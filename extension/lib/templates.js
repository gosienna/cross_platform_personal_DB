/*
 * Finding a field again on a page (used by page templates, see pagetpl.js, and by fields taught in Fill).
 *   template = { id, origin, path, framePath?, direction: 'extract'|'fill', fields: [{ kind, selector, anchor, context, tag, label }] }
 *   field.kind = 'group' (a tick-box / radio group, found by its first option) | 'control' (a form box) | 'text' (a value on a page)
 *     | 'image' (a picture: <img>, <canvas> or <svg>, whose content is read by Claude; never used by Fill)
 *   field.context = up to 3 nearest text pieces before the element (numbering and notes removed), field.tag = its tag;
 *     used to find the element again when the layout differs between records.
 *   Capture and Fill use each other's templates too: a field taught on a read-only page (Capture) is found on the edit
 *   form (Fill) and the other way round — by its context, since the two pages use different elements.
 *   framePath = the (normalised) path of the frame the fields were taught in, e.g. /lcms/fh/showFh200v2/*
 * A field is found by its CSS selector first, then by its anchor (nearby label text) when the layout moved.
 */
(function (g) {
  const PDB = (g.PDB = g.PDB || {});
  const D = () => PDB.dom;

  const unstableId = (id) => !id || /^k-[0-9a-f-]{8,}|^[0-9]|[0-9a-f]{8}-[0-9a-f]{4}|\d{5,}|^ember\d|^react|^mui-|^:r/i.test(id);
  const esc = (s) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/([^\w-])/g, '\\$1'));

  /** A CSS selector for an element, preferring stable ids and names. */
  function selectorFor(el) {
    const doc = el.ownerDocument;
    if (el.id && !unstableId(el.id) && doc.querySelectorAll('#' + esc(el.id)).length === 1) return '#' + esc(el.id);
    const nm = el.getAttribute && (el.getAttribute('name') || el.getAttribute('formcontrolname'));
    if (nm) {
      const sel = `${el.tagName.toLowerCase()}[name="${nm}"]`;
      if (doc.querySelectorAll(sel).length === 1) return sel;
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== doc.body) {
      if (node !== el && node.id && !unstableId(node.id)) { parts.unshift('#' + esc(node.id)); break; }
      let i = 1, sib = node;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === node.tagName) i++;
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${i})`);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  /**
   * Nearby label text used to find the element again if the selector breaks: the whole text of the label cell or
   * element before it (never cut in the middle). Long texts (> 60 characters) are no anchor; the context is used instead.
   */
  function anchorFor(el) {
    const isCtl = /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
    if (isCtl) { const c = D().labelCandidates(el); if (c.length) return c[0]; }
    const short = (t) => (t && t.length <= 60 ? t : null);
    const cell = el.closest && el.closest('td,th');
    if (cell) { let p = cell.previousElementSibling; while (p && !D().textOf(p)) p = p.previousElementSibling; if (p) return short(D().textOf(p)); }
    let sib = el.previousElementSibling;
    while (sib && !D().textOf(sib)) sib = sib.previousElementSibling;
    if (sib) return short(D().textOf(sib));
    return short(walkOne(el).last);
  }

  const norm = (s) => PDB.core.clean(s).replace(/[*＊:：\s]/g, '');

  // ── context: the text right before an element ──────────────────────────
  const SKIP_CTX = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SELECT|OPTION)$/;
  /** One text piece → comparable key: numbering "(4)" "1." "一、" removed, bracketed notes removed, ≤ 24 chars. */
  function ctxKey(t) {
    let s = PDB.core.clean(t);
    for (let i = 0; i < 3; i++) s = s.replace(/^\s*(?:[(（]\s*[0-9一二三四五六七八九十]+\s*[)）]|[0-9一二三四五六七八九十]+\s*[.、．)）])\s*\.?/, '');
    s = s.replace(/[(（][^()（）]*[)）]/g, '').replace(/[*＊:：，,。.\s]/g, '');
    return s.slice(0, 24);
  }
  const ctxMatch = (a, b) => a && b && (a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a))));
  // a placeholder in a saved sample page ("[Name]") is not page text
  const PLACEHOLDER = /^\s*\[[^\[\]]{1,40}\]\s*$/;
  /**
   * Data that changes from patient to patient is never context: dates, times, ages, numbers of 3+ digits (IDs, phone
   * or bed numbers). Works on a context key, so pieces stored by older templates are judged the same way.
   */
  const volatileKey = (k) => !k || /\d{3}/.test(k) || /\d{1,4}[\/\-]\d{1,2}/.test(k) || /\d+歲/.test(k) || /^\[[^\]]*\]$/.test(k);
  const volatileText = (t) => PLACEHOLDER.test(String(t || '')) || volatileKey(ctxKey(t));
  const stable = (ctx) => (ctx || []).filter((k) => k && !volatileKey(k));
  /*
   * A sentence (20+ characters) may be a long form label, or a notice that changes between visits (the announcement
   * at the top of a page). It counts when it matches, but is not needed: a notice that changed does not lose the field.
   */
  const longKey = (k) => k.length >= 20;
  const needFor = (stored) => (stored.filter((k) => !longKey(k)).length >= 2 ? 2 : 1);
  /**
   * Context pieces that are values read on the same page (a name, a contact person) are not context either; they are
   * removed with the page's known values. Returns the pieces kept.
   */
  function stripValues(ctx, values) {
    const keys = [...new Set((values || []).map((v) => ctxKey(v)).filter((k) => k.length >= 2))];
    if (!keys.length) return ctx || [];
    return (ctx || []).filter((p) => !keys.some((k) => p === k || (k.length >= 3 && p.includes(k))));
  }
  /** An anchor (label text) that is a value read on the page is no anchor. */
  const anchorOk = (anchor, values) => (anchor && stripValues([ctxKey(anchor)], values).length ? anchor : null);
  /**
   * Walk the document once; for every element accepted by `want`, record the last `n` stable text pieces before it
   * (stored when a field is taught), a wider window (`wide`, compared when a field is looked for, so a value that slips
   * in between two labels does not push a label out) and the last whole text before it (for anchors).
   * Returns [{ el, ctx: [farthest … nearest], wide, last }].
   */
  function walkContexts(doc, want, n = 3) {
    const body = doc.body || doc.documentElement;
    const out = [];
    const recent = [];
    let last = '';
    const w = doc.createTreeWalker(body, 1 | 4);
    for (let node = w.currentNode; node; node = w.nextNode()) {
      if (node.nodeType === 1) {
        if (want(node)) out.push({ el: node, ctx: recent.slice(-n), wide: recent.slice(-2 * n), last });
      } else {
        const p = node.parentElement;
        if (!p || SKIP_CTX.test(p.tagName) || p.closest('select,script,style,#' + D().OVERLAY_ID)) continue;
        if (PLACEHOLDER.test(node.nodeValue)) continue;
        const raw = PDB.core.clean(node.nodeValue);
        if (raw) last = raw;
        const k = ctxKey(node.nodeValue);
        if (k.length >= 2 && !volatileKey(k) && recent[recent.length - 1] !== k) { recent.push(k); if (recent.length > 8) recent.shift(); }
      }
    }
    return out;
  }
  /*
   * While a page is read (session), the contexts of all elements are found in one walk and reused,
   * instead of one walk per field.
   */
  let cache = null;
  function session(doc, fn) {
    const prev = cache;
    cache = { doc, all: null, byEl: null };
    try { return fn(); } finally { cache = prev; }
  }
  function cached(doc) {
    if (!cache || cache.doc !== doc) return null;
    if (!cache.all) { cache.all = walkContexts(doc, () => true); cache.byEl = new Map(cache.all.map((x) => [x.el, x])); }
    return cache;
  }
  function contexts(doc, want) {
    const c = cached(doc);
    return c ? c.all.filter((x) => want(x.el)) : walkContexts(doc, want);
  }
  function walkOne(el) {
    const c = cached(el.ownerDocument);
    if (c) return c.byEl.get(el) || { ctx: [], wide: [], last: '' };
    return walkContexts(el.ownerDocument, (x) => x === el)[0] || { ctx: [], wide: [], last: '' };
  }
  /** Context of one element (for teaching); with `values` (read on this page), those are left out too; `wide`: the wider window. */
  const contextFor = (el, values, wide) => {
    const w = walkOne(el);
    if (wide) return w.wide || w.ctx;
    if (!values || !values.length) return w.ctx;
    return stripValues(w.wide, values).slice(-3);
  };
  /** How well a stored context matches a candidate's (nearest pieces weigh most). */
  function ctxScore(stored, cand) {
    let score = 0;
    stored.forEach((k, i) => { if (cand.some((c) => ctxMatch(c, k))) score += 1 + i / 10; });
    return score;
  }
  /** What kind of field a template field is (older fields have no kind: told by their tag). */
  const kindOf = (f, use) => f.kind || (f.tag === 'IMG' ? 'group' : /^(INPUT|SELECT|TEXTAREA)$/.test(f.tag || '') ? (/^(checkbox|radio)$/i.test(f.type || '') ? 'group' : 'control') : f.tag ? 'text' : use === 'fill' ? 'control' : 'text');
  const TEXT_CTL = (e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName) && !/^(hidden|button|submit|image|reset|file|password|checkbox|radio)$/i.test(e.type || '');
  /**
   * Which elements a field can be found on.
   * use: 'fill' (a form to fill) | 'extract' (a page to read); cross: the field was taught in the other mode, so its tag is not compared.
   */
  function wantFor(field, use, cross) {
    const tag = cross ? null : field.tag;
    const kind = kindOf(field, use);
    const notOverlay = (e) => !(e.closest && e.closest('#' + D().OVERLAY_ID));
    if (kind === 'group') return (e) => D().optionAt(e) === e && (use !== 'fill' || e.tagName === 'INPUT') && notOverlay(e);
    if (kind === 'image') return (e) => use !== 'fill' && D().isPicture(e) && (!tag || e.tagName === tag) && notOverlay(e);
    if (use === 'fill') return (e) => TEXT_CTL(e) && (!tag || e.tagName === tag);
    if (cross) return (e) => notOverlay(e) && !/^(BR|HR|IMG|TABLE|TBODY|TR|SCRIPT|STYLE)$/.test(e.tagName) && (TEXT_CTL(e) || !!D().textOf(e));
    return (e) => (!tag || e.tagName === tag) && notOverlay(e);
  }
  /*
   * A picture has no text of its own to show it is the right one, so the text right before it (its caption or label)
   * must be the same; otherwise a chart that moved into its place (e.g. temperature instead of glucose) would be read.
   */
  /*
   * Any other field: the nearest short piece stored (normally its own label) must still be among the pieces right
   * before it, so a field whose row is gone is not found on the next row by the labels further up.
   */
  function nearestOk(field, stored, cand) {
    if (field.kind === 'image') return ctxMatch(stored[stored.length - 1], cand[cand.length - 1]);
    const own = [...stored].reverse().find((k) => !longKey(k));
    return !own || cand.some((c) => ctxMatch(c, own));
  }
  /** Find the element whose preceding text best matches the stored context. */
  function findByContext(doc, field, want) {
    const stored = stable(field.context);
    if (!stored.length) return null;
    if (typeof want !== 'function') want = wantFor(field, want ? 'fill' : 'extract', false);
    let best = null, bestScore = 0;
    for (const c of contexts(doc, want)) {
      if (!nearestOk(field, stored, c.ctx)) continue;
      const s = ctxScore(stored, c.wide || c.ctx);
      if (s > bestScore) { best = c.el; bestScore = s; }
    }
    // with several stored pieces, one weak match (e.g. a generic "其他：") is not enough
    const need = needFor(stored);
    return bestScore >= need ? best : null;
  }
  const contextOk = (el, field) => {
    const stored = stable(field.context);
    if (!stored.length) return true;
    const w = walkOne(el);
    return nearestOk(field, stored, w.ctx) && ctxScore(stored, w.wide || w.ctx) >= needFor(stored);
  };
  /** Find an element by anchor text: the element right after a short text equal to the anchor. */
  function findByAnchor(doc, anchor, wantControl) {
    if (!anchor) return null;
    const a = norm(anchor);
    const cands = Array.from(doc.querySelectorAll('label,th,td,div,span,dt,b,strong,p')).filter((e) => e.children.length <= 2 && norm(D().textOf(e)) === a);
    for (const c of cands) {
      if (wantControl) {
        if (c.tagName === 'LABEL' && c.htmlFor) { const t = doc.getElementById(c.htmlFor); if (t) return t; }
        let n = c;
        for (let d = 0; d < 3 && n; d++) {
          let s = n.nextElementSibling;
          while (s) { const ctl = s.matches('input,select,textarea') ? s : s.querySelector('input:not([type=hidden]),select,textarea'); if (ctl) return ctl; s = s.nextElementSibling; }
          n = n.parentElement;
        }
      } else {
        if (c.tagName === 'TH' || c.tagName === 'TD') { const v = c.nextElementSibling; if (v) return v; }
        let s = c.nextElementSibling;
        while (s && !D().textOf(s)) s = s.nextElementSibling;
        if (s) return s;
      }
    }
    return null;
  }

  /**
   * Find a taught field on a page.
   * use: 'fill' | 'extract' (true / false for older callers); cross: taught in the other mode (found by context and anchor only).
   * For a group, el is one of its options.
   */
  function locate(doc, field, use, cross = false) {
    if (use === true) use = 'fill'; else if (use === false || use == null) use = 'extract';
    const wantControl = use === 'fill';
    const want = wantFor(field, use, cross);
    let el = null, how = 'selector';
    if (!cross) {
      try { el = doc.querySelector(field.selector); } catch (e) { el = null; }
      if (el && !want(el) && kindOf(field, use) === 'group') el = D().optionAt(el);
      if (el && !want(el) && kindOf(field, use) === 'image') el = null; // the selector now points at something that is not a picture
      if (el && field.context && field.context.length) {
        // selector still matches, but is it still in the same place (same text before it)?
        if (!contextOk(el, field)) el = null;
      } else if (el && field.anchor && !wantControl) {
        // older templates: make sure it is still next to the same label
        const an = anchorFor(el);
        if (an && norm(an) !== norm(field.anchor)) el = null;
      }
    }
    if (!el) { el = findByContext(doc, field, want); how = el ? 'context' : 'missing'; }
    if (!el) {
      el = findByAnchor(doc, field.anchor, wantControl);
      if (el && kindOf(field, use) === 'group') el = D().optionAt(el) || D().optionsIn(el)[0] || null;
      else if (el && kindOf(field, use) === 'image' && !want(el)) el = Array.from(el.querySelectorAll('img,canvas,svg')).find(want) || null; // the picture next to the label
      else if (el && cross && !want(el)) el = null;
      how = el ? 'anchor' : 'missing';
    }
    return { el, how };
  }

  /** A located field → what to read or fill: the element, or for a group the whole group. */
  function place(doc, field, use, cross, ctx) {
    const { el, how } = locate(doc, field, use, cross);
    if (!el) return { el: null, how };
    if (kindOf(field, use) === 'group') {
      const g = D().groupOf(el, ctx);
      return { el, how, group: g };
    }
    return { el, how };
  }

  /** Normalised page path: record-number segments become * so one template covers every record of a form. */
  const pagePath = (p) => PDB.core.pagePath(p);
  /** Does a template apply to the document at this path? (Old templates without framePath apply everywhere.) */
  const appliesTo = (t, path) => !t.framePath || pagePath(path) === t.framePath;

  /** Templates that apply to a page. */
  const forPage = (templates, origin, path, direction) =>
    (templates || []).filter((t) => t.direction === direction && t.origin === origin && (!t.path || path.startsWith(t.path)));

  /**
   * Templates → label/value pairs (exact), plus fields that could not be found.
   * Capture's own templates (direction 'extract') apply to the frame page they were taught on and report missing fields;
   * fields taught in Fill (direction 'fill') are also looked for, by context, and are never reported missing.
   */
  function applyExtract(doc, templates, reg, ctx = {}) {
    const pairs = [], broken = [], found = [];
    const path = doc.location ? doc.location.pathname : '';
    const seenEls = new Set();
    const add = (f, p) => {
      if (p.group) {
        const g = p.group;
        if (seenEls.has(g.container) || g.opts.every((o) => D().isHidden(o))) return;
        seenEls.add(g.container);
        const value = D().groupValue({ ...g, label: f.label });
        if (value) pairs.push({ label: f.label, value, ref: reg ? reg.id(g.container) : null, src: 'template', opt: reg ? reg.id(g.opts[0]) : null, how: p.how });
        return;
      }
      const el = p.el;
      if (seenEls.has(el) || D().isHidden(el)) return; // on a hidden tab: not part of what you are looking at
      seenEls.add(el);
      const isCtl = /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
      const value = isCtl ? D().controlValue(el) : D().textOf(el);
      if (value) pairs.push({ label: f.label, value, ref: reg ? reg.id(el) : null, src: 'template', how: p.how });
    };
    const own = templates.filter((t) => (t.direction || 'extract') === 'extract');
    const other = templates.filter((t) => t.direction === 'fill');
    const labels = new Set();
    for (const t of own) {
      if (!appliesTo(t, path)) continue;
      for (const f of t.fields) {
        const p = place(doc, f, 'extract', false, ctx);
        if (!p.el) { broken.push({ template: t.id, label: f.label, anchor: f.anchor }); continue; }
        found.push(f.label);
        labels.add(f.label);
        add(f, p);
      }
    }
    for (const t of other) for (const f of t.fields) {
      if (labels.has(f.label)) continue;
      const p = place(doc, f, 'extract', true, ctx);
      if (p.el) { labels.add(f.label); add(f, p); }
    }
    return { pairs, broken, found };
  }

  PDB.templates = { selectorFor, anchorFor, findByAnchor, locate, place, kindOf, forPage, applyExtract, pagePath, appliesTo, contextFor, findByContext, ctxKey, session, wantFor, volatileText, stripValues, anchorOk };
})(globalThis);
