/* Dashboard: patients, trends, media, import (with preview), export, mappings, settings & backup. */
(() => {
  const { h, $, $$, modal, download, vocabLabels } = UI;
  const C = PDB.core, DB = PDB.db, X = PDB.export;
  const MEDIA = X.MEDIA_LABELS;

  // ── navigation ───────────────────────────────────────────────────────
  function show(view) {
    $$('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
    $$('.view').forEach((v) => v.classList.toggle('on', v.id === 'v-' + view));
    ({ patients: renderPatients, export: renderExport, mappings: renderMappings, settings: renderSettings }[view] || (() => {}))();
    history.replaceState(null, '', '#' + view);
  }
  $$('.nav button').forEach((b) => (b.onclick = () => show(b.dataset.view)));
  async function usage() {
    if (!navigator.storage || !navigator.storage.estimate) return;
    const e = await navigator.storage.estimate();
    $('#usage').textContent = `Storage used: ${(e.usage / 1048576).toFixed(1)} MB`;
  }

  // ── patients ─────────────────────────────────────────────────────────
  let current = null;
  async function renderPatients() {
    const ps = await DB.patients();
    const q = $('#q').value.trim().toLowerCase();
    const list = ps.filter((p) => !q || p.patientId.toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q));
    const box = $('#plist');
    box.textContent = '';
    if (!ps.length) { box.append(h('p', { class: 'mut' }, 'No data yet. Capture a page with the side panel, or import a file.')); $('#pview').textContent = ''; return; }
    const tb = h('tbody');
    for (const p of list) {
      tb.append(h('tr', { class: p.patientId === current ? 'sel' : '', onclick: () => { current = p.patientId; renderPatients(); } },
        h('td', {}, p.name || h('span', { class: 'mut' }, '(no name)')), h('td', { class: 'mono' }, p.patientId), h('td', {}, p.count), h('td', { class: 'mut' }, C.displayTime(p.last)), h('td', { class: 'mut small' }, p.sources.join(', '))));
    }
    box.append(h('div', { class: 'scroll', style: 'max-height:240px' }, h('table', { class: 'plist' }, h('thead', {}, h('tr', {}, ['Name', 'Patient ID', 'Values', 'Latest', 'Sources'].map((x) => h('th', {}, x)))), tb)));
    if (current && ps.some((p) => p.patientId === current)) await renderPatient(current); else $('#pview').textContent = '';
    usage();
  }
  $('#q').oninput = () => renderPatients();

  async function renderPatient(pid) {
    const rows = (await DB.rowsByPatient(pid)).sort((a, b) => (b.time === 'nan' ? '9' : b.time).localeCompare(a.time === 'nan' ? '9' : a.time));
    const view = $('#pview');
    view.textContent = '';
    // persistent fields (conflicting values from different sources are all shown; common fields can be edited)
    const persist = {};
    for (const r of rows.filter((x) => x.time === 'nan')) (persist[r.label] = persist[r.label] || []).push(r);
    const kv = h('div', { class: 'kv' });
    for (const [l, rs] of Object.entries(persist)) {
      const vals = [...new Set(rs.map((r) => r.value))];
      const per = rs.map((r) => h('span', { class: 'pv' }, r.value, historyBadge(r), C.isCommon(r.label) ? editButton(r) : null));
      kv.append(h('div', { class: 'k' }, l), h('div', {}, per.flatMap((x, i) => (i ? [' · ', x] : [x])),
        vals.length > 1 ? h('span', { class: 'badge warn', title: rs.map((r) => `${r.value} (${r.source}${r.page ? ' ' + r.page : ''})`).join('\n') }, rs.some((a) => rs.some((b) => a.source !== b.source && a.value !== b.value)) ? ' differs by source' : ' differs by page') : null,
        l === 'MRN' ? h('span', { class: 'mut small' }, `  ${rs.map((r) => r.source).join(', ')}`) : null));
    }
    view.append(h('div', { class: 'card' },
      h('div', { class: 'row', style: 'justify-content:space-between' }, h('h3', { style: 'margin:0' }, (persist.Name && persist.Name[0].value) || pid, h('span', { class: 'mut mono small' }, '  ' + pid)),
        h('div', {}, h('button', { onclick: () => mergeDialog(pid) }, 'Merge into…'), ' ', h('button', { onclick: () => exportRows(rows, 'csv', true) }, 'Export CSV'), ' ', h('button', { onclick: () => exportRows(rows, 'fhir', true) }, 'Export FHIR'))),
      kv));
    // trends
    const timed = rows.filter((r) => r.time !== 'nan' && !MEDIA.has(r.label) && r.label !== 'Medication');
    const charts = h('div', { class: 'grid2' });
    const by = {};
    for (const r of timed) (by[r.label] = by[r.label] || []).push(r);
    for (const [label, rs] of Object.entries(by)) {
      const pts = rs.map((r) => ({ t: C.timeToDate(r.time), v: r.value, dateOnly: r.time.length === 8 })).sort((a, b) => a.t - b.t);
      // a label that is (or contains) a known one, e.g. "血壓 BP" → Blood pressure
      const known = [label, ...label.split(/[\s()（）\[\]【】,，:：]+/)].map((x) => x && C.resolveLabel(x)).find(Boolean);
      const entry = PDB.schema.byLabel[label] || (known && PDB.schema.byLabel[known.label]) || (label.startsWith('Blood glucose') ? PDB.schema.byKey.glucose : null);
      const isBP = entry && entry.type === 'bp';
      // readings with several numbers ("149/71") become one line per number on the same chart
      const parts = pts.map((p) => C.numParts(p.v));
      const n = isBP ? 2 : parts[0] ? parts[0].length : 0;
      const ok = pts.map((p, j) => ({ p, v: parts[j] })).filter((x) => x.v && x.v.length === n);
      if (!n || n > 4 || ok.length < 2 || (!isBP && ok.length !== pts.length)) continue; // BP tolerates stray text; others must all be numeric
      const sub = label.split(/\s*[\/／]\s*/); // e.g. "收縮壓/舒張壓"
      const names = isBP ? ['Systolic', 'Diastolic'] : n === 1 ? [label] : sub.length === n ? sub : Array.from({ length: n }, (_, k) => `Value ${k + 1}`);
      const series = names.map((name, k) => ({ name, points: ok.map(({ p, v }) => ({ ...p, v: v[k] })) }));
      Chart.trend(charts, { title: label, unit: entry ? entry.unit : '', series });
    }
    if (charts.children.length) view.append(h('h3', {}, 'Trends'), charts);
    // medications
    const meds = rows.filter((r) => r.label === 'Medication');
    if (meds.length) view.append(h('h3', {}, `Medications (${meds.length})`), h('div', { class: 'scroll', style: 'max-height:220px' }, h('table', {}, h('tbody', {}, meds.map((r) => h('tr', {}, h('td', { class: 'mut small' }, C.displayTime(r.time)), h('td', {}, r.value), h('td', { class: 'mut small' }, r.source)))))));
    // media
    const media = rows.filter((r) => MEDIA.has(r.label) && X.isMediaRef(r.value));
    if (media.length) {
      const gal = h('div', { class: 'gallery' });
      view.append(h('h3', {}, `Media (${media.length})`), gal);
      for (const r of media) {
        const b = await DB.getBlob(r.value);
        if (!b) { gal.append(h('figure', {}, h('div', { class: 'mut small' }, 'missing file'), h('figcaption', {}, r.label))); continue; }
        const url = URL.createObjectURL(b.blob);
        const el = /^image\//.test(b.mime) ? h('img', { src: url, alt: r.label, onclick: () => window.open(url) })
          : /^audio\//.test(b.mime) ? h('audio', { src: url, controls: true, style: 'width:180px' })
          : /^video\//.test(b.mime) ? h('video', { src: url, controls: true, style: 'width:180px' })
          : h('a', { href: url, download: b.name || 'file' }, b.name || 'download');
        gal.append(h('figure', {}, el, h('figcaption', {}, `${r.label} · ${C.displayTime(r.time)} · ${(b.size / 1024).toFixed(0)} KB`)));
      }
    }
    // all rows (also the table view of the charts)
    const sel = new Set();
    const lf = h('select', { onchange: () => fill() }, h('option', { value: '' }, 'all labels'), [...new Set(rows.map((r) => r.label))].sort().map((l) => h('option', { value: l }, l)));
    const tb = h('tbody');
    const fill = () => {
      tb.textContent = '';
      for (const r of rows.filter((x) => !lf.value || x.label === lf.value)) {
        const k = C.rowKey(r);
        const cb = h('input', { type: 'checkbox', checked: sel.has(k), onchange: () => (cb.checked ? sel.add(k) : sel.delete(k)) });
        tb.append(h('tr', {}, h('td', {}, cb), h('td', {}, r.label),
          h('td', {}, X.isMediaRef(r.value) ? h('span', { class: 'mono' }, r.value.slice(0, 18) + '…') : r.value, historyBadge(r), C.isCommon(r.label) && !X.isMediaRef(r.value) ? editButton(r) : null),
          h('td', { class: 'mut small' }, r.time === 'nan' ? 'nan' : C.displayTime(r.time)), h('td', { class: 'mut small' }, r.source), h('td', { class: 'mut small mono' }, r.page || '')));
      }
    };
    fill();
    view.append(h('h3', {}, `All values (${rows.length})`),
      h('div', { class: 'row' }, lf, h('button', { class: 'danger', onclick: async () => {
        const del = rows.filter((r) => sel.has(C.rowKey(r)));
        if (!del.length || !confirm(`Delete ${del.length} values? This cannot be undone.`)) return;
        await DB.deleteRows(del); renderPatients();
      } }, 'Delete selected')),
      h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['', 'Label', 'Value', 'Time (local)', 'Source', 'Page'].map((x) => h('th', {}, x)))), tb)));
  }

  /** "differs by page" / "edited" badge for a row that replaced earlier values; the tooltip lists them in order. */
  function historyBadge(r) {
    const hist = (r.history || []).filter((e) => e.value !== r.value || (e.page || '') !== (r.page || ''));
    if (!hist.length && !r.edited) return null;
    const at = (e) => (e.page ? ` (${e.page})` : '');
    const lines = [...hist.map((e) => `${e.value}${at(e)}${e.replacedAt ? ' · replaced ' + C.displayTime(e.replacedAt) : ''}`), `→ ${r.value}${at(r)}${r.edited ? ' · edited ' + C.displayTime(r.edited) : ''}`];
    const pages = new Set([...hist.map((e) => e.page || ''), r.page || ''].filter(Boolean));
    const text = r.edited && !hist.some((e) => e.value !== r.value) ? ' edited' : pages.size > 1 ? ' differs by page' : ' changed';
    return h('span', { class: 'badge chg', title: lines.join('\n') }, text);
  }
  function editButton(r) {
    return h('button', { class: 'link small', title: 'Edit this value (the old value is kept in its history)', onclick: () => editDialog(r) }, '✎');
  }
  async function editDialog(row) {
    let value = null;
    const r = await modal((f) => {
      const inp = h('input', { value: row.value, style: 'width:100%' });
      f.append(h('b', {}, `Edit ${row.label}`), h('p', { class: 'small mut' }, `${row.source}${row.page ? ' · ' + row.page : ''}. The current value is kept in the history.`), inp,
        h('div', { class: 'btns' }, h('button', { value: '' }, 'Cancel'), h('button', { class: 'primary', value: 'ok', onclick: () => { value = inp.value.trim(); } }, 'Save')));
    });
    if (r !== 'ok' || value == null || value === row.value) return;
    await DB.editValue(row, value);
    renderPatients();
  }

  async function mergeDialog(from) {
    const ps = (await DB.patients()).filter((p) => p.patientId !== from);
    let to = '';
    const r = await modal((f) => {
      const sel = h('select', {}, ps.map((p) => h('option', { value: p.patientId }, `${p.name || '(no name)'} · ${p.patientId}`)));
      f.append(h('b', {}, `Merge all values of ${from} into another patient`), h('p', { class: 'small mut' }, 'Use this when the same person was saved under two IDs.'), sel,
        h('div', { class: 'btns' }, h('button', { value: '' }, 'Cancel'), h('button', { class: 'primary', value: 'ok', onclick: () => { to = sel.value; } }, 'Merge')));
    });
    if (r !== 'ok' || !to) return;
    const n = await DB.mergePatients(from, to);
    current = to;
    alert(`Moved ${n} values to ${to}.`);
    renderPatients();
  }

  // ── export ───────────────────────────────────────────────────────────
  async function renderExport() {
    const sel = $('#expWho');
    const ps = await DB.patients();
    sel.textContent = '';
    sel.append(h('option', { value: '' }, `All patients (${ps.length})`), ps.map((p) => h('option', { value: p.patientId }, `${p.name || '(no name)'} · ${p.patientId}`)));
  }
  $$('[data-exp]').forEach((b) => (b.onclick = async () => {
    const pid = $('#expWho').value;
    const rows = pid ? await DB.rowsByPatient(pid) : await DB.allRows();
    exportRows(rows, b.dataset.exp, $('#expMedia').checked);
  }));
  async function exportRows(rows, kind, withMedia) {
    const f = await X.exportFile(rows, kind, { getBlob: (id) => DB.getBlob(id), withMedia });
    download(f.name, f.blob);
  }

  // ── import ───────────────────────────────────────────────────────────
  const drop = $('#drop');
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); handleFiles([...e.dataTransfer.files]); };
  $('#file').onchange = (e) => handleFiles([...e.target.files]);

  async function handleFiles(files) {
    const box = $('#imp');
    box.textContent = '';
    for (const f of files) {
      try { await importOne(f, box); } catch (e) { box.append(h('div', { class: 'card bad' }, `${f.name}: ${e.message}`)); }
    }
  }

  async function importOne(file, box) {
    const r = await X.readImport(file);
    const card = h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, `Import: ${file.name}`));
    box.append(card);
    if (r.kind === 'rows') return previewRows(card, r.rows, r.media || []);
    if (r.kind === 'media') return previewMedia(card, r.media, file.name);
    if (r.kind === 'html') {
      const doc = new DOMParser().parseFromString(r.html, 'text/html');
      const ex = PDB.dom.extractFromRoot(doc, { vocab: await DB.getVocab(), origin: r.source });
      return previewRecords(card, C.mergeRecords(ex.records), r.source);
    }
    return previewGrid(card, r);
  }

  /** Already-unified rows (Personal DB / FHIR files). */
  async function previewRows(card, rows, media) {
    const existing = await DB.existingFor(rows);
    const diff = C.diffRows(rows, existing);
    const n = (s) => diff.filter((d) => d.status === s).length;
    const repl = h('input', { type: 'checkbox' });
    card.append(h('p', {}, `${new Set(rows.map((r) => r.patientId)).size} patients · ${rows.length} rows · ${n('new')} new · ${n('duplicate')} duplicates (skipped) · ${n('changed')} different from stored`, media.length ? ` · ${media.length} media files` : ''),
      n('changed') ? h('label', { class: 'small' }, repl, ' replace the stored values that differ') : null,
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: async () => {
        const take = diff.filter((d) => d.status === 'new' || (d.status === 'changed' && repl.checked));
        for (const m of media) await DB.putBlob(m.blob, { name: m.name });
        await DB.putRows(take);
        card.append(h('p', { class: 'ok' }, `Imported ${take.length} rows${media.length ? ` and ${media.length} media files` : ''}.`));
      } }, 'Import')));
  }

  async function previewMedia(card, media, name) {
    const ps = await DB.patients();
    const pid = h('input', { list: 'impPatients', placeholder: 'patient ID' });
    const dl = h('datalist', { id: 'impPatients' }, ps.map((p) => h('option', { value: p.patientId }, p.name)));
    card.append(h('p', {}, `${media.length} file(s). Attach to patient:`), h('div', { class: 'row' }, pid, dl,
      h('button', { class: 'primary', onclick: async () => {
        if (!pid.value.trim()) return alert('Enter a patient ID.');
        const now = C.utcStamp(new Date());
        const rows = [];
        for (const m of media) {
          const id = await DB.putBlob(m.blob, { name: m.name });
          const t = m.blob.type || '';
          rows.push({ patientId: pid.value.trim(), label: /^image/.test(t) ? 'Photo' : /^audio/.test(t) ? 'Audio' : /^video/.test(t) ? 'Video' : 'Attachment', value: id, time: now, source: 'file:' + m.name });
        }
        await DB.putRows(rows);
        card.append(h('p', { class: 'ok' }, `Saved ${rows.length} file(s).`));
      } }, 'Save')));
  }

  /** Spreadsheet / CSV with its own layout: choose sheet, header row and column labels, see the 5-field result live. */
  async function previewGrid(card, r) {
    const maps = await DB.get('importMappings', {});
    const sheetSel = h('select', {}, r.sheets.map((s, i) => h('option', { value: i }, `${s.name} (${s.rows.length} rows)`)));
    const headSel = h('select', {}, [0, 1, 2, 3, 4].map((i) => h('option', { value: i }, `row ${i + 1}`)));
    const fixedPid = h('input', { placeholder: 'patient ID for rows without one', list: 'impPatients' });
    const ps = await DB.patients();
    const out = h('div');
    const remember = h('input', { type: 'checkbox', checked: true });
    let labels = [];
    const recompute = async () => {
      const sheet = r.sheets[+sheetSel.value];
      const hr = +headSel.value;
      const rows = sheet.rows.slice(hr).map((x) => x.map((c) => String(c ?? '')));
      if (!rows.length) return;
      const header = rows[0];
      const sig = header.join('|');
      if (!labels.length || labels.length !== header.length) labels = (maps[sig] && maps[sig].labels) || header.map(() => '');
      // the grid analysed = header replaced by the chosen labels
      const grid = [header.map((x, i) => labels[i] === '__skip__' ? '' : labels[i] || x), ...rows.slice(1)];
      const res = C.analyzeTable(C.gridFromArrays(grid).map((row, i) => row.map((c) => ({ ...c, th: i === 0 }))), { vocab: await DB.getVocab(), origin: r.source });
      const recs = C.mergeRecords(res.records);
      out.textContent = '';
      // mapping table: first 20 rows
      const opts = (i) => h('select', { onchange: (e) => { labels[i] = e.target.value; recompute(); } },
        h('option', { value: '' }, `auto: ${C.resolveLabel(header[i])?.label || C.labelKind(header[i]) || 'keep'}`),
        h('option', { value: '__skip__', selected: labels[i] === '__skip__' }, 'skip column'),
        ['測量時間', ...vocabLabels()].map((l) => h('option', { value: l, selected: labels[i] === l }, l === '測量時間' ? 'Time (of the row)' : l)));
      out.append(h('div', { class: 'scroll', style: 'max-height:300px' }, h('table', { class: 'mapping' },
        h('thead', {}, h('tr', {}, header.map((c, i) => h('th', {}, h('div', {}, c), opts(i))))),
        h('tbody', {}, rows.slice(1, 21).map((row) => h('tr', {}, row.map((c) => h('td', { class: 'small' }, c))))))),
        h('p', { class: 'mut small' }, `Showing ${Math.min(20, rows.length - 1)} of ${rows.length - 1} rows. Layout detected: ${res.kind === 'list' ? 'one row per reading/patient' : res.kind === 'chart' ? 'vitals as rows, times as columns' : res.kind === 'kv' ? 'label/value pairs' : 'not recognised'}.`));
      await previewRecords(out, recs, r.source, fixedPid, async () => { if (remember.checked) { maps[sig] = { labels }; await DB.set('importMappings', maps); } });
    };
    sheetSel.onchange = () => { labels = []; recompute(); };
    headSel.onchange = () => { labels = []; recompute(); };
    fixedPid.onchange = recompute;
    card.append(h('div', { class: 'row' }, 'Sheet ', sheetSel, ' Header ', headSel, ' Patient ', fixedPid, h('datalist', { id: 'impPatients' }, ps.map((p) => h('option', { value: p.patientId }, p.name)))),
      h('label', { class: 'small' }, remember, ' remember this column mapping for files with the same columns'), out);
    recompute();
  }

  /** Records (from a sheet or an HTML file) → identity → 5-field rows → summary → import. */
  async function previewRecords(container, recs, source, fixedPidInput, onImport) {
    const ix = C.buildIdentityIndex(await DB.rowsByLabels(['MRN', 'Name', 'Birth date', 'Bed']));
    const now = C.utcStamp(new Date());
    const rows = [], unassigned = [];
    for (const rec of recs) {
      const id = C.resolveIdentity(rec.hints, source, ix);
      const pid = id.patientId || (fixedPidInput && fixedPidInput.value.trim()) || (id.suggestions[0] && id.suggestions[0].patientId) || '';
      const rr = C.recordToRows(rec, { source, captureTime: now }).map(({ _item, _conflictWith, _fids, ...x }) => ({ ...x, patientId: pid }));
      if (!pid) unassigned.push(rec); else rows.push(...rr);
    }
    const diff = C.diffRows(rows, await DB.existingFor(rows));
    const n = (s) => diff.filter((d) => d.status === s).length;
    const flagged = recs.reduce((a, r) => a + r.items.filter((i) => i.warn).length, 0);
    const sample = h('tbody', {}, diff.slice(0, 12).map((d) => h('tr', {}, h('td', { class: 'mono small' }, d.patientId), h('td', {}, d.label), h('td', {}, d.value), h('td', { class: 'small mut' }, d.time), h('td', {}, h('span', { class: 'badge ' + (d.status === 'new' ? 'new' : d.status === 'changed' ? 'chg' : 'dup') }, d.status)))));
    const repl = h('input', { type: 'checkbox' });
    container.append(
      h('p', {}, h('b', {}, `Result: ${new Set(rows.map((r) => r.patientId)).size} patients · ${rows.length} rows · ${flagged} flagged · ${n('duplicate')} duplicates (skipped) · ${n('changed')} different from stored`),
        unassigned.length ? h('span', { class: 'bad' }, ` · ${unassigned.length} record(s) need a patient ID (enter one above)`) : null),
      h('table', {}, h('thead', {}, h('tr', {}, ['patientId', 'label', 'value', 'time', ''].map((x) => h('th', {}, x)))), sample),
      n('changed') ? h('label', { class: 'small' }, repl, ' replace stored values that differ') : null,
      h('div', { class: 'row' }, h('button', { class: 'primary', disabled: !rows.length, onclick: async () => {
        const take = diff.filter((d) => d.status === 'new' || (d.status === 'changed' && repl.checked)).map(({ status, oldValue, ...x }) => x);
        await DB.putRows(take);
        if (onImport) await onImport();
        container.append(h('p', { class: 'ok' }, `Imported ${take.length} rows.`));
      } }, 'Import')));
  }

  // ── mappings ─────────────────────────────────────────────────────────
  const PT = PDB.pagetpl;
  const g_chrome = () => (globalThis.chrome || {});
  let openTpl = null; // id of the page template shown in detail
  async function renderMappings() {
    await renderPageTemplates();
    const v = await DB.getVocab();
    const box = $('#aliases');
    box.textContent = '';
    const entries = Object.entries(v.aliases);
    if (!entries.length) box.append(h('p', { class: 'mut' }, 'None yet. Map an unrecognised label in the side panel preview and it appears here.'));
    else box.append(h('table', {}, h('thead', {}, h('tr', {}, ['Page label', 'Maps to', 'Scope', 'Learned from', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, entries.map(([k, a]) => h('tr', {}, h('td', {}, k), h('td', {}, a.label === '__ignore__' ? h('i', {}, 'ignored') : a.label),
        h('td', {}, h('button', { class: 'link', title: 'Switch between all sites and one site', onclick: async () => {
          if (a.sites && a.sites.length) delete a.sites; else { const s = prompt('Pin to which site (origin)?', ''); if (!s) return; a.sites = [s]; }
          await DB.set('vocab', v); renderMappings();
        } }, a.sites && a.sites.length ? a.sites.join(', ') : 'all sites')),
        h('td', { class: 'mut' }, a.source || ''),
        h('td', {}, h('button', { class: 'link danger', onclick: async () => { delete v.aliases[k]; await DB.set('vocab', v); renderMappings(); } }, 'delete')))))));
    const t = await DB.getTemplates();
    const tb = $('#templates');
    tb.textContent = '';
    if (!t.length) tb.append(h('p', { class: 'mut' }, 'None yet. Use Teach in the side panel’s Fill tab for a form field it could not match.'));
    else tb.append(h('table', {}, h('thead', {}, h('tr', {}, ['Site', 'Page', 'Fields', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, t.map((x, i) => h('tr', {}, h('td', {}, x.origin), h('td', { class: 'mono small' }, x.framePath || x.path || '*'),
        h('td', { class: 'small' }, x.fields.map((f) => h('div', {}, `${f.anchor || '(no label text)'} → ${f.label}`))),
        h('td', {}, h('button', { class: 'link danger', onclick: async () => { t.splice(i, 1); await DB.saveTemplates(t); renderMappings(); } }, 'delete')))))));
  }

  async function renderPageTemplates(withDetail = true) {
    const list = await DB.getPageTemplates();
    const box = $('#ptList');
    box.textContent = '';
    if (!list.length) { box.append(h('p', { class: 'mut' }, 'None yet. Scan a page in the side panel and press Save: its template is saved with the data.')); $('#ptDetail').textContent = ''; return; }
    const count = (t) => t.fields.filter((f) => f.label !== PT.IGNORE && f.role !== 'time').length;
    box.append(h('table', { class: 'plist' }, h('thead', {}, h('tr', {}, ['Site', 'Page', 'Title', 'Fields', 'Tables', '', 'Updated', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map((t) => h('tr', { class: t.id === openTpl ? 'sel' : '', onclick: () => { openTpl = t.id; renderPageTemplates(); } },
        h('td', {}, t.origin), h('td', { class: 'mono small' }, t.framePath || '/'), h('td', { class: 'small' }, t.title || ''),
        h('td', {}, count(t)), h('td', {}, t.tables.length),
        h('td', {}, t.complete ? h('span', { class: 'badge new' }, 'full') : h('span', { class: 'badge map', title: 'An older template with taught fields only: completed the next time you save this page' }, 'taught fields only')),
        h('td', { class: 'small mut' }, t.updatedAt ? new Date(t.updatedAt).toLocaleString() : ''),
        h('td', {}, h('button', { class: 'link', title: 'Download this template checked against its saved sample page: where each field is found, or why not. No patient data: text kept from a record is shown only by its shape.', onclick: (e) => { e.stopPropagation(); exportCheck(t); } }, 'Export check'), ' ',
          h('button', { class: 'link danger', onclick: async (e) => {
          e.stopPropagation();
          if (!confirm(`Delete the template of ${t.origin}${t.framePath}? The page will get a new draft from the built-in rules next time.`)) return;
          await DB.deletePageTemplate(t.id); if (openTpl === t.id) openTpl = null; renderPageTemplates();
        } }, 'delete')))))));
    if (!withDetail) return;
    const t = list.find((x) => x.id === openTpl);
    if (t) await TplView.render($('#ptDetail'), t, { zoom: 'fit', onSaved: () => { ownSave = Date.now(); return renderPageTemplates(false); } });
    else $('#ptDetail').textContent = '';
  }
  /**
   * One template as a review file: checked against its masked sample page (values there are placeholders), so text the
   * template kept from a record comes out only as its shape. For a full copy (backup, another browser): Export mappings.
   */
  async function exportCheck(t) {
    const sample = await DB.getSample(t.id).catch(() => null);
    const doc = new DOMParser().parseFromString(sample ? sample.html : '<!doctype html><html><body></body></html>', 'text/html');
    const chk = PDB.tplcheck.check(doc, t, { origin: t.origin, page: { path: t.framePath || '', query: t.query || '' }, source: sample ? 'sample' : 'none' });
    if (!sample) chk.note = 'This template has no saved sample page: nothing could be found. Export check in the side panel, on the page itself, shows more.';
    const name = `template-check-${(t.framePath || 'page').replace(/[^\w*-]+/g, '_').replace(/\*/g, 'x').replace(/^_+|_+$/g, '') || 'page'}.json`;
    download(name, new Blob([JSON.stringify(chk, null, 1)], { type: 'application/json' }));
  }
  // a template changed in the side panel: show the new version
  let ownSave = 0;
  if (g_chrome().storage && chrome.storage.onChanged) chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.pageTemplates && Date.now() - ownSave > 1500 && $('#v-mappings').classList.contains('on')) renderPageTemplates();
  });

  $('#mapExport').onclick = async () => download('personal-db-mappings.json', new Blob([JSON.stringify({ format: 'personal-db-mappings', vocab: await DB.getVocab(), templates: await DB.getTemplates(),
    pageTemplates: await DB.getPageTemplates(), samples: await DB.allSamples() }, null, 1)], { type: 'application/json' }));
  $('#mapImport').onchange = async (e) => {
    const j = JSON.parse(await e.target.files[0].text());
    if (j.format !== 'personal-db-mappings') return alert('Not a Personal DB mappings file.');
    const v = await DB.getVocab();
    await DB.set('vocab', { aliases: { ...v.aliases, ...(j.vocab?.aliases || {}) } });
    const t = await DB.getTemplates(); const ids = new Set(t.map((x) => x.id));
    const incoming = j.templates || [];
    // older files: Capture templates become page templates (taught fields only)
    const old = incoming.filter((x) => (x.direction || 'extract') === 'extract');
    await DB.saveTemplates(t.concat(incoming.filter((x) => x.direction === 'fill' && !ids.has(x.id))));
    await PDB.backup.restoreMappings({ pageTemplates: (j.pageTemplates || []).concat(DB.migrateTemplates(old)), samples: j.samples || [] }, 'merge');
    renderMappings();
  };

  // ── settings & backup ────────────────────────────────────────────────
  async function renderSettings() {
    const s = await DB.getSettings();
    const b = s.backup;
    const card = $('#backupCard');
    card.textContent = '';
    const en = h('input', { type: 'checkbox', checked: b.enabled });
    const iv = h('select', {}, ['daily', 'weekly', 'monthly', 'manual'].map((x) => h('option', { value: x, selected: b.interval === x }, x)));
    const keep = h('input', { type: 'number', min: 2, max: 50, value: b.keep || 8, style: 'width:60px' });
    const hasPass = !!(await PDB.crypto.getPassphrase());
    const res = b.lastResult;
    const statusText = !res ? 'Never backed up.' : res.status === 'ok' ? `Last backup ${new Date(res.at).toLocaleString()} · ${res.rows} rows · ${res.uploadedBlobs} new media files` : res.status === 'needs-passphrase' ? 'Waiting: enter the backup passphrase (it is forgotten when the browser closes).' : `Last attempt failed: ${res.message}`;
    const clientIdSet = !/REPLACE_WITH/.test(chrome.runtime.getManifest().oauth2?.client_id || 'REPLACE_WITH');
    card.append(h('h3', { style: 'margin-top:0' }, 'Google Drive backup'),
      !clientIdSet ? h('p', { class: 'bad small' }, 'Setup needed: put your Google OAuth client ID into manifest.json (see README → Google Drive backup).') : null,
      h('p', { class: 'mut small' }, `Encrypted on this computer (AES-GCM, key from your passphrase) and uploaded to the Drive folder “${PDB.backup.FOLDER}”. A scheduled backup runs only when the interval has passed and your data changed. Media files are uploaded once.`),
      h('div', { class: 'row' }, h('label', {}, en, ' Enabled'), ' Interval ', iv, ' Keep ', keep, ' snapshots',
        h('button', { onclick: async () => { await DB.saveSettings({ backup: { ...b, enabled: en.checked, interval: iv.value, keep: +keep.value } }); renderSettings(); } }, 'Save')),
      h('div', { class: 'row' }, h('span', { class: hasPass ? 'ok' : 'bad' }, hasPass ? '🔑 Passphrase set for this browser session' : 'No passphrase in this session'),
        h('button', { onclick: setPassphrase }, hasPass ? 'Change passphrase' : 'Enter passphrase')),
      h('p', { class: res && res.status === 'ok' ? 'ok' : 'mut' }, statusText),
      h('div', { class: 'row' }, h('button', { class: 'primary', disabled: !clientIdSet, onclick: backupNow }, 'Back up now'), h('button', { disabled: !clientIdSet, onclick: restoreDialog }, 'Restore from Drive…')));
    // AI
    const ai = s.ai, pr = s.privacy;
    renderCommon();
    const aiCard = $('#aiCard');
    aiCard.textContent = '';
    const aiEn = h('input', { type: 'checkbox', checked: ai.enabled });
    const key = h('input', { type: 'password', value: ai.apiKey, placeholder: 'sk-ant-…', style: 'width:320px' });
    const curModel = DB.AI_MODELS.some((m) => m.id === ai.model) ? ai.model : DB.DEFAULT_AI_MODEL;
    const model = h('select', {}, DB.AI_MODELS.map((m) => h('option', { value: m.id, selected: m.id === curModel }, m.name)));
    const cats = h('div', { class: 'kv' });
    const catSel = {};
    for (const [l, pol] of Object.entries(pr.categories)) {
      catSel[l] = h('select', {}, ['mask', 'ask', 'send'].map((x) => h('option', { value: x, selected: pol === x }, x)));
      cats.append(h('div', { class: 'k' }, l), catSel[l]);
    }
    const terms = h('textarea', { rows: 3, style: 'width:100%', placeholder: 'One per line: staff names, facility name, anything else to always remove' }, (pr.customTerms || []).join('\n'));
    const log = await DB.get('aiAudit', []);
    aiCard.append(h('h3', { style: 'margin-top:0' }, 'AI extract (Claude) and privacy'),
      h('p', { class: 'mut small' }, 'Off by default. When on, the side panel can send a masked copy of a page to Anthropic with your own API key. Every run shows exactly what will be sent; identifiers left in the text block sending.'),
      h('div', { class: 'row' }, h('label', {}, aiEn, ' Enabled'), ' API key ', key),
      h('div', { class: 'row' }, ' Model ', model, h('span', { class: 'small mut' }, ' Used for AI extract and for reading pictures. Larger models read difficult pages better but cost more per run.')),
      h('p', { class: 'small' }, 'What to do with each kind of personal data before sending: mask = always replace; ask = you decide each time; send = leave as is.'), cats,
      h('p', { class: 'small' }, 'Custom terms to always mask'), terms,
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: async () => {
        const categories = {}; for (const [l, sel] of Object.entries(catSel)) categories[l] = sel.value;
        await DB.saveSettings({ ai: { ...ai, enabled: aiEn.checked, apiKey: key.value.trim(), model: model.value, modelChosen: true }, privacy: { ...pr, categories, customTerms: terms.value.split('\n').map((x) => x.trim()).filter(Boolean) } });
        renderSettings();
      } }, 'Save')),
      h('details', {}, h('summary', {}, `Audit log: what was sent (${log.length})`), log.map((e) => h('div', { class: 'card small' }, h('div', { class: 'mut' }, `${new Date(e.at).toLocaleString()} · ${e.source}`), h('pre', { class: 'mono', style: 'white-space:pre-wrap;max-height:200px;overflow:auto' }, e.text), e.image ? h('img', { src: e.image, style: 'max-width:300px' }) : null))));
  }
  /**
   * Common fields: labels that do not change with time or between pages of one system (Name, National ID, …). They keep
   * one value per patient and site; every other label keeps a separate value for each page it was read on.
   */
  async function renderCommon() {
    const card = $('#commonCard');
    card.textContent = '';
    const v = await DB.getVocab();
    const stored = (await DB.allRows()).map((r) => r.label);
    const learned = Object.values(v.aliases).map((a) => a.label).filter((l) => l && l !== '__ignore__');
    const labels = [...new Set([...vocabLabels(), ...learned, ...stored])].filter((l) => !MEDIA.has(l) && !C.isMulti(l));
    const on = new Set(C.commonLabels());
    const boxes = new Map();
    const list = h('div', { class: 'checks' }, labels.map((l) => {
      const cb = h('input', { type: 'checkbox', checked: on.has(l) });
      boxes.set(l, cb);
      return h('label', { class: 'small', style: 'display:inline-block;min-width:160px' }, cb, ' ', l);
    }));
    const out = h('p', { class: 'small' });
    const apply = async (list) => {
      const res = await DB.setCommonLabels(list);
      out.textContent = `Saved. ${res.rows} values stored${res.merged ? `; ${res.merged} values from different pages were combined (the others are kept in the history)` : ''}.`;
      renderCommon().then(() => card.append(out));
    };
    card.append(h('h3', { style: 'margin-top:0' }, 'Common fields'),
      h('p', { class: 'mut small' }, 'Values read on different pages are kept as separate values. Ticked fields are the exception: they should be the same on every page of a system (name, ID, birth date…), so each patient keeps one value per site, a different value on another page is shown as a change, and you can edit it on the patient card.'),
      list,
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => apply(labels.filter((l) => boxes.get(l).checked).concat([...on].filter((l) => !boxes.has(l)))) }, 'Save'),
        ' ', h('button', { onclick: () => { if (confirm('Use the default common fields?')) apply(null); } }, 'Reset to defaults')),
      out);
  }
  async function setPassphrase() {
    let p1 = '', p2 = '';
    const r = await modal((f) => {
      const a = h('input', { type: 'password', placeholder: 'passphrase (12+ characters)' }), b = h('input', { type: 'password', placeholder: 'repeat' });
      f.append(h('b', {}, 'Backup passphrase'), h('p', { class: 'small bad' }, 'If you forget it, your backups cannot be opened by anyone, including you. It is never uploaded and is forgotten when the browser closes.'), a, b,
        h('div', { class: 'btns' }, h('button', { value: '' }, 'Cancel'), h('button', { class: 'primary', value: 'ok', onclick: () => { p1 = a.value; p2 = b.value; } }, 'Use this passphrase')));
    });
    if (r !== 'ok') return;
    if (p1.length < 12) return alert('Use at least 12 characters.');
    if (p1 !== p2) return alert('The two entries differ.');
    await PDB.crypto.setPassphrase(p1);
    chrome.action.setBadgeText({ text: '' });
    renderSettings();
  }
  async function backupNow() {
    const r = await PDB.backup.run({ interactive: true });
    if (r.status === 'needs-passphrase') { await setPassphrase(); return; }
    chrome.action.setBadgeText({ text: r.status === 'ok' ? '' : '!' });
    renderSettings();
  }
  async function restoreDialog() {
    let list;
    try { list = await PDB.backup.listBackups(); } catch (e) { return alert(e.message); }
    if (!list.length) return alert('No backups found in Google Drive.');
    let id = '', mode = 'merge', pass = '';
    const r = await modal((f) => {
      const sel = h('select', {}, list.map((x) => h('option', { value: x.id }, `${x.name} · ${x.appProperties.rows || '?'} rows`)));
      const m = h('select', {}, h('option', { value: 'merge' }, 'merge with local data'), h('option', { value: 'replace' }, 'replace local data'));
      const p = h('input', { type: 'password', placeholder: 'backup passphrase' });
      f.append(h('b', {}, 'Restore from Google Drive'), sel, m, p, h('div', { class: 'btns' }, h('button', { value: '' }, 'Cancel'), h('button', { class: 'primary', value: 'ok', onclick: () => { id = sel.value; mode = m.value; pass = p.value; } }, 'Restore')));
    });
    if (r !== 'ok') return;
    if (mode === 'replace' && !confirm('Replace ALL local data with this backup?')) return;
    try { const res = await PDB.backup.restore(id, pass, mode); alert(`Restored ${res.rows} rows and ${res.restoredBlobs} media files${res.missingBlobs ? ` (${res.missingBlobs} media files missing on Drive)` : ''}.`); }
    catch (e) { alert(e.message); }
    renderPatients();
  }
  $('#wipe').onclick = async () => {
    const t = prompt('This deletes every saved row and media file on this computer (backups on Drive are not touched). Type DELETE to confirm.');
    if (t !== 'DELETE') return;
    await DB.clearAll();
    current = null;
    show('patients');
  };

  show((location.hash || '#patients').slice(1));
})();
