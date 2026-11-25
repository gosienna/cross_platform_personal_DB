// Template check: a template compared with the live page, exported without patient values.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { PDB } = require('./helpers/load.js');

const PT = PDB.pagetpl, D = PDB.dom;
const CTX = { origin: 'https://x.test', refYear: 2026, refDate: { y: 2026, m: 11, d: 24 } };
const page = (body) => new JSDOM(`<html><head><title>住民檔案 | 王小明</title></head><body>${body}</body></html>`, { url: 'https://x.test/v2/patients/73b61871-2297-48e7-9b14-3e0c4584533b/profile' }).window.document;
const PROFILE = `<div><div class="grid">
 <div class="side"><button><h6>測試機構管理系統切換</h6></button><nav><a>首頁</a><a>住民</a></nav></div>
 <header><a><svg width="20"></svg><h6>測試長照社團法人附設測試住宿長照機構</h6></a></header>
 <section><table><tr><th>姓名</th><td>王小明</td></tr><tr><th>身分證字號</th><td>A123456789</td></tr><tr><th>床號</th><td>A01</td></tr></table></section>
</div></div>`;

function templateOf(doc) {
  const ex = D.extractFromRoot(doc, { ...CTX, registry: D.makeRegistry(), templates: [] });
  const tpl = PT.draft(doc, ex, { origin: CTX.origin, framePath: '/v2/patients/*/profile' });
  tpl.complete = true;
  const { value, framePath, ...f } = PT.fieldFor({ el: doc.querySelectorAll('h6')[1] });
  PT.addField(tpl, f, { label: 'Facility', from: 'taught' });
  return tpl;
}

test('check: every field found, with how and its context now', () => {
  const doc = page(PROFILE);
  const chk = PDB.tplcheck.check(doc, templateOf(doc), CTX);
  assert.equal(chk.format, 'personal-db-template-check');
  assert.equal(chk.page.path, '/v2/patients/*/profile');
  assert.equal(chk.summary.found, chk.summary.fields);
  assert.deepEqual(chk.summary.missing, []);
  const fac = chk.fields.find((f) => f.label === 'Facility');
  assert.equal(fac.how, 'selector');
  assert.equal(fac.now.selectorHit, true);
  assert.equal(fac.now.value.shape, '字'.repeat(18));
  assert.ok(fac.now.contextHits.every(Boolean));
});

test('check: a field that moved is reported missing, with what its selector points at now', () => {
  const doc = page(PROFILE);
  const tpl = templateOf(doc);
  const doc2 = page(PROFILE.replace('<header>', '<header><div>新公告</div>').replace('<nav><a>首頁</a><a>住民</a></nav>', '<nav><a>總覽</a></nav>'));
  const chk = PDB.tplcheck.check(doc2, tpl, CTX);
  const fac = chk.fields.find((f) => f.label === 'Facility');
  assert.equal(fac.found, false);
  assert.ok(chk.summary.missing.includes('Facility'));
  assert.ok(fac.selectorNow && fac.selectorNow.contextHits.some((x) => !x));
});

test('check: no patient values in the exported file', () => {
  const doc = page(PROFILE);
  const out = JSON.stringify(PDB.tplcheck.check(doc, templateOf(doc), CTX));
  for (const v of ['王小明', 'A123456789', '測試長照社團法人附設測試住宿長照機構']) assert.ok(!out.includes(v), `leaked ${v}`);
  assert.ok(out.includes('[Name]'), 'the title keeps a placeholder for the name');
});

test('check: text stored from another patient (context, label text) is not exported', () => {
  const docA = page(PROFILE);
  const tpl = templateOf(docA);
  const { value, framePath, ...f } = PT.fieldFor({ el: docA.querySelectorAll('td')[2] }); // its context holds patient A's name and ID
  PT.addField(tpl, f, { label: PT.IGNORE, from: 'taught' }); // shown by its label text (patient A's name)
  const docB = page(PROFILE.replace('王小明', '李大同').replace('A123456789', 'B223456789'));
  docB.title = '住民檔案 | 李大同';
  const out = JSON.stringify(PDB.tplcheck.check(docB, tpl, CTX));
  for (const v of ['王小明', 'A123456789', '李大同', 'B223456789']) assert.ok(!out.includes(v), `leaked ${v}`);
  assert.ok(out.includes('not on this page'));
  assert.ok(out.includes('"label":"Name"'), 'vocabulary labels stay readable');
});

// ── stable contexts: notices at the top of a page and patient values are no context ──
const NOTICE_A = '【個資保護提醒】已提供個人資料授權應用及知情同意書可至文件中心下載';
const NOTICE_B = '預告!!【評鑑專區功能調整公告】下週起評鑑專區將調整部分功能請留意';
const resident = ({ notice = NOTICE_A, name = '王小明', age = '77歲', birth = '1948/03/02', contact = '許測試' } = {}) => page(`<div>
 <div class="ann"><button><h6>${notice}</h6></button><button>更多公告</button></div>
 <header><a><svg width="20"></svg><h6>測試長照社團法人附設測試住宿長照機構</h6></a></header>
 <nav><a>首頁</a><a>住民資料</a><h6>住民${name}</h6></nav>
 <section><p>${name}</p><p>${age}</p>
  <div><p>收案編號</p><p>F${birth.slice(2, 4)}01</p></div><div><p>生日</p><p>${birth}</p></div>
  <table><tr><th>姓名</th><th>關係</th></tr><tr><td>${contact}</td><td>子女-兒子</td></tr></table>
 </section></div>`);
/** Drafted, the header heading taught as 'Facility' and the name as 'Name', then read once (as Scan does). */
function residentTemplate(doc) {
  const tpl = templateOf(doc);
  const { value, framePath, ...f } = PT.fieldFor({ el: doc.querySelector('section > p') });
  PT.addField(tpl, f, { label: 'Name', from: 'taught' });
  PT.extract(doc, tpl, { ...CTX, registry: D.makeRegistry() });
  return tpl;
}

test('a field after a notice at the top of the page is found when the notice changes (new and older templates)', () => {
  const a = resident();
  const tpl = residentTemplate(a);
  const b = resident({ notice: NOTICE_B, name: '李大同' });
  let res = PT.extract(b, tpl, { ...CTX, registry: D.makeRegistry() });
  assert.ok([...res.located.keys()].includes(tpl.fields.find((f) => f.label === 'Facility').id), 'found with the new notice');
  // an older template stored the notice itself (cut to 24 characters) as the text before the field
  const old = JSON.parse(JSON.stringify(tpl));
  const fac = old.fields.find((f) => f.label === 'Facility');
  fac.context = [PDB.templates.ctxKey(NOTICE_A), '更多公告'];
  res = PT.extract(b, old, { ...CTX, registry: D.makeRegistry() });
  assert.ok(res.located.has(fac.id), 'older template still finds it');
});

test('patient values are not stored as the text before a field, and the template works on the next resident', () => {
  const a = resident();
  const tpl = residentTemplate(a);
  const json = JSON.stringify(tpl);
  for (const v of ['王小明', '77歲', '1948/03/02', '19480302', 'F4801']) assert.ok(!json.includes(v), `template keeps ${v}`);
  const b = resident({ name: '李大同', age: '80歲', birth: '1945/11/20', contact: '陳測試' });
  const res = PT.extract(b, tpl, { ...CTX, registry: D.makeRegistry() });
  assert.deepEqual(res.broken.map((x) => x.label), [], 'every field found on the next resident');
  // a field taught by clicking: values of the last scan are left out (agent.js passes them)
  const values = [...PT.extract(a, tpl, { ...CTX, registry: D.makeRegistry() }).located.values()].map((l) => l.raw);
  const taught = PT.fieldFor({ el: a.querySelectorAll('td')[1] }, values.concat('許測試'));
  assert.ok(!JSON.stringify(taught.context).includes('許測試') && taught.anchor !== '許測試', 'contact name is no context or label text');
});

test('an older template drops text kept from another record when the field is found (changed → saved)', () => {
  const a = resident();
  const tpl = residentTemplate(a);
  const f = tpl.fields.find((x) => x.rawLabel === '生日' || x.anchor === '生日') || tpl.fields[0];
  f.context = ['收案編號', '舊病人名字', '生日'];
  f.anchor = '舊病人名字'; f.rawLabel = '舊病人名字';
  const res = PT.extract(resident({ name: '李大同' }), tpl, { ...CTX, registry: D.makeRegistry() });
  assert.ok(res.located.has(f.id));
  assert.equal(res.changed, true);
  assert.ok(!JSON.stringify(f).includes('舊病人名字'), 'the old text is gone');
});

test('the dashboard export: a template checked against its masked sample page', () => {
  const a = resident();
  const tpl = residentTemplate(a);
  const html = PT.snapshot(a, tpl, PT.extract(a, tpl, { ...CTX, registry: D.makeRegistry() }));
  const sample = new JSDOM(html).window.document;
  const chk = PDB.tplcheck.check(sample, tpl, { origin: CTX.origin, page: { path: '/v2/patients/*/profile', query: '' }, source: 'sample' });
  assert.equal(chk.source, 'sample');
  assert.equal(chk.page.path, '/v2/patients/*/profile');
  assert.equal(chk.summary.found, chk.summary.fields);
  const out = JSON.stringify(chk);
  for (const v of ['王小明', '1948/03/02', '許測試']) assert.ok(!out.includes(v), `leaked ${v}`);
});
