// Privacy gate: planted identifiers must never reach the outgoing payload unless explicitly approved.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PDB, fixture, docFrom, ROOT } = require('./helpers/load.js');
const R = PDB.redact;

// load ai.js (for toFrameResult) with a stub UI global
globalThis.UI = {};
require(path.join(ROOT, 'extension', 'lib', 'ai.js'));

const PLANTED = ['D123456789', '測試庚', '07-7654321', '0912-345-678', 'someone@example.com', '高雄市林園區王公里001鄰林園北路369巷1號', '040/11/09', '1951-11-09'];

function gate(doc, extraKnown = []) {
  const ex = PDB.dom.extractFromRoot(doc, {});
  const known = [];
  for (const r of ex.records) for (const it of r.items) if (it.entry && it.entry.sensitive) { known.push({ label: it.label, value: it.value }); if (it.raw) known.push({ label: it.label, value: it.raw }); }
  const text = R.pageText(doc);
  const { text: t, spans } = R.detect(text, known.concat(extraKnown), {});
  for (const s of spans) if (s.decision == null) s.decision = 'mask'; // "Mask all uncertain"
  return { ...R.apply(t, spans), text: t, spans };
}

test('page text: no attributes, hidden inputs, scripts or URLs', () => {
  const doc = docFrom(path.join(ROOT, 'tests', 'fixtures', 'portal-case.html'));
  doc.body.insertAdjacentHTML('beforeend', '<input type="hidden" value="A111111111"><a href="https://his.example/p?pid=A111111111" title="A111111111">link</a><script>var id="A111111111"</script><!-- A111111111 -->');
  const t = R.pageText(doc);
  assert.ok(!t.includes('A111111111'));
  assert.ok(!/https?:/.test(t));
});

test('masking: planted identifiers in tables, text and forms are all removed', () => {
  const doc = fixture('portal-case.html');
  doc.body.insertAdjacentHTML('beforeend', '<p>家屬手機 0912-345-678，email someone@example.com</p><div>住址：高雄市林園區王公里001鄰林園北路369巷1號</div><p>病人測試庚今日精神佳</p>');
  const { out, map } = gate(doc);
  for (const p of PLANTED) assert.ok(!out.includes(p), `leaked: ${p}`);
  assert.match(out, /\[ID_1\]/);
  assert.match(out, /\[NAME_1\]/);
  assert.equal(R.reidentify('[NAME_1] / [ID_1]', map), '測試庚 / D123456789');
  assert.ok(R.finalCheck(out).ok);
});

test('known stored values are masked in other formats (ROC birth date, phone digits)', () => {
  const text = '生日 40/11/09 電話 077654321 備註';
  const { text: t, spans } = R.detect(text, [{ label: 'Birth date', value: '1951-11-09' }, { label: 'Phone', value: '07-7654321' }], {});
  const { out } = R.apply(t, spans.map((s) => ({ ...s, decision: s.decision || 'mask' })));
  assert.ok(!out.includes('40/11/09'));
  assert.ok(!out.includes('077654321'));
});

test('final hard block: an identifier left in the text blocks sending unless approved', () => {
  const out = '姓名 [NAME_1] 身分證 D123456789';
  const c = R.finalCheck(out);
  assert.equal(c.ok, false);
  assert.equal(c.left[0].text, 'D123456789');
  assert.equal(R.finalCheck(out, ['D123456789']).ok, true);
});

test('policies: "send" lets a category through, "ask" leaves it undecided', () => {
  const t = '電話 07-7654321';
  assert.equal(R.detect(t, [], { categories: { Phone: 'send' } }).spans[0].decision, 'send');
  assert.equal(R.detect(t, [], { categories: { Phone: 'ask' } }).spans[0].decision, null);
});

test('AI reply with placeholders → rows with real values, normalised (local only)', () => {
  const map = { '[NAME_1]': '測試庚', '[ID_1]': 'D123456789' };
  const res = globalThis.AIFlow.toFrameResult({ records: [{ patient: { name: '[NAME_1]', nationalId: '[ID_1]', mrn: '', birthDate: '', bed: '' },
    rows: [{ label: 'Body temperature', value: '101', time: '2026-11-01 08:00' }, { label: '脈搏', value: '80', time: '4小時前' }, { label: 'Name', value: '[NAME_1]', time: 'nan' }] }] }, map);
  const r = res.records[0];
  assert.equal(r.hints.nationalId, 'D123456789');
  assert.equal(r.items[0].value, '38.3'); // °F detected by value > 50
  assert.equal(r.items[0].time, '202611010000');
  assert.equal(r.skipped.length, 1);
  assert.equal(r.items[1].value, '測試庚');
});
