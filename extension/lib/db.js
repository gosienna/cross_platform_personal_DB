/*
 * Local storage.
 *   IndexedDB "pdb":
 *     rows   – the unified data: { k, patientId, label, value, time, source, page?, history? }
 *              k = internal unique key (core.rowKey: page is part of it except for common labels)
 *              page = page path the value was read from; history = [{ value, page, replacedAt }] values it replaced
 *     blobs  – media bytes: { id: "sha256:…", blob, mime, size, name, createdAt }
 *     samples – masked sample page of a page template: { id (= template id), html, capturedAt }
 *   chrome.storage.local:
 *     vocab         – { aliases: { normLabel: { label, sites?, source, createdAt } } }
 *     pageTemplates – one template per page (see lib/pagetpl.js); used by Capture, and by Fill (found by context)
 *     templates     – fields taught in Fill: [{ id, origin, path, framePath, direction: 'fill', fields }]
 *     settings   – backup / AI / privacy settings, commonLabels (null = defaults)
 *     meta       – { dataVersion, lastChange }  (backup uses it to know whether data changed)
 */
(function (g) {
  const PDB = (g.PDB = g.PDB || {});
  const C = () => PDB.core;
  const DB_NAME = 'pdb';
  let _db = null;

  async function open() {
    if (_db) return _db;
    // row keys depend on which labels are common: load the user's list before any key is made
    C().setCommonLabels((await get('settings', {})).commonLabels ?? null);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('rows')) {
          const rows = db.createObjectStore('rows', { keyPath: 'k' });
          rows.createIndex('patientId', 'patientId');
          rows.createIndex('label', 'label');
          rows.createIndex('patientLabel', ['patientId', 'label']);
        }
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('samples')) db.createObjectStore('samples', { keyPath: 'id' });
      };
      req.onsuccess = () => { _db = req.result; _db.onversionchange = () => { _db.close(); _db = null; }; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }
  const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  /** The 5 fields, plus page and history when present. */
  function cleanRow(r) {
    const c = { patientId: String(r.patientId), label: String(r.label), value: String(r.value ?? ''), time: String(r.time ?? 'nan'), source: String(r.source ?? '') };
    if (r.page) c.page = String(r.page);
    if (Array.isArray(r.history) && r.history.length) c.history = r.history;
    if (r.edited) c.edited = String(r.edited);
    return c;
  }
  /** Put one row; a stored value it replaces goes to history. */
  function putMerged(st, c) {
    const k = C().rowKey(c);
    const got = st.get(k);
    got.onsuccess = () => {
      const old = got.result;
      const row = { k, ...c };
      if (old) {
        if (!row.page && old.page) row.page = old.page;
        const h = C().withHistory(old, c);
        if (h.length) row.history = h; else delete row.history;
      }
      st.put(row);
    };
  }

  async function putRows(rows) {
    const db = await open();
    const tx = db.transaction('rows', 'readwrite');
    const st = tx.objectStore('rows');
    for (const r of rows) putMerged(st, cleanRow(r));
    await done(tx);
    await touch();
    return rows.length;
  }
  /** Change a stored value by hand: the old value goes to history and the row is marked edited (key unchanged). */
  async function editValue(row, value) {
    const db = await open();
    const tx = db.transaction('rows', 'readwrite');
    const st = tx.objectStore('rows');
    const k = C().rowKey(row);
    const got = await req(st.get(k));
    if (!got) throw new Error('That value is no longer stored.');
    if (got.value !== String(value)) {
      const stamp = C().utcStamp(new Date());
      st.put({ ...got, value: String(value), history: C().withHistory(got, { value: String(value) }, stamp), edited: stamp });
    }
    await done(tx);
    await touch();
  }
  /**
   * Save which labels are common (null = defaults) and re-key every row. Rows that now share a key (a label became
   * common) are merged into one: one value is kept, the others go to its history. Returns { rows, merged }.
   */
  async function setCommonLabels(list) {
    await saveSettings({ commonLabels: Array.isArray(list) ? list : null });
    const db = await open();
    C().setCommonLabels(Array.isArray(list) ? list : null);
    const tx = db.transaction('rows', 'readwrite');
    const st = tx.objectStore('rows');
    const all = await req(st.getAll());
    const by = new Map();
    for (const r of all) {
      const { k, ...c } = r;
      const nk = C().rowKey(c);
      const prev = by.get(nk);
      if (!prev) { by.set(nk, { k: nk, ...c }); continue; }
      const row = { k: nk, ...c, page: c.page || prev.page };
      const h = C().withHistory(prev, c);
      if (h.length) row.history = h;
      if (!row.page) delete row.page;
      by.set(nk, row);
    }
    st.clear();
    for (const r of by.values()) st.put(r);
    await done(tx);
    await touch();
    return { rows: by.size, merged: all.length - by.size };
  }
  async function deleteRows(rows) {
    const db = await open();
    const tx = db.transaction('rows', 'readwrite');
    for (const r of rows) tx.objectStore('rows').delete(r.k || C().rowKey(r));
    await done(tx);
    await touch();
  }
  async function allRows() {
    const db = await open();
    return (await req(db.transaction('rows').objectStore('rows').getAll())).map(({ k, ...r }) => r);
  }
  async function rowsByPatient(pid) {
    const db = await open();
    return (await req(db.transaction('rows').objectStore('rows').index('patientId').getAll(pid))).map(({ k, ...r }) => r);
  }
  async function rowsByLabels(labels) {
    const db = await open();
    const ix = db.transaction('rows').objectStore('rows').index('label');
    const out = [];
    for (const l of labels) out.push(...(await req(ix.getAll(l))));
    return out.map(({ k, ...r }) => r);
  }
  /** Map rowKey → stored row for the keys of the given rows (each stored row includes its page and history). */
  async function existingFor(rows) {
    const db = await open();
    const st = db.transaction('rows').objectStore('rows');
    const m = new Map();
    for (const r of rows) {
      const k = C().rowKey(r);
      const got = await req(st.get(k));
      if (got) { m.set(k, got); continue; }
      // a row without a page (from a CSV or FHIR file) that some page already gave with the same value: already saved
      if (!r.page && !C().isCommon(r.label)) {
        const same = (await req(st.index('patientLabel').getAll([String(r.patientId), String(r.label)])))
          .find((x) => x.time === String(r.time) && x.source === String(r.source) && x.value === String(r.value));
        if (same) m.set(C().sameValueKey(r), same);
      }
    }
    return m;
  }
  /** One line per patient: id, name, row count, last time. */
  async function patients() {
    const rows = await allRows();
    const by = new Map();
    for (const r of rows) {
      if (!by.has(r.patientId)) by.set(r.patientId, { patientId: r.patientId, name: '', count: 0, last: '', sources: new Set() });
      const p = by.get(r.patientId);
      p.count++; p.sources.add(r.source);
      if (r.label === 'Name' && !p.name) p.name = r.value;
      if (r.time !== 'nan' && r.time > p.last) p.last = r.time;
    }
    return [...by.values()].map((p) => ({ ...p, sources: [...p.sources] })).sort((a, b) => (b.last || '').localeCompare(a.last || ''));
  }
  /** Rewrite every row of `from` to patient `to` (merging two records of the same person). */
  async function mergePatients(from, to) {
    const rows = await rowsByPatient(from);
    await deleteRows(rows);
    await putRows(rows.map((r) => ({ ...r, patientId: to })));
    return rows.length;
  }
  async function clearAll() {
    const db = await open();
    const tx = db.transaction(['rows', 'blobs'], 'readwrite');
    tx.objectStore('rows').clear(); tx.objectStore('blobs').clear();
    await done(tx);
    await set('imageReadings', {});
    await touch();
  }

  // ── blobs ────────────────────────────────────────────────────────────
  async function sha256(blob) {
    const buf = await blob.arrayBuffer();
    const h = await crypto.subtle.digest('SHA-256', buf);
    return 'sha256:' + Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function putBlob(blob, { name = '', mime } = {}) {
    const id = await sha256(blob);
    const db = await open();
    const existing = await req(db.transaction('blobs').objectStore('blobs').get(id));
    if (!existing) {
      const tx = db.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').put({ id, blob, mime: mime || blob.type || 'application/octet-stream', size: blob.size, name, createdAt: Date.now() });
      await done(tx);
      await touch();
    }
    return id;
  }
  async function getBlob(id) { const db = await open(); return req(db.transaction('blobs').objectStore('blobs').get(id)); }
  async function allBlobMeta() {
    const db = await open();
    const out = [];
    await new Promise((res, rej) => {
      const c = db.transaction('blobs').objectStore('blobs').openCursor();
      c.onsuccess = () => { const cur = c.result; if (!cur) return res(); const { blob, ...m } = cur.value; out.push(m); cur.continue(); };
      c.onerror = () => rej(c.error);
    });
    return out;
  }

  // ── settings (chrome.storage.local) ─────────────────────────────────
  const store = () => (g.chrome && chrome.storage && chrome.storage.local) || null;
  async function get(key, dflt) { const s = store(); if (!s) return dflt; const o = await s.get(key); return o[key] ?? dflt; }
  async function set(key, val) { const s = store(); if (s) await s.set({ [key]: val }); }
  async function touch() { const m = await get('meta', {}); await set('meta', { ...m, dataVersion: (m.dataVersion || 0) + 1, lastChange: Date.now() }); }

  const getVocab = () => get('vocab', { aliases: {} });
  /** Save a learned alias (shared by extract and fill). */
  async function learnAlias(rawLabel, label, { site = null, source = 'extract' } = {}) {
    const v = await getVocab();
    const n = C().normLabel(rawLabel).norm;
    if (!n || n === C().normLabel(label).norm) return;
    v.aliases[n] = { label, ...(site ? { sites: [site] } : {}), source, createdAt: Date.now() };
    await set('vocab', v);
  }
  const getTemplates = () => get('templates', []);
  const saveTemplates = (t) => set('templates', t);

  // ── page templates and their sample pages ───────────────────────────
  /**
   * Older Capture templates (taught fields only) → page templates marked incomplete: the page is still read by the
   * rules plus these fields until its next Save, which makes the template complete.
   */
  function migrateTemplates(old) {
    const S = PDB.schema;
    const by = new Map();
    for (const t of old) {
      const key = `${t.origin}|${t.framePath || ''}`;
      if (!by.has(key)) by.set(key, { id: 'pt-' + String(t.id || Date.now()).replace(/^tpl-/, ''), v: 2, origin: t.origin, framePath: t.framePath || '', title: '', complete: false, createdAt: Date.now(), updatedAt: Date.now(), fields: [], tables: [] });
      const pt = by.get(key);
      (t.fields || []).forEach((f, i) => {
        const e = S && S.byLabel[f.label];
        pt.fields.push({ ...f, id: `${pt.id}-f${pt.fields.length}-${i}`, group: 'p', rawLabel: f.anchor || f.label, role: e && e.identity ? 'identity' : 'data',
          time: e && e.persistent ? { mode: 'nan' } : { mode: 'capture' }, from: 'taught', how: 'template' });
      });
    }
    return [...by.values()];
  }
  async function getPageTemplates() {
    const have = await get('pageTemplates', null);
    if (have) return have;
    const old = await getTemplates();
    const pts = migrateTemplates(old.filter((t) => (t.direction || 'extract') === 'extract'));
    await set('pageTemplates', pts);
    await saveTemplates(old.filter((t) => t.direction === 'fill'));
    return pts;
  }
  const savePageTemplates = async (list) => { await set('pageTemplates', list); await touch(); };
  async function savePageTemplate(t) {
    const all = await getPageTemplates();
    // by id: several templates can share one address (pages told apart by their layout or query)
    const i = all.findIndex((x) => x.id === t.id);
    if (i >= 0) all[i] = t; else all.push(t);
    await savePageTemplates(all);
  }
  async function deletePageTemplate(id) {
    await savePageTemplates((await getPageTemplates()).filter((x) => x.id !== id));
    const db = await open();
    const tx = db.transaction('samples', 'readwrite');
    tx.objectStore('samples').delete(id);
    await done(tx);
  }
  async function putSample(sample) {
    const db = await open();
    const tx = db.transaction('samples', 'readwrite');
    tx.objectStore('samples').put({ ...sample, capturedAt: sample.capturedAt || Date.now() });
    await done(tx);
  }
  async function getSample(id) { const db = await open(); return req(db.transaction('samples').objectStore('samples').get(id)); }
  async function allSamples() { const db = await open(); return req(db.transaction('samples').objectStore('samples').getAll()); }
  // another page (the dashboard) changed which labels are common → use the same row keys here
  if (g.chrome && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ch.settings) C().setCommonLabels((ch.settings.newValue || {}).commonLabels ?? null);
    });
  }
  /*
   * What Claude read from pictures (image fields), so the same picture always gives the same values and is sent once:
   *   imageReadings: { '<sha256 of the picture>|<field label>': { rows: [{ label, value, time, exact }], at } }
   * Kept on this computer only (patient values: not in exports or backups; cleared with all data). The newest 500 are kept.
   */
  const READINGS_KEEP = 500;
  async function getImageReadings(keys) {
    const all = await get('imageReadings', {});
    return Object.fromEntries(keys.filter((k) => all[k]).map((k) => [k, all[k]]));
  }
  async function putImageReading(key, reading) {
    const all = await get('imageReadings', {});
    all[key] = { rows: reading.rows || [], at: Date.now() };
    const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, READINGS_KEEP);
    await set('imageReadings', Object.fromEntries(keep));
  }
  async function forgetImageReadings(keys) {
    const all = await get('imageReadings', {});
    for (const k of keys) delete all[k];
    await set('imageReadings', all);
  }
  const getSettings = async () => {
    const saved = await get('settings', {});
    // one-time: before the model picker, the old default (Opus) was stored without being chosen → switch it to Haiku
    if (saved.ai && !saved.ai.modelChosen && saved.ai.model !== DEFAULT_AI_MODEL) {
      saved.ai = { ...saved.ai, model: DEFAULT_AI_MODEL };
      await set('settings', saved);
    }
    return { ...DEFAULT_SETTINGS, ...saved };
  };
  const saveSettings = async (patch) => set('settings', { ...(await getSettings()), ...patch });

  /** Claude models offered in Settings. fallback: the model supports the server-side refusal fallback. */
  const AI_MODELS = [
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5 (fastest, lowest cost)', fallback: false },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 (balanced)', fallback: true },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 (most accurate on hard pages)', fallback: true },
    { id: 'claude-fable-5-2', name: 'Claude Fable 5.2 (most capable, highest cost)', fallback: true },
  ];
  const DEFAULT_AI_MODEL = 'claude-haiku-5-5';

  const DEFAULT_SETTINGS = {
    backup: { enabled: false, interval: 'weekly', keep: 8, lastRun: 0, lastResult: null, lastDataVersion: 0 },
    ai: { enabled: false, apiKey: '', model: DEFAULT_AI_MODEL },
    privacy: { categories: { 'Name': 'mask', 'National ID': 'mask', 'MRN': 'mask', 'Phone': 'mask', 'Mobile': 'mask', 'Address': 'mask', 'Registered address': 'mask', 'Email': 'mask', 'Birth date': 'mask' }, customTerms: [] },
    fill: { overwrite: false },
  };

  PDB.db = { open, putRows, editValue, setCommonLabels, deleteRows, allRows, rowsByPatient, rowsByLabels, existingFor, patients, mergePatients, clearAll,
    sha256, putBlob, getBlob, allBlobMeta, get, set, getVocab, learnAlias, getTemplates, saveTemplates, getSettings, saveSettings, DEFAULT_SETTINGS, AI_MODELS, DEFAULT_AI_MODEL,
    migrateTemplates, getPageTemplates, savePageTemplates, savePageTemplate, deletePageTemplate, putSample, getSample, allSamples,
    getImageReadings, putImageReading, forgetImageReadings };
})(globalThis);
