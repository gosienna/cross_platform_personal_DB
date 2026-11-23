/*
 * Local storage.
 *   IndexedDB "pdb":
 *     rows   – the unified data: { k, patientId, label, value, time, source }   (k = internal unique key)
 *     blobs  – media bytes: { id: "sha256:…", blob, mime, size, name, createdAt }
 *   chrome.storage.local:
 *     vocab      – { aliases: { normLabel: { label, sites?, source, createdAt } } }
 *     templates  – [{ id, origin, path, direction, fields: [{ selector, anchor, label }] }]
 *     settings   – backup / AI / privacy settings
 *     meta       – { dataVersion, lastChange }  (backup uses it to know whether data changed)
 */
(function (g) {
  const PDB = (g.PDB = g.PDB || {});
  const C = () => PDB.core;
  const DB_NAME = 'pdb';
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        const rows = db.createObjectStore('rows', { keyPath: 'k' });
        rows.createIndex('patientId', 'patientId');
        rows.createIndex('label', 'label');
        rows.createIndex('patientLabel', ['patientId', 'label']);
        db.createObjectStore('blobs', { keyPath: 'id' });
      };
      req.onsuccess = () => { _db = req.result; _db.onversionchange = () => { _db.close(); _db = null; }; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }
  const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const clean5 = (r) => ({ patientId: String(r.patientId), label: String(r.label), value: String(r.value ?? ''), time: String(r.time ?? 'nan'), source: String(r.source ?? '') });

  async function putRows(rows) {
    const db = await open();
    const tx = db.transaction('rows', 'readwrite');
    const st = tx.objectStore('rows');
    for (const r of rows) { const c = clean5(r); st.put({ k: C().rowKey(c), ...c }); }
    await done(tx);
    await touch();
    return rows.length;
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
  /** Map rowKey → stored row for the keys of the given rows. */
  async function existingFor(rows) {
    const db = await open();
    const st = db.transaction('rows').objectStore('rows');
    const m = new Map();
    for (const r of rows) {
      const k = C().rowKey(r);
      const got = await req(st.get(k));
      if (got) m.set(k, got);
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
  const getSettings = async () => ({ ...DEFAULT_SETTINGS, ...(await get('settings', {})) });
  const saveSettings = async (patch) => set('settings', { ...(await getSettings()), ...patch });

  const DEFAULT_SETTINGS = {
    backup: { enabled: false, interval: 'weekly', keep: 8, lastRun: 0, lastResult: null, lastDataVersion: 0 },
    ai: { enabled: false, apiKey: '', model: 'claude-opus-5-5' },
    privacy: { categories: { 'Name': 'mask', 'National ID': 'mask', 'MRN': 'mask', 'Phone': 'mask', 'Mobile': 'mask', 'Address': 'mask', 'Registered address': 'mask', 'Email': 'mask', 'Birth date': 'mask' }, customTerms: [] },
    fill: { overwrite: false },
  };

  PDB.db = { open, putRows, deleteRows, allRows, rowsByPatient, rowsByLabels, existingFor, patients, mergePatients, clearAll,
    sha256, putBlob, getBlob, allBlobMeta, get, set, getVocab, learnAlias, getTemplates, saveTemplates, getSettings, saveSettings, DEFAULT_SETTINGS };
})(globalThis);
