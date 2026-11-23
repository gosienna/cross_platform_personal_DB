/* Side panel: Scan → Preview → Save, and Scan form → Preview → Fill. */
(() => {
  const { h, $, $$, modal, dataURLtoBlob, sourceOf, vocabLabels } = UI;
  const C = PDB.core, DB = PDB.db;
  const LIBS = ['lib/schema.js', 'lib/core.js', 'lib/dom.js', 'lib/templates.js', 'lib/fill.js', 'lib/redact.js', 'content/agent.js'];
  const MEDIA_LABEL = { image: 'Photo', audio: 'Audio', video: 'Video', screenshot: 'Screenshot' };

  const st = { tab: null, source: '', path: '', captureTime: '', recs: [], regions: [], blobs: new Map(), broken: [], fill: null };
  // list search (per tab) and whether the page outlines are shown (remembered)
  const pref = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* not available */ } } };
  const ui = { q: { cap: '', fill: '' }, marks: pref.get('pdb.marks') !== 'off' };

  // ── tabs ─────────────────────────────────────────────────────────────
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => {
    $$('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $$('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'fill') loadPatients();
  }));
  $('#openDash').onclick = () => chrome.runtime.sendMessage({ type: 'pdb:openDashboard' });

  const status = (msg, err) => { const s = $('#status'); s.innerHTML = ''; s.append(msg); s.classList.toggle('err', !!err); };
  const fstatus = (msg, err) => { const s = $('#fillStatus'); s.innerHTML = ''; s.append(msg); s.classList.toggle('err', !!err); };

  // ── talking to the page ──────────────────────────────────────────────
  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^(https?|file):/.test(tab.url || '')) throw new Error('This page cannot be read (only http, https and file pages). For local files, enable "Allow access to file URLs" for this extension.');
    return tab;
  }
  async function inject(tabId) {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: LIBS });
  }
  /** Call window.__pdbAgent[fn](...args) in all frames (or the given ones). */
  async function call(tabId, fn, args = [], frameIds) {
    const target = frameIds ? { tabId, frameIds } : { tabId, allFrames: true };
    const res = await chrome.scripting.executeScript({ target, func: (f, a) => (window.__pdbAgent ? window.__pdbAgent[f](...a) : null), args: [fn, args] });
    return res.filter((r) => r.result != null).map((r) => ({ frameId: r.frameId, result: r.result }));
  }
  const splitRef = (ref) => { const [f, r] = String(ref).split(':'); return { frameId: +f, ref: +r }; };

  async function extractCtx() {
    const vocab = await DB.getVocab();
    const all = await DB.getTemplates();
    return { vocab, origin: st.source, templates: templatesFor(all, 'extract') };
  }
  /**
   * Templates for this page, for Capture ('extract') or Fill ('fill'): this mode's templates of this page, plus the
   * other mode's templates of this site (a field taught on the read-only page is found on the edit form, and back).
   */
  function templatesFor(all, use) {
    return all.filter((t) => t.origin === st.source && (t.direction === use ? !t.path || st.path.startsWith(t.path) : true));
  }

  // ── capture ──────────────────────────────────────────────────────────
  $('#scan').onclick = () => run(async () => {
    const tab = await prepare();
    status('Reading the page…');
    const results = await call(tab.id, 'scan', [await extractCtx()]);
    await buildPreview(results);
  });
  $('#pick').onclick = () => run(async () => {
    const tab = await prepare();
    await call(tab.id, 'startPick', ['extract', await extractCtx()]);
    status('Click the part of the page you want to capture (Esc cancels).');
  });
  $('#teach').onclick = () => run(async () => {
    const tab = await prepare();
    await call(tab.id, 'startPick', ['teach', {}]);
    status('Click a value, a form field or a tick box, then choose its label (Esc cancels).');
  });
  $('#media').onclick = () => run(async () => {
    const tab = await prepare();
    await call(tab.id, 'startPick', ['media', {}]);
    status('Click an image, chart, audio or video (Esc cancels).');
  });
  $('#shot').onclick = () => run(async () => {
    const tab = await prepare(true);
    const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    await addMedia({ kind: 'screenshot', name: 'screenshot.png', dataURL: url });
  });
  $('#ai').onclick = () => run(async () => {
    if (!globalThis.AIFlow) throw new Error('AI extract is not available.');
    const tab = await prepare();
    await AIFlow.run({ tab, st, call, status, onResult: (results) => buildPreview(results, { ai: true }) });
  });
  $('#discard').onclick = () => resetCapture('Discarded. Nothing was saved.');
  $('#save').onclick = () => run(save);

  async function prepare(keepPreview) {
    const tab = await activeTab();
    if (!st.tab || st.tab.id !== tab.id || st.tab.url !== tab.url) { if (!keepPreview) resetCapture(); }
    st.tab = tab; st.source = sourceOf(tab.url);
    try { st.path = new URL(tab.url).pathname; } catch (e) { st.path = ''; }
    await inject(tab.id);
    return tab;
  }
  async function run(fn) { try { await fn(); } catch (e) { console.error(e); status(String(e.message || e), true); } }

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!st.tab || !sender.tab || sender.tab.id !== st.tab.id) return;
    if (msg.type === 'pdb:picked') run(() => buildPreview([{ frameId: sender.frameId, result: msg.result }], { picked: true }));
    else if (msg.type === 'pdb:taught' && msg.mode === 'teach') run(() => onTaught(msg.field));
    else if (msg.type === 'pdb:taught' && msg.mode === 'fill') run(() => onFillTaught(msg.field));
    else if (msg.type === 'pdb:media') run(() => addMedia(msg.media));
    else if (msg.type === 'pdb:badge') focusRow(`${sender.frameId}:${msg.ref}`);
    else if (msg.type === 'pdb:pickCancelled') { call(st.tab.id, 'stopPick').catch(() => {}); status('Cancelled.'); }
    else if (msg.type === 'pdb:error') status(msg.message, true);
  });

  /** Merge frame results → records → preview rows with identity and dedup status. */
  async function buildPreview(results, opts = {}) {
    await call(st.tab.id, 'stopPick').catch(() => {});
    st.captureTime = C.utcStamp(new Date());
    const all = [];
    st.regions = []; st.broken = [];
    const foundLabels = new Set();
    for (const { frameId, result } of results) {
      for (const r of result.records) {
        for (const it of r.items) { it.ref = it.ref != null ? `${frameId}:${it.ref}` : null; it.region = it.region != null ? `${frameId}:${it.region}` : null; }
        for (const m of r.meds) { m.ref = m.ref != null ? `${frameId}:${m.ref}` : null; m.region = m.region != null ? `${frameId}:${m.region}` : null; }
        all.push(r);
      }
      for (const g of result.regions || []) if (g.ref != null) st.regions.push({ ...g, ref: `${frameId}:${g.ref}` });
      st.broken.push(...(result.broken || []));
      for (const l of result.found || []) foundLabels.add(l);
    }
    // a field is only "not found" when no frame found it; list each label once
    st.broken = [...new Map(st.broken.filter((b) => !foundLabels.has(b.label)).map((b) => [b.label, b])).values()];
    const merged = C.mergeRecords(all);
    const ix = C.buildIdentityIndex(await DB.rowsByLabels(['MRN', 'Name', 'Birth date', 'Bed']));
    const prev = opts.picked || opts.ai ? [] : st.recs.filter((r) => r.mediaOnly);
    st.recs = merged.map((rec, i) => {
      const id = C.resolveIdentity(rec.hints, st.source, ix);
      const rows = C.recordToRows(rec, { source: st.source, captureTime: st.captureTime }).map((r, j) => ({
        key: `${i}.${j}`, label: r.label, value: r.value, time: r.time, source: r.source,
        rawLabel: r._item.rawLabel || r.label, ref: r._item.ref || null, regionRef: r._item.region || null, warn: r._item.warn, unmapped: !!r._item.unmapped,
        how: r._item.how || (opts.ai ? 'ai' : null), conflictWith: r._conflictWith, on: true,
      }));
      return { hints: rec.hints, skipped: rec.skipped, rows, pid: id.patientId || '', identity: id };
    }).concat(prev);
    for (const rec of st.recs) await refreshStatus(rec);
    const n = st.recs.reduce((a, r) => a + r.rows.length, 0);
    if (!n) status(opts.picked ? 'Nothing recognisable in that part of the page. Try a larger region, or Teach the fields.' : 'No data recognised on this page. Try Pick region, Teach, or AI extract.', !n);
    else status(`${st.recs.length} patient${st.recs.length > 1 ? 's' : ''} · ${n} values found. Check them, then Save.`);
    render();
    paintOverlay();
  }

  async function refreshStatus(rec) {
    const pid = rec.pid.trim();
    if (!pid) { for (const r of rec.rows) { r.status = 'new'; delete r.oldValue; } return; }
    const rows = rec.rows.map((r) => ({ ...r, patientId: pid }));
    const existing = await DB.existingFor(rows);
    const diff = C.diffRows(rows, existing);
    rec.rows.forEach((r, i) => {
      const before = r.status;
      r.status = diff[i].status; r.oldValue = diff[i].oldValue;
      if (before == null || before !== r.status) r.on = r.status === 'new' && !r.conflictWith;
    });
  }

  async function addMedia(media) {
    const blob = await dataURLtoBlob(media.dataURL);
    if (blob.size > 200 * 1024 * 1024 && !confirm(`This file is ${(blob.size / 1048576).toFixed(0)} MB. Save it anyway?`)) return;
    const id = await DB.sha256(blob);
    st.blobs.set(id, { blob, name: media.name });
    if (!st.captureTime) st.captureTime = C.utcStamp(new Date());
    let rec = st.recs.length === 1 ? st.recs[0] : st.recs.find((r) => r.mediaOnly);
    if (!rec && st.recs.length > 1) {
      const choice = await modal((f) => {
        f.append(h('b', {}, 'Which patient is this media for?'));
        const sel = h('select', { name: 'p' }, st.recs.map((r, i) => h('option', { value: i }, r.hints.name || r.pid || `Record ${i + 1}`)));
        f.append(sel, h('div', { class: 'btns' }, h('button', { value: '' }, 'Cancel'), h('button', { class: 'primary', value: 'ok', onclick: () => { f.dataset.sel = sel.value; } }, 'Add')));
      });
      if (choice !== 'ok') return;
      rec = st.recs[+$('#dlgForm').dataset.sel];
    }
    if (!rec) { rec = { hints: {}, skipped: [], rows: [], pid: '', identity: { reason: 'unknown', suggestions: [] }, mediaOnly: true }; st.recs.push(rec); }
    rec.rows.push({ key: `m.${rec.rows.length}`, label: MEDIA_LABEL[media.kind] || 'Attachment', value: id, time: st.captureTime, source: st.source, rawLabel: media.name, on: true, status: 'new', media: true });
    status(`${MEDIA_LABEL[media.kind] || 'File'} added (${(blob.size / 1024).toFixed(0)} KB). Choose the patient and Save.`);
    render();
  }

  /**
   * A taught field (Teach in Capture, Teach field in Fill) → a template field. Both modes save it the same way:
   * one field per label and one label per element, the nearby label text learned as an alias, and the field is
   * then used by both Capture and Fill.
   */
  async function saveTaught(field, use) {
    const what = field.kind === 'group' ? `the tick boxes “${field.anchor || ''}”` : `“${(field.anchor || field.value || 'this field').slice(0, 40)}”`;
    const shown = field.value ? ` (now: ${field.value.slice(0, 40)})` : '';
    const known = [...(st.fill ? Object.keys(st.fill.data) : []), ...st.recs.flatMap((r) => (r.rows || []).map((x) => x.label))];
    const label = await chooseLabel(`Label for ${what}${shown}`, field.anchor, known);
    if (!label) return '';
    const all = await DB.getTemplates();
    const fp = field.framePath || null;
    let t = all.find((x) => x.direction === use && x.origin === st.source && x.path === st.path && (x.framePath || null) === fp);
    if (!t) { t = { id: 'tpl-' + Date.now(), origin: st.source, path: st.path, framePath: fp, direction: use, fields: [] }; all.push(t); }
    const { value, framePath, ...keep } = field;
    t.fields = t.fields.filter((f) => f.label !== label && f.selector !== field.selector).concat([{ ...keep, context: field.context || [], tag: field.tag || null, label }]);
    await DB.saveTemplates(all);
    if (field.anchor) await DB.learnAlias(field.anchor, label, { source: use });
    return label;
  }
  async function onTaught(field) {
    const label = await saveTaught(field, 'extract');
    if (!label) return status('Cancelled.');
    status(`Taught: ${field.anchor || 'this field'} → ${label} (used by Capture and Fill). Scanning again…`);
    const results = await call(st.tab.id, 'scan', [await extractCtx()]);
    await buildPreview(results);
  }

  /** Dialog: pick a vocabulary label or type a custom one. */
  async function chooseLabel(title, suggestion, extra = []) {
    const labels = [...new Set([...extra, ...vocabLabels()])];
    const r = C.resolveLabel(suggestion || '');
    let chosen = '';
    const res = await modal((f) => {
      const sel = h('select', {}, h('option', { value: '' }, '— choose —'), labels.map((l) => h('option', { value: l, selected: r && r.label === l }, l)));
      const txt = h('input', { placeholder: 'or type your own label', value: '' });
      f.append(h('b', {}, title), sel, txt,
        h('div', { class: 'btns' }, h('button', { value: '' }, 'Cancel'), h('button', { class: 'primary', value: 'ok', onclick: () => { chosen = txt.value.trim() || sel.value; } }, 'OK')));
    });
    return res === 'ok' ? chosen : '';
  }

  // ── preview rendering ────────────────────────────────────────────────
  const statusBadge = (r) => {
    if (r.conflictWith) return h('span', { class: 'badge warn', title: `This page shows two values for ${r.label}; the other is “${r.conflictWith}”.` }, 'two values');
    if (r.status === 'duplicate') return h('span', { class: 'badge dup' }, 'already saved');
    if (r.status === 'changed') return h('span', { class: 'badge chg', title: 'Stored value: ' + r.oldValue }, `${r.oldValue} → new`);
    if (r.warn) return h('span', { class: 'badge warn', title: r.warn }, r.warn.replace(/_/g, ' '));
    if (r.unmapped) return h('span', { class: 'badge map' }, 'unmapped');
    if (r.how === 'ai') return h('span', { class: 'badge vio' }, 'AI');
    if (r.how === 'alias' || r.how === 'site-alias') return h('span', { class: 'badge vio', title: 'Mapped by a label you taught earlier' }, 'learned');
    if (r.how === 'template') return h('span', { class: 'badge vio' }, 'template');
    return h('span', { class: 'badge new' }, 'new');
  };

  // ── list search and page highlights ──────────────────────────────────
  const normQ = (s) => String(s == null ? '' : s).toLowerCase().replace(/[\s:：]/g, '');
  const hits = (q, ...texts) => !q || texts.some((t) => normQ(t).includes(q));
  const rowHit = (r) => hits(ui.q.cap, r.label, r.rawLabel, r.value);
  const propHit = (p) => hits(ui.q.fill, p.rawLabel, p.label, p.display, p.edit);
  const clearMarks = () => { if (st.tab) chrome.scripting.executeScript({ target: { tabId: st.tab.id, allFrames: true }, func: () => window.__pdbAgent && window.__pdbAgent.clearOverlay() }).catch(() => {}); };
  function showMarks() {
    for (const w of ['cap', 'fill']) { const b = $(`#${w}Marks`); b.textContent = `Highlights: ${ui.marks ? 'on' : 'off'}`; b.classList.toggle('off', !ui.marks); }
  }
  function toggleMarks() {
    ui.marks = !ui.marks;
    pref.set('pdb.marks', ui.marks ? 'on' : 'off');
    showMarks();
    if (!ui.marks) return clearMarks();
    if ($('#tab-fill').classList.contains('on')) paintFill(); else paintOverlay();
  }
  $('#capMarks').onclick = toggleMarks;
  $('#fillMarks').onclick = toggleMarks;
  $('#capSearch').oninput = () => { ui.q.cap = normQ($('#capSearch').value); render(); paintOverlay(); };
  $('#fillSearch').oninput = () => { ui.q.fill = normQ($('#fillSearch').value); renderFill(); };
  showMarks();

  function render() {
    const box = $('#records');
    box.textContent = '';
    // regions (tables / field groups) — untick to leave a region out
    const reg = $('#regions');
    reg.textContent = '';
    if (st.regions.length > 1) {
      reg.className = 'regions';
      st.regions.forEach((g, i) => {
        const cb = h('input', { type: 'checkbox', checked: g.on !== false, onchange: () => { g.on = cb.checked; toggleRegion(g); } });
        reg.append(h('label', { onmouseenter: () => focusRef(g.ref) }, cb, ` ${g.kind === 'list' ? 'List' : g.kind === 'chart' ? 'Chart' : 'Table'} ${i + 1} · ${g.items}`));
      });
    }
    if (st.broken.length) box.append(h('p', { class: 'status err' }, `Template fields not found on this page: ${st.broken.map((b) => b.label).join(', ')}. Use Teach to re-teach them.`));
    const patients = h('datalist', { id: 'knownPatients' });
    DB.patients().then((ps) => ps.forEach((p) => patients.append(h('option', { value: p.patientId }, p.name))));
    box.append(patients);

    let total = 0, matched = 0;
    st.recs.forEach((rec, ri) => {
      const pid = h('input', { class: 'pid', value: rec.pid, placeholder: 'patient ID (e.g. national ID)', list: 'knownPatients',
        onchange: async () => { rec.pid = pid.value.trim(); await refreshStatus(rec); render(); paintOverlay(); } });
      const who = [rec.hints.name, rec.hints.bed && `bed ${rec.hints.bed}`, rec.hints.mrn && `MRN ${rec.hints.mrn}`].filter(Boolean).join(' · ') || (rec.mediaOnly ? 'Media' : 'No name on page');
      const head = h('div', { class: 'rec-h' },
        h('div', { class: 'idrow' }, h('b', {}, who), rec.identity.patientId ? h('span', { class: 'badge new' }, `matched by ${rec.identity.reason}`) : h('span', { class: 'badge map' }, rec.pid ? 'entered' : 'needs patient ID')),
        h('div', { class: 'idrow' }, 'Patient ID ', pid),
        rec.identity.suggestions && rec.identity.suggestions.length && !rec.pid
          ? h('div', { class: 'idrow small' }, 'Suggestions: ', rec.identity.suggestions.map((s) => h('button', { class: 'link', onclick: async () => { rec.pid = s.patientId; await refreshStatus(rec); render(); paintOverlay(); } }, `${s.patientId} (${s.reason})`)))
          : null);
      const tbody = h('tbody');
      const shown = rec.rows.filter(rowHit);
      total += rec.rows.length; matched += shown.length;
      if (ui.q.cap && !shown.length) return;
      for (const r of shown) tbody.append(rowEl(rec, r));
      // with a search, the header box ticks / unticks only the rows shown
      const all = h('input', { type: 'checkbox', checked: shown.every((r) => r.on), onchange: () => { shown.forEach((r) => { r.on = all.checked; }); render(); paintOverlay(); } });
      const tbl = h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, all), h('th', {}, 'Label'), h('th', {}, 'Value'), h('th', {}, 'Time'), h('th', {}, ''))), tbody);
      const sk = rec.skipped.length ? h('div', { class: 'skipped' }, `Skipped (${rec.skipped.length}): `, rec.skipped.map((s) => `${s.label} – ${s.reason}`).join('; ')) : null;
      box.append(h('div', { class: 'rec', 'data-rec': ri }, head, tbl, sk));
    });
    $('#saveBar').hidden = !st.recs.length;
    $('#capTools').hidden = !st.recs.length;
    $('#capCount').textContent = ui.q.cap ? `${matched} of ${total}` : `${total} rows`;
    if (ui.q.cap && !matched) box.append(h('p', { class: 'status' }, 'No field or value matches the search.'));
  }

  function rowEl(rec, r) {
    const cb = h('input', { type: 'checkbox', checked: r.on, onchange: () => { r.on = cb.checked; tr.classList.toggle('off', !r.on); paintOverlay(); } });
    const val = r.media ? h('span', { class: 'mono' }, r.value.slice(0, 16) + '…')
      : h('input', { value: r.value, onchange: () => { r.value = val.value; refreshStatus(rec).then(() => { tr.replaceWith(rowEl(rec, r)); }); } });
    let labelCell;
    const makeSelect = () => {
      const opts = [h('option', { value: r.label }, r.label)];
      if (r.rawLabel && r.rawLabel !== r.label) opts.push(h('option', { value: '__raw__' }, `keep “${C.cleanLabel(r.rawLabel)}”`));
      for (const l of vocabLabels()) if (l !== r.label) opts.push(h('option', { value: l }, l));
      opts.push(h('option', { value: '__ignore__' }, 'Ignore on this site'));
      const sel = h('select', {}, opts);
      sel.onchange = async () => {
        if (sel.value === '__ignore__') { r.ignore = true; r.on = false; }
        else if (sel.value === '__raw__') { r.label = C.cleanLabel(r.rawLabel); r.userLabel = null; }
        else { r.userLabel = sel.value; r.label = sel.value; r.unmapped = false; }
        await refreshStatus(rec);
        tr.replaceWith(rowEl(rec, r)); paintOverlay();
      };
      return sel;
    };
    if (r.unmapped && !r.media) labelCell = makeSelect();
    else labelCell = h('span', { title: r.rawLabel && r.rawLabel !== r.label ? `on page: ${r.rawLabel}` : '', ondblclick: () => { labelCell.replaceWith(makeSelect()); } }, r.label);
    const tr = h('tr', { class: r.on ? '' : 'off', 'data-key': r.key, 'data-ref': r.ref || '', onmouseenter: () => r.ref && focusRef(r.ref) },
      h('td', {}, cb), h('td', { class: 'l' }, labelCell), h('td', { class: 'v' }, val), h('td', { class: 'small mut' }, C.displayTime(r.time)), h('td', {}, statusBadge(r)));
    return tr;
  }

  function toggleRegion(g) {
    // rows read from this region's table
    for (const rec of st.recs) for (const r of rec.rows) if (r.ref && r.regionRef === g.ref) r.on = g.on !== false;
    render(); paintOverlay();
  }

  // ── overlay on the page ──────────────────────────────────────────────
  function paintOverlay() {
    if (!st.tab) return;
    if (!ui.marks) return clearMarks();
    const byFrame = new Map();
    const add = (ref, m) => { const { frameId, ref: r } = splitRef(ref); if (!byFrame.has(frameId)) byFrame.set(frameId, []); byFrame.get(frameId).push({ ...m, ref: r }); };
    // with a search, only the matching rows are outlined
    if (!ui.q.cap) for (const g of st.regions) add(g.ref, { kind: g.on === false ? 'off' : 'chart', text: `${g.kind} · ${g.items}`, key: g.ref });
    for (const rec of st.recs) for (const r of rec.rows) {
      if (!r.ref || !rowHit(r)) continue;
      const kind = !r.on ? 'off' : r.warn ? 'warn' : r.unmapped ? 'unmapped' : 'mapped';
      add(r.ref, { kind, text: r.unmapped ? `? ${C.cleanLabel(r.rawLabel)}` : `${r.label} ✓`, key: r.key, title: `${r.label}: ${r.value}` });
    }
    chrome.scripting.executeScript({ target: { tabId: st.tab.id, allFrames: true }, func: () => window.__pdbAgent && window.__pdbAgent.clearOverlay() }).then(() => {
      for (const [frameId, marks] of byFrame) call(st.tab.id, 'setMarks', [marks], [frameId]).catch(() => {});
    }).catch(() => {});
  }
  function focusRef(ref) { if (!st.tab || !ref) return; const { frameId, ref: r } = splitRef(ref); call(st.tab.id, 'focusMark', [r], [frameId]).catch(() => {}); }
  function focusRow(ref) {
    const tr = $(`tr[data-ref="${CSS.escape(ref)}"]`);
    if (tr) { tr.scrollIntoView({ block: 'center', behavior: 'smooth' }); tr.style.outline = '2px solid #ff3d7f'; setTimeout(() => { tr.style.outline = ''; }, 1500); }
  }

  function resetCapture(msg) {
    st.recs = []; st.regions = []; st.blobs.clear(); st.broken = [];
    render();
    if (st.tab) chrome.scripting.executeScript({ target: { tabId: st.tab.id, allFrames: true }, func: () => window.__pdbAgent && window.__pdbAgent.clearOverlay() }).catch(() => {});
    if (msg) status(msg);
  }

  async function save() {
    const out = [];
    for (const rec of st.recs) {
      const chosen = rec.rows.filter((r) => r.on);
      if (!chosen.length) continue;
      const pid = rec.pid.trim();
      if (!pid) throw new Error(`Enter a patient ID for “${rec.hints.name || 'unnamed record'}” (or untick its rows).`);
      for (const r of chosen) out.push({ patientId: pid, label: r.label, value: r.value, time: r.time, source: r.source });
    }
    // learned mappings (shared by extract and fill)
    const global = $('#rememberGlobal').checked;
    for (const rec of st.recs) for (const r of rec.rows) {
      if (r.ignore) await DB.learnAlias(r.rawLabel, '__ignore__', { site: st.source, source: 'extract' });
      else if (r.userLabel && r.rawLabel) await DB.learnAlias(r.rawLabel, r.userLabel, { site: global ? null : st.source, source: r.how === 'ai' ? 'ai' : 'extract' });
    }
    if (!out.length) return status('Nothing ticked to save.', true);
    for (const r of out) if (st.blobs.has(r.value)) { const b = st.blobs.get(r.value); await DB.putBlob(b.blob, { name: b.name }); }
    await DB.putRows(out);
    const pts = new Set(out.map((r) => r.patientId)).size;
    resetCapture();
    status(`Saved ${out.length} values for ${pts} patient${pts > 1 ? 's' : ''}.`);
  }

  // ── fill ─────────────────────────────────────────────────────────────
  async function loadPatients() {
    const sel = $('#fillPatient');
    const cur = sel.value;
    const ps = await DB.patients();
    sel.textContent = '';
    if (!ps.length) sel.append(h('option', { value: '' }, 'No patients saved yet'));
    for (const p of ps) sel.append(h('option', { value: p.patientId, selected: p.patientId === cur }, `${p.name || '(no name)'} · ${p.patientId}`));
    await loadTimes();
  }
  $('#fillPatient').onchange = () => loadTimes();
  async function loadTimes() {
    const pid = $('#fillPatient').value;
    const sel = $('#fillTime');
    sel.textContent = '';
    sel.append(h('option', { value: '' }, 'latest of each'));
    if (!pid) return;
    const rows = await DB.rowsByPatient(pid);
    const counts = {};
    for (const r of rows) if (r.time !== 'nan' && r.label !== 'Medication') counts[r.time] = (counts[r.time] || 0) + 1;
    Object.keys(counts).sort().reverse().slice(0, 60).forEach((t) => sel.append(h('option', { value: t }, `${C.displayTime(t)} (${counts[t]})`)));
  }

  $('#fillScan').onclick = () => runF(async () => {
    const pid = $('#fillPatient').value;
    if (!pid) throw new Error('Choose a patient first.');
    const tab = await activeTab();
    st.tab = tab; st.source = sourceOf(tab.url);
    try { st.path = new URL(tab.url).pathname; } catch (e) { st.path = ''; }
    await inject(tab.id);
    const rows = await DB.rowsByPatient(pid);
    const fillData = fillDataFrom(rows, $('#fillTime').value || null);
    const vocab = await DB.getVocab();
    const templates = templatesFor(await DB.getTemplates(), 'fill');
    const res = await call(tab.id, 'fillScan', [fillData, { vocab, origin: st.source, templates }]);
    const props = [];
    for (const { frameId, result } of res) for (const p of result) props.push({ ...p, frameId, on: p.matched && (!p.hasValue || $('#fillOverwrite').checked) });
    st.fill = { pid, props, data: fillData };
    renderFill();
    const m = props.filter((p) => p.matched).length;
    fstatus(props.length ? `${props.length} form fields · ${m} can be filled. Check the values, then Fill.` : 'No form fields found on this page.', !props.length);
  });
  async function runF(fn) { try { await fn(); } catch (e) { console.error(e); fstatus(String(e.message || e), true); } }
  // same rule as PDB.fill.dataFromRows (that file runs in the page)
  function fillDataFrom(rows, at) {
    const data = {}, best = {};
    for (const r of rows) {
      if (r.label === 'Medication') continue;
      if (r.time === 'nan') { if (data[r.label] == null) data[r.label] = r.value; continue; }
      if (at && r.time > at && r.time.slice(0, 8) > at.slice(0, 8)) continue;
      if (!best[r.label] || r.time > best[r.label].time) best[r.label] = r;
    }
    for (const [l, r] of Object.entries(best)) if (data[l] == null) data[l] = r.value;
    return data;
  }

  function renderFill() {
    const box = $('#fillList');
    box.textContent = '';
    if (!st.fill) return;
    const tb = h('tbody');
    const shown = st.fill.props.filter(propHit);
    for (const p of shown) {
      const cb = h('input', { type: 'checkbox', checked: p.on, disabled: !p.matched, onchange: () => { p.on = cb.checked; paintFill(); } });
      const val = p.matched && p.kind === 'text' ? h('input', { value: p.display, onchange: () => { p.edit = val.value; } }) : h('span', {}, p.display || '');
      const note = !p.label ? h('button', { class: 'link', title: 'Teach which stored value goes here', onclick: () => teachFillFor(p) }, '? map')
        : p.noData ? h('span', { class: 'badge dup' }, 'no stored value')
        : p.unmatchedOption ? h('span', { class: 'badge warn', title: 'No option matches ' + p.unmatchedOption }, 'no matching option')
        : p.hasValue ? h('span', { class: 'badge dup', title: 'Current: ' + p.current }, 'has value')
        : h('span', { class: 'badge new' }, p.how === 'template' ? 'template' : p.how === 'alias' ? 'learned' : 'match');
      tb.append(h('tr', { onmouseenter: () => call(st.tab.id, 'focusMark', [p.ref], [p.frameId]).catch(() => {}) },
        h('td', {}, cb), h('td', { class: 'small' }, p.rawLabel || '(no label)', p.label ? h('div', { class: 'mut small' }, '→ ' + p.label) : null), h('td', { class: 'v' }, val), h('td', {}, note)));
    }
    if (shown.length) box.append(h('div', { class: 'rec' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Form field'), h('th', {}, 'Will write'), h('th', {}, ''))), tb)));
    else box.append(h('p', { class: 'status' }, 'No form field or value matches the search.'));
    $('#fillBar').hidden = false;
    $('#fillTools').hidden = false;
    $('#fillCount').textContent = ui.q.fill ? `${shown.length} of ${st.fill.props.length}` : `${st.fill.props.length} fields`;
    paintFill();
  }
  function paintFill() {
    if (!st.fill) return;
    if (!ui.marks) return clearMarks();
    const byFrame = new Map();
    for (const p of st.fill.props) {
      if (!byFrame.has(p.frameId)) byFrame.set(p.frameId, []);
      if (!propHit(p)) continue; // with a search, only the matching fields are outlined
      const kind = p.on ? 'fill' : p.hasValue && p.matched ? 'keep' : 'off';
      const text = p.on ? `⟵ ${p.edit ?? p.display}` : p.hasValue && p.matched ? '⊘ keep' : !p.label ? '? no match' : p.noData ? '– no data' : '';
      byFrame.get(p.frameId).push({ ref: p.ref, kind, text });
    }
    for (const [f, marks] of byFrame) call(st.tab.id, 'setMarks', [marks], [f]).catch(() => {});
  }
  $('#fillOverwrite').onchange = () => { if (!st.fill) return; for (const p of st.fill.props) if (p.matched && p.hasValue) p.on = $('#fillOverwrite').checked; renderFill(); };
  $('#fillApply').onclick = () => runF(async () => {
    if (!st.fill) return;
    const byFrame = new Map();
    for (const p of st.fill.props) if (p.on) {
      if (!byFrame.has(p.frameId)) byFrame.set(p.frameId, { ids: [], edits: {} });
      const b = byFrame.get(p.frameId);
      b.ids.push(p.id);
      if (p.edit != null) b.edits[p.id] = p.edit;
    }
    let n = 0;
    for (const [f, b] of byFrame) { const r = await call(st.tab.id, 'fillApply', [b.ids, b.edits], [f]); n += (r[0] && r[0].result.count) || 0; }
    const filled = new Set(st.fill.props.filter((p) => p.on).map((p) => p.id));
    if (ui.marks) for (const [f] of byFrame) call(st.tab.id, 'setMarks', [st.fill.props.filter((p) => p.frameId === f && filled.has(p.id)).map((p) => ({ ref: p.ref, kind: 'filled', text: '✓ filled' }))], [f]).catch(() => {});
    $('#fillUndo').disabled = false;
    fstatus(`Filled ${n} fields. Check the form and submit it yourself (Personal DB never submits).`);
  });
  $('#fillUndo').onclick = () => runF(async () => {
    await call(st.tab.id, 'fillUndo');
    $('#fillUndo').disabled = true;
    paintFill();
    fstatus('Undone: the previous values are back.');
  });
  $('#fillTeach').onclick = () => runF(async () => {
    const tab = await activeTab();
    st.tab = tab; st.source = sourceOf(tab.url);
    try { st.path = new URL(tab.url).pathname; } catch (e) { st.path = ''; }
    await inject(tab.id);
    await call(tab.id, 'startPick', ['fill', {}]);
    fstatus('Click a form field or a tick box, then choose its label (Esc cancels).');
  });
  async function teachFillFor(p) {
    const label = await chooseLabel(`Which stored value goes into “${p.rawLabel || 'this field'}”?`, p.rawLabel, st.fill ? Object.keys(st.fill.data) : []);
    if (!label) return;
    if (p.rawLabel) await DB.learnAlias(p.rawLabel, label, { source: 'fill' });
    fstatus(`Learned: “${p.rawLabel}” → ${label}. Scan form again to use it.`);
    $('#fillScan').click();
  }
  async function onFillTaught(field) {
    const label = await saveTaught(field, 'fill');
    if (!label) return fstatus('Cancelled.');
    fstatus(`Taught: ${field.anchor || 'this field'} → ${label} (used by Fill and Capture).`);
    if ($('#fillPatient').value) $('#fillScan').click();
  }
  $('#copyText').onclick = () => runF(async () => {
    const pid = $('#fillPatient').value;
    if (!pid) throw new Error('Choose a patient first.');
    const data = fillDataFrom(await DB.rowsByPatient(pid), $('#fillTime').value || null);
    const text = Object.entries(data).filter(([l, v]) => !/^sha256:/.test(v)).map(([l, v]) => `${l}: ${v}`).join('\n');
    await navigator.clipboard.writeText(text);
    fstatus('Copied to the clipboard.');
  });

  // first open
  DB.getSettings().then((s) => { $('#ai').disabled = !(s.ai && s.ai.enabled && s.ai.apiKey); $('#ai').title = $('#ai').disabled ? 'Turn on AI extract in Dashboard → Settings (needs your own API key)' : $('#ai').title; });
})();
