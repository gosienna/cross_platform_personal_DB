// Extraction from synthetic copies of the target page layouts (fake people).
const test = require('node:test');
const assert = require('node:assert/strict');
const { PDB, fixture, capture } = require('./helpers/load.js');

const rowsOf = (rec) => rec.rows;
const find = (rec, label) => rec.rows.filter((r) => r.label === label);
const one = (rec, label) => { const r = find(rec, label); assert.equal(r.length, 1, `expected one ${label}, got ${r.length}`); return r[0]; };

test('measurement list: one record per resident, vital type from page heading, UTC times', () => {
  const { records } = capture(fixture('ltc-measure-temp.html'));
  assert.equal(records.length, 2);
  const [a, b] = records;
  assert.equal(a.hints.name, '測試甲');
  assert.equal(a.hints.bed, '3F-301-1');
  const temps = find(a, 'Body temperature');
  assert.deepEqual(temps.map((r) => [r.value, r.time]), [['36.6', '202610240920'], ['37.9', '202610250843']]);
  assert.equal(one(a, 'Name').time, 'nan');
  // °F converted to °C
  assert.deepEqual(find(b, 'Body temperature').map((r) => r.value), ['36.4', '37.3']);
  // nothing from the facility footer or the search form
  assert.ok(!records.some((r) => r.rows.some((x) => /機構|電話/.test(x.label))));
});

test('glucose list: meal-time tag goes into the label, value stays numeric', () => {
  const { records } = capture(fixture('ltc-measure-glucose.html'));
  assert.equal(records.length, 1);
  const g = records[0].rows.filter((r) => r.label.startsWith('Blood glucose'));
  assert.deepEqual(g.map((r) => [r.label, r.value]), [['Blood glucose (HS)', '107'], ['Blood glucose (AC)', '132'], ['Blood glucose (HS)', '98']]);
  assert.ok(!records[0].rows.some((r) => r.label === '序' || r.label === '操作'));
});

test('medication tables: one row per medication, both tables merged, linked to national ID', () => {
  const { records } = capture(fixture('ltc-medicine.html'));
  assert.equal(records.length, 1);
  const rec = records[0];
  assert.equal(rec.hints.nationalId, 'A223456789');
  const meds = find(rec, 'Medication');
  assert.equal(meds.length, 3);
  assert.equal(meds[0].value, 'Acetaminophen 500 mg; 1 粒; TID; 口服; 56天; 2026-10-07~2026-12-02; 測試醫院 骨科一診; 醫師甲');
  assert.equal(meds[0].time, '202610070900'); // 17:00 Taipei = 09:00 UTC, from the table with times
  assert.ok(meds[2].value.startsWith('Sennapur 12.5 mg;'));
  // extra columns of the medication table are not stored as separate rows
  assert.ok(!rec.rows.some((r) => ['健保代碼', '作用', '學名'].includes(r.label)));
});

test('Angular-style form: label next to input, segmented ROC birthday, radio, select', () => {
  const { records } = capture(fixture('homecare-basic.html'));
  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(one(r, 'MRN').value, 'HC-0042');
  assert.equal(one(r, 'Name').value, '測試戊');
  assert.equal(one(r, 'Birth date').value, '1951-11-09'); // 040/11/09 ROC in three boxes
  assert.equal(one(r, 'Sex').value, 'female');
  assert.equal(one(r, 'National ID').value, 'B234567890');
  assert.equal(one(r, 'Blood type').value, 'O');
  assert.equal(one(r, 'Body weight').value, '52.5');
  assert.equal(one(r, 'Body weight').time, '202611230600'); // timed label without page time → capture time
  assert.equal(one(r, 'Registered address').value, '測試市測試區測試路2號');
  assert.equal(one(r, 'Medical history').value, '高血壓、糖尿病');
  assert.ok(!r.rows.some((x) => x.label === 'Nickname')); // empty field skipped
});

test('div layout: label/value siblings; relative-time vitals are skipped', () => {
  const { records } = capture(fixture('zhiling-profile.html'));
  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(one(r, 'National ID').value, 'C212345678');
  assert.equal(one(r, 'Birth date').value, '1953-03-04');
  assert.equal(one(r, 'Admission date').value, '2025-09-22');
  assert.ok(!r.rows.some((x) => x.label === 'Heart rate' || x.label === 'Blood pressure' || x.label === 'Body weight'));
  assert.deepEqual(r.skipped.map((s) => s.label).sort(), ['Blood pressure', 'Body weight', 'Heart rate']);
  assert.ok(!r.rows.some((x) => x.label === 'Name' && x.value === '照護')); // menu text is not a name
});

test('portal case page: stacked th/td pairs, ROC dates, sex text', () => {
  const { records } = capture(fixture('portal-case.html'));
  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(one(r, 'Name').value, '測試庚');
  assert.equal(one(r, 'National ID').value, 'D123456789');
  assert.equal(one(r, 'Birth date').value, '1951-11-09');
  assert.equal(one(r, 'Sex').value, 'male');
  assert.equal(one(r, 'Admission date').value, '2025-12-02');
  assert.equal(one(r, 'Phone').value, '07-7654321');
  assert.equal(one(r, '申請日期').value, '2025-12-02'); // unmapped label, value normalised as a date
});

test('assessment: only checked image-checkbox options; form date is the time of timed rows', () => {
  const { records } = capture(fixture('portal-assessment.html'));
  const r = records[0];
  assert.equal(one(r, '意識狀態').value, '警醒');
  assert.equal(one(r, '肢體').value, '肌力降低; 攣縮');
  assert.equal(one(r, '意識狀態').time, '20260828');
});

test('doctor orders: checked boxes joined, order date used as time', () => {
  const { records } = capture(fixture('homecare-order.html'));
  const r = records[0];
  assert.equal(one(r, '醫囑').value, '1.更換鼻胃管; 7.壓傷');
  assert.equal(one(r, 'Diagnosis').value, '慢性腎病');
  assert.equal(one(r, 'Diagnosis').time, '20261101');
});

test('frames: records from several documents of one capture merge into one patient', () => {
  const a = PDB.dom.extractFromRoot(fixture('portal-case.html'), {});
  const b = PDB.dom.extractFromRoot(fixture('portal-assessment.html'), {});
  const merged = PDB.core.mergeRecords([...a.records, ...b.records]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].hints.nationalId, 'D123456789');
});

test('pick region: extracting one element only reads that element', () => {
  const doc = fixture('ltc-measure-temp.html');
  const table = doc.querySelector('table');
  const ex = PDB.dom.extractFromRoot(table, { refYear: 2026 });
  const recs = PDB.core.mergeRecords(ex.records);
  assert.equal(recs.length, 2);
});

test('dropdowns and checkboxes inside a form laid out with a table the table reader does not use are captured', () => {
  const { JSDOM } = require('jsdom');
  const doc = new JSDOM(`<body><form><table>
    <tr><td colspan="2">二、醫學上之意見</td></tr>
    <tr><td>(2).病情狀態</td><td><select name="sick"><option value="">請選擇</option><option value="1" selected>穩定</option></select>
        <label><input type="checkbox">需追蹤</label><label><input type="checkbox" checked>需轉介</label></td></tr>
    <tr><td>(3)壓力性損傷</td><td><select name="ulcer"><option value="">請選擇</option><option value="2">有</option></select>
        <label><input type="checkbox">第一級</label><label><input type="checkbox">第二級</label></td></tr>
    <tr><td colspan="2">其他說明<textarea name="memo">測試說明文字</textarea></td></tr>
  </table>
  <div>縣市</div><select name="cnt"><option>測試市</option></select><select name="twn"><option>測試區</option></select>
  </form></body>`).window.document;
  const ex = PDB.dom.extractFromRoot(doc, { refYear: 2026 });
  const items = PDB.core.mergeRecords(ex.records).flatMap((r) => r.items);
  const get = (re) => items.filter((i) => re.test(i.rawLabel)).map((i) => i.value);
  assert.ok(get(/病情狀態/).some((v) => /穩定/.test(v)), 'chosen dropdown value captured');
  assert.equal(get(/壓力性損傷/).filter((v) => /請選擇/.test(v)).length, 0, 'placeholder not captured');
  // the second address dropdown is not labelled with the first one's value
  const { label } = PDB.dom.bestLabel(doc.querySelector('[name=twn]'), {});
  assert.notEqual(label, '測試市');
});

test('tick-box pictures: in a <label>, bare with text after, bare alone in a cell; unticked text left out', () => {
  const { JSDOM } = require('jsdom');
  const on = '<img src="/lcms/images/icons/checkbox_checked.gif">', off = '<img src="/lcms/images/icons/checkbox.gif">';
  const doc = new JSDOM(`<body>
    <div>建議其他長照服務項目</div>
    <div><label>${on}居家照顧服務</label><label>${off}日間照顧</label><label>${on}家庭托顧</label></div>
    <p>輔具需求</p>
    <div>${off}輪椅 ${on}助行器 ${off}<span>氣墊床</span></div>
    <table><tr><th>身障證明</th><td>${on}</td></tr><tr><th>重大傷病</th><td>${off}</td></tr></table>
    <table><tr><th>照顧方式</th><td>${off}自行照顧 ${on}家人照顧 ${off}外籍看護</td></tr></table>
  </body>`).window.document;
  const D = PDB.dom;
  assert.equal(D.optionLabelText(doc.querySelectorAll('img')[4]), '助行器');
  const items = PDB.core.mergeRecords(D.extractFromRoot(doc, {}).records).flatMap((r) => r.items);
  const v = (re) => items.filter((i) => re.test(i.label)).map((i) => i.value).join(' | ');
  assert.equal(v(/^建議其他長照服務項目$/), '居家照顧服務; 家庭托顧');
  assert.equal(v(/^輔具需求$/), '助行器');
  assert.equal(v(/身障證明/), '是', 'a lone ticked picture is "是"');
  assert.equal(v(/重大傷病/), '', 'a lone unticked picture gives no value');
  assert.ok(!/自行照顧|外籍看護/.test(v(/照顧方式/)), 'unticked options are not in the value');
  assert.match(v(/照顧方式/), /家人照顧/);
});

const HC_TICKS = ['IsCheckCId', 'FallInYear2', 'HasFoodAllergies2', 'DNRStatus2', 'CaseKind2', 'NgMaterial2', 'FoleyMaterial1', 'PCaseType1'];

test('tick boxes are stored as rows: 居護 Angular radios/checkboxes in a table form (one row per group)', () => {
  const doc = fixture('homecare-options.html');
  for (const id of HC_TICKS) doc.getElementById(id).checked = true; // saved Angular pages lose ticks, so set them here
  const rows = capture(doc).records.flatMap((r) => r.rows);
  const got = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  assert.equal(got['Nationality'], '本國', '<label>國籍</label> ☑本國 → mapped label');
  assert.equal(got['National ID'], 'A123456789', 'the text box in the same cell is still read');
  assert.equal(got['近1年跌倒'], '有', 'only the chosen radio; the "次" text box beside it is not the value');
  assert.equal(got['食物'], '有');
  assert.equal(got['DNR簽署狀態'], '已簽署');
  assert.equal(got['個案類型'], '安寧', 'Angular radios without name are one group (formcontrolname)');
  assert.equal(got['更換鼻胃管/材質'], '矽質', 'a field inside an order row takes the item as prefix');
  assert.equal(got['更換導尿管/材質'], '一般塑膠');
  assert.ok(!rows.some((r) => /收案中|全部/.test(r.value)), 'a search filter (with 全部) is not patient data');
  assert.ok(!rows.some((r) => r.label === '頻率'), 'a column-header row is not a label/value pair');
  assert.ok(rows.filter((r) => !['National ID', 'Nationality'].includes(r.label)).every((r) => /^\d{12}$/.test(r.time)));
});

test('tick boxes: pictures in a table nested inside a label/value row are one group', () => {
  const rows = capture(fixture('portal-case.html')).records.flatMap((r) => r.rows).filter((r) => r.label === '申請服務種類');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, '照顧及專業服務; 輔具服務');
});
