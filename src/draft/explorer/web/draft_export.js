// A design from the atlas, written as a Draft robot directory:
// parameters.yaml + tree.yaml + mesh.yaml, ready for src/draft/robots/<name>/.
//
// Lengths, bends, radii, joint ranges and actuator classes become named
// parameters shared by every limb of a group, so the design stays editable in
// Draft's editor. Mount points on the hub are written as numbers.

import { walk } from './genome.js';

const COLORS = {
  link_color: '0.5 0.5 0.8 1.0',
  motor_color: '0.3 0.3 0.5 1.0',
  mot_detail_color: '0.1 0.1 0.2 1.0',
  torso_color: '0.5 0.5 0.8 1.0',
  foot_color: '0.3 0.3 0.6 1.0',
};

function num(x) {
  if (!Number.isFinite(x)) throw new Error(`non-finite value in export: ${x}`);
  if (Math.abs(x) < 5e-7) return '0';
  const s = x.toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

const expr = (key) => `"\${${key}}"`;

function value(v) {
  if (typeof v === 'number') return num(v);
  if (Array.isArray(v)) return `[${v.map(value).join(', ')}]`;
  if (v && typeof v === 'object' && v.raw !== undefined) return v.raw;
  return String(v);
}

function flow(obj) {
  return `{${Object.entries(obj).filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${value(v)}`).join(', ')}}`;
}

/** XYZ Euler angles (MuJoCo's default `eulerseq`, rotating axes) of a rotation matrix. */
export function eulerXYZ(R) {
  const b = Math.asin(Math.max(-1, Math.min(1, R[2])));
  if (Math.abs(R[2]) > 0.999999) {
    return [Math.atan2(R[7], R[4]), b, 0];
  }
  return [Math.atan2(-R[5], R[8]), b, Math.atan2(-R[1], R[0])];
}

const isIdentity = (R) => R.every((x, i) => Math.abs(x - [1, 0, 0, 0, 1, 0, 0, 0, 1][i]) < 1e-9);

/** Robot directory name for a design. */
export function robotName(design) {
  return `atlas_${design.id.toLowerCase()}`;
}

/**
 * The three files of a Draft robot directory, as strings.
 * Returns { name, files: { 'parameters.yaml', 'tree.yaml', 'mesh.yaml' } }.
 */
export function toDraft(design, origin = '') {
  const name = robotName(design);
  const params = new Map();
  const sections = new Map();
  // A group's limbs share their parameters. Where one limb needs a different
  // value (a bend that levels a foot on a limb mounted at another pitch), it
  // gets its own key rather than silently taking the group's.
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9);
  const setParam = (section, key, v, owner) => {
    if (params.has(key) && !same(params.get(key), v)) {
      const limb = owner ? owner.split('_')[0] : 'x';
      key = /^g\d_/.test(key) && limb.startsWith(key.slice(0, 2)) ? `${limb}${key.slice(2)}` : `${key}_${limb}`;
      if (params.has(key) && !same(params.get(key), v)) throw new Error(`parameter clash on ${key}`);
    }
    if (!params.has(key)) {
      params.set(key, v);
      if (!sections.has(section)) sections.set(section, []);
      sections.get(section).push(key);
    }
    return { raw: expr(key) };
  };
  const sectionOf = (node) => node.group || 'body';

  // Actuator classes actually used.
  const used = new Set();
  walk(design, (node) => { if (node.joint) used.add(node.joint.cls); });

  const lines = [];
  const emit = (node, depth) => {
    const pad = '  '.repeat(depth);
    const sec = sectionOf(node);
    const L = (s) => lines.push(pad + s);
    if (node.role === 'hub') {
      L(`name: ${node.name}`);
      L('type: root');
      L(`color: ${expr('torso_color')}`);
      L(`pos: [0, 0, ${expr('stand_height')}]`);
      L('sites: [{name: imu, pos: [0, 0, 0]}]');
      L('sensors: [{type: gyro, name: imu_ang_vel, site: imu}]');
    } else {
      lines.push(`${'  '.repeat(depth - 1)}- name: ${node.name}`);
      const type = { mount: 'basic', seg: 'basic', tip: 'sphere', foot: 'foot', wheel: 'geom',
                     palm: 'geom', jaw: 'geom', pad: 'geom', module: 'geom' }[node.role];
      L(`type: ${type}`);
      // Position: the previous member's length where it is one, else numbers.
      let pos = node.pos.map(num);
      if ((node.role === 'seg' || node.role === 'tip') && node.index > 1 && node.pos[0] > 0
          && Math.abs(node.pos[1]) < 1e-12 && Math.abs(node.pos[2]) < 1e-12) {
        pos = [node.prevNode?._lenRaw ?? num(node.pos[0]), '0', '0'];
      }
      L(`pos: [${pos.join(', ')}]`);
      if (!isIdentity(node.rot)) {
        if (node.bendParam && node.bend !== undefined) {
          const bend = setParam(sec, node.bendParam, node.bend, node.name);
          L(`euler: [0, ${bend.raw}, 0]`);
        } else {
          L(`euler: [${eulerXYZ(node.rot).map(num).join(', ')}]`);
        }
      }
      if (node.joint) {
        const j = node.joint;
        const cls = setParam(sec, j.clsParam, j.cls, node.name);
        const range = j.rangeParam ? setParam(sec, j.rangeParam, j.range, node.name) : j.range;
        L(`joint: ${flow({ name: j.name, axis: j.axis, range, motor_class: cls })}`);
      }
      // The actuator a body draws belongs to its child's joint: register the
      // class under the key the child will use.
      const driven = node.motor && node.children.find((c) => c.joint?.name === node.motor.jointName);
      const motorCls = driven ? setParam(sec, driven.joint.clsParam, driven.joint.cls, driven.name) : null;
      const geo = geometry(node, sec, (a, b, c) => setParam(a, b, c, node.name), motorCls);
      if (geo.link_l?.raw) node._lenRaw = geo.link_l.raw;
      L(`geometry: ${flow(geo)}`);
    }
    if (node.children.length) {
      L('children:');
      for (const c of node.children) emit(c, depth + 1);
    }
  };

  // Members after the first sit at the previous member's tip.
  const markPrev = (node) => {
    let prevLen = null;
    for (const c of node.children) {
      if ((c.role === 'seg' || c.role === 'tip') && node.lenParam
          && Math.abs(c.pos[0] - node.linkL) < 1e-9) {
        c.prevNode = node;
      }
      markPrev(c);
      prevLen = c;
    }
    return prevLen;
  };
  markPrev(design.root);

  emit(design.root, 0);

  const head = [
    `# ${name}: exported from Draft's morphology atlas${origin ? ` (${origin})` : ''}.`,
    '#',
    '# Not yet through the feasibility gate. To check it:',
    `#   python scripts/generate_robot.py --robot ${name}`,
    '#',
    '# No measured population covers this body plan, so mass_composition_reference',
    '# is left out and members, hub and effectors are priced at the densities',
    '# stated here; the actuators are sized from the fitted trends as usual.',
    `# latent: [${design.z.map((x) => x.toFixed(4)).join(', ')}]`,
    '',
  ];
  const out = [...head];
  out.push('# actuator classes: peak torque, no-load speed, reduction; Draft derives the rest');
  for (const c of ['L', 'M', 'S']) {
    if (!used.has(c)) continue;
    const k = design.classes[c];
    out.push(`${c}_motor_effort: ${num(k.tau)}`);
    out.push(`${c}_motor_velocity: ${num(k.velocity)}`);
    out.push(`${c}_motor_gear: ${num(k.gear)}`);
    out.push(`${c}_motor_friction: ${num(0.001 * k.tau)}`);
    out.push(`${c}_motor_damping: ${num(0.0001 * k.tau)}`);
  }
  out.push('', '# stated densities [kg/m^3]: limbs at the middle of the measured limb');
  out.push('# effective densities, the hub at the measured quadruped trunk median');
  out.push('link_rho: 600', 'torso_rho: 654', '');
  out.push('# Draft\'s default palette');
  for (const [k, v] of Object.entries(COLORS)) out.push(`${k}: ${v}`);
  out.push('', '# standing height: the lowest point of the rest pose on the floor');
  out.push(`stand_height: ${num(design.standHeight)}`);
  const titles = { g0: 'limb group 0', g1: 'limb group 1', g2: 'limb group 2', chain: 'spine and modules' };
  for (const [sec, keys] of sections) {
    out.push('', `# ${titles[sec] || sec}`);
    for (const key of keys) out.push(`${key}: ${value(params.get(key))}`);
  }

  const mesh = [
    `name: ${design.root.name}`,
    'axis: z',
    'density_param: torso_rho',
    'layers:',
    ...design.hub.layers.map((Lr) =>
      `  - {pos: ${num(Lr.z)}, polygon: [${design.hub.outline
        .map(([x, y]) => `[${num(x * Lr.scale)}, ${num(y * Lr.scale)}]`).join(', ')}]}`),
  ];

  return {
    name,
    files: {
      'parameters.yaml': out.join('\n') + '\n',
      'tree.yaml': lines.join('\n') + '\n',
      'mesh.yaml': mesh.join('\n') + '\n',
    },
  };
}

function geometry(node, sec, setParam, motorCls) {
  const motor = node.motor
    ? { motor_axis: node.motor.axis, motor_class: motorCls ?? { raw: expr(node.motor.clsParam) },
        motor_for: node.motor.jointName }
    : {};
  switch (node.role) {
    case 'mount':
      return { link_axis: 'x', link_l: 0, ...motor };
    case 'seg':
      return {
        link_axis: 'x', link_l: setParam(sec, node.lenParam, node.linkL),
        link_r: setParam(sec, node.rParam, node.linkR), link_rho: { raw: expr('link_rho') },
        ...motor,
      };
    case 'tip':
      return {
        link_axis: 'x', link_l: setParam(sec, node.lenParam, node.linkL),
        link_r: setParam(sec, node.rParam, node.linkR), link_rho: { raw: expr('link_rho') },
        sphere_dir: 1, sphere_r: setParam(sec, node.tipParam, node.tipR),
        sphere_color: { raw: expr('foot_color') },
      };
    case 'foot': {
      const f = node.foot;
      return { foot_l: f.l, foot_w: f.w, foot_h: f.h, foot_plate_h: f.plateH,
               foot_offset_x: f.offX, riser_r: node.geoms[0].r, color: { raw: expr('foot_color') } };
    }
    case 'wheel':
      return { shape: 'cylinder', r: setParam(sec, node.rParam, node.wheel.r),
               l: setParam(sec, node.wParam, node.wheel.w), axis: node.wheel.axis,
               rho: 400, color: { raw: expr('foot_color') } };
    case 'pad':
      return { shape: 'cylinder', r: setParam(sec, node.rParam, node.padR),
               l: setParam(sec, node.tParam, node.padT), axis: 'x', rho: 500,
               color: { raw: expr('foot_color') } };
    case 'palm':
    case 'jaw':
      return { shape: 'box', r: Math.min(...node.box) / 2, lx: node.box[0], ly: node.box[1],
               lz: node.box[2], rho: 700,
               color: { raw: expr(node.role === 'palm' ? 'link_color' : 'foot_color') } };
    case 'module':
      return { shape: 'box', r: Math.min(...node.box) / 2, lx: node.box[0], ly: node.box[1],
               lz: node.box[2], rho: { raw: expr('torso_rho') }, color: { raw: expr('torso_color') } };
    default:
      throw new Error(`no Draft type for role ${node.role}`);
  }
}

/** A shell snippet that writes the robot directory from the checkout root. */
export function installCommand(exported) {
  const dir = `src/draft/robots/${exported.name}`;
  const parts = [`mkdir -p ${dir}`];
  for (const [file, text] of Object.entries(exported.files)) {
    parts.push(`cat > ${dir}/${file} <<'DRAFT_EOF'\n${text}DRAFT_EOF`);
  }
  parts.push(`echo "wrote ${dir}; check it with: python scripts/generate_robot.py --robot ${exported.name}"`);
  return parts.join('\n') + '\n';
}

// ── a store-only zip, so a local page can hand over a folder in one file ─────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A .zip (no compression) holding `<name>/<file>` for each exported file. */
export function zipBytes(exported) {
  const enc = new TextEncoder();
  const entries = Object.entries(exported.files).map(([file, text]) => ({
    path: enc.encode(`${exported.name}/${file}`), data: enc.encode(text),
  }));
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const crc = crc32(e.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, e.data.length, true);
    local.setUint32(22, e.data.length, true);
    local.setUint16(26, e.path.length, true);
    chunks.push(new Uint8Array(local.buffer), e.path, e.data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, e.data.length, true);
    cen.setUint32(24, e.data.length, true);
    cen.setUint16(28, e.path.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), e.path);
    offset += 30 + e.path.length + e.data.length;
  }
  const cenSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cenSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const total = all.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}
