// Local storage: page-aware keys, history of replaced values, common labels, exports.
const test = require('node:test');
const assert = require('node:assert/strict');
const fidb = require('fake-indexeddb');
const path = require('node:path');
const { PDB, ROOT } = require('./helpers/load.js');
globalThis.indexedDB = new fidb.IDBFactory();
globalThis.IDBKeyRange = fidb.IDBKeyRange;
require(path.join(ROOT, 'extension', 'lib', 'db.js'));
const C = PDB.core, DB = PDB.db, X = PDB.export;

const S = 'https://his.example';
const row = (label, value, time, page, pid = 'P1') => ({ patientId: pid, label, value, time, source: S, page });

test('values from two pages are both kept; a common field from another page replaces the value and keeps it in history', async () => {
  await DB.clearAll();
  await DB.putRows([row('Name', 'X', 'nan', '/a'), row('Body weight', '70', '202611230000', '/a')]);
  await DB.putRows([row('Name', 'Y', 'nan', '/b'), row('Body weight', '72', '202611230000', '/b')]);
  const rows = await DB.rowsByPatient('P1');
  assert.deepEqual(rows.filter((r) => r.label === 'Body weight').map((r) => [r.value, r.page]).sort(), [['70', '/a'], ['72', '/b']]);
  const name = rows.filter((r) => r.label === 'Name');
  assert.equal(name.length, 1);
  assert.equal(name[0].value, 'Y');
  assert.equal(name[0].page, '/b');
  assert.deepEqual(name[0].history.map((e) => [e.value, e.page]), [['X', '/a']]);
  // the same value again: history unchanged
  await DB.putRows([row('Name', 'Y', 'nan', '/b')]);
  assert.equal((await DB.rowsByPatient('P1')).find((r) => r.label === 'Name').history.length, 1);
});

test('editing a value keeps the old one in history and does not change its key', async () => {
  await DB.clearAll();
  await DB.putRows([row('Birth date', '19500101', 'nan', '/a')]);
  const [r] = await DB.rowsByPatient('P1');
  await DB.editValue(r, '19500110');
  const [e] = await DB.rowsByPatient('P1');
  assert.equal(e.value, '19500110');
  assert.ok(e.edited);
  assert.deepEqual(e.history.map((x) => [x.value, x.page]), [['19500101', '/a']]);
  assert.equal(C.rowKey(e), C.rowKey(r));
});

test('changing the common labels re-keys stored rows; values that now share a key are combined into history', async () => {
  await DB.clearAll();
  await DB.putRows([row('Body weight', '70', '202611230000', '/a'), row('Body weight', '72', '202611230000', '/b'), row('Pulse', '80', '202611230000', '/a')]);
  try {
    const res = await DB.setCommonLabels([...C.defaultCommonLabels(), 'Body weight']);
    assert.deepEqual(res, { rows: 2, merged: 1 });
    const w = (await DB.rowsByPatient('P1')).filter((r) => r.label === 'Body weight');
    assert.equal(w.length, 1);
    assert.equal(w[0].history.length, 1);
    assert.deepEqual([w[0].value, w[0].history[0].value].sort(), ['70', '72']);
    // keys still find every row
    const all = await DB.rowsByPatient('P1');
    assert.equal((await DB.existingFor(all)).size, all.length);
  } finally { await DB.setCommonLabels(null); }
});

test('restore keeps page and history; CSV stays at 5 fields; JSON keeps page and history', async () => {
  await DB.clearAll();
  const h = [{ value: 'X', page: '/a', replacedAt: '202611230000' }];
  await DB.putRows([{ ...row('Name', 'Y', 'nan', '/b'), history: h }, row('Pulse', '80', '202611230000', '/a')]);
  const rows = await DB.allRows();
  assert.deepEqual(rows.find((r) => r.label === 'Name').history, h);
  const csv = C.toCSV(rows);
  assert.ok(csv.split('\r\n').filter(Boolean).every((l) => C.parseCSV(l)[0].length === 5));
  assert.ok(!csv.includes('/a') && !csv.includes('/b'));
  const back = JSON.parse(X.toJSON(rows)).rows;
  assert.deepEqual(back.find((r) => r.label === 'Name').history, h);
  assert.equal(back.find((r) => r.label === 'Pulse').page, '/a');
});

test('re-importing a CSV export into the same database: values from pages are found as already saved', async () => {
  await DB.clearAll();
  await DB.putRows([row('Pulse', '80', '202611230000', '/a'), row('Pulse', '84', '202611230000', '/b')]);
  const fromCsv = C.parseCSV(C.toCSV(await DB.allRows())).slice(1).map(([patientId, label, value, time, source]) => ({ patientId, label, value, time, source }));
  const diff = C.diffRows(fromCsv, await DB.existingFor(fromCsv));
  assert.deepEqual(diff.map((d) => d.status), ['duplicate', 'duplicate']);
});
