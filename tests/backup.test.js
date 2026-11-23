const test = require('node:test');
const assert = require('node:assert/strict');
const { PDB } = require('./helpers/load.js');

/** In-memory fake of the Drive endpoints the backup uses. */
function fakeDrive() {
  const files = new Map(); let n = 0; const calls = [];
  const fetch = async (url, opt = {}) => {
    const u = new URL(url); const m = opt.method || 'GET'; calls.push(`${m} ${u.pathname}`);
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
    if (u.pathname === '/drive/v3/files' && m === 'GET') {
      const q = u.searchParams.get('q');
      if (q.includes("mimeType='application/vnd.google-apps.folder'")) return json({ files: [...files.values()].filter((f) => f.folder).map((f) => ({ id: f.id })) });
      return json({ files: [...files.values()].filter((f) => !f.folder).map(({ data, ...f }) => f) });
    }
    if (u.pathname === '/drive/v3/files' && m === 'POST') { const b = JSON.parse(opt.body); const id = 'f' + ++n; files.set(id, { id, name: b.name, folder: true }); return json({ id }); }
    if (u.pathname === '/upload/drive/v3/files' && m === 'POST') {
      const raw = new Uint8Array(await opt.body.arrayBuffer());
      const text = new TextDecoder('latin1').decode(raw);
      const meta = JSON.parse(text.match(/\r\n\r\n(\{.*?\})\r\n/s)[1]);
      const start = text.indexOf('application/octet-stream\r\n\r\n') + 'application/octet-stream\r\n\r\n'.length;
      const end = text.lastIndexOf('\r\n--');
      const id = 'f' + ++n; files.set(id, { id, name: meta.name, appProperties: meta.appProperties, data: raw.slice(start, end) });
      return json({ id });
    }
    const dl = u.pathname.match(/^\/drive\/v3\/files\/(\w+)$/);
    if (dl && m === 'GET') return new Response(files.get(dl[1]).data);
    if (dl && m === 'DELETE') { files.delete(dl[1]); return new Response(null, { status: 204 }); }
    return json({ error: 'unexpected ' + url }, 400);
  };
  return { files, fetch, calls };
}

function deps(drive, state) {
  return {
    fetch: drive.fetch, token: async () => 'tok', passphrase: async () => state.pass,
    settings: async () => ({ backup: state.backup }), saveSettings: async (p) => { state.backup = p.backup; },
    meta: async () => ({ dataVersion: state.dataVersion }),
    snapshot: async () => ({ format: 'personal-db-backup', version: 1, rows: state.rows, vocab: { aliases: {} }, templates: [], blobs: state.blobs.map((b) => ({ id: b.id, mime: 'image/png', name: 'p.png', size: 3 })) }),
    blob: async (id) => state.blobs.find((b) => b.id === id),
    restoreData: async (snap, mode) => { state.restored = { snap, mode }; },
    hasBlob: async () => false, putBlob: async (blob) => { state.putBlobs = (state.putBlobs || 0) + 1; },
    now: () => state.now,
  };
}

test('backup: schedule rule (interval due AND data changed)', () => {
  const b = { enabled: true, interval: 'weekly', lastRun: 1000, lastDataVersion: 5 };
  assert.equal(PDB.backup.isDue(b, { dataVersion: 5 }, 1000 + 8 * 86400000).due, false); // no changes
  assert.equal(PDB.backup.isDue(b, { dataVersion: 6 }, 1000 + 2 * 86400000).due, false); // not yet
  assert.equal(PDB.backup.isDue(b, { dataVersion: 6 }, 1000 + 8 * 86400000).due, true);
  assert.equal(PDB.backup.isDue({ ...b, interval: 'manual' }, { dataVersion: 9 }, 1e15).due, false);
  assert.equal(PDB.backup.isDue({ ...b, enabled: false }, { dataVersion: 9 }, 1e15).due, false);
});

test('backup: waits for passphrase instead of failing silently', async () => {
  const drive = fakeDrive();
  const state = { pass: null, backup: { enabled: true }, rows: [], blobs: [], now: 1, dataVersion: 1 };
  const r = await PDB.backup.run({}, deps(drive, state));
  assert.equal(r.status, 'needs-passphrase');
  assert.equal(drive.calls.length, 0);
});

test('backup: encrypted upload, media uploaded once, restore decrypts', async () => {
  const drive = fakeDrive();
  const img = { id: 'sha256:' + 'b'.repeat(64), blob: new Blob([new Uint8Array([1, 2, 3])]) };
  const state = { pass: 'pw', backup: { enabled: true, keep: 2 }, rows: [{ patientId: 'N1', label: 'Name', value: '王小明', time: 'nan', source: 's' }], blobs: [img], now: Date.UTC(2026, 0, 1), dataVersion: 1 };
  const r1 = await PDB.backup.run({}, deps(drive, state));
  assert.equal(r1.status, 'ok');
  assert.equal(r1.uploadedBlobs, 1);
  // nothing readable on "Drive"
  for (const f of drive.files.values()) if (f.data) assert.ok(!Buffer.from(f.data).toString('utf8').includes('王小明'));
  state.now += 86400000; state.dataVersion = 2;
  const r2 = await PDB.backup.run({}, deps(drive, state));
  assert.equal(r2.uploadedBlobs, 0); // incremental
  state.now += 86400000; state.dataVersion = 3;
  await PDB.backup.run({}, deps(drive, state));
  const snaps = [...drive.files.values()].filter((f) => f.appProperties && f.appProperties.pdb === 'snapshot');
  assert.equal(snaps.length, 2); // keep = 2
  const rr = await PDB.backup.restore(snaps[0].id, 'pw', 'merge', deps(drive, state));
  assert.equal(rr.rows, 1);
  assert.equal(rr.restoredBlobs, 1);
  assert.equal(state.restored.snap.rows[0].value, '王小明');
  await assert.rejects(PDB.backup.restore(snaps[0].id, 'nope', 'merge', deps(drive, state)), /Wrong passphrase/);
});
