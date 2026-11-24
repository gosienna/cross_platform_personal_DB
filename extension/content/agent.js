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
      .t .x{display:inline-block;margin-left:6px;padding:0 4px;border-radius:3px;background:rgba(255,255,255,.25);cursor:pointer} .t .x:hover{background:#d33}
      .time{border-color:#2f6fd6;border-style:dashed;border-width:2px;background:rgba(47,111,214,.08)} .time .t{background:#2f6fd6}
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
        if (m.x) {
          // ✕ cancels this mapping in the page's template; ↺ brings a cancelled one back
          const x = document.createElement('span');
          x.className = 'x'; x.textContent = m.x === 'restore' ? '↺' : '✕';
          x.title = m.x === 'restore' ? 'Read this again' : 'Cancel this mapping (not saved any more)';
          x.addEventListener('click', (e) => { e.stopPropagation(); chrome.runtime.sendMessage({ type: 'pdb:markx', key: m.key, x: m.x }); });
          t.appendChild(x);
        }
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
  /**
   * Read this frame. With a saved template the page is read strictly by it, and what the rules find outside it is
   * listed as "not in the template". Without one, the built-in rules make a draft template (with fields taught
   * earlier, if any), and the page is read by that draft — exactly as it will be read once saved.
   */
  function scan(ctx) {
    clearOverlay();
    const T = PDB.templates, PT = PDB.pagetpl;
    const framePath = T.pagePath(location.pathname);
    const query = PDB.core.queryKey(location.search);
    const page = { path: framePath, query };
    const base = { url: location.href, title: document.title, top: window === window.top, framePath, query, found: [] };
    const all = (ctx.pageTemplates || []).filter((t) => !ctx.origin || t.origin === ctx.origin);
    // which template: one chosen in the side panel (or "a new page"), the draft being edited, or the best match
    const choice = (ctx.choice || {})[framePath];
    const editing = all.find((t) => t._draft && t.framePath === framePath && (!t.query || t.query === query));
    let tpl = null, m = null;
    if (choice === 'new') tpl = editing || null;
    else if (choice) tpl = all.find((t) => t.id === choice) || null;
    else if (editing) tpl = editing;
    else { m = PT.match(document, all, page, ctx); tpl = m.decision === 'use' ? m.tpl : null; }
    const match = m ? { decision: m.decision, how: m.how || null, found: m.found || 0, total: m.total || 0, id: m.tpl ? m.tpl.id : null,
      title: m.tpl ? m.tpl.title || m.tpl.framePath : '', candidates: m.candidates } : { decision: choice === 'new' ? 'new' : choice ? 'chosen' : 'editing' };
    if (tpl && (tpl.complete || tpl._draft)) {
      reg = PDB.dom.makeRegistry();
      const res = PT.extract(document, tpl, { ...ctx, registry: reg });
      const unc = tpl._draft ? [] : PT.uncovered(document, tpl, res, { ...ctx, templates: [] });
      // fields cancelled in the template, where they are on the page (shown greyed, to bring back)
      const ignored = tpl.fields.filter((f) => f.label === PT.IGNORE && res.located.has(f.id))
        .map((f) => ({ fid: f.id, ref: reg.id(res.located.get(f.id).box), label: f.prevLabel || PT.fieldName(f) }));
      return { ...base, mode: tpl._draft ? 'draft' : 'strict', partial: !!tpl._partial, template: tpl, changed: res.changed, match,
        records: serialise(res.records), regions: res.regions, broken: res.broken, uncovered: unc, ignored, images: res.images || [] };
    }
    // a new page: the built-in rules make a draft (with an older template's taught fields, if this address had one)
    const partial = m && m.decision === 'partial' ? m.tpl : null;
    reg = PDB.dom.makeRegistry();
    const legacy = partial ? [{ direction: 'extract', framePath, fields: partial.fields.filter((f) => f.label !== PT.IGNORE) }] : [];
    const rules = PDB.dom.extractFromRoot(document, { ...ctx, registry: reg, templates: legacy.concat(ctx.templates || []) });
    const d = PT.draft(document, rules, { origin: ctx.origin, framePath, query, title: document.title, base: partial });
    d._draft = true;
    if (partial) d._partial = true;
    reg = PDB.dom.makeRegistry();
    const res = PT.extract(document, d, { ...ctx, registry: reg });
    return { ...base, mode: 'draft', partial: !!partial, template: d, match, records: serialise(res.records), regions: res.regions, broken: [], uncovered: [], images: res.images || [] };
  }
  /** This frame's page compared with its template (see lib/tplcheck.js); null in other frames. */
  function checkTemplate(tpl, ctx) {
    if (!tpl || PDB.templates.pagePath(location.pathname) !== tpl.framePath) return null;
    return PDB.tplcheck.check(document, tpl, ctx);
  }
  /** The masked sample page of this frame for a template. */
  function sample(tpl, ctx) {
    clearOverlay();
    const r = PDB.dom.makeRegistry();
    const res = PDB.pagetpl.extract(document, tpl, { ...ctx, registry: r });
    const out = {};
    const html = PDB.pagetpl.snapshot(document, tpl, res, out);
    return { html, external: out.external || [], framePath: PDB.templates.pagePath(location.pathname), title: document.title,
      width: document.documentElement.clientWidth || 1200, height: window.innerHeight || 0 };
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
   *   a form box → the box; (Capture only) a picture (img, canvas, svg) → the picture, read by Claude;
   *   (Capture only) any other element → that element.
   */
  function teachTarget(el, mode, cache = new Map()) {
    const opt = PDB.dom.optionAt(el);
    if (opt && (mode === 'teach' || opt.tagName === 'INPUT')) {
      if (!cache.has(opt)) { const g = PDB.dom.groupOf(opt); for (const o of g.opts) cache.set(o, g); }
      const group = cache.get(opt);
      return { el: group.opts[0], group };
    }
    const pic = mode === 'teach' && PDB.dom.pictureAt(el);
    if (pic) return { el: pic };
    const ctl = el.closest('input,select,textarea');
    if (ctl && !/^(hidden|button|submit|reset|image|file|password)$/i.test(ctl.type || '')) return { el: ctl };
    return mode === 'teach' ? { el } : null;
  }
  /** A taught field (Teach, or the element a time is read from), saved into a template by the side panel. */
  const teachField = (target) => PDB.pagetpl.fieldFor(target);
  function startPick(mode, ctx) {
    stopPick();
    ensureOverlay();
    const tip = document.createElement('div');
    tip.className = 'tip';
    tip.textContent = { extract: 'Click the part of the page to capture · Esc to cancel', teach: 'Click a value, a form field, a tick box or a picture to teach its label · Esc to cancel', media: 'Click an image, chart, audio or video · Esc to cancel', fill: 'Click a form field or a tick box to teach its label · Esc to cancel', time: 'Click the date or time this value belongs to · Esc to cancel' }[mode];
    shadow.appendChild(tip);
    let hover = null;
    const box = document.createElement('div');
    box.className = 'b pick';
    shadow.appendChild(box);
    const pickable = (el) => {
      if (!el || el === host) return null;
      if (mode === 'media') return el.closest('img,canvas,video,audio,svg,picture') || null;
      if (mode === 'teach' || mode === 'fill') return teachTarget(el, mode, groupCache);
      if (mode === 'time') return teachTarget(el, 'teach', groupCache);
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
        else if (mode === 'teach' || mode === 'fill' || mode === 'time') chrome.runtime.sendMessage({ type: 'pdb:taught', mode, field: teachField(el) });
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

  // ── image fields: the picture as it is shown now ────────────────────
  /**
   * The pixels of image-field pictures (refs from the last scan), for the side panel to read with Claude.
   * Each → { ref, dataURL } | { ref, src } (another site's picture: the side panel fetches it) | { ref, shot: true }
   * (cannot be read from the page: the side panel crops a screenshot) | { ref, error }.
   */
  async function imageData(refs) {
    const out = [];
    for (const ref of refs) {
      const el = reg.els[ref];
      if (!el || !el.isConnected) { out.push({ ref, error: 'The picture is no longer on the page. Scan again.' }); continue; }
      try { out.push({ ref, ...(await pictureData(el)) }); } catch (e) { out.push({ ref, error: String((e && e.message) || e) }); }
    }
    return out;
  }
  async function pictureData(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'img') {
      if (!el.complete) await new Promise((res) => { el.addEventListener('load', res, { once: true }); el.addEventListener('error', res, { once: true }); setTimeout(res, 5000); });
      if (!el.naturalWidth) throw new Error('The picture did not load.');
      try {
        const c = document.createElement('canvas');
        c.width = el.naturalWidth; c.height = el.naturalHeight;
        c.getContext('2d').drawImage(el, 0, 0);
        return { dataURL: c.toDataURL('image/png') };
      } catch (e) { /* another site's picture (tainted canvas): fetch the file instead */ }
      const src = el.currentSrc || el.src;
      try { const r = await fetch(src, { credentials: 'include' }); if (r.ok) return { dataURL: await blobToDataURL(await r.blob()) }; } catch (e) { /* not allowed from the page */ }
      return { src };
    }
    if (tag === 'canvas') {
      try { return { dataURL: el.toDataURL('image/png') }; } catch (e) { return { shot: true }; }
    }
    // svg, with its drawn size (the side panel turns it into a PNG)
    const r = el.getBoundingClientRect();
    const clone = el.cloneNode(true);
    if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    if (!clone.getAttribute('width')) clone.setAttribute('width', String(Math.round(r.width)));
    if (!clone.getAttribute('height')) clone.setAttribute('height', String(Math.round(r.height)));
    const xml = new XMLSerializer().serializeToString(clone);
    return { dataURL: 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml))) };
  }
  /** Scroll a picture into view; its box in screenshot pixels (for cropping a screenshot of the visible tab). */
  async function showRect(ref) {
    const el = reg.els[ref];
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    clearOverlay(); // the outlines must not be in the screenshot
    await new Promise((res) => setTimeout(res, 300));
    const dpr = window.devicePixelRatio || 1, b = el.getBoundingClientRect();
    return { x: Math.max(0, b.left) * dpr, y: Math.max(0, b.top) * dpr, w: Math.min(b.width, innerWidth - Math.max(0, b.left)) * dpr, h: Math.min(b.height, innerHeight - Math.max(0, b.top)) * dpr };
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

  // ── AI extract → suggested template changes ─────────────────────────
  /**
   * Find AI-read values on this frame: each value's element (where its exact text is) and, when its time matches a
   * date on the page, the element holding that date. Returns suggestions for the page template:
   *   { framePath, found: [{ i, kind: 'add'|'relabel'|'same', fid?, field?, time?: { fid } | { field } }] }
   */
  function locateValues(items, ctx) {
    const T = PDB.templates, PT = PDB.pagetpl, D = PDB.dom, C = PDB.core;
    const framePath = T.pagePath(location.pathname);
    const tpl = (ctx.pageTemplates || []).find((t) => t.framePath === framePath);
    const located = tpl ? PT.extract(document, tpl, { ...ctx, registry: D.makeRegistry() }).located : new Map();
    const fieldAt = new Map();
    for (const [id, l] of located) { fieldAt.set(l.box, id); fieldAt.set(l.el, id); }
    const norm = (s) => C.clean(s).replace(/\s+/g, '');
    // elements that hold one value: leaves, table cells and form boxes
    const els = Array.from((document.body || document.documentElement).querySelectorAll('*')).filter((el) => {
      if (el.closest('#' + D.OVERLAY_ID) || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|OPTION|BR|HR|IMG)$/.test(el.tagName) || D.isHidden(el)) return false;
      return /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) ? !/^(hidden|button|submit|reset|image|file|password|checkbox|radio)$/i.test(el.type)
        : el.children.length === 0 || /^(TD|TH|DD|LI)$/.test(el.tagName);
    });
    const texts = new Map(els.map((el) => [el, /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) ? D.readControl(el) : D.textOf(el)]));
    const innermost = (list) => list.filter((a) => !list.some((b) => b !== a && a.contains(b)));
    const matches = (want) => {
      const w = norm(want);
      if (!w) return [];
      let hit = els.filter((el) => norm(texts.get(el)) === w);
      if (!hit.length && /^\d{4}-\d{2}-\d{2}$/.test(want)) hit = els.filter((el) => { const t = texts.get(el); if (!t || t.length > 24) return false; const p = C.parseDateTime(t); return p && C.isoDate(p) === want; });
      return innermost(hit);
    };
    const dateEls = (time) => {
      if (!time || time === 'nan') return [];
      return innermost(els.filter((el) => { const t = texts.get(el); if (!t || t.length > 30) return false; const p = C.parseDateTime(t, { refYear: new Date().getFullYear() }); return p && p.kind !== 'relative' && C.formatTime(p) === time; }));
    };
    const asField = (el) => { const opt = D.optionAt(el); return PT.fieldFor(opt ? { el: D.groupOf(opt).opts[0], group: D.groupOf(opt) } : { el }); };
    const found = [];
    items.forEach((it, i) => {
      const hit = matches(it.text || it.raw || it.value);
      if (hit.length !== 1) return;
      const el = hit[0];
      const fid = fieldAt.get(el);
      const s = { i };
      if (fid) {
        const f = tpl.fields.find((x) => x.id === fid);
        s.kind = f && f.label !== it.label ? 'relabel' : 'same';
        s.fid = fid; s.from = f ? PT.fieldName(f) : '';
      } else { s.kind = 'add'; s.field = asField(el); }
      const d = dateEls(it.time).filter((x) => x !== el);
      if (d.length === 1) { const tf = fieldAt.get(d[0]); s.time = tf ? { fid: tf } : { field: asField(d[0]) }; }
      found.push(s);
    });
    return { framePath, found };
  }

  window.__pdbAgent = { scan, sample, locateValues, aiText, setMarks, clearOverlay, focusMark, startPick, stopPick, fillScan, fillApply, fillUndo, rectsOf, imageData, showRect, checkTemplate,
    textOfRef: (ref) => (reg.els[ref] ? PDB.dom.textOf(reg.els[ref]) : '') };
})();
