/*
 * Page templates: one full template per page (a site's frame page), assuming the page's layout is fixed.
 *   - The built-in rules make the first draft of a page's template; it is saved with the data on Save.
 *   - After that the page is read strictly by its template: only template fields are saved. What the rules find
 *     outside the template is offered as "not in the template" (to add or to ignore), never saved on its own.
 *   - Every field has a time link: fixed (nan), another field on the page (e.g. 填表日期), the table's time
 *     column, or the capture time.
 *
 *   PageTemplate { id, v: 2, origin, framePath, title, complete, createdAt, updatedAt, fields: [Field], tables: [Table] }
 *   Field  { id, kind: 'text'|'control'|'group'|'image', selector, context, anchor, tag, part?, group, mask?,
 *            label ('__ignore__' = known, not saved), rawLabel, role: 'data'|'identity'|'recordDate'|'time',
 *            unmapped?, time: TimeLink, from: 'rule'|'taught'|'ai'|'sample', how }
 *            part: which bit of the element's text: { line } | { word } | { inline: label } (default: all of it)
 *            group: fields of one group form one record (one patient), e.g. a label/value table
 *            kind 'image': a picture (chart, scanned form, photo of a meter). It has no page text: extract() lists it in
 *              `images`, and the side panel adds the values Claude read from it (see imageItems). mask = the boxes
 *              blacked out before sending, as fractions of the picture ([{ x, y, w, h }], 0–1), offered again next time.
 *   Table  { id, kind: 'table', layout: 'list'|'chart', selector, context, tag: 'TABLE', map, time: TimeLink, from }
 *            map: how columns (list) or rows (chart) are read; see core.listMap / core.chartMap
 *   TimeLink { mode: 'nan' } | { mode: 'field', field: <field id> } | { mode: 'column', cols? } | { mode: 'capture' }
 *            | { mode: 'image' } (image fields: the time written in the picture, e.g. a chart's dates; capture time if none)
 */
(function (g) {
  const PDB = (g.PDB = g.PDB || {});
  const C = () => PDB.core, D = () => PDB.dom, T = () => PDB.templates, S = () => PDB.schema;
  const IGNORE = '__ignore__';
  let seq = 0;
  const newId = (p) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const entryOf = (label) => (label ? S().byLabel[label] || S().byLabel[String(label).replace(/\s*\((AC|PC|HS)\)$/, '')] || null : null);
  const isPersistent = (label) => { const e = entryOf(label); return !!(e && e.persistent); };
  const isCtl = (el) => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);

  // ── reading a field ──────────────────────────────────────────────────
  const linesFor = (el) => D().linesOf(el, /^(TD|TH)$/.test(el.tagName) ? { skipTables: true } : undefined);
  function partOf(el, part) {
    const lines = linesFor(el);
    if (!part) return lines.join('\n');
    if (part.line != null) return lines[part.line] || '';
    if (part.word != null) return (lines[0] || '').split(/\s+/)[part.word] || '';
    if (part.inline != null) { const hit = D().splitInlinePairs(D().textOf(el)).find(([l]) => l === part.inline); return hit ? hit[1] : ''; }
    return lines.join('\n');
  }
  function readField(f, p) {
    if (f.kind === 'image') return '';
    if (p.group) return D().groupValue(p.group);
    if (isCtl(p.el)) return D().readControl(p.el);
    return partOf(p.el, f.part);
  }
  /** Which bit of a text element an item came from (for elements holding several values). */
  function partFor(el, item) {
    const J = (s) => C().joinLines(s);
    const lines = linesFor(el);
    if (J(lines.join('\n')) === item.raw) return null;
    const i = lines.findIndex((l) => J(l) === item.raw);
    if (i >= 0) return { line: i };
    const hit = D().splitInlinePairs(D().textOf(el)).find(([l, v]) => l === item.rawLabel && J(v) === item.raw);
    if (hit) return { inline: hit[0] };
    const w = (lines[0] || '').split(/\s+/).indexOf(item.raw);
    return w >= 0 ? { word: w } : null;
  }

  // ── names and time links (for display) ───────────────────────────────
  const fieldName = (f) => (f.role === 'time' || f.label === IGNORE || f.unmapped || f.role === 'recordDate'
    ? C().cleanLabel(f.rawLabel || f.anchor || '') || f.label : f.label);
  /** fid of an item → { unit (field or table), col } */
  function unitOf(tpl, fid) {
    if (!tpl || !fid) return null;
    const f = tpl.fields.find((x) => x.id === fid);
    if (f) return { unit: f };
    const [tid, key] = String(fid).split(':');
    const t = tpl.tables.find((x) => x.id === tid);
    if (!t) return null;
    if (key == null) return { unit: t };
    if (key === 'med') return { unit: t, col: 'med' };
    const [ci, sub] = key.split('.').map(Number);
    const col = t.map.layout === 'chart' ? t.map.rows.find((r) => r.i === ci) : t.map.columns.find((c) => c.i === ci);
    return { unit: t, col, sub: Number.isFinite(sub) ? sub : null };
  }
  /** How a unit gets its time, in words: { mode, text, warn } */
  function timeText(tpl, unit) {
    const l = unit.time || { mode: 'capture' };
    if (unit.kind !== 'table' && isPersistent(unit.label)) return { mode: 'nan', text: 'fixed' };
    if (l.mode === 'nan') return { mode: 'nan', text: 'fixed' };
    if (l.mode === 'field') {
      const f = tpl.fields.find((x) => x.id === l.field);
      if (!f) return { mode: 'field', text: '← (field missing)', warn: true };
      return { mode: 'field', text: f.id === unit.id ? 'own value' : `← ${fieldName(f)}` };
    }
    if (l.mode === 'image' && unit.kind === 'image') return { mode: 'image', text: 'written in the picture' };
    if (l.mode === 'column' && unit.kind === 'table') {
      if (unit.map.layout === 'chart') return { mode: 'column', text: '← column headers' };
      const names = (l.cols || []).map((i) => (unit.map.columns.find((c) => c.i === i) || {}).header).filter(Boolean);
      if (names.length) return { mode: 'column', text: `← column ${names.join(' + ')}` };
    }
    return { mode: 'capture', text: 'capture time', warn: true };
  }
  /** Columns of a list that hold times (to offer as time links). */
  const timeColumns = (t) => (t.map.layout === 'list' ? t.map.columns.filter((c) => c.kind === 'time' || /日期|時間|date|time/i.test(c.header)) : []);
  /** The record-date field a field in `group` takes its time from by default. */
  function recordDateFor(tpl, group) {
    const rd = tpl.fields.filter((f) => f.role === 'recordDate' && f.label !== IGNORE);
    return rd.filter((f) => f.group === group).pop() || rd.filter((f) => f.group === 'p').pop() || rd[0] || null;
  }
  /** Default time link for a new field. */
  function defaultTime(tpl, f) {
    if (isPersistent(f.label)) return { mode: 'nan' };
    if (f.role === 'recordDate') return { mode: 'field', field: f.id };
    if (f.kind === 'image') return { mode: 'image' };
    const rd = recordDateFor(tpl, f.group);
    return rd ? { mode: 'field', field: rd.id } : { mode: 'capture' };
  }
  const roleFor = (label, rawLabel, prev) => {
    if (prev === 'time') return 'time';
    if (C().labelKind(rawLabel || '') === 'recordDate' && (!label || label === C().cleanLabel(rawLabel))) return 'recordDate';
    const e = entryOf(label);
    return e && e.identity ? 'identity' : 'data';
  };

  // ── draft: the rules' reading of a page → a template ─────────────────
  /**
   * ex: extractFromRoot(doc, { registry }) output (in the page, before serialising).
   * opts: { origin, framePath, title, base (a partial template to complete), els (Map id → element, filled), values (Map id → value) }
   */
  function draft(doc, ex, opts = {}) {
    const reg = ex.registry;
    const base = opts.base || null;
    const tpl = { id: base ? base.id : newId('pt-'), v: 2, origin: opts.origin || (base && base.origin) || '', framePath: opts.framePath || (base && base.framePath) || '',
      query: opts.query != null ? opts.query : (base && base.query) || '', title: opts.title || (base && base.title) || '', complete: false, createdAt: (base && base.createdAt) || Date.now(), updatedAt: Date.now(), fields: [], tables: [] };
    const els = opts.els || new Map(), values = opts.values || new Map();
    const regionOf = new Map(ex.regions.filter((r) => r.ref != null).map((r) => [r.ref, r]));
    return T().session(doc, () => {
      for (const r of ex.regions) {
        if (r.ref == null || !r.map || (r.kind !== 'list' && r.kind !== 'chart')) continue;
        const el = reg.els[r.ref];
        if (!el) continue;
        const t = { id: newId('t'), kind: 'table', layout: r.map.layout, selector: T().selectorFor(el), context: T().contextFor(el), tag: 'TABLE', map: r.map, time: r.map.time, from: 'rule' };
        tpl.tables.push(t); els.set(t.id, el); values.set(t.id, `${r.items} values`);
      }
      const seen = new Set();
      for (const rec of ex.records) {
        const meds = rec.meds.map((m) => ({ ref: m.ref, region: m.region, label: 'Medication', rawLabel: 'Medication', raw: null, value: C().medValue(m.fields) }));
        for (const it of rec.items.concat(meds)) {
          if (it.ref == null) continue;
          const rg = it.region != null ? regionOf.get(it.region) : null;
          if (rg && (rg.kind === 'list' || rg.kind === 'chart')) continue;
          const el = reg.els[it.ref];
          if (!el) continue;
          const info = ex.pairInfo && ex.pairInfo.get(it.ref);
          const grp = info && info.opt != null && reg.els[info.opt] ? reg.els[info.opt] : null;
          const kind = grp ? 'group' : isCtl(el) ? 'control' : 'text';
          const target = grp || el;
          const label = it.entry ? it.entry.label : it.label;
          const part = kind === 'text' && it.raw != null ? partFor(el, it) : null;
          const key = `${it.ref}|${JSON.stringify(part)}|${label}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const f = { id: newId('f'), kind, selector: T().selectorFor(target), context: T().contextFor(target),
            anchor: kind === 'group' ? it.rawLabel || null : T().anchorFor(target), tag: target.tagName,
            label, rawLabel: it.rawLabel || label, role: roleFor(label, it.rawLabel), group: it.region != null ? `t${it.region}` : 'p',
            from: info && info.src === 'template' ? 'taught' : 'rule', how: it.how || null, time: null };
          if (part) f.part = part;
          if (it.unmapped) f.unmapped = true;
          tpl.fields.push(f); els.set(f.id, kind === 'group' ? el : target); values.set(f.id, it.value);
        }
      }
      // what the fields read (a name, a contact person) is no context or label text of a field
      for (const f of tpl.fields) {
        const others = otherValues(tpl, f.id, (id) => values.get(id));
        f.context = T().stripValues(f.context, others);
        if (f.kind !== 'group') f.anchor = T().anchorOk(f.anchor, others);
      }
      for (const f of tpl.fields) f.time = defaultTime(tpl, f);
      for (const t of tpl.tables) if (t.layout === 'list' && !(t.time.cols || []).length) {
        const rd = recordDateFor(tpl, 'p');
        t.time = rd ? { mode: 'field', field: rd.id } : { mode: 'capture' };
      }
      return tpl;
    });
  }

  /** A page title without the values read on the page (each becomes "…"). */
  function cleanTitle(title, values) {
    let out = String(title || '');
    for (const v of (values || []).filter((x) => typeof x === 'string').map((x) => C().clean(x)).filter((x) => x.length >= 2).sort((a, b) => b.length - a.length)) out = out.split(v).join('…');
    return out;
  }
  /** The values the fields of a template read, its own included (strings of 2+ characters): none is context of a field. */
  const otherValues = (tpl, id, valueOf) => tpl.fields.map((x) => valueOf(x.id)).filter((v) => typeof v === 'string' && C().clean(v).length >= 2);
  /**
   * Older templates (and fields taught on another record) can keep text of that record: another patient's name next to
   * the field, a contact person as its label text. When the field is found, such pieces are removed — only removed,
   * never replaced, so the template settles and is not changed again on the next record. Returns true if changed.
   */
  function tidyField(f, p, others, pageHas) {
    if (f.kind === 'image' || (p.how !== 'selector' && p.how !== 'context')) return false;
    const live = T().contextFor(p.el, null, true);
    const keep = (f.context || []).filter((k) => k && !T().volatileText(k) && (k.length >= 20 || live.some((c) => c === k || c.startsWith(k) || k.startsWith(c))));
    const kept = T().stripValues(keep, others);
    let changed = kept.length !== (f.context || []).length;
    if (changed) f.context = kept;
    if (f.kind !== 'group' && f.anchor && (!pageHas(f.anchor) || !T().anchorOk(f.anchor, others))) {
      if (f.rawLabel === f.anchor) f.rawLabel = f.label === IGNORE ? '' : f.label;
      f.anchor = null; changed = true;
    }
    return changed;
  }

  // ── strict reading ───────────────────────────────────────────────────
  const tableHeaders = (t) => (t.map.layout === 'chart' ? t.map.rows.map((r) => r.header) : t.map.columns.map((c) => c.header)).filter(Boolean);
  const cellText = (td) => D().linesOf(td, { skipTables: true }).join(' ');
  /** How well a <table> matches a template table (share of its headers found), 0–1. */
  function tableScore(el, t) {
    const heads = tableHeaders(t);
    if (!heads.length || !el.rows) return 0;
    const rows = Array.from(el.rows);
    if (t.map.layout === 'chart') {
      const firsts = new Set(rows.map((r) => (r.cells[0] ? cellText(r.cells[0]) : '')));
      return heads.filter((x) => firsts.has(x)).length / heads.length;
    }
    let best = 0;
    for (const r of rows.slice(0, 6)) {
      const texts = new Set(Array.from(r.cells).map(cellText));
      best = Math.max(best, heads.filter((x) => texts.has(x)).length / heads.length);
    }
    return best;
  }
  function findTable(doc, t) {
    let el = null;
    try { el = doc.querySelector(t.selector); } catch (e) { el = null; }
    if (el && el.tagName === 'TABLE' && tableScore(el, t) >= 0.5) return el;
    let best = null, bs = 0;
    for (const x of doc.querySelectorAll('table')) { if (x.closest('#' + D().OVERLAY_ID)) continue; const s = tableScore(x, t); if (s > bs) { best = x; bs = s; } }
    return bs >= 0.5 ? best : null;
  }
  /** The stored map, with the header row / chart rows found again by their text (rows can come and go). */
  function fitMap(map, rows) {
    if (map.layout === 'chart') {
      const out = map.rows.map((vr) => { const i = rows.findIndex((r) => r[0] && r[0].text === vr.header); return { ...vr, i: i >= 0 ? i : vr.i }; });
      return { ...map, rows: out, first: Math.min(...out.map((r) => r.i)) };
    }
    const heads = map.columns.filter((c) => c.header);
    let best = map.headerRow, bs = -1;
    for (let h = 0; h < Math.min(4, rows.length); h++) {
      const s = heads.filter((c) => rows[h][c.i] && rows[h][c.i].lines.join(' ') === c.header).length;
      if (s > bs) { best = h; bs = s; }
    }
    return { ...map, headerRow: bs >= heads.length / 2 ? best : map.headerRow };
  }
  const docOrder = (a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & 4 ? -1 : 1);

  /**
   * Read a page strictly by its template.
   * Returns { records, regions, broken: [{ id, label }], located: Map id → { el, box, group?, raw }, changed }
   *   items carry fid (the template field / table column) and timeRef (the element their time was read from).
   */
  function extract(doc, tpl, ctx = {}) {
    const reg = ctx.registry || D().makeRegistry();
    const now = new Date();
    ctx = { refYear: now.getFullYear(), refDate: { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() }, ...ctx };
    return T().session(doc, () => {
      const located = new Map(), broken = [];
      let changed = false;
      for (const f of tpl.fields) {
        // a field added on the saved sample page is first found by its selector, then its context is learned from the live page
        const fresh = f.from === 'sample' && !f.live;
        let p = fresh ? T().place(doc, { ...f, context: [], anchor: null }, 'extract', false, ctx) : { el: null };
        if (!p.el) p = T().place(doc, f, 'extract', false, ctx);
        if (!p.el) { broken.push({ id: f.id, label: fieldName(f), anchor: f.anchor }); continue; }
        if (fresh) { f.context = T().contextFor(p.el); f.live = true; changed = true; }
        const box = p.group ? p.group.container : p.el;
        const hidden = p.group ? p.group.opts.every((o) => D().isHidden(o)) : D().isHidden(p.el);
        located.set(f.id, { el: p.el, box, group: p.group || null, raw: readField(f, p), hidden, how: p.how, p });
      }
      // found fields drop text left from another record (see tidyField)
      let bodyText = null;
      const pageHas = (s) => { if (bodyText == null) bodyText = C().clean((doc.body || doc.documentElement).textContent || ''); return bodyText.includes(C().clean(s)); };
      for (const f of tpl.fields) {
        const l = located.get(f.id);
        if (l && tidyField(f, l.p, otherValues(tpl, f.id, (id) => (located.get(id) || {}).raw), pageHas)) changed = true;
      }
      // the page title saved with the template ("住民檔案 | <name>") keeps no value read on the page
      if (tpl.title) {
        const t = cleanTitle(tpl.title, [...located.values()].map((l) => l.raw));
        if (t !== tpl.title) { tpl.title = t; changed = true; }
      }
      for (const l of located.values()) delete l.p;
      const timeOf = (link) => {
        if (!link || link.mode === 'capture') return { t: undefined };
        if (link.mode === 'nan') return { t: 'nan' };
        if (link.mode === 'field') {
          const l = located.get(link.field);
          if (!l) return { t: undefined };
          const p = C().parseDateTime(l.raw, { refYear: ctx.refYear, refDate: ctx.refDate });
          return { t: p && p.kind !== 'relative' ? C().formatTime(p) : undefined, ref: reg.id(l.box) };
        }
        return { t: undefined };
      };
      const units = [], groups = new Map(), regions = [], images = [];
      for (const f of tpl.fields) {
        if (f.label === IGNORE || f.role === 'time') continue;
        const l = located.get(f.id);
        if (!l || l.hidden) continue;
        if (!groups.has(f.group)) { const rec = C().newRecord(); groups.set(f.group, rec); units.push({ el: l.box, recs: [rec], page: f.group === 'p' }); }
        const rec = groups.get(f.group);
        const tm = timeOf(f.time);
        if (f.kind === 'image') {
          // no page text to read: the side panel reads the picture (or reuses its earlier reading) and adds its values
          images.push({ fid: f.id, ref: reg.id(l.el), label: f.label, anchor: f.anchor || '', tag: l.el.tagName, rec, t: tm.t, timeRef: tm.ref != null ? tm.ref : null,
            mode: (f.time && f.time.mode) || 'capture', mask: f.mask || [] });
          continue;
        }
        const n = rec.items.length, m = rec.meds.length;
        C().addMapped(rec, { label: f.label, rawLabel: f.rawLabel || f.label, recordDate: f.role === 'recordDate', how: f.from === 'rule' ? f.how : 'template',
          unmapped: !!f.unmapped, strict: true, fid: f.id }, l.raw, ctx, reg.id(l.box), tm.t);
        if (tm.ref != null) for (const it of rec.items.slice(n)) it.timeRef = tm.ref;
        for (const md of rec.meds.slice(m)) md.fid = f.id;
      }
      for (const t of tpl.tables) {
        const el = findTable(doc, t);
        if (!el) { broken.push({ id: t.id, label: `table (${tableHeaders(t).slice(0, 3).join(' | ')})` }); continue; }
        located.set(t.id, { el, box: el, raw: '' });
        if (t.ignored || D().isHidden(el)) continue; // a table left out: known (not offered again), not read
        const tref = reg.id(el);
        const grid = D().gridOf(el).map((r) => r.map((c) => ({ text: c.text, lines: c.lines, th: c.th, ref: c.el ? reg.id(c.el) : null })));
        const rows = grid.filter((r) => r.some((c) => C().clean(c.text)));
        if (!rows.length) continue;
        const map = fitMap(t.map, rows);
        const tm = t.time && t.time.mode === 'field' ? timeOf(t.time) : null;
        const opts = { strict: true, fid: t.id, time: t.time, fixedTime: tm ? (tm.t === undefined ? null : tm.t) : undefined };
        const recs = (map.layout === 'chart' ? [C().applyChart(rows, map, ctx, opts)] : C().applyList(rows, map, ctx, opts)).filter((r) => r.items.length || r.meds.length);
        for (const r of recs) {
          for (const it of r.items) { it.region = tref; if (tm && tm.ref != null) it.timeRef = tm.ref; }
          for (const md of r.meds) md.region = tref;
        }
        units.push({ el, recs });
        regions.push({ ref: tref, kind: map.layout, items: recs.reduce((k, r) => k + r.items.length + r.meds.length, 0) });
      }
      units.sort((a, b) => (a.page !== b.page ? (a.page ? 1 : -1) : docOrder(a.el, b.el)));
      const records = units.flatMap((u) => u.recs);
      const pageRec = units.find((u) => u.page);
      if (pageRec) regions.push({ ref: null, kind: 'fields', items: pageRec.recs[0].items.length });
      for (const im of images) im.rec = records.indexOf(im.rec); // which record the picture's values belong to
      return { records, regions, broken, located, changed, registry: reg, images };
    });
  }

  /**
   * What the rules find on the page that the template does not cover: candidate fields and tables.
   * res: extract() output. Returns [{ unit, value, ref }] (unit: a field or table, ready to add).
   */
  function uncovered(doc, tpl, res, ctx = {}) {
    const reg = res.registry;
    const covered = new Set(), tables = [];
    const groupOfTable = new Map();
    for (const [id, l] of res.located) {
      covered.add(l.el); covered.add(l.box);
      if (l.group) for (const o of l.group.opts) covered.add(o);
      if (l.box.tagName === 'TABLE') tables.push(l.box);
      const f = tpl.fields.find((x) => x.id === id);
      const tb = l.box.closest && l.box.closest('table');
      if (f && tb && !groupOfTable.has(tb)) groupOfTable.set(tb, f.group);
    }
    const isCovered = (el) => !el || covered.has(el) || tables.some((t) => t.contains(el));
    const rules = D().extractFromRoot(doc, { ...ctx, registry: reg, templates: [] });
    const els = new Map(), values = new Map();
    const d = draft(doc, rules, { origin: tpl.origin, framePath: tpl.framePath, els, values });
    const out = [];
    for (const t of d.tables) if (!isCovered(els.get(t.id))) out.push({ unit: t, value: values.get(t.id), ref: reg.id(els.get(t.id)) });
    for (const f of d.fields) {
      const el = els.get(f.id);
      if (isCovered(el)) continue;
      const tb = el.closest && el.closest('table');
      f.group = (tb && groupOfTable.get(tb)) || (f.group === 'p' ? 'p' : f.group);
      f.time = null; // set against the real template when added
      out.push({ unit: f, value: values.get(f.id), ref: reg.id(el) });
    }
    return out;
  }

  /**
   * Values Claude read from a picture (an image field) → items of the picture's record, as if read from the page.
   * reading: { rows: [{ label, value, time, exact }] } (kept per picture by the side panel, so the same picture always
   *   gives the same values); img: an entry of extract()'s `images`.
   * Time: with the field's time link 'image', each value's own time from the picture (capture time when it shows none);
   * with any other link, that link's time, as for any field. Values estimated from a chart's axes (exact: false) are flagged.
   */
  function imageItems(rec, reading, img, ctx = {}) {
    let k = 0;
    for (const row of (reading && reading.rows) || []) {
      const r = C().resolveLabel(row.label || '', ctx);
      if (r && r.ignore) continue;
      let label = (r && r.label) || C().cleanLabel(row.label || '') || img.label;
      const tag = /\((AC|PC|HS)\)\s*$/i.exec(row.label || ''); // a glucose meal-time tag stays in the label
      if (tag && r && r.entry && r.entry.type === 'glucose') label = `${r.entry.label} (${tag[1].toUpperCase()})`;
      let t = img.t;
      if (img.mode === 'image') {
        const tt = String(row.time || '').trim();
        const p = tt && tt !== 'nan' ? C().parseDateTime(tt) : null;
        t = tt === 'nan' ? 'nan' : p && p.kind !== 'relative' ? C().formatTime(p) : undefined;
      }
      const n = rec.items.length;
      C().addMapped(rec, { label, rawLabel: row.label || img.label, how: 'image', strict: true, fid: img.fid }, String(row.value == null ? '' : row.value), ctx, img.ref, t);
      for (const it of rec.items.slice(n)) {
        if (img.timeRef != null && img.mode !== 'image') it.timeRef = img.timeRef;
        if (row.exact === false) { it.estimated = true; it.warn = it.warn || 'estimated_from_picture'; }
        k++;
      }
    }
    return k;
  }

  // ── which template is this page? (layout first, address second) ─────
  const USE = 0.7, ASK = 0.4; // share of a template's fields found on the page: use it / ask whether it is this page
  const parseQ = (q) => new Map(String(q || '').split('&').filter(Boolean).map((x) => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)]; }));
  /** How well an address fits a template (0–1): same page path, and the same values for the query keys that pick the page. */
  function addressScore(t, page) {
    let best = 0;
    for (const a of [{ path: t.framePath, query: t.query || '' }, ...(t.addresses || [])]) {
      if (a.path !== page.path) continue;
      const want = parseQ(a.query), have = parseQ(page.query);
      let sc = 1;
      for (const [k, v] of want) sc -= !have.has(k) ? 0.2 : have.get(k) !== v ? 0.6 : 0;
      for (const k of have.keys()) if (!want.has(k)) sc -= 0.1;
      best = Math.max(best, sc);
    }
    return Math.max(0, best);
  }
  /** Share of a template's fields and tables found on the page by their position and the text before them (label text alone is not enough). */
  function layoutScore(doc, t, ctx, quick) {
    let found = 0, total = 0;
    for (const f of t.fields) {
      total++;
      if (quick) { let el = null; try { el = doc.querySelector(f.selector); } catch (e) { el = null; } if (el) found++; continue; }
      if (T().place(doc, { ...f, anchor: null }, 'extract', false, ctx).el) found++;
    }
    for (const tb of t.tables) { total += 2; const el = findTable(doc, tb); if (el && sameMeaning(el, tb)) found += 2; }
    return { found, total, score: total ? found / total : 0 };
  }
  /**
   * A list whose value column takes its meaning from the page heading ("數據" under "體溫測量") is only the same list
   * when the heading names the same measurement (a glucose list is not a temperature list with the same columns).
   */
  function sameMeaning(el, tb) {
    const gen = tb.map.layout === 'list' ? tb.map.columns.find((c) => c.kind === 'generic' && c.spec && c.spec.label) : null;
    if (!gen) return true;
    const v = C().vitalFromText(D().precedingText(el));
    return !v || v.label === gen.spec.label;
  }
  /**
   * The template for a page, among the site's templates.
   * page: { path (normalised), query (queryKey) }. Templates with only a few taught fields (older ones) match by address only.
   * Returns { tpl, decision: 'use' | 'ask' | 'none', how: 'address' | 'layout', found, total, candidates: [{ id, title, found, total, score }] }
   */
  function match(doc, templates, page, ctx = {}) {
    return T().session(doc, () => {
      const full = templates.filter((t) => t.complete && !t._draft);
      const scored = [];
      for (const t of full) {
        const addr = addressScore(t, page);
        // a cheap first look (selectors only) before the full check, unless the address already fits
        if (!addr && layoutScore(doc, t, ctx, true).score < 0.3) continue;
        const ls = layoutScore(doc, t, ctx, false);
        scored.push({ t, addr, ...ls, final: Math.min(1, ls.score + 0.1 * addr) });
      }
      scored.sort((a, b) => b.final - a.final || b.addr - a.addr);
      const candidates = scored.map((x) => ({ id: x.t.id, title: x.t.title || x.t.framePath, found: x.found, total: x.total, score: Math.round(x.score * 100) / 100, address: x.addr > 0 }));
      const best = scored[0];
      if (best) {
        const enough = best.total >= 3 || best.t.tables.length > 0 || best.addr > 0; // a table's headers are evidence enough
        const how = best.addr >= 0.9 ? 'address' : 'layout';
        if (enough && (best.score >= USE || (best.addr >= 0.9 && best.score >= 0.5))) return { tpl: best.t, decision: 'use', how, found: best.found, total: best.total, candidates };
        if (enough && best.score >= ASK) return { tpl: best.t, decision: 'ask', how, found: best.found, total: best.total, candidates };
      }
      // an older template (taught fields only) of this address: completed from the rules
      const partial = templates.find((t) => !t.complete && !t._draft && addressScore(t, page) > 0);
      return { tpl: partial || null, decision: partial ? 'partial' : 'none', candidates };
    });
  }
  /** Remember that this address shows this template (when it was matched by layout or chosen). */
  function rememberAddress(t, page) {
    if (addressScore(t, page) >= 0.99) return false;
    t.addresses = [...(t.addresses || []).filter((a) => !(a.path === page.path && a.query === page.query)), { path: page.path, query: page.query }].slice(-20);
    return true;
  }

  // ── editing ──────────────────────────────────────────────────────────
  const touch = (tpl) => { tpl.updatedAt = Date.now(); return tpl; };
  /** Change the label of a field, or of a table column / chart row. */
  function setLabel(tpl, fid, label) {
    const u = unitOf(tpl, fid);
    if (!u) return false;
    if (u.unit.kind !== 'table') {
      const f = u.unit;
      f.label = label; f.unmapped = false; f.how = 'taught';
      f.role = roleFor(label, f.rawLabel, f.role);
      if (isPersistent(label)) f.time = { mode: 'nan' };
      return !!touch(tpl);
    }
    if (!u.col || u.col === 'med') return false;
    const spec = { label, rawLabel: u.col.header, how: 'taught' };
    if (u.sub != null && u.col.sub) u.col.sub[u.sub] = spec;
    else { u.col.spec = spec; u.col.sub = null; }
    u.col.off = false; u.col.taught = true;
    return !!touch(tpl);
  }
  /** Leave a field (or a column / chart row) out: it stays in the template as known, so it is not offered again. */
  function removeUnit(tpl, fid) {
    const u = unitOf(tpl, fid);
    if (!u) return false;
    if (u.unit.kind !== 'table') { if (u.unit.label !== IGNORE) { u.unit.prevLabel = u.unit.label; u.unit.label = IGNORE; } }
    else if (u.col && u.col !== 'med') u.col.off = true;
    else if (!u.col) u.unit.ignored = true; // the whole table
    else return false;
    return !!touch(tpl);
  }
  /** Undo removeUnit: the field is read again under its old label. */
  function restoreUnit(tpl, id) {
    const u = unitOf(tpl, id);
    if (!u) return false;
    if (u.unit.kind !== 'table') {
      const f = u.unit;
      if (f.label !== IGNORE) return false;
      // its old label; for one ignored from the start, the label its page text maps to (or the text itself)
      const r = C().resolveLabel(f.rawLabel || '');
      f.label = f.prevLabel || (r && r.label) || C().cleanLabel(f.rawLabel || f.anchor || '') || 'field';
      if (!f.prevLabel && !r) f.unmapped = true;
      delete f.prevLabel;
      f.role = roleFor(f.label, f.rawLabel, f.role);
    }
    else if (!u.col) delete u.unit.ignored;
    else if (u.col !== 'med') u.col.off = false;
    return !!touch(tpl);
  }
  /**
   * Erase a field or table from the template (it may be offered again as "not in the template").
   * Values that took their time from it fall back to the capture time. Returns how many did.
   */
  function deleteUnit(tpl, id) {
    const users = [...tpl.fields, ...tpl.tables].filter((x) => x.id !== id && x.time && x.time.mode === 'field' && x.time.field === id);
    for (const x of users) x.time = { mode: 'capture' };
    tpl.fields = tpl.fields.filter((f) => f.id !== id);
    tpl.tables = tpl.tables.filter((t) => t.id !== id);
    touch(tpl);
    return users.length;
  }
  /** How many fields and tables take their time from this one. */
  const timeUsers = (tpl, id) => [...tpl.fields, ...tpl.tables].filter((x) => x.id !== id && x.time && x.time.mode === 'field' && x.time.field === id).length;
  function setTime(tpl, id, link) {
    const u = unitOf(tpl, id) || { unit: tpl.tables.find((t) => t.id === id) };
    if (!u || !u.unit) return false;
    u.unit.time = link;
    return !!touch(tpl);
  }
  /** Add a field (taught, from the "not in template" list, from AI or the sample page). Same element → replaced. */
  function addField(tpl, f, { label, from } = {}) {
    const nf = { ...f, id: f.id || newId('f'), group: f.group || 'p', from: from || f.from || 'taught' };
    if (label) { nf.label = label; nf.unmapped = false; if (label !== f.label) nf.how = 'taught'; }
    nf.role = roleFor(nf.label, nf.rawLabel, nf.role);
    if (!nf.rawLabel) nf.rawLabel = nf.anchor || nf.label;
    tpl.fields = tpl.fields.filter((x) => !(x.selector === nf.selector && JSON.stringify(x.part || null) === JSON.stringify(nf.part || null)));
    if (!nf.time) nf.time = defaultTime(tpl, nf);
    tpl.fields.push(nf);
    touch(tpl);
    return nf;
  }
  function addTable(tpl, t) {
    const nt = { ...t, id: t.id || newId('t'), from: t.from || 'rule' };
    if (!nt.time) nt.time = nt.map.time;
    tpl.tables = tpl.tables.filter((x) => x.selector !== nt.selector);
    tpl.tables.push(nt);
    touch(tpl);
    return nt;
  }
  /** Other fields of a template reading the same label (labels that hold several values, like Medication, excepted). */
  const sameLabel = (tpl, label, f) => (C().isMulti(label) ? [] : tpl.fields.filter((x) => x.label === label && x.selector !== f.selector));
  /**
   * A clicked element (Teach / pick in the sample page) → a field. target: { el, group? }
   * values: what the page's fields read now (from the last scan); they are left out of its context and label text.
   */
  function fieldFor(target, values) {
    const { el, group } = target;
    const kind = group ? 'group' : D().isPicture(el) ? 'image' : isCtl(el) ? 'control' : 'text';
    const value = group ? D().groupValue(group) : kind === 'image' ? '' : kind === 'control' ? D().readControl(el) : D().textOf(el);
    const others = (values || []).concat(group || kind === 'image' ? [] : [value]);
    const anchor = group ? group.label || T().anchorFor(el) : T().anchorOk(T().anchorFor(el), others);
    return {
      kind, selector: T().selectorFor(el), anchor, rawLabel: anchor || '', context: T().contextFor(el, others), tag: el.tagName,
      value: String(value || '').slice(0, 200), framePath: T().pagePath(el.ownerDocument.location ? el.ownerDocument.location.pathname : ''),
      options: group ? group.opts.map(D().optionLabelText).filter(Boolean).slice(0, 30) : undefined,
    };
  }
  /** Find a unit's element on a document (the live page or the sample page). */
  function locateUnit(doc, tpl, unit) {
    if (unit.kind === 'table') return findTable(doc, unit);
    const tagged = doc.querySelector(`[data-pdb-f="${unit.id}"]`);
    if (tagged) return tagged;
    const p = T().place(doc, unit, 'extract', false, {});
    return p.el ? (p.group ? p.group.container : p.el) : null;
  }

  // ── the saved sample page ────────────────────────────────────────────
  const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";
  /**
   * A masked copy of the page for showing the template: same element structure (so selectors still find the
   * fields), no scripts, no network, no patient data. Mapped values become [Label]; table cells [column];
   * form boxes are emptied and tick boxes unticked; identifiers found anywhere else become [Name], [National ID] …
   * The layout is kept: every stylesheet stays in its place (as a <style> with its rules, so the cascade is the same),
   * rules added by scripts are kept, pictures keep their size (as grey boxes). Stylesheets this page may not read
   * (another site's) are left as placeholders listed in out.external = [{ i, href }], for the side panel to fetch.
   * res: extract() output for this template (where each field was found, and the identity values to mask).
   */
  function snapshot(doc, tpl, res, out = {}) {
    const root = doc.documentElement;
    const pathOf = (el) => { const p = []; for (let n = el; n && n !== root; n = n.parentNode) { if (!n.parentNode) return null; p.unshift(Array.prototype.indexOf.call(n.parentNode.childNodes, n)); } return p; };
    // known identifiers on this page (and their other spellings) are masked wherever they appear
    const known = [];
    for (const r of res.records) for (const it of r.items) if (it.entry && (it.entry.sensitive || it.entry.identity)) known.push({ label: it.label, value: it.value }, { label: it.label, value: it.raw });
    const targets = [];
    for (const [id, l] of res.located) {
      const unit = tpl.fields.find((f) => f.id === id) || tpl.tables.find((t) => t.id === id);
      if (unit) targets.push({ unit, path: pathOf(l.box), live: l.box });
    }
    // stylesheets as the page has them (undefined: not a stylesheet; null: rules not readable here)
    const sheetNodes = Array.from(root.querySelectorAll('style, link'));
    const sheetCss = sheetNodes.map((n) => {
      if (n.tagName === 'LINK' && !/(^|\s)stylesheet(\s|$)/i.test(n.getAttribute('rel') || '')) return undefined;
      try { return n.sheet ? rulesText(n.sheet.cssRules) : n.tagName === 'STYLE' ? n.textContent : null; } catch (e) { return null; }
    });
    const liveImgs = Array.from(root.querySelectorAll('img')).map((img) => { const r = img.getBoundingClientRect(); return { opt: D().isImgOption(img), w: r.width, h: r.height }; });
    const clone = root.cloneNode(true);
    const cloneSheets = Array.from(clone.querySelectorAll('style, link'));
    const at = (path) => path && path.reduce((n, i) => (n ? n.childNodes[i] : null), clone);
    // resolve everything in the copy before anything is changed (rows are removed below)
    const cloneImgs = Array.from(clone.querySelectorAll('img'));
    for (const t of targets) t.el = at(t.path);
    const cd = clone.ownerDocument;
    const textNodes = (el) => { const out = []; const w = cd.createTreeWalker(el, 4); for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n); return out; };
    const setText = (el, text) => {
      const nodes = textNodes(el).filter((n) => n.nodeValue.trim() && !(n.parentElement && n.parentElement.closest('select,option,script,style')));
      nodes.forEach((n, i) => { n.nodeValue = i === 0 ? text : ''; });
      if (!nodes.length && !el.children.length) el.textContent = text;
    };
    // 1. mapped elements: tag them, and replace their values with the label
    const labelsAt = new Map();
    for (const t of targets) {
      const el = t.el;
      if (!el || el.nodeType !== 1) continue;
      if (t.unit.kind === 'table') { el.setAttribute('data-pdb-t', t.unit.id); maskTable(el, t.unit, t.live); continue; }
      el.setAttribute('data-pdb-f', [el.getAttribute('data-pdb-f'), t.unit.id].filter(Boolean).join(' '));
      if (t.unit.kind === 'group' || t.unit.kind === 'image') continue; // option labels are page text (ticks cleared below); pictures become grey boxes below
      const name = t.unit.role === 'recordDate' || t.unit.role === 'time' ? 'time' : fieldName(t.unit);
      if (!labelsAt.has(el)) labelsAt.set(el, []);
      labelsAt.get(el).push(name);
    }
    for (const [el, names] of labelsAt) {
      const text = `[${[...new Set(names)].join(' / ')}]`;
      if (isCtl(el)) { if (el.tagName === 'TEXTAREA') el.textContent = text; else if (el.tagName === 'INPUT') el.setAttribute('value', text); }
      else setText(el, text);
    }
    // the copy is not rendered, so header texts are read from the live table (same rows, same order)
    function maskTable(el, t, live) {
      const rows = Array.from(el.rows || []), liveRows = Array.from(live.rows || []);
      if (t.map.layout === 'chart') {
        const names = new Map(t.map.rows.map((r) => [r.header, (r.spec && r.spec.label) || r.header]));
        rows.forEach((tr, ri) => {
          const lc = liveRows[ri] && liveRows[ri].cells[0];
          const head = lc ? cellText(lc) : '';
          Array.from(tr.cells).slice(1).forEach((td) => setText(td, names.has(head) ? `[${names.get(head)}]` : C().clean(td.textContent) ? '[time]' : ''));
        });
        return;
      }
      const heads = t.map.columns.map((c) => c.header);
      let hr = liveRows.findIndex((tr) => Array.from(tr.cells).filter((td) => heads.includes(cellText(td))).length >= heads.filter(Boolean).length / 2);
      if (hr < 0) hr = 0;
      let kept = 0;
      rows.slice(hr + 1).forEach((tr) => {
        if (kept >= 3) { tr.remove(); return; } // a few rows are enough to show the columns
        kept++;
        Array.from(tr.cells).forEach((td, i) => {
          const c = t.map.columns.find((x) => x.i === i);
          const name = !c || c.off ? '' : c.kind === 'time' ? 'time' : (c.spec && c.spec.label) || c.header;
          setText(td, name ? `[${name}]` : C().clean(td.textContent) ? '[…]' : '');
        });
      });
    }
    // 2. scripts, frames, links and attributes: nothing runs, nothing loads, no hidden data
    for (const s of clone.querySelectorAll('script')) { s.textContent = ''; s.removeAttribute('src'); s.setAttribute('type', 'text/plain'); }
    for (const s of clone.querySelectorAll('noscript,template')) s.textContent = '';
    for (const f of clone.querySelectorAll('iframe,frame')) {
      let p = '';
      try { p = T().pagePath(new URL(f.getAttribute('src') || '', doc.baseURI || 'http://x/').pathname); } catch (e) { p = ''; }
      f.setAttribute('src', 'about:blank'); f.setAttribute('data-pdb-frame', p);
    }
    const external = [];
    cloneSheets.forEach((n, i) => {
      const css = sheetCss[i];
      if (css === undefined) { n.removeAttribute('href'); return; }
      if (n.tagName === 'STYLE') { n.textContent = cleanCss(css || ''); return; }
      // a linked stylesheet → its rules, in the same place
      const st = cd.createElement('style');
      if (n.getAttribute('media')) st.setAttribute('media', n.getAttribute('media'));
      if (css != null) st.textContent = cleanCss(css);
      else if (sheetNodes[i].href) { st.setAttribute('data-pdb-ext', String(external.length)); external.push({ i: external.length, href: sheetNodes[i].href }); }
      n.removeAttribute('href');
      n.after(st);
    });
    out.external = external;
    for (const b of clone.querySelectorAll('base')) b.removeAttribute('href');
    cloneImgs.forEach((img, i) => {
      const L = liveImgs[i] || {};
      img.removeAttribute('srcset');
      if (L.w > 0 && L.h > 0) img.setAttribute('style', `${img.getAttribute('style') || ''};width:${Math.round(L.w)}px;height:${Math.round(L.h)}px`);
      img.setAttribute('src', L.opt ? IMG_BOX : IMG_GREY); // same size, no picture (a tick-box picture: an empty box)
    });
    for (const t of clone.querySelectorAll('svg text')) t.textContent = ''; // numbers of a drawn chart
    const scrub = (v) => maskText(String(v), known);
    for (const el of clone.querySelectorAll('*')) {
      for (const a of Array.from(el.attributes)) {
        const n = a.name.toLowerCase();
        // data-* attributes can carry styling ([data-role=…]): short plain ones stay, anything that could be data goes
        const dataOk = n.startsWith('data-pdb-') || (a.value.length <= 30 && !/[\u3400-\u9fff]/.test(a.value) && scrub(a.value) === a.value);
        if (n.startsWith('on') || (n.startsWith('data-') && !dataOk) || n === 'title' || n === 'alt' || n === 'action' || n === 'srcset' || n === 'background') el.removeAttribute(a.name);
        else if (n === 'href' && !/^#/.test(a.value)) el.setAttribute('href', '#');
        else if (n === 'style' && /url\(/i.test(a.value)) el.setAttribute('style', cleanCss(a.value));
        else if ((n === 'id' || n === 'name' || n === 'class' || n === 'for') && scrub(a.value) !== a.value) el.setAttribute(a.name, scrub(a.value));
        // record keys built from a national ID ("MD" + ID + number) in any attribute
        if (el.hasAttribute(a.name) && ID_INSIDE.test(el.getAttribute(a.name))) el.setAttribute(a.name, el.getAttribute(a.name).replace(ID_INSIDE_G, 'X000000000'));
      }
    }
    // 3. form boxes: no values (mapped ones show their label), nothing ticked or chosen
    for (const c of clone.querySelectorAll('input,textarea,select,option')) {
      const mapped = labelsAt.has(c);
      if (c.tagName === 'OPTION') { c.removeAttribute('selected'); c.removeAttribute('value'); continue; } // its text shows; its value is a code
      if (c.tagName === 'SELECT') continue;
      if (c.tagName === 'TEXTAREA') { if (!mapped) c.textContent = ''; continue; }
      if (/^(checkbox|radio)$/i.test(c.type || c.getAttribute('type') || '')) { c.removeAttribute('checked'); c.removeAttribute('value'); continue; }
      if (!mapped && !/^(button|submit|reset|image)$/i.test(c.getAttribute('type') || '')) c.setAttribute('value', '');
    }
    // 4. identifiers anywhere else in the text
    for (const n of textNodes(clone)) {
      if (n.parentElement && /^(STYLE|SCRIPT)$/.test(n.parentElement.tagName)) continue; // CSS is not page text
      const v = n.nodeValue;
      if (v.trim()) { const m = maskText(v, known); if (m !== v) n.nodeValue = m; }
    }
    // 5. network blocked
    const head = clone.querySelector('head') || clone.insertBefore(cd.createElement('head'), clone.firstChild);
    const meta = cd.createElement('meta');
    meta.setAttribute('http-equiv', 'Content-Security-Policy'); meta.setAttribute('content', CSP);
    head.insertBefore(meta, head.firstChild);
    return '<!DOCTYPE html>\n' + clone.outerHTML;
  }
  /** A stylesheet's rules as text (rules of readable @imports included in place). */
  function rulesText(rules) {
    return Array.from(rules).map((r) => {
      if (r.type === 3) { try { return rulesText(r.styleSheet.cssRules); } catch (e) { return ''; } } // @import
      return r.cssText;
    }).join('\n');
  }
  /** CSS for the sample page: nothing is loaded from the network (pictures and fonts in it are left out; data: ones stay). */
  const cleanCss = (css) => String(css).replace(/@import[^;]*;/g, '').replace(/url\(\s*(['"]?)(?!data:)[^)]*\)/gi, 'none');
  const ID_INSIDE = /[A-Z][12ABCD89]\d{8}/, ID_INSIDE_G = /[A-Z][12ABCD89]\d{8}/g;
  const svgURI = (svg) => 'data:image/svg+xml,' + encodeURIComponent(svg);
  const IMG_GREY = svgURI('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#e4e6ea"/></svg>');
  // still recognised as a tick-box picture (by its name), unticked
  const IMG_BOX = svgURI('<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13"><rect x=".5" y=".5" width="12" height="12" fill="#fff" stroke="#767676"/></svg>') + '#/checkbox_off.gif';
  const CAT_NAME = { name: 'Name', id: 'National ID', mrn: 'MRN', phone: 'Phone', email: 'Email', address: 'Address', dob: 'Birth date', number: 'number', term: 'term' };
  /** Replace identifiers in a text with [Name], [National ID] … (everything the privacy gate would flag). */
  function maskText(text, known) {
    if (!PDB.redact) return text;
    const { text: t, spans } = PDB.redact.detect(text, known, {});
    if (!spans.length) return text;
    let out = '', pos = 0;
    for (const s of spans.sort((a, b) => a.start - b.start)) {
      if (s.start < pos) continue;
      out += t.slice(pos, s.start) + `[${CAT_NAME[s.cat] || s.cat}]`;
      pos = s.end;
    }
    return out + t.slice(pos);
  }

  PDB.pagetpl = { IGNORE, newId, draft, extract, uncovered, match, addressScore, rememberAddress, snapshot, maskText, cleanCss, unitOf, timeText, timeColumns, fieldName, defaultTime,
    setLabel, removeUnit, restoreUnit, deleteUnit, timeUsers, setTime, addField, sameLabel, addTable, fieldFor, imageItems, locateUnit, findTable, isPersistent, readField };
})(globalThis);
