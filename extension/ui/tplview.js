/* The view of one page template: its masked sample page with every field outlined (and time links as arrows), and its
 * field list with labels and time links, all editable. Used by Dashboard → Mappings and by the template's own tab. */
(function (g) {
  const { h, modal, vocabLabels } = UI;
  const C = PDB.core, DB = PDB.db, PT = PDB.pagetpl;

  /**
   * One page template: its sample page with every field outlined, and the list of fields with their labels and time links.
   * opts: { zoom: 'fit' | '1', onSaved }
   */
  async function render(box, tpl, opts = {}) {
    box.textContent = '';
    const sample = await DB.getSample(tpl.id);
    const msgEl = h('span', { class: 'small pt-msg' });
    const say = (m) => { msgEl.textContent = m || ''; };
    const save = async (msg) => {
      tpl.updatedAt = Date.now();
      await DB.savePageTemplate(tpl);
      found = null; draw(); fillList();
      if (opts.onSaved) await opts.onSaved(tpl);
      say(msg);
    };
    const view = { doc: null, scale: 1, hot: null, pick: null };
    const units = () => [...tpl.fields, ...tpl.tables];
    const off = (u) => (u.kind === 'table' ? !!u.ignored : u.label === PT.IGNORE);
    const isSource = (u) => units().some((x) => x.time && x.time.mode === 'field' && x.time.field === u.id && x.id !== u.id);
    const roleClass = (u) => (u.kind === 'table' ? (u.ignored ? 'ignored' : 'table') : u.label === PT.IGNORE ? 'ignored' : u.role === 'time' || u.role === 'recordDate' || isSource(u) ? 'time' : u.unmapped ? 'unmapped' : u.role === 'identity' ? 'identity' : 'data');
    const nameOf = (u) => (u.kind === 'table' ? `Table: ${(u.map.layout === 'chart' ? u.map.rows.map((r) => r.header) : u.map.columns.map((c) => c.header)).filter(Boolean).slice(0, 4).join(' | ')}` : PT.fieldName(u));

    // ── left: the sample page ──
    const layer = h('div', { class: 'smp-layer' });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'smp-svg');
    const catcher = h('div', { class: 'smp-catch', hidden: true });
    const hover = h('div', { class: 'smp-box pick', hidden: true });
    const width = (sample && sample.width) || 1200;
    const ifr = h('iframe', { class: 'smp-frame', sandbox: 'allow-same-origin', title: 'Sample page', style: `width:${width}px` });
    const stage = h('div', { class: 'smp-stage', style: `width:${width}px` }, ifr, layer, svg, catcher, hover);
    const pane = h('div', { class: 'smp-pane' }, stage);
    const zoom = h('select', { onchange: () => fit() }, h('option', { value: 'fit', selected: opts.zoom !== '1' }, 'Fit width'), h('option', { value: '1', selected: opts.zoom === '1' }, '100% (as on the page)'));
    const addBtn = h('button', { onclick: () => startPick('add') }, '+ Add a field (click it in the sample)');
    const left = h('div', { class: 'smp' },
      h('div', { class: 'row' }, addBtn, zoom, h('span', { class: 'legend small' }, ['data', 'identity', 'time', 'unmapped', 'table', 'ignored'].map((k) => h('span', { class: `lg ${k}` }, { data: 'value', identity: 'personal detail', time: 'time source', unmapped: 'unknown label', table: 'table', ignored: 'not saved' }[k])))),
      sample ? pane : h('p', { class: 'mut card' }, 'No sample page yet: scan this page in the side panel and press Save (or Save template) to keep a masked sample of it here.'),
      sample ? h('p', { class: 'small mut' }, `Masked sample, saved ${new Date(sample.capturedAt).toLocaleString()}: values and personal details are replaced by [labels]. Hover a value to see where its time comes from.`) : null);

    function fit() {
      const avail = pane.clientWidth || width;
      view.scale = zoom.value === 'fit' ? Math.min(1, avail / width) : 1;
      stage.style.transform = `scale(${view.scale})`;
      pane.style.height = Math.min(window.innerHeight * 0.75, (stage.offsetHeight || 600) * view.scale + 4) + 'px';
    }
    const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
    const boxes = new Map(); // unit id → { el, r, div }
    // where each field is in the sample (found again only when the template changes, not on every scroll)
    let found = null;
    const relocate = () => { found = new Map(units().map((u) => [u.id, PT.locateUnit(view.doc, tpl, u)])); };
    /** Parts of the sample that scroll on their own (panels with their own scroll bar). */
    const findScrollers = () => {
      const win = view.doc.defaultView;
      view.scrollers = Array.from(view.doc.querySelectorAll('*')).filter((el) => {
        const cs = win.getComputedStyle(el);
        return /(auto|scroll)/.test(cs.overflowY + ' ' + cs.overflowX) && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
      });
    };
    /** A box clipped to the panels it sits in (null when scrolled out of sight). */
    const visibleRect = (el, r) => {
      let { x, y, w, h: hh } = r;
      for (const s of view.scrollers || []) {
        if (!s.contains(el) || s === el) continue;
        const c = rectOf(s);
        const x2 = Math.min(x + w, c.x + c.w), y2 = Math.min(y + hh, c.y + c.h);
        x = Math.max(x, c.x); y = Math.max(y, c.y); w = x2 - x; hh = y2 - y;
        if (w <= 0 || hh <= 0) return null;
      }
      return { x, y, w, h: hh };
    };
    /** ✕ on a box: cancel this mapping at once (left out; ↺ brings it back). */
    function quickToggle(u) {
      const isOff = off(u);
      return h('button', { class: 'x', type: 'button', title: isOff ? 'Read this again' : 'Cancel this mapping (not saved any more; ↺ brings it back)',
        onclick: (e) => {
          e.stopPropagation();
          if (view.pick) return;
          run(() => {
            if (isOff) { PT.restoreUnit(tpl, u.id); return save(`“${nameOf(u)}” is read again.`); }
            PT.removeUnit(tpl, u.id);
            return save(`Cancelled “${nameOf(u)}”: it is not saved any more.`);
          });
        } }, isOff ? '↺' : '✕');
    }
    function draw() {
      layer.textContent = ''; boxes.clear();
      const doc = view.doc;
      if (!doc) return;
      if (!found) relocate();
      for (const u of units()) {
        const el = found.get(u.id);
        if (!el || !el.isConnected) continue;
        const r0 = rectOf(el);
        if (!r0.w && !r0.h) continue;
        const r = visibleRect(el, r0);
        if (!r) continue;
        const tt = PT.timeText(tpl, u);
        const div = h('div', { class: `smp-box ${roleClass(u)}`, style: `left:${r.x - 2}px;top:${r.y - 2}px;width:${r.w + 4}px;height:${r.h + 4}px`,
          onmouseenter: () => setHot(u.id), onmouseleave: () => setHot(null), onclick: () => run(() => (view.pick ? null : editUnit(u))) },
          h('span', { class: 'tag' }, `${nameOf(u)}${off(u) ? ' (not saved)' : ''}${u.kind !== 'table' && tt.mode !== 'nan' ? ` · ⏱ ${tt.text}` : ''}`, quickToggle(u)));
        layer.append(div);
        boxes.set(u.id, { el, r, div });
      }
      connect();
    }
    /** Hovered unit: outline it, its time source (dashed arrow), or — for a time source — every value that uses it. */
    function setHot(id) { view.hot = id; connect(); for (const tr of list.querySelectorAll('tr[data-u]')) tr.classList.toggle('hot', tr.dataset.u === id); }
    function connect() {
      svg.textContent = '';
      for (const b of boxes.values()) b.div.classList.remove('hot', 'src');
      const id = view.hot;
      if (!id) return;
      const u = units().find((x) => x.id === id);
      const b = boxes.get(id);
      if (!u || !b) return;
      b.div.classList.add('hot');
      const users = units().filter((x) => x.time && x.time.mode === 'field' && x.time.field === id && x.id !== id);
      const pairs = u.time && u.time.mode === 'field' && u.time.field !== u.id ? [[u.id, u.time.field]] : [];
      for (const x of users) pairs.push([x.id, id]);
      svg.setAttribute('width', stage.offsetWidth); svg.setAttribute('height', stage.offsetHeight);
      svg.innerHTML = '<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="#2f6fd6"/></marker></defs>';
      for (const [from, to] of pairs) {
        const a = boxes.get(from), s = boxes.get(to);
        if (!a || !s) continue;
        s.div.classList.add('src'); a.div.classList.add('hot');
        const x1 = a.r.x, y1 = a.r.y + a.r.h / 2, x2 = s.r.x + s.r.w / 2, y2 = s.r.y + s.r.h;
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const mx = Math.min(x1, x2) - 40;
        p.setAttribute('d', `M${x1},${y1} C${mx},${y1} ${mx},${y2 + 30} ${x2},${y2 + 2}`);
        p.setAttribute('class', 'smp-link'); p.setAttribute('marker-end', 'url(#ah)');
        svg.append(p);
      }
    }
    /** Pick an element in the sample: to add a field, or as the time source of a unit. */
    function startPick(what, unit) {
      if (!view.doc) return;
      view.pick = { what, unit };
      catcher.hidden = false;
      say(what === 'add' ? 'Click the value to add in the sample page (Esc cancels).' : 'Click the date or time in the sample page (Esc cancels).');
    }
    const stopPick = () => { view.pick = null; catcher.hidden = true; hover.hidden = true; };
    const pickTarget = (e) => {
      const rect = stage.getBoundingClientRect();
      const el = view.doc.elementFromPoint((e.clientX - rect.left) / view.scale, (e.clientY - rect.top) / view.scale);
      if (!el || el === view.doc.body || el === view.doc.documentElement) return null;
      const opt = PDB.dom.optionAt(el);
      if (opt) { const g = PDB.dom.groupOf(opt); return { el: g.opts[0], group: g, box: g.container }; }
      const ctl = el.closest('input,select,textarea');
      return ctl ? { el: ctl, box: ctl } : { el, box: el };
    };
    catcher.onmousemove = (e) => {
      const t = pickTarget(e);
      if (!t) { hover.hidden = true; return; }
      const r = rectOf(t.box);
      Object.assign(hover.style, { left: r.x - 2 + 'px', top: r.y - 2 + 'px', width: r.w + 4 + 'px', height: r.h + 4 + 'px' });
      hover.hidden = false;
    };
    catcher.onclick = (e) => run(async () => {
      const t = pickTarget(e);
      const p = view.pick;
      stopPick();
      if (!t || !p) return;
      const { value, framePath, ...f } = PT.fieldFor(t);
      const tagged = t.box.closest('[data-pdb-f]');
      const existing = tagged && t.box === tagged ? tpl.fields.find((x) => tagged.getAttribute('data-pdb-f').split(' ').includes(x.id)) : tpl.fields.find((x) => x.selector === f.selector);
      if (p.what === 'add') {
        if (existing && existing.label !== PT.IGNORE) return editUnit(existing);
        const label = await chooseLabel(`Label for ${f.anchor ? `“${f.anchor}”` : 'this element'}`, f.anchor);
        if (!label) return;
        const others = PT.sameLabel(tpl, label, f);
        if (others.length && confirm(`This template already reads “${label}” from ${others.length > 1 ? `${others.length} other places` : 'another place'}.\n\nOK: use only the place you just clicked.\nCancel: keep both.`)) for (const o of others) PT.removeUnit(tpl, o.id);
        PT.addField(tpl, { ...f, from: 'sample' }, { label, from: 'sample' });
        await save(`Added “${label}”. It is read from the next scan of this page.`);
      } else {
        const src = existing && existing.label !== PT.IGNORE ? existing
          : PT.addField(tpl, { ...f, from: 'sample', role: 'time', label: C.cleanLabel(f.anchor || '') || 'time', rawLabel: f.anchor || '' }, { from: 'sample' });
        PT.setTime(tpl, p.unit.id, { mode: 'field', field: src.id });
        await save(`Time of “${nameOf(p.unit)}” ← ${PT.fieldName(src)}.`);
      }
    });
    document.onkeydown = (e) => { if (e.key === 'Escape' && view.pick) { stopPick(); say('Cancelled.'); } };

    // ── right: fields and their time links ──
    const chip = (u) => {
      const tt = PT.timeText(tpl, u);
      return h('span', { class: 'chip' + (tt.warn ? ' warn' : '') }, `⏱ ${tt.text}${tt.warn ? ' ⚠' : ''}`);
    };
    const list = h('tbody');
    /** Row buttons: edit · remove (left out, known) or restore · delete (erased from the template). */
    function actions(u) {
      const btn = (text, title, fn, cls = 'link') => h('button', { class: cls, title, onclick: (e) => { e.stopPropagation(); run(fn); } }, text);
      return [
        off(u) ? null : btn('edit', 'Change the label or the time link', () => editUnit(u)),
        off(u)
          ? btn('restore', 'Read this again', () => { PT.restoreUnit(tpl, u.id); return save(`“${nameOf(u)}” is read again.`); })
          : btn('remove', 'Leave it out: not saved, and not offered again as “not in the template”', () => { PT.removeUnit(tpl, u.id); return save(`Removed “${nameOf(u)}”. It is not read any more (restore brings it back).`); }),
        btn('✕', 'Delete from the template completely', async () => {
          const n = PT.timeUsers(tpl, u.id);
          if (!confirm(`Delete “${nameOf(u)}” from this page's template?${n ? `\n\n${n} value${n > 1 ? 's take their' : ' takes its'} time from it; ${n > 1 ? 'they' : 'it'} will use the capture time instead.` : ''}\n\nIt may be offered again as “not in the template” the next time you scan the page.`)) return;
          PT.deleteUnit(tpl, u.id);
          await save(`Deleted “${nameOf(u)}”.`);
        }, 'link danger'),
      ];
    }
    function fillList() {
    list.textContent = '';
    const ordered = [...tpl.tables.filter((t) => !off(t)), ...tpl.fields.filter((f) => !off(f)), ...tpl.tables.filter(off), ...tpl.fields.filter(off)];
    for (const u of ordered) {
      const tr = h('tr', { 'data-u': u.id, class: roleClass(u), onmouseenter: () => setHot(u.id), onmouseleave: () => setHot(null) },
        h('td', {}, h('span', { class: `dot ${roleClass(u)}` }), ' ', u.kind === 'table' ? nameOf(u) : u.label === PT.IGNORE ? h('i', {}, `${u.prevLabel || PT.fieldName(u)} (not saved)`) : u.label,
          u.role === 'time' ? h('span', { class: 'badge' }, 'time only') : null),
        h('td', { class: 'small mut' }, u.kind === 'table' ? `${u.map.layout}` : (u.kind === 'image' ? '🖼 picture, read by AI' + (u.anchor ? ` · ${u.anchor}` : '') : (u.rawLabel && C.cleanLabel(u.rawLabel) !== u.label ? C.cleanLabel(u.rawLabel) : u.anchor || '') + (u.part ? ' (part)' : ''))),
        h('td', {}, chip(u)),
        h('td', { class: 'acts' }, actions(u)));
      list.append(tr);
    }
    }
    fillList();
    const right = h('div', { class: 'tpl-fields' },
      h('table', {}, h('thead', {}, h('tr', {}, ['Label', 'On the page', 'Time', ''].map((x) => h('th', {}, x)))), list));

    // the field list is a side panel beside the sample, hidden until asked for (remembered)
    const pref = { get: () => { try { return localStorage.getItem('pdb.tplList') === 'on'; } catch (e) { return false; } }, set: (v) => { try { localStorage.setItem('pdb.tplList', v ? 'on' : 'off'); } catch (e) { /* not available */ } } };
    const grid = h('div', { class: 'tplgrid' }, left, right);
    const listBtn = h('button', { class: 'listbtn', title: 'Show or hide the list of fields and their time links' });
    const showList = (on) => {
      grid.classList.toggle('nolist', !on); right.hidden = !on;
      listBtn.textContent = on ? 'Hide field list ▸' : '◂ Field list';
      listBtn.classList.toggle('on', on);
      if (view.doc) fit();
    };
    listBtn.onclick = () => { const on = right.hidden; pref.set(on); showList(on); };
    showList(pref.get());
    box.append(h('div', { class: 'card' },
      h('div', { class: 'row' }, h('b', {}, tpl.title || 'Page template'), h('span', { class: 'mono small mut' }, `${tpl.origin}${tpl.framePath}`), msgEl, h('span', { class: 'grow' }), listBtn),
      grid));

    if (sample) {
      ifr.onload = () => {
        view.doc = ifr.contentDocument;
        if (!view.doc || !view.doc.documentElement) return;
        found = null; view.h = 0; view.sig = '';
        findScrollers();
        watch();
      };
      // follow the sample: when a panel in it scrolls, or it grows (styles applied late), the boxes are drawn again
      const token = {};
      box._tplWatch = token;
      const watch = () => {
        if (box._tplWatch !== token || !view.doc || !view.doc.documentElement) return; // another template is shown now
        const d = view.doc, win = d.defaultView;
        // at least the window height the page had (layouts sized to the window keep their shape)
        const H = Math.max(d.documentElement.scrollHeight, d.body ? d.body.scrollHeight : 0, sample.height || 0, 200);
        if (H !== view.h) { view.h = H; ifr.style.height = H + 'px'; stage.style.height = H + 'px'; findScrollers(); fit(); view.sig = ''; }
        const sig = `${win.scrollX},${win.scrollY}|${(view.scrollers || []).map((e) => `${e.scrollTop},${e.scrollLeft}`).join(';')}`;
        if (sig !== view.sig) { view.sig = sig; draw(); }
        requestAnimationFrame(watch);
      };
      ifr.srcdoc = sample.html;
      window.onresize = () => { if (view.doc) fit(); };
    }

    /** Edit a field or table: label, time link, or leave it out. */
    async function editUnit(u) {
      const isT = u.kind === 'table';
      const timeOpts = [['nan', 'Fixed: no time (the value does not change)'], ['capture', 'Capture time (when you press Scan)']];
      if (u.kind === 'image') timeOpts.unshift(['image', 'The time written in the picture (e.g. a chart’s dates; capture time if it shows none)']);
      if (isT && u.map.layout === 'chart') timeOpts.push(['column', 'Each column’s date (column headers)']);
      if (isT && u.map.layout === 'list') for (const c of PT.timeColumns(u)) timeOpts.push([`col:${c.i}`, `Column “${c.header}”`]);
      for (const f of tpl.fields) {
        if (f.label === PT.IGNORE) continue;
        const e = PDB.schema.byLabel[f.label];
        if (f.role === 'recordDate' || f.role === 'time' || (e && e.type === 'date') || /日期|時間|date|time/i.test(f.rawLabel || '')) timeOpts.push([`f:${f.id}`, f.id === u.id ? 'Its own value (a date)' : `The date in “${PT.fieldName(f)}”`]);
      }
      if (view.doc) timeOpts.push(['pick', 'Pick the date in the sample page…']);
      const cur = u.time || { mode: 'capture' };
      const curKey = cur.mode === 'field' ? `f:${cur.field}` : cur.mode === 'column' ? (isT && u.map.layout === 'list' ? `col:${(cur.cols || []).join(',')}` : 'column') : cur.mode;
      if (!timeOpts.some(([v]) => v === curKey)) timeOpts.push([curKey, PT.timeText(tpl, u).text]);
      let timeKey = curKey;
      const fixed = !isT && PT.isPersistent(u.label);
      const labels = [...new Set([u.label, ...vocabLabels()])].filter((l) => l && l !== PT.IGNORE);
      const sel = isT ? null : h('select', {}, labels.map((l) => h('option', { value: l, selected: l === u.label }, l)));
      const own = isT ? null : h('input', { placeholder: 'or type your own label' });
      const off = isT ? null : h('input', { type: 'checkbox', checked: u.label === PT.IGNORE });
      const cols = isT && u.map.layout === 'list' ? u.map.columns.filter((c) => c.header && c.kind !== 'time') : isT ? u.map.rows : [];
      const colRows = cols.map((c) => ({ c, on: h('input', { type: 'checkbox', checked: !c.off && !(c.spec && c.spec.skip) }),
        sel: h('select', {}, [...new Set([(c.spec && c.spec.label) || C.cleanLabel(c.header), ...vocabLabels()])].map((l) => h('option', { value: l, selected: l === ((c.spec && c.spec.label) || C.cleanLabel(c.header)) }, l))) }));
      const res = await modal((form) => {
        form.append(h('b', {}, isT ? nameOf(u) : `Field “${PT.fieldName(u)}”`));
        if (!isT) form.append(h('label', {}, 'Label ', sel), own, h('label', {}, off, ' Leave out (known, not saved)'));
        if (isT) form.append(h('div', { class: 'payload' }, h('table', {}, h('thead', {}, h('tr', {}, ['', 'Column', 'Saved as'].map((x) => h('th', {}, x)))),
          h('tbody', {}, colRows.map((x) => h('tr', {}, h('td', {}, x.on), h('td', {}, x.c.header), h('td', {}, x.sel)))))));
        form.append(h('b', {}, 'Time'), fixed ? h('p', { class: 'small mut' }, 'Personal details are always fixed (no time).')
          : h('div', { class: 'choices' }, timeOpts.map(([v, t]) => h('label', {}, h('input', { type: 'radio', name: 'tl', value: v, checked: v === curKey, onchange: () => { timeKey = v; } }), ' ', t))));
        form.append(h('div', { class: 'btns' }, h('button', { value: '' }, 'Cancel'), h('button', { class: 'primary', value: 'ok' }, 'Save')));
      }, { wide: true });
      if (res !== 'ok') return;
      if (!isT) {
        if (off.checked) u.label = PT.IGNORE;
        else { const l = own.value.trim() || sel.value; if (l !== u.label) PT.setLabel(tpl, u.id, l); }
      } else {
        for (const x of colRows) {
          x.c.off = !x.on.checked;
          const was = (x.c.spec && x.c.spec.label) || C.cleanLabel(x.c.header);
          if (x.on.checked && x.sel.value !== was) { x.c.spec = { label: x.sel.value, rawLabel: x.c.header, how: 'taught' }; x.c.sub = null; x.c.taught = true; }
        }
      }
      if (!fixed && timeKey !== curKey) {
        if (timeKey === 'pick') { await save(); return startPick('time', u); }
        const link = timeKey === 'nan' ? { mode: 'nan' } : timeKey === 'capture' ? { mode: 'capture' } : timeKey === 'image' ? { mode: 'image' } : timeKey === 'column' ? { mode: 'column' }
          : timeKey.startsWith('col:') ? { mode: 'column', cols: timeKey.slice(4).split(',').map(Number) } : { mode: 'field', field: timeKey.slice(2) };
        PT.setTime(tpl, u.id, link);
      }
      await save('Saved. The page is read this way from the next scan.');
    }
  }
  async function run(fn) { try { await fn(); } catch (e) { console.error(e); alert(e.message || e); } }
  /** Dialog: pick a vocabulary label or type a custom one. */
  async function chooseLabel(title, suggestion) {
    const r = C.resolveLabel(suggestion || '');
    let chosen = '';
    const res = await modal((f) => {
      const sel = h('select', {}, h('option', { value: '' }, '— choose —'), vocabLabels().map((l) => h('option', { value: l, selected: r && r.label === l }, l)));
      const txt = h('input', { placeholder: 'or type your own label', value: r ? '' : C.cleanLabel(suggestion || '') });
      f.append(h('b', {}, title), sel, txt,
        h('div', { class: 'btns' }, h('button', { value: '' }, 'Cancel'), h('button', { class: 'primary', value: 'ok', onclick: () => { chosen = txt.value.trim() || sel.value; } }, 'OK')));
    });
    return res === 'ok' ? chosen : '';
  }

  g.TplView = { render };
})(globalThis);
