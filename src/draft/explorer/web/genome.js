// The morphology space the atlas draws.
//
// A design is a latent vector z: one standard-normal coordinate per gene.
// `decode(z)` turns it into a body tree whose frames already follow Draft's
// tree.yaml conventions (hinge joints about a body's own x/y/z, members along
// +x, actuators drawn by the parent at the child's joint), so draft_export.js
// writes it out without re-deriving any geometry.
//
// Nothing here is checked against Draft's feasibility gate. Actuators are drawn
// at the size Draft's fitted airgap and slenderness trends give their class;
// everything else is a stated shape.

// ── small maths ──────────────────────────────────────────────────────────────

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
export const lerp = (a, b, t) => a + (b - a) * t;
const logLerp = (a, b, t) => a * Math.pow(b / a, t);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function erf(x) {
  // Abramowitz & Stegun 7.1.26, |error| < 1.5e-7.
  const s = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

// Row-major 3x3 rotations.
export const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export function mul3(a, b) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}
export const apply3 = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
export function Rx(t) { const c = Math.cos(t), s = Math.sin(t); return [1, 0, 0, 0, c, -s, 0, s, c]; }
// Ry(t) takes +x to (cos t, 0, -sin t): a positive bend points a member down.
export function Ry(t) { const c = Math.cos(t), s = Math.sin(t); return [c, 0, s, 0, 1, 0, -s, 0, c]; }
export function Rz(t) { const c = Math.cos(t), s = Math.sin(t); return [c, -s, 0, s, c, 0, 0, 0, 1]; }
export const AXIS = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The body axis (x/y/z) a unit vector lies along, or null if it lies along none. */
function axisName(v) {
  for (const k of ['x', 'y', 'z']) if (Math.abs(Math.abs(dot(v, AXIS[k])) - 1) < 1e-6) return k;
  return null;
}

// ── Draft's actuator relations (drawing only) ────────────────────────────────
// The same fitted relations draft.trends applies (docs/fitted-trends.md):
// volume from the airgap law tau/N = 2*pi*sigma*r^2*L, sigma = 11974*tau^0.300*N^-0.833,
// shape L/D = 0.401*tau^-0.098*N^0.316, mass 0.0653*tau^0.666, speed 228.5*N^-0.938.

export function actuatorEnvelope(tau, gear) {
  const sigma = 11974 * Math.pow(tau, 0.300) * Math.pow(gear, -0.833);
  const r2L = (tau / gear) / (TAU * sigma);
  const q = 0.401 * Math.pow(tau, -0.098) * Math.pow(gear, 0.316);
  const r = Math.cbrt(r2L / (2 * q));
  return { r, len: 2 * q * r, mass: 0.0653 * Math.pow(tau, 0.666),
           velocity: 228.5 * Math.pow(gear, -0.938) };
}

// ── the genes ────────────────────────────────────────────────────────────────
// Each gene belongs to a band, and the band sets how fast it changes across the
// world map: body-plan genes drift slowly (large territories), shape genes
// faster, fine proportions fastest, so zooming in shows continuous variation
// inside a territory.

// Discrete genes get fewer octaves: high-frequency wiggle on a threshold makes
// a territory's border flicker instead of moving.
export const BANDS = {
  P: { freq: 0.022, octaves: 2 }, T: { freq: 0.06, octaves: 3 },
  S: { freq: 0.2, octaves: 4 }, F: { freq: 0.6, octaves: 4 },
};

const GROUP_GENES = [
  ['count', 'T'], ['nseg', 'T'], ['effector', 'T'], ['pattern', 'T'], ['place', 'T'],
  ['zigzag', 'T'], ['wheel_axis', 'T'], ['elev', 'S'], ['height', 'S'], ['sweep', 'S'],
  ['splay', 'S'], ['length', 'S'], ['bend', 'S'], ['spread', 'S'], ['phase', 'S'],
  ['taper', 'F'], ['ratio1', 'F'], ['ratio2', 'F'], ['tip', 'F'],
];

export const GENES = [
  ['plan', 'P'], ['symmetry', 'P'], ['radial_n', 'P'], ['n_groups', 'T'],
  ['hub_profile', 'T'], ['chain_n', 'T'], ['chain_joint', 'T'], ['chain_app', 'T'],
  ['scale', 'S'], ['hub_round', 'S'], ['hub_aspect', 'S'], ['hub_height', 'S'],
  ['chain_len', 'S'], ['torque', 'S'], ['gear', 'S'],
  ...[0, 1, 2].flatMap((k) => GROUP_GENES.map(([n, b]) => [`g${k}_${n}`, b])),
].map(([name, band], i) => ({ name, band, index: i }));

export const D = GENES.length;
const GENE_INDEX = Object.fromEntries(GENES.map((g) => [g.name, g.index]));

// ── 2-D simplex noise, for the world map ─────────────────────────────────────

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GRAD = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];

function makeSimplex(rand) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  return function (xin, yin) {
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s), j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) { t0 *= t0; const g = GRAD[perm[ii + perm[jj]] & 7]; n += t0 * t0 * (g[0] * x0 + g[1] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) { t1 *= t1; const g = GRAD[perm[ii + i1 + perm[jj + j1]] & 7]; n += t1 * t1 * (g[0] * x1 + g[1] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) { t2 *= t2; const g = GRAD[perm[ii + 1 + perm[jj + 1]] & 7]; n += t2 * t2 * (g[0] * x2 + g[1] * y2); }
    return 70 * n;
  };
}

function fbm(noise, u, v, ox, oy, octaves) {
  let sum = 0, amp = 1, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(u * f + ox + o * 17.3, v * f + oy - o * 31.7);
    amp *= 0.5;
    f *= 2;
  }
  return sum;
}

// The fBm's spread is a property of the noise, not of the seed: measure it
// once per octave count so every gene field comes out close to standard normal.
const FBM_SD = (() => {
  const out = {};
  for (const oct of new Set(Object.values(BANDS).map((b) => b.octaves))) {
    const rand = mulberry32(12345);
    const noise = makeSimplex(rand);
    let s = 0, s2 = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const x = fbm(noise, rand() * 2000 - 1000, rand() * 2000 - 1000, 0, 0, oct);
      s += x; s2 += x * x;
    }
    out[oct] = Math.sqrt(s2 / n - (s / n) ** 2);
  }
  return out;
})();

/**
 * A world is an infinite plane folded through the latent space: every gene is
 * its own smooth noise field over the plane, so a point (u, v) names a design
 * and nearby points name similar ones.
 */
export class World {
  constructor(seed) {
    this.seed = seed >>> 0;
    const rand = mulberry32(this.seed * 7919 + 1);
    this.noise = makeSimplex(rand);
    this.offsets = GENES.map(() => [rand() * 4000 - 2000, rand() * 4000 - 2000]);
  }

  latentAt(u, v) {
    const z = new Float64Array(D);
    for (const g of GENES) {
      const { freq, octaves } = BANDS[g.band];
      const [ox, oy] = this.offsets[g.index];
      z[g.index] = fbm(this.noise, u * freq, v * freq, ox, oy, octaves) / FBM_SD[octaves];
    }
    return z;
  }
}

/** Two random orthogonal directions through latent space, for a local slice. */
export function sliceDirections(seed) {
  const rand = mulberry32(seed);
  const gauss = () => {
    const u = Math.max(rand(), 1e-12), v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
  };
  const a = Array.from({ length: D }, gauss);
  const b = Array.from({ length: D }, gauss);
  const na = Math.hypot(...a);
  for (let i = 0; i < D; i++) a[i] /= na;
  const proj = a.reduce((s, ai, i) => s + ai * b[i], 0);
  for (let i = 0; i < D; i++) b[i] -= proj * a[i];
  const nb = Math.hypot(...b);
  for (let i = 0; i < D; i++) b[i] /= nb;
  return { a, b };
}

/** A point on the plane through `center` spanned by `dirs`; one unit moves each gene about half a standard deviation. */
export function sliceLatent(center, dirs, u, v) {
  const k = 0.5 * Math.sqrt(D);
  const z = new Float64Array(D);
  for (let i = 0; i < D; i++) z[i] = center[i] + k * (u * dirs.a[i] + v * dirs.b[i]);
  return z;
}

const ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** A short, stable name for a latent vector. */
export function designId(z) {
  let h = 0x811c9dc5;
  for (let i = 0; i < z.length; i++) {
    h ^= Math.round(z[i] * 1e4) & 0xffff;
    h = Math.imul(h, 0x01000193);
    h ^= (Math.round(z[i] * 1e4) >> 16) & 0xffff;
    h = Math.imul(h, 0x01000193);
  }
  h >>>= 0;
  let s = '';
  for (let i = 0; i < 5; i++) { s += ID_ALPHABET[h % 32]; h = Math.floor(h / 32); }
  return s;
}

// ── decoding helpers ─────────────────────────────────────────────────────────

function pick(g, options) {
  return options[Math.min(options.length - 1, Math.floor(g * options.length))];
}

function pickWeighted(g, weighted) {
  const total = weighted.reduce((s, [, w]) => s + w, 0);
  let acc = 0;
  for (const [value, w] of weighted) {
    acc += w / total;
    if (g < acc) return value;
  }
  return weighted[weighted.length - 1][0];
}

// Joint-axis templates for a limb, proximal first: z swings the member about
// the vertical (a coxa), y lifts it (a pitch), x twists it about itself.
const PATTERNS = [
  ['z', 'y', 'y', 'y'], ['y', 'y', 'y', 'y'], ['x', 'y', 'y', 'x'],
  ['z', 'x', 'y', 'x'], ['y', 'z', 'y', 'z'], ['x', 'z', 'y', 'y'], ['z', 'y', 'x', 'y'],
];

export const EFFECTORS = {
  ball: 'ball foot', foot: 'flat foot', wheel: 'wheel', gripper: 'gripper',
  peg: 'peg', pad: 'pad',
};

// Densities for the parts no trend prices [kg/m^3]. Members use the middle of
// the limb effective densities Draft measured (≈450–780); the hub uses the
// quadruped trunk median (654).
export const DENSITY = {
  link: 600, hub: 654, module: 654, foot: 301, tire: 400, palm: 700, pad: 500,
};

// ── the hub: stacked cross-sections, as mesh.yaml lofts them ────────────────

const OUTLINE_N = 48;

const PROFILES = {
  slab: [[-1, 1], [1, 1]],
  dome: [[-1, 1], [-0.1, 1], [0.45, 0.86], [0.8, 0.6], [1, 0.22]],
  lens: [[-1, 0.4], [-0.55, 0.86], [0, 1], [0.55, 0.86], [1, 0.4]],
  wedge: [[-1, 1], [1, 0.62]],
  keel: [[-1, 0.3], [-0.45, 0.8], [0.2, 1], [1, 1]],
};

function makeHub(g, S, sym, n) {
  const profileName = pickWeighted(g('hub_profile'),
    [['slab', 0.3], ['dome', 0.22], ['lens', 0.18], ['wedge', 0.15], ['keel', 0.15]]);
  const profile = PROFILES[profileName];
  const hh = 0.5 * S * lerp(0.16, 0.42, g('hub_height'));
  let rho;
  let shape;
  if (sym === 'radial') {
    // A rounded n-gon with flat faces centred on the limb directions, so the
    // hub keeps the body plan's rotational symmetry.
    const A = 0.5 * S * lerp(0.62, 1.05, g('hub_aspect'));
    const q = lerp(0.15, 1, g('hub_round'));
    rho = (th) => {
      const step = TAU / n;
      const d = ((th + step / 2) % step + step) % step - step / 2;
      return A / Math.pow(Math.cos(d), q);
    };
    shape = `${n}-sided`;
  } else {
    const a = 0.5 * S * lerp(0.85, 1.55, g('hub_aspect'));
    const b = 0.5 * S * lerp(0.72, 0.5, g('hub_aspect'));
    const p = logLerp(2, 7, g('hub_round'));
    rho = (th) => Math.pow(Math.pow(Math.abs(Math.cos(th) / a), p)
      + Math.pow(Math.abs(Math.sin(th) / b), p), -1 / p);
    shape = p > 4 ? 'rounded box' : 'oval';
  }
  const outline = [];
  for (let k = 0; k < OUTLINE_N; k++) {
    const th = (TAU * k) / OUTLINE_N;
    const r = rho(th);
    outline.push([r * Math.cos(th), r * Math.sin(th)]);
  }
  const layers = profile.map(([zf, s]) => ({ z: zf * hh, scale: s }));
  const scaleAt = (z) => {
    if (z <= layers[0].z) return layers[0].scale;
    for (let i = 1; i < layers.length; i++) {
      if (z <= layers[i].z) {
        const t = (z - layers[i - 1].z) / (layers[i].z - layers[i - 1].z);
        return lerp(layers[i - 1].scale, layers[i].scale, t);
      }
    }
    return layers[layers.length - 1].scale;
  };
  const point = (th, z) => {
    const r = rho(th) * scaleAt(z);
    return [r * Math.cos(th), r * Math.sin(th), z];
  };
  // The outline at angle th, at the widest the hub gets between z - hz and
  // z + hz: what a part spanning that height has to clear.
  const clearPoint = (th, z, hz) => {
    let s = 0;
    for (let i = 0; i <= 12; i++) s = Math.max(s, scaleAt(clamp(z - hz + (2 * hz * i) / 12, -hh, hh)));
    const r = rho(th) * s;
    return [r * Math.cos(th), r * Math.sin(th), z];
  };
  const normal = (th) => {
    // Outward normal of the outline, from the tangent of a star-shaped curve.
    const e = 1e-4;
    const p0 = point(th - e, 0), p1 = point(th + e, 0);
    const t = [p1[0] - p0[0], p1[1] - p0[1]];
    const len = Math.hypot(t[0], t[1]);
    return [t[1] / len, -t[0] / len, 0];
  };
  // Where the +y side of the outline crosses a given x (bilateral mounts).
  const sideAngle = (x, z) => {
    let lo = 1e-4, hi = Math.PI - 1e-4;
    for (let i = 0; i < 50; i++) {
      const mid = 0.5 * (lo + hi);
      if (point(mid, z)[0] > x) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
  };
  const area = polygonArea(outline);
  let volume = 0;
  for (let i = 1; i < layers.length; i++) {
    const s0 = layers[i - 1].scale, s1 = layers[i].scale;
    volume += area * (s0 * s0 + s0 * s1 + s1 * s1) / 3 * (layers[i].z - layers[i - 1].z);
  }
  const inside = (p, pad) => {
    if (p[2] < -hh - pad || p[2] > hh + pad) return false;
    const th = Math.atan2(p[1], p[0]);
    return Math.hypot(p[0], p[1]) <= rho(th) * scaleAt(clamp(p[2], -hh, hh)) + pad;
  };
  return { profile: profileName, shape, hh, outline, layers, rho, point, clearPoint, normal,
           sideAngle, scaleAt, inside, volume, top: hh, bottom: -hh };
}

function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

// ── limbs ────────────────────────────────────────────────────────────────────

function groupSpec(g, k, S) {
  const G = (n) => g(`g${k}_${n}`);
  return {
    k,
    nseg: pickWeighted(G('nseg'), [[1, 0.12], [2, 0.38], [3, 0.36], [4, 0.14]]),
    eff: pickWeighted(G('effector'),
      [['ball', 0.3], ['foot', 0.12], ['wheel', 0.18], ['gripper', 0.12], ['peg', 0.16], ['pad', 0.12]]),
    pattern: pick(G('pattern'), PATTERNS),
    elev: lerp(-80, 55, G('elev')) * DEG,
    height: lerp(-0.7, 0.7, G('height')),
    sweep: lerp(-45, 45, G('sweep')) * DEG,
    splay: lerp(-22, 22, G('splay')) * DEG,
    length: S * logLerp(0.45, 1.7, G('length')),
    bend: lerp(-115, 115, G('bend')) * DEG,
    zigzag: G('zigzag') > 0.55,
    taper: lerp(0.65, 1.2, G('taper')),
    ratio: [1, lerp(0.7, 1.35, G('ratio1')), lerp(0.7, 1.35, G('ratio2'))],
    tip: G('tip'),
    wheelAxis: G('wheel_axis') < 0.5 ? 'y' : 'z',
    spread: G('spread'),
    phase: G('phase'),
    count: G('count'),
    place: G('place'),
  };
}

const MARGIN = 0.006;

function drumGeoms(c, dir, r, len) {
  const h = scale(dir, len / 2);
  const ring = Math.max(0.002, len * 0.14);
  return [
    { k: 'cyl', a: add(c, scale(h, -1)), b: add(c, h), r, mat: 'motor' },
    { k: 'cyl', a: add(c, h), b: add(c, scale(dir, len / 2 + ring)), r: r * 0.72, mat: 'detail' },
  ];
}

/**
 * Build one limb. `mount` is where it leaves its parent (a point on the parent's
 * surface, its outward normal, and the limb's yaw and elevation in that frame).
 * Returns the jointless mount body; the limb's joints hang below it.
 */
function buildLimb(ctx, spec, label, mount, bendScale = 1) {
  const { classes } = ctx;
  const nseg = spec.nseg;
  const axes = spec.pattern.slice(0, nseg);
  if (spec.eff === 'wheel') axes[nseg - 1] = 'y';
  const cls = axes.map((_, i) => (i === 0 ? 'L' : i === 1 ? (nseg > 2 ? 'L' : 'M') : i === 2 ? 'M' : 'S'));
  const effCls = spec.eff === 'gripper' ? 'S' : 'M';
  const pk = `g${spec.k}`;

  let el = mount.el ?? spec.elev;
  if (spec.eff === 'wheel' && nseg === 1) el = -Math.PI / 2;

  // Rest bends, child relative to parent, all about y. A joint about the
  // member's own x or z keeps its actuator on a body axis only at a multiple
  // of 90 degrees, so those bends are quantised.
  const bends = [0];
  let alpha = -el;                 // pitch of the member below horizontal
  const alphas = [alpha];
  for (let i = 1; i < nseg; i++) {
    let b = bendScale * spec.bend * Math.pow(0.8, i - 1) * (spec.zigzag && i % 2 === 0 ? -1 : 1);
    if (axes[i] !== 'y') b = clamp(Math.round(b / (Math.PI / 2)), -1, 1) * (Math.PI / 2);
    if (spec.eff === 'wheel' && i === nseg - 1) b = Math.PI / 2 - alpha;
    bends.push(b);
    alpha += b;
    alphas.push(alpha);
  }

  // Segment lengths: a tapering split of the limb's length, never shorter than
  // the actuators at its two ends need.
  const env = (c) => classes[c];
  const endR = (i) => (i < nseg - 1 ? env(cls[i + 1]).r
    : (['foot', 'wheel', 'gripper'].includes(spec.eff) ? env(effCls).r : env(cls[i]).r * 0.6));
  const w = Array.from({ length: nseg }, (_, i) =>
    (spec.ratio[Math.min(i, 2)] * (i === 3 ? spec.ratio[1] : 1)) * Math.pow(spec.taper, i));
  const wsum = w.reduce((s, x) => s + x, 0);
  const lengths = w.map((wi, i) => {
    const want = (spec.length * wi) / wsum;
    const ends = env(cls[i]).r + endR(i);
    const lens = Math.max(env(cls[i]).len, i < nseg - 1 ? env(cls[i + 1]).len : 0);
    return Math.max(want, 1.25 * ends + 0.5 * lens + 0.01);
  });
  const linkR = lengths.map((_, i) => Math.max(0.006, 0.62 * Math.min(env(cls[i]).r, endR(i))));

  // The mount: a jointless body holding the first actuator, pushed out from the
  // parent's surface until that actuator clears it.
  const R0 = mul3(Rz(mount.phi), Ry(-el));
  const e0 = env(cls[0]);
  const d0 = apply3(R0, AXIS[axes[0]]);
  const extent = (n) => {
    const c = Math.abs(dot(d0, n));
    return e0.r * Math.sqrt(Math.max(0, 1 - c * c)) + (e0.len / 2) * c;
  };
  const base = mount.surface ? mount.surface(extent([0, 0, 1])) : mount.pos;
  const mountNode = {
    name: `${label}_mount`, role: 'mount', group: pk,
    pos: add(base, scale(mount.normal, extent(mount.normal) + MARGIN)), rot: R0, joint: null,
    geoms: drumGeoms([0, 0, 0], AXIS[axes[0]], e0.r, e0.len),
    motor: { axis: axes[0], clsParam: `${pk}_j1_mot`, jointName: `${label}_j1` },
    children: [],
  };

  let parent = mountNode;
  for (let i = 0; i < nseg; i++) {
    const last = i === nseg - 1;
    const L = lengths[i];
    const jointName = `${label}_j${i + 1}`;
    const node = {
      name: `${label}_s${i + 1}`, role: 'seg', group: pk, index: i + 1,
      pos: i === 0 ? [0, 0, 0] : [lengths[i - 1], 0, 0],
      rot: Ry(bends[i]), bend: bends[i],
      lenParam: `${pk}_s${i + 1}_length`, bendParam: `${pk}_s${i + 1}_bend`,
      rParam: `${pk}_s${i + 1}_link_r`,
      linkL: L, linkR: linkR[i],
      joint: { name: jointName, axis: axes[i], range: [-1.0, 1.0], cls: cls[i],
               clsParam: `${pk}_j${i + 1}_mot`, rangeParam: `${pk}_j${i + 1}_range` },
      geoms: [{ k: 'cyl', a: [0, 0, 0], b: [L, 0, 0], r: linkR[i], mat: 'link' }],
      children: [],
    };
    if (i === 0) node.bendParam = null;

    // The actuator for the next joint, drawn at this member's tip the way Draft
    // draws it: centred on the tip, recessed by half its length when coaxial.
    const drawNextDrum = (axisInChild, rotChild, envNext, motorInfo) => {
      const dir = apply3(rotChild, AXIS[axisInChild]);
      const name = axisName(dir);
      const coax = name === 'x';
      const c = [L - (coax ? envNext.len / 2 : 0), 0, 0];
      node.geoms.push(...drumGeoms(c, dir, envNext.r, envNext.len));
      node.motor = { ...motorInfo, axis: name };
    };

    if (!last) {
      drawNextDrum(axes[i + 1], Ry(bends[i + 1]), env(cls[i + 1]),
        { clsParam: `${pk}_j${i + 2}_mot`, jointName: `${label}_j${i + 2}` });
    } else {
      attachEffector(ctx, spec, label, node, L, alphas[i], effCls, drawNextDrum);
    }
    parent.children.push(node);
    parent = node;
  }
  return mountNode;
}

function countLimb(ctx, spec) {
  ctx.limbs += 1;
  ctx.effectors[spec.eff] = (ctx.effectors[spec.eff] || 0) + 1;
  if (spec.eff === 'wheel') ctx.wheels += 1;
}

/** Whether any part of a limb below its mount passes through the hub in the rest pose. */
function penetratesHub(hub, mountNode) {
  let hit = false;
  const visit = (node, R, p, isMount) => {
    if (!isMount) {
      for (const geom of node.geoms) {
        const pts = geom.k === 'cyl'
          ? [0.15, 0.5, 0.85, 1].map((t) => add(geom.a, scale([geom.b[0] - geom.a[0],
              geom.b[1] - geom.a[1], geom.b[2] - geom.a[2]], t)))
          : geom.k === 'sph' || geom.k === 'box' ? [geom.c] : [];
        const pad = geom.k === 'cyl' || geom.k === 'sph' ? geom.r * 0.6 : 0.01;
        for (const q of pts) if (hub.inside(add(p, apply3(R, q)), pad)) hit = true;
      }
    }
    for (const c of node.children) visit(c, mul3(R, c.rot), add(p, apply3(R, c.pos)), false);
  };
  visit(mountNode, mountNode.rot, mountNode.pos, true);
  return hit;
}

/**
 * Build every limb of a group, relaxing the group's shared rest bends until
 * no limb folds back through the hub.
 */
function buildGroup(ctx, hub, spec, labels, placements) {
  for (const bendScale of [1, 0.6, 0.3, 0]) {
    const limbs = placements.map((p, j) => buildLimb(ctx, spec, labels[j], p, bendScale));
    if (bendScale === 0 || !limbs.some((m) => penetratesHub(hub, m))) {
      limbs.forEach(() => countLimb(ctx, spec));
      return limbs;
    }
  }
  return [];
}

function attachEffector(ctx, spec, label, node, L, alpha, effCls, drawNextDrum) {
  const { classes, S } = ctx;
  const pk = `g${spec.k}`;
  const eff = spec.eff;
  const e = classes[effCls];
  if (eff === 'ball' || eff === 'peg' || eff === 'pad') {
    node.role = 'tip';
    const r = eff === 'ball' ? Math.max(node.linkR * 1.4, S * lerp(0.035, 0.075, spec.tip))
      : node.linkR * (eff === 'pad' ? 1.1 : 1.3);
    node.tipR = r;
    node.tipParam = `${pk}_tip_r`;
    node.geoms.push({ k: 'sph', c: [L, 0, 0], r, mat: eff === 'ball' ? 'foot' : 'link' });
    if (eff === 'pad') {
      const pr = node.linkR * lerp(2.4, 4.2, spec.tip);
      const th = Math.max(0.006, pr * 0.22);
      node.children.push({
        name: `${label}_pad`, role: 'pad', group: pk, pos: [L + r + th / 2, 0, 0], rot: I3,
        joint: null, padR: pr, padT: th, rParam: `${pk}_pad_r`, tParam: `${pk}_pad_t`,
        geoms: [{ k: 'cyl', a: [-th / 2, 0, 0], b: [th / 2, 0, 0], r: pr, mat: 'foot' }],
        children: [],
      });
    }
    return;
  }
  if (eff === 'foot') {
    // Level the sole whatever the leg's pose.
    const b = -alpha;
    drawNextDrum('y', Ry(b), e, { clsParam: `${pk}_ankle_mot`, jointName: `${label}_ankle` });
    const footL = Math.max(e.r * 3, ctx.S * lerp(0.16, 0.34, spec.tip));
    const footW = footL * 0.55;
    const plateH = clamp(footL * 0.06, 0.008, 0.025);
    const footH = e.r + plateH + 0.004;
    const offX = footL * 0.18;
    const riserH = Math.max(footH - plateH, e.r);
    node.children.push({
      name: `${label}_foot`, role: 'foot', group: pk, pos: [L, 0, 0], rot: Ry(b), bend: b,
      bendParam: `${pk}_foot_bend`,
      joint: { name: `${label}_ankle`, axis: 'y', range: [-0.6, 0.6], cls: effCls,
               clsParam: `${pk}_ankle_mot`, rangeParam: `${pk}_ankle_range` },
      foot: { l: footL, w: footW, h: footH, plateH, offX },
      geoms: [
        { k: 'cyl', a: [0, 0, 0], b: [0, 0, -riserH], r: e.r * 0.7, mat: 'foot' },
        { k: 'box', c: [offX, 0, -riserH - plateH / 2], s: [footL, footW, plateH], mat: 'foot' },
      ],
      children: [],
    });
    return;
  }
  if (eff === 'wheel') {
    const ax = spec.wheelAxis;
    drawNextDrum(ax, I3, e, { clsParam: `${pk}_wheel_mot`, jointName: `${label}_wheel` });
    const R = Math.max(e.r * 1.5, S * lerp(0.1, 0.24, spec.tip));
    const W = clamp(R * 0.42, e.len * 0.6, R * 0.8);
    const side = e.len / 2 + W / 2 + 0.004;
    const pos = add([L, 0, 0], scale(AXIS[ax], side));
    const A = AXIS[ax];
    node.children.push({
      name: `${label}_wheel`, role: 'wheel', group: pk, pos, rot: I3,
      joint: { name: `${label}_wheel`, axis: ax, range: [-1000, 1000], cls: effCls,
               clsParam: `${pk}_wheel_mot`, rangeParam: null, continuous: true },
      wheel: { r: R, w: W, axis: ax }, rParam: `${pk}_wheel_r`, wParam: `${pk}_wheel_w`,
      geoms: [
        { k: 'cyl', a: scale(A, -W / 2), b: scale(A, W / 2), r: R, mat: 'tire' },
        { k: 'cyl', a: scale(A, -W / 2 - 0.001), b: scale(A, W / 2 + 0.001), r: R * 0.62, mat: 'rim' },
      ],
      children: [],
    });
    return;
  }
  // Gripper: a wrist roll, a palm, two fixed jaws.
  drawNextDrum('x', I3, e, { clsParam: `${pk}_wrist_mot`, jointName: `${label}_wrist` });
  const plx = Math.max(0.012, e.r * 1.3), ply = e.r * 2.8, plz = e.r * 1.2;
  const jawL = Math.max(plx * 1.6, S * lerp(0.05, 0.11, spec.tip));
  const jawT = Math.max(0.006, ply * 0.16);
  const jaw = (side) => ({
    name: `${label}_jaw_${side > 0 ? 'l' : 'r'}`, role: 'jaw', group: pk,
    pos: [plx / 2 + jawL / 2, side * (ply / 2 - jawT / 2), 0], rot: I3, joint: null,
    box: [jawL, jawT, plz * 0.8],
    geoms: [{ k: 'box', c: [0, 0, 0], s: [jawL, jawT, plz * 0.8], mat: 'foot' }],
    children: [],
  });
  node.children.push({
    name: `${label}_palm`, role: 'palm', group: pk, pos: [L + plx / 2, 0, 0], rot: I3,
    joint: { name: `${label}_wrist`, axis: 'x', range: [-3.1, 3.1], cls: effCls,
             clsParam: `${pk}_wrist_mot`, rangeParam: `${pk}_wrist_range` },
    box: [plx, ply, plz],
    geoms: [{ k: 'box', c: [0, 0, 0], s: [plx, ply, plz], mat: 'link' }],
    children: [jaw(1), jaw(-1)],
  });
}

// ── placements on the hub ────────────────────────────────────────────────────

function sidePlacement(hub, th, zf, phiOffset, el) {
  const z = zf * hub.hh * 0.75;
  const n = hub.normal(th);
  return { pos: hub.point(th, z), surface: (hz) => hub.clearPoint(th, z, hz), normal: n,
           phi: Math.atan2(n[1], n[0]) + phiOffset, el };
}

function topPlacement(hub, up, x, spec) {
  const z = up ? hub.top : hub.bottom;
  const el = up ? lerp(50, 90, spec.elev / (55 * DEG) * 0.5 + 0.5) * DEG
    : -lerp(70, 90, spec.phase) * DEG;
  return { pos: [x * hub.scaleAt(z) * 0.8, 0, z], normal: [0, 0, up ? 1 : -1],
           phi: spec.sweep > 0 ? 0 : Math.PI, el };
}

function hubPlacements(ctx, hub, sym, n, spec) {
  const k = spec.k;
  const out = [];
  if (sym === 'radial') {
    const step = TAU / n;
    const kind = k === 0 ? 'faces' : pickWeighted(spec.place,
      [['vertices', 0.45], ['top', 0.3], ['bottom', 0.1], ['faces', 0.15]]);
    if (kind === 'top' || kind === 'bottom') {
      out.push(topPlacement(hub, kind === 'top', 0, spec));
    } else {
      const off = kind === 'vertices' ? step / 2 : 0;
      for (let j = 0; j < n; j++) {
        out.push(sidePlacement(hub, j * step + off, spec.height, spec.sweep * 0.5, spec.elev));
      }
    }
    return { kind, out };
  }
  if (sym === 'bilateral') {
    const kind = k === 0 ? 'pairs' : pickWeighted(spec.place,
      [['pairs', 0.35], ['front', 0.2], ['rear', 0.15], ['top', 0.25], ['bottom', 0.05]]);
    if (kind === 'pairs') {
      const P = k === 0 ? pickWeighted(spec.count, [[1, 0.3], [2, 0.45], [3, 0.25]])
        : pickWeighted(spec.count, [[1, 0.65], [2, 0.35]]);
      const ax = hub.point(0, 0)[0] * hub.scaleAt(spec.height * hub.hh * 0.75);
      for (let p = 0; p < P; p++) {
        const t = P === 1 ? lerp(-0.4, 0.4, spec.spread) : 1 - (2 * p) / (P - 1);
        const x = ax * (P === 1 ? t : t * lerp(0.45, 0.82, spec.spread));
        const sweep = spec.sweep * 0.6 + spec.splay * (P === 1 ? 0 : t);
        const zf = spec.height;
        const thL = hub.sideAngle(x, zf * hub.hh * 0.75);
        out.push(sidePlacement(hub, thL, zf, sweep, spec.elev));
        out.push(sidePlacement(hub, -thL, zf, -sweep, spec.elev));
      }
      return { kind, out };
    }
    if (kind === 'front' || kind === 'rear') {
      out.push(sidePlacement(hub, kind === 'front' ? 0 : Math.PI, spec.height, 0, spec.elev));
      return { kind, out };
    }
    const ax = hub.point(0, 0)[0];
    out.push(topPlacement(hub, kind === 'top', lerp(-0.5, 0.5, spec.spread) * ax, spec));
    return { kind, out };
  }
  // No symmetry: one or two limbs wherever the genes put them.
  if (spec.place < 0.18) {
    out.push(topPlacement(hub, true, 0, spec));
    return { kind: 'top', out };
  }
  const count = spec.count < 0.55 ? 1 : 2;
  const th = TAU * spec.phase;
  out.push(sidePlacement(hub, th, spec.height, spec.sweep, spec.elev));
  if (count === 2) {
    out.push(sidePlacement(hub, th + lerp(0.7, 2.6, spec.spread), -spec.height, spec.sweep,
      spec.elev));
  }
  return { kind: 'scattered', out };
}

// ── chains ───────────────────────────────────────────────────────────────────

function buildChain(ctx, hub, root, g) {
  const { S, classes } = ctx;
  const nmod = 2 + Math.floor(g('chain_n') * 6);
  const pattern = pick(g('chain_joint'), ['z', 'y', 'alt']);
  const app = pickWeighted(g('chain_app'), [['none', 0.25], ['legs', 0.4], ['wheels', 0.25], ['mixed', 0.1]]);
  const e = classes.L;
  const mlen = S * lerp(0.22, 0.45, g('chain_len'));
  const mw = 2 * hub.point(Math.PI / 2, 0)[1] * 0.85;
  const mh = 2 * hub.hh * 0.8;
  const gap = e.r + 0.01;
  const Lm = 2 * gap + mlen;
  const axisOf = (k) => (pattern === 'alt' ? (k % 2 ? 'z' : 'y') : pattern);
  const spec0 = groupSpec(g, 0, S);
  const legSpec = { ...spec0, elev: Math.min(spec0.elev, -35 * DEG), length: spec0.length * 0.6,
                    nseg: Math.min(spec0.nseg, 3), eff: spec0.eff === 'gripper' ? 'ball' : spec0.eff };
  const wheelR = Math.max(mh / 2 + S * 0.06, e.r * 1.6);

  const appendages = (parent, k, frameLabel, halfW) => {
    const kind = app === 'mixed' ? (k % 2 ? 'wheels' : 'legs') : app;
    if (kind === 'legs') {
      for (const side of [1, -1]) {
        const lab = `${frameLabel}${side > 0 ? 'l' : 'r'}`;
        parent.children.push(buildLimb(ctx, legSpec, lab, {
          pos: [0, side * halfW(0), 0], surface: (hz) => [0, side * halfW(hz), 0],
          normal: [0, side, 0], phi: side * Math.PI / 2, el: legSpec.elev,
        }));
        countLimb(ctx, legSpec);
      }
    } else if (kind === 'wheels') {
      const ew = classes.M;
      for (const side of [1, -1]) {
        const lab = `${frameLabel}${side > 0 ? 'l' : 'r'}w`;
        const W = clamp(wheelR * 0.4, ew.len * 0.6, wheelR * 0.8);
        const mountNode = {
          name: `${lab}_mount`, role: 'mount', group: 'chain',
          pos: [0, side * (halfW(ew.r) + ew.len / 2 + MARGIN), 0], rot: Rz(side * Math.PI / 2), joint: null,
          geoms: drumGeoms([0, 0, 0], AXIS.x, ew.r, ew.len),
          motor: { axis: 'x', clsParam: 'chain_wheel_mot', jointName: `${lab}_spin` },
          children: [{
            name: `${lab}_wheel`, role: 'wheel', group: 'chain',
            pos: [ew.len / 2 + W / 2 + 0.004, 0, 0], rot: I3,
            joint: { name: `${lab}_spin`, axis: 'x', range: [-1000, 1000], cls: 'M',
                     clsParam: 'chain_wheel_mot', rangeParam: null, continuous: true },
            wheel: { r: wheelR, w: W, axis: 'x' }, rParam: 'chain_wheel_r', wParam: 'chain_wheel_w',
            geoms: [
              { k: 'cyl', a: [-W / 2, 0, 0], b: [W / 2, 0, 0], r: wheelR, mat: 'tire' },
              { k: 'cyl', a: [-W / 2 - 0.001, 0, 0], b: [W / 2 + 0.001, 0, 0], r: wheelR * 0.62, mat: 'rim' },
            ],
            children: [],
          }],
        };
        parent.children.push(mountNode);
        ctx.wheels += 1;
        ctx.effectors.wheel = (ctx.effectors.wheel || 0) + 1;
      }
    }
  };

  appendages(root, 0, 'h', (hz) => hub.clearPoint(Math.PI / 2, 0, hz)[1]);

  const firstAxis = axisOf(1);
  const hzSpine = firstAxis === 'z' ? e.len / 2 : e.r;
  const rear = hub.clearPoint(Math.PI, 0, hzSpine);
  const mountNode = {
    name: 'spine_mount', role: 'mount', group: 'chain',
    pos: [rear[0] - e.r - MARGIN, 0, 0], rot: Rz(Math.PI), joint: null,
    geoms: drumGeoms([0, 0, 0], AXIS[firstAxis], e.r, e.len),
    motor: { axis: firstAxis, clsParam: 'chain_j_mot', jointName: 'spine_j1' },
    children: [],
  };
  root.children.push(mountNode);
  let parent = mountNode;
  const linkR = Math.max(0.006, 0.55 * e.r);
  for (let k = 1; k <= nmod; k++) {
    const last = k === nmod;
    const L = last ? gap + mlen + 0.01 : Lm;
    const node = {
      name: `m${k}`, role: last ? 'tip' : 'seg', group: 'chain', index: k,
      pos: k === 1 ? [0, 0, 0] : [Lm, 0, 0], rot: I3, bend: 0,
      lenParam: last ? 'chain_tail_length' : 'chain_link_length', bendParam: null,
      rParam: 'chain_link_r', linkL: L, linkR,
      joint: { name: `spine_j${k}`, axis: axisOf(k), range: [-0.7, 0.7], cls: 'L',
               clsParam: 'chain_j_mot', rangeParam: 'chain_j_range' },
      geoms: [{ k: 'cyl', a: [0, 0, 0], b: [L, 0, 0], r: linkR, mat: 'link' }],
      children: [],
    };
    if (!last) {
      node.geoms.push(...drumGeoms([L, 0, 0], AXIS[axisOf(k + 1)], e.r, e.len));
      node.motor = { axis: axisOf(k + 1), clsParam: 'chain_j_mot', jointName: `spine_j${k + 1}` };
    } else {
      node.tipR = linkR * 1.6;
      node.tipParam = 'chain_tail_r';
      node.geoms.push({ k: 'sph', c: [L, 0, 0], r: node.tipR, mat: 'link' });
    }
    const body = {
      name: `m${k}_body`, role: 'module', group: 'chain', pos: [gap + mlen / 2, 0, 0], rot: I3,
      joint: null, box: [mlen, mw, mh],
      geoms: [{ k: 'box', c: [0, 0, 0], s: [mlen, mw, mh], mat: 'hub' }],
      children: [],
    };
    appendages(body, k, `m${k}`, () => mw / 2);
    node.children.push(body);
    parent.children.push(node);
    parent = node;
  }
  ctx.modules = nmod;
  return { nmod, pattern, app };
}

// ── decode ───────────────────────────────────────────────────────────────────

/** Turn a latent vector into a design: a body tree plus what a reader needs to know about it. */
export function decode(z) {
  const g = (name) => Phi(z[GENE_INDEX[name]]);
  const plan = g('plan') < 0.8 ? 'hub' : 'chain';
  const sym = plan === 'chain' ? 'bilateral'
    : pickWeighted(g('symmetry'), [['radial', 0.42], ['bilateral', 0.42], ['asymmetric', 0.16]]);
  const n = 3 + Math.min(5, Math.floor(g('radial_n') * 6));
  const S = logLerp(0.22, 1.1, g('scale'));
  const gear = Math.round(logLerp(6, 50, g('gear')));
  const tauL = 30 * Math.pow(S / 0.5, 2.4) * lerp(0.6, 1.6, g('torque'));
  const classes = {};
  for (const [c, f] of [['L', 1], ['M', 0.55], ['S', 0.3]]) {
    const tau = Math.max(1.0, tauL * f);
    classes[c] = { tau, gear, ...actuatorEnvelope(tau, gear) };
  }
  const hub = makeHub(g, S, sym, n);
  const ctx = { S, classes, limbs: 0, wheels: 0, effectors: {}, modules: 0 };
  const root = { name: 'hub', role: 'hub', pos: [0, 0, 0], rot: I3, joint: null,
                 geoms: [{ k: 'hub' }], children: [] };

  let groups = [];
  let chain = null;
  if (plan === 'chain') {
    chain = buildChain(ctx, hub, root, g);
    const nGroups = pickWeighted(g('n_groups'), [[1, 0.6], [2, 0.4]]);
    if (nGroups === 2) {
      const spec = groupSpec(g, 1, S);
      const p = topPlacement(hub, true, hub.point(0, 0)[0] * 0.4, spec);
      root.children.push(...buildGroup(ctx, hub, spec, ['g1a'], [p]));
      groups.push({ spec, kind: 'top', count: 1 });
    }
  } else {
    const nGroups = pickWeighted(g('n_groups'), [[1, 0.35], [2, 0.45], [3, 0.2]]);
    for (let k = 0; k < nGroups; k++) {
      const spec = groupSpec(g, k, S);
      const { kind, out } = hubPlacements(ctx, hub, sym, n, spec);
      const labels = out.map((_, j) => `g${k}${String.fromCharCode(97 + j)}`);
      root.children.push(...buildGroup(ctx, hub, spec, labels, out));
      groups.push({ spec, kind, count: out.length });
    }
  }

  const design = { z: Array.from(z), plan, sym, n, S, gear, classes, hub, root, groups, chain };
  finish(design, ctx);
  return design;
}

// ── forward kinematics, bounds, summary ──────────────────────────────────────

/** Visit every body with its pose in the hub frame (rest pose: every joint at zero). */
export function walk(design, fn) {
  const visit = (node, R, p) => {
    fn(node, R, p);
    for (const c of node.children) {
      const Rc = mul3(R, c.rot);
      const pc = add(p, apply3(R, c.pos));
      visit(c, Rc, pc);
    }
  };
  visit(design.root, I3, [0, 0, 0]);
}

function geomExtremes(geom, hub) {
  if (geom.k === 'hub') {
    const pts = [];
    for (const L of hub.layers)
      for (const [x, y] of hub.outline) pts.push([x * L.scale, y * L.scale, L.z]);
    return pts;
  }
  if (geom.k === 'sph') {
    const { c, r } = geom;
    return [[c[0] - r, c[1] - r, c[2] - r], [c[0] + r, c[1] + r, c[2] + r]];
  }
  if (geom.k === 'box') {
    const [lx, ly, lz] = geom.s;
    const pts = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1])
      pts.push([geom.c[0] + sx * lx / 2, geom.c[1] + sy * ly / 2, geom.c[2] + sz * lz / 2]);
    return pts;
  }
  // Cylinder: its end discs, sampled.
  const { a, b, r } = geom;
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(...d) || 1;
  const u = d.map((x) => x / len);
  const ref = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const v1 = [u[1] * ref[2] - u[2] * ref[1], u[2] * ref[0] - u[0] * ref[2], u[0] * ref[1] - u[1] * ref[0]];
  const n1 = Math.hypot(...v1);
  const e1 = v1.map((x) => x / n1);
  const e2 = [u[1] * e1[2] - u[2] * e1[1], u[2] * e1[0] - u[0] * e1[2], u[0] * e1[1] - u[1] * e1[0]];
  const pts = [];
  for (let i = 0; i < 12; i++) {
    const t = (TAU * i) / 12;
    const off = add(scale(e1, r * Math.cos(t)), scale(e2, r * Math.sin(t)));
    pts.push(add(a, off), add(b, off));
  }
  return pts;
}

const MASS_DENSITY = { link: DENSITY.link, hub: DENSITY.module, foot: DENSITY.foot,
                       tire: DENSITY.tire, rim: 0, motor: 0, detail: 0 };

function geomVolume(geom) {
  if (geom.k === 'sph') return (4 / 3) * Math.PI * geom.r ** 3;
  if (geom.k === 'box') return geom.s[0] * geom.s[1] * geom.s[2];
  if (geom.k === 'cyl') {
    const d = Math.hypot(geom.b[0] - geom.a[0], geom.b[1] - geom.a[1], geom.b[2] - geom.a[2]);
    return Math.PI * geom.r * geom.r * d;
  }
  return 0;
}

function finish(design, ctx) {
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let dof = 0, mass = 0, actuators = 0;
  walk(design, (node, R, p) => {
    if (node.joint) {
      dof += 1;
      actuators += 1;
      mass += design.classes[node.joint.cls].mass;
    }
    for (const geom of node.geoms) {
      for (const q of geomExtremes(geom, design.hub)) {
        const w = add(p, apply3(R, q));
        for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], w[i]); hi[i] = Math.max(hi[i], w[i]); }
      }
      if (geom.k === 'hub') mass += DENSITY.hub * design.hub.volume;
      else mass += (MASS_DENSITY[geom.mat] ?? DENSITY.palm) * geomVolume(geom);
    }
  });
  design.bounds = { lo, hi };
  design.standHeight = -lo[2];
  design.dof = dof;
  design.actuators = actuators;
  design.mass = mass;
  design.limbs = ctx.limbs;
  design.wheels = ctx.wheels;
  design.effectors = ctx.effectors;
  design.height = hi[2] - lo[2];
  design.span = Math.max(hi[0] - lo[0], hi[1] - lo[1]);
  design.family = familyOf(design);
  design.id = designId(design.z);
}

function familyOf(d) {
  if (d.plan === 'chain') return { key: `chain-${d.chain.nmod + 1}`, label: `Chain ×${d.chain.nmod + 1}` };
  if (d.sym === 'radial') return { key: `radial-${d.n}`, label: `Radial ×${d.n}` };
  if (d.sym === 'bilateral') {
    const limbs = d.limbs;
    return { key: `bilateral-${limbs}`, label: `Bilateral · ${limbs} limb${limbs === 1 ? '' : 's'}` };
  }
  return { key: `asymmetric-${d.limbs}`, label: `Asymmetric · ${d.limbs} limb${d.limbs === 1 ? '' : 's'}` };
}

/** One line per part, for the detail panel. */
export function describe(d) {
  const lines = [];
  const m = (x) => `${(x * 100).toFixed(0)} cm`;
  const hubDims = `${m(2 * d.hub.point(0, 0)[0])} × ${m(2 * d.hub.point(Math.PI / 2, 0)[1])} × ${m(2 * d.hub.hh)}`;
  lines.push({ label: 'Body', text: `${d.hub.profile} ${d.hub.shape} hub, ${hubDims}` });
  if (d.chain) {
    const how = { none: 'no appendages', legs: 'a leg pair per module', wheels: 'a wheel pair per module',
                  mixed: 'legs and wheels alternating' }[d.chain.app];
    const ax = { z: 'yaw', y: 'pitch', alt: 'alternating yaw/pitch' }[d.chain.pattern];
    lines.push({ label: 'Spine', text: `${d.chain.nmod} trailing modules, ${ax} joints, ${how}` });
  }
  const axisWord = { x: 'roll', y: 'pitch', z: 'yaw' };
  for (const { spec, kind, count } of d.groups) {
    if (d.chain && spec.k === 0) continue;
    const axes = spec.pattern.slice(0, spec.nseg).map((a, i) =>
      (spec.eff === 'wheel' && i === spec.nseg - 1 ? 'pitch' : axisWord[a]));
    const where = { faces: 'around the hub', vertices: 'between them', top: 'on top', bottom: 'underneath',
                    pairs: 'in side pairs', front: 'at the front', rear: 'at the rear',
                    scattered: 'off-axis' }[kind] || kind;
    lines.push({
      label: `Limbs ×${count}`,
      text: `${where}: ${axes.join(' · ')} → ${EFFECTORS[spec.eff]}, ${m(spec.length)}`,
    });
  }
  return lines;
}
