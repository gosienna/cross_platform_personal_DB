/*
 * Page agent, injected into every frame on demand (never runs until you press a button).
 * Reads the page, draws the preview overlay, runs the picker / teach mode, and fills forms.
 * Nothing on the page is changed except by fill(); the overlay lives in a shadow DOM.
 */
(function () {
  if (window.__pdbAgent) return;
  const PDB = globalThis.PDB;
  const OVERLAY_ID = PDB.dom.OVERLAY_ID;

  let reg = PDB.dom.makeRegistry();
  let marks = [];
  let fillState = null;
  let undoStack = null;
  let pickCleanup = null;

  // ── overlay ──────────────────────────────────────────────────────────
  let host = null, shadow = null, layer = null, raf = 0;
  function ensureOverlay() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = OVERLAY_ID;
    host.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      .b{position:absolute;box-sizing:border-box;border:2px solid;border-radius:3px;pointer-events:none}
      .mapped{border-color:#1a9e5a;background:rgba(26,158,90,.06)} .unmapped{border-color:#e0a100;background:rgba(224,161,0,.07)}
      .chart{border-color:#2f6fd6;background:rgba(47,111,214,.04)} .warn{border-color:#d33;background:rgba(221,51,51,.08)}
      .off{border-color:#999;border-style:dashed;background:rgba(0,0,0,.03)} .fill{border-color:#7b4fd6;background:rgba(123,79,214,.06)}
      .keep{border-color:#999;border-style:dashed} .filled{border-color:#1a9e5a;border-width:3px} .hot{outline:3px solid #ff3d7f;outline-offset:2px}
      .t{position:absolute;left:0;top:-1.45em;font:600 11px/1.3 system-ui,sans-serif;color:#fff;padding:1px 5px;border-radius:3px;white-space:nowrap;
         pointer-events:auto;cursor:pointer;max-width:340px;overflow:hidden;text-overflow:ellipsis}
      .mapped .t{background:#1a9e5a}.unmapped .t{background:#c48a00}.chart .t{background:#2f6fd6}.warn .t{background:#d33}.off .t{background:#888}
      .fill .t{background:#7b4fd6}.keep .t{background:#888}.filled .t{background:#1a9e5a}
      .pick{border-color:#ff3d7f;border-width:2px;background:rgba(255,61,127,.08)}
      .tip{position:fixed;right:12px;bottom:12px;font:13px system-ui;background:#222;color:#fff;padding:8px 12px;border-radius:6px;pointer-events:none}
    </style><div class="layer"></div>`;
    layer = shadow.querySelector('.layer');
    (document.body || document.documentElement).appendChild(host);
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
  }
  function schedule() { cancelAnimationFrame(raf); raf = requestAnimationFrame(render); }
  function render() {
    if (!layer) return;
    layer.textContent = '';
    for (const m of marks) {
      const el = reg.els[m.ref];
      if (!el || !el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const b = document.createElement('div');
      b.className = `b ${m.kind}${m.hot ? ' hot' : ''}`;
      b.style.left = r.left + scrollX - 2 + 'px'; b.style.top = r.top + scrollY - 2 + 'px';
      b.style.width = r.width + 4 + 'px'; b.style.height = r.height + 4 + 'px';
      if (m.text) {
        const t = document.createElement('div');
        t.className = 't'; t.textContent = m.text; t.title = m.title || m.text;
        t.addEventListener('click', (e) => { e.stopPropagation(); chrome.runtime.sendMessage({ type: 'pdb:badge', ref: m.ref, key: m.key }); });
        b.appendChild(t);
      }
      layer.appendChild(b);
    }
  }
  function setMarks(list) { ensureOverlay(); marks = list || []; render(); }
  function clearOverlay() { marks = []; if (layer) layer.textContent = ''; if (host) { host.remove(); host = null; layer = null; } }
  function focusMark(ref) {
    for (const m of marks) m.hot = m.ref === ref;
    const el = reg.els[ref];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    render();
    setTimeout(render, 400);
  }

  // ── reading ──────────────────────────────────────────────────────────
  /** Make records serialisable: drop vocabulary objects, keep labels and element refs. */
  function serialise(records) {
    return records.map((r) => ({
      ...r,
      items: r.items.map(({ entry, ...it }) => ({ ...it, entryKey: entry ? entry.key : null })),
      meds: r.meds.map((m) => ({ ...m })),
    }));
  }
  function scan(ctx) {
    clearOverlay();
    reg = PDB.dom.makeRegistry();
    const ex = PDB.dom.extractFromRoot(document, { ...ctx, registry: reg });
    return { records: serialise(ex.records), regions: ex.regions, broken: ex.broken, found: ex.found || [], url: location.href, title: document.title, top: window === window.top };
  }
  function extractElement(el, ctx) {
    reg = PDB.dom.makeRegistry();
    const ex = PDB.dom.extractFromRoot(el, { ...ctx, registry: reg, templates: [] });
    return { records: serialise(ex.records), regions: ex.regions, broken: [], url: location.href, title: document.title, top: window === window.top, picked: true };
  }

  // ── picker / teach / media ───────────────────────────────────────────
  /**
   * What a Teach click points at — the same in Capture and Fill:
   *   a tick box, radio, tick-box picture or its label text → the whole group ({ el: first option, group });
   *   a form box → the box; (Capture only) any other element → that element.
   */
  function teachTarget(el, mode, cache = new Map()) {
    const opt = PDB.dom.optionAt(el);
    if (opt && (mode === 'teach' || opt.tagName === 'INPUT')) {
      if (!cache.has(opt)) { const g = PDB.dom.groupOf(opt); for (const o of g.opts) cache.set(o, g); }
      const group = cache.get(opt);
      return { el: group.opts[0], group };
    }
    const ctl = el.closest('input,select,textarea');
    if (ctl && !/^(hidden|button|submit|reset|image|file|password)$/i.test(ctl.type || '')) return { el: ctl };
    return mode === 'teach' ? { el } : null;
  }
  /** A taught field, saved as a template field by the side panel. */
  function teachField({ el, group }) {
    const T = PDB.templates;
    const kind = group ? 'group' : /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) ? 'control' : 'text';
    const value = group ? PDB.dom.groupValue(group) : kind === 'control' ? PDB.dom.controlValue(el) : PDB.dom.textOf(el);
    return {
      kind, selector: T.selectorFor(el), anchor: group ? (group.label || T.anchorFor(el)) : T.anchorFor(el),
      value: String(value || '').slice(0, 200), framePath: T.pagePath(location.pathname), context: T.contextFor(el), tag: el.tagName,
      options: group ? group.opts.map(PDB.dom.optionLabelText).filter(Boolean).slice(0, 30) : undefined,
    };
  }
  function startPick(mode, ctx) {
    stopPick();
    ensureOverlay();
    const tip = document.createElement('div');
    tip.className = 'tip';
    tip.textContent = { extract: 'Click the part of the page to capture · Esc to cancel', teach: 'Click a value, a form field or a tick box to teach its label · Esc to cancel', media: 'Click an image, chart, audio or video · Esc to cancel', fill: 'Click a form field or a tick box to teach its label · Esc to cancel' }[mode];
    shadow.appendChild(tip);
    let hover = null;
    const box = document.createElement('div');
    box.className = 'b pick';
    shadow.appendChild(box);
    const pickable = (el) => {
      if (!el || el === host) return null;
      if (mode === 'media') return el.closest('img,canvas,video,audio,svg,picture') || null;
      if (mode === 'teach' || mode === 'fill') return teachTarget(el, mode, groupCache);
      return el;
    };
    const groupCache = new Map(); // option → its group (grouping reads the whole page, so once per option)
    const boxOf = (t) => (t.nodeType === 1 ? t : t.group ? t.group.container : t.el);
    const move = (e) => {
      const el = pickable(document.elementFromPoint(e.clientX, e.clientY));
      hover = el;
      if (!el) { box.style.display = 'none'; return; }
      const r = boxOf(el).getBoundingClientRect();
      Object.assign(box.style, { display: 'block', position: 'fixed', left: r.left - 2 + 'px', top: r.top - 2 + 'px', width: r.width + 4 + 'px', height: r.height + 4 + 'px' });
    };
    const click = async (e) => {
      if (!hover) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      const el = hover;
      stopPick();
      try {
        if (mode === 'extract') chrome.runtime.sendMessage({ type: 'pdb:picked', result: extractElement(el, ctx) });
        else if (mode === 'teach' || mode === 'fill') chrome.runtime.sendMessage({ type: 'pdb:taught', mode, field: teachField(el) });
        else if (mode === 'media') chrome.runtime.sendMessage({ type: 'pdb:media', media: await grabMedia(el) });
      } catch (err) { chrome.runtime.sendMessage({ type: 'pdb:error', message: String(err && err.message || err) }); }
    };
    const key = (e) => { if (e.key === 'Escape') { stopPick(); chrome.runtime.sendMessage({ type: 'pdb:pickCancelled' }); } };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true);
    pickCleanup = () => {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('keydown', key, true);
      tip.remove(); box.remove();
    };
  }
  function stopPick() { if (pickCleanup) { pickCleanup(); pickCleanup = null; } }

  const blobToDataURL = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
  async function grabMedia(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'canvas') {
      const blob = await new Promise((res, rej) => { try { el.toBlob((b) => (b ? res(b) : rej(new Error('Canvas is empty'))), 'image/png'); } catch (e) { rej(new Error('This chart is drawn from another site and cannot be captured (tainted canvas). Use Screenshot instead.')); } });
      return { kind: 'image', name: 'chart.png', dataURL: await blobToDataURL(blob) };
    }
    if (tag === 'svg') {
      const xml = new XMLSerializer().serializeToString(el);
      return { kind: 'image', name: 'chart.svg', dataURL: 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml))) };
    }
    const src = el.currentSrc || el.src || el.querySelector?.('source')?.src;
    if (!src) throw new Error('This element has no file to save.');
    if (src.startsWith('blob:') && (tag === 'video' || tag === 'audio') && el.srcObject == null) {
      // MSE streams cannot be downloaded
      try { const b = await (await fetch(src)).blob(); return { kind: tag, name: `${tag}.${(b.type.split('/')[1] || 'bin')}`, dataURL: await blobToDataURL(b) }; } catch (e) { throw new Error('This is a streaming video/audio and cannot be saved.'); }
    }
    const res = await fetch(src, { credentials: 'include' });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const blob = await res.blob();
    const kind = tag === 'img' || tag === 'picture' ? 'image' : tag;
    return { kind, name: decodeURIComponent((new URL(src, location.href).pathname.split('/').pop() || kind)).slice(0, 80), dataURL: await blobToDataURL(blob), size: blob.size };
  }

  // ── fill ─────────────────────────────────────────────────────────────
  function fillScan(data, ctx) {
    clearOverlay();
    reg = PDB.dom.makeRegistry();
    const props = PDB.fill.scanForm(document, data, ctx);
    fillState = props;
    return props.map((p) => ({
      id: p.id, kind: p.kind, label: p.label, rawLabel: p.rawLabel, how: p.how, matched: p.matched, noData: !!p.noData,
      unmatchedOption: p.unmatchedOption || null, display: p.display, current: p.current, hasValue: p.hasValue, from: p.from || null,
      ref: reg.id(p.ctls[0]),
    }));
  }
  function fillApply(ids, edits) {
    if (!fillState) return { count: 0 };
    const ed = {};
    for (const [id, v] of Object.entries(edits || {})) {
      const p = fillState.find((x) => x.id === +id);
      if (!p) continue;
      if (p.kind === 'segments') ed[id] = String(v).split(/[\/\-.]/);
      else if (p.kind === 'select' || p.kind === 'radio') { /* chosen option stays */ }
      else ed[id] = v;
    }
    undoStack = PDB.fill.apply(fillState, ids, ed);
    return { count: undoStack.length };
  }
  function fillUndo() { if (undoStack) { PDB.fill.revert(undoStack); undoStack = null; return true; } return false; }

  // ── privacy: boxes of sensitive elements (for screenshot masking) ───
  function rectsOf(refs) {
    const dpr = window.devicePixelRatio || 1;
    return refs.map((r) => reg.els[r]).filter(Boolean).map((el) => { const b = el.getBoundingClientRect(); return { x: b.left * dpr, y: b.top * dpr, w: b.width * dpr, h: b.height * dpr }; })
      .filter((b) => b.w > 0 && b.h > 0);
  }

  // ── AI extract: page text + values that sit next to sensitive labels (for masking) ──
  function aiText(ctx) {
    clearOverlay();
    reg = PDB.dom.makeRegistry();
    const ex = PDB.dom.extractFromRoot(document, { ...ctx, registry: reg });
    const known = [];
    for (const r of ex.records) for (const it of r.items) {
      if (it.entry && it.entry.sensitive) { known.push({ label: it.label, value: it.value, ref: it.ref }); if (it.raw && it.raw !== it.value) known.push({ label: it.label, value: it.raw, ref: it.ref }); }
    }
    return { text: PDB.redact.pageText(document), known, top: window === window.top };
  }

  window.__pdbAgent = { scan, aiText, setMarks, clearOverlay, focusMark, startPick, stopPick, fillScan, fillApply, fillUndo, rectsOf,
    textOfRef: (ref) => (reg.els[ref] ? PDB.dom.textOf(reg.els[ref]) : '') };
})();
