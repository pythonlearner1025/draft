// three.js drawing of atlas designs: one shared off-screen renderer for the
// map's thumbnails, and an orbit view for the selected design.
//
// Both draw a design as a handful of instanced meshes (one per primitive and
// material) whose matrices come straight from forward kinematics, so a robot
// with two hundred parts is about ten draw calls rather than two hundred, and
// swinging its joints costs a few hundred matrix products.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Draft's own palette (link 0.5 0.5 0.8, motor 0.3 0.3 0.5, foot 0.3 0.3 0.6),
// so a design looks here the way the generator will draw it.
const PALETTE = {
  hub: { color: 0x8f93d8, roughness: 0.62, metalness: 0.05 },
  link: { color: 0x8080cc, roughness: 0.55, metalness: 0.05 },
  motor: { color: 0x4d4d80, roughness: 0.38, metalness: 0.35 },
  detail: { color: 0x1a1a33, roughness: 0.5, metalness: 0.2 },
  foot: { color: 0x4d4d99, roughness: 0.7, metalness: 0.05 },
  tire: { color: 0x2b2d3a, roughness: 0.92, metalness: 0.0 },
  rim: { color: 0xc3c6d6, roughness: 0.35, metalness: 0.5 },
};

const MATERIALS = Object.fromEntries(Object.entries(PALETTE).map(([k, v]) =>
  [k, new THREE.MeshStandardMaterial(v)]));
// Diffuse-only stand-ins: a fraction of the per-pixel cost, for a GPU that is
// really a CPU (software WebGL).
const LIGHT_MATERIALS = Object.fromEntries(Object.entries(PALETTE).map(([k, v]) =>
  [k, new THREE.MeshLambertMaterial({ color: v.color })]));

/**
 * 'software' when WebGL is being rasterised on the CPU (SwiftShader, llvmpipe,
 * Microsoft Basic Render): every pixel there is expensive, so the atlas draws
 * smaller, plainer thumbnails and a shadowless detail view.
 */
export function renderingTier() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return 'none';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name) ? 'software' : 'hardware';
  } catch { return 'none'; }
}

const UNIT = {
  cyl: new THREE.CylinderGeometry(1, 1, 1, 18, 1),
  sph: new THREE.SphereGeometry(1, 18, 12),
  box: new THREE.BoxGeometry(1, 1, 1),
};
const Y = new THREE.Vector3(0, 1, 0);
const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

/** The hub as mesh.yaml lofts it: stacked outlines joined side to side, capped flat. One geometry. */
function hubGeometry(hub) {
  const n = hub.outline.length;
  const pos = [];
  const idx = [];
  hub.layers.forEach((L) => {
    for (const [x, y] of hub.outline) pos.push(x * L.scale, y * L.scale, L.z);
  });
  for (let l = 0; l < hub.layers.length - 1; l++) {
    for (let i = 0; i < n; i++) {
      const a = l * n + i, b = l * n + ((i + 1) % n), c = (l + 1) * n + i, d = (l + 1) * n + ((i + 1) % n);
      idx.push(a, b, d, a, d, c);
    }
  }
  // Caps get their own vertices, so they shade flat while the sides stay smooth.
  const cap = (L, up) => {
    const base = pos.length / 3;
    pos.push(0, 0, L.z);
    for (const [x, y] of hub.outline) pos.push(x * L.scale, y * L.scale, L.z);
    for (let i = 0; i < n; i++) {
      const a = base + 1 + i, b = base + 1 + ((i + 1) % n);
      if (up) idx.push(base, a, b); else idx.push(base, b, a);
    }
  };
  cap(hub.layers[0], false);
  cap(hub.layers[hub.layers.length - 1], true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function localMatrix(geom) {
  const m = new THREE.Matrix4();
  if (geom.k === 'cyl') {
    const a = new THREE.Vector3(...geom.a), b = new THREE.Vector3(...geom.b);
    const d = b.clone().sub(a);
    const len = Math.max(d.length(), 1e-4);
    const q = new THREE.Quaternion().setFromUnitVectors(Y, d.normalize());
    m.compose(a.add(b).multiplyScalar(0.5), q, new THREE.Vector3(geom.r, len, geom.r));
  } else if (geom.k === 'sph') {
    m.compose(new THREE.Vector3(...geom.c), new THREE.Quaternion(), new THREE.Vector3(geom.r, geom.r, geom.r));
  } else {
    m.compose(new THREE.Vector3(...geom.c), new THREE.Quaternion(), new THREE.Vector3(...geom.s));
  }
  return m;
}

/** A design drawn as instanced meshes, posed by forward kinematics. Reused design after design. */
class Instancer {
  constructor(scene, shadows, materials = MATERIALS) {
    this.scene = scene;
    this.shadows = shadows;
    this.materials = materials;
    this.meshes = new Map();
    this.hub = new THREE.Mesh(new THREE.BufferGeometry(), materials.hub);
    this.hub.matrixAutoUpdate = false;
    this.hub.castShadow = this.hub.receiveShadow = shadows;
    scene.add(this.hub);
    this.tmp = new THREE.Matrix4();
    this.bodies = [];
    this.geoms = [];
    this.world = [];
  }

  _mesh(key, need) {
    let m = this.meshes.get(key);
    if (!m || m.instanceMatrix.count < need) {
      const cap = Math.max(need, m ? m.instanceMatrix.count * 2 : 128);
      if (m) { this.scene.remove(m); m.dispose(); }
      const [k, mat] = key.split(':');
      m = new THREE.InstancedMesh(UNIT[k], this.materials[mat], cap);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = m.receiveShadow = this.shadows;
      this.scene.add(m);
      this.meshes.set(key, m);
    }
    return m;
  }

  setDesign(design) {
    const bodies = [];
    const geoms = [];
    const counts = new Map();
    const visit = (node, parent) => {
      const idx = bodies.length;
      const R = node.rot;
      const rest = new THREE.Matrix4().set(
        R[0], R[1], R[2], node.pos[0], R[3], R[4], R[5], node.pos[1], R[6], R[7], R[8], node.pos[2], 0, 0, 0, 1);
      if (parent < 0) rest.premultiply(new THREE.Matrix4().makeTranslation(0, 0, design.standHeight));
      bodies.push({ parent, rest, joint: node.joint, axis: node.joint ? AXES[node.joint.axis] : null,
                    phase: bodies.length * 0.9 });
      for (const g of node.geoms) {
        if (g.k === 'hub') continue;
        const key = `${g.k}:${g.mat}`;
        const slot = counts.get(key) || 0;
        counts.set(key, slot + 1);
        geoms.push({ body: idx, key, slot, local: localMatrix(g) });
      }
      for (const c of node.children) visit(c, idx);
    };
    visit(design.root, -1);
    for (const [key, m] of this.meshes) if (!counts.has(key)) m.count = 0;
    for (const [key, n] of counts) this._mesh(key, n).count = n;
    for (const g of geoms) g.mesh = this.meshes.get(g.key);
    this.hub.geometry.dispose();
    this.hub.geometry = hubGeometry(design.hub);
    this.bodies = bodies;
    this.geoms = geoms;
    while (this.world.length < bodies.length) this.world.push(new THREE.Matrix4());
  }

  /** Pose every part. `t` in seconds swings the joints; null is the rest pose. */
  pose(t = null) {
    const { bodies, world, tmp } = this;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b.parent < 0) world[i].copy(b.rest);
      else world[i].multiplyMatrices(world[b.parent], b.rest);
      if (t !== null && b.axis) {
        let a;
        if (b.joint.continuous) a = t * 2.2;
        else {
          const [lo, hi] = b.joint.range;
          a = Math.min(0.45, (hi - lo) / 4) * Math.sin(t * 1.6 + b.phase);
        }
        world[i].multiply(tmp.makeRotationAxis(b.axis, a));
      }
    }
    this.hub.matrix.copy(world[0]);
    this.hub.matrixWorldNeedsUpdate = true;
    for (const g of this.geoms) g.mesh.setMatrixAt(g.slot, tmp.multiplyMatrices(world[g.body], g.local));
    for (const m of this.meshes.values()) if (m.count) m.instanceMatrix.needsUpdate = true;
  }
}

function frame(design) {
  const { lo, hi } = design.bounds;
  const h = design.standHeight;
  const c = new THREE.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2 + h);
  const r = 0.5 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  return { c, r };
}

// Seen from the front-left and a little above, the way a part is drawn on a sheet.
const VIEW = new THREE.Vector3(Math.cos(24 * Math.PI / 180) * Math.cos(38 * Math.PI / 180),
  Math.cos(24 * Math.PI / 180) * Math.sin(38 * Math.PI / 180), Math.sin(24 * Math.PI / 180));

function lights(scene, shadows) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x7a7f96, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(2.5, 1.5, 4);
  if (shadows) {
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.01;
  }
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xdfe3ff, 0.7);
  rim.position.set(-3, -2, 1.5);
  scene.add(rim);
  return key;
}

/** A soft dark disc, for the contact shadow under a thumbnail. */
function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(10, 12, 30, 1)');
  grad.addColorStop(1, 'rgba(10, 12, 30, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Renders designs one at a time for the map. Each result is an ImageBitmap,
 * copied on the GPU: nothing is read back to the CPU, and the map frees it
 * with close() when it falls out of the cache.
 */
export class Thumbnailer {
  constructor(size, { light = false } = {}) {
    this.size = size;
    this.light = light;
    this.canvas = document.createElement('canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: !light, alpha: true,
                                              preserveDrawingBuffer: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(size, size, false);
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    lights(this.scene, false);
    this.robot = new Instancer(this.scene, false, light ? LIGHT_MATERIALS : MATERIALS);
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      map: shadowTexture(), transparent: true, depthWrite: false, opacity: 0.22 }));
    this.shadow.renderOrder = -1;
    this.scene.add(this.shadow);
    this.camera = new THREE.PerspectiveCamera(24, 1, 0.01, 100);
    this.camera.up.set(0, 0, 1);
  }

  resize(size) {
    this.size = size;
    this.renderer.setSize(size, size, false);
  }

  /** Resolves to a `size`-square ImageBitmap of the design and its contact shadow. */
  render(design, shadowAlpha = 0.22) {
    this.robot.setDesign(design);
    this.robot.pose(null);
    const { lo, hi } = design.bounds;
    this.shadow.position.set((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, 0.0005);
    this.shadow.scale.set((hi[0] - lo[0]) * 1.25 + 0.05, (hi[1] - lo[1]) * 1.25 + 0.05, 1);
    this.shadow.material.opacity = shadowAlpha;
    const { c, r } = frame(design);
    const dist = (r / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.04;
    this.camera.position.copy(c).addScaledVector(VIEW, dist);
    this.camera.lookAt(c);
    this.camera.near = dist / 50;
    this.camera.far = dist * 4;
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
    // The bitmap is a snapshot taken now, so the next render cannot overwrite it.
    return createImageBitmap(this.canvas);
  }
}

/**
 * An orbitable view of one design, with its joints optionally swinging. It
 * draws only when something moved, and at most 30 times a second while the
 * joints swing.
 */
export class DetailViewer {
  constructor(container, { light = false } = {}) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: !light, alpha: true });
    this.renderer.setPixelRatio(light ? 1 : Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = !light;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.key = lights(this.scene, true);
    this.scene.add(this.key.target);
    this.robot = new Instancer(this.scene, !light, light ? LIGHT_MATERIALS : MATERIALS);
    this.frameMs = light ? 50 : 32;
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener('change', () => { this.dirty = true; });
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.ShadowMaterial({ opacity: 0.22 }));
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);
    this.grid = new THREE.GridHelper(4, 40, 0x888ca8, 0x888ca8);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.18;
    this.scene.add(this.grid);
    this.animate = true;
    this.dirty = true;
    this.lastDraw = 0;
    this.t0 = performance.now();
    this.resize = new ResizeObserver(() => { this.fit(); this.dirty = true; });
    this.resize.observe(container);
    this.running = false;
  }

  fit() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  show(design) {
    this.robot.setDesign(design);
    this.robot.pose(this.animate ? 0 : null);
    const { c, r } = frame(design);
    const dist = (r / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.15;
    this.camera.position.copy(c).addScaledVector(VIEW, dist);
    this.camera.near = dist / 100;
    this.camera.far = dist * 10;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(c);
    this.controls.update();
    this.grid.scale.setScalar(Math.max(1, design.span * 2.2) / 4);
    this.key.position.set(c.x + 2.5 * r, c.y + 1.5 * r, 4 * r + 1);
    this.key.target.position.copy(c);
    const cam = this.key.shadow.camera;
    cam.left = cam.bottom = -r * 1.6;
    cam.right = cam.top = r * 1.6;
    cam.near = 0.01;
    cam.far = 10 * r + 5;
    cam.updateProjectionMatrix();
    this.fit();
    this.t0 = performance.now();
    this.dirty = true;
    this.start();
  }

  setAnimate(on) {
    this.animate = on;
    if (!on) this.robot.pose(null);
    this.dirty = true;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = (now) => {
      if (!this.running) return;
      this.controls.update();
      if (this.animate && now - this.lastDraw > this.frameMs) {
        this.robot.pose((now - this.t0) / 1000);
        this.dirty = true;
      }
      if (this.dirty) {
        this.renderer.render(this.scene, this.camera);
        this.dirty = false;
        this.lastDraw = now;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  stop() { this.running = false; }
}
