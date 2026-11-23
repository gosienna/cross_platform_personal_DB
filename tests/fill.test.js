const test = require('node:test');
const assert = require('node:assert/strict');
const { PDB, fixture } = require('./helpers/load.js');

const rows = [
  { patientId: 'D123456789', label: 'Name', value: '測試庚', time: 'nan', source: 's' },
  { patientId: 'D123456789', label: 'National ID', value: 'D123456789', time: 'nan', source: 's' },
  { patientId: 'D123456789', label: 'Birth date', value: '1951-11-09', time: 'nan', source: 's' },
  { patientId: 'D123456789', label: 'Sex', value: 'male', time: 'nan', source: 's' },
  { patientId: 'D123456789', label: 'Blood type', value: 'O', time: 'nan', source: 's' },
  { patientId: 'D123456789', label: 'Phone', value: '07-7654321', time: 'nan', source: 's' },
  { patientId: 'D123456789', label: 'Body temperature', value: '37', time: '202611010000', source: 's' },
  { patientId: 'D123456789', label: 'Body temperature', value: '37.9', time: '202611020000', source: 's' },
  { patientId: 'D123456789', label: 'Blood pressure', value: '144/100', time: '202611020000', source: 's' },
];

test('fill preview: matches, converts formats, keeps existing values, writes nothing yet', () => {
  const doc = fixture('referral-form.html');
  const data = PDB.fill.dataFromRows(rows);
  assert.equal(data['Body temperature'], '37.9'); // latest
  const props = PDB.fill.scanForm(doc, data, {});
  const by = (sel) => props.find((p) => p.ctls.includes(doc.querySelector(sel)));
  assert.equal(by('#pname').display, '測試庚');
  assert.equal(by('#dob').display, '1951-11-09');
  assert.equal(by('#dob2').display, '040/11/09');
  assert.equal(by('input[maxlength="3"]').display, '040/11/09');
  assert.equal(by('#sm').display, '男');
  assert.equal(by('#bt').display, 'O');
  assert.equal(by('#tf').display, '100.2'); // 37.9 °C → °F
  assert.equal(by('#sbp').display, '144');
  assert.equal(by('#dbp').display, '100');
  assert.equal(by('#ph').hasValue, true);
  assert.equal(by('#refno').matched, false);
  assert.equal(doc.querySelector('#pname').value, ''); // preview only
});

test('fill apply: fires input/change events, skips unticked, undo restores', () => {
  const doc = fixture('referral-form.html');
  const props = PDB.fill.scanForm(doc, PDB.fill.dataFromRows(rows), {});
  const events = [];
  doc.querySelector('#pname').addEventListener('input', () => events.push('input'));
  doc.querySelector('#pname').addEventListener('change', () => events.push('change'));
  const chosen = props.filter((p) => p.matched && !p.hasValue).map((p) => p.id);
  const undo = PDB.fill.apply(props, chosen);
  assert.equal(doc.querySelector('#pname').value, '測試庚');
  assert.deepEqual(events, ['input', 'change']);
  assert.equal(doc.querySelector('#sm').checked, true);
  assert.equal(doc.querySelector('#bt').value, 'O');
  assert.deepEqual(Array.from(doc.querySelectorAll('input[type=tel]')).map((x) => x.value), ['040', '11', '09']);
  assert.equal(doc.querySelector('#ph').value, '02-00000000'); // had a value, not ticked
  PDB.fill.revert(undo);
  assert.equal(doc.querySelector('#pname').value, '');
  assert.equal(doc.querySelector('#sm').checked, false);
});

test('fill template: a taught field maps an unknown label', () => {
  const doc = fixture('referral-form.html');
  const sel = PDB.templates.selectorFor(doc.querySelector('#refno'));
  const tpl = [{ id: 't', direction: 'fill', fields: [{ selector: sel, anchor: '轉介單號', label: 'National ID' }] }];
  const props = PDB.fill.scanForm(doc, PDB.fill.dataFromRows(rows), { templates: tpl });
  const p = props.find((x) => x.ctls.includes(doc.querySelector('#refno')));
  assert.equal(p.display, 'D123456789');
  assert.equal(p.how, 'template');
});

test('extract template: selector, then anchor fallback after the layout changed', () => {
  const doc = fixture('portal-case.html');
  const cell = doc.querySelectorAll('table')[1].rows[0].cells[1]; // 測試照管中心
  const field = { selector: PDB.templates.selectorFor(cell), anchor: PDB.templates.anchorFor(cell), label: 'Ward' };
  let ex = PDB.dom.extractFromRoot(doc, { templates: [{ id: 't', direction: 'extract', fields: [field] }] });
  let recs = PDB.core.mergeRecords(ex.records);
  assert.ok(recs[0].items.some((i) => i.label === 'Ward' && i.value === '測試照管中心'));
  // reshuffle: insert a new first table so the old selector points elsewhere
  const t = doc.createElement('table'); t.innerHTML = '<tr><th>新欄位</th><td>x</td></tr>';
  doc.body.insertBefore(t, doc.body.firstChild);
  ex = PDB.dom.extractFromRoot(doc, { templates: [{ id: 't', direction: 'extract', fields: [field] }] });
  recs = PDB.core.mergeRecords(ex.records);
  assert.ok(recs[0].items.some((i) => i.label === 'Ward' && i.value === '測試照管中心'));
  assert.equal(ex.broken.length, 0);
});

test('templates: tied to the frame page they were taught on; hidden elements skipped; found reported', () => {
  assert.equal(PDB.templates.pagePath('/lcms/fh/showFh200v2/8444623782'), '/lcms/fh/showFh200v2/*');
  assert.equal(PDB.templates.pagePath('/lcms/fh/editFh200v2/9421876995'), '/lcms/fh/editFh200v2/*');
  const doc = fixture('portal-case.html');
  const path = doc.location.pathname;
  const cell = doc.querySelectorAll('table')[1].rows[0].cells[1];
  const field = { selector: PDB.templates.selectorFor(cell), anchor: PDB.templates.anchorFor(cell), label: 'Ward' };
  // a template taught on another form page is not applied here and not reported missing
  let ex = PDB.dom.extractFromRoot(doc, { templates: [{ id: 'o', direction: 'extract', framePath: '/other/form/*', fields: [{ ...field, selector: '#nope', anchor: 'nope' }] }] });
  assert.equal(ex.broken.length, 0);
  // taught on this page → found
  ex = PDB.dom.extractFromRoot(doc, { templates: [{ id: 't', direction: 'extract', framePath: PDB.templates.pagePath(path), fields: [field] }] });
  assert.deepEqual(ex.found, ['Ward']);
  assert.ok(PDB.core.mergeRecords(ex.records)[0].items.some((i) => i.label === 'Ward'));
  // on a hidden tab: found (so not "missing") but its value is not captured
  cell.setAttribute('style', 'display:none'); // (real Chrome also sees hidden parents via checkVisibility; jsdom does not)
  ex = PDB.dom.extractFromRoot(doc, { templates: [{ id: 't', direction: 'extract', framePath: PDB.templates.pagePath(path), fields: [field] }] });
  assert.deepEqual(ex.found, ['Ward']);
  assert.equal(ex.broken.length, 0);
  assert.ok(!ex.records.some((r) => r.items.some((i) => i.label === 'Ward')));
});

test('templates: a long-text field is found on another record whose layout differs (context match)', () => {
  const { JSDOM } = require('jsdom');
  // two records of the same form; record B has an extra table before the section, and the hint text repeats in two sections
  const page = (extra, notes) => new JSDOM(`<body><form id="f"><div><div>
    ${extra ? '<table><tr><td>附加資料</td></tr></table>' : ''}
    <table><tr><td>(3)其他重要治療<br>如有必要，請向開立本醫師意見書之醫師諮詢，其他：<div>無特殊治療內容需要記錄的文字</div></td></tr></table>
    <table><tr><td>(4)最近6個月內照護個案之特殊注意事項(可能影響長照服務使用之狀況、一般照顧注意事項等)<br>
      如有必要，請向開立本醫師意見書之醫師諮詢，其他：<div id="x">${notes}</div></td></tr></table>
  </div></div></form></body>`, { url: 'https://h.example/lcms/fh/showFh200v2/1234567' }).window.document;
  const A = page(false, '測試注意事項甲，可正常溝通。'), B = page(true, '測試注意事項乙，需協助行走。');
  const el = A.querySelector('#x');
  el.removeAttribute('id'); B.querySelector('#x').removeAttribute('id'); // force a position selector, as on the real site
  const field = { selector: PDB.templates.selectorFor(el), anchor: PDB.templates.anchorFor(el), context: PDB.templates.contextFor(el), tag: el.tagName, label: 'Special notes' };
  assert.ok(field.context.includes('最近6個月內照護個案之特殊注意事項'), 'numbering and bracketed note removed');
  const hit = PDB.templates.locate(B, field, false);
  assert.equal(hit.how, 'context');
  assert.equal(hit.el.textContent, '測試注意事項乙，需協助行走。');
});

test('醫師意見書 checkbox cell: group label from loose text, "其他" boxes, capture → fill another copy → undo', () => {
  const doc = fixture('portal-fh200-notice.html');
  for (const id of ['fh200.notice2', 'fh200.notice15', 'fh200.notice99', 'fh200.noticeSug']) doc.getElementById(id).checked = true;
  doc.querySelector('[name="fh200.notice99Desc"]').value = '測試其他說明';
  doc.querySelector('[name="fh200.disposalSug"]').value = '測試處置建議';
  const items = PDB.core.mergeRecords(PDB.dom.extractFromRoot(doc, {}).records).flatMap((r) => r.items);
  const data = Object.fromEntries(items.map((i) => [i.label, i.value]));
  assert.equal(data['照顧應注意事項及處置方法'], '跌倒、骨折; 疼痛; 其他', 'numbering removed; label from loose text in the cell, not the section heading');
  assert.equal(data['照顧應注意事項及處置方法/其他'], '測試其他說明');
  assert.equal(data['處置建議/其他建議'], '測試處置建議');
  assert.ok(data['處置建議'], 'the 處置建議 tick box is its own group');

  const blank = fixture('portal-fh200-notice.html');
  const props = PDB.fill.scanForm(blank, data, {});
  const undo = PDB.fill.apply(props, props.filter((p) => p.matched).map((p) => p.id));
  const ticked = [...blank.querySelectorAll('input[type=checkbox]')].filter((x) => x.checked).map((x) => x.id);
  assert.deepEqual(ticked, ['fh200.notice2', 'fh200.notice15', 'fh200.notice99', 'fh200.noticeSug']);
  assert.equal(blank.querySelector('[name="fh200.notice99Desc"]').value, '測試其他說明');
  assert.equal(blank.querySelector('[name="fh200.disposalSug"]').value, '測試處置建議');
  PDB.fill.revert(undo);
  assert.equal([...blank.querySelectorAll('input[type=checkbox]')].filter((x) => x.checked).length, 0);
  assert.equal(blank.querySelector('[name="fh200.notice99Desc"]').value, '');
});

test('read-only copy with tick-box pictures (檢視) captures the same labels the edit form (編輯) fills', () => {
  const { JSDOM } = require('jsdom');
  const fs = require('node:fs'), path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'portal-fh200-notice.html'), 'utf8');
  // the 檢視 page: <img src=checkbox(_checked).gif> instead of inputs, text instead of text boxes
  const ticked = new Set(['fh200.notice2', 'fh200.notice15']);
  const show = html
    .replace(/<input type="hidden"[^>]*>/g, '')
    .replace(/<input type="checkbox" name="[^"]*" id="([^"]*)">/g, (m, id) => `<img src="/images/${ticked.has(id) ? 'checkbox_checked' : 'checkbox'}.gif">`)
    .replace(/<textarea[^>]*><\/textarea>/g, '');
  const doc = new JSDOM(show).window.document;
  const items = PDB.core.mergeRecords(PDB.dom.extractFromRoot(doc, {}).records).flatMap((r) => r.items);
  const data = Object.fromEntries(items.map((i) => [i.label, i.value]));
  assert.equal(data['照顧應注意事項及處置方法'], '跌倒、骨折; 疼痛');
  const edit = fixture('portal-fh200-notice.html');
  const props = PDB.fill.scanForm(edit, data, {});
  PDB.fill.apply(props, props.filter((p) => p.matched).map((p) => p.id));
  assert.deepEqual([...edit.querySelectorAll('input[type=checkbox]')].filter((x) => x.checked).map((x) => x.id), ['fh200.notice2', 'fh200.notice15']);
});

test('居護 options: captured rows fill a blank copy (radios by formcontrolname, checkbox, order-row radios) and undo', () => {
  const ticks = ['IsCheckCId', 'FallInYear2', 'HasFoodAllergies2', 'DNRStatus2', 'CaseKind2', 'NgMaterial2', 'FoleyMaterial1'];
  const src = fixture('homecare-options.html');
  for (const id of ticks) src.getElementById(id).checked = true;
  const items = PDB.core.mergeRecords(PDB.dom.extractFromRoot(src, {}).records).flatMap((r) => r.items);
  const data = Object.fromEntries(items.map((i) => [i.label, i.value]));
  const blank = fixture('homecare-options.html');
  const props = PDB.fill.scanForm(blank, data, {});
  const undo = PDB.fill.apply(props, props.filter((p) => p.matched && p.kind !== 'text').map((p) => p.id));
  const on = [...blank.querySelectorAll('input[type=radio],input[type=checkbox]')].filter((x) => x.checked).map((x) => x.id);
  assert.deepEqual(on.sort(), [...ticks].sort());
  assert.ok(!blank.getElementById('PCaseType1').checked, 'the search filter is left alone');
  PDB.fill.revert(undo);
  assert.equal([...blank.querySelectorAll('input[type=radio],input[type=checkbox]')].filter((x) => x.checked).length, 0);
});

test('Teach is the same in Capture and Fill: a field taught in one mode is used by the other', () => {
  const { JSDOM } = require('jsdom');
  const fs = require('node:fs'), path = require('node:path');
  const T = PDB.templates, D = PDB.dom;
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'portal-fh200-notice.html'), 'utf8');
  // read-only copy (檢視): tick-box pictures, the 處置建議 text box shown as text
  const show = new JSDOM(html
    .replace(/<input type="hidden"[^>]*>/g, '')
    .replace(/<input type="checkbox" name="[^"]*" id="([^"]*)">/g, (m, id) => `<img src="/images/${['fh200.notice2', 'fh200.notice15'].includes(id) ? 'checkbox_checked' : 'checkbox'}.gif">`)
    .replace(/<textarea name="fh200.disposalSug"[^>]*><\/textarea>/, '<div>測試處置建議</div>')
    .replace(/<textarea[^>]*><\/textarea>/g, ''), { url: 'https://h.example/lcms/fh/showFh200v2/1234567' }).window.document;
  const edit = () => new JSDOM(html, { url: 'https://h.example/lcms/fh/editFh200v2/7654321' }).window.document;
  // what the picker sends (agent.js teachField)
  const taught = (el, group) => ({
    kind: group ? 'group' : /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) ? 'control' : 'text',
    selector: T.selectorFor(el), anchor: group ? group.label : T.anchorFor(el), context: T.contextFor(el), tag: el.tagName,
    framePath: T.pagePath(el.ownerDocument.location.pathname),
  });

  // 1. Capture → Teach: click the label text of one tick-box picture → the whole group
  const pic = [...show.querySelectorAll('img')].find((i) => D.optionLabelText(i) === '疼痛');
  const opt = D.optionAt(pic.closest('label') || pic);
  assert.equal(opt, pic);
  const g = D.groupOf(opt);
  assert.ok(g.opts.length >= 10, 'the whole group, not one box');
  const capField = { ...taught(g.opts[0], g), label: 'Care notes' };
  const capTpl = { id: 'c', origin: 'https://h.example', direction: 'extract', framePath: capField.framePath, fields: [capField] };
  let items = PDB.core.mergeRecords(D.extractFromRoot(show, { templates: [capTpl] }).records).flatMap((r) => r.items);
  assert.equal(items.find((i) => i.label === 'Care notes').value, '跌倒、骨折; 疼痛');
  assert.ok(!items.some((i) => i.label === '照顧應注意事項及處置方法'), 'the group is not read twice under its page label');
  //    … and Fill uses it on the edit form (another page, real inputs)
  const e1 = edit();
  let props = PDB.fill.scanForm(e1, { 'Care notes': '跌倒、骨折; 疼痛' }, { templates: [capTpl] });
  const cp = props.find((p) => p.label === 'Care notes');
  assert.ok(cp && cp.kind === 'checks' && cp.how === 'template');
  PDB.fill.apply(props, [cp.id]);
  assert.deepEqual([...e1.querySelectorAll('input[type=checkbox]')].filter((x) => x.checked).map((x) => x.id), ['fh200.notice2', 'fh200.notice15']);

  // 2. Fill → Teach: click the 處置建議 text box on the edit form
  const e2 = edit();
  const box = e2.querySelector('[name="fh200.disposalSug"]');
  const fillField = { ...taught(box), label: 'Disposal advice' };
  assert.equal(fillField.kind, 'control');
  const fillTpl = { id: 'f', origin: 'https://h.example', direction: 'fill', framePath: fillField.framePath, fields: [fillField] };
  props = PDB.fill.scanForm(e2, { 'Disposal advice': '測試建議' }, { templates: [fillTpl] });
  assert.equal(props.find((p) => p.ctls.includes(box)).label, 'Disposal advice');
  //    … and Capture reads the same field on the read-only page
  const ex = D.extractFromRoot(show, { templates: [fillTpl] });
  items = PDB.core.mergeRecords(ex.records).flatMap((r) => r.items);
  assert.equal(items.find((i) => i.label === 'Disposal advice').value, '測試處置建議');
  assert.equal(ex.broken.length, 0, 'a field taught in the other mode is never reported missing');

  // 3. Fill → Teach on a tick box: the whole group, the same as Capture
  const e3 = edit();
  const cb = e3.getElementById('fh200.notice15');
  const g3 = D.groupOf(D.optionAt(cb));
  assert.ok(g3.opts.includes(e3.getElementById('fh200.notice2')));
  const f3 = { ...taught(g3.opts[0], g3), label: 'Care notes' };
  const ex3 = D.extractFromRoot(show, { templates: [{ id: 'f3', origin: 'https://h.example', direction: 'fill', fields: [f3] }] });
  assert.equal(PDB.core.mergeRecords(ex3.records).flatMap((r) => r.items).find((i) => i.label === 'Care notes').value, '跌倒、骨折; 疼痛');
});
