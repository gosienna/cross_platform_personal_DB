/*
 * Template check: a page template compared with the live page, as a file to export and review (e.g. to see why a
 * field is not found). For every field and table: what the template stores (selector, the text before it, anchor)
 * and what the page shows now (found or not, and how: selector / context / anchor; the text before the element now).
 *
 * No patient data: values are given only as their length and shape ("王小明" → "字字字", "149/71" → "999/99").
 * Page text stored in the template or read now (context, anchor, label text, title) has every value the template
 * reads on this page replaced by [its label], and identifiers found by the privacy patterns (redact.js) masked.
 */
(function (g) {
  const PDB = (g.PDB = g.PDB || {});
  const T = () => PDB.templates, PT = () => PDB.pagetpl, D = () => PDB.dom, C = () => PDB.core;
  const FORMAT = 'personal-db-template-check';

  /** A value's shape: digits → 9, latin letters → a / A, CJK → 字, other characters kept; at most 80 characters. */
  const shapeOf = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 80)
    .replace(/[0-9０-９]/g, '9').replace(/[a-z]/g, 'a').replace(/[A-Z]/g, 'A').replace(/[㐀-鿿豈-﫿]/g, '字');
  const valueInfo = (v) => { const s = C().joinLines(v || ''); return { len: s.length, shape: shapeOf(s) }; };
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** A masker for page text: the given values → [label], then identifiers found by redact.js patterns. */
  function masker(known) {
    const pairs = [];
    for (const { label, value } of known) {
      const v = C().clean(value || '');
      if (v.length < 2) continue;
      for (const x of new Set([v, T().ctxKey(v), ...C().joinLines(value).split(/\n| \| /).map((l) => C().clean(l))])) if (x && x.length >= 2) pairs.push([x, `[${label}]`]);
    }
    pairs.sort((a, b) => b[0].length - a[0].length);
    const res = pairs.map(([v, tok]) => [new RegExp(escRe(v), 'g'), tok]);
    return (s) => {
      if (s == null || s === '') return s;
      let out = String(s);
      for (const [re, tok] of res) out = out.replace(re, tok);
      const R = PDB.redact;
      if (R) { const d = R.detect(out, []); for (const sp of d.spans) sp.decision = 'mask'; out = R.apply(d.text, d.spans).out; }
      return out;
    };
  }

  /**
   * Stored text (context, anchor, label text taught on another record) may hold another patient's values, which the
   * live page cannot mask. It is kept only when the same text is on this page now; otherwise only its shape is given.
   */
  function pageTexts(doc) {
    const out = new Set();
    const w = doc.createTreeWalker(doc.body || doc.documentElement, 4);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const p = n.parentElement;
      if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) continue;
      const c = C().clean(n.nodeValue);
      if (!c) continue;
      out.add(c); out.add(T().ctxKey(c));
    }
    return out;
  }
  const guard = (texts, mask) => (s) => {
    if (s == null || s === '') return s;
    const c = C().clean(s);
    return texts.has(c) || texts.has(T().ctxKey(c)) || /^\[[^\]]*\]$/.test(c) ? mask(s) : `‹not on this page: ${shapeOf(c)}›`;
  };

  const ctxMatch = (a, b) => a && b && (a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a))));
  /** Which stored context pieces the element's context now has (same test as templates.js). */
  function ctxHits(stored, now) { return (stored || []).map((k) => now.some((c) => ctxMatch(c, k))); }

  /**
   * Check a template against a document.
   * ctx: as for pagetpl.extract (origin, refYear …), plus page: { path, query } for a document without its address
   * (a saved sample page) and source: 'live' | 'sample'. Returns the check object (JSON-safe).
   * The template is read from a copy: reading tidies a template (see pagetpl tidyField), the file shows it as saved.
   */
  function check(doc, tpl, ctx = {}) {
    return T().session(doc, () => {
      const copy = JSON.parse(JSON.stringify(tpl));
      const res = PT().extract(doc, copy, { ...ctx, registry: D().makeRegistry() });
      const tidied = new Map(copy.fields.map((f) => [f.id, f]));
      const known = [];
      for (const f of tpl.fields) { const l = res.located.get(f.id); if (l && l.raw) known.push({ label: PT().fieldName(f) || f.label, value: l.raw }); }
      const mask = masker(known);
      const maskList = (a) => (a || []).map(mask);
      const old = guard(pageTexts(doc), mask); // stored text: kept only if it is on this page
      const oldList = (a) => (a || []).map(old);
      // the label is yours (vocabulary or typed); names read from the page (label text, anchor) are checked as stored text
      const lbl = (l, f) => (l && l === f.label ? l : old(l));
      const fields = tpl.fields.map((f) => {
        const l = res.located.get(f.id);
        let sel = null;
        try { sel = doc.querySelector(f.selector); } catch (e) { sel = null; }
        const out = {
          id: f.id, label: f.label, name: lbl(PT().fieldName(f), f), rawLabel: old(f.rawLabel), kind: f.kind || null, role: f.role || null, group: f.group || null,
          from: f.from || null, part: f.part ? { ...f.part, inline: f.part.inline != null ? old(f.part.inline) : undefined } : null, time: f.time || null, tag: f.tag || null,
          stored: { selector: f.selector, context: oldList(f.context), anchor: old(f.anchor) },
          found: !!l, how: l ? l.how || null : 'missing',
          tidy: l && JSON.stringify(tidied.get(f.id).context) !== JSON.stringify(f.context || []) ? 'stored text from another record is dropped on the next Save' : undefined,
          selectorNow: sel ? { tag: sel.tagName, context: maskList(T().contextFor(sel)), anchor: mask(T().anchorFor(sel)), contextHits: ctxHits(f.context, T().contextFor(sel)) } : null,
        };
        if (l) {
          const el = l.el;
          out.now = { tag: el.tagName, selector: T().selectorFor(el), selectorHit: sel === el, hidden: !!l.hidden,
            context: maskList(T().contextFor(el)), anchor: mask(T().anchorFor(el)), contextHits: ctxHits(f.context, T().contextFor(el)), value: valueInfo(l.raw) };
        }
        return out;
      });
      const tables = tpl.tables.map((t) => {
        const l = res.located.get(t.id);
        let sel = null;
        try { sel = doc.querySelector(t.selector); } catch (e) { sel = null; }
        const heads = (t.map.layout === 'chart' ? t.map.rows : t.map.columns).map((c) => c.header).filter(Boolean);
        return {
          id: t.id, layout: t.map.layout, ignored: !!t.ignored, from: t.from || null, time: t.time || null,
          stored: { selector: t.selector, headers: heads.map(old), context: oldList(t.context) },
          found: !!l, selectorHit: !!(l && sel === l.el), selectorNow: sel ? sel.tagName : null,
          now: l ? { selector: T().selectorFor(l.el), rows: (l.el.rows || []).length, hidden: D().isHidden(l.el) } : null,
        };
      });
      const items = res.records.reduce((k, r) => k + r.items.length + r.meds.length, 0);
      const byHow = {};
      for (const f of fields) byHow[f.how] = (byHow[f.how] || 0) + 1;
      const loc = doc.location || {};
      const page = ctx.page || { path: T().pagePath(loc.pathname || ''), query: C().queryKey ? C().queryKey(loc.search || '') : '' };
      return {
        format: FORMAT, v: 1, checkedAt: new Date().toISOString(), source: ctx.source || 'live',
        page: { origin: ctx.origin || loc.origin || '', path: page.path, query: page.query || '', title: old(doc.title || '') },
        template: { id: tpl.id, title: old(tpl.title || ''), origin: tpl.origin, framePath: tpl.framePath, query: tpl.query || '', addresses: tpl.addresses || [],
          complete: !!tpl.complete, draft: !!tpl._draft, createdAt: tpl.createdAt || null, updatedAt: tpl.updatedAt || null },
        summary: { fields: fields.length, found: fields.filter((f) => f.found).length, missing: fields.filter((f) => !f.found).map((f) => f.name),
          byHow, tables: tables.length, tablesFound: tables.filter((t) => t.found).length, values: items },
        fields, tables,
      };
    });
  }

  PDB.tplcheck = { check, shapeOf, masker, FORMAT };
})(globalThis);
