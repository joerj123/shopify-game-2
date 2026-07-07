// Vans & lorries on roads (state.shipAnims), freighters on the sea lane
// (state.boatAnims + an ambient ferry), and walking survey researchers.
// IMPORTANT: draw() advances AND PRUNES shipAnims/boatAnims here, per spec —
// sim's concurrency caps depend on it. Surveys are sim-ticked; read-only.
import * as THREE from 'three';
import { SEA_LEVEL } from './terrain.js';
import { T } from '../world.js';

const WHEEL_R = 0.05;

function samplePath(path, f, out) {
  // linear interpolation along a tile path (+0.5 centering); also heading
  const n = path.length;
  if (n === 0) { out.x = 0; out.y = 0; out.hx = 1; out.hy = 0; return out; }
  if (n === 1) { out.x = path[0].x + 0.5; out.y = path[0].y + 0.5; out.hx = 1; out.hy = 0; return out; }
  const t = Math.min(0.999, Math.max(0, f)) * (n - 1);
  const i = Math.floor(t), r = t - i;
  const a = path[i], b = path[Math.min(n - 1, i + 1)];
  out.x = a.x + (b.x - a.x) * r + 0.5;
  out.y = a.y + (b.y - a.y) * r + 0.5;
  // look-ahead for heading
  const j = Math.min(n - 1, i + 1);
  const la = path[Math.max(0, j - 1)], lb = path[j];
  out.hx = lb.x - la.x; out.hy = lb.y - la.y;
  if (out.hx === 0 && out.hy === 0) { out.hx = 1; out.hy = 0; }
  return out;
}

function makePuffTexture(r, g, b) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const c2 = cv.getContext('2d');
  const grad = c2.createRadialGradient(32, 32, 4, 32, 32, 30);
  grad.addColorStop(0, `rgba(${r},${g},${b},0.7)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  c2.fillStyle = grad;
  c2.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
}

function makeTruck(big, lorry) {
  const g = new THREE.Group();
  const chassis = new THREE.Group();          // bobs on suspension
  g.add(chassis);
  const bodyC = lorry ? 0xd07a3a : 0xf0ece0;
  const trimC = lorry ? 0xa85a24 : 0x3ddc84;
  const L = big ? 0.46 : 0.34, H = big ? 0.2 : 0.15, W = big ? 0.2 : 0.16;
  const box = new THREE.Mesh(new THREE.BoxGeometry(L, H, W), new THREE.MeshStandardMaterial({ color: bodyC, flatShading: true, roughness: 0.7 }));
  box.position.set(-0.05, H / 2 + 0.05, 0);
  box.castShadow = true;
  chassis.add(box);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(L + 0.005, H * 0.3, W + 0.005), new THREE.MeshStandardMaterial({ color: trimC, flatShading: true }));
  stripe.position.copy(box.position);
  stripe.position.y -= H * 0.18;
  chassis.add(stripe);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(0.14, H * 0.75, W * 0.92), new THREE.MeshStandardMaterial({ color: 0xf5f2ea, flatShading: true }));
  cab.position.set(L / 2 + 0.04, H * 0.4 + 0.05, 0);
  cab.castShadow = true;
  chassis.add(cab);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.1, H * 0.4), new THREE.MeshBasicMaterial({ color: 0x8ab6c9 }));
  glass.rotation.y = Math.PI / 2;
  glass.position.set(L / 2 + 0.115, H * 0.5 + 0.05, 0);
  chassis.add(glass);

  // wheels stay on the group (don't bob with the chassis) and spin as it rolls
  const wheelGeo = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.04, 8);
  wheelGeo.rotateX(Math.PI / 2);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x2c2c30, flatShading: true });
  const wheels = [];
  for (const wx of [-0.14, 0.16]) for (const wz of [-1, 1]) {
    const wl = new THREE.Mesh(wheelGeo, wheelMat);
    wl.position.set(wx, WHEEL_R, wz * (W / 2));
    g.add(wl);
    wheels.push(wl);
  }

  // headlights: two warm emissive spheres + faint additive light-cone planes (night only)
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xffe9a3 });
  const coneMat = new THREE.MeshBasicMaterial({
    color: 0xffe3a8, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const lampGeo = new THREE.SphereGeometry(0.018, 5, 4);
  const coneGeo = new THREE.PlaneGeometry(0.3, 0.11);
  const lamps = [];
  for (const wz of [-1, 1]) {
    const lamp = new THREE.Mesh(lampGeo, lampMat);
    lamp.position.set(L / 2 + 0.11, H * 0.35 + 0.05, wz * W * 0.3);
    chassis.add(lamp);
    lamps.push(lamp);
    const cone = new THREE.Mesh(coneGeo, coneMat);   // horizontal beam splash on the road
    cone.rotation.x = -Math.PI / 2;
    cone.position.set(L / 2 + 0.28, 0.015, wz * W * 0.28); // just above the road surface
    chassis.add(cone);
  }
  g.userData = { chassis, wheels, lamps, coneMat, phase: Math.random() * Math.PI * 2, spin: 0 };
  return g;
}

function makeShip(laden) {
  const g = new THREE.Group();
  const hull = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.18, 0.34), new THREE.MeshStandardMaterial({ color: 0x2e3a4a, flatShading: true }));
  hull.position.y = 0.1;
  hull.castShadow = true;
  g.add(hull);
  const water = new THREE.Mesh(new THREE.BoxGeometry(1.18, 0.05, 0.36), new THREE.MeshStandardMaterial({ color: 0xc8503a, flatShading: true }));
  water.position.y = 0.025;
  g.add(water);
  const bow = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.3, 4), new THREE.MeshStandardMaterial({ color: 0x2e3a4a, flatShading: true }));
  bow.rotation.z = -Math.PI / 2;
  bow.rotation.y = Math.PI / 4;
  bow.position.set(0.7, 0.1, 0);
  g.add(bow);
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.26, 0.24), new THREE.MeshStandardMaterial({ color: 0xf1efe6, flatShading: true }));
  bridge.position.set(-0.42, 0.32, 0);
  bridge.castShadow = true;
  g.add(bridge);
  const funnel = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.14, 6), new THREE.MeshStandardMaterial({ color: 0xc8503a, flatShading: true }));
  funnel.position.set(-0.42, 0.52, 0);
  g.add(funnel);
  if (laden) {
    ['#c85a3a', '#3a7ac8', '#c8a23a'].forEach((c, i) => {
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.14, 0.2), new THREE.MeshStandardMaterial({ color: c, flatShading: true }));
      box.position.set(0.28 - i * 0.28, 0.26, 0);
      box.castShadow = true;
      g.add(box);
    });
  }
  // foam wake: fading white planes behind the ship
  const wakeMat = new THREE.MeshBasicMaterial({ color: 0xf2f8f6, transparent: true, opacity: 0.5, depthWrite: false });
  for (let i = 0; i < 4; i++) {
    const wk = new THREE.Mesh(new THREE.PlaneGeometry(0.5 + i * 0.28, 0.24 + i * 0.14), wakeMat.clone());
    wk.rotation.x = -Math.PI / 2;
    wk.position.set(-0.75 - i * 0.34, 0.02 - i * 0.001, 0);
    wk.material.opacity = 0.4 - i * 0.09;
    g.add(wk);
  }
  return g;
}

function makeWalker() {
  const g = new THREE.Group();
  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.1, 0.05), new THREE.MeshStandardMaterial({ color: 0x2e3a5c, flatShading: true }));
  legs.position.y = 0.05;
  g.add(legs);
  const jacket = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.11, 0.06), new THREE.MeshStandardMaterial({ color: 0xe0a83a, flatShading: true }));
  jacket.position.y = 0.15;
  g.add(jacket);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 5), new THREE.MeshStandardMaterial({ color: 0xe8c49a, flatShading: true }));
  head.position.y = 0.25;
  g.add(head);
  const board = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.01), new THREE.MeshStandardMaterial({ color: 0x8a6f4d, flatShading: true }));
  board.position.set(0.06, 0.16, 0.03);
  g.add(board);
  // '?' bubble sprite
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const c2 = cv.getContext('2d');
  c2.fillStyle = 'rgba(255,255,255,.95)';
  c2.beginPath(); c2.arc(32, 28, 22, 0, Math.PI * 2); c2.fill();
  c2.beginPath(); c2.moveTo(24, 46); c2.lineTo(32, 60); c2.lineTo(38, 46); c2.fill();
  c2.fillStyle = '#2c3a52';
  c2.font = 'bold 30px sans-serif';
  c2.textAlign = 'center'; c2.textBaseline = 'middle';
  c2.fillText('?', 32, 30);
  const tex = new THREE.CanvasTexture(cv);
  const bubble = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  bubble.scale.set(0.22, 0.22, 1);
  bubble.position.y = 0.48;
  bubble.visible = false;
  g.add(bubble);
  g.userData.bubble = bubble;
  return g;
}

// Pool of billboard puffs (dust kicked up by vans, smokestack smoke). Fixed
// size, zero steady-state allocations: sprites + records are created once.
class PuffPool {
  constructor(group, n, tex, baseScale, rise, life) {
    this.n = n;
    this.baseScale = baseScale;
    this.rise = rise;
    this.life = life;
    this.puffs = [];
    for (let i = 0; i < n; i++) {
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false }));
      spr.visible = false;
      group.add(spr);
      this.puffs.push({ spr, t: -1, drift: 0 });
    }
  }
  spawn(x, y, z) {
    for (const p of this.puffs) {
      if (p.t >= 0) continue;
      p.t = 0;
      p.drift = (Math.random() - 0.5) * 0.1;
      p.spr.visible = true;
      p.spr.position.set(x, y, z);
      p.spr.scale.set(this.baseScale, this.baseScale, 1);
      return;
    }
  }
  update(dt) {
    for (const p of this.puffs) {
      if (p.t < 0) continue;
      p.t += dt;
      if (p.t >= this.life) { p.t = -1; p.spr.visible = false; continue; }
      const f = p.t / this.life;
      const s = this.baseScale * (1 + f * 2.2);
      p.spr.scale.set(s, s, 1);
      p.spr.position.y += this.rise * dt;
      p.spr.position.x += p.drift * dt;
      p.spr.material.opacity = 0.45 * (1 - f);
    }
  }
}

const DOCK_T = 0.9;   // boats reach the quay at t=0.9, then dwell bobbing until pruned at t=1

export class Vehicles {
  constructor(ctx) {
    this.ctx = ctx;
    this.group = new THREE.Group();
    this.group.name = 'vehicles';
    this.trucks = new Map();   // anim → mesh
    this.boats = new Map();    // anim → mesh
    this.walkers = new Map();  // survey → mesh
    this.ferry = null;         // renderer-private ambient ship {t, dur}
    this.ferryMesh = null;
    this.s = { x: 0, y: 0, hx: 1, hy: 0 };
    this.dust = new PuffPool(this.group, 20, makePuffTexture(196, 178, 140), 0.12, 0.14, 0.9);
    this.smoke = new PuffPool(this.group, 14, makePuffTexture(210, 214, 220), 0.14, 0.35, 2.2);
  }

  place(mesh, tx, ty, hx, hy, y) {
    const { ox, oz } = this.ctx;
    mesh.position.set(tx + ox, y, ty + oz);
    mesh.rotation.y = Math.atan2(-hy, hx);
  }

  _funnelSmoke(m, dt) {
    // funnel sits at local (-0.42, ~0.6, 0); rotate by the ship's yaw
    if (Math.random() < dt * 1.4) {
      const ry = m.rotation.y;
      this.smoke.spawn(m.position.x - 0.42 * Math.cos(ry), m.position.y + 0.62, m.position.z + 0.42 * Math.sin(ry));
    }
  }

  update(dt, time, state, night = 0) {
    const { groundH } = this.ctx;
    const world = state.world;
    const lampsOn = night > 0.12;

    // ---- vans & lorries: advance + prune (renderer owns lifecycle) ----
    for (const a of state.shipAnims) a.t += dt / a.dur;
    state.shipAnims = state.shipAnims.filter(a => a.t < 1);
    const liveTrucks = new Set(state.shipAnims);
    for (const [a, m] of this.trucks) if (!liveTrucks.has(a)) { this.group.remove(m); this.trucks.delete(a); }
    for (const a of state.shipAnims) {
      let m = this.trucks.get(a);
      if (!m) {
        m = makeTruck(a.kind === 'lorry' || a.units >= 20, a.kind === 'lorry');
        this.trucks.set(a, m);
        this.group.add(m);
      }
      const p = samplePath(a.path, a.t, this.s);
      this.place(m, p.x, p.y, p.hx, p.hy, groundH(p.x, p.y) + 0.02);
      const u = m.userData;
      // rolling wheels: angular speed = linear speed / radius
      const speed = Math.max(0, a.path.length - 1) / a.dur;   // tiles (world units) per second
      u.spin -= (speed / WHEEL_R) * dt;
      for (const w of u.wheels) w.rotation.z = u.spin;
      // gentle suspension bob on the chassis only
      u.chassis.position.y = Math.sin(time * 11 + u.phase) * 0.008;
      // warm headlights at night
      for (const l of u.lamps) l.visible = lampsOn;
      u.coneMat.opacity = lampsOn ? 0.16 * Math.min(1, (night - 0.12) * 4) : 0;
      // occasional dust puff kicked up off the tarmac (not on bridges)
      if (Math.random() < dt * 1.5) {
        const ti = (Math.floor(p.y) * world.w + Math.floor(p.x)) | 0;
        const tile = world.tiles[ti];
        if (tile !== undefined && tile !== T.BRIDGE && tile !== T.WATER) {
          const ry = m.rotation.y;
          this.dust.spawn(m.position.x - 0.24 * Math.cos(ry), m.position.y + 0.03, m.position.z + 0.24 * Math.sin(ry));
        }
      }
    }

    // ---- freighters: advance + prune ----
    for (const b of state.boatAnims) b.t += dt / b.dur;
    state.boatAnims = state.boatAnims.filter(b => b.t < 1);
    const liveBoats = new Set(state.boatAnims);
    for (const [b, m] of this.boats) if (!liveBoats.has(b)) { this.group.remove(m); this.boats.delete(b); }
    const lane = world.seaLane || [];
    for (const b of state.boatAnims) {
      let m = this.boats.get(b);
      if (!m) { m = makeShip(true); this.boats.set(b, m); this.group.add(m); }
      // arrive at the quay at t=DOCK_T, then dwell dockside (crane moment) until pruned
      const docked = b.t >= DOCK_T;
      const f = Math.min(1, b.t / DOCK_T);
      const p = samplePath(lane, f, this.s);
      const bobAmp = docked ? 0.012 : 0.02;
      this.place(m, p.x, p.y, p.hx, p.hy, SEA_LEVEL + 0.02 + Math.sin(time * 1.2 + b.dur) * bobAmp);
      // slow bow bob (pitch) + gentle roll
      m.rotation.z = Math.sin(time * 0.9 + b.dur) * 0.02;
      m.rotation.x = Math.sin(time * 0.7 + b.dur * 1.7) * (docked ? 0.008 : 0.016);
      this._funnelSmoke(m, docked ? dt * 0.4 : dt);
    }

    // ---- ambient ferry (renderer-private) so the sea is never dead ----
    if (!this.ferry && lane.length > 1 && Math.random() < dt * 0.02) this.ferry = { t: 0, dur: 60 };
    if (this.ferry) {
      this.ferry.t += dt / this.ferry.dur;
      if (this.ferry.t >= 1) {
        this.ferry = null;
        if (this.ferryMesh) { this.group.remove(this.ferryMesh); this.ferryMesh = null; }
      } else {
        if (!this.ferryMesh) { this.ferryMesh = makeShip(false); this.group.add(this.ferryMesh); }
        // ferry sails the lane out-and-back
        const f = this.ferry.t < 0.5 ? this.ferry.t * 2 : (1 - this.ferry.t) * 2;
        const p = samplePath(lane, f, this.s);
        const dir = this.ferry.t < 0.5 ? 1 : -1;
        this.place(this.ferryMesh, p.x, p.y, p.hx * dir, p.hy * dir, SEA_LEVEL + 0.02 + Math.sin(time * 1.1) * 0.02);
        this.ferryMesh.rotation.x = Math.sin(time * 0.75) * 0.014;
        this._funnelSmoke(this.ferryMesh, dt * 0.6);
      }
    }

    this.dust.update(dt);
    this.smoke.update(dt);

    // ---- survey walkers (sim-ticked; renderer just draws) ----
    const liveSurveys = new Set(state.surveys);
    for (const [sv, m] of this.walkers) if (!liveSurveys.has(sv)) { this.group.remove(m); this.walkers.delete(sv); }
    for (const sv of state.surveys) {
      let m = this.walkers.get(sv);
      if (!m) { m = makeWalker(); this.walkers.set(sv, m); this.group.add(m); }
      const walkFrac = Math.min(1, (1 - sv.daysLeft / sv.totalDays) / 0.75);
      const p = samplePath(sv.path, walkFrac, this.s);
      const walking = walkFrac < 1;
      const bob = walking ? Math.abs(Math.sin(time * 7)) * 0.035 : 0;
      this.place(m, p.x, p.y, p.hx, p.hy, groundH(p.x, p.y) + bob);
      const bubble = m.userData.bubble;
      bubble.visible = !walking;
      if (!walking) bubble.position.y = 0.48 + Math.sin(time * 3) * 0.03;
    }
  }
}
