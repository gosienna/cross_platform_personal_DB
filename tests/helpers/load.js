// Loads the extension's lib files into Node and gives a jsdom document for a fixture.
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
for (const f of ['schema.js', 'core.js', 'dom.js', 'templates.js', 'pagetpl.js', 'fill.js', 'zip.js', 'crypto.js', 'export.js', 'backup.js', 'redact.js', 'tplcheck.js']) require(path.join(ROOT, 'extension', 'lib', f));
const PDB = globalThis.PDB;

function docFrom(file) {
  const html = fs.readFileSync(file, 'utf8');
  return new JSDOM(html).window.document;
}
const fixture = (name) => docFrom(path.join(ROOT, 'tests', 'fixtures', name));

/** Extract a document into merged records and 5-field rows (patientId left as hints). */
function capture(doc, { source = 'https://test.example', captureTime = '202611230600', vocab } = {}) {
  const ex = PDB.dom.extractFromRoot(doc, { vocab, origin: source, refYear: 2026, refDate: { y: 2026, m: 11, d: 23 } });
  const records = PDB.core.mergeRecords(ex.records);
  const out = records.map((r) => ({ hints: r.hints, skipped: r.skipped, rows: PDB.core.recordToRows(r, { source, captureTime }).map(({ _item, ...row }) => row) }));
  return { records: out, regions: ex.regions };
}
module.exports = { PDB, docFrom, fixture, capture, ROOT };
