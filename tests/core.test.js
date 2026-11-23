const test = require('node:test');
const assert = require('node:assert/strict');
const { PDB } = require('./helpers/load.js');
const C = PDB.core;

test('label matching: synonyms, markers, units, cautious partial match', () => {
  assert.equal(C.resolveLabel('*姓名：').label, 'Name');
  assert.equal(C.resolveLabel('＊ 個案身分證').label, 'National ID');
  assert.equal(C.resolveLabel('體溫(°C)').label, 'Body temperature');
  assert.equal(C.resolveLabel('Heart Rate').label, 'Heart rate');
  assert.equal(C.resolveLabel('病人血壓').label, 'Blood pressure'); // known prefix
  assert.equal(C.resolveLabel('住民類別'), null); // not a name
  assert.equal(C.resolveLabel('戶籍地址 ※ (里、鄰非必填)').label, 'Registered address');
});

test('learned aliases: global, pinned to a site, ignored', () => {
  const vocab = { aliases: { '住院序號': { label: 'MRN' }, 'unit': { label: 'Ward', sites: ['https://a'] }, '客服': { label: '__ignore__' } } };
  assert.equal(C.resolveLabel('住院序號', { vocab }).label, 'MRN');
  assert.equal(C.resolveLabel('Unit', { vocab, origin: 'https://a' }).label, 'Ward');
  assert.equal(C.resolveLabel('Unit', { vocab, origin: 'https://b' }), null);
  assert.ok(C.resolveLabel('客服', { vocab }).ignore);
});

test('dates: ROC, compact ROC, US, time-only with reference date', () => {
  const iso = (s) => C.isoDate(C.parseDateTime(s));
  assert.equal(iso('040/11/09'), '1951-11-09');
  assert.equal(iso('115/10/07'), '2026-10-07');
  assert.equal(iso('1151007'), '2026-10-07');
  assert.equal(iso('20261007'), '2026-10-07');
  assert.equal(iso('11/23/2026'), '2026-11-23');
  assert.equal(iso('2026年11月23日'), '2026-11-23');
  const p = C.parseDateTime('08:30', { refDate: { y: 2026, m: 11, d: 23 } });
  assert.equal(C.formatTime(p), '202611230030'); // Asia/Taipei → UTC
  assert.equal(C.parseDateTime('4小時前').kind, 'relative');
  assert.equal(C.formatTime(C.parseDateTime('2026/10/07')), '20261007'); // date-only stays a local date
});

test('values: units, BP, sex, glucose tag, ranges, placeholders', () => {
  const V = PDB.schema.byKey;
  assert.equal(C.normalizeValue(V.temperature, '101 °F').value, '38.3');
  assert.equal(C.normalizeValue(V.bp, '144 / 100').value, '144/100');
  assert.equal(C.normalizeValue(V.sex, '(75歲) 男性').value, 'male');
  assert.deepEqual(C.normalizeValue(V.glucose, '107/HS'), { value: '107', label: 'Blood glucose (HS)', warn: undefined });
  assert.equal(C.normalizeValue(V.pulse, '400').warn, 'out_of_range');
  assert.equal(C.normalizeValue(V.birthDate, '民 年 月 日'), null);
  assert.equal(C.normalizeValue(V.weight, '150 lb', { unit: 'lb' }).value, '68');
});

test('dedup and conflicts by (patientId, label, time, source); Medication keys include the value', () => {
  const base = { patientId: 'A1', source: 's' };
  const existing = new Map([
    [C.rowKey({ ...base, label: 'Name', time: 'nan' }), { value: '王' }],
    [C.rowKey({ ...base, label: 'Body temperature', time: '202601010000' }), { value: '36.5' }],
  ]);
  const out = C.diffRows([
    { ...base, label: 'Name', value: '王', time: 'nan' },
    { ...base, label: 'Body temperature', value: '37', time: '202601010000' },
    { ...base, label: 'Medication', value: 'A', time: '202601010000' },
  ], existing);
  assert.deepEqual(out.map((r) => r.status), ['duplicate', 'changed', 'new']);
  assert.equal(out[1].oldValue, '36.5');
  assert.notEqual(C.rowKey({ ...base, label: 'Medication', time: 't', value: 'A' }), C.rowKey({ ...base, label: 'Medication', time: 't', value: 'B' }));
});

test('identity: national ID, MRN at the same site, name + birth date suggestion', () => {
  const rows = [
    { patientId: 'A123456789', label: 'Name', value: '王小明', time: 'nan', source: 'https://h' },
    { patientId: 'A123456789', label: 'Birth date', value: '1960-01-01', time: 'nan', source: 'https://h' },
    { patientId: 'A123456789', label: 'MRN', value: 'M1', time: 'nan', source: 'https://h' },
  ];
  const ix = C.buildIdentityIndex(rows);
  assert.equal(C.resolveIdentity({ nationalId: 'B1' }, 'https://x', ix).patientId, 'B1');
  assert.equal(C.resolveIdentity({ mrn: 'M1' }, 'https://h', ix).patientId, 'A123456789');
  assert.equal(C.resolveIdentity({ mrn: 'M1' }, 'https://other', ix).patientId, null);
  const s = C.resolveIdentity({ name: '王小明', birthDate: '1960-01-01' }, 'https://y', ix);
  assert.equal(s.patientId, null);
  assert.equal(s.suggestions[0].patientId, 'A123456789');
  assert.equal(C.resolveIdentity({ name: '王小明', birthDate: '1970-01-01' }, 'https://y', ix).suggestions.length, 0);
});

test('CSV: exactly 5 columns, quoting, round trip', () => {
  const rows = [{ patientId: 'N1', label: 'Medication', value: 'A, "B"; C', time: '202601011400', source: 'https://c' }];
  const csv = C.toCSV(rows);
  assert.equal(csv.split('\r\n')[0], 'patientId,label,value,time,source');
  const back = C.parseCSV(csv);
  assert.deepEqual(back[1], ['N1', 'Medication', 'A, "B"; C', '202601011400', 'https://c']);
});

test('generic CSV vitals sheet → analyzeTable list', () => {
  const grid = C.gridFromArrays(C.parseCSV('病歷號,姓名,測量時間,體溫,血壓\nM1,王小明,2026/11/01 08:00,36.8,120/80\nM1,王小明,2026/11/01 12:00,37.9,118/76\n'));
  const res = C.analyzeTable(grid, {});
  const recs = C.mergeRecords(res.records);
  assert.equal(recs.length, 1);
  const rows = C.recordToRows(recs[0], { source: 'file:x.csv', captureTime: '202611230000' });
  assert.deepEqual(rows.filter((r) => r.label === 'Blood pressure').map((r) => [r.value, r.time]), [['120/80', '202611010000'], ['118/76', '202611010400']]);
});

test('row key: values from different pages are different data points, except common labels', () => {
  const base = { patientId: 'A1', source: 'https://h', time: '202611010000' };
  const t = (page) => ({ ...base, label: 'Body temperature', value: '37', page });
  assert.notEqual(C.rowKey(t('/summary')), C.rowKey(t('/vitals')));
  // a row without a page keeps the key it had before pages were recorded
  assert.equal(C.rowKey(t('')), ['A1', 'Body temperature', '202611010000', 'https://h'].join('␟'));
  const n = (page) => ({ ...base, label: 'Name', value: 'X', time: 'nan', page });
  assert.equal(C.rowKey(n('/summary')), C.rowKey(n('/vitals')));
  // diff: another page → new; a common field that differs on another page → changed, naming the stored page
  const existing = new Map([[C.rowKey(t('/summary')), t('/summary')], [C.rowKey(n('/summary')), n('/summary')]]);
  const out = C.diffRows([{ ...t('/vitals'), value: '38' }, { ...n('/vitals'), value: 'Y' }], existing);
  assert.deepEqual(out.map((r) => r.status), ['new', 'changed']);
  assert.equal(out[1].oldPage, '/summary');
});

test('common labels: defaults are the persistent labels; a user list replaces them', () => {
  assert.ok(C.isCommon('Name') && C.isCommon('National ID') && C.isCommon('Birth date'));
  assert.ok(!C.isCommon('Body temperature'));
  C.setCommonLabels(['Body temperature']);
  try {
    assert.ok(C.isCommon('Body temperature') && !C.isCommon('Name'));
    assert.equal(C.rowKey({ patientId: 'A', label: 'Body temperature', time: 't', source: 's', page: '/a' }), C.rowKey({ patientId: 'A', label: 'Body temperature', time: 't', source: 's', page: '/b' }));
  } finally { C.setCommonLabels(null); }
  assert.ok(C.isCommon('Name'));
});

test('page path: record numbers in the path are masked', () => {
  assert.equal(C.pagePath('/case/A123456789/vitals'), '/case/*/vitals');
  assert.equal(C.pagePath('/MEDICINE.ASP'), '/MEDICINE.ASP');
  assert.equal(PDB.templates.pagePath('/p/20261123'), '/p/*');
});

test('history: replaced values are kept in order, without repeats, at most HISTORY_MAX', () => {
  const h1 = C.withHistory({ value: '70', page: '/a' }, { value: '72', page: '/b' }, '202611240000');
  assert.deepEqual(h1, [{ value: '70', page: '/a', replacedAt: '202611240000' }]);
  assert.deepEqual(C.withHistory({ value: '72', history: h1 }, { value: '72', history: h1 }), h1, 'same value: nothing added');
  let old = { value: '0', history: [] };
  for (let i = 1; i <= C.HISTORY_MAX + 5; i++) old = { value: String(i), history: C.withHistory(old, { value: String(i) }, String(i)) };
  assert.equal(old.history.length, C.HISTORY_MAX);
  assert.equal(old.history[old.history.length - 1].value, String(C.HISTORY_MAX + 4));
});
