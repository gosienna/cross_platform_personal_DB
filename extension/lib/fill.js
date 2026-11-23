/*
 * Autofill: match a form's controls to stored labels, convert values to the form's format,
 * propose (preview), then apply with events that frameworks notice, and undo.
 */
(function (g) {
  const PDB = (g.PDB = g.PDB || {});
  const C = () => PDB.core, D = () => PDB.dom, S = () => PDB.schema;

  const SKIP_TYPES = /^(hidden|button|submit|reset|image|file|password|checkbox)$/i;
  const usable = (el) => !D().isHidden(el) && !el.disabled && !el.readOnly && !SKIP_TYPES.test(el.type || '');

  const SEX_WORDS = {
    male: ['男', '男性', 'm', 'male', '先生', '1'],
    female: ['女', '女性', 'f', 'female', '小姐', '女士', '2'],
    other: ['其他', 'other', '3'],
  };
  const pad = (n, w = 2) => String(n).padStart(w, '0');

  /** Which date format does this text box expect? */
  function dateFormat(ctl, label) {
    const hint = `${ctl.getAttribute('placeholder') || ''} ${ctl.getAttribute('pattern') || ''} ${ctl.getAttribute('data-format') || ''} ${label || ''} ${ctl.value || ''}`.toLowerCase();
    if (/民國|roc|yyy\/|^\d{2,3}\/\d{1,2}\/\d{1,2}$/.test(hint) || ctl.maxLength === 7 || ctl.maxLength === 9) return 'roc';
    if (/mm\/dd\/yyyy/.test(hint)) return 'mdy';
    if (/yyyy-mm-dd/.test(hint) || ctl.type === 'date') return 'iso';
    if (/yyyymmdd/.test(hint) || ctl.maxLength === 8) return 'compact';
    return 'slash';
  }
  function formatDate(iso, fmt) {
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return iso;
    const [y, mo, d] = [+m[1], m[2], m[3]];
    switch (fmt) {
      case 'iso': return `${y}-${mo}-${d}`;
      case 'roc': return `${pad(y - 1911, 3)}/${mo}/${d}`;
      case 'mdy': return `${mo}/${d}/${y}`;
      case 'compact': return `${y}${mo}${d}`;
      default: return `${y}/${mo}/${d}`;
    }
  }
  /** Value → text for a text box, converting units when the label asks for another one. */
  function convertForLabel(entry, value, rawLabel) {
    const l = (rawLabel || '').toLowerCase();
    const n = parseFloat(value);
    if (entry && entry.key === 'temperature' && /°?f\b|℉|華氏/.test(l) && !isNaN(n)) return String(Math.round((n * 9 / 5 + 32) * 10) / 10);
    if (entry && entry.key === 'weight' && /\blbs?\b|磅/.test(l) && !isNaN(n)) return String(Math.round((n / 0.45359237) * 10) / 10);
    return value;
  }
  /** Best option of a select / radio group for a stored value. */
  function matchOption(opts, value, entry) {
    const v = String(value).toLowerCase().trim();
    const words = entry && entry.type === 'sex' ? (SEX_WORDS[v] || [v]) : [v];
    const norm = (s) => C().clean(s).toLowerCase();
    for (const w of words) { const o = opts.find((o) => norm(o.text) === w || norm(o.value) === w); if (o) return o; }
    for (const w of words) { if (w.length < 2 && entry && entry.type !== 'sex') continue; const o = opts.find((o) => norm(o.text).includes(w) && w.length >= 1 && norm(o.text).length <= w.length + 4); if (o) return o; }
    const o = opts.find((o) => o.text && v.includes(norm(o.text)) && norm(o.text).length >= 2);
    return o || null;
  }

  /** Look up a value for a target label in the data, including glucose variants and BP parts. */
  function valueFor(label, data) {
    if (data[label] != null) return { value: data[label], from: label };
    if (label === 'Systolic BP' || label === 'Diastolic BP') {
      const bp = data['Blood pressure'];
      if (bp) { const [s, d] = String(bp).split('/'); return { value: label === 'Systolic BP' ? s : d, from: 'Blood pressure' }; }
    }
    const k = Object.keys(data).find((x) => x.startsWith(label + ' ('));
    return k ? { value: data[k], from: k } : null;
  }

  /** A stored label (outside the vocabulary) that is the same as this page label, ignoring numbering and marks. */
  function sameStoredLabel(c, data) {
    if (!data) return null;
    const n = C().normLabel(c).norm;
    if (!n) return null;
    return Object.keys(data).find((k) => C().normLabel(k).norm === n) || null;
  }
  function labelFor(cands, ctx, data) {
    for (const c of cands) {
      const r = C().resolveLabel(c, ctx);
      if (r && r.label && !r.ignore) return { label: r.label, entry: r.entry, how: r.how, rawLabel: c };
    }
    for (const c of cands) { const k = sameStoredLabel(c, data); if (k) return { label: k, how: 'same-label', rawLabel: c }; }
    return null;
  }
  function targetLabel(ctl, ctx, overrides, data) {
    if (overrides && overrides.has(ctl)) return { label: overrides.get(ctl), how: 'template', rawLabel: overrides.get(ctl) };
    const { cands } = D().bestLabel(ctl, ctx);
    const hit = labelFor(cands, ctx, data);
    if (hit) return hit;
    const readable = cands.find((c) => /[㐀-鿿]/.test(c) || /\s/.test(c));
    return { label: null, rawLabel: readable || cands[0] || '' };
  }

  /**
   * Scan a form and propose values.
   * data: { label: value } (stored values to use)
   * ctx: { vocab, origin, templates (this site's templates: Fill's own, and Capture's, which are found by context) }
   * Returns [{ id, kind, ctls, label, rawLabel, how, value, display, current, hasValue, matched }]
   */
  function scanForm(root, data, ctx = {}) {
    const doc = root.ownerDocument || root;
    const scope = root.nodeType === 9 ? root.body : root;
    const overrides = new Map();
    const path = doc.location ? doc.location.pathname : '';
    // Fill's own templates (on the frame page they were taught on) first, then fields taught in Capture (found by context)
    const tpls = ctx.templates || [];
    const own = tpls.filter((t) => (t.direction || 'fill') === 'fill'), other = tpls.filter((t) => t.direction === 'extract');
    const labels = new Set();
    const put = (f, cross) => {
      if (cross && labels.has(f.label)) return;
      const p = PDB.templates.place(doc, f, 'fill', cross, ctx);
      if (!p.el) return;
      const els = p.group ? p.group.opts.filter((o) => o.tagName === 'INPUT') : [p.el];
      if (!els.length || els.every((e) => PDB.dom.isHidden(e)) || els.some((e) => overrides.has(e))) return;
      for (const e of els) overrides.set(e, f.label);
      labels.add(f.label);
    };
    for (const t of own) if (PDB.templates.appliesTo(t, path)) for (const f of t.fields) put(f, false);
    for (const t of other) for (const f of t.fields) put(f, true);
    const taught = (els) => { const e = els.find((x) => overrides.has(x)); return e ? { label: overrides.get(e), how: 'template' } : null; };
    const out = [];
    const all = Array.from(scope.querySelectorAll('input,select,textarea')).filter(usable);
    const seen = new Set();
    for (let i = 0; i < all.length; i++) {
      const ctl = all[i];
      if (seen.has(ctl)) continue;
      // radio group
      if (ctl.type === 'radio') {
        const group = D().radioGroupOf(ctl, all);
        group.forEach((x) => seen.add(x));
        const g = D().optionGroups(group, ctx).find((x) => x.opts.includes(ctl));
        const gl = (g && g.label) || groupLabelText(group.length > 1 ? common(group) : ctl.parentElement) || '';
        const r = taught(group) || (gl && labelFor([gl], ctx, data)) || null;
        const opts = group.map((x) => ({ el: x, text: optionText(x), value: x.value }));
        out.push(proposal(out.length, 'radio', group, r && r.label, gl, r && r.how, data, (v, e) => matchOption(opts, v, e), opts));
        continue;
      }
      // segmented date (3 boxes: 年/月/日)
      if (D().isSegment(ctl)) {
        const seg = [ctl];
        let j = i + 1;
        while (j < all.length && D().isSegment(all[j]) && all[j].parentNode === ctl.parentNode) seg.push(all[j++]);
        if (seg.length === 3) {
          seg.forEach((x) => seen.add(x));
          const t = targetLabel(ctl, ctx, overrides, data);
          out.push(proposal(out.length, 'segments', seg, t.label, t.rawLabel, t.how, data, null));
          continue;
        }
      }
      seen.add(ctl);
      const t = targetLabel(ctl, ctx, overrides, data);
      if (ctl.tagName === 'SELECT') {
        const opts = Array.from(ctl.options).map((o) => ({ el: o, text: o.textContent.trim(), value: o.value }));
        out.push(proposal(out.length, 'select', [ctl], t.label, t.rawLabel, t.how, data, (v, e) => matchOption(opts.filter((o) => o.value !== '' || o.text), v, e), opts));
      } else {
        out.push(proposal(out.length, 'text', [ctl], t.label, t.rawLabel, t.how, data, null));
      }
    }
    // checkbox groups ("☑失禁 ☐跌倒、骨折 …"): tick the stored options
    const boxes = Array.from(scope.querySelectorAll('input[type=checkbox]')).filter((x) => !D().isHidden(x) && !x.disabled);
    for (const g of D().optionGroups(boxes, ctx)) {
      if (!g.label && !taught(g.opts)) continue;
      const r = taught(g.opts) || labelFor([g.label], ctx, data) || null;
      const opts = g.opts.map((x) => ({ el: x, text: D().optionLabelText(x) }));
      out.push(proposal(out.length, 'checks', g.opts, r && r.label, g.label, r && r.how, data, null, opts));
    }
    return out;
  }

  /** Which options of a checkbox group a stored "a; b; c" value ticks. */
  function matchChecks(opts, value) {
    const norm = (s) => C().clean(s).replace(/[\s:：,，。]/g, '').toLowerCase();
    const parts = String(value).split(/\s*[;；]\s*/).map(norm).filter(Boolean);
    const on = new Set(), missing = [];
    // a single tick box ("身障證明 ☐") and a yes-value
    if (opts.length === 1 && parts.length === 1 && /^(是|有|yes|true|y|✓|☑|v)$/i.test(parts[0])) return { on: new Set([opts[0].el]), missing };
    for (const p of parts) {
      const o = opts.find((x) => norm(x.text) === p) || opts.find((x) => norm(x.text).length >= 2 && (norm(x.text).startsWith(p) || p.startsWith(norm(x.text))));
      if (o) on.add(o.el); else missing.push(p);
    }
    return { on, missing };
  }

  function proposal(id, kind, ctls, label, rawLabel, how, data, chooser, opts) {
    const p = { id, kind, ctls, label: label || null, rawLabel: rawLabel || '', how: how || null, matched: false, value: null, display: null };
    p.current = currentValue(kind, ctls);
    p.hasValue = !!p.current;
    if (!label) return p;
    const entry = S().byLabel[label] || (label.startsWith('Blood glucose') ? S().byKey.glucose : null);
    const got = valueFor(label, data);
    if (!got || got.value == null || got.value === '') { p.noData = true; return p; }
    let v = String(got.value);
    if (kind === 'segments') {
      const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (!m) { p.noData = true; return p; }
      const roc = ctls[0].maxLength === 3;
      p.value = [roc ? pad(+m[1] - 1911, 3) : m[1], m[2], m[3]];
      p.display = p.value.join('/');
    } else if (kind === 'checks') {
      const { on, missing } = matchChecks(opts, v);
      if (!on.size) { p.unmatchedOption = v; return p; }
      p.value = Array.from(on);
      p.display = opts.filter((o) => on.has(o.el)).map((o) => o.text).join('; ') + (missing.length ? `  (no box for: ${missing.join(', ')})` : '');
    } else if (kind === 'select' || kind === 'radio') {
      const o = chooser(v, entry);
      if (!o) { p.unmatchedOption = v; return p; }
      p.value = o; p.display = o.text || o.value;
    } else {
      if (entry && entry.type === 'date') v = formatDate(v, dateFormat(ctls[0], rawLabel));
      else if (entry && entry.type === 'sex') v = { male: '男', female: '女', other: '其他' }[v] || v;
      else v = convertForLabel(entry, v, rawLabel);
      if (ctls[0].type === 'number') v = String(parseFloat(v));
      p.value = v; p.display = v;
    }
    p.matched = true;
    p.from = got.from;
    return p;
  }

  function currentValue(kind, ctls) {
    if (kind === 'radio') { const c = ctls.find((x) => x.checked); return c ? optionText(c) : ''; }
    if (kind === 'checks') return ctls.filter((x) => x.checked).map((x) => D().optionLabelText(x)).join('; ');
    if (kind === 'segments') return ctls.map((x) => x.value).filter(Boolean).join('/');
    if (kind === 'select') { const o = ctls[0].options[ctls[0].selectedIndex]; return o && o.value ? o.textContent.trim() : ''; }
    return ctls[0].value || '';
  }
  function optionText(radio) {
    const doc = radio.ownerDocument;
    const l = (radio.id && doc.querySelector(`label[for="${radio.id}"]`)) || radio.closest('label');
    if (l) return D().textOf(l);
    const n = radio.nextSibling;
    return n && n.nodeType === 3 ? n.nodeValue.trim() : radio.value;
  }
  function common(els) { let a = els[0].parentElement; while (a && !els.every((e) => a.contains(e))) a = a.parentElement; return a; }
  function groupLabelText(container) {
    let node = container;
    for (let d = 0; d < 4 && node; d++) {
      let sib = node.previousElementSibling, steps = 0;
      while (sib && steps < 3) {
        const t = D().textOf(sib);
        if (t && t.length <= 30 && !sib.querySelector('input,select,textarea')) return t;
        sib = sib.previousElementSibling; steps++;
      }
      node = node.parentElement;
    }
    return null;
  }

  // ── writing values so that React / Vue / Angular notice ─────────────
  function setNative(el, v) {
    const proto = el.tagName === 'TEXTAREA' ? g.HTMLTextAreaElement?.prototype : el.tagName === 'SELECT' ? g.HTMLSelectElement?.prototype : g.HTMLInputElement?.prototype;
    const win = el.ownerDocument.defaultView;
    const P = (el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement : el.tagName === 'SELECT' ? win.HTMLSelectElement : win.HTMLInputElement).prototype;
    const desc = Object.getOwnPropertyDescriptor(P, 'value') || (proto && Object.getOwnPropertyDescriptor(proto, 'value'));
    if (desc && desc.set) desc.set.call(el, v); else el.value = v;
  }
  function fire(el, ...types) {
    const win = el.ownerDocument.defaultView;
    for (const t of types) el.dispatchEvent(new win.Event(t, { bubbles: true }));
  }

  /** Apply chosen proposals; returns undo info. */
  function apply(proposals, chosenIds, edits = {}) {
    const undo = [];
    for (const p of proposals) {
      if (!chosenIds.includes(p.id) || !p.matched) continue;
      const v = edits[p.id] != null ? edits[p.id] : p.value;
      if (p.kind === 'checks') {
        // edits arrive as text ("a; b"); otherwise the matched boxes
        const on = typeof v === 'string' ? matchChecks(p.ctls.map((x) => ({ el: x, text: D().optionLabelText(x) })), v).on : new Set(v);
        undo.push({ kind: 'checks', ctls: p.ctls, prev: p.ctls.map((x) => x.checked) });
        for (const x of p.ctls) {
          const want = on.has(x);
          if (x.checked === want) continue;
          if (x.click) x.click(); // lets the page's own handlers run
          if (x.checked !== want) x.checked = want;
          fire(x, 'input', 'change');
        }
      } else if (p.kind === 'radio') {
        const target = typeof v === 'string' ? p.ctls.find((x) => optionText(x) === v) : v.el;
        if (!target) continue;
        undo.push({ kind: 'radio', ctls: p.ctls, prev: p.ctls.map((x) => x.checked) });
        target.click ? target.click() : (target.checked = true);
        if (!target.checked) target.checked = true;
        fire(target, 'input', 'change');
      } else if (p.kind === 'select') {
        const el = p.ctls[0];
        undo.push({ kind: 'select', ctls: [el], prev: [el.value] });
        setNative(el, typeof v === 'string' ? v : v.value);
        fire(el, 'input', 'change', 'blur');
      } else if (p.kind === 'segments') {
        const parts = Array.isArray(v) ? v : String(v).split(/[\/\-.]/);
        undo.push({ kind: 'text', ctls: p.ctls, prev: p.ctls.map((x) => x.value) });
        p.ctls.forEach((el, i) => { el.focus && el.focus(); setNative(el, parts[i] || ''); fire(el, 'input', 'change', 'blur'); });
      } else {
        const el = p.ctls[0];
        undo.push({ kind: 'text', ctls: [el], prev: [el.value] });
        el.focus && el.focus();
        setNative(el, v);
        fire(el, 'input', 'change', 'blur');
      }
    }
    return undo;
  }
  function revert(undo) {
    for (const u of undo.reverse()) {
      if (u.kind === 'radio' || u.kind === 'checks') u.ctls.forEach((x, i) => { x.checked = u.prev[i]; fire(x, 'change'); });
      else u.ctls.forEach((x, i) => { setNative(x, u.prev[i]); fire(x, 'input', 'change'); });
    }
  }

  /**
   * Build the data to fill from stored rows of one patient:
   * persistent rows ("nan") + for each timed label the row closest to (and not after) `at` (default: latest).
   */
  function dataFromRows(rows, at) {
    const data = {};
    const best = {};
    for (const r of rows) {
      if (r.label === 'Medication') continue;
      if (r.time === 'nan') { if (data[r.label] == null) data[r.label] = r.value; continue; }
      if (at && r.time.slice(0, 8) > at.slice(0, 8) && r.time > at) continue;
      if (!best[r.label] || r.time > best[r.label].time) best[r.label] = r;
    }
    for (const [l, r] of Object.entries(best)) if (data[l] == null) data[l] = r.value;
    return data;
  }

  PDB.fill = { scanForm, apply, revert, dataFromRows, matchOption, formatDate, dateFormat, convertForLabel };
})(globalThis);
