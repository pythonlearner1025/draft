// The atlas: an infinite, zoomable map of robot designs.
//
// The map is tiled like a slippy map, but zoom is semantic: tiles stay about
// the same size on screen, so zooming in halves the spacing in latent space and
// the new tiles are the designs *between* the ones you were looking at.

import { World, decode, describe, sliceDirections, sliceLatent, hashString } from './genome.js';
import { Thumbnailer, DetailViewer } from './render.js';
import { toDraft, installCommand, zipBytes } from './draft_export.js';

const $ = (id) => document.getElementById(id);
const canvas = $('map');
const g2d = canvas.getContext('2d');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
// The Python server stamps its page, so the save and gate buttons only show there.
const SERVER = !!document.querySelector('meta[name="atlas-server"]');

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`atlas:${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`atlas:${key}`, JSON.stringify(value)); } catch { /* storage off */ }
  },
};

const LEVEL_MIN = -6;
const LEVEL_MAX = 11;
const target = () => (canvas.clientWidth < 640 ? 104 : 132);   // tile size on screen [px]

const state = {
  seed: store.get('seed', 1),
  mode: 'world',
  around: null,
  epoch: 0,
  view: { cx: 0, cy: 0, s: 66 },
  homeScale: 66,
  savedWorld: null,
  selected: null,
  hover: null,
  pins: store.get('pins', []),
};
let world = new World(state.seed);

// ── designs and thumbnails, cached by canonical grid point ───────────────────

class LRU {
  constructor(limit, weigh = () => 1) { this.limit = limit; this.weigh = weigh; this.map = new Map(); this.total = 0; }
  get(k) {
    const v = this.map.get(k);
    if (v !== undefined) { this.map.delete(k); this.map.set(k, v); }
    return v;
  }
  set(k, v) {
    const old = this.map.get(k);
    if (old !== undefined) { this.total -= this.weigh(old); this.map.delete(k); }
    this.map.set(k, v);
    this.total += this.weigh(v);
    while (this.total > this.limit && this.map.size > 1) {
      const [fk, fv] = this.map.entries().next().value;
      this.map.delete(fk);
      this.total -= this.weigh(fv);
    }
  }
  clear() { this.map.clear(); this.total = 0; }
}

const designs = new LRU(5000);
const thumbs = new LRU(150e6, (t) => t.px * t.px * 4);
const TIERS = [96, 160, 256, 384];

const namespace = () => (state.mode === 'world' ? `w${state.seed}` : `a${state.epoch}`);

/** A grid point named at the coarsest level it exists on, so it keeps its name across zoom levels. */
function pointKey(i, j, L) {
  while (L > LEVEL_MIN && i % 2 === 0 && j % 2 === 0) { i /= 2; j /= 2; L -= 1; }
  return `${namespace()}:${L}:${i}:${j}`;
}

function latentAt(u, v) {
  return state.mode === 'world' ? world.latentAt(u, v)
    : sliceLatent(state.around.center, state.around.dirs, u, v);
}

function designAt(i, j, L) {
  const key = pointKey(i, j, L);
  let d = designs.get(key);
  if (!d) {
    const step = 2 ** -L;
    d = decode(latentAt(i * step, j * step));
    d.key = key;
    d.where = { u: i * step, v: j * step, ns: namespace() };
    designs.set(key, d);
  }
  return d;
}

let thumbnailer = null;
try { thumbnailer = new Thumbnailer(384); } catch (e) { console.warn('no WebGL', e); }

// ── colour ───────────────────────────────────────────────────────────────────

const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
};
let tokens = {};
function readTokens() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['ground', 'ink', 'muted', 'panel', 'line', 'accent', 'pin']) {
    tokens[k] = cs.getPropertyValue(`--${k}`).trim();
  }
  tokens.dark = isDark();
}

// One hue per body plan, so territories read as regions when you zoom out.
const HUES = { bilateral: 32, asymmetric: 338, chain: 78, 'radial-3': 206, 'radial-4': 186,
               'radial-5': 166, 'radial-6': 226, 'radial-7': 248, 'radial-8': 268 };
const planKey = (d) => (d.plan === 'chain' ? 'chain' : d.sym === 'radial' ? `radial-${d.n}` : d.sym);
const planLabel = (k) => (k.startsWith('radial') ? `Radial ×${k.split('-')[1]}`
  : { bilateral: 'Bilateral', asymmetric: 'Asymmetric', chain: 'Chain' }[k]);
const tint = (k) => (tokens.dark ? `hsl(${HUES[k]} 22% 18%)` : `hsl(${HUES[k]} 40% 89%)`);
const swatch = (k) => (tokens.dark ? `hsl(${HUES[k]} 32% 40%)` : `hsl(${HUES[k]} 44% 72%)`);

// ── view maths ───────────────────────────────────────────────────────────────

function level() {
  const L = Math.round(Math.log2(state.view.s / target()));
  return Math.max(LEVEL_MIN, Math.min(LEVEL_MAX, L));
}

function toScreen(u, v) {
  const { cx, cy, s } = state.view;
  return [canvas.clientWidth / 2 + (u - cx) * s, canvas.clientHeight / 2 + (v - cy) * s];
}

function toWorld(x, y) {
  const { cx, cy, s } = state.view;
  return [cx + (x - canvas.clientWidth / 2) / s, cy + (y - canvas.clientHeight / 2) / s];
}

function tileAt(x, y) {
  const L = level();
  const step = 2 ** -L;
  const [u, v] = toWorld(x, y);
  const i = Math.round(u / step), j = Math.round(v / step);
  const [sx, sy] = toScreen(i * step, j * step);
  const half = (step * state.view.s) / 2;
  if (Math.abs(x - sx) > half || Math.abs(y - sy) > half) return null;
  return { i, j, L };
}

function zoomAt(x, y, factor) {
  const [u, v] = toWorld(x, y);
  const s = state.view.s * factor;
  const min = target() * 2 ** LEVEL_MIN * 0.75, max = target() * 2 ** LEVEL_MAX * 1.3;
  state.view.s = Math.max(min, Math.min(max, s));
  state.view.cx = u - (x - canvas.clientWidth / 2) / state.view.s;
  state.view.cy = v - (y - canvas.clientHeight / 2) / state.view.s;
  invalidate();
}

// ── drawing ──────────────────────────────────────────────────────────────────

let dirty = true;
let queue = [];
let legendSig = '';

function invalidate() {
  dirty = true;
  schedule();
}

let scheduled = false;
function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(frame);
}

function frame() {
  scheduled = false;
  const t0 = performance.now();
  if (dirty) { dirty = false; draw(); }
  // Render thumbnails nearest the middle first, a few milliseconds a frame.
  let rendered = 0;
  while (queue.length && thumbnailer && (rendered === 0 || performance.now() - t0 < 10)) {
    const job = queue.shift();
    const have = thumbs.get(job.d.key);
    if (have && have.px >= job.px) continue;
    const c = thumbnailer.render(job.d, job.px, tokens.dark ? 0.45 : 0.22);
    thumbs.set(job.d.key, { canvas: c, px: job.px, born: have ? have.born : performance.now() });
    rendered++;
  }
  if (rendered) dirty = true;
  if (dirty || queue.length || fading) schedule();
}

let fading = false;

function resizeCanvas() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  return dpr;
}

function draw() {
  const dpr = resizeCanvas();
  const W = canvas.clientWidth, H = canvas.clientHeight;
  g2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  g2d.fillStyle = tokens.ground;
  g2d.fillRect(0, 0, W, H);

  const L = level();
  const step = 2 ** -L;
  const tile = step * state.view.s;
  const [u0, v0] = toWorld(0, 0);
  const [u1, v1] = toWorld(W, H);
  const i0 = Math.floor(u0 / step) - 1, i1 = Math.ceil(u1 / step) + 1;
  const j0 = Math.floor(v0 / step) - 1, j1 = Math.ceil(v1 / step) + 1;
  const need = TIERS.find((t) => t >= tile * dpr * 0.94) ?? TIERS[TIERS.length - 1];
  const now = performance.now();
  const pinned = new Set(state.pins.map((p) => p.id));
  const counts = new Map();
  const jobs = [];
  fading = false;
  const gap = Math.max(1, Math.min(3, tile * 0.02));
  const radius = Math.min(6, tile * 0.05);

  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const d = designAt(i, j, L);
      const [sx, sy] = toScreen(i * step, j * step);
      const x = sx - tile / 2, y = sy - tile / 2;
      const pk = planKey(d);
      if (sx > -tile / 2 && sx < W + tile / 2 && sy > -tile / 2 && sy < H + tile / 2) {
        counts.set(pk, (counts.get(pk) || 0) + 1);
      }
      g2d.fillStyle = tint(pk);
      g2d.beginPath();
      g2d.roundRect(x + gap / 2, y + gap / 2, tile - gap, tile - gap, radius);
      g2d.fill();

      const th = thumbs.get(d.key);
      if (th) {
        const age = reduceMotion ? 1 : Math.min(1, (now - th.born) / 220);
        if (age < 1) fading = true;
        g2d.globalAlpha = age;
        const inset = tile * 0.04;
        g2d.drawImage(th.canvas, x + inset, y + inset, tile - 2 * inset, tile - 2 * inset);
        g2d.globalAlpha = 1;
      } else {
        g2d.fillStyle = tokens.muted;
        g2d.globalAlpha = 0.35;
        g2d.beginPath();
        g2d.arc(sx, sy, Math.max(1.5, tile * 0.025), 0, Math.PI * 2);
        g2d.fill();
        g2d.globalAlpha = 1;
      }
      if (!th || th.px < need) {
        const dist = Math.hypot(sx - W / 2, sy - H / 2);
        if (sx > -tile && sx < W + tile && sy > -tile && sy < H + tile) jobs.push({ d, px: need, dist });
      }

      if (tile >= 150) {
        g2d.fillStyle = tokens.muted;
        g2d.font = '500 11px "IBM Plex Mono", ui-monospace, monospace';
        g2d.textBaseline = 'alphabetic';
        g2d.fillText(`${d.id} · ${d.dof} DoF`, x + 10, y + tile - 10);
      }
      if (pinned.has(d.id)) {
        g2d.fillStyle = tokens.pin;
        g2d.beginPath();
        g2d.arc(x + tile - 12, y + 12, Math.max(3, tile * 0.03), 0, Math.PI * 2);
        g2d.fill();
      }
      const isOrigin = state.mode === 'around' && i === 0 && j === 0;
      if (isOrigin) {
        g2d.strokeStyle = tokens.ink;
        g2d.setLineDash([5, 4]);
        g2d.lineWidth = 1.5;
        g2d.beginPath();
        g2d.roundRect(x + gap + 2, y + gap + 2, tile - 2 * gap - 4, tile - 2 * gap - 4, radius);
        g2d.stroke();
        g2d.setLineDash([]);
        if (tile >= 90) {
          g2d.fillStyle = tokens.ink;
          g2d.font = '500 10.5px "IBM Plex Mono", ui-monospace, monospace';
          g2d.fillText('ORIGIN', x + 10, y + 18);
        }
      }
      const sel = state.selected && state.selected.key === d.key;
      const hov = state.hover && state.hover.key === d.key;
      if (sel || hov) {
        g2d.strokeStyle = tokens.accent;
        g2d.lineWidth = sel ? 2.5 : 1.5;
        g2d.beginPath();
        g2d.roundRect(x + gap / 2 + 1, y + gap / 2 + 1, tile - gap - 2, tile - gap - 2, radius);
        g2d.stroke();
      }
    }
  }
  jobs.sort((a, b) => a.dist - b.dist);
  queue = jobs;
  updateLegend(counts);
  const z = state.view.s / state.homeScale;
  $('zoom-readout').textContent = `×${z >= 10 ? z.toFixed(0) : z >= 1 ? z.toFixed(1) : z.toPrecision(2)}`;
}

function updateLegend(counts) {
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const sig = rows.map(([k, n]) => `${k}${n}`).join('|') + tokens.dark;
  if (sig === legendSig) return;
  legendSig = sig;
  const ul = $('legend-list');
  ul.replaceChildren(...rows.slice(0, 7).map(([k, n]) => {
    const li = document.createElement('li');
    const sw = document.createElement('span');
    sw.className = 'sw';
    sw.style.background = swatch(k);
    const label = document.createElement('span');
    label.textContent = planLabel(k);
    const num = document.createElement('span');
    num.className = 'n';
    num.textContent = n;
    li.append(sw, label, num);
    return li;
  }));
}

// ── input ────────────────────────────────────────────────────────────────────

const pointers = new Map();
let gesture = null;

function hideHint() {
  if (!$('hint').hidden) { $('hint').hidden = true; store.set('hintSeen', true); }
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const r = canvas.getBoundingClientRect();
  if (pointers.size === 1) {
    gesture = { kind: 'pan', x: e.clientX, y: e.clientY, sx: e.clientX - r.left, sy: e.clientY - r.top,
                t: e.timeStamp, moved: 0 };
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    gesture = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), moved: 99 };
  }
});

canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  if (!pointers.has(e.pointerId)) {
    const t = tileAt(e.clientX - r.left, e.clientY - r.top);
    const key = t ? pointKey(t.i, t.j, t.L) : null;
    if ((state.hover?.key ?? null) !== key) {
      state.hover = key ? { key } : null;
      canvas.classList.toggle('over-tile', !!key);
      invalidate();
    }
    return;
  }
  const prev = pointers.get(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (gesture?.kind === 'pan' && pointers.size === 1) {
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    gesture.moved += Math.abs(dx) + Math.abs(dy);
    if (gesture.moved > 4) { canvas.classList.add('dragging'); hideHint(); }
    state.view.cx -= dx / state.view.s;
    state.view.cy -= dy / state.view.s;
    invalidate();
  } else if (gesture?.kind === 'pinch' && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
    if (gesture.dist > 0) zoomAt(mx, my, dist / gesture.dist);
    gesture.dist = dist;
    hideHint();
  }
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  canvas.classList.remove('dragging');
  // Timed by the events themselves: a busy frame must not turn a tap into a drag.
  if (gesture?.kind === 'pan' && pointers.size === 0 && gesture.moved < 6
      && e.timeStamp - gesture.t < 600) {
    const t = tileAt(gesture.sx, gesture.sy);
    if (t) select(designAt(t.i, t.j, t.L));
  }
  if (pointers.size === 0) gesture = null;
  else if (pointers.size === 1) {
    const [p] = pointers.values();
    gesture = { kind: 'pan', x: p.x, y: p.y, moved: 99 };
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => {
  if (state.hover) { state.hover = null; invalidate(); }
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const k = e.ctrlKey ? 0.012 : 0.0016;
  zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * k));
  hideHint();
}, { passive: false });

canvas.addEventListener('dblclick', (e) => {
  const r = canvas.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, 2);
});

canvas.addEventListener('keydown', (e) => {
  const step = 60 / state.view.s;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (e.key === 'ArrowLeft') state.view.cx -= step;
  else if (e.key === 'ArrowRight') state.view.cx += step;
  else if (e.key === 'ArrowUp') state.view.cy -= step;
  else if (e.key === 'ArrowDown') state.view.cy += step;
  else if (e.key === '+' || e.key === '=') zoomAt(W / 2, H / 2, 1.5);
  else if (e.key === '-' || e.key === '_') zoomAt(W / 2, H / 2, 1 / 1.5);
  else if (e.key === 'Enter') {
    const t = tileAt(W / 2, H / 2);
    if (t) select(designAt(t.i, t.j, t.L));
  } else return;
  e.preventDefault();
  invalidate();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('sheet').hidden) closeSheet();
});

$('zoom-in').addEventListener('click', () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1.6));
$('zoom-out').addEventListener('click', () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1 / 1.6));

// ── modes ────────────────────────────────────────────────────────────────────

function updateModeUI() {
  const around = state.mode === 'around';
  $('mode-label').textContent = around ? `Around ${state.around.origin.id}` : `World ${state.seed}`;
  $('btn-world').hidden = !around;
  $('btn-reslice').hidden = !around;
  $('btn-reseed').hidden = around;
}

function exploreAround(design) {
  if (state.mode === 'world') state.savedWorld = { ...state.view };
  state.epoch += 1;
  state.around = {
    center: Float64Array.from(design.z),
    dirs: sliceDirections(hashString(design.id) + state.epoch * 7919),
    origin: design,
  };
  state.mode = 'around';
  // Start where neighbouring tiles differ by about one standard deviation per
  // gene; zoom in for smaller steps.
  state.view = { cx: 0, cy: 0, s: target() * 2 };
  state.selected = null;
  closeSheet();
  updateModeUI();
  invalidate();
}

$('btn-world').addEventListener('click', () => {
  state.mode = 'world';
  state.view = state.savedWorld ? { ...state.savedWorld } : { cx: 0, cy: 0, s: state.homeScale };
  state.selected = null;
  closeSheet();
  updateModeUI();
  invalidate();
});

$('btn-reslice').addEventListener('click', () => {
  state.epoch += 1;
  state.around.dirs = sliceDirections(hashString(state.around.origin.id) + state.epoch * 7919);
  invalidate();
});

$('btn-reseed').addEventListener('click', () => {
  state.seed = 1 + Math.floor(Math.random() * 99998);
  store.set('seed', state.seed);
  world = new World(state.seed);
  state.view = { cx: 0, cy: 0, s: state.homeScale };
  state.selected = null;
  closeSheet();
  updateModeUI();
  invalidate();
});

// ── the sheet ────────────────────────────────────────────────────────────────

let viewer = null;
let exported = null;

function stat(label, value) {
  const div = document.createElement('div');
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  div.append(dt, dd);
  return div;
}

function select(design) {
  state.selected = design;
  invalidate();
  openSheet(design);
}

function openSheet(d) {
  $('sheet').hidden = false;
  $('sheet-family').textContent = d.family.label;
  $('sheet-title').textContent = `Design ${d.id}`;
  const w = d.where;
  $('sheet-where').textContent = w
    ? (w.ns.startsWith('w') ? `world ${w.ns.slice(1)} at (${w.u.toFixed(3)}, ${w.v.toFixed(3)})`
      : `slice around ${state.around?.origin.id ?? ''} at (${w.u.toFixed(3)}, ${w.v.toFixed(3)})`)
    : 'pinned';
  const cls = d.classes;
  $('stats').replaceChildren(
    stat('DoF', d.dof),
    stat('Limbs', d.limbs),
    stat('Wheels', d.wheels),
    stat('Mass ≈', `${d.mass.toFixed(1)} kg`),
    stat('Height × span', `${(d.height * 100).toFixed(0)} × ${(d.span * 100).toFixed(0)} cm`),
    stat('Peak τ', `${cls.L.tau.toFixed(0)} N·m`),
  );
  $('parts').replaceChildren(...describe(d).map(({ label, text }) => {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = label;
    const span = document.createElement('span');
    span.textContent = text;
    li.append(b, span);
    return li;
  }));
  const pinned = state.pins.some((p) => p.id === d.id);
  $('btn-pin').setAttribute('aria-pressed', String(pinned));
  $('btn-pin').textContent = pinned ? 'Pinned' : 'Pin';

  const origin = w ? `${w.ns.startsWith('w') ? `world ${w.ns.slice(1)}` : 'local slice'}, design ${d.id}` : `design ${d.id}`;
  exported = toDraft(d, origin);
  $('check-cmd').textContent = `python scripts/generate_robot.py --robot ${exported.name}`;
  $('export-status').textContent = '';
  $('export-status').className = 'status';
  $('gate').hidden = true;
  renderFileTabs('tree.yaml');

  if (!viewer && thumbnailer) {
    try { viewer = new DetailViewer($('viewer')); } catch (e) { console.warn(e); }
  }
  if (viewer) {
    viewer.setAnimate($('animate').checked);
    viewer.show(d);
  }
}

function closeSheet() {
  $('sheet').hidden = true;
  viewer?.stop();
  if (state.selected) { state.selected = null; invalidate(); }
}
$('sheet-close').addEventListener('click', closeSheet);

$('animate').checked = !reduceMotion;
$('animate').addEventListener('change', (e) => viewer?.setAnimate(e.target.checked));

$('btn-around').addEventListener('click', () => { if (state.selected) exploreAround(state.selected); });

$('btn-pin').addEventListener('click', () => {
  const d = state.selected;
  if (!d) return;
  const i = state.pins.findIndex((p) => p.id === d.id);
  if (i >= 0) state.pins.splice(i, 1);
  else state.pins.push({ id: d.id, z: d.z.map((x) => +x.toFixed(5)) });
  store.set('pins', state.pins);
  openSheet(d);
  renderTray();
  invalidate();
});

function renderTray() {
  const list = $('tray-list');
  $('tray').hidden = state.pins.length === 0;
  list.replaceChildren(...state.pins.map((p) => {
    const b = document.createElement('button');
    b.title = `Design ${p.id}`;
    b.setAttribute('aria-label', `Open pinned design ${p.id}`);
    const d = decode(Float64Array.from(p.z));
    d.key = `pin:${p.id}`;
    if (thumbnailer) {
      const c = thumbnailer.render(d, 104, tokens.dark ? 0.45 : 0.22);
      b.append(c);
    }
    b.addEventListener('click', () => { state.selected = d; openSheet(d); invalidate(); });
    return b;
  }));
}

function renderFileTabs(active) {
  const tabs = $('file-tabs');
  tabs.replaceChildren(...Object.keys(exported.files).map((f) => {
    const b = document.createElement('button');
    b.textContent = f;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(f === active));
    b.addEventListener('click', () => renderFileTabs(f));
    return b;
  }));
  $('file-view').textContent = exported.files[active];
}

function status(text, bad = false) {
  $('export-status').textContent = text;
  $('export-status').className = bad ? 'status bad' : 'status';
}

$('btn-copy').addEventListener('click', () => {
  const cmd = installCommand(exported);
  const fallback = () => {
    $('files').open = true;
    $('file-view').textContent = cmd;
    const range = document.createRange();
    range.selectNodeContents($('file-view'));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    status('The clipboard is not available here. The command is selected below: copy it with Ctrl+C or ⌘C.', true);
  };
  try {
    navigator.clipboard.writeText(cmd).then(
      () => status(`Copied. Paste it in a terminal at the repository root to create src/draft/robots/${exported.name}/.`),
      fallback);
  } catch { fallback(); }
});

// Downloads, saving and the gate need the page to come from the local server.
$('btn-zip').hidden = !SERVER;
$('btn-save').hidden = !SERVER;
$('btn-check').hidden = !SERVER;

$('btn-zip').addEventListener('click', () => {
  const blob = new Blob([zipBytes(exported)], { type: 'application/zip' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${exported.name}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
  return data;
}

$('btn-save').addEventListener('click', async () => {
  status('Saving…');
  try {
    const res = await post('/api/save', { name: exported.name, files: exported.files });
    status(`Saved to ${res.path}.`);
  } catch (e) { status(`Not saved: ${e.message}`, true); }
});

$('btn-check').addEventListener('click', async () => {
  status('Running Draft\'s generator and feasibility gate…');
  $('gate').hidden = true;
  try {
    const res = await post('/api/check', { name: exported.name, files: exported.files });
    const box = $('gate');
    box.replaceChildren();
    const head = document.createElement('strong');
    head.textContent = res.verdict === 'compiled'
      ? `Compiled: ${res.total_mass_kg.toFixed(1)} kg as Draft prices it.`
      : 'Refused by the feasibility gate.';
    box.append(head);
    const items = res.verdict === 'compiled' ? res.warnings : res.violations;
    if (items?.length) {
      const ul = document.createElement('ul');
      ul.replaceChildren(...items.slice(0, 8).map((t) => {
        const li = document.createElement('li');
        li.textContent = t;
        return li;
      }));
      box.append(ul);
    }
    box.hidden = false;
    status(res.verdict === 'compiled' ? 'The gate passed it. Warnings, if any, are listed.' : 'See what it refused below.',
      res.verdict !== 'compiled');
  } catch (e) { status(`The check did not run: ${e.message}`, true); }
});

// ── start ────────────────────────────────────────────────────────────────────

function home() {
  state.homeScale = target() / 2;     // tiles two latent units apart
  state.view = { cx: 0, cy: 0, s: state.homeScale };
}

readTokens();
home();
if (store.get('hintSeen', false)) $('hint').hidden = true;
updateModeUI();
renderTray();
new ResizeObserver(() => invalidate()).observe(canvas);
const onTheme = () => { readTokens(); legendSig = ''; invalidate(); };
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onTheme);
new MutationObserver(onTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
invalidate();
