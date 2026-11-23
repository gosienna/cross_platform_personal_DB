// Page templates: the rules' draft, strict reading, time links, "not in template", masked sample pages.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { PDB, fixture, ROOT } = require('./helpers/load.js');

const PT = PDB.pagetpl, C = PDB.core, D = PDB.dom;
const SRC = 'https://test.example', CAP = '202611230600';
const CTX = { origin: SRC, refYear: 2026, refDate: { y: 2026, m: 11, d: 23 } };

function rulesOf(doc) {
  const reg = D.makeRegistry();
  return D.extractFromRoot(doc, { ...CTX, registry: reg, templates: [] });
}
const draftOf = (doc) => PT.draft(doc, rulesOf(doc), { origin: SRC, framePath: '/page' });
function strict(doc, tpl) { return PT.extract(doc, tpl, { ...CTX, registry: D.makeRegistry() }); }
/** records → sorted "label | value | time" lines, plus each record's identity hints */
function rows(records) {
  const merged = C.mergeRecords(records);
  return merged.map((r) => ({ hints: r.hints, rows: C.recordToRows(r, { source: SRC, captureTime: CAP }).map((x) => `${x.label} | ${x.value} | ${x.time}`).sort() }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
const fixtures = fs.readdirSync(path.join(ROOT, 'tests', 'fixtures')).filter((f) => f.endsWith('.html'));

for (const name of fixtures) {
  test(`parity: ${name} read by its draft template = read by the rules`, () => {
    const doc = fixture(name);
    const tpl = draftOf(doc);
    assert.deepEqual(rows(strict(doc, tpl).records), rows(rulesOf(doc).records));
    assert.deepEqual(strict(doc, tpl).broken, []);
  });
}

test('a template survives a JSON round trip (it is stored as JSON)', () => {
  const doc = fixture('ltc-measure-temp.html');
  const tpl = JSON.parse(JSON.stringify(draftOf(doc)));
  assert.deepEqual(rows(strict(doc, tpl).records), rows(rulesOf(doc).records));
});

test('strict: a value the template does not know is not read, and is listed as not in the template', () => {
  const doc = fixture('zhiling-profile.html');
  const tpl = draftOf(doc);
  const before = rows(strict(doc, tpl).records);
  // the site adds a new field
  const div = doc.createElement('div');
  div.innerHTML = '<span>血型</span><span>O</span>';
  doc.body.appendChild(div);
  const res = strict(doc, tpl);
  assert.deepEqual(rows(res.records), before);
  const unc = PT.uncovered(doc, tpl, res, CTX);
  assert.ok(unc.some((u) => u.unit.label === 'Blood type' && u.value === 'O'), JSON.stringify(unc.map((u) => [u.unit.label, u.value])));
  assert.ok(!unc.some((u) => u.unit.label === 'Name'), 'fields already in the template are not offered again');
  // added → read next time
  PT.addField(tpl, unc.find((u) => u.unit.label === 'Blood type').unit, { from: 'rule' });
  assert.ok(rows(strict(doc, tpl).records)[0].rows.some((r) => r.startsWith('Blood type | O |')));
});

test('removing a field: it is not read, and not offered again', () => {
  const doc = fixture('zhiling-profile.html');
  const tpl = draftOf(doc);
  const res = strict(doc, tpl);
  const dnr = res.records.flatMap((r) => r.items).find((i) => i.label === 'DNR');
  assert.ok(dnr && dnr.fid);
  PT.removeUnit(tpl, dnr.fid);
  const res2 = strict(doc, tpl);
  assert.ok(!res2.records.flatMap((r) => r.items).some((i) => i.label === 'DNR'));
  assert.ok(!PT.uncovered(doc, tpl, res2, CTX).some((u) => u.unit.label === 'DNR'));
});

test('relabel: a field keeps its element and gets the new label (and its normalisation)', () => {
  const doc = new JSDOM('<body><table><tr><th>量測項目甲</th><td>98.6</td></tr><tr><th>姓名</th><td>測試甲</td></tr></table></body>').window.document;
  const tpl = draftOf(doc);
  const items = () => strict(doc, tpl).records.flatMap((r) => r.items);
  const it = items().find((i) => i.value === '98.6');
  assert.ok(it && it.unmapped, 'an unknown label is kept as unmapped');
  PT.setLabel(tpl, it.fid, 'Body temperature');
  const t = items().find((i) => i.label === 'Body temperature');
  assert.equal(t.value, '37'); // °F → °C, as for any temperature
});

test('time links: record date field, fixed, capture time, list time column', () => {
  const doc = new JSDOM(`<body>
    <div><span>填表日期</span><span>115/10/07</span></div>
    <div><span>姓名</span><span>測試甲</span></div>
    <div><span>體重</span><span>60</span></div>
    <div><span>身高</span><span>160</span></div></body>`).window.document;
  const tpl = draftOf(doc);
  const byLabel = (l) => tpl.fields.find((f) => f.label === l);
  const rd = tpl.fields.find((f) => f.role === 'recordDate');
  assert.ok(rd);
  assert.deepEqual(byLabel('Body weight').time, { mode: 'field', field: rd.id });
  assert.equal(PT.timeText(tpl, byLabel('Body weight')).text, '← 填表日期');
  assert.equal(PT.timeText(tpl, byLabel('Name')).text, 'fixed');
  assert.equal(PT.timeText(tpl, rd).text, 'own value');
  const timeOf = (l) => C.recordToRows(C.mergeRecords(strict(doc, tpl).records)[0], { source: SRC, captureTime: CAP }).find((r) => r.label === l).time;
  assert.equal(timeOf('Body weight'), '20261007');
  assert.equal(timeOf('Name'), 'nan');
  PT.setTime(tpl, byLabel('Body height').id, { mode: 'capture' });
  assert.equal(timeOf('Body height'), CAP);
  assert.equal(PT.timeText(tpl, byLabel('Body height')).warn, true);
  PT.setTime(tpl, byLabel('Body height').id, { mode: 'nan' });
  assert.equal(timeOf('Body height'), 'nan');
  // item knows where its time came from
  const w = strict(doc, tpl).records.flatMap((r) => r.items).find((i) => i.label === 'Body weight');
  assert.ok(w.timeRef != null);

  const list = fixture('ltc-measure-temp.html');
  const lt = draftOf(list);
  assert.equal(lt.tables.length >= 1, true);
  const t = lt.tables.find((x) => x.time.mode === 'column');
  assert.ok(t, 'a measurement list takes each row\'s time from its time column');
  assert.match(PT.timeText(lt, t).text, /^← column /);
});

test('a page record date as the time of a list without a time column', () => {
  const doc = new JSDOM(`<body><div><span>填表日期</span><span>2026/10/07</span></div>
    <table><tr><th>姓名</th><th>體溫</th><th>脈搏</th></tr><tr><td>測試甲</td><td>36.5</td><td>80</td></tr></table></body>`).window.document;
  const tpl = draftOf(doc);
  assert.equal(tpl.tables.length, 1);
  assert.equal(tpl.tables[0].time.mode, 'field');
  const all = C.mergeRecords(strict(doc, tpl).records).flatMap((r) => C.recordToRows(r, { source: SRC, captureTime: CAP }));
  assert.equal(all.find((r) => r.label === 'Body temperature').time, '20261007');
});

test('anchor: never cut in the middle of a word', () => {
  const doc = new JSDOM('<body><p>最近6個月內照護個案之特殊注意事項（如管路、跌倒、壓瘡、營養注意事項等）如有必要，請向開立本醫師意見書之醫師諮詢，其他：</p><span>某值</span></body>').window.document;
  const a = PDB.templates.anchorFor(doc.querySelector('span'));
  assert.ok(a === null || !/^意事項/.test(a), a);
});

test('sample page: masked, same structure, no scripts or network', () => {
  const doc = fixture('zhiling-profile.html');
  // a script, a remote image and an attribute with an ID, to check they are removed
  doc.body.insertAdjacentHTML('beforeend', '<script>alert(1)</script><img src="https://x.example/p.png"><a href="https://x.example/?id=A123456789">x</a><div data-id="A123456789" onclick="x()">z</div>');
  const tpl = draftOf(doc);
  const res = strict(doc, tpl);
  const html = PT.snapshot(doc, tpl, res);
  const sample = new JSDOM(html).window.document;
  // no values of the page are left
  for (const r of res.records) for (const it of r.items) {
    if (String(it.raw).length >= 2 && !/^\d{1,3}$/.test(it.raw)) assert.ok(!html.includes(it.raw), `value of ${it.label} left in the sample`);
  }
  assert.ok(!/A123456789/.test(html));
  assert.ok(!/alert\(1\)/.test(html));
  assert.ok(!/https:\/\/x\.example/.test(html));
  assert.ok(!/onclick/.test(html));
  assert.match(html, /Content-Security-Policy/);
  // every field is found in the sample by its own selector, on the element tagged with its id
  for (const f of tpl.fields) {
    if (!res.located.has(f.id)) continue;
    const tagged = sample.querySelector(`[data-pdb-f~="${f.id}"]`);
    assert.ok(tagged, `field ${f.label} tagged`);
    const p = PDB.templates.place(sample, { ...f, context: [], anchor: null }, 'extract', false, {});
    const box = p.group ? p.group.container : p.el;
    assert.equal(box, tagged, `field ${f.label} found by its selector in the sample`);
  }
  // labels of the page stay readable
  assert.match(html, /\[Name\]/);
});

test('sample page of a list: a few masked rows, table tagged', () => {
  const doc = fixture('ltc-measure-temp.html');
  const tpl = draftOf(doc);
  const res = strict(doc, tpl);
  const html = PT.snapshot(doc, tpl, res);
  const sample = new JSDOM(html).window.document;
  const t = sample.querySelector('[data-pdb-t]');
  assert.ok(t);
  assert.ok(t.rows.length <= 5);
  assert.ok(!html.includes('測試甲'));
  assert.ok(!html.includes('36.6'));
});

test('a field added on the sample page is found on the live page', () => {
  const doc = fixture('zhiling-profile.html');
  const tpl = draftOf(doc);
  const res = strict(doc, tpl);
  const sample = new JSDOM(PT.snapshot(doc, tpl, res)).window.document;
  // pick an element in the sample that is not a field: the first unmapped leaf with text
  const dnr = tpl.fields.find((f) => f.label === 'DNR');
  tpl.fields = tpl.fields.filter((f) => f.id !== dnr.id);
  const el = sample.querySelector(`[data-pdb-f~="${dnr.id}"]`);
  const nf = PT.addField(tpl, { ...PT.fieldFor({ el }), from: 'sample' }, { label: 'DNR', from: 'sample' });
  const live = strict(doc, tpl);
  assert.ok(live.changed, 'its context is learned from the live page');
  assert.ok(tpl.fields.find((f) => f.id === nf.id).live);
  assert.ok(live.records.flatMap((r) => r.items).some((i) => i.label === 'DNR' && i.value === '尚未決定'));
});

test('AI values are found on the page: new fields, relabels, and the date they belong to', () => {
  const dom = new JSDOM(`<body><table><tr><th>評估日期</th><td>115/10/07</td></tr><tr><th>姓名</th><td>測試甲</td></tr>
    <tr><th>過敏史</th><td>盤尼西林</td></tr><tr><th>其他</th><td>需協助行走</td></tr></table></body>`, { url: 'https://his.example/a/form.asp', runScripts: 'outside-only' });
  const w = dom.window;
  w.chrome = { runtime: { sendMessage() {} } };
  for (const f of ['schema.js', 'core.js', 'dom.js', 'templates.js', 'pagetpl.js', 'redact.js']) w.eval(fs.readFileSync(path.join(ROOT, 'extension', 'lib', f), 'utf8'));
  w.eval(fs.readFileSync(path.join(ROOT, 'extension', 'content', 'agent.js'), 'utf8'));
  const A = w.__pdbAgent;
  const scan = A.scan({ origin: 'https://his.example', pageTemplates: [], templates: [] });
  const tpl = JSON.parse(JSON.stringify(scan.template));
  const other = tpl.fields.find((f) => f.rawLabel === '其他');
  assert.ok(other, 'the rules read 其他 as an unmapped field');
  const items = [
    { label: 'Allergies', value: '盤尼西林', text: '盤尼西林', time: '' },              // a field already there, other label → relabel
    { label: 'Mobility note', value: '需協助行走', text: '需協助行走', time: '20261007' }, // with the form's date
    { label: 'Name', value: '測試甲', text: '測試甲', time: 'nan' },
    { label: 'Ghost', value: 'nowhere', text: 'nowhere', time: '' },
  ];
  const r = JSON.parse(JSON.stringify(A.locateValues(items, { origin: 'https://his.example', pageTemplates: [tpl] })));
  const by = (i) => r.found.find((s) => s.i === i);
  assert.ok(by(0) && ['relabel', 'same'].includes(by(0).kind));
  assert.ok(by(1) && by(1).time && by(1).time.fid, 'the time is the 評估日期 field');
  assert.equal(tpl.fields.find((f) => f.id === by(1).time.fid).role, 'recordDate');
  assert.equal(by(3), undefined, 'a value not on the page is not suggested');
});

test('sample page keeps the layout: stylesheets in place, other sites’ ones marked to fetch, pictures keep their size', () => {
  const dom = new JSDOM(`<html><head>
      <link rel="stylesheet" href="https://cdn.example/site.css">
      <style>.a { color: red; background: url(https://x.example/bg.png); } .tel { width: 0912345678px; }</style>
      <link rel="icon" href="/favicon.ico">
    </head><body>
      <img src="/logo.png" class="logo"><img src="/img/checkbox_on.gif">
      <div><span>姓名</span><span>測試甲</span></div></body></html>`, { url: 'https://his.example/p.asp' });
  const doc = dom.window.document;
  const tpl = draftOf(doc);
  const out = {};
  const html = PT.snapshot(doc, tpl, strict(doc, tpl), out);
  const s = new JSDOM(html).window.document;
  // the linked sheet → a placeholder right where the link was, before the page's own <style> (same cascade order)
  assert.deepEqual(out.external.map((x) => x.href), ['https://cdn.example/site.css']);
  const styles = [...s.querySelectorAll('head style')];
  assert.equal(styles[0].getAttribute('data-pdb-ext'), '0');
  assert.match(styles[1].textContent, /\.a\s*\{\s*color:\s*red/);
  assert.ok(!/x\.example/.test(html), 'no network address left in CSS');
  assert.match(styles[1].textContent, /0912345678px/, 'CSS is not masked as if it were page text');
  assert.ok(!html.includes('/favicon.ico'));
  // pictures: no picture, a grey box instead; a tick-box picture is still a tick box (unticked)
  const [logo, box] = s.querySelectorAll('body img');
  assert.match(logo.getAttribute('src'), /^data:image\/svg\+xml/);
  assert.ok(PDB.dom.isImgOption(box));
  assert.ok(!/checkbox_on/.test(html));
});

test('sample page: record keys made from a national ID are masked in attributes (tick-box and option values too)', () => {
  const doc = new JSDOM(`<body><div><span>姓名</span><span>測試甲</span></div>
    <input type="checkbox" value="MDA123456789419590"><select><option value="CLA123456789105">藥品甲</option></select>
    <a id="rowA123456789x" href="#">x</a></body>`).window.document;
  const tpl = draftOf(doc);
  const html = PT.snapshot(doc, tpl, strict(doc, tpl));
  assert.ok(!/A123456789/.test(html));
  assert.match(html, /藥品甲/);
});

test('a value read by two fields is one row that knows both fields; removing it removes both', () => {
  // the name shown twice (a header and a details table), as on the 居護系統 基本資料 page
  const doc = new JSDOM(`<body><div><span>姓名</span><span>測試甲</span></div>
    <table><tr><th>個案姓名</th><td>測試甲</td></tr><tr><th>性別</th><td>女</td></tr></table></body>`).window.document;
  const tpl = draftOf(doc);
  assert.equal(tpl.fields.filter((f) => f.label === 'Name').length, 2);
  const rowsOf = () => C.mergeRecords(strict(doc, tpl).records).flatMap((r) => C.recordToRows(r, { source: SRC, captureTime: CAP }));
  const name = rowsOf().filter((r) => r.label === 'Name');
  assert.equal(name.length, 1, 'one row');
  assert.equal(name[0]._fids.length, 2, 'standing for both fields');
  for (const fid of name[0]._fids) PT.removeUnit(tpl, fid);
  assert.ok(!rowsOf().some((r) => r.label === 'Name'), 'Name is gone, not brought back by the other field');
  assert.deepEqual(PT.sameLabel(tpl, 'Name', { selector: 'x' }), tpl.fields.filter((f) => f.label === 'Name'));
});

test('remove (left out, known) → restore; delete erases it and moves values timed by it to the capture time', () => {
  const doc = new JSDOM(`<body><div><span>填表日期</span><span>115/10/07</span></div><div><span>姓名</span><span>測試甲</span></div>
    <div><span>體重</span><span>60</span></div></body>`).window.document;
  const tpl = draftOf(doc);
  const labels = () => strict(doc, tpl).records.flatMap((r) => r.items).map((i) => i.label);
  const w = tpl.fields.find((f) => f.label === 'Body weight'), rd = tpl.fields.find((f) => f.role === 'recordDate');
  PT.removeUnit(tpl, w.id);
  assert.ok(!labels().includes('Body weight'));
  assert.ok(!PT.uncovered(doc, tpl, strict(doc, tpl), CTX).some((u) => u.unit.label === 'Body weight'), 'not offered again');
  PT.restoreUnit(tpl, w.id);
  assert.ok(labels().includes('Body weight'));
  assert.equal(PT.timeUsers(tpl, rd.id), 1);
  assert.equal(PT.deleteUnit(tpl, rd.id), 1);
  assert.equal(tpl.fields.find((f) => f.id === w.id).time.mode, 'capture');
  assert.ok(!tpl.fields.some((f) => f.id === rd.id));
  assert.ok(PT.uncovered(doc, tpl, strict(doc, tpl), CTX).some((u) => u.unit.rawLabel === '填表日期'), 'offered again after delete');
  // a whole table left out
  const list = fixture('ltc-measure-temp.html');
  const lt = draftOf(list);
  PT.removeUnit(lt, lt.tables[0].id);
  const res = strict(list, lt);
  assert.ok(!res.records.flatMap((r) => r.items).some((i) => i.label === 'Body temperature'));
  assert.ok(!PT.uncovered(list, lt, res, CTX).some((u) => u.unit.kind === 'table'));
});

test('page path: record IDs of any form become *, so every record of a form shares one template', () => {
  const P = PDB.templates.pagePath;
  for (const id of ['73b61871-2297-48e7-9b14-3e0c4584533b', '854dbcc2-d6a8-4925-8cdb-6c4739679d43', '627b1aea-f265-4d5d-93d8-09ebba15fbda'])
    assert.equal(P(`/v2/patients/${id}/profile`), '/v2/patients/*/profile', id);
  assert.equal(P('/api/case/5f1d7c2ab8e94a0012cd34ef/view'), '/api/case/*/view'); // hex object id
  assert.equal(P('/lcms/fh/showFh200v2/12345678'), '/lcms/fh/showFh200v2/*'); // as before
  assert.equal(P('/MEASURE.ASP'), '/MEASURE.ASP');
  assert.equal(P('/v2/patients/list'), '/v2/patients/list');
  assert.equal(P('/residents/profile-overview'), '/residents/profile-overview');
});

// ── which template is this page: layout + address ─────────────────────
const formHtml = (name, extra = '') => `<body><table>
  <tr><th>姓名</th><td>${name}</td></tr><tr><th>性別</th><td>女</td></tr><tr><th>出生日期</th><td>1950-01-02</td></tr>
  <tr><th>電話</th><td>07-1234567</td></tr><tr><th>地址</th><td>高雄市</td></tr>${extra}</table></body>`;
const medsHtml = `<body><table><tr><th>藥品名稱</th><th>劑量</th><th>頻率</th><th>開始日期</th></tr>
  <tr><td>Aspirin 100mg</td><td>1 粒</td><td>QD</td><td>2026/10/01</td></tr></table></body>`;
function savedFrom(html, path, query = '') {
  const doc = new JSDOM(html).window.document;
  return { ...PT.draft(doc, rulesOf(doc), { origin: SRC, framePath: path, query }), complete: true };
}

test('match: the same form at an address that was never seen is found by its layout', () => {
  const profile = savedFrom(formHtml('測試甲'), '/v2/patients/*/profile');
  const meds = savedFrom(medsHtml, '/v2/patients/*/meds');
  const doc = new JSDOM(formHtml('測試乙')).window.document;
  const m = PT.match(doc, [meds, profile], { path: '/v2/patients/abc-unknown/profile', query: '' }, CTX);
  assert.equal(m.decision, 'use');
  assert.equal(m.tpl.id, profile.id);
  assert.equal(m.how, 'layout');
  assert.ok(m.found >= m.total * 0.7);
  // remembered for that address: matched by address next time
  assert.ok(PT.rememberAddress(profile, { path: '/v2/patients/abc-unknown/profile', query: '' }));
  assert.equal(PT.match(doc, [meds, profile], { path: '/v2/patients/abc-unknown/profile', query: '' }, CTX).how, 'address');
});

test('match: two pages on one path, told apart by layout and by the query that picks the page', () => {
  const profile = savedFrom(formHtml('測試甲'), '/index.asp', 'func=profile');
  const meds = savedFrom(medsHtml, '/index.asp', 'func=meds');
  const pMeds = PT.match(new JSDOM(medsHtml).window.document, [profile, meds], { path: '/index.asp', query: 'func=meds' }, CTX);
  assert.equal(pMeds.tpl.id, meds.id);
  const pProf = PT.match(new JSDOM(formHtml('測試丙')).window.document, [profile, meds], { path: '/index.asp', query: 'func=profile' }, CTX);
  assert.equal(pProf.tpl.id, profile.id);
  assert.equal(C.queryKey('?func=meds&id=627b1aea-f265-4d5d-93d8-09ebba15fbda&_=1732300000&pid=12345'), 'func=meds');
});

test('match: an unrelated page is a new page; a half-matching one is asked about', () => {
  const profile = savedFrom(formHtml('測試甲'), '/a/profile');
  const other = new JSDOM('<body><table><tr><th>護理問題</th><td>跌倒</td></tr><tr><th>措施</th><td>床欄</td></tr></table></body>').window.document;
  assert.equal(PT.match(other, [profile], { path: '/b/notes', query: '' }, CTX).decision, 'none');
  // the same form with half of its rows gone (another version of the system)
  const half = new JSDOM('<body><table><tr><th>姓名</th><td>測試乙</td></tr><tr><th>性別</th><td>男</td></tr><tr><th>出生日期</th><td>1951-02-03</td></tr><tr><th>職業</th><td>無</td></tr><tr><th>宗教</th><td>無</td></tr></table></body>').window.document;
  const m = PT.match(half, [profile], { path: '/c/profile', query: '' }, CTX);
  assert.equal(m.decision, 'ask');
  // an older template with taught fields only is used by address (completed from the rules)
  const old = { ...profile, id: 'pt-old', complete: false, framePath: '/b/notes' };
  assert.equal(PT.match(other, [old], { path: '/b/notes', query: '' }, CTX).decision, 'partial');
});

test('match: a measurement list matches its own template, and not a list with the same columns for another measurement', () => {
  const temp = savedFrom(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'ltc-measure-temp.html'), 'utf8'), '/MEASURE.ASP', 'type=temp');
  const doc = fixture('ltc-measure-temp.html');
  assert.equal(PT.match(doc, [temp], { path: '/other', query: '' }, CTX).decision, 'use');
  // the same page with a glucose heading: the value column means something else
  const glu = fixture('ltc-measure-temp.html');
  for (const n of glu.querySelectorAll('h1,h2,h3,h4,.title,legend,caption')) if (/體溫/.test(n.textContent)) n.textContent = n.textContent.replace(/體溫/g, '血糖');
  const w = glu.createTreeWalker(glu.body, 4);
  for (let t = w.nextNode(); t; t = w.nextNode()) if (/體溫/.test(t.nodeValue) && !t.parentElement.closest('table')) t.nodeValue = t.nodeValue.replace(/體溫/g, '血糖');
  assert.notEqual(PT.match(glu, [temp], { path: '/other', query: '' }, CTX).decision, 'use');
});
