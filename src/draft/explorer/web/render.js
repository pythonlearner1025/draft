// three.js drawing of atlas designs: one shared off-screen renderer for the
// map's thumbnails, and an orbit view for the selected design.

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

const UNIT = {
  cyl: new THREE.CylinderGeometry(1, 1, 1, 22, 1),
  sph: new THREE.SphereGeometry(1, 22, 14),
  box: new THREE.BoxGeometry(1, 1, 1),
};
const Y = new THREE.Vector3(0, 1, 0);

function matrixFromRot(R) {
  const m = new THREE.Matrix4();
  m.set(R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, 0, 0, 0, 1);
  return m;
}

/** The hub as mesh.yaml lofts it: stacked outlines joined side to side, capped flat. */
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
  const side = new THREE.BufferGeometry();
  side.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  side.setIndex(idx);
  side.computeVertexNormals();

  const cap = (L, up) => {
    const p = [0, 0, L.z];
    for (const [x, y] of hub.outline) p.push(x * L.scale, y * L.scale, L.z);
    const ix = [];
    for (let i = 0; i < n; i++) {
      const a = 1 + i, b = 1 + ((i + 1) % n);
      if (up) ix.push(0, a, b); else ix.push(0, b, a);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setIndex(ix);
    g.computeVertexNormals();
    return g;
  };
  return [side, cap(hub.layers[0], false), cap(hub.layers[hub.layers.length - 1], true)];
}

function geomMesh(geom, owned, design) {
  if (geom.k === 'hub') {
    const group = new THREE.Group();
    for (const g of hubGeometry(design.hub)) {
      owned.push(g);
      const m = new THREE.Mesh(g, MATERIALS.hub);
      m.castShadow = m.receiveShadow = true;
      group.add(m);
    }
    return group;
  }
  let mesh;
  if (geom.k === 'cyl') {
    const a = new THREE.Vector3(...geom.a), b = new THREE.Vector3(...geom.b);
    const d = b.clone().sub(a);
    const len = Math.max(d.length(), 1e-4);
    mesh = new THREE.Mesh(UNIT.cyl, MATERIALS[geom.mat]);
    mesh.scale.set(geom.r, len, geom.r);
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(Y, d.normalize());
  } else if (geom.k === 'sph') {
    mesh = new THREE.Mesh(UNIT.sph, MATERIALS[geom.mat]);
    mesh.scale.setScalar(geom.r);
    mesh.position.set(...geom.c);
  } else {
    mesh = new THREE.Mesh(UNIT.box, MATERIALS[geom.mat]);
    mesh.scale.set(...geom.s);
    mesh.position.set(...geom.c);
  }
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

/**
 * The design as a three.js tree that mirrors its body tree: each body is an
 * outer group at its rest pose and an inner group its joint turns.
 */
export function buildObject(design) {
  const owned = [];
  const joints = [];
  const build = (node) => {
    const outer = new THREE.Group();
    outer.position.set(...node.pos);
    outer.quaternion.setFromRotationMatrix(matrixFromRot(node.rot));
    const inner = new THREE.Group();
    outer.add(inner);
    if (node.joint) {
      const ax = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[node.joint.axis];
      joints.push({ inner, axis: new THREE.Vector3(...ax), joint: node.joint, phase: joints.length * 0.9 });
    }
    for (const g of node.geoms) inner.add(geomMesh(g, owned, design));
    for (const c of node.children) inner.add(build(c));
    return outer;
  };
  const root = build(design.root);
  root.position.z = design.standHeight;
  const group = new THREE.Group();
  group.add(root);
  return { group, joints, dispose: () => owned.forEach((g) => g.dispose()) };
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

/** Renders designs one at a time into canvases for the map. */
export class Thumbnailer {
  constructor(maxSize = 384) {
    this.max = maxSize;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(maxSize, maxSize, false);
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    lights(this.scene, false);
    this.camera = new THREE.PerspectiveCamera(24, 1, 0.01, 100);
    this.camera.up.set(0, 0, 1);
  }

  /** A `px`-square canvas holding the design and its contact shadow. */
  render(design, px, shadowAlpha = 0.22) {
    px = Math.min(px, this.max);
    const { group, dispose } = buildObject(design);
    this.scene.add(group);
    const { c, r } = frame(design);
    const dist = (r / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.04;
    this.camera.position.copy(c).addScaledVector(VIEW, dist);
    this.camera.lookAt(c);
    this.camera.near = dist / 50;
    this.camera.far = dist * 4;
    this.camera.updateProjectionMatrix();
    this.renderer.setViewport(0, 0, px, px);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.scene.remove(group);
    dispose();

    const out = document.createElement('canvas');
    out.width = out.height = px;
    const ctx = out.getContext('2d');
    // A soft shadow where the design meets the floor.
    const floor = new THREE.Vector3(c.x, c.y, 0).project(this.camera);
    const edge = new THREE.Vector3(c.x + 0.5 * design.span, c.y, 0).project(this.camera);
    const fx = ((floor.x + 1) / 2) * px, fy = ((1 - floor.y) / 2) * px;
    const rx = Math.max(px * 0.12, Math.abs(edge.x - floor.x) * px * 0.62);
    ctx.save();
    ctx.translate(fx, fy);
    ctx.scale(1, 0.34);
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    grad.addColorStop(0, `rgba(10, 12, 30, ${shadowAlpha})`);
    grad.addColorStop(1, 'rgba(10, 12, 30, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.drawImage(this.renderer.domElement, 0, this.max - px, px, px, 0, 0, px, px);
    return out;
  }
}

/** An orbitable view of one design, with its joints optionally swinging. */
export class DetailViewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.key = lights(this.scene, true);
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.autoRotate = false;
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.ShadowMaterial({ opacity: 0.22 }));
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);
    this.grid = new THREE.GridHelper(4, 40, 0x888ca8, 0x888ca8);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.18;
    this.scene.add(this.grid);
    this.animate = true;
    this.current = null;
    this.t0 = performance.now();
    this.resize = new ResizeObserver(() => this.fit());
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
    if (this.current) {
      this.scene.remove(this.current.group);
      this.current.dispose();
    }
    this.current = buildObject(design);
    this.scene.add(this.current.group);
    const { c, r } = frame(design);
    const dist = (r / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.15;
    this.camera.position.copy(c).addScaledVector(VIEW, dist);
    this.camera.near = dist / 100;
    this.camera.far = dist * 10;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(c);
    this.controls.update();
    const s = Math.max(1, design.span * 2.2);
    this.grid.scale.setScalar(s / 4);
    this.key.position.set(c.x + 2.5 * r, c.y + 1.5 * r, 4 * r + 1);
    this.key.target.position.copy(c);
    this.scene.add(this.key.target);
    const cam = this.key.shadow.camera;
    cam.left = cam.bottom = -r * 1.6;
    cam.right = cam.top = r * 1.6;
    cam.near = 0.01;
    cam.far = 10 * r + 5;
    cam.updateProjectionMatrix();
    this.fit();
    this.start();
  }

  setAnimate(on) { this.animate = on; }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      const t = (performance.now() - this.t0) / 1000;
      if (this.current) {
        for (const j of this.current.joints) {
          let a = 0;
          if (this.animate) {
            if (j.joint.continuous) a = t * 2.2;
            else {
              const [lo, hi] = j.joint.range;
              a = Math.min(0.45, (hi - lo) / 4) * Math.sin(t * 1.6 + j.phase);
            }
          }
          j.inner.quaternion.setFromAxisAngle(j.axis, a);
        }
      }
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  stop() { this.running = false; }
}
