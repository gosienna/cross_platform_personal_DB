/*
 * Optional Claude extract (side panel only). Off until you add your own API key in Settings.
 * Flow: page text (+ optional screenshot) → privacy gate (mask, your review, final hard block)
 *       → Claude (structured output) → placeholders mapped back locally → normal preview.
 */
(function (g) {
  const PDB = (g.PDB = g.PDB || {});
  const MODEL = 'claude-opus-5-5';

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
                type: 'object', additionalProperties: false, required: ['label', 'value', 'time'],
                properties: { label: { type: 'string' }, value: { type: 'string' }, time: { type: 'string' } },
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
        out.items.push({ label: label.startsWith('Blood glucose') ? label : label, value: v, time: t, rawLabel: row.label, raw: value, warn, how: 'ai', ref: null });
        if (entry && entry.identity && !out.hints[entry.identity] && v) out.hints[entry.identity] = v;
      }
      return out;
    });
    return { records, regions: [], broken: [] };
  }

  async function callClaude({ apiKey, text, imageB64 }) {
    if (!g.Anthropic) throw new Error('The Anthropic SDK is not bundled yet. Run "npm run build:vendor" and reload the extension.');
    const Anthropic = g.Anthropic.default || g.Anthropic;
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const content = [];
    if (imageB64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageB64 } });
    content.push({ type: 'text', text: `Page text:\n<page>\n${text}\n</page>` });
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      system: systemPrompt(),
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
      const draw = () => {
        pane.textContent = '';
        let pos = 0;
        for (const s of spans) {
          if (s.start < pos) continue;
          pane.append(text.slice(pos, s.start));
          const mk = h('mark', { class: s.decision === 'send' ? 'sent' : s.decision == null ? 'amber' : '', title: `${PDB.redact.CAT_LABEL[s.cat]} · ${s.conf === 'high' ? 'detected' : 'uncertain'} · click to ${s.decision === 'mask' ? 'send it' : 'mask it'}` },
            s.decision === 'send' ? s.text : s.decision == null ? `${s.text} ?` : `■ ${PDB.redact.CAT_LABEL[s.cat]}`);
          mk.onclick = () => { s.decision = s.decision === 'mask' ? 'send' : 'mask'; draw(); };
          pane.append(mk);
          pos = s.end;
        }
        pane.append(text.slice(pos));
        const undecided = spans.filter((s) => s.decision == null).length;
        info.textContent = `${spans.filter((s) => s.decision === 'mask').length} masked · ${spans.filter((s) => s.decision === 'send').length} you chose to send · ${undecided} need your decision (amber).`;
        sendBtn.disabled = undecided > 0 || (imgBox && imgCb.checked && !checkedCb.checked);
      };
      const maskSel = h('button', { type: 'button', onclick: () => {
        const sel = document.getSelection();
        if (!sel || sel.isCollapsed || !pane.contains(sel.anchorNode)) return;
        const t = sel.toString().trim();
        if (t.length < 2) return;
        let i = text.indexOf(t);
        while (i >= 0) { if (!spans.some((s) => i < s.end && i + t.length > s.start)) spans.push({ start: i, end: i + t.length, text: t, cat: 'term', conf: 'high', source: 'you', decision: 'mask' }); i = text.indexOf(t, i + t.length); }
        spans.sort((a, b) => a.start - b.start);
        draw();
      } }, 'Mask selected text');
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
        h('p', { class: 'small mut' }, 'Grey ■ = masked (replaced by a placeholder). Amber ? = uncertain, click to decide. Click any masked item to send it instead. Only this text', screenshot ? ' (and the image, if you tick it)' : '', ' leaves your computer.'),
        truncated ? h('p', { class: 'small', style: 'color:#d33' }, 'The page is very long; only the first 60 000 characters are shown and sent. Use Pick region for the rest.') : null,
        pane, info, h('div', { class: 'btns', style: 'justify-content:flex-start' }, maskSel, maskAmber),
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
    const parsed = await callClaude({ apiKey: s.ai.apiKey, text: out, imageB64: review.image });
    await onResult([{ frameId: 0, result: toFrameResult(parsed, map) }]);
  }

  g.AIFlow = { run, toFrameResult, SCHEMA, systemPrompt };
})(globalThis);
