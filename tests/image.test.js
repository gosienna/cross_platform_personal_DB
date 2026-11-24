// Image fields: a picture (chart, scanned form, photo of a meter) taught into a page template, found again on the page,
// and its values (read by Claude, kept per picture) added to the record as if read from the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const fidb = require('fake-indexeddb');
const { PDB, ROOT } = require('./helpers/load.js');

const PT = PDB.pagetpl, C = PDB.core, D = PDB.dom, T = PDB.templates;
const SRC = 'https://test.example', CAP = '202611230600';
const CTX = { origin: SRC, refYear: 2026, refDate: { y: 2026, m: 11, d: 23 } };

// synthetic page: no real patient data
const PAGE = `<html><body>
  <table id="info"><tr><th>姓名</th><td>測試一</td></tr><tr><th>填表日期</th><td>2026-11-20</td></tr></table>
  <div class="box"><span>血糖趨勢圖</span><img src="/chart/glucose.png" width="400" height="200"></div>
  <div class="opts"><img src="/img/checkbox_checked.gif">有過敏</div>
  <div class="box"><span>簽名</span><canvas width="200" height="60"></canvas></div>
</body></html>`;
const docOf = (html = PAGE) => new JSDOM(html, { url: 'https://test.example/form/1234' }).window.document;
const strict = (doc, tpl) => PT.extract(doc, tpl, { ...CTX, registry: D.makeRegistry() });

function templateWithChart(doc) {
  const reg = D.makeRegistry();
  const rules = D.extractFromRoot(doc, { ...CTX, registry: reg, templates: [] });
  const tpl = PT.draft(doc, rules, { origin: SRC, framePath: '/form/*' });
  const { value, framePath, ...f } = PT.fieldFor({ el: doc.querySelector('img[src*="glucose"]') });
  PT.addField(tpl, f, { label: 'Blood glucose', from: 'taught' });
  return tpl;
}
const rowsOf = (records) => C.mergeRecords(records).flatMap((r) => C.recordToRows(r, { source: SRC, captureTime: CAP }));

test('a picture is an image field; a tick-box picture is not', () => {
  const doc = docOf();
  assert.equal(D.pictureAt(doc.querySelector('img[src*="glucose"]')).tagName, 'IMG');
  assert.equal(D.pictureAt(doc.querySelector('canvas')).tagName, 'CANVAS');
  assert.equal(D.pictureAt(doc.querySelector('img[src*="checkbox"]')), null, 'a tick box belongs to its group');
  const f = PT.fieldFor({ el: doc.querySelector('img[src*="glucose"]') });
  assert.equal(f.kind, 'image');
  assert.equal(f.value, '');
  assert.equal(f.anchor, '血糖趨勢圖');
  const tpl = templateWithChart(doc);
  const img = tpl.fields.find((x) => x.kind === 'image');
  assert.deepEqual(img.time, { mode: 'image' }, 'by default its values take the times written in the picture');
  assert.equal(PT.timeText(tpl, img).text, 'written in the picture');
});

test('extract lists the picture (with its record) and reads no text from it', () => {
  const doc = docOf();
  const tpl = templateWithChart(doc);
  const res = strict(doc, tpl);
  assert.equal(res.images.length, 1);
  const im = res.images[0];
  assert.equal(im.label, 'Blood glucose');
  assert.equal(im.tag, 'IMG');
  assert.equal(im.mode, 'image');
  assert.ok(im.rec >= 0 && res.records[im.rec], 'the record its values belong to');
  assert.equal(res.registry.els[im.ref], doc.querySelector('img[src*="glucose"]'));
  assert.ok(!rowsOf(res.records).some((r) => r.label === 'Blood glucose'), 'nothing is read until the picture is read');
  assert.deepEqual(res.broken, []);
});

test('the picture is found again when the layout shifts, and only a picture can be it', () => {
  const doc = docOf();
  const tpl = templateWithChart(doc);
  const f = tpl.fields.find((x) => x.kind === 'image');
  // a new block before it: the selector moves, the text before it does not
  const extra = doc.createElement('div');
  extra.className = 'box';
  extra.innerHTML = '<span>體溫</span><img src="/chart/temp.png">';
  doc.querySelector('.box').before(extra);
  let p = T.place(doc, f, 'extract', false, {});
  assert.equal(p.el && p.el.getAttribute('src'), '/chart/glucose.png');
  // the picture replaced by text: not taken for the field
  const doc2 = docOf(PAGE.replace('<img src="/chart/glucose.png" width="400" height="200">', '<b>no chart</b>'));
  p = T.place(doc2, f, 'extract', false, {});
  assert.ok(!p.el || D.isPicture(p.el), 'a non-picture is never read as the picture');
  // Fill never uses image fields
  assert.equal(T.wantFor(f, 'fill', false)(doc.querySelector('img[src*="glucose"]')), false);
});

test('what Claude read from the picture becomes rows: normalised, times from the picture, estimates flagged', () => {
  const doc = docOf();
  const tpl = templateWithChart(doc);
  const res = strict(doc, tpl);
  const im = res.images[0];
  const reading = { rows: [
    { label: 'Blood glucose (AC)', value: '126', time: '2026-11-20 07:30', exact: true },
    { label: 'Blood glucose', value: '110', time: '2026-11-21 07:30', exact: true },
    { label: 'Blood glucose', value: '140', time: '', exact: false },
  ] };
  const n = PT.imageItems(res.records[im.rec], reading, im, CTX);
  assert.equal(n, 3);
  const rows = rowsOf(res.records).filter((r) => r.label.startsWith('Blood glucose'));
  const line = (r) => `${r.label} | ${r.value} | ${r.time}`;
  assert.deepEqual(rows.map(line).sort(), [
    'Blood glucose (AC) | 126 | 202611192330', // 07:30 Taipei = 23:30 UTC the day before
    `Blood glucose | 140 | ${CAP}`, // no time in the picture: capture time
    'Blood glucose | 110 | 202611202330',
  ].sort());
  const est = rows.find((r) => r.value === '140');
  assert.equal(est._item.estimated, true);
  assert.equal(est._item.warn, 'estimated_from_picture');
  assert.ok(rows.every((r) => r._item.fid === im.fid && r._item.how === 'image'));
});

test('with another time link, the picture’s values take that time (e.g. the form date)', () => {
  const doc = docOf();
  const tpl = templateWithChart(doc);
  const f = tpl.fields.find((x) => x.kind === 'image');
  const date = tpl.fields.find((x) => x.role === 'recordDate');
  assert.ok(date, 'the draft knows the form date');
  PT.setTime(tpl, f.id, { mode: 'field', field: date.id });
  const res = strict(doc, tpl);
  const im = res.images[0];
  PT.imageItems(res.records[im.rec], { rows: [{ label: 'Blood glucose', value: '99', time: '2026-01-01 08:00', exact: true }] }, im, CTX);
  const r = rowsOf(res.records).find((x) => x.label === 'Blood glucose');
  assert.equal(r.time, '20261120');
  assert.ok(r._item.timeRef != null, 'the ⏱ chip points at the form date');
});

test('the sample page keeps the picture as a grey box (no label text put inside it)', () => {
  const doc = docOf();
  const tpl = templateWithChart(doc);
  const html = PT.snapshot(doc, tpl, strict(doc, tpl));
  const s = new JSDOM(html).window.document;
  const img = s.querySelector(`[data-pdb-f="${tpl.fields.find((x) => x.kind === 'image').id}"]`);
  assert.ok(img && img.tagName === 'IMG');
  assert.equal(img.textContent, '');
  assert.ok(!/glucose\.png/.test(html), 'nothing is loaded from the network');
});

test('the text sent with a picture has identifiers masked', () => {
  globalThis.UI = globalThis.UI || {};
  require(path.join(ROOT, 'extension', 'lib', 'ai.js'));
  const settings = { privacy: { categories: {}, customTerms: [] } };
  const hint = globalThis.AIFlow.imageHint('Blood glucose', 'A123456789 血糖', settings);
  assert.ok(!hint.includes('A123456789'), hint);
  assert.ok(hint.includes('Blood glucose'));
  assert.ok(PDB.redact.finalCheck(hint, []).ok);
  assert.ok(globalThis.AIFlow.IMAGE_SCHEMA.properties.rows.items.required.includes('exact'));
});

test('readings are kept per picture and cleared with all data', async () => {
  const mem = {};
  globalThis.chrome = { storage: { local: { get: async (k) => ({ [k]: mem[k] }), set: async (o) => Object.assign(mem, o) } } };
  globalThis.indexedDB = new fidb.IDBFactory();
  globalThis.IDBKeyRange = fidb.IDBKeyRange;
  require(path.join(ROOT, 'extension', 'lib', 'db.js'));
  const DB = PDB.db;
  await DB.putImageReading('abc|Blood glucose', { rows: [{ label: 'Blood glucose', value: '120', time: '', exact: true }] });
  assert.deepEqual(Object.keys(await DB.getImageReadings(['abc|Blood glucose', 'zzz|Blood glucose'])), ['abc|Blood glucose']);
  await DB.forgetImageReadings(['abc|Blood glucose']);
  assert.deepEqual(await DB.getImageReadings(['abc|Blood glucose']), {});
  await DB.putImageReading('def|x', { rows: [] });
  await DB.clearAll();
  assert.deepEqual(await DB.getImageReadings(['def|x']), {});
  delete globalThis.chrome;
});
