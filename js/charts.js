/**
 * charts.js — tiny SVG chart helpers (no libraries).
 *
 * Everything is built with DOM APIs (textContent only, no innerHTML), so
 * user-controlled strings can never inject markup. Colours come from CSS
 * classes defined in css/style.css (.ch-*), which use the app's CSS variables.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** HTML element helper: el('div', { class: 'x', text: 'hi' }, child, 'text') */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  applyAttrs(node, attrs);
  appendChildren(node, children);
  return node;
}

/** SVG element helper (same signature as el). */
export function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  applyAttrs(node, attrs);
  appendChildren(node, children);
  return node;
}

function applyAttrs(node, attrs) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') node.textContent = v;
    else node.setAttribute(k, String(v));
  }
}

function appendChildren(node, children) {
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number'
      ? document.createTextNode(String(c)) : c);
  }
}

// ── Scales and ticks ──────────────────────────────────────────

/** Round a positive number up to a "nice" value (1, 2, 2.5, 5 × 10^n). */
export function niceCeil(v) {
  if (!(v > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const f = v / pow;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * pow;
}

function ticks(lo, hi, count = 4) {
  const out = [];
  for (let i = 0; i <= count; i++) out.push(lo + ((hi - lo) * i) / count);
  return out;
}

const fmtDefault = v => String(Math.round(v));

const W = 640;
const MARGIN = { l: 46, r: 10, t: 10, b: 24 };

function frame(height, ariaLabel) {
  return svgEl('svg', {
    viewBox: `0 0 ${W} ${height}`,
    class: 'ch-svg',
    role: 'img',
    'aria-label': ariaLabel,
    preserveAspectRatio: 'xMidYMid meet',
  });
}

function drawYAxis(svg, yFn, lo, hi, m, fmt) {
  for (const t of ticks(lo, hi)) {
    const y = yFn(t);
    svg.appendChild(svgEl('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, class: 'ch-grid' }));
    svg.appendChild(svgEl('text', { x: m.l - 6, y: y + 3, class: 'ch-tick', 'text-anchor': 'end', text: fmt(t) }));
  }
}

function drawRefLines(svg, refLines, yFn, m) {
  for (const r of refLines) {
    if (!Number.isFinite(r.value)) continue;
    const y = yFn(r.value);
    svg.appendChild(svgEl('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, class: `ch-ref ${r.cls || ''}` }));
    if (r.label) {
      svg.appendChild(svgEl('text', { x: W - m.r - 2, y: y - 3, class: `ch-ref-label ${r.cls || ''}`, 'text-anchor': 'end', text: r.label }));
    }
  }
}

// ── Bar chart (supports negative values) ─────────────────────

/**
 * @param {{data:Array<{label:string, value:?number, cls?:string, title?:string}>,
 *          refLines?:Array<{value:number,label?:string,cls?:string}>,
 *          ariaLabel:string, height?:number, format?:(n:number)=>string}} o
 * value === null → "sin datos" (a small tick at the baseline).
 */
export function barChart({ data, refLines = [], ariaLabel, height = 200, format = fmtDefault }) {
  const m = MARGIN;
  const iw = W - m.l - m.r;
  const ih = height - m.t - m.b;
  const values = data.map(d => d.value).filter(v => Number.isFinite(v));
  const refs = refLines.map(r => r.value).filter(Number.isFinite);

  let hi = Math.max(0, ...values, ...refs);
  let lo = Math.min(0, ...values, ...refs);
  hi = hi > 0 ? niceCeil(hi * 1.05) : 0;
  lo = lo < 0 ? -niceCeil(-lo * 1.05) : 0;
  if (hi === lo) hi = 1;

  const yFn = v => m.t + (ih * (hi - v)) / (hi - lo);
  const svg = frame(height, ariaLabel);
  drawYAxis(svg, yFn, lo, hi, m, format);

  const step = iw / Math.max(1, data.length);
  const bw = Math.max(1.5, Math.min(24, step * 0.7));
  const labelEvery = Math.max(1, Math.ceil(data.length / 8));
  const y0 = yFn(0);

  data.forEach((d, i) => {
    const cx = m.l + step * i + step / 2;
    if (d.value === null || d.value === undefined || !Number.isFinite(d.value)) {
      svg.appendChild(svgEl('line', {
        x1: cx - bw / 2, x2: cx + bw / 2, y1: y0 - 1, y2: y0 - 1, class: 'ch-nodata',
      }, svgEl('title', { text: `${d.label}: sin datos` })));
    } else {
      const y = yFn(d.value);
      svg.appendChild(svgEl('rect', {
        x: cx - bw / 2, width: bw,
        y: Math.min(y, y0), height: Math.max(1, Math.abs(y0 - y)),
        class: `ch-bar ${d.cls || ''}`,
      }, svgEl('title', { text: d.title || `${d.label}: ${format(d.value)}` })));
    }
    if (i % labelEvery === 0) {
      svg.appendChild(svgEl('text', {
        x: cx, y: height - 8, class: 'ch-tick', 'text-anchor': 'middle', text: d.label,
      }));
    }
  });

  svg.appendChild(svgEl('line', { x1: m.l, x2: W - m.r, y1: y0, y2: y0, class: 'ch-axis' }));
  drawRefLines(svg, refLines, yFn, m);
  return svg;
}

// ── Line chart ───────────────────────────────────────────────

/**
 * @param {{series:Array<{points:Array<{x:number,y:number,title?:string}>, cls?:string, dots?:boolean, line?:boolean}>,
 *          xMin:number, xMax:number, yMin:number, yMax:number,
 *          xTicks?:Array<{x:number,label:string}>,
 *          refLines?:Array<{value:number,label?:string,cls?:string}>,
 *          ariaLabel:string, height?:number, format?:(n:number)=>string}} o
 */
export function lineChart({
  series, xMin, xMax, yMin, yMax, xTicks = [], refLines = [],
  ariaLabel, height = 200, format = fmtDefault,
}) {
  const m = MARGIN;
  const iw = W - m.l - m.r;
  const ih = height - m.t - m.b;
  const xSpan = Math.max(1, xMax - xMin);
  const xFn = x => m.l + (iw * (x - xMin)) / xSpan;
  const yFn = v => m.t + (ih * (yMax - v)) / (yMax - yMin || 1);

  const svg = frame(height, ariaLabel);
  drawYAxis(svg, yFn, yMin, yMax, m, format);

  xTicks.forEach((t, i) => {
    // First/last labels are anchored inward so they are not clipped at the edges.
    const anchor = i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle';
    svg.appendChild(svgEl('text', {
      x: xFn(t.x), y: height - 8, class: 'ch-tick', 'text-anchor': anchor, text: t.label,
    }));
  });
  drawRefLines(svg, refLines, yFn, m);

  for (const s of series) {
    const pts = s.points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (s.line !== false && pts.length >= 2) {
      svg.appendChild(svgEl('polyline', {
        points: pts.map(p => `${xFn(p.x).toFixed(1)},${yFn(p.y).toFixed(1)}`).join(' '),
        class: `ch-line ${s.cls || ''}`,
      }));
    }
    if (s.dots) {
      for (const p of pts) {
        svg.appendChild(svgEl('circle', {
          cx: xFn(p.x).toFixed(1), cy: yFn(p.y).toFixed(1), r: 3.5,
          class: `ch-dot ${s.cls || ''}`,
        }, p.title ? svgEl('title', { text: p.title }) : null));
      }
    }
  }
  return svg;
}

// ── Date formatting for chart labels ─────────────────────────

/** 'YYYY-MM-DD' → 'DD/MM' */
export function fmtDay(dateKey) {
  const [, m, d] = dateKey.split('-');
  return `${d}/${m}`;
}

/** 'YYYY-MM-DD' → 'DD/MM/YYYY' */
export function fmtDayFull(dateKey) {
  const [y, m, d] = dateKey.split('-');
  return `${d}/${m}/${y}`;
}

/** es-AR number with up to `digits` decimals. */
export function fmtNum(n, digits = 1) {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('es-AR', { maximumFractionDigits: digits });
}
