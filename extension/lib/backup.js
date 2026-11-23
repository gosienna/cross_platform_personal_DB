/*
 * Encrypted, incremental Google Drive backup (scope drive.file: the extension only sees files it created).
 *   Folder "PersonalDB Backups":
 *     pdb-YYYYMMDD-HHmm.rows.enc   snapshot: all rows + vocabulary + templates (newest `keep` are kept)
 *     <sha256>.enc                  one file per media blob, uploaded once
 * Every file is encrypted with PDB.crypto before it leaves the browser.
 */
(function (g) {
  const PDB = (g.PDB = g.PDB || {});
  const FOLDER = 'PersonalDB Backups';
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  const DAY = 86400000;
  const INTERVAL = { daily: DAY, weekly: 7 * DAY, monthly: 30 * DAY, manual: Infinity };

  /** Real dependencies (overridable in tests). */
  function defaultDeps() {
    return {
      fetch: (...a) => g.fetch(...a),
      token: (interactive) => new Promise((res, rej) => chrome.identity.getAuthToken({ interactive }, (t) => {
        if (chrome.runtime.lastError || !t) rej(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Google sign-in failed'));
        else res(typeof t === 'string' ? t : t.token);
      })),
      passphrase: () => PDB.crypto.getPassphrase(),
      settings: () => PDB.db.getSettings(),
      saveSettings: (p) => PDB.db.saveSettings(p),
      meta: () => PDB.db.get('meta', {}),
      snapshot: async () => ({ format: 'personal-db-backup', version: 1, createdAt: new Date().toISOString(), rows: await PDB.db.allRows(), vocab: await PDB.db.getVocab(), templates: await PDB.db.getTemplates(), blobs: await PDB.db.allBlobMeta() }),
      blob: (id) => PDB.db.getBlob(id),
      restoreData: async (snap, mode) => {
        if (mode === 'replace') await PDB.db.clearAll();
        await PDB.db.putRows(snap.rows);
        const v = await PDB.db.getVocab();
        await PDB.db.set('vocab', { aliases: { ...(mode === 'replace' ? {} : v.aliases), ...(snap.vocab?.aliases || {}) } });
        if (mode === 'replace') await PDB.db.saveTemplates(snap.templates || []);
        else { const t = await PDB.db.getTemplates(); const ids = new Set(t.map((x) => x.id)); await PDB.db.saveTemplates(t.concat((snap.templates || []).filter((x) => !ids.has(x.id)))); }
      },
      hasBlob: async (id) => !!(await PDB.db.getBlob(id)),
      putBlob: (blob, meta) => PDB.db.putBlob(blob, meta),
      now: () => Date.now(),
    };
  }

  // ── Drive REST ───────────────────────────────────────────────────────
  function drive(deps, token) {
    const auth = { Authorization: `Bearer ${token}` };
    const j = async (url, opt = {}) => {
      const r = await deps.fetch(url, { ...opt, headers: { ...auth, ...(opt.headers || {}) } });
      if (!r.ok) throw new Error(`Google Drive error ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.status === 204 ? null : r.json();
    };
    return {
      async folder() {
        const q = encodeURIComponent(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
        const r = await j(`${API}/files?q=${q}&fields=files(id)&spaces=drive`);
        if (r.files && r.files.length) return r.files[0].id;
        const c = await j(`${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' }) });
        return c.id;
      },
      async list(folderId) {
        const out = [];
        let page = '';
        do {
          const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
          const r = await j(`${API}/files?q=${q}&fields=nextPageToken,files(id,name,size,createdTime,appProperties)&pageSize=1000${page ? '&pageToken=' + page : ''}`);
          out.push(...(r.files || []));
          page = r.nextPageToken || '';
        } while (page);
        return out;
      },
      async upload(folderId, name, bytes, appProperties) {
        const meta = { name, parents: [folderId], appProperties };
        if (bytes.length < 5 * 1024 * 1024) {
          const boundary = 'pdb' + Math.random().toString(16).slice(2);
          const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`, bytes, `\r\n--${boundary}--`]);
          return j(`${UPLOAD}?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
        }
        const r = await deps.fetch(`${UPLOAD}?uploadType=resumable&fields=id`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(bytes.length) }, body: JSON.stringify(meta) });
        if (!r.ok) throw new Error(`Google Drive error ${r.status}`);
        const loc = r.headers.get('Location');
        const up = await deps.fetch(loc, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
        if (!up.ok) throw new Error(`Google Drive upload error ${up.status}`);
        return up.json();
      },
      async download(id) {
        const r = await deps.fetch(`${API}/files/${id}?alt=media`, { headers: auth });
        if (!r.ok) throw new Error(`Google Drive error ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      },
      remove: (id) => j(`${API}/files/${id}`, { method: 'DELETE' }),
    };
  }

  const stampName = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `pdb-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}.rows.enc`; };

  /** Is a scheduled backup due? */
  function isDue(b, meta, now) {
    if (!b || !b.enabled) return { due: false, why: 'off' };
    if ((meta.dataVersion || 0) === (b.lastDataVersion || 0) && b.lastRun) return { due: false, why: 'no changes' };
    if (now - (b.lastRun || 0) < (INTERVAL[b.interval] ?? INTERVAL.weekly)) return { due: false, why: 'not yet' };
    return { due: true };
  }

  async function runIfDue(opts = {}, deps = defaultDeps()) {
    const s = await deps.settings();
    const d = isDue(s.backup, await deps.meta(), deps.now());
    if (!d.due) return { status: 'skipped', why: d.why };
    return run(opts, deps);
  }

  /** Back up now: snapshot + new blobs, then prune. */
  async function run({ interactive = false } = {}, deps = defaultDeps()) {
    const settings = await deps.settings();
    const b = settings.backup || {};
    const pass = await deps.passphrase();
    if (!pass) { await deps.saveSettings({ backup: { ...b, lastResult: { status: 'needs-passphrase', at: deps.now() } } }); return { status: 'needs-passphrase' }; }
    try {
      const token = await deps.token(interactive);
      const dv = drive(deps, token);
      const folder = await dv.folder();
      const files = await dv.list(folder);
      const enc = await PDB.crypto.session(pass);
      const meta = await deps.meta();
      const snap = await deps.snapshot();
      // 1. media blobs not on Drive yet
      const onDrive = new Set(files.filter((f) => f.appProperties && f.appProperties.pdb === 'blob').map((f) => f.appProperties.hash));
      let uploaded = 0;
      for (const m of snap.blobs || []) {
        if (onDrive.has(m.id.slice(7))) continue;
        const rec = await deps.blob(m.id);
        if (!rec) continue;
        const bytes = await enc.encrypt(new Uint8Array(await rec.blob.arrayBuffer()));
        await dv.upload(folder, `${m.id.slice(7)}.enc`, bytes, { pdb: 'blob', hash: m.id.slice(7) });
        uploaded++;
      }
      // 2. snapshot
      const now = deps.now();
      const snapBytes = await enc.encrypt(new TextEncoder().encode(JSON.stringify(snap)));
      const created = await dv.upload(folder, stampName(now), snapBytes, { pdb: 'snapshot', rows: String(snap.rows.length), blobs: String((snap.blobs || []).length) });
      // 3. prune old snapshots; prune blobs no kept snapshot references (only when we know the references)
      const keep = b.keep || 8;
      const known = { ...(b.snapshotBlobs || {}) };
      known[created.id] = (snap.blobs || []).map((x) => x.id.slice(7));
      const snaps = files.filter((f) => f.appProperties && f.appProperties.pdb === 'snapshot').sort((x, y) => (y.name > x.name ? 1 : -1));
      const kept = [created.id, ...snaps.slice(0, keep - 1).map((f) => f.id)];
      for (const f of snaps.slice(keep - 1)) { await dv.remove(f.id); delete known[f.id]; }
      let pruned = 0;
      if (kept.every((id) => known[id])) {
        const refs = new Set(kept.flatMap((id) => known[id]));
        for (const f of files.filter((x) => x.appProperties && x.appProperties.pdb === 'blob' && !refs.has(x.appProperties.hash))) { await dv.remove(f.id); pruned++; }
      }
      for (const id of Object.keys(known)) if (!kept.includes(id)) delete known[id];
      const result = { status: 'ok', at: now, rows: snap.rows.length, uploadedBlobs: uploaded, prunedBlobs: pruned, snapshot: created.id };
      await deps.saveSettings({ backup: { ...b, lastRun: now, lastDataVersion: meta.dataVersion || 0, lastResult: result, snapshotBlobs: known } });
      return result;
    } catch (e) {
      const result = { status: 'error', at: deps.now(), message: String(e.message || e) };
      await deps.saveSettings({ backup: { ...b, lastResult: result } });
      return result;
    }
  }

  async function listBackups(deps = defaultDeps()) {
    const dv = drive(deps, await deps.token(true));
    const files = await dv.list(await dv.folder());
    return files.filter((f) => f.appProperties && f.appProperties.pdb === 'snapshot').sort((a, b) => (b.name > a.name ? 1 : -1));
  }

  /** Restore a snapshot (merge or replace) and download the media it references. */
  async function restore(fileId, passphrase, mode = 'merge', deps = defaultDeps()) {
    const dv = drive(deps, await deps.token(true));
    const folder = await dv.folder();
    const snap = JSON.parse(new TextDecoder().decode(await PDB.crypto.decrypt(await dv.download(fileId), passphrase)));
    if (snap.format !== 'personal-db-backup') throw new Error('Not a Personal DB snapshot');
    await deps.restoreData(snap, mode);
    const files = await dv.list(folder);
    const blobFiles = new Map(files.filter((f) => f.appProperties && f.appProperties.pdb === 'blob').map((f) => [f.appProperties.hash, f.id]));
    let restored = 0, missing = 0;
    for (const m of snap.blobs || []) {
      if (await deps.hasBlob(m.id)) continue;
      const fid = blobFiles.get(m.id.slice(7));
      if (!fid) { missing++; continue; }
      const bytes = await PDB.crypto.decrypt(await dv.download(fid), passphrase);
      await deps.putBlob(new Blob([bytes], { type: m.mime }), { name: m.name, mime: m.mime });
      restored++;
    }
    return { rows: snap.rows.length, restoredBlobs: restored, missingBlobs: missing };
  }

  PDB.backup = { run, runIfDue, isDue, listBackups, restore, stampName, INTERVAL, FOLDER };
})(globalThis);
