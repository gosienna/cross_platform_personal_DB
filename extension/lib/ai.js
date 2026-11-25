/*
 * Optional Claude extract (side panel only). Off until you add your own API key in Settings.
 * Flow: page text (+ optional screenshot) → privacy gate (mask, your review, final hard block)
 *       → Claude (structured output) → placeholders mapped back locally → normal preview.
 */
(function (g) {
  const PDB = (g.PDB = g.PDB || {});
  /** The model chosen in Settings, or the default when it is missing or no longer offered. */
  const modelOf = (settings) => {
    const id = settings && settings.ai && settings.ai.model;
    return PDB.db.AI_MODELS.find((m) => m.id === id) || PDB.db.AI_MODELS.find((m) => m.id === PDB.db.DEFAULT_AI_MODEL);
  };

  const SCHEMA = {
    type: 'object', additionalProperties: false, required: ['records'],
    properties: {
      records: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['patient', 'rows'],
          properties: {
            patient: {
              type: 'object', additionalProperties: false, required: ['name', 'nationalId', 'mrn', 'birthDate', 'bed'],
              properties: { name: { type: 'string' }, nationalId: { type: 'string' }, mrn: { type: 'string' }, birthDate: { type: 'string' }, bed: { type: 'string' } },
            },
            rows: {
              type: 'array',
              items: {
                type: 'object', additionalProperties: false, required: ['label', 'value', 'text', 'time'],
                properties: { label: { type: 'string' }, value: { type: 'string' }, text: { type: 'string' }, time: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  };

  function systemPrompt() {
    const labels = PDB.schema.VOCAB.map((v) => `${v.label}${v.unit ? ` (${v.unit})` : ''}${v.persistent ? ' [persistent]' : ''}`).join('; ');
    return [
      'You extract patient data from the text of a health-information-system page (often Traditional Chinese, sometimes with ROC dates such as 115/10/07 = 2026-10-07).',
      'Personal details were replaced with placeholders like [NAME_1], [ID_1], [PHONE_1] before you received the page. Copy placeholders exactly as they appear; never guess the hidden values.',
      'Return one record per patient on the page. In "patient", fill the fields you can see (placeholders allowed), "" otherwise.',
      `For each data point return a row with "label", "value" and "time". Use these canonical labels when they fit: ${labels}. For anything else use the label as written on the page.`,
      'Values: dates as YYYY-MM-DD; sex as male/female/other; numbers without units, converted to the unit shown in brackets; blood pressure as "systolic/diastolic"; blood glucose with a meal-time tag as label "Blood glucose (AC)" / "(PC)" / "(HS)".',
      'Medication: one row per medication, label "Medication", value "drug strength; dose; frequency; route; days; start~end; hospital dept; doctor" (leave out parts that are missing), time = start date.',
      'text: the value exactly as it is written on the page (copied character for character, placeholders as they appear), so it can be found on the page again.',
      'Why "text" matters: your answer is not saved as data. The system searches the page for the one element whose text equals your "text", records that element\'s CSS selector in a page template, and from then on reads the value from that selector itself, without you. So copy only the value as it appears inside its own element: no label, no unit that sits in a separate element, no reformatting. If the same text appears in several places, the system cannot tell which one you meant and drops the row.',
      'Example: the page shows "血壓" next to a cell "149/71" followed by "mmHg" in a separate cell, under a column dated "115/10/07 08:30". Return {"label": "Blood pressure", "value": "149/71", "text": "149/71", "time": "2026-10-07 08:30"}. The system finds the cell "149/71", saves a selector such as "table#vitals tr:nth-child(3) > td:nth-child(2)" for Blood pressure, and links the time to the date cell. Returning "text": "血壓 149/71 mmHg" would match no single element.',
      'time: "nan" for labels marked [persistent]; otherwise the measurement/record time as "YYYY-MM-DD HH:mm" (or "YYYY-MM-DD"), in the page\'s local time; "" if the page gives no time.',
      'Skip readings whose only time is relative (e.g. "4小時前"). Skip menus, buttons, staff schedules and page chrome. Do not invent data.',
    ].join('\n');
  }

  /** Records from Claude → the same shape the page agent returns. */
  function toFrameResult(parsed, map) {
    const C = PDB.core, R = PDB.redact;
    const records = (parsed.records || []).map((rec) => {
      const p = rec.patient || {};
      const hints = {};
      for (const k of ['name', 'nationalId', 'mrn', 'birthDate', 'bed']) { const v = R.reidentify(p[k] || '', map).trim(); if (v && !/^\[[A-Z]+_\d+\]$/.test(v)) hints[k] = v; }
      const out = C.newRecord();
      out.hints = hints;
      for (const row of rec.rows || []) {
        const value = R.reidentify(row.value, map);
        let time = (row.time || '').trim();
        const r = C.resolveLabel(row.label);
        const label = r && r.label ? r.label : C.cleanLabel(row.label);
        const entry = r && r.entry;
        if (/前$/.test(time)) { out.skipped.push({ label, raw: value, reason: 'relative time' }); continue; }
        let t = null;
        if (time === 'nan' || (entry && entry.persistent)) t = 'nan';
        else if (time) { const pt = C.parseDateTime(time); t = pt && pt.kind !== 'relative' ? C.formatTime(pt) : null; }
        let v = value, warn;
        if (entry && label !== 'Medication') { const n = C.normalizeValue(entry, value); if (!n) continue; v = n.value; warn = n.warn; }
        out.items.push({ label, value: v, time: t, rawLabel: row.label, raw: value, text: R.reidentify(row.text || row.value || '', map), warn, how: 'ai', ref: null });
        if (entry && entry.identity && !out.hints[entry.identity] && v) out.hints[entry.identity] = v;
      }
      return out;
    });
    return { records, regions: [], broken: [] };
  }

  async function callClaude({ apiKey, model, text, imageB64, system = systemPrompt(), schema = SCHEMA, prefix = 'Page text:\n<page>\n', suffix = '\n</page>' }) {
    if (!g.Anthropic) throw new Error('The Anthropic SDK is not bundled yet. Run "npm run build:vendor" and reload the extension.');
    const Anthropic = g.Anthropic.default || g.Anthropic;
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const content = [];
    if (imageB64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageB64 } });
    content.push({ type: 'text', text: `${prefix}${text}${suffix}` });
    const response = await client.beta.messages.create({
      model: model.id,
      max_tokens: 16000,
      // refusal fallback only where the model supports it (not Haiku)
      ...(model.fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content }],
    });
    if (response.stop_reason === 'refusal') throw new Error('Claude declined this request' + (response.stop_details && response.stop_details.explanation ? `: ${response.stop_details.explanation}` : '.'));
    if (response.stop_reason === 'max_tokens') throw new Error('The page is too large for one request. Use Pick region to send a smaller part.');
    const block = response.content.find((b) => b.type === 'text');
    if (!block) throw new Error('Claude returned no data.');
    return JSON.parse(block.text);
  }

  // ── review dialog (side panel DOM) ───────────────────────────────────
  function reviewDialog({ text, spans, truncated, screenshot, boxes }) {
    const { h, $ } = g.UI;
    return new Promise((resolve) => {
      const dlg = $('#dlg'), form = $('#dlgForm');
      dlg.style.width = '640px';
      form.textContent = '';
      const pane = h('div', { class: 'payload' });
      const info = h('div', { class: 'small' });
      const note = h('div', { class: 'small mut' });
      const L = PDB.redact.CAT_LABEL;
      const draw = () => {
        hidePop();
        pane.textContent = '';
        let pos = 0;
        // every piece carries its offsets in `text`, so a selection maps back exactly
        const seg = (a, b) => { if (b > a) pane.append(h('span', { 'data-s': a }, text.slice(a, b))); };
        for (const s of spans) {
          if (s.start < pos) continue;
          seg(pos, s.start);
          const mine = s.source === 'you';
          const mk = h('mark', {
            class: mine ? 'you' : s.decision === 'send' ? 'sent' : s.decision == null ? 'amber' : '', 'data-s': s.start, 'data-e': s.end,
            title: mine ? `${L[s.cat]} · click to unblock` : `${L[s.cat]} · ${s.conf === 'high' ? 'detected' : 'uncertain'} · click to ${s.decision === 'mask' ? 'send it' : 'mask it'}`,
          }, mine ? `■ ${s.text}` : s.decision === 'send' ? s.text : s.decision == null ? `${s.text} ?` : `■ ${L[s.cat]}`);
          mk.onclick = () => {
            if (mine) spans.splice(spans.indexOf(s), 1);
            else s.decision = s.decision === 'mask' ? 'send' : 'mask';
            draw();
          };
          pane.append(mk);
          pos = s.end;
        }
        seg(pos, text.length);
        const undecided = spans.filter((s) => s.decision == null).length;
        const yours = spans.filter((s) => s.source === 'you').length;
        info.textContent = `${spans.filter((s) => s.decision === 'mask').length} masked${yours ? ` (${yours} blocked by you)` : ''} · ${spans.filter((s) => s.decision === 'send').length} you chose to send · ${undecided} need your decision (amber).`;
        sendBtn.disabled = undecided > 0 || (imgBox && imgCb.checked && !checkedCb.checked);
      };
      /** Block text[a, b): grows over any detected item it touches, which it then replaces. */
      const block = (a, b) => {
        for (const s of spans) if (s.start < b && s.end > a) { a = Math.min(a, s.start); b = Math.max(b, s.end); }
        for (let i = spans.length - 1; i >= 0; i--) if (spans[i].start >= a && spans[i].end <= b) spans.splice(i, 1);
        spans.push({ start: a, end: b, text: text.slice(a, b), cat: 'blocked', conf: 'high', source: 'you', decision: 'mask' });
      };
      const places = (v) => { const at = []; let i = text.indexOf(v); while (i >= 0) { at.push(i); i = text.indexOf(v, i + v.length); } return at; };
      /** Block a value in every place it appears in the text. Returns how many places. */
      const blockAll = (v) => {
        const at = places(v);
        for (const i of at.reverse()) block(i, i + v.length);
        spans.sort((x, y) => x.start - y.start);
        return at.length;
      };
      const alwaysBlock = async (v) => {
        const st = await PDB.db.getSettings();
        const terms = st.privacy.customTerms || [];
        if (!terms.includes(v)) await PDB.db.saveSettings({ privacy: { ...st.privacy, customTerms: terms.concat([v]) } });
      };
      // a selection in the text → offsets in `text` (a selection that ends inside a masked item takes all of it)
      const offsetAt = (node, off, edge) => {
        let el = node.nodeType === 3 ? node.parentNode : node;
        if (el === pane) { const c = pane.childNodes[off]; return c ? +c.dataset.s : text.length; }
        while (el && el.parentNode !== pane) el = el.parentNode;
        if (!el) return null;
        if (el.tagName === 'MARK') return edge === 'start' ? +el.dataset.s : +el.dataset.e;
        return +el.dataset.s + (node.nodeType === 3 ? off : off ? el.textContent.length : 0);
      };
      const selected = () => {
        const sel = document.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
        const r = sel.getRangeAt(0);
        if (!pane.contains(r.startContainer) || !pane.contains(r.endContainer)) return null;
        let a = offsetAt(r.startContainer, r.startOffset, 'start'), b = offsetAt(r.endContainer, r.endOffset, 'end');
        if (a == null || b == null) return null;
        while (a < b && /\s/.test(text[a])) a++;
        while (b > a && /\s/.test(text[b - 1])) b--;
        if (b <= a) return null;
        if (spans.some((s) => s.start <= a && s.end >= b)) return null; // inside one item: click it instead
        return { a, b, rect: r.getBoundingClientRect ? r.getBoundingClientRect() : pane.getBoundingClientRect() };
      };
      // the small "Block" bar shown over a selection
      let pending = null;
      const keep = (e) => e.preventDefault(); // keep the selection when pressing the bar's buttons
      const popOne = h('button', { type: 'button', onmousedown: keep, onclick: () => { if (!pending) return; const { a, b } = pending; block(a, b); spans.sort((x, y) => x.start - y.start); draw(); } });
      const popAll = h('button', { type: 'button', onmousedown: keep, onclick: () => { if (!pending) return; const n = blockAll(pending.v); draw(); note.textContent = `Blocked in ${n} places.`; } });
      const popAlways = h('button', { type: 'button', onmousedown: keep, title: 'Also add it to Settings → Custom terms to always mask, for every page', onclick: async () => {
        if (!pending) return; const v = pending.v; const n = blockAll(v); draw(); await alwaysBlock(v); note.textContent = `Blocked in ${n} places, and added to your custom terms: it will be masked on every page.`;
      } }, 'Always block');
      const pop = h('div', { class: 'blockpop', hidden: true }, popOne, popAll, popAlways);
      function hidePop() { pop.hidden = true; pending = null; }
      const showPop = () => {
        const s = selected();
        if (!s) return hidePop();
        const v = text.slice(s.a, s.b);
        const n = places(v).length;
        pending = { ...s, v };
        popOne.textContent = n > 1 ? 'Block here' : 'Block';
        popAll.hidden = n < 2;
        popAll.textContent = `Block all ${n}`;
        popAlways.hidden = v.length < 2 || v.length > 80;
        pop.hidden = false;
        const box = form.getBoundingClientRect();
        pop.style.left = `${Math.max(0, s.rect.left - box.left)}px`;
        pop.style.top = `${s.rect.bottom - box.top + 4}px`;
      };
      pane.addEventListener('mouseup', () => setTimeout(showPop, 0));
      pane.addEventListener('keyup', (e) => { if (e.shiftKey || e.key.startsWith('Arrow')) showPop(); });
      pane.addEventListener('scroll', hidePop);
      // type a value to block (for text that is hard to select)
      const typed = h('input', { type: 'text', placeholder: 'Type a value to block, e.g. a name or number', style: 'flex:1;min-width:200px' });
      const blockTyped = () => {
        const v = typed.value.trim();
        if (!v) return;
        const n = blockAll(v);
        note.textContent = n ? `Blocked “${v}” in ${n} place${n > 1 ? 's' : ''}.` : `“${v}” does not appear in the text, so there is nothing to block.`;
        if (n) typed.value = '';
        draw();
      };
      typed.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); blockTyped(); } }); // Enter would close the dialog
      const typedBtn = h('button', { type: 'button', onclick: blockTyped }, 'Block');
      const maskAmber = h('button', { type: 'button', onclick: () => { spans.forEach((s) => { if (s.decision == null) s.decision = 'mask'; }); draw(); } }, 'Mask all uncertain');
      // screenshot with black boxes; drag to add more
      let imgBox = null, imgCb = null, checkedCb = null, canvas = null;
      if (screenshot) {
        imgCb = h('input', { type: 'checkbox', onchange: () => { imgBox.hidden = !imgCb.checked; draw(); } });
        checkedCb = h('input', { type: 'checkbox', onchange: () => draw() });
        canvas = h('canvas', { style: 'max-width:100%;border:1px solid #ccc;cursor:crosshair' });
        const img = new Image();
        img.onload = () => {
          canvas.width = img.width; canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          ctx.fillStyle = '#000';
          for (const b of boxes) ctx.fillRect(b.x - 3, b.y - 3, b.w + 6, b.h + 6);
          let start = null;
          canvas.onmousedown = (e) => { const r = canvas.getBoundingClientRect(); start = { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height }; };
          canvas.onmouseup = (e) => { if (!start) return; const r = canvas.getBoundingClientRect(); const x = (e.clientX - r.left) * canvas.width / r.width, y = (e.clientY - r.top) * canvas.height / r.height; ctx.fillRect(Math.min(x, start.x), Math.min(y, start.y), Math.abs(x - start.x), Math.abs(y - start.y)); start = null; };
        };
        img.src = screenshot;
        imgBox = h('div', { hidden: true }, h('p', { class: 'small' }, 'Known personal fields are blacked out. Drag on the image to black out more. Text inside images and charts cannot be detected automatically: check it yourself.'), canvas,
          h('label', { class: 'small' }, checkedCb, ' I checked the image and it shows no personal data I don\'t want to send'));
      }
      const sendBtn = h('button', { class: 'primary', type: 'button', onclick: () => { dlg.close('send'); } }, 'Send to Claude');
      form.append(
        h('b', {}, 'Review what will be sent to Anthropic'),
        h('p', { class: 'small mut' }, 'Grey ■ = masked (replaced by a placeholder). Amber ? = uncertain, click to decide. Click any masked item to send it instead. To block anything else, select it in the text and press Block (dark ■ = blocked by you; click to unblock). Only this text', screenshot ? ' (and the image, if you tick it)' : '', ' leaves your computer.'),
        truncated ? h('p', { class: 'small', style: 'color:#d33' }, 'The page is very long; only the first 60 000 characters are shown and sent. Use Pick region for the rest.') : null,
        pane, pop, info,
        h('div', { class: 'btns', style: 'justify-content:flex-start' }, typed, typedBtn, maskAmber), note,
        screenshot ? h('label', { class: 'small' }, imgCb, ' Also send a screenshot (needed for charts drawn as images)') : null, imgBox,
        h('div', { class: 'btns' }, h('button', { type: 'button', onclick: () => dlg.close('') }, 'Cancel'), sendBtn));
      dlg.onclose = () => resolve(dlg.returnValue === 'send' ? { spans, image: imgCb && imgCb.checked ? canvas.toDataURL('image/png').split(',')[1] : null } : null);
      dlg.returnValue = '';
      draw();
      dlg.showModal();
    });
  }

  async function blocked(left) {
    const { h, modal } = g.UI;
    await modal((f) => f.append(h('b', {}, 'Sending blocked'), h('p', {}, 'The text still contains identifiers you did not approve:'),
      h('ul', {}, left.map((s) => h('li', {}, `${PDB.redact.CAT_LABEL[s.cat]}: ${s.text}`))), h('p', { class: 'small' }, 'Nothing was sent. Run AI extract again and mask them, or click them to approve sending.'),
      h('div', { class: 'btns' }, h('button', { class: 'primary', value: '' }, 'OK'))));
  }

  async function audit(entry) {
    const log = await PDB.db.get('aiAudit', []);
    log.unshift(entry);
    await PDB.db.set('aiAudit', log.slice(0, 20));
  }

  /** Entry point used by the side panel. */
  async function run({ tab, st, call, status, onResult }) {
    const s = await PDB.db.getSettings();
    if (!s.ai.enabled || !s.ai.apiKey) throw new Error('AI extract is off. Turn it on in Dashboard → Settings with your own Anthropic API key.');
    status('Preparing a privacy-masked copy of the page…');
    const vocab = await PDB.db.getVocab();
    const frames = await call(tab.id, 'aiText', [{ vocab, origin: st.source }]);
    let text = frames.map((f, i) => (frames.length > 1 ? `=== part ${i + 1} ===\n` : '') + f.result.text).join('\n\n');
    const truncated = /\[…truncated\]$/.test(text);
    const known = frames.flatMap((f) => f.result.known);
    // stored values of sensitive labels that appear on this page
    const stored = await PDB.db.rowsByLabels(Object.keys(PDB.redact.LABEL_CAT));
    for (const r of stored) if (r.value && r.value.length >= 2 && text.includes(r.value)) known.push({ label: r.label, value: r.value });
    const { text: norm, spans } = PDB.redact.detect(text, known, { categories: s.privacy.categories, customTerms: s.privacy.customTerms });
    text = norm;
    // screenshot with sensitive element boxes (top frame only)
    let shot = null, boxes = [];
    try {
      shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      const top = frames.find((f) => f.result.top);
      if (top) { const r = await call(tab.id, 'rectsOf', [top.result.known.map((k) => k.ref).filter((x) => x != null)], [top.frameId]); boxes = (r[0] && r[0].result) || []; }
    } catch (e) { shot = null; }
    status('Review what will be sent…');
    const review = await reviewDialog({ text, spans, truncated, screenshot: shot, boxes });
    if (!review) return status('Cancelled. Nothing was sent.');
    const { out, map } = PDB.redact.apply(text, review.spans);
    const approved = review.spans.filter((x) => x.decision === 'send').map((x) => x.text);
    const check = PDB.redact.finalCheck(out, approved);
    if (!check.ok) { await blocked(check.left); return status('Blocked: the text still contained identifiers. Nothing was sent.', true); }
    await audit({ at: Date.now(), source: st.source, text: out, image: review.image ? `data:image/png;base64,${review.image}` : null });
    status('Asking Claude… (only the masked text' + (review.image ? ' and the masked image' : '') + ' was sent)');
    const parsed = await callClaude({ apiKey: s.ai.apiKey, model: modelOf(s), text: out, imageB64: review.image });
    await onResult([{ frameId: 0, result: toFrameResult(parsed, map) }]);
  }

  // ── reading a picture (image fields of a page template) ─────────────
  const IMAGE_SCHEMA = {
    type: 'object', additionalProperties: false, required: ['rows'],
    properties: {
      rows: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['label', 'value', 'time', 'exact'],
          properties: { label: { type: 'string' }, value: { type: 'string' }, time: { type: 'string' }, exact: { type: 'boolean' } },
        },
      },
    },
  };
  function imagePrompt() {
    const labels = PDB.schema.VOCAB.map((v) => `${v.label}${v.unit ? ` (${v.unit})` : ''}${v.persistent ? ' [persistent]' : ''}`).join('; ');
    return [
      'You read patient data from one picture taken from a health-information-system page: a chart, a scanned or photographed form, a photo of a meter, a table drawn as an image. Text is often Traditional Chinese; dates may be ROC (115/10/07 = 2026-10-07).',
      'Personal details may have been blacked out before you received the picture. Never guess what is under a black box.',
      'You are told what the page calls this picture. Return every data point the picture shows as one row.',
      `"label": use these canonical labels when they fit: ${labels}. For anything else use the label as written in the picture. When the picture shows one kind of value without naming it, use the name the page gives the picture.`,
      'Values: numbers without units, converted to the unit shown in brackets; blood pressure as "systolic/diastolic"; dates as YYYY-MM-DD; blood glucose with a meal-time tag as "Blood glucose (AC)" / "(PC)" / "(HS)". Medication: label "Medication", value "drug strength; dose; frequency; route; days; start~end".',
      '"time": "nan" for labels marked [persistent]; otherwise the time this value was measured or recorded as written in the picture, as "YYYY-MM-DD HH:mm" or "YYYY-MM-DD", in local time; "" when the picture shows no time for it.',
      '"exact": true when the value is written in the picture (a number, a data label, text); false when you estimated it from a point\'s position against the axes. Prefer written values; only estimate when nothing is written, and then round sensibly.',
      'Skip titles, legends, axis ticks, logos and anything that is not a data point. Do not invent data. If the picture shows no data, return no rows.',
    ].join('\n');
  }
  const loadImage = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('This picture cannot be shown (unknown format).')); i.src = src; });
  const MAX_EDGE = 1568; // larger pictures are scaled down (what Claude reads best; smaller requests)
  /**
   * Review one picture before it is sent: earlier black boxes (field.mask) are drawn again, you can drag more or clear
   * them, and you must tick that you checked it. Resolves { image (PNG base64), mask } or null (skip) / false (cancel all).
   */
  function imageDialog({ dataURL, label, hint, mask, index, count }) {
    const { h, $ } = g.UI;
    return loadImage(dataURL).then((img) => new Promise((resolve) => {
      const dlg = $('#dlg'), form = $('#dlgForm');
      dlg.style.width = '640px';
      form.textContent = '';
      const k = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
      const W = Math.max(1, Math.round((img.naturalWidth || img.width) * k)), H = Math.max(1, Math.round((img.naturalHeight || img.height) * k));
      const canvas = h('canvas', { style: 'max-width:100%;border:1px solid #ccc;cursor:crosshair;background:#fff' });
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      let boxes = (mask || []).map((b) => ({ ...b }));
      const paint = () => {
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
        ctx.drawImage(img, 0, 0, W, H);
        ctx.fillStyle = '#000';
        for (const b of boxes) ctx.fillRect(b.x * W, b.y * H, b.w * W, b.h * H);
      };
      let start = null;
      const at = (e) => { const r = canvas.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
      canvas.onmousedown = (e) => { start = at(e); };
      canvas.onmouseup = (e) => {
        if (!start) return;
        const p = at(e);
        const b = { x: Math.min(p.x, start.x), y: Math.min(p.y, start.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
        start = null;
        if (b.w * W < 3 || b.h * H < 3) return;
        boxes.push(b); paint(); checked.checked = false; sync();
      };
      const checked = h('input', { type: 'checkbox', onchange: () => sync() });
      const sendBtn = h('button', { class: 'primary', type: 'button', onclick: () => dlg.close('send') }, 'Send to Claude');
      const sync = () => { sendBtn.disabled = !checked.checked; };
      const clear = h('button', { type: 'button', onclick: () => { boxes = []; paint(); checked.checked = false; sync(); } }, 'Clear black boxes');
      form.append(
        h('b', {}, `Read the picture “${label}” with Claude${count > 1 ? ` (${index + 1} of ${count})` : ''}`),
        h('p', { class: 'small mut' }, 'Only this picture (with the black boxes) and the text below leave your computer. Text inside pictures cannot be detected automatically: drag on the picture to black out names, ID numbers, faces or anything else you do not want to send.',
          mask && mask.length ? ' The boxes you drew last time for this picture are already applied.' : ''),
        canvas,
        h('div', { class: 'btns', style: 'justify-content:flex-start' }, clear),
        h('div', { class: 'payload small' }, hint),
        h('label', { class: 'small' }, checked, ' I checked the picture and it shows no personal data I don\'t want to send'),
        h('div', { class: 'btns' }, h('button', { type: 'button', onclick: () => dlg.close('') }, 'Cancel'), h('button', { type: 'button', onclick: () => dlg.close('skip') }, 'Skip this picture'), sendBtn));
      dlg.onclose = () => {
        const v = dlg.returnValue;
        resolve(v === 'send' ? { image: canvas.toDataURL('image/png').split(',')[1], mask: boxes } : v === 'skip' ? null : false);
      };
      dlg.returnValue = '';
      paint(); sync();
      dlg.showModal();
    }));
  }
  /** The text sent with a picture: what the page calls it, with any identifiers in it masked (never sent). */
  function imageHint(label, anchor, settings) {
    const near = anchor && PDB.core.cleanLabel(anchor) !== label ? ` It sits next to the text “${anchor.slice(0, 60)}”.` : '';
    const raw = `The page calls this picture “${label}”.${near}`;
    const { text, spans } = PDB.redact.detect(raw, [], { categories: settings.privacy.categories, customTerms: settings.privacy.customTerms });
    const { out } = PDB.redact.apply(text, spans.map((x) => ({ ...x, decision: 'mask' })));
    return out;
  }
  /**
   * Read pictures with Claude, one review per picture. pics: [{ dataURL, label, anchor, mask }].
   * Calls onRead(i, { rows, mask }) for each picture read; stops at Cancel. Returns how many were read.
   */
  async function readImages({ pics, source, status, onRead }) {
    const s = await PDB.db.getSettings();
    if (!s.ai.enabled || !s.ai.apiKey) throw new Error('Reading pictures uses AI, which is off. Turn it on in Dashboard → Settings with your own Anthropic API key.');
    let n = 0;
    for (let i = 0; i < pics.length; i++) {
      const p = pics[i];
      const hint = imageHint(p.label, p.anchor, s);
      status(`Review picture ${i + 1} of ${pics.length}…`);
      const review = await imageDialog({ dataURL: p.dataURL, label: p.label, hint, mask: p.mask, index: i, count: pics.length });
      if (review === false) break;
      if (!review) continue;
      const check = PDB.redact.finalCheck(hint, []);
      if (!check.ok) { await blocked(check.left); break; }
      await audit({ at: Date.now(), source, text: hint, image: `data:image/png;base64,${review.image}` });
      status(`Claude is reading “${p.label}”… (only the picture with its black boxes and the line of text above were sent)`);
      const parsed = await callClaude({ apiKey: s.ai.apiKey, model: modelOf(s), text: hint, imageB64: review.image, system: imagePrompt(), schema: IMAGE_SCHEMA, prefix: '', suffix: '' });
      await onRead(i, { rows: (parsed.rows || []).filter((r) => r && String(r.value || '').trim()), mask: review.mask });
      n++;
    }
    return n;
  }

  g.AIFlow = { run, modelOf, reviewDialog, toFrameResult, SCHEMA, systemPrompt, readImages, imagePrompt, IMAGE_SCHEMA, imageHint };
})(globalThis);
