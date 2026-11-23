/* Small UI helpers shared by the side panel and the dashboard. */
(function (g) {
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
    return el;
  };
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  /** Modal dialog built from DOM nodes; resolves with the button value ('' on Esc). */
  function modal(build, { wide } = {}) {
    const dlg = $('#dlg'), form = $('#dlgForm');
    form.textContent = '';
    if (wide) dlg.style.width = '560px'; else dlg.style.width = '';
    build(form);
    return new Promise((res) => {
      dlg.onclose = () => res(dlg.returnValue);
      dlg.returnValue = '';
      dlg.showModal();
    });
  }
  const dataURLtoBlob = (u) => fetch(u).then((r) => r.blob());
  const download = (name, blob) => { const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); };
  /** "file:<name>" for local files, the origin otherwise. */
  function sourceOf(url) {
    try { const u = new URL(url); if (u.protocol === 'file:') return 'file:' + decodeURIComponent(u.pathname.split('/').pop()); return u.origin; } catch (e) { return url || ''; }
  }
  const vocabLabels = () => PDB.schema.VOCAB.map((v) => v.label);
  g.UI = { h, $, $$, modal, dataURLtoBlob, download, sourceOf, vocabLabels };
})(globalThis);
