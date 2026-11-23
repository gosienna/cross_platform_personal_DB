/*
 * Core logic (no DOM): label matching, value/time parsing, table analysis,
 * record → 5-field rows, dedup, identity matching.
 *
 * Unified row: { patientId, label, value, time, source }   (+ page, history: stored locally, never in CSV/FHIR)
 *   page = normalised path of the page the value was read from (record-number segments → *)
 *   Values from different pages are different data points (page is part of the row key), except for
 *   "common" labels (Name, National ID, …): one value per (patientId, label, time, source).
 *   time = "nan"            persistent label
 *        | "YYYYMMDD"       date only (local calendar date, no timezone shift)
 *        | "YYYYMMDDHHmm"   UTC date-time
 */
(function (g) {
  const PDB = (g.PDB = g.PDB || {});
  const S = () => PDB.schema;

  // ── text helpers ─────────────────────────────────────────────────────
  const nfkc = (s) => String(s == null ? '' : s).normalize('NFKC');
  const clean = (s) => nfkc(s).replace(/[​ ]/g, ' ').replace(/[ \t]+/g, ' ').trim();
  const isCJK = (s) => /[㐀-鿿]/.test(s);
  /** Display form of an unmapped page label: no markers, numbering or trailing colon. */
  /** Leading item numbers: "(1)" "（一）" "2." "2、" "四、" "(3)." */
  const NUMBERING = /^\s*(?:[(（]\s*(?:\d{1,2}(?:-\d{1,2})?|[一二三四五六七八九十]{1,3})\s*[)）]|(?:\d{1,2}|[一二三四五六七八九十]{1,3})\s*[.、．)）](?!\d))\s*[.、．]?\s*/;
  const stripNumbering = (s) => { for (let i = 0; i < 2; i++) s = s.replace(NUMBERING, ''); return s; };
  const cleanLabel = (raw) => stripNumbering(clean(raw).replace(/\s*※.*$/, '').replace(/^[*＊\s]+/, '')).replace(/[:：\s]+$/, '').trim();

  /** Normalise a page label: NFKC, lower-case, strip markers, colons, bracketed unit. */
  function normLabel(raw) {
    let s = clean(raw).toLowerCase().replace(/\s*※.*$/, '');
    let unit = null;
    s = s.replace(/^[*＊\s]+/, '').replace(/[*＊]+$/, '');
    s = stripNumbering(s);
    s = s.replace(/[:：]+\s*$/, '').trim();
    const m = s.match(/^(.*?)\s*[(\[]([^)\]]{1,10})[)\]]\s*$/);
    if (m && m[1]) { unit = m[2].trim(); s = m[1].trim(); }
    s = s.replace(/^[*＊\s]+/, '').replace(/[:：]+$/, '').replace(/\s+/g, ' ').trim();
    return { norm: s, unit };
  }

  // Lazily built lookup tables.
  let _idx = null;
  function index() {
    if (_idx && _idx.v === S()) return _idx;
    const exact = new Map();
    for (const e of S().VOCAB) {
      for (const syn of [e.label, ...e.synonyms]) {
        const n = normLabel(syn).norm;
        if (!exact.has(n)) exact.set(n, e);
      }
    }
    const set = (arr) => new Set(arr.map((x) => normLabel(x).norm));
    const parts = new Map();
    for (const [part, syns] of Object.entries(S().MED_PARTS)) for (const s of syns) {
      const n = normLabel(s).norm; if (!parts.has(n)) parts.set(n, part);
    }
    _idx = { v: S(), exact, parts, generic: set(S().GENERIC_VALUE), time: set(S().TIME),
      recordDate: set(S().RECORD_DATE), ignore: set(S().IGNORE) };
    return _idx;
  }

  const PREFIXES = ['個案', '病人', '病患', '患者', '住民', '案主', 'patient '];
  const SUFFIXES = ['測量', '紀錄', '記錄', '數值', '值', '資料', '號碼', '字號', '記錄值'];

  /**
   * Map a page label to a vocabulary entry.
   * ctx.vocab = { aliases: { normLabel: { label, sites?: [origin] } } }, ctx.origin
   * Returns { entry, label, how } — entry null when the label is a learned alias to a
   * non-vocabulary label — or null when unmapped.
   */
  function resolveLabel(raw, ctx = {}) {
    const { norm } = normLabel(raw);
    if (!norm) return null;
    const ix = index();
    const aliases = (ctx.vocab && ctx.vocab.aliases) || {};
    const a = aliases[norm];
    if (a) {
      const pinned = a.sites && a.sites.length;
      if (!pinned || a.sites.includes(ctx.origin)) {
        if (a.label === '__ignore__') return { ignore: true, how: 'alias' };
        return { entry: S().byLabel[a.label] || null, label: a.label, how: pinned ? 'site-alias' : 'alias' };
      }
    }
    if (ix.exact.has(norm)) { const e = ix.exact.get(norm); return { entry: e, label: e.label, how: 'synonym' }; }
    // cautious partial match: only known prefixes/suffixes around a synonym
    for (const p of ['', ...PREFIXES]) {
      if (p && !norm.startsWith(p)) continue;
      const rest = norm.slice(p.length).trim();
      for (const sfx of ['', ...SUFFIXES]) {
        if (!p && !sfx) continue;
        if (sfx && !rest.endsWith(sfx)) continue;
        const core = rest.slice(0, rest.length - sfx.length).trim();
        if (core.length >= 2 && ix.exact.has(core)) { const e = ix.exact.get(core); return { entry: e, label: e.label, how: 'partial' }; }
      }
    }
    return null;
  }

  const labelKind = (raw) => {
    const n = normLabel(raw).norm, ix = index();
    if (ix.ignore.has(n)) return 'ignore';
    if (ix.time.has(n)) return 'time';
    if (ix.recordDate.has(n)) return 'recordDate';
    if (ix.generic.has(n)) return 'generic';
    return null;
  };
  const medPart = (raw) => index().parts.get(normLabel(raw).norm) || null;

  /** Find the vital sign named in free text (e.g. a page heading "生理數值測量 體溫測量"). Last mention wins. */
  function vitalFromText(text) {
    const t = clean(text).toLowerCase();
    let best = null;
    for (const e of S().VOCAB) {
      if (!e.vital) continue;
      for (const syn of e.synonyms) {
        if (syn.length < 2 || (!isCJK(syn) && syn.length < 4)) continue;
        const i = t.lastIndexOf(syn.toLowerCase());
        if (i >= 0 && (!best || i > best.i || (i === best.i && syn.length > best.len))) best = { e, i, len: syn.length };
      }
    }
    return best ? best.e : null;
  }

  // ── dates & times ────────────────────────────────────────────────────
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const validDate = (y, m, d) => y > 1880 && y < 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
  const fixYear = (ys) => { const y = +ys; return ys.length <= 3 ? y + 1911 : y; }; // 2–3 digit = ROC

  /**
   * Parse a date/time string.
   * Returns { kind: 'datetime'|'date', y, m, d, H, M } | { kind: 'relative' } | null
   */
  function parseDateTime(raw, opts = {}) {
    const s = clean(raw);
    if (!s) return null;
    if (/(\d+)\s*(秒|分鐘|分|小時|天|日|週|周|個月|月|年)前|\b(\d+)\s*(min|minute|hour|day|week|month|year)s?\s+ago\b|剛剛|昨天|今天|just now|yesterday/i.test(s)) {
      return { kind: 'relative' };
    }
    let y, m, d, rest = s, mm;
    if ((mm = s.match(/(?:^|[^\d])(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?!\d)/))) {
      y = +mm[3]; m = +mm[1]; d = +mm[2]; if (m > 12) [m, d] = [d, m]; rest = s.slice(mm.index + mm[0].length);
    } else if ((mm = s.match(/(\d{2,4})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})\s*日?/))) {
      y = fixYear(mm[1]); m = +mm[2]; d = +mm[3]; rest = s.slice(mm.index + mm[0].length);
    } else if ((mm = s.match(/(?:^|[^\d])(\d{7}|\d{8})(?!\d)/))) {
      const t = mm[1]; y = fixYear(t.slice(0, t.length - 4)); m = +t.slice(-4, -2); d = +t.slice(-2);
      rest = s.slice(mm.index + mm[0].length);
    } else if (opts.refYear && (mm = s.match(/(?:^|\s)(\d{1,2})[\/\-](\d{1,2})(?=\s|$)/))) {
      y = opts.refYear; m = +mm[1]; d = +mm[2]; rest = s.slice(mm.index + mm[0].length);
    }
    let H = null, M = null;
    const t = rest.match(/(\d{1,2})\s*[:：時]\s*(\d{2})/) || (y != null && rest.match(/(?:^|\s)([01]\d|2[0-3])([0-5]\d)(?:\s|$)/));
    if (t) { H = +t[1]; M = +t[2]; if (/(下午|pm)/i.test(rest) && H < 12) H += 12; }
    if (y == null) {
      if (H != null && opts.refDate) { ({ y, m, d } = opts.refDate); } else return null;
    }
    if (!validDate(y, m, d)) return null;
    if (H != null && (H > 23 || M > 59)) H = M = null;
    return H == null ? { kind: 'date', y, m, d } : { kind: 'datetime', y, m, d, H, M };
  }

  /** Format a parsed date/time into the stored `time` string. */
  function formatTime(p) {
    if (!p) return null;
    if (p.kind === 'date') return `${p.y}${pad(p.m)}${pad(p.d)}`;
    if (p.kind === 'datetime') {
      const dt = new Date(p.y, p.m - 1, p.d, p.H, p.M); // local wall time → UTC
      return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}`;
    }
    return null;
  }
  const isoDate = (p) => (p ? `${p.y}-${pad(p.m)}-${pad(p.d)}` : null);
  function utcStamp(date = new Date()) {
    return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`;
  }
  /** Stored time → readable local string (for UI). */
  function displayTime(t) {
    if (!t || t === 'nan') return '—';
    if (t.length === 8) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
    const dt = new Date(Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(8, 10), +t.slice(10, 12)));
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  }
  /** Stored time → JS Date (date-only = local midnight). */
  function timeToDate(t) {
    if (!t || t === 'nan') return null;
    if (t.length === 8) return new Date(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8));
    return new Date(Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(8, 10), +t.slice(10, 12)));
  }

  // ── value normalisation ──────────────────────────────────────────────
  const num = (s) => { const m = nfkc(s).match(/-?\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null; };
  const fmtNum = (x) => String(Math.round(x * 10) / 10);
  /** Placeholder or punctuation-only values ("民 年 月 日", ", ,", "--") count as empty. */
  const isEmptyValue = (t) => !t || /^[\s,，;；、|/\-—–.。:：()（）_*]*$/.test(t) || /^(null|undefined|nan|請選擇|--請選擇--)$/i.test(t) || /^民?\s*(國)?\s*年\s*月\s*日$/.test(t.replace(/[\s;/]/g, ''));
  const joinLines = (s) => clean(String(s).split(/\n+/).map((x) => x.trim()).filter(Boolean).join('; '));

  /**
   * Normalise a raw value for a vocabulary entry.
   * Returns { value, label?, warn? } or null (nothing usable).
   */
  function normalizeValue(entry, raw, ctx = {}) {
    const text = joinLines(raw);
    if (isEmptyValue(text)) return null;
    if (!entry) return { value: text };
    switch (entry.type) {
      case 'text': return { value: /address/i.test(entry.key) ? clean(String(raw).split(/\n+/).map((x) => x.trim()).join('')) : text };
      case 'id': {
        const v = text.split(/[;\s]/)[0].toUpperCase();
        const warn = entry.key === 'nationalId' && !/^[A-Z][0-9A-D]\d{8}$/.test(v) ? 'unusual_id' : undefined;
        return { value: v, warn };
      }
      case 'sex': {
        if (/女|female|^f$|小姐|女士/i.test(text)) return { value: 'female' };
        if (/男|male|^m$|先生/i.test(text)) return { value: 'male' };
        if (/其他|other/i.test(text)) return { value: 'other' };
        return { value: 'unknown', warn: 'unparsed' };
      }
      case 'date': {
        const p = parseDateTime(text);
        if (!p || p.kind === 'relative') return { value: text, warn: 'unparsed_date' };
        return { value: isoDate(p) };
      }
      case 'bp': {
        const m = nfkc(text).match(/(\d{2,3})\s*[\/／]\s*(\d{2,3})/);
        if (!m) return null;
        const sys = +m[1], dia = +m[2];
        const warn = sys < 50 || sys > 300 || dia < 20 || dia > 200 || dia >= sys ? 'out_of_range' : undefined;
        return { value: `${sys}/${dia}`, warn };
      }
      case 'glucose': {
        const v = num(text);
        if (v == null) return null;
        const q = nfkc(text).match(/\b(AC|PC|HS)\b|飯前|飯後|睡前|空腹/i);
        const map = { 飯前: 'AC', 空腹: 'AC', 飯後: 'PC', 睡前: 'HS' };
        const tag = q ? (map[q[0]] || q[0].toUpperCase()) : null;
        const warn = v < entry.range[0] || v > entry.range[1] ? 'out_of_range' : undefined;
        return { value: fmtNum(v), label: tag ? `${entry.label} (${tag})` : entry.label, warn };
      }
      case 'number': {
        let v = num(text);
        if (v == null) return null;
        const unit = (ctx.unit || text).toLowerCase();
        let warn;
        if (entry.key === 'temperature' && (/°?f\b|℉/.test(unit) || v > 50)) { v = ((v - 32) * 5) / 9; warn = 'converted_from_F'; }
        if (entry.key === 'weight' && /\blbs?\b|磅/.test(unit)) { v *= 0.45359237; warn = 'converted_from_lb'; }
        if (entry.key === 'height' && (/\bm\b|公尺/.test(unit) || v < 3)) { v *= 100; warn = 'converted_from_m'; }
        if (entry.range && (v < entry.range[0] || v > entry.range[1])) warn = 'out_of_range';
        return { value: fmtNum(v), warn };
      }
      default: return { value: text };
    }
  }

  // ── medication ───────────────────────────────────────────────────────
  const FREQ = /\b(QD|QOD|BID|TID|QID|HS|PRN|STAT|ST|QN|QW|BIW|TIW|Q\d{1,2}H|AC|PC|QAM|QPM|QHS)\b/i;
  const ROUTE = /口服|外用|注射|皮下|肌肉|靜脈|舌下|吸入|點眼|眼用|鼻用|塞劑|貼片|\b(PO|IV|IM|SC|SL|TOP|INH|PR)\b/i;

  /** Build one Medication value from parts collected in a table row. */
  function buildMedication(parts) {
    const p = {};
    for (const [k, v] of Object.entries(parts)) { const t = joinLines(v); if (t) p[k] = t; }
    if (!p.drug) return null;
    const lines = String(parts.drug).split('\n').map((x) => clean(x)).filter(Boolean);
    let drug = lines[0] || p.drug;
    if (p.strength && !/\d/.test(drug)) drug = `${drug} ${p.strength}${p.strengthUnit ? ' ' + p.strengthUnit : ''}`;
    const all = Object.values(p).join(' ; ');
    const freq = (p.freq && p.freq.match(FREQ)?.[0]) || all.match(FREQ)?.[0];
    const route = (p.route && p.route.match(ROUTE)?.[0]) || all.match(ROUTE)?.[0];
    const days = (p.days && num(p.days)) || num(all.match(/[(（]?\s*(\d+)\s*天\s*[)）]?/)?.[0] || '');
    let dose = p.dose ? p.dose.replace(/;/g, ' ').trim() : null;
    if (dose && p.doseUnit && !/[^\d.\s]/.test(dose)) dose = `${dose} ${p.doseUnit}`;
    const start = p.start ? parseDateTime(p.start.split(';')[0]) : null;
    const end = p.end ? parseDateTime(p.end) : null;
    const hospital = p.hospital ? p.hospital.split(';')[0].trim() : null;
    const doctor = p.doctor ? p.doctor.split(';')[0].trim() : null;
    const span = start ? `${isoDate(start)}~${end && end.kind !== 'relative' ? isoDate(end) : ''}` : null;
    const fields = {
      drug, dose, freq: freq && freq.toUpperCase(), route: route && route.toUpperCase?.() === route ? route : route,
      days: days ? `${days}天` : null, span, place: [hospital, p.dept].filter(Boolean).join(' ') || null, doctor,
    };
    return { fields, start, drugKey: drug.toLowerCase().replace(/[^a-z㐀-鿿]/g, '').slice(0, 24) };
  }
  const MED_ORDER = ['drug', 'dose', 'freq', 'route', 'days', 'span', 'place', 'doctor'];
  const medValue = (f) => MED_ORDER.map((k) => f[k]).filter(Boolean).join('; ');
  function mergeMed(a, b) {
    const f = { ...a.fields };
    for (const k of MED_ORDER) if (!f[k] && b.fields[k]) f[k] = b.fields[k];
    const start = a.start && a.start.kind === 'datetime' ? a.start : b.start && b.start.kind === 'datetime' ? b.start : a.start || b.start;
    return { ...a, fields: f, start };
  }

  // ── records ──────────────────────────────────────────────────────────
  /*
   * An extraction produces records. One record = one patient on the page:
   *   { hints: { nationalId, name, mrn, bed, birthDate }, items: [Item], meds: [Med] }
   * Item = { label, value, time, rawLabel, raw, warn?, entry?, ref? }
   *   time: 'nan' | 'YYYYMMDD' | 'YYYYMMDDHHmm' | null (→ record date or capture time later)
   */
  const newRecord = () => ({ hints: {}, items: [], meds: [], skipped: [], recordDate: null });

  /**
   * How a page label is read: { skip } (UI noise / a time header), a record date, or { label, how, unmapped }.
   * A page template stores this per field, so the label can be changed without the page changing.
   */
  function specFor(rawLabel, ctx = {}) {
    const kind = labelKind(rawLabel);
    if (kind === 'ignore' || kind === 'time') return { skip: true, rawLabel };
    if (kind === 'recordDate') return { recordDate: true, label: cleanLabel(rawLabel), rawLabel };
    const r = resolveLabel(rawLabel, ctx);
    if (r && r.ignore) return { skip: true, rawLabel };
    return { label: r ? r.label : null, rawLabel, how: r ? r.how : null, unmapped: !r };
  }
  const GLUCOSE_TAG = /\s*\((AC|PC|HS)\)$/;
  const entryOf = (label) => (label ? S().byLabel[label] || S().byLabel[label.replace(GLUCOSE_TAG, '')] || null : null);

  /** Turn one (label, value) pair into record items. */
  function addPair(rec, rawLabel, rawValue, ctx, ref, timeOverride) {
    const spec = specFor(rawLabel, ctx);
    if (!spec.skip) addMapped(rec, spec, rawValue, ctx, ref, timeOverride);
  }

  /**
   * One value with a known label → record items.
   * spec: { label, rawLabel, recordDate?, how?, unmapped?, strict?, fid? }
   *   strict: from a page template. The label is the user's choice, so the "is this really a label?" guesses are
   *           skipped, and a record date does not become the fallback time (each field has its own time link).
   * timeOverride: 'nan' | 'YYYYMMDD[HHmm]' | null (no time) | undefined (capture time; relative-time readings skipped)
   */
  function addMapped(rec, spec, rawValue, ctx = {}, ref = null, timeOverride) {
    const value = joinLines(rawValue);
    if (isEmptyValue(value)) return;
    const rawLabel = spec.rawLabel || spec.label || '';
    const extra = spec.fid ? { fid: spec.fid } : {};
    if (spec.recordDate) {
      const p = parseDateTime(value);
      const own = p && p.kind !== 'relative' ? formatTime(p) : null;
      if (own && !spec.strict) rec.recordDate = own;
      rec.items.push({ label: spec.label || cleanLabel(rawLabel), value: p ? isoDate(p) : value, time: spec.strict && timeOverride !== undefined ? timeOverride : own, rawLabel, raw: value, ref, how: spec.how || null, ...extra });
      return;
    }
    const { unit } = normLabel(rawLabel);
    const e = entryOf(spec.label);
    if (e) {
      if (e.type === 'medication') { const m = buildMedication({ drug: rawValue }); if (m) rec.meds.push({ ...m, ref, ...extra }); return; }
      const n = normalizeValue(e, rawValue, { unit });
      if (!n) return;
      if (e.vital && timeOverride === undefined && !e.persistent) {
        // a vital value with a relative time beside it (e.g. "53 min 4小時前") is skipped
        if (/\d+\s*(分鐘|小時|天|週|個月|年)前|ago/i.test(rawValue)) { rec.skipped.push({ label: e.label, raw: value, reason: 'relative time' }); return; }
      }
      if (e.identity && !rec.hints[e.identity]) rec.hints[e.identity] = n.value;
      // a glucose tag read from the value wins; otherwise the chosen label (which may carry its own tag)
      const label = n.label && n.label !== e.label ? n.label : spec.label || e.label;
      rec.items.push({ label, value: n.value, time: e.persistent ? 'nan' : timeOverride ?? null,
        rawLabel, raw: value, warn: n.warn, entry: e, how: spec.how, ref, ...extra });
      return;
    }
    const label = spec.label || cleanLabel(rawLabel);
    if (!label) return;
    if (!spec.strict) {
      if (label.length > 40 || /^[\d\s:：.\-/]+$/.test(label)) return;
      if (spec.unmapped && value.length === 1 && !/[\da-z㐀-鿿]/i.test(value)) return;
    }
    let v = value;
    if (/^\d{2,4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}$/.test(value)) { const p = parseDateTime(value); if (p) v = isoDate(p); } // a bare date → ISO
    rec.items.push({ label, value: v, time: timeOverride ?? null, rawLabel, raw: value, unmapped: !!spec.unmapped, how: spec.how || null, ref, ...extra });
  }

  /** Pair a label cell with a value cell, splitting stacked lines ("姓名 | 身分證號" over "王 | A123"). */
  function addStacked(rec, labelLines, valueLines, ctx, ref) {
    labelLines = labelLines.filter((l) => !/^\s*※/.test(l));
    if (!labelLines.length) return;
    if (labelLines.length > 1 && labelLines.length === valueLines.length) {
      labelLines.forEach((l, i) => addPair(rec, l, valueLines[i], ctx, ref));
    } else if (labelLines.length > 1 && valueLines.length === 1 && /\s/.test(valueLines[0])) {
      const parts = valueLines[0].split(/\s+/);
      if (parts.length === labelLines.length) labelLines.forEach((l, i) => addPair(rec, l, parts[i], ctx, ref));
      else addPair(rec, labelLines.join(' '), valueLines.join('\n'), ctx, ref);
    } else if (labelLines.length > 1 && valueLines.length >= 1 && valueLines.length < labelLines.length && labelLines.every((l) => isLabelish(l, ctx))) {
      valueLines.forEach((v, i) => addPair(rec, labelLines[i], v, ctx, ref));
    } else {
      addPair(rec, labelLines.join(' '), valueLines.join('\n'), ctx, ref);
    }
  }

  const isLabelish = (text, ctx) => {
    const t = clean(text);
    if (!t || t.length > 24) return false;
    if (/[:：]$/.test(t)) return true;
    return !!(resolveLabel(t, ctx) || labelKind(t) || medPart(t));
  };

  /**
   * Analyse one table.
   * grid: rows of cells { text, lines: [..], th: bool, ref }
   * ctx: { vocab, origin, heading (text before the table), refDate }
   * Returns { kind: 'list'|'chart'|'kv'|'none', records: [record] }
   */
  const HEADER_WORDS = /^(選擇|勾選|項目|頻率|內容|說明|備註|操作|動作|功能|日期|時間|名稱|數量|編號|序號|狀態|類別|單位|結果|no\.?|item|content|note|action)$/i;
  function analyzeTable(grid, ctx = {}) {
    const rows = grid.filter((r) => r.some((c) => clean(c.text)));
    if (!rows.length) return { kind: 'none', records: [] };
    const list = tryList(rows, ctx);
    if (list) return list;
    const chart = tryChart(rows, ctx);
    if (chart) return chart;
    // key/value table
    const rec = newRecord();
    for (const row of rows) {
      // a column-header row of a form table ("選擇 | 項目 | 頻率 | 內容") is not label/value pairs
      const filled = row.filter((c) => clean(c.text));
      if (filled.length >= 3 && filled.every((c) => HEADER_WORDS.test(cleanLabel(c.text)))) continue;
      for (let i = 0; i < row.length - 1; i++) {
        const c = row[i], v = row[i + 1];
        if (c.ref && v.ref && c.ref === v.ref) continue; // colspan duplicate
        const ltxt = c.lines.join(' ');
        if ((c.th || isLabelish(ltxt, ctx) || c.lines.every((l) => isLabelish(l, ctx))) && clean(v.text) && !v.th && !isLabelish(v.text, ctx) && !/^[*＊]/.test(clean(v.text))) {
          addStacked(rec, c.lines, v.lines, ctx, v.ref);
          i++;
        }
      }
    }
    return { kind: rec.items.length || rec.meds.length ? 'kv' : 'none', records: [rec] };
  }

  /**
   * Header row + data rows; each data row is a reading or a patient.
   * Returns { kind: 'list', records, map }; map says how each column was read (a page template keeps it).
   */
  function tryList(rows, ctx) {
    if (rows.length < 2) return null;
    for (let h = 0; h < Math.min(2, rows.length - 1); h++) {
      const map = listMap(rows, h, ctx);
      if (!map) continue;
      const records = applyList(rows, map, ctx);
      if (records.length) return { kind: 'list', records, map };
    }
    return null;
  }

  /** If row h is the header of a list: how each column is read. Otherwise null. */
  function listMap(rows, h, ctx = {}) {
    const header = rows[h];
    const cols = header.map((c) => {
      const t = c.lines.join(' ');
      const kind = labelKind(t);
      const r = kind ? null : resolveLabel(t, ctx);
      const part = medPart(t);
      return { text: t, kind, r, part: part || (c.lines.length > 1 ? medPart(c.lines[0]) : null), lines: c.lines };
    });
    const mapped = cols.filter((c) => c.kind === 'time' || c.kind === 'generic' || c.part || (c.r && c.r.entry)).length;
    const filled = cols.filter((c) => clean(c.text));
    const labelish = filled.filter((c) => isLabelish(c.text, ctx) || (c.lines.length > 1 && c.lines.every((l) => isLabelish(l, ctx)))).length;
    const dataRows = rows.slice(h + 1);
    // a list has ≥2 mapped headers, a header row made of labels, and data rows that are not label/value pairs
    const allTh = header.every((c) => !clean(c.text) || c.th);
    if (mapped < 2 || labelish / Math.max(1, filled.length) < (allTh ? 0.5 : 0.7)) return null;
    const kvRows = dataRows.filter((r) => r.length >= 2 && isLabelish(r[0].text, ctx) && !isLabelish(r[1].text, ctx)).length;
    if (kvRows > dataRows.length / 2) return null;
    const genericVital = cols.some((c) => c.kind === 'generic') ? vitalFromText(ctx.heading || '') : null;
    return {
      layout: 'list', headerRow: h, hasMed: cols.some((c) => c.part === 'drug'),
      columns: cols.map((c, i) => ({
        i, header: c.text, kind: c.kind || null, part: c.part || null,
        ident: !!(c.r && c.r.entry && c.r.entry.identity), vocab: !!(c.r && c.r.entry),
        spec: c.kind === 'time' || c.kind === 'ignore' ? { skip: true, rawLabel: c.text } : specFor(c.kind === 'generic' && genericVital ? genericVital.label : c.text, ctx),
        sub: c.kind !== 'generic' && c.lines.length > 1 ? c.lines.map((l) => specFor(l, ctx)) : null,
      })),
      time: { mode: 'column', cols: cols.map((c, i) => (c.kind === 'time' ? i : -1)).filter((i) => i >= 0) },
    };
  }

  /**
   * Read the data rows of a list with a column map.
   * opts: { strict, fid (table id: items get fid "<fid>:<column>"), time (a TimeLink overriding map.time), fixedTime }
   */
  function applyList(rows, map, ctx = {}, opts = {}) {
    const { strict = false, fid = null } = opts;
    const link = opts.time || map.time || { mode: 'column', cols: [] };
    const timeCols = link.mode === 'column' ? link.cols || [] : [];
    const sp = (s, key) => ({ ...s, strict, fid: fid ? `${fid}:${key}` : undefined });
    const records = [];
    for (const row of rows.slice(map.headerRow + 1)) {
      if (row.every((c) => !clean(c.text))) continue;
      const rec = newRecord();
      let time = null;
      if (link.mode === 'nan') time = 'nan';
      else if (link.mode === 'field') time = opts.fixedTime ?? null;
      else if (timeCols.length) {
        const p = parseDateTime(timeCols.map((i) => row[i]?.text || '').join(' '), { refYear: ctx.refYear, refDate: ctx.refDate });
        if (p && p.kind === 'relative') continue; // a reading with only a relative time ("4小時前")
        time = p ? formatTime(p) : null;
      }
      const med = {};
      for (const c of map.columns) {
        const cell = row[c.i];
        if (!cell || !clean(cell.text) || c.kind === 'time' || c.kind === 'ignore' || c.off) continue;
        if (map.hasMed && c.part && !c.ident) { med[c.part] = (med[c.part] ? med[c.part] + '\n' : '') + cell.lines.join('\n'); continue; }
        if (c.spec.skip) continue;
        if (c.kind === 'generic') { addMapped(rec, sp(c.spec, c.i), cell.lines.join('\n'), ctx, cell.ref, time); continue; }
        if (map.hasMed && !c.ident && !c.vocab && !c.taught) continue; // extra columns of a medication table
        if (c.ident) { addMapped(rec, sp(c.spec, c.i), cell.lines.join('\n'), ctx, cell.ref); continue; }
        if (c.sub && c.sub.length === cell.lines.length) {
          c.sub.forEach((s, k) => { if (!s.skip) addMapped(rec, sp(s, `${c.i}.${k}`), cell.lines[k], ctx, cell.ref, time); });
        } else addMapped(rec, sp(c.spec, c.i), cell.lines.join('\n'), ctx, cell.ref, time);
      }
      if (map.hasMed) { const m = buildMedication(med); if (m) rec.meds.push({ ...m, ref: row[0]?.ref, ...(fid ? { fid: `${fid}:med` } : {}) }); }
      if (rec.items.length || rec.meds.length) records.push(rec);
    }
    return records;
  }

  /** Vital-sign chart with vitals as rows and times as columns. */
  function tryChart(rows, ctx) {
    const map = chartMap(rows, ctx);
    if (!map) return null;
    const rec = applyChart(rows, map, ctx);
    return rec.items.length ? { kind: 'chart', records: [rec], map } : null;
  }
  function chartMap(rows, ctx = {}) {
    const vitalRows = rows.map((r, i) => ({ i, r: resolveLabel(r[0].text, ctx) })).filter((x) => x.r && x.r.entry && x.r.entry.vital);
    if (vitalRows.length < 2) return null;
    return { layout: 'chart', first: vitalRows[0].i, rows: vitalRows.map(({ i }) => ({ i, header: rows[i][0].text, spec: specFor(rows[i][0].text, ctx) })), time: { mode: 'column' } };
  }
  /** Read a chart with a row map. opts as for applyList. */
  function applyChart(rows, map, ctx = {}, opts = {}) {
    const { strict = false, fid = null } = opts;
    const link = opts.time || map.time || { mode: 'column' };
    const width = Math.max(...rows.map((r) => r.length));
    const rec = newRecord();
    for (let j = 1; j < width; j++) {
      let time;
      if (link.mode === 'column') {
        const head = rows.slice(0, map.first).map((r) => r[j]?.text || '').join(' ')
          + ' ' + rows.filter((r) => labelKind(r[0].text) === 'time').map((r) => r[j]?.text || '').join(' ');
        const p = parseDateTime(head, { refYear: ctx.refYear, refDate: ctx.refDate });
        if (!p || p.kind === 'relative') continue;
        time = formatTime(p);
      } else time = link.mode === 'nan' ? 'nan' : link.mode === 'field' ? opts.fixedTime ?? null : null;
      for (const vr of map.rows) {
        if (vr.spec.skip || vr.off) continue;
        const cell = rows[vr.i] && rows[vr.i][j];
        if (cell && clean(cell.text)) addMapped(rec, { ...vr.spec, strict, fid: fid ? `${fid}:${vr.i}` : undefined }, cell.lines.join('\n'), ctx, cell.ref, time);
      }
    }
    return rec;
  }

  /** Pairs found outside tables (forms, divs, dl, "label：value" text) → items of the page record. */
  function recordFromPairs(pairs, ctx) {
    const rec = newRecord();
    for (const p of pairs) {
      if (p.labelLines && p.valueLines) addStacked(rec, p.labelLines, p.valueLines, ctx, p.ref);
      else addPair(rec, p.label, p.value, ctx, p.ref);
    }
    return rec;
  }

  // ── merging records of one capture ───────────────────────────────────
  const hintKey = (h) => h.nationalId || (h.mrn ? `mrn:${h.mrn}` : null) || (h.name ? `name:${h.name}${h.bed ? '@' + h.bed : ''}` : null);

  /**
   * Merge records from all tables/frames of one capture.
   * - The page-level record (no identity of its own) is merged into the single patient if there is one.
   * - Records naming the same person are merged; a name seen with a national ID links name-only records.
   * - Duplicate medications (same drug + start date) are merged.
   */
  function mergeRecords(records) {
    const recs = records.filter((r) => r.items.length || r.meds.length || r.skipped.length);
    // name → national ID links
    const nameToId = {};
    for (const r of recs) if (r.hints.name && r.hints.nationalId) nameToId[r.hints.name] = r.hints.nationalId;
    for (const r of recs) if (r.hints.name && !r.hints.nationalId && nameToId[r.hints.name]) r.hints.nationalId = nameToId[r.hints.name];
    const groups = new Map();
    const anon = [];
    for (const r of recs) {
      const k = hintKey(r.hints);
      if (!k) { anon.push(r); continue; }
      // a name-only key may match a record keyed by national ID with the same name
      let key = k;
      if (!r.hints.nationalId) for (const [gk, gr] of groups) if (gr.hints.name && gr.hints.name === r.hints.name && (!r.hints.bed || !gr.hints.bed || gr.hints.bed === r.hints.bed)) { key = gk; break; }
      if (!groups.has(key)) groups.set(key, newRecord());
      const t = groups.get(key);
      Object.assign(t.hints, Object.fromEntries(Object.entries(r.hints).filter(([k2, v]) => v && !t.hints[k2])));
      t.items.push(...r.items); t.meds.push(...r.meds); t.skipped.push(...r.skipped);
      t.recordDate = t.recordDate || r.recordDate;
    }
    let out = [...groups.values()];
    const strong = out.filter((r) => r.hints.nationalId || r.hints.name);
    if (strong.length === 1 && out.length > 1) {
      const t = strong[0];
      for (const r of out) if (r !== t) {
        for (const [k2, v] of Object.entries(r.hints)) if (v && !t.hints[k2]) t.hints[k2] = v;
        t.items.push(...r.items); t.meds.push(...r.meds); t.skipped.push(...r.skipped); t.recordDate = t.recordDate || r.recordDate;
      }
      out = [t];
    }
    if (anon.length) {
      if (out.length === 1) { for (const a of anon) { out[0].items.push(...a.items); out[0].meds.push(...a.meds); out[0].skipped.push(...a.skipped); out[0].recordDate = out[0].recordDate || a.recordDate; } }
      else if (!out.length) { const t = newRecord(); for (const a of anon) { t.items.push(...a.items); t.meds.push(...a.meds); t.skipped.push(...a.skipped); t.recordDate = t.recordDate || a.recordDate; Object.assign(t.hints, a.hints); } out = [t]; }
      else { const t = newRecord(); for (const a of anon) { t.items.push(...a.items); t.meds.push(...a.meds); t.skipped.push(...a.skipped); } t.unassigned = true; out.push(t); }
    }
    for (const r of out) {
      const meds = new Map();
      for (const m of r.meds) {
        const k = `${m.drugKey}|${m.start ? isoDate(m.start) : ''}`;
        meds.set(k, meds.has(k) ? mergeMed(meds.get(k), m) : m);
      }
      r.meds = [...meds.values()];
    }
    return out;
  }

  /**
   * Record → 5-field rows (without patientId yet).
   * Items without a time get the record date or the capture time.
   */
  function recordToRows(rec, { source, captureTime }) {
    const rows = [];
    const fallback = rec.recordDate || captureTime;
    const seen = new Map();
    const slot = new Map(); // label|time → first value (one value per key unless the label is multi)
    for (const it of rec.items) {
      const time = it.time || fallback;
      const k = `${it.label}|${time}|${it.value}`;
      // the same value read twice (e.g. by two template fields): one row, which knows every field it stands for
      if (seen.has(k)) { const r0 = seen.get(k); if (it.fid && it.fid !== r0._item.fid) (r0._fids = r0._fids || [r0._item.fid]).push(it.fid); continue; }
      const row = { label: it.label, value: it.value, time, source, page: it.page || '', _item: it };
      seen.set(k, row);
      const sk = `${it.label}|${time}`;
      if (!isMulti(it.label)) { if (slot.has(sk)) row._conflictWith = slot.get(sk); else slot.set(sk, it.value); }
      rows.push(row);
    }
    // separate systolic / diastolic readings at the same time → one "Blood pressure" row (e.g. "144/100")
    const sys = rows.filter((r) => r.label === 'Systolic BP'), dia = rows.filter((r) => r.label === 'Diastolic BP');
    for (const s of sys) {
      const d = dia.find((x) => x.time === s.time);
      if (!d) continue;
      rows.splice(rows.indexOf(s), 1, { label: 'Blood pressure', value: `${s.value}/${d.value}`, time: s.time, source, page: s.page, _item: { ...s._item, label: 'Blood pressure' } });
      rows.splice(rows.indexOf(d), 1);
    }
    for (const m of rec.meds) {
      rows.push({ label: 'Medication', value: medValue(m.fields), time: m.start ? formatTime(m.start) : fallback, source, page: m.page || (rec.items[0] && rec.items[0].page) || '', _item: { label: 'Medication', rawLabel: 'Medication', ref: m.ref, region: m.region, entry: S().byKey.medication, fid: m.fid, fp: m.fp } });
    }
    return rows;
  }

  // ── storage keys, dedup, identity ────────────────────────────────────
  const isMulti = (label) => !!(S().byLabel[label] && S().byLabel[label].multi);
  /** Normalised page path: record-number segments become * (no record numbers stored, one template per form). */
  /**
   * A path part that is a record ID: 4 or more digits in a row (as before), a UUID ("627b1aea-f265-4d5d-93d8-09ebba15fbda",
   * which may have no 4 digits in a row), a long hex string, or a long letters-and-digits token ("a8F3kq92LmZ01x").
   */
  const isIdSegment = (seg) => {
    let s = seg;
    try { s = decodeURIComponent(seg); } catch (e) { /* keep as is */ }
    return /\d{4,}/.test(s)
      || /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(s)
      || /^[0-9a-f]{16,}$/i.test(s)
      || (s.length >= 12 && /^[A-Za-z0-9_-]+$/.test(s) && /[A-Za-z]/.test(s) && (s.match(/\d/g) || []).length >= 3);
  };
  const pagePath = (p) => String(p || '').split('/').map((seg, i) => (i > 0 && seg && isIdSegment(seg) ? '*' : seg)).join('/');
  /**
   * The part of an address's query that picks the page (?func=profile&tab=2), without record IDs and cache-busters.
   * Pages on one path told apart by it get their own templates.
   */
  function queryKey(search) {
    const out = [];
    for (const [k, v] of new URLSearchParams(String(search || '').replace(/^\?/, ''))) {
      if (!v || v.length > 40 || isIdSegment(v) || /^\d+$/.test(v) || /^(_|t|ts|time|timestamp|rnd|rand|random|nocache|cache|v|ver|token|sid|session)$/i.test(k)) continue;
      out.push(`${k}=${v}`);
    }
    return [...new Set(out)].sort().join('&');
  }

  // Common labels: do not change with time or between pages of one system → one value per (patient, label, source).
  const defaultCommonLabels = () => S().VOCAB.filter((e) => e.persistent).map((e) => e.label);
  let _common = null; // user list, or null = defaults
  let _commonSet = null, _commonFor = null;
  function setCommonLabels(list) { _common = Array.isArray(list) ? [...list] : null; _commonSet = null; }
  const commonLabels = () => (_common ? [..._common] : defaultCommonLabels());
  function isCommon(label) {
    if (!_commonSet || _commonFor !== S()) { _commonSet = new Set(commonLabels()); _commonFor = S(); }
    return _commonSet.has(label);
  }
  /**
   * Storage key. A row with no page (saved before pages were recorded, or imported from a file) keeps the key it had:
   * the page part is only added when there is a page.
   */
  const rowKey = (r) => [r.patientId, r.label, r.time, r.source]
    .concat(isMulti(r.label) ? [r.value] : [])
    .concat(!isCommon(r.label) && r.page ? ['@' + r.page] : [])
    .join('␟');

  /** Lookup key for "some page already stored this exact value" (rows from files carry no page). */
  const sameValueKey = (r) => rowKey(r) + '␟=' + r.value;

  /** Values a stored row had before → kept when it is replaced. Oldest first, no repeats, at most HISTORY_MAX. */
  const HISTORY_MAX = 20;
  function withHistory(old, incoming, replacedAt = utcStamp(new Date())) {
    const h = [...((old && old.history) || []), ...((incoming && incoming.history) || [])];
    if (old && incoming && old.value !== incoming.value) h.push({ value: old.value, page: old.page || '', replacedAt });
    const seen = new Set(), out = [];
    for (const e of h) {
      const k = `${e.value}␟${e.page || ''}␟${e.replacedAt || ''}`;
      if (seen.has(k)) continue;
      seen.add(k); out.push({ value: String(e.value ?? ''), page: e.page || '', replacedAt: e.replacedAt || '' });
    }
    return out.slice(-HISTORY_MAX);
  }

  /** Compare new rows to existing rows → status 'new' | 'duplicate' | 'changed' (with the old value and its page). */
  function diffRows(newRows, existingByKey) {
    return newRows.map((r) => {
      if (existingByKey.has(sameValueKey(r))) return { ...r, status: 'duplicate' };
      const old = existingByKey.get(rowKey(r));
      if (!old) return { ...r, status: 'new' };
      if (old.value === r.value) return { ...r, status: 'duplicate' };
      return { ...r, status: 'changed', oldValue: old.value, oldPage: old.page || '' };
    });
  }

  /**
   * Find the patient for a record's hints.
   * existing: all stored rows (or a prebuilt index from buildIdentityIndex).
   * Returns { patientId|null, auto: bool, reason, suggestions: [{patientId, name, reason}] }
   */
  function buildIdentityIndex(rows) {
    const ix = { ids: new Set(), mrn: new Map(), names: new Map(), birth: new Map(), bed: new Map() };
    for (const r of rows) {
      ix.ids.add(r.patientId);
      if (r.label === 'MRN') ix.mrn.set(`${r.value}|${r.source}`, r.patientId);
      if (r.label === 'Name') { if (!ix.names.has(r.value)) ix.names.set(r.value, new Set()); ix.names.get(r.value).add(r.patientId); }
      if (r.label === 'Birth date') ix.birth.set(r.patientId, r.value);
      if (r.label === 'Bed') ix.bed.set(`${r.value}|${r.source}|${r.patientId}`, r.patientId);
    }
    return ix;
  }
  function resolveIdentity(hints, source, ix) {
    if (hints.nationalId) return { patientId: hints.nationalId, auto: true, reason: 'national ID', suggestions: [] };
    if (hints.mrn && ix.mrn.has(`${hints.mrn}|${source}`)) return { patientId: ix.mrn.get(`${hints.mrn}|${source}`), auto: true, reason: 'MRN at this site', suggestions: [] };
    const suggestions = [];
    if (hints.name && ix.names.has(hints.name)) {
      for (const pid of ix.names.get(hints.name)) {
        const b = ix.birth.get(pid);
        let reason = 'same name';
        if (hints.birthDate && b) { if (b !== hints.birthDate) continue; reason = 'same name + birth date'; }
        else if (hints.bed && [...ix.bed.keys()].some((k) => k.startsWith(`${hints.bed}|${source}|${pid}`))) reason = 'same name + bed at this site';
        suggestions.push({ patientId: pid, name: hints.name, reason });
      }
    }
    suggestions.sort((a, b) => (b.reason.length - a.reason.length));
    return { patientId: null, auto: false, reason: suggestions.length ? 'suggested' : 'unknown', suggestions };
  }

  // ── CSV ──────────────────────────────────────────────────────────────
  const FIELDS = ['patientId', 'label', 'value', 'time', 'source'];
  const csvCell = (s) => { s = String(s ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const toCSV = (rows) => [FIELDS.join(','), ...rows.map((r) => FIELDS.map((f) => csvCell(r[f])).join(','))].join('\r\n') + '\r\n';
  function parseCSV(text, delim) {
    text = String(text).replace(/^﻿/, '');
    if (!delim) delim = (text.split('\n')[0].match(/\t/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
    const out = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
      if (ch === '"') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); out.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell.replace(/\r$/, '')); out.push(row); }
    return out.filter((r) => r.some((c) => c.trim()));
  }
  /** Rows of strings → grid of cells for analyzeTable. */
  const gridFromArrays = (arr) => arr.map((r) => r.map((t) => ({ text: String(t ?? ''), lines: String(t ?? '').split(/\n/).map((x) => clean(x)).filter(Boolean), th: false })));

  PDB.core = {
    nfkc, clean, cleanLabel, normLabel, resolveLabel, labelKind, medPart, vitalFromText,
    parseDateTime, formatTime, isoDate, utcStamp, displayTime, timeToDate,
    normalizeValue, buildMedication, medValue,
    newRecord, specFor, addPair, addMapped, addStacked, analyzeTable, listMap, applyList, chartMap, applyChart,
    recordFromPairs, mergeRecords, recordToRows, isEmptyValue, joinLines,
    rowKey, isMulti, diffRows, buildIdentityIndex, resolveIdentity,
    pagePath, queryKey, isIdSegment, sameValueKey, defaultCommonLabels, setCommonLabels, commonLabels, isCommon, withHistory, HISTORY_MAX,
    FIELDS, toCSV, parseCSV, gridFromArrays,
    _resetIndex: () => { _idx = null; },
  };
})(globalThis);
