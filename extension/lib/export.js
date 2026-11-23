/*
 * Export / import of the 5-field rows.
 *   CSV  – exactly: patientId,label,value,time,source
 *   JSON – { format: "personal-db", version: 1, fields: [...], rows: [...] }
 *   FHIR – R4 Bundle computed from the rows (Patient, Observation, MedicationStatement, Media)
 *   ZIP  – data file + media/<sha256>.<ext>
 */
(function (g) {
  const PDB = (g.PDB = g.PDB || {});
  const C = () => PDB.core, S = () => PDB.schema;
  const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/webm': 'weba', 'audio/ogg': 'ogg', 'video/mp4': 'mp4', 'video/webm': 'webm', 'application/pdf': 'pdf' };
  const MEDIA_LABELS = new Set(['Photo', 'Audio', 'Video', 'Screenshot', 'Attachment']);
  const isMediaRef = (v) => /^sha256:[0-9a-f]{64}$/.test(v);

  const toJSON = (rows) => JSON.stringify({ format: 'personal-db', version: 1, fields: C().FIELDS, rows: rows.map(pick5) }, null, 1);
  const pick5 = (r) => ({ patientId: r.patientId, label: r.label, value: r.value, time: r.time, source: r.source });

  // ── FHIR ─────────────────────────────────────────────────────────────
  function fhirTime(t) {
    if (!t || t === 'nan') return undefined;
    if (t.length === 8) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
    return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:00Z`;
  }
  const safeId = (s) => String(s).replace(/[^A-Za-z0-9\-.]/g, '-').slice(0, 64) || 'x';

  function toFHIR(rows, blobMeta = new Map()) {
    const entries = [];
    const byPatient = new Map();
    for (const r of rows) { if (!byPatient.has(r.patientId)) byPatient.set(r.patientId, []); byPatient.get(r.patientId).push(r); }
    let n = 0;
    for (const [pid, rs] of byPatient) {
      const pref = `Patient/${safeId(pid)}`;
      const val = (l) => (rs.find((r) => r.label === l && r.time === 'nan') || {}).value;
      const patient = { resourceType: 'Patient', id: safeId(pid), identifier: [{ use: 'usual', type: { text: 'Personal DB patient ID' }, value: pid }] };
      const nid = val('National ID'); if (nid) patient.identifier.push({ type: { text: 'National ID' }, value: nid });
      for (const r of rs.filter((x) => x.label === 'MRN')) patient.identifier.push({ type: { text: 'MRN' }, system: r.source, value: r.value });
      if (val('Name')) patient.name = [{ text: val('Name') }];
      const sex = val('Sex'); if (sex) patient.gender = sex;
      const bd = val('Birth date'); if (bd && /^\d{4}-\d{2}-\d{2}$/.test(bd)) patient.birthDate = bd;
      const tel = ['Phone', 'Mobile'].map(val).filter(Boolean).map((v) => ({ system: 'phone', value: v }));
      if (val('Email')) tel.push({ system: 'email', value: val('Email') });
      if (tel.length) patient.telecom = tel;
      const addr = [val('Address'), val('Registered address')].filter(Boolean).map((t) => ({ text: t }));
      if (addr.length) patient.address = addr;
      entries.push({ fullUrl: `urn:uuid:patient-${safeId(pid)}`, resource: patient });
      const persistentDone = new Set(['National ID', 'MRN', 'Name', 'Sex', 'Birth date', 'Phone', 'Mobile', 'Email', 'Address', 'Registered address']);
      for (const r of rs) {
        if (persistentDone.has(r.label)) continue;
        const id = `obs-${++n}`;
        const when = fhirTime(r.time);
        if (r.label === 'Medication') {
          entries.push({ fullUrl: `urn:uuid:${id}`, resource: { resourceType: 'MedicationStatement', id, status: 'recorded', subject: { reference: pref }, medicationCodeableConcept: { text: r.value.split(';')[0] }, effectiveDateTime: when, dosage: [{ text: r.value }], note: [{ text: `source: ${r.source}` }] } });
          continue;
        }
        if (MEDIA_LABELS.has(r.label) && isMediaRef(r.value)) {
          const m = blobMeta.get(r.value) || {};
          const ct = m.mime || 'application/octet-stream';
          entries.push({ fullUrl: `urn:uuid:${id}`, resource: { resourceType: 'Media', id, status: 'completed', subject: { reference: pref }, createdDateTime: when, content: { contentType: ct, url: `media/${r.value.slice(7)}.${EXT[ct] || 'bin'}`, title: m.name || r.label } } });
          continue;
        }
        const base = S().byLabel[r.label] || (r.label.startsWith('Blood glucose') ? S().byKey.glucose : null);
        const obs = { resourceType: 'Observation', id, status: 'final', subject: { reference: pref } };
        if (when) obs.effectiveDateTime = when;
        if (base && base.vital) obs.category = [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }];
        if (base && base.key === 'bp') {
          const [s, d] = r.value.split('/').map(Number);
          obs.code = { coding: [{ system: 'http://loinc.org', code: '85354-9', display: 'Blood pressure panel' }], text: 'Blood pressure' };
          obs.component = [
            { code: { coding: [{ system: 'http://loinc.org', code: '8480-6', display: 'Systolic blood pressure' }] }, valueQuantity: { value: s, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' } },
            { code: { coding: [{ system: 'http://loinc.org', code: '8462-4', display: 'Diastolic blood pressure' }] }, valueQuantity: { value: d, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' } },
          ];
        } else if (base && base.loinc && !isNaN(parseFloat(r.value))) {
          obs.code = { coding: [{ system: 'http://loinc.org', code: base.loinc, display: base.label }], text: r.label };
          obs.valueQuantity = { value: parseFloat(r.value), unit: base.unit || undefined, system: 'http://unitsofmeasure.org', code: base.ucum || base.unit || undefined };
        } else {
          obs.code = { text: r.label };
          obs.valueString = r.value;
        }
        obs.note = [{ text: `source: ${r.source}` }];
        entries.push({ fullUrl: `urn:uuid:${id}`, resource: obs });
      }
    }
    return { resourceType: 'Bundle', type: 'collection', timestamp: new Date().toISOString(), entry: entries };
  }

  /** FHIR Bundle → rows (best effort; Observations with known LOINC codes get canonical labels). */
  function fromFHIR(bundle, source = 'file:fhir') {
    const rows = [];
    const res = (bundle.entry || []).map((e) => e.resource).filter(Boolean);
    const pid = new Map();
    const toTime = (s) => { if (!s) return 'nan'; if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.replace(/-/g, ''); const d = new Date(s); return isNaN(d) ? 'nan' : C().utcStamp(d); };
    for (const p of res.filter((r) => r.resourceType === 'Patient')) {
      const ids = p.identifier || [];
      const nat = ids.find((i) => /national/i.test(i.type?.text || ''));
      const id = (nat && nat.value) || (ids[0] && ids[0].value) || p.id;
      pid.set(`Patient/${p.id}`, id);
      const add = (label, value) => value && rows.push({ patientId: id, label, value: String(value), time: 'nan', source });
      if (nat) add('National ID', nat.value);
      for (const i of ids.filter((x) => /mrn/i.test(x.type?.text || ''))) rows.push({ patientId: id, label: 'MRN', value: i.value, time: 'nan', source: i.system || source });
      add('Name', p.name && (p.name[0].text || [...(p.name[0].family ? [p.name[0].family] : []), ...(p.name[0].given || [])].join('')));
      add('Sex', p.gender); add('Birth date', p.birthDate);
      for (const t of p.telecom || []) add(t.system === 'email' ? 'Email' : 'Phone', t.value);
      if (p.address && p.address[0]) add('Address', p.address[0].text);
    }
    const byLoinc = new Map(S().VOCAB.filter((v) => v.loinc).map((v) => [v.loinc, v]));
    for (const r of res) {
      const id = pid.get(r.subject && r.subject.reference);
      if (!id) continue;
      const src = (r.note || []).map((n) => n.text).find((t) => /^source: /.test(t))?.slice(8) || source;
      if (r.resourceType === 'Observation') {
        const code = (r.code?.coding || []).find((c) => /loinc/.test(c.system || ''))?.code;
        const t = toTime(r.effectiveDateTime);
        if (code === '85354-9' && r.component) {
          const v = (c) => r.component.find((x) => x.code?.coding?.some((k) => k.code === c))?.valueQuantity?.value;
          rows.push({ patientId: id, label: 'Blood pressure', value: `${v('8480-6')}/${v('8462-4')}`, time: t, source: src });
        } else if (code && byLoinc.has(code) && r.valueQuantity) {
          rows.push({ patientId: id, label: r.code.text && r.code.text.startsWith(byLoinc.get(code).label) ? r.code.text : byLoinc.get(code).label, value: String(r.valueQuantity.value), time: t, source: src });
        } else {
          rows.push({ patientId: id, label: r.code?.text || code || 'Observation', value: r.valueString ?? String(r.valueQuantity?.value ?? r.valueCodeableConcept?.text ?? ''), time: t, source: src });
        }
      } else if (r.resourceType === 'MedicationStatement') {
        rows.push({ patientId: id, label: 'Medication', value: r.dosage?.[0]?.text || r.medicationCodeableConcept?.text || '', time: toTime(r.effectiveDateTime), source: src });
      } else if (r.resourceType === 'Media' && r.content?.url) {
        const h = r.content.url.match(/([0-9a-f]{64})/);
        if (h) rows.push({ patientId: id, label: 'Attachment', value: 'sha256:' + h[1], time: toTime(r.createdDateTime), source: src });
      }
    }
    return rows;
  }

  // ── files ────────────────────────────────────────────────────────────
  /**
   * Build an export file.
   * kind: 'csv' | 'json' | 'fhir';  getBlob(id) → { blob, mime, name } (for media → zip)
   */
  async function exportFile(rows, kind, { getBlob, withMedia = true } = {}) {
    const media = withMedia ? [...new Set(rows.map((r) => r.value).filter(isMediaRef))] : [];
    const metas = new Map();
    const files = [];
    for (const id of media) {
      const b = getBlob ? await getBlob(id) : null;
      if (!b) continue;
      metas.set(id, b);
      files.push({ name: `media/${id.slice(7)}.${EXT[b.mime] || 'bin'}`, data: b.blob });
    }
    const stamp = C().utcStamp(new Date());
    let name, data, type;
    if (kind === 'csv') { name = `personal-db-${stamp}.csv`; data = '﻿' + C().toCSV(rows); type = 'text/csv'; }
    else if (kind === 'fhir') { name = `personal-db-${stamp}.fhir.json`; data = JSON.stringify(toFHIR(rows, metas), null, 1); type = 'application/fhir+json'; }
    else { name = `personal-db-${stamp}.json`; data = toJSON(rows); type = 'application/json'; }
    if (!files.length) return { name, blob: new Blob([data], { type }) };
    const zip = await PDB.zip.create([{ name: name.replace(/^personal-db-\d+/, 'data'), data }, ...files]);
    return { name: name.replace(/\.(csv|json)$/, '') + '.zip', blob: zip };
  }

  /**
   * Read an import file.
   * Returns { kind: 'rows', rows, media: [{ id?, name, blob }] }  – ready to import
   *      or { kind: 'grid', sheets: [{ name, rows: string[][] }] } – needs the mapping preview
   *      or { kind: 'media', media: [...] }
   */
  async function readImport(file) {
    const name = file.name || 'file';
    const lower = name.toLowerCase();
    const source = 'file:' + name;
    if (lower.endsWith('.zip')) {
      const entries = await PDB.zip.read(file);
      const dataEntry = entries.find((e) => /^data(\.fhir)?\.(json|csv)$/.test(e.name)) || entries.find((e) => /\.(json|csv)$/.test(e.name));
      const media = entries.filter((e) => e.name.startsWith('media/')).map((e) => ({ name: e.name.slice(6), blob: new Blob([e.data], { type: mimeOf(e.name) }) }));
      if (!dataEntry) return { kind: 'media', media };
      const inner = await readImport(new File([dataEntry.data], dataEntry.name));
      return { ...inner, media };
    }
    if (/\.(xlsx|xls|ods)$/.test(lower)) {
      if (!g.XLSX) throw new Error('Spreadsheet support is not loaded (run npm run build:vendor).');
      const wb = g.XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array', cellDates: false });
      return { kind: 'grid', source, sheets: wb.SheetNames.map((n) => ({ name: n, rows: g.XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' }) })) };
    }
    if (/\.(png|jpe?g|gif|webp|svg|mp3|wav|m4a|ogg|mp4|webm|mov|pdf)$/.test(lower) || /^(image|audio|video)\//.test(file.type)) {
      return { kind: 'media', media: [{ name, blob: file }] };
    }
    const text = await file.text();
    if (lower.endsWith('.json') || /^\s*[{[]/.test(text)) {
      const j = JSON.parse(text);
      if (j.format === 'personal-db') return { kind: 'rows', rows: j.rows.map(pick5), media: [] };
      if (j.resourceType === 'Bundle') return { kind: 'rows', rows: fromFHIR(j, source), media: [] };
      if (Array.isArray(j) && j[0] && 'patientId' in j[0]) return { kind: 'rows', rows: j.map(pick5), media: [] };
      throw new Error('Unknown JSON format');
    }
    if (/\.html?$/.test(lower) || /^\s*<(!doctype|html)/i.test(text)) return { kind: 'html', source, html: text };
    const grid = C().parseCSV(text);
    const head = (grid[0] || []).map((x) => x.trim());
    if (C().FIELDS.every((f, i) => head[i] === f)) {
      return { kind: 'rows', rows: grid.slice(1).map((r) => ({ patientId: r[0], label: r[1], value: r[2], time: r[3] || 'nan', source: r[4] || source })), media: [] };
    }
    return { kind: 'grid', source, sheets: [{ name, rows: grid }] };
  }
  const mimeOf = (n) => { const e = n.split('.').pop().toLowerCase(); return Object.keys(EXT).find((k) => EXT[k] === e) || 'application/octet-stream'; };

  PDB.export = { toJSON, toFHIR, fromFHIR, exportFile, readImport, isMediaRef, MEDIA_LABELS };
})(globalThis);
