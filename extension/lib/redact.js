/*
 * Privacy gate for AI extract. Nothing reaches the network without passing through here.
 *   1. mask()       – replace sensitive text with placeholders ([NAME_1], [ID_1] …)
 *                     using known values (label-based + stored), patterns and your custom terms
 *   2. the review dialog lets you keep/mask each span (amber = uncertain, needs a decision)
 *   3. finalCheck() – hard block if a high-confidence identifier is still in the outgoing text
 *   4. reidentify() – placeholders in the AI reply are mapped back locally
 */
(function (g) {
  const PDB = (g.PDB = g.PDB || {});
  const nfkc = (s) => String(s || '').normalize('NFKC');

  const CAT = { name: 'NAME', id: 'ID', mrn: 'MRN', phone: 'PHONE', email: 'EMAIL', address: 'ADDR', dob: 'DOB', number: 'NUM', term: 'TERM', blocked: 'BLOCKED' };
  const LABEL_CAT = { 'Name': 'name', 'Nickname': 'name', 'National ID': 'id', 'MRN': 'mrn', 'Phone': 'phone', 'Mobile': 'phone', 'Email': 'email', 'Address': 'address', 'Registered address': 'address', 'Birth date': 'dob' };
  const CAT_LABEL = { name: 'Name', id: 'National ID', mrn: 'MRN', phone: 'Phone', email: 'Email', address: 'Address', dob: 'Birth date', number: 'Long number', term: 'Custom term', blocked: 'Blocked by you' };

  const PATTERNS = [
    { cat: 'id', conf: 'high', re: /(?<![A-Za-z0-9])[A-Z][12ABCD89]\d{8}(?![0-9])/g },
    { cat: 'email', conf: 'high', re: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
    { cat: 'phone', conf: 'high', re: /(?:\+886[-\s]?|(?<!\d))0?9\d{2}[-\s]?\d{3}[-\s]?\d{3}(?!\d)/g },
    { cat: 'phone', conf: 'high', re: /(?:\+886[-\s]?\(?\d\)?|\(0\d{1,2}\)|(?<!\d)0\d{1,2})[-\s]?\d{3,4}[-\s]?\d{4}(?:\s*(?:#|ext\.?|分機)\s*\d{1,5})?(?!\d)/g },
    { cat: 'address', conf: 'high', re: /[一-鿿]{1,3}[市縣][一-鿿]{1,4}[區鄉鎮市][^\s,，。;；|]{0,30}?(?:路|街|大道)[^\s,，。;；|]{0,20}?號(?:之\d+)?(?:\d+樓(?:之\d+)?)?/g },
    { cat: 'address', conf: 'amber', re: /\d{1,5}\s+[A-Z][a-z]+(?:\s[A-Z][a-z]+)*\s(?:St|Street|Rd|Road|Ave|Avenue|Blvd|Lane|Ln|Dr|Drive)\b\.?/g },
    { cat: 'name', conf: 'amber', group: 2, re: /(病人|患者|個案|住民|案主|姓名|病患|家屬|聯絡人)[:：\s]*([一-鿿]{2,4})(?![一-鿿])/g },
    { cat: 'name', conf: 'amber', group: 1, re: /([一-鿿]{2,3})(先生|小姐|女士|太太|阿嬤|阿公)/g },
    { cat: 'number', conf: 'amber', re: /(?<![\d/.:-])\d{7,}(?![\d/.:-])/g },
  ];

  /** Words that are labels, not names ("個案姓名", "病人編號"). */
  const isLabelWord = (w) => /姓名|身分|身份|性別|生日|出生|電話|地址|編號|類別|狀態|資料|紀錄|記錄|日期|時間|號碼/.test(w) || !!(PDB.core && (PDB.core.resolveLabel(w) || PDB.core.labelKind(w)));

  /** Variants of a known value as it may appear in text (spacing, case, phone digits, date formats). */
  function variants(value, cat) {
    const v = nfkc(value).trim();
    if (!v || v.length < 2) return [];
    const out = new Set([v]);
    if (cat === 'id' || cat === 'mrn') { out.add(v.toUpperCase()); out.add(v.toLowerCase()); }
    if (cat === 'phone') { const d = v.replace(/\D/g, ''); if (d.length >= 7) { out.add(d); out.add(d.replace(/^(\d{2})(\d{4})(\d+)$/, '$1-$2-$3')); out.add(d.replace(/^(\d{4})(\d{3})(\d{3})$/, '$1-$2-$3')); } }
    if (cat === 'name' && v.length >= 2) out.add(v.split('').join(' '));
    if (cat === 'dob') {
      const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m) {
        const [y, mo, d] = [+m[1], m[2], m[3]];
        const roc = String(y - 1911);
        for (const s of [`${y}/${mo}/${d}`, `${y}-${mo}-${d}`, `${y}.${mo}.${d}`, `${y}${mo}${d}`, `${roc}/${mo}/${d}`, `${roc.padStart(3, '0')}/${mo}/${d}`, `${roc}${mo}${d}`, `${y}/${+mo}/${+d}`, `${roc}/${+mo}/${+d}`, `${y}年${+mo}月${+d}日`]) out.add(s);
      }
    }
    return [...out].filter((x) => x.length >= 2);
  }
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');

  /**
   * Find sensitive spans.
   * known: [{ value, label }]  (values found next to sensitive labels on the page + stored values of this patient)
   * opts.categories: { label: 'mask'|'ask'|'send' }, opts.customTerms: [string]
   * Returns spans sorted by start: { start, end, text, cat, conf: 'high'|'amber', source, decision: 'mask'|'send'|null }
   */
  function detect(text, known = [], opts = {}) {
    const t = nfkc(text);
    const spans = [];
    const policyOf = (cat) => (opts.categories || {})[CAT_LABEL[cat]] || (opts.categories || {})[LABEL_CAT_INV[cat]] || 'mask';
    const add = (start, end, cat, conf, source) => {
      if (end <= start) return;
      if (spans.some((s) => start < s.end && end > s.start && (s.conf === 'high' || conf !== 'high'))) {
        // overlapping: keep the wider/higher-confidence one
        for (const s of spans) if (start < s.end && end > s.start && conf === 'high' && s.conf !== 'high') { s.start = Math.min(s.start, start); s.end = Math.max(s.end, end); s.conf = 'high'; s.cat = cat; s.source = source; }
        return;
      }
      spans.push({ start, end, cat, conf, source });
    };
    // known values (high confidence: they sat next to a sensitive label or are stored for this patient)
    for (const k of known) {
      const cat = LABEL_CAT[k.label] || k.cat;
      if (!cat) continue;
      for (const v of variants(k.value, cat).sort((a, b) => b.length - a.length)) {
        const re = new RegExp(escRe(v), cat === 'id' || cat === 'mrn' ? 'gi' : 'g');
        let m; while ((m = re.exec(t))) add(m.index, m.index + m[0].length, cat, 'high', 'known');
      }
    }
    for (const term of opts.customTerms || []) {
      if (!term || term.length < 2) continue;
      const re = new RegExp(escRe(nfkc(term)), 'gi');
      let m; while ((m = re.exec(t))) add(m.index, m.index + m[0].length, 'term', 'high', 'custom');
    }
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(t))) {
        if (p.cat === 'name' && isLabelWord(m[p.group])) continue;
        if (p.group) { const off = m[0].indexOf(m[p.group]); add(m.index + off, m.index + off + m[p.group].length, p.cat, p.conf, 'pattern'); }
        else add(m.index, m.index + m[0].length, p.cat, p.conf, 'pattern');
      }
    }
    spans.sort((a, b) => a.start - b.start);
    for (const s of spans) {
      s.text = t.slice(s.start, s.end);
      const pol = policyOf(s.cat);
      s.decision = s.conf === 'high' ? (pol === 'send' ? 'send' : pol === 'ask' ? null : 'mask') : (pol === 'mask' && s.source !== 'pattern' ? 'mask' : null);
    }
    return { text: t, spans };
  }
  const LABEL_CAT_INV = {};
  for (const [l, c] of Object.entries(LABEL_CAT)) if (!LABEL_CAT_INV[c]) LABEL_CAT_INV[c] = l;

  /** Apply decisions: masked spans become placeholders. Returns { out, map } (map: placeholder → original). */
  function apply(text, spans) {
    const map = {};
    const byValue = new Map();
    const counters = {};
    let out = '', pos = 0;
    for (const s of spans.filter((x) => x.decision === 'mask').sort((a, b) => a.start - b.start)) {
      if (s.start < pos) continue;
      const key = `${s.cat}|${s.text.replace(/\s+/g, '').toLowerCase()}`;
      let token = byValue.get(key);
      if (!token) { counters[s.cat] = (counters[s.cat] || 0) + 1; token = `[${CAT[s.cat]}_${counters[s.cat]}]`; byValue.set(key, token); map[token] = s.text; }
      out += text.slice(pos, s.start) + token;
      pos = s.end;
    }
    return { out: out + text.slice(pos), map };
  }

  /**
   * Last check on the exact outgoing text. High-confidence identifiers that were not explicitly
   * approved ("send") block the request.
   */
  function finalCheck(outgoing, approvedTexts = []) {
    const approved = new Set(approvedTexts.map((x) => nfkc(x).replace(/\s+/g, '')));
    const { spans } = detect(outgoing, [], {});
    const left = spans.filter((s) => s.conf === 'high' && ['id', 'email', 'phone'].includes(s.cat) && !approved.has(s.text.replace(/\s+/g, '')));
    return { ok: left.length === 0, left };
  }

  /** Placeholders in AI output → original values (done locally). */
  function reidentify(value, map) {
    return String(value).replace(/\[(NAME|ID|MRN|PHONE|EMAIL|ADDR|DOB|NUM|TERM)_\d+\]/g, (m) => (map[m] != null ? map[m] : m));
  }

  /**
   * Serialise page text for AI: visible text only, tables as "a | b | c" lines.
   * (Runs in the page; attributes, hidden inputs, scripts, comments and URLs are never included.)
   */
  function pageText(root) {
    const D = PDB.dom;
    const scope = root.nodeType === 9 ? root.body : root;
    const lines = [];
    const walk = (el) => {
      if (!el || el.nodeType !== 1 || D.isHidden(el) || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|svg|IFRAME|HEAD)$/.test(el.tagName) || el.id === D.OVERLAY_ID) return;
      if (el.tagName === 'TABLE') {
        for (const row of D.gridOf(el)) {
          const cells = []; let last = null;
          for (const c of row) { if (c.el === last) continue; last = c.el; cells.push(c.lines.join(' / ')); }
          if (cells.some(Boolean)) lines.push(cells.join(' | '));
        }
        lines.push('');
        return;
      }
      const hasBlockKids = Array.from(el.children).some((c) => /^(DIV|P|TABLE|UL|OL|LI|SECTION|FORM|H\d|DL|TR|FIELDSET|ARTICLE|HEADER|MAIN|NAV)$/.test(c.tagName));
      if (!hasBlockKids) { const t = D.textOf(el); if (t) lines.push(...t.split('\n')); return; }
      for (const c of el.children) walk(c);
    };
    walk(scope);
    const text = lines.join('\n').replace(/https?:\/\/\S+/g, '[URL]').replace(/\n{3,}/g, '\n\n').trim();
    return text.length > 60000 ? text.slice(0, 60000) + '\n[…truncated]' : text;
  }

  PDB.redact = { detect, apply, finalCheck, reidentify, pageText, variants, LABEL_CAT, CAT_LABEL };
})(globalThis);
