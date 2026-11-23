// Local-only checks against the real saved pages in tests/data/ (git-ignored, contains real patient data).
// Skipped when the folder is missing. Assertions use counts and labels only; no values are printed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { docFrom, capture, ROOT } = require('./helpers/load.js');

const D = path.join(ROOT, 'tests', 'data');
const D_DIR = D;
const has = fs.existsSync(D);
const page = (name) => {
  const f = fs.readdirSync(D, { recursive: true }).find((x) => String(x).endsWith(name));
  assert.ok(f, `missing ${name}`);
  return capture(docFrom(path.join(D, String(f))));
};
const labels = (rec) => new Set(rec.rows.map((r) => r.label));
const count = (rec, label) => rec.rows.filter((r) => r.label === label).length;

test('real: measurement list (temperature)', { skip: !has }, () => {
  const { records } = page('生理測量資料-MEASURE_執行.html');
  assert.ok(records.length >= 1);
  assert.ok(records.every((r) => r.hints.name && r.hints.bed));
  assert.ok(records.reduce((n, r) => n + count(r, 'Body temperature'), 0) >= 50);
  assert.ok(records.every((r) => r.rows.filter((x) => x.label === 'Body temperature').every((x) => /^\d{12}$/.test(x.time))));
});

test('real: measurement list (glucose with meal tags)', { skip: !has }, () => {
  const { records } = page('生理測量資料-MEASURE_執行2.html');
  const all = records.flatMap((r) => r.rows);
  assert.ok(all.some((r) => r.label === 'Blood glucose (HS)'));
  assert.ok(all.filter((r) => r.label.startsWith('Blood glucose')).every((r) => /^\d+(\.\d)?$/.test(r.value)));
});

test('real: medication list', { skip: !has }, () => {
  const { records } = page('藥品給藥資料-MEDICINE_執行.html');
  assert.equal(records.length, 1);
  assert.ok(records[0].hints.nationalId);
  assert.equal(count(records[0], 'Medication'), 9);
});

test('real: resident profile (div layout)', { skip: !has }, () => {
  const { records } = page('智齡科技管理系統.html');
  const l = labels(records[0]);
  for (const x of ['National ID', 'Birth date', 'Admission date', 'Medical history']) assert.ok(l.has(x), x);
  assert.ok(records[0].skipped.length >= 3); // relative-time vital cards
});

test('real: portal case and assessment frames', { skip: !has }, () => {
  const a = page('照顧服務管理資訊平臺_files/8310519481.html');
  const b = page('照顧服務管理資訊平臺_files/9126144286.html');
  for (const { records } of [a, b]) {
    assert.equal(records.length, 1);
    const l = labels(records[0]);
    for (const x of ['Name', 'National ID', 'Birth date', 'Sex']) assert.ok(l.has(x), x);
  }
  assert.ok(labels(b.records[0]).has('意識狀態'));
});

test('real: privacy gate leaves no national ID, phone or email in any page payload', { skip: !has }, () => {
  const R = require('./helpers/load.js').PDB.redact;
  const P = require('./helpers/load.js').PDB;
  const files = fs.readdirSync(D, { recursive: true }).map(String).filter((f) => f.endsWith('.html'));
  for (const f of files) {
    const doc = docFrom(path.join(D, f));
    const ex = P.dom.extractFromRoot(doc, {});
    const known = [];
    for (const r of ex.records) for (const it of r.items) if (it.entry && it.entry.sensitive) { known.push({ label: it.label, value: it.value }); if (it.raw) known.push({ label: it.label, value: it.raw }); }
    const { text, spans } = R.detect(R.pageText(doc), known, {});
    for (const s of spans) if (s.decision == null) s.decision = 'mask';
    const { out } = R.apply(text, spans);
    assert.ok(R.finalCheck(out).ok, `identifier left in ${f.slice(-40)}`);
    for (const k of known) if (k.value.length >= 3 && ['Name', 'National ID', 'Phone', 'Mobile', 'Birth date'].includes(k.label)) assert.ok(!out.includes(k.value), `${k.label} left in ${f.slice(-40)}`);
  }
});

test('real: every ticked option group (checkbox, radio, tick-box picture) is stored as a row', { skip: !has }, () => {
  const P = require('./helpers/load.js').PDB;
  const C = P.core, Dm = P.dom;
  const files = [...new Set(fs.readdirSync(D, { recursive: true }).map(String).filter((f) => /\.html?$/.test(f)))];
  let groupsChecked = 0;
  for (const f of files) {
    const doc = docFrom(path.join(D, f));
    const opts = Dm.optionsIn(doc.body || doc.documentElement).filter((o) => !Dm.isHidden(o));
    if (!opts.length) continue;
    const { records } = capture(doc);
    const rows = records.flatMap((r) => r.rows);
    const byLabel = new Map();
    for (const r of rows) byLabel.set(C.normLabel(r.label).norm, (byLabel.get(C.normLabel(r.label).norm) || '') + ' ' + r.value);
    for (const g of Dm.optionGroups(opts, {})) {
      // never labelled by one of its own options (e.g. "收案中" for 收案中/已結案/未收案)
      if (g.label && g.opts.length > 1) assert.ok(!g.opts.some((o) => C.cleanLabel(Dm.optionLabelText(o)) === C.cleanLabel(g.label)), `group labelled by its own option in …${f.slice(-30)}`);
      const ticked = g.opts.filter(Dm.optionChecked);
      if (!g.label || !ticked.length) continue;
      groupsChecked++;
      const stored = [...byLabel.entries()].find(([k]) => k === C.normLabel(g.label).norm || k.endsWith('/' + C.normLabel(g.label).norm) || C.normLabel(g.label).norm.endsWith(k));
      assert.ok(stored, `ticked group "${C.cleanLabel(g.label).slice(0, 20)}" not stored in …${f.slice(-30)}`);
      for (const o of ticked) {
        const t = C.clean(Dm.optionLabelText(o));
        assert.ok(stored[1].includes(t) || (g.opts.length === 1 && /是/.test(stored[1])), `ticked option missing from "${C.cleanLabel(g.label).slice(0, 20)}" in …${f.slice(-30)}`);
      }
    }
  }
  assert.ok(groupsChecked >= 7, `expected the ticked groups of the portal pages, checked ${groupsChecked}`);
});

test('real: portal case — 申請服務種類 (pictures in a nested table) is stored', { skip: !has }, () => {
  const { records } = page('照顧服務管理資訊平臺_files/8310519481.html');
  assert.ok(records.flatMap((r) => r.rows).some((r) => r.label === '申請服務種類'));
});

test('real: portal assessment — tick-box picture groups stored', { skip: !has }, () => {
  const { records } = page('照顧服務管理資訊平臺_files/9126144286.html');
  const l = labels(records[0]);
  assert.ok(l.has('意識狀態'));
  assert.ok(l.has('近期治療') || [...l].some((x) => x.startsWith('建議')), 'a tick-box list section');
});

// A page read by its draft template gives the same rows as the rules. Only counts are reported (no values).
test('real: every saved page reads the same through its draft template', { skip: !has }, () => {
  const { PDB } = require('./helpers/load.js');
  const D = PDB.dom, C = PDB.core, PT = PDB.pagetpl;
  const ctx = { origin: 'https://real.example', refYear: 2026, refDate: { y: 2026, m: 11, d: 23 } };
  const lines = (records) => C.mergeRecords(records).flatMap((r) => C.recordToRows(r, { source: 'x', captureTime: '202611230600' }).map((x) => `${x.label}␟${x.value}␟${x.time}`)).sort();
  const files = fs.readdirSync(D_DIR, { recursive: true }).map(String).filter((f) => f.endsWith('.html') && !f.includes('_files'));
  assert.ok(files.length);
  for (const f of files) {
    const doc = docFrom(path.join(D_DIR, f));
    const rules = D.extractFromRoot(doc, { ...ctx, registry: D.makeRegistry(), templates: [] });
    const tpl = JSON.parse(JSON.stringify(PT.draft(doc, rules, { origin: ctx.origin, framePath: '/p' })));
    const a = lines(rules.records), b = lines(PT.extract(doc, tpl, { ...ctx, registry: D.makeRegistry() }).records);
    const missing = a.filter((x) => !b.includes(x)), extra = b.filter((x) => !a.includes(x));
    const labelsOf = (xs) => [...new Set(xs.map((x) => x.split('␟')[0]))].join(', ');
    assert.ok(!missing.length && !extra.length, `${path.basename(f).slice(-30)}: ${missing.length} rows missing (${labelsOf(missing)}), ${extra.length} extra (${labelsOf(extra)})`);
  }
});
