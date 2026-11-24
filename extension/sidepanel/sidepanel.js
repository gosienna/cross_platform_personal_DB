/* Side panel: Scan → Preview → Save, and Scan form → Preview → Fill. */
(() => {
  const { h, $, $$, modal, dataURLtoBlob, sourceOf, vocabLabels } = UI;
  const C = PDB.core, DB = PDB.db, PT = PDB.pagetpl;
  const LIBS = ['lib/schema.js', 'lib/core.js', 'lib/dom.js', 'lib/templates.js', 'lib/pagetpl.js', 'lib/fill.js', 'lib/redact.js', 'lib/tplcheck.js', 'content/agent.js'];
  const MEDIA_LABEL = { image: 'Photo', audio: 'Audio', video: 'Video', screenshot: 'Screenshot' };

  const st = { tab: null, source: '', path: '', captureTime: '', recs: [], regions: [], blobs: new Map(), broken: [], fill: null,
    // page templates of the frames read: framePath → { fp, tpl, mode: 'strict'|'draft', partial, dirty, frameId, uncovered }
    pages: new Map(), off: new Set(), learn: [], hot: null, pendingTime: null,
    // pictures of image fields on the page: { fp, frameId, fid, ref, label, anchor, mask, key, read, n?, dataURL?, error? }
    images: [] };
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

  /** What a page scan needs: this site's page templates (with unsaved changes made here) and fields taught in Fill. */
  async function extractCtx() {
    const vocab = await DB.getVocab();
    const pageTemplates = (await DB.getPageTemplates()).filter((t) => t.origin === st.source);
    const choice = {};
    for (const pg of st.pages.values()) {
      if (pg.choice) choice[pg.fp] = pg.choice;
      if (!pg.tpl) continue;
      const i = pageTemplates.findIndex((t) => t.id === pg.tpl.id);
      if (i >= 0) pageTemplates[i] = pg.tpl; else pageTemplates.push(pg.tpl);
      // once a page has its template, it keeps it while you work on it (edits must not change which template it is)
      if (!pg.choice && !pg.tpl._draft) choice[pg.fp] = pg.tpl.id;
    }
    st.siteTemplates = pageTemplates.filter((t) => t.complete && !t._draft);
    const templates = (await DB.getTemplates()).filter((t) => t.origin === st.source && t.direction === 'fill');
    return { vocab, origin: st.source, pageTemplates, templates, choice };
  }
  /**
   * Templates for a Fill scan: fields taught in Fill on this page, plus the fields of this site's page templates
   * (a field taught on the read-only page is found on the edit form by the text before it).
   */
  async function fillTemplates() {
    const fill = (await DB.getTemplates()).filter((t) => t.origin === st.source && t.direction === 'fill' && (!t.path || st.path.startsWith(t.path)));
    const pages = (await DB.getPageTemplates()).filter((t) => t.origin === st.source)
      .map((t) => ({ id: t.id, origin: t.origin, framePath: t.framePath, direction: 'extract', fields: t.fields.filter((f) => f.label !== PT.IGNORE && f.role !== 'time' && f.kind !== 'image') }));
    return fill.concat(pages);
  }
  /** Read the page again (after a template change). */
  async function rescan(msg) {
    const results = await call(st.tab.id, 'scan', [await extractCtx()]);
    await buildPreview(results);
    if (msg) status(msg);
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
    status('Click a value, a form field, a tick box or a picture, then choose its label (Esc cancels).');
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
    await AIFlow.run({ tab, st, call, status, onResult: (results) => onAI(results) });
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
    else if (msg.type === 'pdb:taught' && msg.mode === 'time') run(() => onTimePicked(msg.field));
    else if (msg.type === 'pdb:media') run(() => addMedia(msg.media));
    else if (msg.type === 'pdb:badge') focusRow(`${sender.frameId}:${msg.ref}`);
    else if (msg.type === 'pdb:markx') run(() => onMarkX(msg.key, msg.x));
    else if (msg.type === 'pdb:pickCancelled') { call(st.tab.id, 'stopPick').catch(() => {}); status('Cancelled.'); }
    else if (msg.type === 'pdb:error') status(msg.message, true);
  });

  /** Merge frame results → records → preview rows with identity and dedup status. */
  async function buildPreview(results, opts = {}) {
    await call(st.tab.id, 'stopPick').catch(() => {});
    if (!opts.picked) await addImageReadings(results);
    st.captureTime = C.utcStamp(new Date());
    const all = [];
    st.regions = []; st.broken = [];
    const foundLabels = new Set();
    const fref = (frameId, x) => (x != null ? `${frameId}:${x}` : null);
    for (const { frameId, result } of results) {
      const fp = result.framePath;
      // the page each value is read from: values from different pages are different data points
      let page = fp;
      if (page == null) { try { page = C.pagePath(new URL(result.url).pathname); } catch (e) { page = C.pagePath(st.path); } }
      if (result.template) {
        const pg = st.pages.get(fp) || { fp, dirty: false };
        Object.assign(pg, { tpl: result.template, mode: result.mode, partial: !!result.partial, frameId, title: result.title, query: result.query || '',
          match: result.match && result.match.decision !== 'chosen' && result.match.decision !== 'editing' ? result.match : pg.match || result.match,
          uncovered: (result.uncovered || []).map((u) => ({ ...u, ref: fref(frameId, u.ref) })),
          ignored: (result.ignored || []).map((x) => ({ ...x, ref: fref(frameId, x.ref) })) });
        if (result.changed) pg.dirty = true;
        st.pages.set(fp, pg);
      }
      for (const r of result.records) {
        for (const it of r.items) { it.ref = fref(frameId, it.ref); it.region = fref(frameId, it.region); it.timeRef = fref(frameId, it.timeRef); it.fp = result.template ? fp : null; it.page = page; }
        for (const m of r.meds) { m.ref = fref(frameId, m.ref); m.region = fref(frameId, m.region); m.fp = result.template ? fp : null; m.page = page; }
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
        key: `${i}.${j}`, label: r.label, value: r.value, time: r.time, source: r.source, page: r.page || '',
        rawLabel: r._item.rawLabel || r.label, ref: r._item.ref || null, regionRef: r._item.region || null, warn: r._item.warn, unmapped: !!r._item.unmapped,
        how: r._item.how || (opts.ai ? 'ai' : null), conflictWith: r._conflictWith, on: !r._item.estimated,
        fid: r._item.fid || null, fids: (r._fids || [r._item.fid]).filter(Boolean), fp: r._item.fp || null, timeRef: r._item.timeRef || null,
        estimated: !!r._item.estimated,
      }));
      return { hints: rec.hints, skipped: rec.skipped, rows, pid: id.patientId || '', identity: id };
    }).concat(prev);
    for (const rec of st.recs) await refreshStatus(rec);
    for (const rec of st.recs) for (const r of rec.rows) if (st.off.has(offKey(r))) r.on = false; // unticked before a re-read
    const n = st.recs.reduce((a, r) => a + r.rows.length, 0);
    const unread = st.images.filter((x) => !x.read && !x.error).length;
    if (!n && unread) status(`${unread} picture${unread > 1 ? 's' : ''} on this page ${unread > 1 ? 'are' : 'is'} not read yet: press Read with AI above.`);
    else if (!n) status(opts.picked ? 'Nothing recognisable in that part of the page. Try a larger region, or Teach the fields.' : 'No data recognised on this page. Try Pick region, Teach, or AI extract.', !n);
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
      r.status = diff[i].status; r.oldValue = diff[i].oldValue; r.oldPage = diff[i].oldPage;
      if (before == null || before !== r.status) r.on = r.status === 'new' && !r.conflictWith && !r.estimated;
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
    rec.rows.push({ key: `m.${rec.rows.length}`, label: MEDIA_LABEL[media.kind] || 'Attachment', value: id, time: st.captureTime, source: st.source, page: C.pagePath(st.path), rawLabel: media.name, on: true, status: 'new', media: true });
    status(`${MEDIA_LABEL[media.kind] || 'File'} added (${(blob.size / 1024).toFixed(0)} KB). Choose the patient and Save.`);
    render();
  }

  // ── image fields: values read from pictures ─────────────────────────
  const blobToDataURL = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
  const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  /** A picture that cannot be read from the page (e.g. a canvas drawn from another site): cropped from a screenshot. Top frame only. */
  async function cropShot(frameId, ref) {
    if (frameId !== 0) return null;
    const r = await call(st.tab.id, 'showRect', [ref], [frameId]);
    const box = r[0] && r[0].result;
    if (!box || box.w < 4 || box.h < 4) return null;
    const img = await loadImg(await chrome.tabs.captureVisibleTab(st.tab.windowId, { format: 'png' }));
    const c = document.createElement('canvas');
    c.width = Math.round(box.w); c.height = Math.round(box.h);
    c.getContext('2d').drawImage(img, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }
  /**
   * Image fields of the page templates: each picture is identified by its content (sha256 of its pixels). A picture
   * read before gets the values Claude read from it then, added to its record as if read from the page; the others
   * are listed in st.images, to read with AI. Runs before the preview is built (refs are still frame-local here).
   */
  async function addImageReadings(results) {
    st.images = [];
    const pics = [];
    for (const { frameId, result } of results) {
      const imgs = result.images || [];
      if (!imgs.length) continue;
      const got = await call(st.tab.id, 'imageData', [imgs.map((x) => x.ref)], [frameId]).catch(() => []);
      const byRef = new Map(((got[0] && got[0].result) || []).map((d) => [d.ref, d]));
      for (const im of imgs) {
        const d = byRef.get(im.ref) || {};
        const base = { fp: result.framePath, frameId, fid: im.fid, ref: `${frameId}:${im.ref}`, label: im.label, anchor: im.anchor, mask: im.mask || [] };
        let dataURL = d.dataURL || null;
        if (!dataURL && d.src) dataURL = await fetch(d.src, { credentials: 'include' }).then((r) => (r.ok ? r.blob() : null)).then((b) => (b ? blobToDataURL(b) : null)).catch(() => null);
        if (!dataURL && (d.shot || d.src)) dataURL = await cropShot(frameId, im.ref).catch(() => null);
        if (!dataURL) { st.images.push({ ...base, error: d.error || 'its pixels cannot be read from this page.' }); continue; }
        const key = `${await DB.sha256(await dataURLtoBlob(dataURL))}|${im.label}`;
        pics.push({ im, result, base: { ...base, key, dataURL } });
      }
    }
    if (!pics.length) return;
    const readings = await DB.getImageReadings(pics.map((p) => p.base.key));
    const ctx = { vocab: await DB.getVocab(), origin: st.source };
    for (const { im, result, base } of pics) {
      const reading = readings[base.key];
      const rec = im.rec >= 0 ? result.records[im.rec] : null;
      if (reading && rec) st.images.push({ ...base, dataURL: null, read: true, n: PT.imageItems(rec, reading, im, ctx) });
      else st.images.push({ ...base, read: false });
    }
  }
  /** Read the pictures of a page (or all) not read yet: one review each, then Claude. Their values are kept per picture. */
  async function readPictures(fp) {
    if (!globalThis.AIFlow) throw new Error('AI is not available.');
    const todo = st.images.filter((x) => !x.read && !x.error && x.dataURL && (!fp || x.fp === fp));
    if (!todo.length) return status('No pictures to read.');
    const n = await AIFlow.readImages({ source: st.source, status, pics: todo.map((x) => ({ dataURL: x.dataURL, label: x.label, anchor: x.anchor, mask: x.mask })),
      onRead: async (i, { rows, mask }) => {
        const x = todo[i];
        await DB.putImageReading(x.key, { rows });
        // the black boxes are offered again for this field's next picture
        const pg = st.pages.get(x.fp);
        const f = pg && pg.tpl && pg.tpl.fields.find((y) => y.id === x.fid);
        if (f && JSON.stringify(f.mask || []) !== JSON.stringify(mask)) { f.mask = mask; pg.dirty = true; }
      } });
    await rescan(n ? `Read ${n} picture${n > 1 ? 's' : ''}. Check the values (ones estimated from a chart’s axes are unticked), then Save.` : 'No picture was read. Nothing was sent.');
  }
  /** Forget what was read from this page's pictures, and read them again. */
  async function rereadPictures(fp) {
    const keys = st.images.filter((x) => x.read && x.fp === fp).map((x) => x.key);
    if (!keys.length) return;
    await DB.forgetImageReadings(keys);
    await rescan();
    await readPictures(fp);
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
  /**
   * AI extract → suggested changes to the page template (values are never saved from AI directly: the page is read
   * by its template, so what is accepted here is read from the page itself, now and next time).
   */
  async function onAI(results) {
    const items = results.flatMap((r) => r.result.records).flatMap((r) => r.items).map((it) => ({ label: it.label, value: it.value, raw: it.raw, text: it.text, time: it.time }));
    if (!items.length) return status('Claude found no values on this page.');
    if (!st.pages.size) await rescan();
    status('Finding the values Claude read on the page…');
    const res = await call(st.tab.id, 'locateValues', [items, await extractCtx()]);
    const used = new Set(), sug = [];
    for (const { result } of res) for (const s of result.found) { if (used.has(s.i)) continue; used.add(s.i); sug.push({ ...s, fp: result.framePath, item: items[s.i] }); }
    const todo = sug.filter((s) => (s.kind !== 'same' || s.time) && st.pages.has(s.fp));
    const same = sug.filter((s) => s.kind === 'same' && !s.time).length;
    const missed = items.filter((_, i) => !used.has(i));
    const where = (f) => (f && f.anchor ? ` at “${f.anchor.slice(0, 24)}”` : '');
    const timeTxt = (s) => {
      if (!s.time || PT.isPersistent(s.item.label)) return '';
      const pg = st.pages.get(s.fp);
      const f = s.time.fid && pg ? pg.tpl.fields.find((x) => x.id === s.time.fid) : null;
      return ` · ⏱ ← ${f ? PT.fieldName(f) : (s.time.field && s.time.field.anchor) || 'a date on the page'}`;
    };
    const rows = todo.map((s) => ({ s, cb: h('input', { type: 'checkbox', checked: true }),
      text: s.kind === 'add' ? `Add “${s.item.label}” = ${String(s.item.value).slice(0, 40)}${where(s.field)}${timeTxt(s)}`
        : s.kind === 'relabel' ? `“${s.from}” → “${s.item.label}”${timeTxt(s)}` : `Time of “${s.item.label}”${timeTxt(s)}` }));
    const res2 = await modal((f) => {
      f.append(h('b', {}, 'Suggested changes to this page’s template'),
        h('p', { class: 'small mut' }, `Claude read ${items.length} values. ${same} are already read by the template. Accepted changes are read from the page itself, now and every time.`),
        rows.length ? h('div', { class: 'payload' }, rows.map((x) => h('label', { style: 'display:block' }, x.cb, ' ', x.text))) : h('p', {}, 'Nothing to change.'),
        missed.length ? h('details', {}, h('summary', { class: 'small' }, `Not found on the page as one element (${missed.length}): not added`),
          h('div', { class: 'small mut' }, missed.map((m) => h('div', {}, `${m.label} = ${String(m.value).slice(0, 40)}`)))) : null,
        h('div', { class: 'btns' }, h('button', { value: '' }, 'Cancel'), h('button', { class: 'primary', value: 'ok', disabled: !rows.length }, 'Apply ticked')));
    }, { wide: true });
    if (res2 !== 'ok') return status('No template changes.');
    let n = 0;
    for (const { s, cb } of rows) {
      if (!cb.checked) continue;
      const pg = st.pages.get(s.fp);
      let fid = s.fid;
      if (s.kind === 'add') { const { value, framePath, ...f } = s.field; fid = PT.addField(pg.tpl, f, { label: s.item.label, from: 'ai' }).id; }
      else if (s.kind === 'relabel') PT.setLabel(pg.tpl, s.fid, s.item.label);
      const anchor = s.field ? s.field.anchor : null;
      if (anchor && anchor.length <= 24) st.learn.push({ rawLabel: anchor, label: s.item.label, how: 'ai' });
      if (s.time && !PT.isPersistent(s.item.label)) {
        let tid = s.time.fid;
        if (!tid) {
          const { value, framePath, ...f } = s.time.field;
          const ex = pg.tpl.fields.find((x) => x.selector === f.selector && !x.part && x.label !== PT.IGNORE);
          tid = ex ? ex.id : PT.addField(pg.tpl, { ...f, role: 'time', label: C.cleanLabel(f.anchor || '') || 'time', rawLabel: f.anchor || '' }, { from: 'ai' }).id;
        }
        PT.setTime(pg.tpl, fid, { mode: 'field', field: tid });
      }
      pg.dirty = true; n++;
    }
    await rescan(n ? `Applied ${n} change${n > 1 ? 's' : ''} to the template. Check the rows, then Save.` : 'No template changes.');
  }

  /** Teach in Capture: the clicked element becomes a field of this page's template (or gets a new label). */
  async function onTaught(field) {
    let pg = st.pages.get(field.framePath);
    if (!pg) { await rescan(); pg = st.pages.get(field.framePath); }
    if (!pg) throw new Error('This part of the page could not be read. Scan the page first.');
    const what = field.kind === 'group' ? `the tick boxes “${field.anchor || ''}”`
      : field.kind === 'image' ? `the picture${field.anchor ? ` next to “${field.anchor.slice(0, 30)}”` : ''} (what it shows, e.g. Blood glucose)`
      : `“${(field.anchor || field.value || 'this field').slice(0, 40)}”`;
    const shown = field.value ? ` (now: ${field.value.slice(0, 40)})` : '';
    const known = st.recs.flatMap((r) => (r.rows || []).map((x) => x.label));
    const label = await chooseLabel(`Label for ${what}${shown}`, field.anchor, known);
    if (!label) return status('Cancelled.');
    const { value, framePath, ...f } = field;
    // teaching a label the template already reads elsewhere (e.g. the right Name): replace the old field(s)
    const others = f.kind === 'image' ? [] : PT.sameLabel(pg.tpl, label, f); // a chart of a value can sit beside the value itself
    const replace = others.length && confirm(`This page's template already reads “${label}” from ${others.length > 1 ? `${others.length} other places` : 'another place'}${others[0].anchor ? ` (next to “${others[0].anchor.slice(0, 20)}”)` : ''}.\n\nOK: use only the place you just clicked.\nCancel: keep both.`);
    if (replace) for (const o of others) PT.removeUnit(pg.tpl, o.id);
    PT.addField(pg.tpl, f, { label, from: 'taught' });
    pg.dirty = true;
    if (field.anchor && field.anchor.length <= 24 && field.kind !== 'image') await DB.learnAlias(field.anchor, label, { source: 'extract' });
    if (field.kind === 'image') return rescan(`Taught: the picture → ${label}. It is part of this page's template now: press Read with AI above to read it. Each new picture there is read once; the same picture reuses its values.`);
    await rescan(`Taught: ${field.anchor || 'this field'} → ${label}. It is part of this page's template now (kept when you Save).`);
  }

  /** ✕ / ↺ on an outline on the page: cancel a mapping, or bring a cancelled one back. */
  async function onMarkX(key, x) {
    if (x === 'restore') {
      const [, fp, fid] = String(key).split('␟');
      const pg = st.pages.get(fp);
      if (!pg || !PT.restoreUnit(pg.tpl, fid)) return;
      pg.dirty = true;
      return rescan('Read again. Press Save or Save template to keep this.');
    }
    const r = st.recs.flatMap((rec) => rec.rows).find((row) => row.key === key);
    const pg = r && pageOf(r);
    if (!pg || !r.fids || !r.fids.length) return;
    for (const fid of r.fids) PT.removeUnit(pg.tpl, fid);
    pg.dirty = true;
    await rescan(`Cancelled “${r.label}”: not saved any more (↺ on the page brings it back). Press Save or Save template to keep this.`);
  }
  /** ✕ on a row read by the page's template: leave that field out of the template (all fields the row stands for). */
  function removeBtn(r) {
    const pg = pageOf(r);
    if (!pg || !r.fids || !r.fids.some((fid) => PT.unitOf(pg.tpl, fid))) return null;
    return h('button', { class: 'link rm', type: 'button', title: 'Remove from this page’s template (not saved, not offered again). Undo in Dashboard → Mappings.',
      onclick: () => run(async () => {
        for (const fid of r.fids) PT.removeUnit(pg.tpl, fid);
        pg.dirty = true;
        await rescan(`Removed “${r.label}” from the template. Press Save or Save template to keep this.`);
      }) }, '✕');
  }

  // ── time links ───────────────────────────────────────────────────────
  const offKey = (r) => `${r.fid || r.key}|${r.time}|${r.value}`;
  function setOn(r, on) { r.on = on; if (on) st.off.delete(offKey(r)); else st.off.add(offKey(r)); }
  const pageOf = (r) => (r.fp != null ? st.pages.get(r.fp) : null);
  /** The ⏱ chip of a row: where its time comes from. */
  function timeChip(r) {
    const pg = pageOf(r);
    const u = pg && PT.unitOf(pg.tpl, r.fid);
    if (!u) return null;
    const tt = PT.timeText(pg.tpl, u.unit);
    const fixed = u.unit.kind !== 'table' && PT.isPersistent(u.unit.label);
    return h('button', { class: 'chip' + (tt.warn ? ' warn' : ''), type: 'button', disabled: fixed,
      title: fixed ? 'Personal details have no time' : 'Where this value’s time comes from. Click to change.',
      onmouseenter: () => { st.hot = r.key; paintOverlay(); if (r.timeRef) focusRef(r.timeRef); },
      onmouseleave: () => { st.hot = null; paintOverlay(); },
      onclick: () => run(() => editTime(pg, u.unit)) }, `⏱ ${tt.text}${tt.warn ? ' ⚠' : ''}`);
  }
  /** Dialog: how a field (or a table's rows) gets its time. */
  async function editTime(pg, unit) {
    const tpl = pg.tpl;
    const cur = unit.time || { mode: 'capture' };
    const curKey = cur.mode === 'field' ? `f:${cur.field}` : cur.mode === 'column' ? (unit.map && unit.map.layout === 'list' ? `col:${(cur.cols || []).join(',')}` : 'column') : cur.mode;
    const opts = [['nan', 'Fixed: no time (the value does not change)'], ['capture', 'Capture time (when you press Scan)']];
    if (unit.kind === 'image') opts.unshift(['image', 'The time written in the picture (e.g. a chart’s dates; capture time if it shows none)']);
    if (unit.kind === 'table' && unit.map.layout === 'chart') opts.push(['column', 'Each column’s date (column headers)']);
    if (unit.kind === 'table' && unit.map.layout === 'list') {
      const cols = PT.timeColumns(unit);
      for (const c of cols) opts.push([`col:${c.i}`, `Column “${c.header}”`]);
      if (cols.length > 1) opts.push([`col:${cols.map((c) => c.i).join(',')}`, `Columns ${cols.map((c) => `“${c.header}”`).join(' + ')}`]);
    }
    // fields of this page holding a date: record dates, time fields, and fields whose value is a date
    const dated = new Set(st.recs.flatMap((rec) => rec.rows).filter((r) => r.fp === pg.fp && r.fid && /^\d{4}-\d{2}-\d{2}/.test(r.value)).map((r) => r.fid));
    for (const f of tpl.fields) if (f.role === 'recordDate' || f.role === 'time' || dated.has(f.id)) opts.push([`f:${f.id}`, f.id === unit.id ? 'Its own value (a date)' : `The date in “${PT.fieldName(f)}”`]);
    opts.push(['pick', 'Pick the date on the page…']);
    let chosen = curKey;
    const res = await modal((form) => {
      form.append(h('b', {}, `Time of “${unit.kind === 'table' ? 'the rows of this table' : PT.fieldName(unit)}”`),
        h('div', { class: 'choices' }, opts.map(([v, t]) => h('label', {}, h('input', { type: 'radio', name: 'tl', value: v, checked: v === curKey, onchange: () => { chosen = v; } }), ' ', t))),
        h('div', { class: 'btns' }, h('button', { value: '' }, 'Cancel'), h('button', { class: 'primary', value: 'ok' }, 'OK')));
    });
    if (res !== 'ok' || chosen === curKey) return;
    if (chosen === 'pick') {
      st.pendingTime = { fp: pg.fp, id: unit.id };
      await call(st.tab.id, 'startPick', ['time', {}], [pg.frameId]);
      return status('Click the date or time on the page that this value belongs to (Esc cancels).');
    }
    const link = chosen === 'nan' ? { mode: 'nan' } : chosen === 'capture' ? { mode: 'capture' } : chosen === 'image' ? { mode: 'image' } : chosen === 'column' ? { mode: 'column' }
      : chosen.startsWith('col:') ? { mode: 'column', cols: chosen.slice(4).split(',').map(Number) } : { mode: 'field', field: chosen.slice(2) };
    PT.setTime(tpl, unit.id, link);
    pg.dirty = true;
    await rescan(`Time changed: ${PT.timeText(tpl, unit).text}.`);
  }
  /** "Pick the date on the page": the clicked element becomes the time source (a time field if it is not a field yet). */
  async function onTimePicked(field) {
    const pt = st.pendingTime;
    st.pendingTime = null;
    if (!pt) return;
    const pg = st.pages.get(pt.fp);
    if (!pg || field.framePath !== pt.fp) throw new Error('Pick the date in the same part of the page (frame) as the value.');
    if (field.kind === 'image') throw new Error('Pick a date written on the page, not a picture. For dates inside a picture, choose “The time written in the picture”.');
    const { value, framePath, ...f } = field;
    let src = pg.tpl.fields.find((x) => x.selector === f.selector && !x.part && x.label !== PT.IGNORE);
    if (!src) src = PT.addField(pg.tpl, { ...f, role: 'time', label: C.cleanLabel(f.anchor || '') || 'time', rawLabel: f.anchor || '' }, { from: 'taught' });
    PT.setTime(pg.tpl, pt.id, { mode: 'field', field: src.id });
    pg.dirty = true;
    await rescan(`Time linked to “${PT.fieldName(src)}”${value ? ` (now: ${value.slice(0, 30)})` : ''}.`);
  }

  // ── the page template: banner, "not in the template" ─────────────────
  function pageBanner(pg) {
    const tpl = pg.tpl;
    const n = tpl.fields.filter((f) => f.label !== PT.IGNORE && f.role !== 'time').length, m = tpl.tables.length;
    const what = `${n} field${n === 1 ? '' : 's'}${m ? `, ${m} table${m === 1 ? '' : 's'}` : ''}`;
    const where = st.pages.size > 1 ? h('span', { class: 'mono small mut' }, ` ${pg.fp || '/'}`) : null;
    const text = pg.mode === 'draft'
      ? (pg.partial ? `Older template completed from the built-in rules: ${what}. ` : `New page: draft template from the built-in rules, ${what}. `)
        + 'It is saved when you press Save; rows you untick are left out of it.'
      : `Read by this page’s template: ${what}. Only these are saved.${pg.dirty ? ' Changed — not saved yet.' : ''}`;
    const saveT = pg.dirty || pg.mode === 'draft'
      ? h('button', { class: 'link', onclick: () => run(async () => { const k = await savePageTemplates(false); status(k ? 'Template saved (no data saved).' : 'Nothing to save.'); render(); }) }, pg.mode === 'draft' ? 'Save template only' : 'Save template')
      : null;
    const unc = pg.uncovered && pg.uncovered.length
      ? h('div', { class: 'unc' }, `${pg.uncovered.length} value${pg.uncovered.length > 1 ? 's' : ''} on this page ${pg.uncovered.length > 1 ? 'aren’t' : 'isn’t'} in the template. `,
        h('button', { class: 'link', onclick: () => run(() => reviewUncovered(pg)) }, 'Review'))
      : null;
    const exp = h('button', { class: 'link', title: 'Download this template compared with the page as it is now (where each field is found, or why not). No patient values: only their length and shape.', onclick: () => run(() => exportCheck(pg)) }, 'Export check');
    return h('div', { class: 'pagebar' + (pg.mode === 'draft' ? ' draft' : '') }, h('div', {}, h('b', {}, pg.mode === 'draft' ? 'Draft template' : 'Template'), where, ' · ', text, ' ', saveT, ' ', exp), matchRow(pg), unc, picturesRow(pg));
  }
  /** Export check: the template (with unsaved changes made here) against the live page. */
  async function exportCheck(pg) {
    const res = await call(st.tab.id, 'checkTemplate', [pg.tpl, await extractCtx()], pg.frameId != null ? [pg.frameId] : undefined);
    const chk = res.map((r) => r.result).find(Boolean);
    if (!chk) throw new Error('This part of the page could not be checked. Scan the page again.');
    chk.match = pg.match || null;
    chk.unsaved = !!pg.dirty || pg.mode === 'draft';
    // the saved sample page is left out: its masking misses some names (e.g. contacts in a table) and it is large
    const s = chk.summary;
    const name = `template-check-${(pg.fp || 'page').replace(/[^\w*-]+/g, '_').replace(/\*/g, 'x').replace(/^_+|_+$/g, '') || 'page'}.json`;
    UI.download(name, new Blob([JSON.stringify(chk, null, 1)], { type: 'application/json' }));
    status(`Exported ${name}: ${s.found} of ${s.fields} fields found${s.missing.length ? ` (missing: ${s.missing.join(', ')})` : ''}, ${s.tablesFound} of ${s.tables} tables. No patient values in it.`);
  }
  /** The pictures of this page's image fields: read before (values reused), to read with AI, or unreadable. */
  function picturesRow(pg) {
    const pics = st.images.filter((x) => x.fp === pg.fp);
    if (!pics.length) return null;
    const todo = pics.filter((x) => !x.read && !x.error), done = pics.filter((x) => x.read), bad = pics.filter((x) => x.error);
    const pl = (k) => (k > 1 ? 's' : '');
    return h('div', { class: 'unc' },
      todo.length ? [`🖼 ${todo.length} picture${pl(todo.length)} not read yet (${todo.map((x) => x.label).join(', ')}). `,
        h('button', { class: 'link', title: 'Claude reads each picture after you review it (black out personal details first)', onclick: () => run(() => readPictures(pg.fp)) }, 'Read with AI'), ' '] : null,
      done.length ? [`🖼 ${done.length} picture${pl(done.length)} read before: values reused. `,
        h('button', { class: 'link', title: 'Forget what Claude read from these pictures and read them again', onclick: () => run(() => rereadPictures(pg.fp)) }, 'Read again'), ' '] : null,
      bad.length ? h('span', { class: 'err' }, `🖼 ${bad.length} picture${pl(bad.length)} cannot be read: ${bad[0].error}`) : null);
  }
  /** How this page was matched to a template, and the choice to use another one or treat it as a new page. */
  function matchRow(pg) {
    const m = pg.match || {};
    const others = (st.siteTemplates || []).filter((t) => !pg.tpl || t.id !== pg.tpl.id);
    const name = (t) => `“${t.title || t.framePath}”`;
    const pick = () => {
      if (!others.length) return null;
      const score = new Map((m.candidates || []).map((c) => [c.id, c]));
      const sorted = [...others].sort((a, b) => ((score.get(b.id) || {}).score || 0) - ((score.get(a.id) || {}).score || 0));
      const sel = h('select', { class: 'small', onchange: () => { if (sel.value) run(() => chooseTemplate(pg, sel.value)); } },
        h('option', { value: '' }, pg.mode === 'draft' ? 'Use a saved template ▾' : 'Use another template ▾'),
        sorted.map((t) => { const c = score.get(t.id); return h('option', { value: t.id }, `${t.title || t.framePath} · ${t.framePath}${c ? ` (${c.found}/${c.total} found)` : ''}`); }));
      return sel;
    };
    const newBtn = pg.mode === 'strict' ? h('button', { class: 'link', title: 'This page is not that template: start a draft for it from the built-in rules', onclick: () => run(() => newPage(pg)) }, 'This is a new page') : null;
    let how = null;
    if (pg.mode === 'strict' && pg.choice) how = 'chosen by you';
    else if (pg.mode === 'strict' && m.decision === 'use') how = m.how === 'address' ? `matched by address (${m.found} of ${m.total} fields found)` : `matched by layout: ${m.found} of ${m.total} fields found`;
    if (pg.mode === 'draft' && m.decision === 'ask' && m.id) {
      const t = (st.siteTemplates || []).find((x) => x.id === m.id);
      if (t) return h('div', { class: 'ask' }, `This may be the template ${name(t)}: ${m.found} of ${m.total} fields found. `,
        h('button', { class: 'link', onclick: () => run(() => chooseTemplate(pg, t.id)) }, 'Use it'), ' · ',
        h('button', { class: 'link', onclick: () => { m.decision = 'none'; render(); } }, 'No, it’s a new page'), ' ', pick());
    }
    if (!how && !others.length) return null;
    return h('div', { class: 'small mut' }, how ? `${how} · ` : '', pick(), ' ', newBtn);
  }
  /** Read this page with another (saved) template; this address is remembered for it when you Save. */
  async function chooseTemplate(pg, id) {
    pg.choice = id; pg.remember = true; pg.dirty = false; pg.tpl = null;
    await rescan('Read with the template you chose. Save to remember it for this address.');
  }
  /** Not the matched template: a draft from the built-in rules instead (saved as a new template). */
  async function newPage(pg) {
    pg.choice = 'new'; pg.remember = false; pg.dirty = false; pg.tpl = null; pg.match = null;
    await rescan('New page: a draft template from the built-in rules. It is saved as a new template when you press Save.');
  }
  async function reviewUncovered(pg) {
    const items = pg.uncovered.map((u) => {
      const isT = u.unit.kind === 'table';
      const sel = isT ? null : h('select', {}, [u.unit.unmapped ? h('option', { value: u.unit.label }, `keep “${u.unit.label}”`) : h('option', { value: u.unit.label }, u.unit.label)]
        .concat(vocabLabels().filter((l) => l !== u.unit.label).map((l) => h('option', { value: l }, l))));
      return { u, sel, add: h('input', { type: 'checkbox', checked: true }) };
    });
    const res = await modal((f) => {
      f.append(h('b', {}, 'Not in this page’s template'),
        h('p', { class: 'small mut' }, 'Add the ones that should be saved from now on. Ignored ones are not offered again.'),
        h('div', { class: 'payload' }, h('table', {}, h('tbody', {}, items.map((x) => h('tr', { onmouseenter: () => x.u.ref && focusRef(x.u.ref) },
          h('td', {}, x.add), h('td', {}, x.sel || `Table · ${x.u.value}`), h('td', { class: 'small' }, x.sel ? String(x.u.value || '').slice(0, 60) : '')))))),
        h('div', { class: 'btns' }, h('button', { value: '' }, 'Cancel'), h('button', { value: 'ignore' }, 'Ignore ticked'), h('button', { class: 'primary', value: 'add' }, 'Add ticked')));
    }, { wide: true });
    if (res !== 'add' && res !== 'ignore') return;
    let k = 0;
    for (const x of items) {
      if (!x.add.checked) continue;
      k++;
      if (x.u.unit.kind === 'table') {
        const t = JSON.parse(JSON.stringify(x.u.unit));
        if (res === 'ignore') { for (const c of t.map.columns || []) c.off = true; for (const r of t.map.rows || []) r.off = true; }
        PT.addTable(pg.tpl, t);
      } else {
        const label = res === 'ignore' ? PT.IGNORE : x.sel.value;
        PT.addField(pg.tpl, x.u.unit, { label, from: label === x.u.unit.label ? 'rule' : 'taught' });
      }
    }
    if (!k) return;
    pg.dirty = true;
    await rescan(res === 'add' ? `Added ${k} to the template. Press Save (or Save template) to keep it.` : `Ignored ${k}. Press Save (or Save template) to keep this.`);
  }
  /**
   * Stylesheets the page could not read (another site's): fetched here (the extension may read them) and put in their
   * places in the sample page, so it keeps the page's layout. @imports are followed two levels deep.
   */
  async function withExternalCss(html, external) {
    const get = async (href, depth) => {
      try {
        const res = await fetch(href, { credentials: 'include' });
        if (!res.ok) return '';
        let css = await res.text();
        if (depth > 0) {
          const imports = [...css.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)['"]?\s*\)?[^;]*;/g)];
          for (const m of imports) css = css.replace(m[0], await get(new URL(m[1], href).href, depth - 1));
        }
        return css;
      } catch (e) { return ''; }
    };
    for (const x of external) {
      const css = PT.cleanCss(await get(x.href, 2)).replace(/<\/style/gi, '<\\/style');
      html = html.replace(`<style data-pdb-ext="${x.i}"></style>`, () => `<style data-pdb-ext="${x.i}">${css}</style>`);
    }
    return html;
  }
  /**
   * Save the page templates read in this capture, with a masked sample page each.
   * A draft becomes the page's template (without the fields whose rows were unticked, when saving with data);
   * a changed template is saved again.
   */
  async function savePageTemplates(withRows) {
    let n = 0;
    const ctx = await extractCtx();
    for (const pg of st.pages.values()) {
      const tpl = pg.tpl;
      if (!tpl || (!tpl.fields.length && !tpl.tables.length)) continue;
      const rows = st.recs.flatMap((rec) => rec.rows.filter((r) => r.fp === pg.fp));
      if (pg.mode === 'draft') {
        if (!rows.length) continue; // a frame with nothing on it
        if (withRows) {
          const linked = new Set([...tpl.fields, ...tpl.tables].map((u) => (u.time && u.time.mode === 'field' ? u.time.field : null)));
          const byFid = new Map();
          for (const r of rows) if (r.fid) { if (!byFid.has(r.fid)) byFid.set(r.fid, []); byFid.get(r.fid).push(r); }
          const dropped = (f) => byFid.has(f.id) && byFid.get(f.id).every((r) => st.off.has(offKey(r)));
          tpl.fields = tpl.fields.filter((f) => {
            if (!dropped(f)) return true;
            if (linked.has(f.id)) { f.role = 'time'; return true; } // still where other values take their time from
            return false;
          });
        }
      } else {
        // matched by layout or chosen: remember this address for the template
        const remembered = (pg.remember || (pg.match && pg.match.how === 'layout')) && PT.rememberAddress(tpl, { path: pg.fp, query: pg.query || '' });
        if (!pg.dirty && !remembered && (await DB.getSample(tpl.id))) continue;
      }
      const t = { ...tpl, complete: true, updatedAt: Date.now() };
      delete t._draft; delete t._partial;
      await DB.savePageTemplate(t);
      try {
        const r = await call(st.tab.id, 'sample', [t, ctx], [pg.frameId]);
        if (r[0] && r[0].result) {
          const x = r[0].result;
          await DB.putSample({ id: t.id, html: await withExternalCss(x.html, x.external || []), title: x.title, width: x.width, height: x.height });
        }
      } catch (e) { console.warn('sample page not saved', e); }
      Object.assign(pg, { tpl: t, mode: 'strict', dirty: false });
      n++;
    }
    return n;
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
    if (r.status === 'changed') {
      const where = r.oldPage && r.oldPage !== r.page ? ` (read on ${r.oldPage})` : '';
      return h('span', { class: 'badge chg', title: `Stored value: ${r.oldValue}${where}. Saving keeps it in the history.` }, `${r.oldValue} → new`);
    }
    if (r.warn) return h('span', { class: 'badge warn', title: r.warn }, r.warn.replace(/_/g, ' '));
    if (r.unmapped) return h('span', { class: 'badge map' }, 'unmapped');
    if (r.how === 'ai') return h('span', { class: 'badge vio' }, 'AI');
    if (r.how === 'image') return h('span', { class: 'badge vio', title: 'Read by Claude from the picture. The same picture always gives these values; “Read again” above reads it anew.' }, 'picture');
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
    const pages = $('#pages');
    pages.textContent = '';
    for (const pg of st.pages.values()) {
      const used = st.recs.some((rec) => rec.rows.some((r) => r.fp === pg.fp)) || (pg.uncovered && pg.uncovered.length) || st.images.some((x) => x.fp === pg.fp);
      if (used && pg.tpl && (pg.tpl.fields.length || pg.tpl.tables.length || pg.uncovered.length)) pages.append(pageBanner(pg));
    }
    if (st.broken.length) box.append(h('p', { class: 'status err' }, `Template fields not found on this page: ${st.broken.map((b) => b.label).join(', ')}. Use Teach to teach them again (or remove them in Dashboard → Mappings).`));
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
      const all = h('input', { type: 'checkbox', checked: shown.every((r) => r.on), onchange: () => { shown.forEach((r) => setOn(r, all.checked)); render(); paintOverlay(); } });
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
    const cb = h('input', { type: 'checkbox', checked: r.on, onchange: () => { setOn(r, cb.checked); tr.classList.toggle('off', !r.on); paintOverlay(); } });
    const val = r.media ? h('span', { class: 'mono' }, r.value.slice(0, 16) + '…')
      : h('input', { value: r.value, onchange: () => { r.value = val.value; refreshStatus(rec).then(() => { tr.replaceWith(rowEl(rec, r)); }); } });
    let labelCell;
    const makeSelect = () => {
      const opts = [h('option', { value: r.label }, r.label)];
      if (r.rawLabel && r.rawLabel !== r.label) opts.push(h('option', { value: '__raw__' }, `keep “${C.cleanLabel(r.rawLabel)}”`));
      for (const l of vocabLabels()) if (l !== r.label) opts.push(h('option', { value: l }, l));
      const pg = pageOf(r);
      const inTpl = !!(pg && r.fid && PT.unitOf(pg.tpl, r.fid));
      opts.push(h('option', { value: '__ignore__' }, inTpl ? 'Remove from template' : 'Ignore on this site'));
      const sel = h('select', {}, opts);
      sel.onchange = async () => {
        if (inTpl) {
          // a template field: the change goes into the page's template, and the page is read again
          // a row can stand for several fields reading the same value: all of them change
          if (sel.value === '__ignore__') for (const fid of r.fids) PT.removeUnit(pg.tpl, fid);
          else {
            const label = sel.value === '__raw__' ? C.cleanLabel(r.rawLabel) : sel.value;
            for (const fid of r.fids) PT.setLabel(pg.tpl, fid, label);
            if (sel.value !== '__raw__' && r.rawLabel) st.learn.push({ rawLabel: r.rawLabel, label, how: r.how });
          }
          pg.dirty = true;
          return run(() => rescan(sel.value === '__ignore__' ? `Removed “${r.label}” from the template.` : `“${r.rawLabel || r.label}” is now ${sel.value === '__raw__' ? C.cleanLabel(r.rawLabel) : sel.value} in the template.`));
        }
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
      h('td', {}, cb), h('td', { class: 'l' }, labelCell), h('td', { class: 'v' }, val), h('td', { class: 'small mut t' }, C.displayTime(r.time), timeChip(r)), h('td', { class: 'b' }, statusBadge(r), removeBtn(r)));
    return tr;
  }

  function toggleRegion(g) {
    // rows read from this region's table
    for (const rec of st.recs) for (const r of rec.rows) if (r.ref && r.regionRef === g.ref) setOn(r, g.on !== false);
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
    const picMarks = new Map(); // a picture's values share one outline
    for (const rec of st.recs) for (const r of rec.rows) {
      if (!r.ref || !rowHit(r)) continue;
      if (r.how === 'image') { const m = picMarks.get(r.ref) || { n: 0, on: 0, key: r.key, label: (st.images.find((x) => x.ref === r.ref) || {}).label || r.label }; m.n++; if (r.on) m.on++; picMarks.set(r.ref, m); continue; }
      const kind = !r.on ? 'off' : r.warn ? 'warn' : r.unmapped ? 'unmapped' : 'mapped';
      const pg = pageOf(r);
      const inTpl = !!(pg && r.fids && r.fids.some((fid) => PT.unitOf(pg.tpl, fid)));
      add(r.ref, { kind, text: r.unmapped ? `? ${C.cleanLabel(r.rawLabel)}` : `${r.label} ✓`, key: r.key, title: `${r.label}: ${r.value}`, x: inTpl ? 'cancel' : null });
      // hovering a ⏱ chip: where this value's time is read from
      if (st.hot === r.key && r.timeRef) add(r.timeRef, { kind: 'time', text: `⏱ time of ${r.label}`, key: r.key });
    }
    for (const [ref, m] of picMarks) add(ref, { kind: m.on ? 'mapped' : 'off', text: `🖼 ${m.label}: ${m.n} value${m.n > 1 ? 's' : ''} ✓`, key: m.key, title: `${m.on} of ${m.n} ticked` });
    if (!ui.q.cap) for (const x of st.images) if (!x.read && x.ref) add(x.ref, { kind: x.error ? 'warn' : 'unmapped', text: x.error ? `🖼 ${x.label}: cannot be read` : `🖼 ${x.label}: not read yet`, key: 'img' });
    // fields cancelled in the template: greyed, with ↺ to bring them back
    if (!ui.q.cap) for (const pg of st.pages.values()) for (const x of pg.ignored || []) if (x.ref) add(x.ref, { kind: 'off', text: `${x.label} (not saved)`, key: `ign␟${pg.fp}␟${x.fid}`, x: 'restore' });
    // values the rules see that the template does not cover
    if (!ui.q.cap) for (const pg of st.pages.values()) for (const u of pg.uncovered || []) if (u.ref) add(u.ref, { kind: 'unmapped', text: `+ not in template: ${u.unit.label || ''}`, key: 'unc' });
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
    st.pages.clear(); st.off.clear(); st.learn = []; st.hot = null; st.pendingTime = null; st.images = [];
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
      for (const r of chosen) out.push({ patientId: pid, label: r.label, value: r.value, time: r.time, source: r.source, page: r.page || '' });
    }
    // learned mappings (shared by extract and fill)
    const global = $('#rememberGlobal').checked;
    for (const rec of st.recs) for (const r of rec.rows) {
      if (r.ignore) await DB.learnAlias(r.rawLabel, '__ignore__', { site: st.source, source: 'extract' });
      else if (r.userLabel && r.rawLabel) await DB.learnAlias(r.rawLabel, r.userLabel, { site: global ? null : st.source, source: r.how === 'ai' ? 'ai' : 'extract' });
    }
    // labels chosen for template fields also help the drafts of other pages
    for (const l of st.learn) await DB.learnAlias(l.rawLabel, l.label, { site: global ? null : st.source, source: l.how === 'ai' ? 'ai' : 'extract' });
    if (!out.length) return status('Nothing ticked to save.', true);
    for (const r of out) if (st.blobs.has(r.value)) { const b = st.blobs.get(r.value); await DB.putBlob(b.blob, { name: b.name }); }
    await DB.putRows(out);
    const tpls = await savePageTemplates(true);
    const pts = new Set(out.map((r) => r.patientId)).size;
    resetCapture();
    status(`Saved ${out.length} values for ${pts} patient${pts > 1 ? 's' : ''}.${tpls ? ` Page template${tpls > 1 ? 's' : ''} saved: the page${tpls > 1 ? 's are' : ' is'} read by ${tpls > 1 ? 'them' : 'it'} from now on.` : ''}`);
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
    const templates = await fillTemplates();
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
