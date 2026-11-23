// Loads the side panel and dashboard pages in jsdom with a stubbed chrome API and an in-memory IndexedDB,
// to catch start-up errors and check the main dashboard paths (import → patient view → export).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { ROOT } = require('./helpers/load.js');

function chromeStub() {
  const local = {}, session = {};
  const area = (o) => ({ get: async (k) => (typeof k === 'string' ? { [k]: o[k] } : { ...o }), set: async (v) => Object.assign(o, v) });
  return {
    storage: { local: area(local), session: area(session) },
    runtime: { onMessage: { addListener() {} }, sendMessage() {}, getManifest: () => JSON.parse(fs.readFileSync(path.join(ROOT, 'extension/manifest.json'))), getURL: (p) => p },
    tabs: { query: async () => [{ id: 1, url: 'https://his.example/p', windowId: 1 }] },
    scripting: { executeScript: async () => [] },
    action: { setBadgeText() {} },
  };
}

async function loadPage(rel, tabPage, { query = '', idb = null, storage = null } = {}) {
  const file = path.join(ROOT, 'extension', rel);
  const html = fs.readFileSync(file, 'utf8');
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Could not load script|not implemented/i.test(e.message)) errors.push(e.message); });
  const dom = new JSDOM(html.replace(/<script src="[^"]+"><\/script>/g, ''), { url: 'chrome-extension://x/' + rel + query, runScripts: 'outside-only', virtualConsole: vc, pretendToBeVisual: true });
  const w = dom.window;
  const fidb = require('fake-indexeddb');
  w.indexedDB = idb || new fidb.IDBFactory();
  w.IDBKeyRange = fidb.IDBKeyRange;
  w.chrome = chromeStub();
  if (storage) w.chrome.storage = storage;
  if (tabPage) {
    // a simulated tab: executeScript injects files into / runs functions in the page's own window
    w.chrome.tabs.query = async () => [{ id: 1, url: tabPage.url, windowId: 1 }];
    w.chrome.scripting.executeScript = async ({ files, func, args }) => {
      const pw = tabPage.dom.window;
      if (files) { for (const f of files) pw.eval(fs.readFileSync(path.join(ROOT, 'extension', f), 'utf8')); return [{ frameId: 0, result: null }]; }
      const res = await pw.eval(`(${func.toString()})`)(...(args || []));
      return [{ frameId: 0, result: res === undefined ? null : JSON.parse(JSON.stringify(res)) }];
    };
  }
  w.crypto.subtle || Object.defineProperty(w.crypto, 'subtle', { value: globalThis.crypto.subtle });
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  w.Blob = Blob; w.File = File; w.Response = Response; w.structuredClone = structuredClone;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function (v) { this.returnValue = v || ''; this.open = false; this.onclose && this.onclose(); };
  w.URL.createObjectURL = () => 'blob:x';
  for (const m of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
    const src = path.join(path.dirname(file), m[1]);
    if (!fs.existsSync(src)) continue;
    try { w.eval(fs.readFileSync(src, 'utf8')); } catch (e) { errors.push(`${m[1]}: ${e.message}`); }
  }
  await new Promise((r) => setTimeout(r, 100));
  return { w, errors };
}
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test('side panel starts without errors', async () => {
  const { w, errors } = await loadPage('sidepanel/sidepanel.html');
  assert.deepEqual(errors, []);
  assert.ok(w.document.querySelector('#scan'));
  assert.ok(w.AIFlow && w.Anthropic, 'AI flow and bundled SDK loaded');
});

test('dashboard: import native CSV → patient view with trend chart → export', async () => {
  const { w, errors } = await loadPage('dashboard/dashboard.html');
  assert.deepEqual(errors, []);
  const rows = [
    ['patientId', 'label', 'value', 'time', 'source'],
    ['N1', 'Name', '測試辛', 'nan', 'https://h'],
    ['N1', 'Body temperature', '36.5', '202611010000', 'https://h'],
    ['N1', 'Body temperature', '37.2', '202611020000', 'https://h'],
    ['N1', 'Blood pressure', '120/80', '202611010000', 'https://h'],
    ['N1', 'Blood pressure', '135/88', '202611020000', 'https://h'],
  ].map((r) => r.join(',')).join('\n');
  const file = new w.File([rows], 'export.csv', { type: 'text/csv' });
  const input = w.document.querySelector('#file');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new w.Event('change'));
  await tick(300);
  const btn = [...w.document.querySelectorAll('#imp button')].find((b) => b.textContent === 'Import');
  assert.ok(btn, 'import preview shown');
  assert.match(w.document.querySelector('#imp').textContent, /1 patients · 5 rows · 5 new/);
  btn.click();
  await tick(300);
  assert.match(w.document.querySelector('#imp').textContent, /Imported 5 rows/);
  w.document.querySelector('[data-view="patients"]').click();
  await tick(300);
  w.document.querySelector('.plist tbody tr').dispatchEvent(new w.Event('click'));
  await tick(400);
  const pv = w.document.querySelector('#pview');
  assert.match(pv.textContent, /測試辛/);
  assert.equal(pv.querySelectorAll('.viz').length, 2); // temperature + blood pressure
  const bp = [...pv.querySelectorAll('.viz')].find((v) => v.querySelector('h4').textContent === 'Blood pressure');
  assert.equal(bp.querySelectorAll('path').length, 2); // systolic + diastolic
  // generic sheet import preview
  const sheet = new w.File(['病歷號,姓名,測量時間,體溫\nM1,測試壬,2026/11/01 08:00,36.8\nM1,測試壬,2026/11/01 12:00,37.9\n'], 'vitals.csv');
  w.document.querySelector('[data-view="import"]').click();
  Object.defineProperty(input, 'files', { value: [sheet], configurable: true });
  input.dispatchEvent(new w.Event('change'));
  await tick(400);
  assert.match(w.document.querySelector('#imp').textContent, /record\(s\) need a patient ID|1 patients · /);
  assert.deepEqual(errors, []);
});

function tab(fixtureName, url) {
  const html = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', fixtureName), 'utf8');
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.chrome = { runtime: { sendMessage() {} } };
  return { dom, url };
}

test('side panel: scan → preview (search, highlights switch) → save → fill another form', async () => {
  const page = tab('ltc-medicine.html', 'https://ltc.example/MEDICINE.ASP');
  const { w, errors } = await loadPage('sidepanel/sidepanel.html', page);
  w.document.querySelector('#scan').click();
  await tick(500);
  assert.deepEqual(errors, []);
  assert.match(w.document.querySelector('#status').textContent, /1 patient · 5 values found/);
  assert.equal(w.document.querySelector('input.pid').value, 'A223456789');
  // a new page: read by a draft template from the built-in rules; every row shows where its time comes from
  assert.ok(w.document.querySelector('.pagebar.draft'), 'draft template banner');
  assert.equal(w.document.querySelectorAll('#records .chip').length, 5);
  // the page got an overlay, but its own content is unchanged
  assert.ok(page.dom.window.document.getElementById('pdb-overlay-host'));
  // search: narrows the list (and the page outlines); clearing it brings everything back
  const D = w.document, rowsShown = () => D.querySelectorAll('#records tbody tr').length;
  const search = (q) => { D.querySelector('#capSearch').value = q; D.querySelector('#capSearch').dispatchEvent(new w.Event('input')); };
  assert.equal(D.querySelector('#capTools').hidden, false);
  assert.equal(D.querySelector('#capCount').textContent, '5 rows');
  const firstLabel = D.querySelector('#records tbody td.l').textContent;
  search('no-such-field');
  await tick(100);
  assert.equal(rowsShown(), 0);
  assert.equal(D.querySelector('#capCount').textContent, '0 of 5');
  assert.ok(!page.dom.window.document.getElementById('pdb-overlay-host'), 'no outlines for hidden rows');
  search(firstLabel.toLowerCase());
  await tick(100);
  assert.ok(rowsShown() >= 1 && [...D.querySelectorAll('#records tbody td.l')].every((td) => td.textContent === firstLabel));
  search('');
  await tick(100);
  assert.equal(rowsShown(), 5);
  // highlights switch: off removes the outlines, on paints them again
  D.querySelector('#capMarks').click();
  await tick(100);
  assert.equal(D.querySelector('#capMarks').textContent, 'Highlights: off');
  assert.ok(!page.dom.window.document.getElementById('pdb-overlay-host'));
  D.querySelector('#capMarks').click();
  await tick(100);
  assert.ok(page.dom.window.document.getElementById('pdb-overlay-host'));
  w.document.querySelector('#save').click();
  await tick(400);
  assert.match(w.document.querySelector('#status').textContent, /Saved 5 values for 1 patient\. Page template saved/);
  const pts = await w.PDB.db.getPageTemplates();
  assert.equal(pts.length, 1);
  assert.equal(pts[0].complete, true);
  assert.equal(pts[0].origin, 'https://ltc.example');
  const sample = await w.PDB.db.getSample(pts[0].id);
  assert.ok(sample && /data-pdb-t=/.test(sample.html), 'masked sample page saved');
  assert.ok(!sample.html.includes('A223456789'), 'no national ID in the sample');
  // scanning again: read strictly by the saved template; everything is a duplicate now and unticked
  w.document.querySelector('#scan').click();
  await tick(500);
  assert.ok(w.document.querySelector('.pagebar') && !w.document.querySelector('.pagebar.draft'), 'strict template banner');
  assert.match(w.document.querySelector('#status').textContent, /5 values found/);
  assert.ok([...w.document.querySelectorAll('.badge')].some((b) => b.textContent === 'already saved'));
  assert.ok([...w.document.querySelectorAll('#records tbody input[type=checkbox]')].every((c) => !c.checked));

  // fill: same side panel, now on a referral form
  const form = tab('referral-form.html', 'https://clinic.example/referral');
  const w2 = await loadPage('sidepanel/sidepanel.html', form);
  w2.w.indexedDB = w.indexedDB; // same database
  w2.w.document.querySelector('[data-tab="fill"]').click();
  await tick(300);
  assert.equal(w2.w.document.querySelector('#fillPatient').value, 'A223456789');
  w2.w.document.querySelector('#fillScan').click();
  await tick(400);
  assert.match(w2.w.document.querySelector('#fillStatus').textContent, /form fields · \d+ can be filled/);
  // search the form fields by stored value; the hidden ones are still filled (search only narrows the view)
  const F = w2.w.document, fsearch = (q) => { F.querySelector('#fillSearch').value = q; F.querySelector('#fillSearch').dispatchEvent(new w2.w.Event('input')); };
  const nFields = F.querySelectorAll('#fillList tbody tr').length;
  fsearch('A223456789');
  await tick(100);
  assert.ok(F.querySelectorAll('#fillList tbody tr').length >= 1 && F.querySelectorAll('#fillList tbody tr').length < nFields);
  assert.match(F.querySelector('#fillCount').textContent, new RegExp(`^\\d+ of ${nFields}$`));
  assert.equal(F.querySelector('#fillMarks').textContent, 'Highlights: on');
  w2.w.document.querySelector('#fillApply').click();
  await tick(300);
  const fd = form.dom.window.document;
  assert.equal(fd.querySelector('#pname').value, '測試丁');
  assert.equal(fd.querySelector('#idno').value, 'A223456789');
  assert.match(w2.w.document.querySelector('#fillStatus').textContent, /Filled \d+ fields/);
  w2.w.document.querySelector('#fillUndo').click();
  await tick(200);
  assert.equal(fd.querySelector('#pname').value, '');
  assert.deepEqual(w2.errors, []);
});

test('dashboard: Mappings shows a page template with its sample page, labels and time links; edits are saved', async () => {
  const { PDB } = require('./helpers/load.js');
  const doc = new JSDOM(`<body><div><span>填表日期</span><span>115/10/07</span></div><div><span>姓名</span><span>測試甲</span></div>
    <div><span>體重</span><span>60</span></div></body>`).window.document;
  const ex = PDB.dom.extractFromRoot(doc, { origin: 'https://his.example', registry: PDB.dom.makeRegistry(), templates: [] });
  const tpl = { ...PDB.pagetpl.draft(doc, ex, { origin: 'https://his.example', framePath: '/form/*', title: 'Assessment' }), complete: true };
  const html = PDB.pagetpl.snapshot(doc, tpl, PDB.pagetpl.extract(doc, tpl, { registry: PDB.dom.makeRegistry() }));
  const { w, errors } = await loadPage('dashboard/dashboard.html');
  await w.PDB.db.savePageTemplate(JSON.parse(JSON.stringify(tpl)));
  await w.PDB.db.putSample({ id: tpl.id, html, width: 900 });
  w.document.querySelector('[data-view="mappings"]').click();
  await tick(200);
  assert.deepEqual(errors, []);
  const row = [...w.document.querySelectorAll('#ptList tbody tr')].find((tr) => tr.textContent.includes('/form/*'));
  assert.ok(row, 'page template listed');
  row.click();
  await tick(200);
  const D = w.document;
  const fieldRow = (label) => [...D.querySelectorAll('#ptDetail tr[data-u]')].find((tr) => tr.querySelector('td').textContent.includes(label));
  assert.ok(D.querySelector('#ptDetail iframe.smp-frame'), 'sample page shown');
  // the field list is a side panel: hidden at first, shown with its button; no new-tab page any more
  const panel = D.querySelector('#ptDetail .tpl-fields');
  assert.equal(panel.hidden, true, 'field list hidden by default');
  D.querySelector('#ptDetail .listbtn').click();
  assert.equal(panel.hidden, false);
  assert.ok(![...D.querySelectorAll('#ptDetail button')].some((b) => /new tab/i.test(b.textContent)));
  assert.match(fieldRow('Body weight').textContent, /⏱ ← 填表日期/);
  assert.match(fieldRow('Name').textContent, /⏱ fixed/);
  // edit: weight's time → capture time
  fieldRow('Body weight').querySelector('button').click();
  await tick(50);
  const cap = [...D.querySelectorAll('#dlgForm input[name=tl]')].find((r) => r.value === 'capture');
  cap.checked = true; cap.dispatchEvent(new w.Event('change'));
  [...D.querySelectorAll('#dlgForm button')].find((b) => b.value === 'ok').click();
  D.querySelector('#dlg').close('ok');
  await tick(200);
  const saved = (await w.PDB.db.getPageTemplates())[0];
  assert.equal(JSON.stringify(saved.fields.find((f) => f.label === 'Body weight').time), JSON.stringify({ mode: 'capture' }));
  assert.match(fieldRow('Body weight').textContent, /capture time ⚠/);
  // remove a mapping straight from the list, then bring it back
  [...fieldRow('Name').querySelectorAll('button')].find((b) => b.textContent === 'remove').click();
  await tick(200);
  assert.equal((await w.PDB.db.getPageTemplates())[0].fields.find((f) => f.prevLabel === 'Name').label, '__ignore__');
  [...fieldRow('Name').querySelectorAll('button')].find((b) => b.textContent === 'restore').click();
  await tick(200);
  assert.ok((await w.PDB.db.getPageTemplates())[0].fields.some((f) => f.label === 'Name'));
});
