/*
 * Small trend chart (inline SVG): one measure per chart, one y-axis, 2px lines, ≥8px markers,
 * recessive grid, crosshair + tooltip on hover. Multi-value readings (e.g. BP 149/71) = up to four
 * series on the same axis, with legend + direct labels.
 */
(function (g) {
  const NS = 'http://www.w3.org/2000/svg';
  const s = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const fmtDate = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
  const fmtFull = (d, dateOnly) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}${dateOnly ? '' : ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')}`;
  function niceTicks(min, max, n = 4) {
    if (min === max) { min -= 1; max += 1; }
    const step0 = (max - min) / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= step0);
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const out = []; for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(6));
    return out;
  }
  /**
   * series: [{ name, points: [{ t: Date, v: number, dateOnly }] }]
   */
  function trend(container, { title, unit, series }) {
    const W = 520, H = 170, L = 40, R = 46, T = 10, B = 22;
    const all = series.flatMap((x) => x.points);
    if (!all.length) return;
    const t0 = Math.min(...all.map((p) => +p.t)), t1 = Math.max(...all.map((p) => +p.t));
    const ticks = niceTicks(Math.min(...all.map((p) => p.v)), Math.max(...all.map((p) => p.v)));
    const y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const X = (t) => (t1 === t0 ? (L + W - R) / 2 : L + ((+t - t0) / (t1 - t0)) * (W - L - R));
    const Y = (v) => T + (1 - (v - y0) / (y1 - y0 || 1)) * (H - T - B);
    const box = document.createElement('div');
    box.className = 'viz';
    const last = series[0].points[series[0].points.length - 1];
    box.innerHTML = `<h4></h4><div class="sub"></div>`;
    box.querySelector('h4').textContent = title;
    box.querySelector('.sub').textContent = `${all.length} readings · latest ${series.map((x) => x.points.at(-1).v).join('/')}${unit ? ' ' + unit : ''} on ${fmtFull(last.t, last.dateOnly)}`;
    if (series.length > 1) {
      const lg = document.createElement('div'); lg.className = 'legend';
      series.forEach((x, i) => { const sp = document.createElement('span'); sp.innerHTML = `<i style="background:var(--series-${i + 1})"></i>`; sp.append(x.name); lg.append(sp); });
      box.append(lg);
    }
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${title} trend` });
    for (const v of ticks) {
      svg.append(s('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: 'var(--grid)', 'stroke-width': 1 }));
      const tx = s('text', { x: L - 6, y: Y(v) + 3, 'text-anchor': 'end', 'font-size': 10, fill: 'var(--text-secondary)' }); tx.textContent = v; svg.append(tx);
    }
    const xt = t1 === t0 ? [t0] : [t0, t0 + (t1 - t0) / 2, t1];
    for (const t of xt) { const tx = s('text', { x: X(t), y: H - 6, 'text-anchor': 'middle', 'font-size': 10, fill: 'var(--text-secondary)' }); tx.textContent = fmtDate(new Date(t)); svg.append(tx); }
    series.forEach((x, i) => {
      const col = `var(--series-${i + 1})`;
      const d = x.points.map((p, j) => `${j ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
      svg.append(s('path', { d, fill: 'none', stroke: col, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      if (x.points.length <= 40) for (const p of x.points) svg.append(s('circle', { cx: X(p.t), cy: Y(p.v), r: 4, fill: col, stroke: 'var(--surface-1)', 'stroke-width': 2 }));
      if (series.length > 1) { const lp = x.points.at(-1); const tx = s('text', { x: X(lp.t) + 8, y: Y(lp.v) + 3, 'font-size': 10, fill: 'var(--text-secondary)' }); tx.textContent = x.name; svg.append(tx); }
    });
    // hover: crosshair + tooltip
    const cross = s('line', { y1: T, y2: H - B, stroke: 'var(--text-secondary)', 'stroke-width': 1, 'stroke-dasharray': '3 3', visibility: 'hidden' });
    svg.append(cross);
    const hit = s('rect', { x: L, y: 0, width: W - L - R, height: H, fill: 'transparent' });
    svg.append(hit);
    const tip = document.createElement('div'); tip.className = 'tip';
    const times = [...new Set(all.map((p) => +p.t))].sort((a, b) => a - b);
    hit.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      const t = times.reduce((a, b) => (Math.abs(X(b) - px) < Math.abs(X(a) - px) ? b : a));
      cross.setAttribute('x1', X(t)); cross.setAttribute('x2', X(t)); cross.setAttribute('visibility', 'visible');
      const vals = series.map((x) => { const p = x.points.find((q) => +q.t === t); return p ? `${series.length > 1 ? x.name + ': ' : ''}${p.v}${unit ? ' ' + unit : ''}` : null; }).filter(Boolean);
      const p0 = all.find((q) => +q.t === t);
      tip.textContent = `${fmtFull(new Date(t), p0.dateOnly)} · ${vals.join(' · ')}`;
      tip.style.display = 'block';
      const bx = box.getBoundingClientRect();
      tip.style.left = Math.min(e.clientX - bx.left + 12, bx.width - tip.offsetWidth - 4) + 'px';
      tip.style.top = e.clientY - bx.top - 28 + 'px';
    });
    hit.addEventListener('mouseleave', () => { tip.style.display = 'none'; cross.setAttribute('visibility', 'hidden'); });
    box.append(svg, tip);
    container.append(box);
  }
  g.Chart = { trend };
})(globalThis);
