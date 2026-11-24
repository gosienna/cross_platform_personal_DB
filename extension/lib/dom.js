/*
 * DOM layer: reads a page (or a part of it) into label/value pairs and table grids,
 * then hands them to PDB.core. Works in the browser and in jsdom (tests).
 */
(function (g) {
  const PDB = (g.PDB = g.PDB || {});
  const C = () => PDB.core;

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg', 'SVG', 'HEAD', 'IFRAME', 'FRAME', 'OBJECT', 'BUTTON']);
  const BLOCK = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'TR', 'TABLE', 'TBODY', 'THEAD', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DT', 'DD', 'DL', 'FORM', 'FIELDSET', 'BLOCKQUOTE', 'PRE', 'NAV', 'ASIDE', 'MAIN', 'TD', 'TH']);
  const OVERLAY_ID = 'pdb-overlay-host';
  const esc = (s) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));
  const TEXT_INPUT = /^(text|tel|number|date|datetime-local|email|search|url|month|time|)$/i;

  // ── element registry (items refer to elements by number so results can be serialised) ──
  function makeRegistry() { const els = []; return { els, id: (el) => { if (!el) return null; let i = els.indexOf(el); if (i < 0) { i = els.length; els.push(el); } return i; } }; }

  function isHidden(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.id === OVERLAY_ID) return true;
    if (el.hidden || (el.tagName === 'INPUT' && /^hidden$/i.test(el.type))) return true;
    if (typeof el.checkVisibility === 'function') { try { if (!el.checkVisibility({ visibilityProperty: true })) return true; } catch (e) { /* ignore */ } }
    const st = el.getAttribute && el.getAttribute('style');
    return !!(st && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(st));
  }

  /** 'on' | 'off' | null — is this label/element a checkbox or radio option, and is it selected? */
  function optionState(el) {
    if (!el || el.nodeType !== 1) return null;
    const doc = el.ownerDocument;
    let input = el.matches('input[type=checkbox],input[type=radio]') ? el : el.querySelector('input[type=checkbox],input[type=radio]');
    if (!input && el.tagName === 'LABEL' && el.htmlFor) {
      const t = doc.getElementById(el.htmlFor);
      if (t && /^(checkbox|radio)$/i.test(t.type)) input = t;
    }
    if (input) return input.checked ? 'on' : 'off';
    const aria = el.getAttribute('aria-checked') || (el.getAttribute('role') && /checkbox|radio/.test(el.getAttribute('role')) ? 'false' : null);
    if (aria) return aria === 'true' ? 'on' : 'off';
    if (el.tagName === 'LABEL') {
      const img = el.querySelector('img');
      if (img) {
        const src = (img.getAttribute('src') || '') + ' ' + (img.getAttribute('alt') || '');
        if (/check|radio|tick|box|option/i.test(src)) return /unchecked|_off\b|uncheck/i.test(src) ? 'off' : /checked|_on\b|selected|tick|_y\b/i.test(src) ? 'on' : 'off';
      }
    }
    return null;
  }

  function controlValue(el) {
    if (el.tagName === 'SELECT') {
      const o = el.options && el.options[el.selectedIndex];
      return o && o.value !== '' ? o.textContent.trim() : '';
    }
    if (el.tagName === 'TEXTAREA') return el.value || '';
    if (el.tagName === 'INPUT' && TEXT_INPUT.test(el.type || '')) return el.value || '';
    return '';
  }
  const isSegment = (el) => el && el.tagName === 'INPUT' && TEXT_INPUT.test(el.type || '') && el.maxLength > 0 && el.maxLength <= 4;
  /** A form box's value as a page scan reads it: split date boxes joined ("115/10/07"), a "please choose" first option is empty. */
  function readControl(c) {
    let value = controlValue(c).trim();
    if (c.tagName === 'SELECT' && c.selectedIndex === 0 && /請選擇|選擇|^-+$/.test(value)) value = '';
    if (isSegment(c)) {
      const seg = [value];
      // the boxes after it in the same parent, as a page scan joins them
      const peers = c.parentNode ? Array.from(c.parentNode.querySelectorAll('input,select,textarea'))
        .filter((x) => x.parentNode === c.parentNode && !isHidden(x) && !/^(checkbox|radio|button|submit|reset|image|file|password|hidden)$/i.test(x.type)) : [];
      for (let k = peers.indexOf(c) + 1; k > 0 && k < peers.length && isSegment(peers[k]); k++) seg.push(controlValue(peers[k]).trim());
      value = seg.filter(Boolean).join('/');
    }
    return value;
  }

  /**
   * Visible text of an element, with line breaks at <br> and block boundaries.
   * Form controls contribute their value; unselected checkbox/radio options are left out.
   */
  function textOf(root, opts = {}) {
    let out = '';
    let lastSeg = null;
    let skipOption = false; // after an unticked tick-box picture without a <label>: its text is not part of the value
    const nl = () => { if (out && !out.endsWith('\n')) out += '\n'; };
    const walk = (node) => {
      if (node.nodeType === 3) {
        if (skipOption && node.nodeValue.trim()) { skipOption = false; return; }
        out += node.nodeValue.replace(/\s+/g, ' '); return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      if (SKIP.has(tag) || isHidden(node)) return;
      if (opts.skipTables && tag === 'TABLE' && node !== root) return;
      if (tag === 'BR') { skipOption = false; nl(); return; }
      if (tag === 'IMG') {
        if (isImgOption(node) && !node.closest('label')) {
          const cell = node.closest('td,th');
          // the picture alone in a cell ("身障證明 | ☑"): ticked → "是", unticked → nothing
          if (cell && optionsIn(cell).length === 1 && !C().clean(cell.textContent)) { if (imgTicked(node)) out += ' 是 '; return; }
          skipOption = !imgTicked(node);
        }
        return;
      }
      if (skipOption && !BLOCK.has(tag) && C().clean(node.textContent) && !optionsIn(node).length) { skipOption = false; return; }
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
        if (/^(checkbox|radio|button|submit|reset|image|file|password|hidden)$/i.test(node.type)) return;
        const v = controlValue(node).trim();
        if (v) {
          if (isSegment(node) && lastSeg && lastSeg.parentNode === node.parentNode) out = out.replace(/\s*$/, '') + '/' + v;
          else out += ' ' + v + ' ';
        }
        lastSeg = isSegment(node) ? node : null;
        return;
      }
      if (node !== root && (tag === 'LABEL' || node.getAttribute('role') === 'checkbox' || node.getAttribute('role') === 'radio')) {
        const st = optionState(node);
        if (st === 'off') return;
      }
      const block = BLOCK.has(tag);
      if (block) nl();
      for (const ch of node.childNodes) walk(ch);
      if (block) nl();
      if (tag === 'TD' || tag === 'TH' || tag === 'SPAN' || tag === 'LABEL') out += ' ';
    };
    walk(root);
    return out.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  }
  const linesOf = (el, opts) => textOf(el, opts).split('\n').filter(Boolean);

  // ── tables ───────────────────────────────────────────────────────────
  function gridOf(table) {
    const grid = [];
    const rows = Array.from(table.rows || []).filter((r) => !isHidden(r));
    rows.forEach((tr, ri) => {
      grid[ri] = grid[ri] || [];
      let ci = 0;
      for (const td of Array.from(tr.cells)) {
        if (isHidden(td)) continue;
        while (grid[ri][ci]) ci++;
        const lines = linesOf(td, { skipTables: true });
        const cell = { text: lines.join(' '), lines, th: td.tagName === 'TH', el: td };
        const cs = Math.min(+td.colSpan || 1, 50), rs = Math.min(+td.rowSpan || 1, 50);
        for (let r = 0; r < rs; r++) for (let c = 0; c < cs; c++) {
          grid[ri + r] = grid[ri + r] || [];
          grid[ri + r][ci + c] = cell;
        }
        ci += cs;
      }
    });
    return grid.map((r) => Array.from(r, (c) => c || { text: '', lines: [], th: false, el: null }));
  }

  /** Text shortly before an element in document order (for "which vital is this list?"). */
  function precedingText(el, max = 400) {
    const doc = el.ownerDocument;
    const body = doc.body || doc.documentElement;
    const w = doc.createTreeWalker(body, 4 /* SHOW_TEXT */);
    let buf = '';
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (el.contains(n)) break;
      if (!(el.compareDocumentPosition(n) & 2 /* PRECEDING */)) break;
      const p = n.parentElement;
      if (!p || SKIP.has(p.tagName) || p.closest('script,style,select,option,noscript,template')) continue;
      const t = n.nodeValue.replace(/\s+/g, ' ');
      if (t.trim()) { buf += t; if (buf.length > max * 3) buf = buf.slice(-max * 2); }
    }
    return buf.slice(-max);
  }

  // ── labels for form controls ─────────────────────────────────────────
  const shortText = (el) => { const t = textOf(el); return t && t.length <= 30 && !t.includes('\n') ? t : null; };
  const hasControl = (el) => !!el.querySelector && !!el.querySelector('input:not([type=hidden]),select,textarea');

  /** Candidate labels for a form control, best first. */
  function labelCandidates(ctl) {
    const doc = ctl.ownerDocument;
    const out = [];
    const push = (t) => { t = t && C().clean(t); if (t && t.length <= 40 && !out.includes(t)) out.push(t); };
    if (ctl.id) { try { const l = doc.querySelector(`label[for="${esc(ctl.id)}"]`); if (l) push(textOf(l)); } catch (e) { /* ignore */ } }
    const lb = ctl.getAttribute('aria-labelledby');
    if (lb) push(lb.split(/\s+/).map((id) => doc.getElementById(id)).filter(Boolean).map((e) => textOf(e)).join(' '));
    push(ctl.getAttribute('aria-label'));
    if (/^(TEXTAREA|INPUT)$/.test(ctl.tagName) && !/^(checkbox|radio)$/i.test(ctl.type || '')) {
      const ob = optionBefore(ctl);
      if (ob && ob.group) {
        const t = C().cleanLabel(ob.text);
        // "☐其他 [___]" → group/其他; a long option ("如有必要…，其他建議：") → group/its last phrase ("其他建議")
        const last = t.split(/[,，、;；]/).map((x) => x.trim()).filter(Boolean).pop() || '';
        const part = t.length <= 6 ? t : last.length <= 8 ? last : '說明';
        const gl = C().cleanLabel(ob.group);
        out.unshift(!part || gl === part || gl.endsWith('/' + part) ? gl : `${gl}/${part}`);
      }
    }
    const wrap = ctl.closest('label');
    if (wrap) push(textOf(wrap).replace(controlValue(ctl), ''));
    // same table row: the cell to the left
    const cell = ctl.closest('td,th');
    if (cell) {
      let p = cell.previousElementSibling;
      while (p && (!shortText(p) || hasControl(p))) p = p.previousElementSibling;
      if (p) push(shortText(p));
    }
    // previous siblings, walking up a few levels (label sits next to the control or its wrapper)
    let node = ctl;
    for (let depth = 0; depth < 5 && node && node !== doc.body; depth++) {
      let sib = node.previousElementSibling, steps = 0;
      while (sib && steps < 4) {
        if (!isHidden(sib) && /^(INPUT|SELECT|TEXTAREA)$/.test(sib.tagName)) {
          if (isSegment(sib)) { sib = sib.previousElementSibling; steps++; continue; }
          depth = 99; break; // another control comes first: its value is not this control's label
        }
        if (!isHidden(sib)) {
          const isLbl = sib.tagName === 'LABEL' || sib.tagName === 'TH' || !hasControl(sib);
          const t = isLbl && shortText(sib);
          if (t) { push(t); depth = 99; break; }
          if (hasControl(sib) && !isSegment(sib) && !sib.querySelector('input[maxlength]')) { depth = 99; break; }
        }
        sib = sib.previousElementSibling; steps++;
      }
      node = node.parentElement;
      if (node && (node.tagName === 'FORM' || node.tagName === 'TR' || node.tagName === 'TABLE')) break;
    }
    const ph = ctl.getAttribute('placeholder');
    if (ph && !/^(null|undefined)$/i.test(ph)) push(ph);
    push(ctl.getAttribute('title'));
    const nm = ctl.getAttribute('formcontrolname') || ctl.getAttribute('name') || (ctl.id && !/^k-[0-9a-f-]{20,}/.test(ctl.id) ? ctl.id : '');
    if (nm && !/^k-[0-9a-f-]{20,}/.test(nm)) push(nm.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' '));
    return out;
  }
  /** Best label for a control: the first candidate the vocabulary knows, else the first readable one. */
  function bestLabel(ctl, ctx) {
    const cands = labelCandidates(ctl);
    for (const c of cands) if (C().resolveLabel(c, ctx) || C().labelKind(c)) return { label: c, known: true, cands };
    const readable = cands.find((c) => /[㐀-鿿]/.test(c) || /\s/.test(c));
    return { label: readable || null, known: false, cands };
  }

  // ── pairs outside tables ─────────────────────────────────────────────
  function collectPairs(root, ctx, reg) {
    const doc = root.ownerDocument || root;
    const pairs = [];
    const used = new Set();
    // elements inside a table the table reader already read are skipped here; other tables (forms laid out with
    // <table>) are read field by field like any other layout
    const handled = ctx._handledTables || null;
    const optCells = ctx._optionCells || null;
    const inOptionCell = (el) => { if (!optCells) return false; for (let c = el.closest('td,th'); c; c = c.parentElement && c.parentElement.closest('td,th')) if (optCells.has(c)) return true; return false; };
    const inTable = (el) => {
      if (inOptionCell(el)) return false;
      if (!handled) return !!el.closest('table');
      for (let t = el.closest('table'); t; t = t.parentElement && t.parentElement.closest('table')) if (handled.has(t)) return true;
      return false;
    };
    // options in a table nested inside a read label/value row ("申請服務種類 | <table>☑…☐…</table>") are read here;
    // the row's own value does not list them
    const inReadTable = (el) => { if (inOptionCell(el)) return false; const t = el.closest('table'); return !!(t && handled ? handled.has(t) : t); };
    const scope = root.nodeType === 9 ? root.body || root.documentElement : root;
    if (!scope) return pairs;

    // 1. text-like controls (segmented ROC dates are joined)
    const ctls = Array.from(scope.querySelectorAll('input,select,textarea'))
      .filter((c) => !isHidden(c) && !inTable(c) && !/^(checkbox|radio|button|submit|reset|image|file|password|hidden)$/i.test(c.type));
    for (let i = 0; i < ctls.length; i++) {
      const c = ctls[i];
      if (used.has(c)) continue;
      const { label } = bestLabel(c, ctx);
      if (!label) continue;
      let value = controlValue(c).trim();
      if (c.tagName === 'SELECT' && c.selectedIndex === 0 && (label.includes(value) || /請選擇|選擇|^-+$/.test(value))) value = '';
      if (isSegment(c)) {
        const seg = [value];
        let j = i + 1;
        while (j < ctls.length && isSegment(ctls[j]) && ctls[j].parentNode === c.parentNode) { seg.push(controlValue(ctls[j]).trim()); used.add(ctls[j]); j++; }
        value = seg.filter(Boolean).join('/');
      }
      used.add(c);
      if (value) pairs.push({ label, value, ref: reg.id(c), src: 'control' });
    }

    // 2. checkbox / radio groups → the selected option labels
    const opts = optionsIn(scope).filter((c) => !inReadTable(c) && !isHidden(c));
    for (const g of optionGroups(opts, ctx)) {
      if (!g.label) continue;
      const value = groupValue(g);
      if (value) pairs.push({ label: g.label, value, ref: reg.id(g.container), src: 'options', opt: reg.id(g.opts[0]) });
    }

    // 3. <dl>
    for (const dl of scope.querySelectorAll('dl')) {
      if (inTable(dl)) continue;
      for (const dt of dl.querySelectorAll(':scope > dt, :scope > div > dt')) {
        const dd = dt.nextElementSibling;
        if (dd && dd.tagName === 'DD') pairs.push({ label: textOf(dt), value: textOf(dd), ref: reg.id(dd), src: 'dl' });
      }
    }

    // 4. label element followed by a value element (div/span layouts), and "label：value" text
    const leaves = Array.from(scope.querySelectorAll('div,span,label,p,li,b,strong,dt,h4,h5,h6,small,em'))
      .filter((el) => !inTable(el) && !isHidden(el) && !el.closest('dl,select,button') && !hasControl(el) && el.id !== OVERLAY_ID && !el.closest('#' + OVERLAY_ID));
    const taken = new Set();
    for (const el of leaves) {
      if (taken.has(el)) continue;
      const kids = Array.from(el.children).filter((k) => !isHidden(k) && !['BR', 'I', 'IMG', 'SPAN', 'B', 'SMALL', 'EM'].includes(k.tagName) || (k.tagName === 'SPAN' && k.children.length));
      if (kids.length) continue; // not a leaf
      const t = textOf(el);
      if (!t || t.length > 60) continue;
      // "姓名：王小明  性別：男"
      const kv = splitInlinePairs(t);
      if (kv.length) { for (const [l, v] of kv) pairs.push({ label: l, value: v, ref: reg.id(el), src: 'text' }); taken.add(el); continue; }
      if (t.length > 24) continue;
      const sibs = el.parentElement ? Array.from(el.parentElement.children) : [];
      if (sibs.length >= 3 && sibs.filter((x) => { const st = textOf(x); return st && st.length <= 12 && (C().resolveLabel(st, ctx) || C().labelKind(st)); }).length >= sibs.length / 2) continue;
      const r = C().resolveLabel(t, ctx);
      const kind = C().labelKind(t);
      if (!(r && (r.entry || r.label) && r.how !== 'partial') && kind !== 'recordDate') continue;
      const valEl = valueElementAfter(el);
      if (!valEl || taken.has(valEl) || hasControl(valEl) || valEl.querySelector('table')) continue;
      const vlines = linesOf(valEl);
      let vt = vlines.join('\n');
      // a vital card may show its (relative) time in the next element: "53 min" + "4小時前"
      if (r && r.entry && r.entry.vital) { const nx = valEl.nextElementSibling; const nt = nx && textOf(nx); if (nt && nt.length <= 20) vt += '\n' + nt; }
      if (!vt || vt.length > 200) continue;
      if (vlines.length === 1 && (C().resolveLabel(vlines[0], ctx)?.entry && !r.entry?.vital)) continue; // next element is another label
      if (r && r.entry && r.entry.vital && !/^[\s<>~≦≧]*\d/.test(vt)) continue; // a heading like "體溫測量", not a reading
      taken.add(valEl);
      pairs.push({ label: t, value: vt, ref: reg.id(valEl), src: 'sibling' });
    }
    return pairs;
  }

  function commonAncestor(els) {
    let a = els[0].parentElement;
    while (a && !els.every((e) => a.contains(e))) a = a.parentElement;
    return a;
  }
  // "罹患感染症: 無" (a read-only page writes the answer next to the label) → "罹患感染症"
  const tidyGroupText = (t) => C().clean(t).replace(/[:：]\s*[^\s:：]{1,6}$/, '').replace(/[(（:：\s]+$/, '').replace(/^[)）\s]+/, '').trim();
  const YES_NO = /^(有|無|是|否|yes|no|其他|other)$/i; // answers, not labels
  const okGroupText = (t) => {
    if (!t || t.length > 40 || YES_NO.test(t)) return false;
    if (/^[(（][^()（）]*[)）]$/.test(t)) return false; // a bracketed note: "(若…請勾選)"
    return !!C().cleanLabel(t); // not just an item number "(1)"
  };
  const isControl = (el) => /^(INPUT|SELECT|TEXTAREA|OPTION|BUTTON)$/.test(el.tagName);
  /** <label for="x"> of a checkbox / radio (the option's text, not a heading). */
  const isOptionLabel = (el) => {
    if (el.tagName !== 'LABEL' || !el.htmlFor) return false;
    const t = el.ownerDocument.getElementById(el.htmlFor);
    return !!(t && /^(checkbox|radio)$/i.test(t.type || ''));
  };
  /** The label cell to the left of the cell holding el ("目前個案就醫科別 | [select] 內科 ☐…"). */
  function rowLabelOf(el) {
    const cell = el.closest && el.closest('td,th');
    if (!cell) return null;
    for (let p = cell.previousElementSibling; p; p = p.previousElementSibling) {
      if (hasControl(p)) continue;
      const t = tidyGroupText(C().clean(p.textContent));
      if (t && t.length <= 40) return t;
    }
    return null;
  }
  /** Loose text directly inside an element (not inside its child elements). */
  const ownText = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(' ').replace(/\s+/g, ' ').trim();
  /**
   * Label for a group of options: the nearest short text before the group — a text element, or loose text
   * in the same cell (e.g. "(1)照顧應注意事項及處置方法<br><div>…options…</div>").
   */
  function groupLabel(container, ctx, firstOpt) {
    // loose text inside the container itself, before the first option ("處置建議(<label>…")
    if (firstOpt) {
      let t = '', el = '';
      for (const n of container.childNodes) {
        if (n.nodeType === 1 && (n.contains(firstOpt) || n === firstOpt)) break;
        if (n.nodeType === 3) t += n.nodeValue;
        // a label element inside the cell before the options ("<label>國籍</label> ☐本國")
        else if (n.nodeType === 1 && n.tagName !== 'BR' && !isControl(n) && !isHidden(n) && !hasControl(n) && !optionsIn(n).length && !isOptionLabel(n)) el = tidyGroupText(C().clean(n.textContent));
      }
      t = tidyGroupText(t);
      if (okGroupText(t) && !(t.length <= 4 && rowLabelOf(container))) return t;
      if (okGroupText(el)) return el;
    }
    let node = container;
    for (let d = 0; d < 4 && node; d++) {
      let sib = node.previousSibling, steps = 0;
      while (sib && steps < 6) {
        if (sib.nodeType === 3) {
          const t = tidyGroupText(sib.nodeValue);
          // in a cell that has its own label on the left, a short word is a value shown as text (a read-only
          // page prints the chosen "穩定" where the edit page has a dropdown), not the group's label
          if (okGroupText(t) && !(t.length <= 4 && rowLabelOf(sib.parentElement))) return t;
        } else if (sib.nodeType === 1 && sib.tagName !== 'BR' && !isControl(sib) && !isHidden(sib)) {
          // a heading element (also a <label> used as a sub-heading, e.g. "內科"), never a control
          const inner = optionsIn(sib);
          if (!sib.querySelector('select,textarea,input:not([type=hidden]):not([type=checkbox]):not([type=radio])')) {
            // a sub-heading may itself be a "whole section" tick box (☐內科 above ☐腫瘤內科 ☐腎臟內科 …)
            const t = inner.length === 1 ? tidyGroupText(optionLabelText(inner[0])) : inner.length ? '' : tidyGroupText(C().clean(sib.textContent));
            if (okGroupText(t)) return t;
          }
          steps++;
        }
        sib = sib.previousSibling;
      }
      node = node.parentElement;
      if (node && /^(TR|TABLE|FORM|BODY)$/.test(node.tagName)) break;
    }
    return textBefore(container);
  }
  /** The nearest heading-like text before an element in reading order (e.g. a heading above a one-row table). */
  function textBefore(el, maxNodes = 6) {
    const doc = el.ownerDocument;
    const w = doc.createTreeWalker(doc.body || doc.documentElement, 4);
    w.currentNode = el;
    for (let n = w.previousNode(), k = 0; n && k < maxNodes; n = w.previousNode()) {
      const p = n.parentElement;
      if (!p || SKIP.has(p.tagName) || p.closest('select,option,script,style') || isHidden(p)) continue;
      const lab = p.closest('label');
      if (lab && (optionsIn(lab).length || isOptionLabel(lab))) { k++; continue; } // another option
      const t = tidyGroupText(n.nodeValue);
      if (!t) continue;
      k++;
      if (okGroupText(t)) return t;
    }
    return null;
  }
  // Options may be real inputs or tick-box pictures (read-only pages draw ☑ as <img src="checkbox_checked.gif">).
  const OPTION_SEL = 'input[type=checkbox],input[type=radio]';
  // a tick-box picture: by its file name (checkbox.gif, checkbox_checked.gif, radio_on.png, tick.svg …), with or without a <label>
  const IMG_OPTION = /(^|[\/_\-.])(check(box|ed)?|radio|tick|chk|option)[^\/]*\.(gif|png|svg|jpe?g|webp)(\?|$)/i;
  const isImgOption = (el) => el.tagName === 'IMG' && IMG_OPTION.test(el.getAttribute('src') || '');
  /** All options (inputs and tick-box pictures) inside an element. */
  const optionsIn = (el) => [...el.querySelectorAll(OPTION_SEL), ...Array.from(el.querySelectorAll('img')).filter(isImgOption)];
  /** Is this option ticked? */
  const imgTicked = (img) => { const s = (img.getAttribute('src') || '').split(/[?#]/)[0].split('/').pop(); return /checked|_on\b|[_-]on\.|selected|tick|_y\b/i.test(s) && !/unchecked|_off\b|[_-]off\.|uncheck/i.test(s); };
  const optionChecked = (o) => (o.tagName === 'IMG' ? imgTicked(o) : !!o.checked);
  /** The text of an option's label, whether or not it is ticked. */
  function optionLabelText(o) {
    const doc = o.ownerDocument;
    let l = null;
    try { l = (o.id && doc.querySelector(`label[for="${esc(o.id)}"]`)) || o.closest('label'); } catch (e) { l = o.closest('label'); }
    if (l) return C().clean(l.textContent);
    // a bare option: the text right after it ("<img>居家照顧服務", "<img><span>居家照顧服務</span>"), up to the next option
    let t = '';
    for (let n = o.nextSibling; n && t.length < 40; n = n.nextSibling) {
      if (n.nodeType === 1 && (n.matches(OPTION_SEL) || isImgOption(n) || optionsIn(n).length || n.tagName === 'BR')) break;
      t += n.nodeType === 3 ? n.nodeValue : n.nodeType === 1 ? n.textContent : '';
      if (t.trim()) break;
    }
    t = C().clean(t);
    if (t) return t;
    // the picture alone in a table cell: the label is the cell on the left
    const cell = o.closest('td,th');
    if (cell && optionsIn(cell).length === 1 && !C().clean(cell.textContent)) {
      const p = cell.previousElementSibling;
      if (p && !optionsIn(p).length) return C().clean(p.textContent);
    }
    return o.value || o.getAttribute('alt') || o.getAttribute('title') || '';
  }
  /** The element that holds one option (its <label>, or the option itself), and the block around it. */
  const optionBox = (o) => o.closest('label') || o;
  /**
   * Group checkbox / radio options. Radios group by name. Checkboxes group by the block holding their wrappers,
   * except an option whose wrapper has its own text in front ("處置建議(☐ …") — that is a group of its own.
   * Returns [{ opts, container, label }].
   */
  const formIds = new WeakMap();
  let formSeq = 0;
  /** Radios belong together by name — or, in Angular forms without a name, by formcontrolname. */
  function groupKeyOf(o) {
    if (o.type !== 'radio') return null;
    const nm = o.name || o.getAttribute('formcontrolname') || o.getAttribute('ng-reflect-name');
    if (!nm) return null;
    const f = o.form || o.closest('form') || o.ownerDocument;
    if (!formIds.has(f)) formIds.set(f, ++formSeq);
    return `n:${formIds.get(f)}:${nm}`;
  }
  /** All radios of the same group as this one. */
  function radioGroupOf(o, pool) {
    const k = groupKeyOf(o);
    if (!k) return [o];
    return (pool || Array.from(o.ownerDocument.querySelectorAll('input[type=radio]'))).filter((x) => x.type === 'radio' && groupKeyOf(x) === k);
  }
  function optionGroups(opts, ctx) {
    const groups = new Map();
    for (const o of opts) {
      let key = groupKeyOf(o);
      if (!key) {
        const box = optionBox(o);
        const wrap = box.parentElement;
        key = wrap && ownText(wrap) && !/^[\s()（）]*$/.test(ownText(wrap)) ? wrap : (o.closest('div,span,fieldset,p,li') || box).parentElement || box.parentElement;
        if (key === box) key = box.parentElement;
        if (key && /^(TD|TH|TR|TBODY)$/.test(key.tagName)) {
          const tb = key.closest('table');
          if (tb && tb.parentElement && tb.parentElement.closest('td,th')) key = tb; // "申請服務種類 | <table>☑…☐…</table>"
        }
      }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(o);
    }
    const out = [];
    for (const [key, list] of groups) {
      // a search filter ("○收案中 ○已結案 ○全部"), not data about the patient
      if (list.length > 1 && list.some((o) => /^(全部|all|不限)$/i.test(C().clean(optionLabelText(o))))) continue;
      const container = list.length > 1 ? commonAncestor(list) : typeof key === 'string' ? optionBox(list[0]).parentElement : key;
      if (!container) continue;
      let label = groupLabel(container, ctx, list[0]);
      const row = rowLabelOf(container);
      if (!label) { const b = bestLabel(container.querySelector('input') === list[0] ? container : list[0], ctx); label = b.label; }
      if (label && row && C().cleanLabel(row) !== C().cleanLabel(label) && !rowLabelOf(container).includes(label)) {
        // a sub-list inside a labelled cell ("目前個案就醫科別" › "內科")
        // …also a field label inside an item row ("1.更換鼻胃管 | … | 材質：○一般塑膠 ○矽質") → "更換鼻胃管/材質"
        const cellText = C().clean((container.closest('td,th') || container).textContent);
        const fieldInCell = cellText.startsWith(label) && /^\s*[:：]/.test(cellText.slice(label.length));
        if (!cellText.startsWith(label) || fieldInCell) label = `${C().cleanLabel(row)}/${C().cleanLabel(label)}`;
      }
      // a group is never labelled by one of its own options ("收案中" for 收案中/已結案/未收案)
      const own = new Set(list.map((o) => C().cleanLabel(optionLabelText(o))));
      if (label && own.has(C().cleanLabel(label)) && list.length > 1) {
        const alt = [rowLabelOf(container), textBefore(container)].find((t) => t && okGroupText(t) && !own.has(C().cleanLabel(t)));
        label = alt || null;
      }
      out.push({ opts: list, container, label: label || null });
    }
    return out;
  }
  /** A group's stored value: the ticked options joined with "; " ("" when nothing is ticked). */
  function groupValue(g) {
    let sel = g.opts.filter(optionChecked).map(optionLabelText).filter(Boolean);
    // one box whose text is its label ("身障證明 | ☑"): ticked → 是
    if (g.opts.length === 1 && sel.length && C().cleanLabel(sel[0]) === C().cleanLabel(g.label || '')) sel = ['是'];
    return sel.join('; ');
  }
  /** The option element (box, radio or tick-box picture) an element is or belongs to: a click on its label text counts. */
  function optionAt(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.matches('input[type=checkbox],input[type=radio]') || isImgOption(el)) return el;
    const lab = el.closest('label');
    if (lab) { const o = optionsIn(lab); if (o.length === 1) return o[0]; }
    if (lab && lab.htmlFor) { const t = el.ownerDocument.getElementById(lab.htmlFor); if (t && t.matches('input[type=checkbox],input[type=radio]')) return t; }
    return null;
  }
  /** The whole group an option belongs to, grouped exactly as a page scan groups it. */
  function groupOf(opt, ctx = {}) {
    const doc = opt.ownerDocument;
    const all = optionsIn(doc.body || doc.documentElement).filter((o) => o === opt || !isHidden(o));
    return optionGroups(all, ctx).find((g) => g.opts.includes(opt)) || { opts: [opt], container: opt.parentElement || opt, label: null };
  }
  /** If a text box sits right after an option ("☐其他 [____]"), the group and option it belongs to. */
  function optionBefore(ctl) {
    let sib = ctl.previousElementSibling;
    while (sib && isHidden(sib) && sib.tagName !== 'LABEL') sib = sib.previousElementSibling;
    if (!sib) return null;
    const o = sib.matches('input[type=checkbox],input[type=radio]') ? sib : sib.tagName === 'LABEL' ? sib.querySelector('input[type=checkbox],input[type=radio]') : null;
    if (!o) return null;
    // the whole group this option belongs to (its neighbours in the same cell / block)
    const scopeEl = o.closest('td,th,fieldset,form') || ctl.ownerDocument.body;
    const all = Array.from(scopeEl.querySelectorAll('input[type=checkbox],input[type=radio]')).filter((x) => !isHidden(x));
    const g = optionGroups(all.includes(o) ? all : radioGroupOf(o), {}).find((x) => x.opts.includes(o));
    return { option: o, text: optionLabelText(o), group: g ? g.label : null };
  }
  function valueElementAfter(el) {
    let node = el;
    for (let d = 0; d < 3 && node; d++) {
      let sib = node.nextElementSibling;
      while (sib && (isHidden(sib) || !textOf(sib))) sib = sib.nextElementSibling;
      if (sib) return sib;
      node = node.parentElement;
      if (node && node.parentElement && Array.from(node.parentElement.children).length > 6) break;
    }
    return null;
  }
  /** Split "姓名：王小明 性別：男" into pairs (only when every label is short). */
  function splitInlinePairs(t) {
    const s = C().nfkc(t);
    const re = /([^\s:|;,，。]{1,16})\s*:\s*([^:]*?)(?=\s+[^\s:|;,，。]{1,16}\s*:|$)/g;
    const out = [];
    let m, covered = 0;
    while ((m = re.exec(s))) { if (/^[\d.\-~]+$/.test(m[1])) return []; if (m[2].trim()) out.push([m[1], m[2].trim()]); covered += m[0].length; }
    return out.length && covered >= s.replace(/\s+/g, '').length * 0.6 ? out : [];
  }

  // ── main entry ───────────────────────────────────────────────────────
  /**
   * Extract records from a document or an element.
   * ctx: { vocab, origin, refDate, refYear }
   * Returns { records, regions: [{ ref, kind, items }], registry }
   */
  function extractFromRoot(root, ctx = {}) {
    const reg = ctx.registry || makeRegistry();
    const now = new Date();
    ctx = { refYear: now.getFullYear(), refDate: { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() }, ...ctx };
    const scope = root.nodeType === 9 ? root.body || root.documentElement : root;
    const records = [];
    const regions = [];
    const tables = scope.tagName === 'TABLE' ? [scope] : Array.from(scope.querySelectorAll('table'));
    const handledTables = new Set();
    const optionCells = new Set(); // cells of label/value tables that hold tick boxes: read as option groups instead
    for (const t of tables) {
      if (isHidden(t) || t.closest('#' + OVERLAY_ID)) continue;
      const raw = gridOf(t);
      const toGrid = (skip) => raw.map((r) => r.map((c) => (skip && skip.has(c.el)
        ? { text: '', lines: [], th: c.th, ref: c.el ? reg.id(c.el) : null }
        : { text: c.text, lines: c.lines, th: c.th, ref: c.el ? reg.id(c.el) : null })));
      let res = C().analyzeTable(toGrid(null), { ...ctx, heading: precedingText(t) });
      if (res.kind === 'kv') {
        // a form laid out as a table: cells with labelled options ("○無 ○有", "☑輔具服務") give their value through
        // the option groups (only the ticked ones, with the right group label), not as cell text
        const withOpts = new Set(raw.flat().map((c) => c.el).filter((el) => el && optionsIn(el).some((o) => !isHidden(o) && optionLabelText(o))));
        if (withOpts.size) {
          withOpts.forEach((el) => optionCells.add(el));
          res = C().analyzeTable(toGrid(withOpts), { ...ctx, heading: precedingText(t) });
        }
      }
      if (res.kind === 'none') continue;
      handledTables.add(t);
      const tref = reg.id(t);
      for (const r of res.records) { for (const it of r.items) it.region = tref; for (const m of r.meds) m.region = tref; }
      records.push(...res.records);
      regions.push({ ref: tref, kind: res.kind, items: res.records.reduce((n, r) => n + r.items.length + r.meds.length, 0), map: res.map || null });
    }
    let broken = [], found = [];
    let pairs = [];
    if (ctx.templates && ctx.templates.length && PDB.templates) {
      const t = PDB.templates.applyExtract(scope.ownerDocument || scope, ctx.templates, reg, ctx);
      pairs = t.pairs; broken = t.broken; found = t.found;
    }
    // an element read by a template is not read again automatically (the taught label wins)
    const taughtRefs = new Set(pairs.map((p) => p.ref).filter((r) => r != null));
    pairs = pairs.concat(collectPairs(scope, { ...ctx, _handledTables: handledTables, _optionCells: optionCells }, reg).filter((p) => !taughtRefs.has(p.ref)));
    if (pairs.length) {
      const rec = C().recordFromPairs(pairs, ctx);
      if (rec.items.length || rec.meds.length || rec.skipped.length) { records.push(rec); regions.push({ ref: null, kind: 'fields', items: rec.items.length }); }
    }
    // how each element was read (a page template keeps it): option groups are found again by their first option
    const pairInfo = new Map();
    for (const p of pairs) if (p.ref != null && !pairInfo.has(p.ref)) pairInfo.set(p.ref, { src: p.src, opt: p.opt != null ? p.opt : null });
    return { records, regions, registry: reg, broken, found, pairInfo };
  }

  /**
   * The picture an element is (or is inside): an <img>, a <canvas> or an outermost <svg> — not a tick-box picture,
   * which is an option of a group. Used for image fields (their content is read by Claude, see ai.js readImage).
   */
  const PICTURE = /^(IMG|CANVAS|svg|SVG)$/;
  function pictureAt(el) {
    if (!el || el.nodeType !== 1 || !el.closest) return null;
    let pic = el.closest('img,canvas,svg');
    if (!pic) return null;
    if (/^svg$/i.test(pic.tagName)) for (let up = pic.parentElement && pic.parentElement.closest('svg'); up; up = up.parentElement && up.parentElement.closest('svg')) pic = up;
    if (isImgOption(pic)) return null;
    return pic;
  }
  const isPicture = (el) => !!el && el.nodeType === 1 && PICTURE.test(el.tagName) && !isImgOption(el);

  PDB.dom = { textOf, linesOf, gridOf, precedingText, labelCandidates, bestLabel, collectPairs, extractFromRoot,
    makeRegistry, isHidden, optionState, controlValue, readControl, splitInlinePairs, isSegment, OVERLAY_ID, optionGroups, optionLabelText, groupLabel, optionsIn, optionChecked, groupKeyOf, radioGroupOf, groupValue, optionAt, groupOf, isImgOption, pictureAt, isPicture };
})(globalThis);
