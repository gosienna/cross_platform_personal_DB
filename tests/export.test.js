const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PDB } = require('./helpers/load.js');

const rows = [
  { patientId: 'A223456789', label: 'Name', value: '測試丁', time: 'nan', source: 'https://h' },
  { patientId: 'A223456789', label: 'Sex', value: 'female', time: 'nan', source: 'https://h' },
  { patientId: 'A223456789', label: 'Birth date', value: '1950-01-02', time: 'nan', source: 'https://h' },
  { patientId: 'A223456789', label: 'MRN', value: 'M9', time: 'nan', source: 'https://h' },
  { patientId: 'A223456789', label: 'Blood pressure', value: '144/100', time: '202601011400', source: 'https://c' },
  { patientId: 'A223456789', label: 'Body temperature', value: '38.3', time: '202601011400', source: 'https://c' },
  { patientId: 'A223456789', label: 'Blood glucose (HS)', value: '107', time: '202601011445', source: 'https://c' },
  { patientId: 'A223456789', label: 'Medication', value: 'Kascoal 40 mg; 1 粒; QID', time: '202610070900', source: 'https://c' },
];

test('FHIR export: Patient, LOINC vitals, BP panel, medication; and back to rows', () => {
  const b = PDB.export.toFHIR(rows);
  const res = b.entry.map((e) => e.resource);
  const p = res.find((r) => r.resourceType === 'Patient');
  assert.equal(p.gender, 'female');
  assert.equal(p.birthDate, '1950-01-02');
  const bp = res.find((r) => r.code && r.code.coding && r.code.coding[0].code === '85354-9');
  assert.equal(bp.component[0].valueQuantity.value, 144);
  assert.equal(bp.effectiveDateTime, '2026-01-01T14:00:00Z');
  assert.ok(res.some((r) => r.resourceType === 'MedicationStatement'));
  const back = PDB.export.fromFHIR(b);
  for (const l of ['Name', 'Blood pressure', 'Body temperature', 'Blood glucose (HS)', 'Medication', 'MRN']) {
    const a = rows.find((r) => r.label === l), z = back.find((r) => r.label === l);
    assert.ok(z, l);
    assert.equal(z.value, a.value, l);
    assert.equal(z.time, a.time, l);
  }
});

test('zip: valid archive (unzip -t) with data and media, and readable back', async () => {
  const blob = new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], { type: 'image/png' });
  const hash = 'sha256:' + 'a'.repeat(64);
  const withMedia = rows.concat([{ patientId: 'A223456789', label: 'Photo', value: hash, time: '202601011415', source: 'https://c' }]);
  const out = await PDB.export.exportFile(withMedia, 'csv', { getBlob: async () => ({ blob, mime: 'image/png', name: 'x.png' }) });
  assert.match(out.name, /\.zip$/);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pdb-')), out.name);
  fs.writeFileSync(f, Buffer.from(await out.blob.arrayBuffer()));
  const t = execFileSync('unzip', ['-t', f]).toString();
  assert.match(t, /No errors detected/);
  const back = await PDB.export.readImport(new File([fs.readFileSync(f)], out.name));
  assert.equal(back.kind, 'rows');
  assert.equal(back.rows.length, withMedia.length);
  assert.equal(back.media.length, 1);
});

test('import: native CSV, JSON, and a generic sheet goes to the mapping preview', async () => {
  const csv = await PDB.export.readImport(new File([PDB.core.toCSV(rows)], 'x.csv'));
  assert.deepEqual(csv.rows, rows);
  const json = await PDB.export.readImport(new File([PDB.export.toJSON(rows)], 'x.json'));
  assert.deepEqual(json.rows, rows);
  const generic = await PDB.export.readImport(new File(['姓名,體溫,時間\n王,36.5,2026/1/1 08:00\n'], 'vitals.csv'));
  assert.equal(generic.kind, 'grid');
});

test('crypto: round trip; wrong passphrase fails', async () => {
  const s = await PDB.crypto.session('correct horse');
  const ct = await s.encrypt(new TextEncoder().encode('秘密 data'));
  assert.equal(new TextDecoder().decode(await PDB.crypto.decrypt(ct, 'correct horse')), '秘密 data');
  await assert.rejects(PDB.crypto.decrypt(ct, 'wrong'), /Wrong passphrase/);
  assert.ok(!Buffer.from(ct).toString('utf8').includes('data'));
});
