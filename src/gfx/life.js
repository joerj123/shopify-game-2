// Ambient life: tiny pedestrians wandering settlements, civilian cars on the
// road network, flocking birds over coast & forest, and chimney smoke puffs.
// Everything instanced/pooled; update() allocates nothing.
//
//   buildLife(ctx, state) → { group, update(dt, time, state, light) }
//
// ctx = { world, seed, scene, heightAt, groundH, ox, oz } (renderer.js)
// light = { dayLight, night, sunDir, sunColor } (sky.update)
import * as THREE from 'three';
import { T, findRoute, SEGMENTS } from '../world.js';
import { makeRng } from '../rng.js';
import { calInfo } from '../sim.js';

// ---------------------------------------------------------------- constants
const PED_CAP = 140;
const PED_COUNT = { city: 14, town: 8, village: 4 };
const PED_BODY = ['#c96f5a', '#5a7fa8', '#8a9570'];          // muted jackets
const PED_HEAD = ['#e8c49a', '#c99a72', '#a87652'];          // skin tones
const CAR_SLOTS = 10;
const CAR_COLORS = ['#7d94ad', '#b3705f', '#c2c6cc', '#9aa98a', '#a89ac0', '#c9b27a'];
const FLOCKS = 3, BIRDS_PER_FLOCK = 6;
const SMOKE_CHIMNEYS = 20, SMOKE_PER_CHIMNEY = 3;            // 60 particles

// Same palette-length arrays buildings.js picks from — only lengths matter
// for rng replay, but keep values honest anyway.
const WALLS_LEN = 5, ROOFS_LEN = 5;

// -------------------------------------------------- citizen identities
// Pedestrians carry a persistent market-intel card: who they are, which
// customer segment they belong to (sampled from their settlement's actual
// segment mix), and a one-line "wish" derived from that segment's top
// category affinities + prefs in SEGMENTS. Cars get a lighter family label.
const FIRST_NAMES = ['Mara', 'Odin', 'Tessa', 'Ravi', 'June', 'Kofi', 'Elsa', 'Milo', 'Nadia', 'Piet',
  'Sana', 'Bram', 'Ivy', 'Theo', 'Lena', 'Ansel', 'Rosa', 'Hugo', 'Wren', 'Silas',
  'Maeve', 'Dara', 'Otto', 'Priya', 'Cleo', 'Emil', 'Freya', 'Jonas', 'Aiko', 'Marta'];
const LAST_INITIALS = 'ABCDEFGHJKLMNPRSTVW';
const FAMILY_NAMES = ['Okafor', 'Nguyen', 'Bianchi', 'Haddad', 'Kowalski', 'Sato', 'Fernandez',
  'Mbeki', 'Larsen', 'Novak', 'Reyes', 'Ferreira', 'Aliyev', 'Brandt', 'Osei'];
const CAT_NOUN = {
  apparel: 'clothes', beauty: 'beauty products', gadgets: 'gadgets', home: 'homeware',
  toys: 'toys', food: 'good food', outdoor: 'outdoor gear', fitness: 'fitness gear',
};
const PREF_ADJ = { style: 'stylish', quality: 'well-made', utility: 'practical', eco: 'eco-friendly', tech: 'high-tech' };

function sampleSegment(mix, r) {
  let acc = 0, last = 'families';
  for (const k in mix) { last = k; acc += mix[k]; if (r <= acc) return k; }
  return last;
}
function dominantSegment(mix) {
  let best = 'families', bv = -1;
  for (const k in mix) if (mix[k] > bv) { bv = mix[k]; best = k; }
  return best;
}
function topCats(segKey) {
  return Object.keys(SEGMENTS[segKey].cats).sort((a, b) => SEGMENTS[segKey].cats[b] - SEGMENTS[segKey].cats[a]);
}
function makeWish(segKey, r) {
  const seg = SEGMENTS[segKey];
  const cats = topCats(segKey);
  const cat = cats[r < 0.6 ? 0 : 1];                 // mostly the #1 affinity
  const pref = Object.keys(seg.prefs).sort((a, b) => seg.prefs[b] - seg.prefs[a])[0];
  const quirk = seg.priceSens > 0.65 ? 'hates overpaying'
    : seg.priceSens < 0.3 ? 'happy to pay up for the good stuff'
    : seg.onlineBias > 1.05 ? 'shops online first'
    : 'likes to browse in person';
  return `Wants ${PREF_ADJ[pref]} ${CAT_NOUN[cat]} — ${quirk}`;
}

// linear interpolation along a tile path (+0.5 centering) + heading;
// same technique as vehicles.js samplePath, writing into a scratch object.
function samplePath(path, f, out) {
  const n = path.length;
  if (n === 0) { out.x = 0; out.y = 0; out.hx = 1; out.hy = 0; return out; }
  if (n === 1) { out.x = path[0].x + 0.5; out.y = path[0].y + 0.5; out.hx = 1; out.hy = 0; return out; }
  const t = Math.min(0.999, Math.max(0, f)) * (n - 1);
  const i = Math.floor(t), r = t - i;
  const a = path[i], b = path[Math.min(n - 1, i + 1)];
  out.x = a.x + (b.x - a.x) * r + 0.5;
  out.y = a.y + (b.y - a.y) * r + 0.5;
  const j = Math.min(n - 1, i + 1);
  const la = path[Math.max(0, j - 1)], lb = path[j];
  out.hx = lb.x - la.x; out.hy = lb.y - la.y;
  if (out.hx === 0 && out.hy === 0) { out.hx = 1; out.hy = 0; }
  return out;
}

// Replay buildings.js's deterministic placement rng to recover the REAL
// chimney positions (for smoke) and building footprints (so pedestrians
// don't pick targets inside houses). Must consume rng in the exact same
// order as buildStatic() — including short-circuited draws.
function replaySettlementBuildings(ctx) {
  const { world, seed, groundH, ox, oz } = ctx;
  const chimneys = [];          // scene-space {x, y, z} (top of stack)
  const footprints = new Map(); // settlement → [{x, y, r2}] in tile coords
  for (const s of world.settlements) {
    const rng = makeRng((seed ^ (s.x * 977 + s.y * 331)) >>> 0);
    const count = s.type === 'city' ? 15 : s.type === 'town' ? 8 : 4;
    const spread = s.type === 'city' ? 2.3 : s.type === 'town' ? 1.5 : 0.9;
    const feet = [];
    footprints.set(s, feet);
    for (let i = 0; i < count; i++) {
      const dx = rng.range(-spread, spread), dy = rng.range(-spread, spread);
      const tx = s.x + 0.5 + dx, ty = s.y + 0.5 + dy;
      const tile = world.tiles[Math.floor(ty) * world.w + Math.floor(tx)];
      if (tile === T.WATER || tile === T.BRIDGE) continue;
      const tower = s.type === 'city' && rng.chance(0.4);
      const hgt = tower ? rng.range(1.5, 2.6) : rng.range(0.42, 0.8);
      const wid = tower ? rng.range(0.5, 0.7) : rng.range(0.5, 0.85);
      const dep = tower ? wid : rng.range(0.5, 0.85);
      const rot = rng.chance(0.5) ? 0 : Math.PI / 2;
      const y = groundH(tx, ty) - 0.09;
      rng.pick(new Array(WALLS_LEN)); // wall color draw
      const gabled = !tower && rng.chance(0.7);
      if (gabled) rng.range(0.28, 0.44); // roof height draw
      rng.pick(new Array(ROOFS_LEN));   // roof color draw
      rng.chance(0.75);                 // window draw
      const r = Math.max(wid, dep) * 0.62;
      feet.push({ x: tx, y: ty, r2: r * r });
      if (gabled && rng.chance(0.45)) {
        chimneys.push({ x: tx + ox + wid * 0.22, y: y + hgt + 0.45, z: ty + oz - dep * 0.2 });
      }
      void rot;
    }
  }
  return { chimneys, footprints };
}

function makeSmokeTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const c2 = cv.getContext('2d');
  const g = c2.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c2.fillStyle = g;
  c2.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildLife(ctx, state) {
  const { world, seed, heightAt, groundH, ox, oz } = ctx;
  const rng = makeRng((seed ^ 0x11fe55) >>> 0);
  const group = new THREE.Group();
  group.name = 'life';

  const { chimneys, footprints } = replaySettlementBuildings(ctx);

  // shared scratch (zero allocations in update)
  const dummy = new THREE.Object3D();
  dummy.rotation.order = 'YXZ';
  const color = new THREE.Color();
  const cWarm = new THREE.Color();
  const pathS = { x: 0, y: 0, hx: 1, hy: 0 };

  const walkable = (tx, ty) => {
    if (tx < 1 || ty < 1 || tx >= world.w - 1 || ty >= world.h - 1) return false;
    const t = world.tiles[Math.floor(ty) * world.w + Math.floor(tx)];
    if (t === T.WATER || t === T.BRIDGE) return false;
    return heightAt(tx, ty) > 0.12;
  };

  // ============================================================ pedestrians
  const peds = [];
  for (const s of world.settlements) {
    const n = PED_COUNT[s.type] || 4;
    const spread = (s.type === 'city' ? 2.3 : s.type === 'town' ? 1.5 : 0.9) + 0.4;
    for (let i = 0; i < n && peds.length < PED_CAP; i++) {
      const x = s.x + 0.5 + rng.range(-0.6, 0.6), y = s.y + 0.5 + rng.range(-0.6, 0.6);
      const segment = sampleSegment(s.segments, rng.next());
      peds.push({
        s, spread,
        x, y,
        tx: 0, ty: 0, dx: 1, dy: 0, dist: 0, prog: 0,
        mode: 0,                                  // 0 idle, 1 walking
        timer: rng.range(0.2, 3),
        speed: rng.range(0.28, 0.44),
        phase: rng.range(0, Math.PI * 2),
        nightOwl: rng.chance(0.3),                // some stay out after dark
        fade: 1,
        bodyC: rng.pick(PED_BODY), headC: rng.pick(PED_HEAD),
        // scene-space position, refreshed every update (used by pick())
        wx: x + ox, wy: groundH(x, y), wz: y + oz,
        // persistent identity for the market-intel tooltip
        info: {
          name: `${rng.pick(FIRST_NAMES)} ${LAST_INITIALS[rng.int(0, LAST_INITIALS.length - 1)]}.`,
          segment,
          wish: makeWish(segment, rng.next()),
          home: s.name,
        },
      });
    }
  }
  const inFootprint = (s, x, y) => {
    const feet = footprints.get(s);
    if (feet) for (let i = 0; i < feet.length; i++) {
      const f = feet[i], ddx = x - f.x, ddy = y - f.y;
      if (ddx * ddx + ddy * ddy < f.r2) return true;
    }
    return false;
  };
  function pickPedTarget(p) {
    for (let t = 0; t < 8; t++) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.3 + Math.random() * p.spread;
      const tx = p.s.x + 0.5 + Math.cos(a) * r, ty = p.s.y + 0.5 + Math.sin(a) * r;
      if (!walkable(tx, ty) || inFootprint(p.s, tx, ty)) continue;
      const mx = (p.x + tx) / 2, my = (p.y + ty) / 2;
      if (inFootprint(p.s, mx, my)) continue;
      p.tx = tx; p.ty = ty;
      const dx = tx - p.x, dy = ty - p.y;
      p.dist = Math.hypot(dx, dy) || 0.001;
      p.dx = dx / p.dist; p.dy = dy / p.dist;
      p.prog = 0;
      return true;
    }
    return false;
  }

  const pedBodyGeo = new THREE.BoxGeometry(0.075, 0.13, 0.055);
  pedBodyGeo.translate(0, 0.065, 0);
  const pedHeadGeo = new THREE.SphereGeometry(0.037, 6, 5);
  const pedMat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.9 });
  const pedHeadMat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.85 });
  const pedBodyIM = new THREE.InstancedMesh(pedBodyGeo, pedMat, Math.max(1, peds.length));
  const pedHeadIM = new THREE.InstancedMesh(pedHeadGeo, pedHeadMat, Math.max(1, peds.length));
  pedBodyIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  pedHeadIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  pedBodyIM.castShadow = false; pedHeadIM.castShadow = false;
  pedBodyIM.frustumCulled = false; pedHeadIM.frustumCulled = false;
  peds.forEach((p, i) => {
    pedBodyIM.setColorAt(i, color.set(p.bodyC));
    pedHeadIM.setColorAt(i, color.set(p.headC));
  });
  group.add(pedBodyIM, pedHeadIM);

  // ================================================================== cars
  const carBodyGeo = new THREE.BoxGeometry(0.27, 0.085, 0.135);
  carBodyGeo.translate(0, 0.085, 0);
  const carCabGeo = new THREE.BoxGeometry(0.15, 0.07, 0.12);
  carCabGeo.translate(-0.015, 0.16, 0);
  const carMat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.55, metalness: 0.1 });
  const carCabMat = new THREE.MeshStandardMaterial({ color: 0xd9e2e6, flatShading: true, roughness: 0.35 });
  const carBodyIM = new THREE.InstancedMesh(carBodyGeo, carMat, CAR_SLOTS);
  const carCabIM = new THREE.InstancedMesh(carCabGeo, carCabMat, CAR_SLOTS);
  carBodyIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  carCabIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  carBodyIM.castShadow = false; carCabIM.castShadow = false;
  carBodyIM.frustumCulled = false; carCabIM.frustumCulled = false;
  group.add(carBodyIM, carCabIM);
  const cars = [];
  for (let i = 0; i < CAR_SLOTS; i++) {
    cars.push({ active: false, path: null, t: 0, dur: 10, ang: 0, pause: rng.range(0, 4), colorI: i % CAR_COLORS.length, sx: 0, sy: -20, sz: 0, info: null });
    carBodyIM.setColorAt(i, color.set(CAR_COLORS[i % CAR_COLORS.length]));
  }
  let carSpawnTimer = 0;
  function spawnCarTrip(c) {
    const ss = world.settlements;
    if (ss.length < 2) return false;
    const a = ss[(Math.random() * ss.length) | 0];
    let b = ss[(Math.random() * ss.length) | 0];
    if (b === a) b = ss[(ss.indexOf(a) + 1) % ss.length];
    const path = findRoute(world, a, b); // cached per world inside world.js
    if (!path || path.length < 2) return false;
    let len = 0;
    for (let i = 1; i < path.length; i++) len += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    c.path = path;
    c.t = 0;
    c.dur = Math.max(5, len / 2.1);      // ~2.1 tiles/sec
    c.colorI = (Math.random() * CAR_COLORS.length) | 0;
    carBodyIM.setColorAt(cars.indexOf(c), color.set(CAR_COLORS[c.colorI]));
    if (carBodyIM.instanceColor) carBodyIM.instanceColor.needsUpdate = true;
    samplePath(path, 0, pathS);
    c.ang = Math.atan2(-pathS.hy, pathS.hx);
    // trip identity: family label + what the destination's dominant segment shops for
    const domSeg = dominantSegment(b.segments);
    c.info = {
      label: `The ${FAMILY_NAMES[(Math.random() * FAMILY_NAMES.length) | 0]} family — heading to ${b.name} for ${CAT_NOUN[topCats(domSeg)[0]]}`,
      dest: b.name,
      segment: domSeg,
    };
    c.active = true;
    return true;
  }

  // ================================================================= birds
  // anchors: a few coast (sand) and forest points, in scene space
  const coastPts = [], forestPts = [];
  for (let y = 2; y < world.h - 2; y += 3) for (let x = 2; x < world.w - 2; x += 3) {
    const t = world.tiles[y * world.w + x];
    if (t === T.SAND) coastPts.push({ x: x + 0.5 + ox, z: y + 0.5 + oz });
    else if (t === T.FOREST) forestPts.push({ x: x + 0.5 + ox, z: y + 0.5 + oz });
  }
  const anyPt = { x: 0, z: 0 };
  const pickPt = (arr) => (arr.length ? arr[rng.int(0, arr.length - 1)] : anyPt);
  const flocks = [];
  for (let f = 0; f < FLOCKS; f++) {
    const A = pickPt(f === 1 ? forestPts : coastPts);
    const B = pickPt(f === 1 ? coastPts : forestPts.length ? forestPts : coastPts);
    flocks.push({
      A, B,
      alt: rng.range(4.2, 6.6),
      rx: rng.range(2.5, 4.5), rz: rng.range(1.6, 3),
      speed: rng.range(0.14, 0.22),
      mig: rng.range(0.008, 0.016),      // slow island crossings
      ph: rng.range(0, Math.PI * 2), ph2: rng.range(0, Math.PI * 2),
      px: A.x, pz: A.z, inited: false,
    });
  }
  // two-triangle bird, nose along +x, wings spanning z
  const birdGeo = new THREE.BufferGeometry();
  birdGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0.1, 0, 0, -0.07, 0, 0, -0.02, 0, -0.17,   // left wing
    0.1, 0, 0, -0.02, 0, 0.17, -0.07, 0, 0,    // right wing
  ]), 3));
  const nBirds = FLOCKS * BIRDS_PER_FLOCK;
  const birdPhase = new Float32Array(nBirds);
  for (let i = 0; i < nBirds; i++) birdPhase[i] = rng.range(0, Math.PI * 2);
  const phaseAttr = new THREE.InstancedBufferAttribute(birdPhase, 1);
  birdGeo.setAttribute('aPhase', phaseAttr);
  const birdMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color('#46525e') } },
    vertexShader: /* glsl */`
      attribute float aPhase;
      uniform float uTime;
      varying float vShade;
      void main() {
        vec3 p = position;
        float flap = sin(uTime * 9.0 + aPhase);
        p.y += abs(p.z) * flap * 0.7;
        vShade = 0.8 + 0.2 * flap;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      varying float vShade;
      void main() { gl_FragColor = vec4(uColor * vShade, 1.0); }`,
    side: THREE.DoubleSide,
  });
  const birdIM = new THREE.InstancedMesh(birdGeo, birdMat, nBirds);
  birdIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  birdIM.castShadow = false;
  birdIM.frustumCulled = false;
  group.add(birdIM);

  // ================================================================= smoke
  const smokeStacks = rng.shuffle(chimneys).slice(0, SMOKE_CHIMNEYS);
  const nSmoke = Math.max(1, smokeStacks.length * SMOKE_PER_CHIMNEY);
  const smokePos = new Float32Array(nSmoke * 3);
  const smokeFade = new Float32Array(nSmoke);
  const smokeSize = new Float32Array(nSmoke);
  const smoke = [];
  for (let i = 0; i < nSmoke; i++) {
    smoke.push({
      stack: smokeStacks.length ? smokeStacks[(i / SMOKE_PER_CHIMNEY) | 0] : null,
      life: rng.range(0, 1),
      dur: rng.range(3.2, 5),
      wob: rng.range(0, Math.PI * 2),
    });
  }
  const smokeGeo = new THREE.BufferGeometry();
  const smokePosAttr = new THREE.BufferAttribute(smokePos, 3).setUsage(THREE.DynamicDrawUsage);
  const smokeFadeAttr = new THREE.BufferAttribute(smokeFade, 1).setUsage(THREE.DynamicDrawUsage);
  const smokeSizeAttr = new THREE.BufferAttribute(smokeSize, 1).setUsage(THREE.DynamicDrawUsage);
  smokeGeo.setAttribute('position', smokePosAttr);
  smokeGeo.setAttribute('aFade', smokeFadeAttr);
  smokeGeo.setAttribute('aSize', smokeSizeAttr);
  const smokeMat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: makeSmokeTexture() }, uColor: { value: new THREE.Color('#e6e3dc') } },
    vertexShader: /* glsl */`
      attribute float aFade;
      attribute float aSize;
      varying float vFade;
      void main() {
        vFade = aFade;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * (170.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uMap;
      uniform vec3 uColor;
      varying float vFade;
      void main() {
        float a = texture2D(uMap, gl_PointCoord).a * vFade;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a);
      }`,
    transparent: true,
    depthWrite: false,
  });
  const smokePts = new THREE.Points(smokeGeo, smokeMat);
  smokePts.frustumCulled = false;
  smokePts.visible = smokeStacks.length > 0;
  group.add(smokePts);

  // ================================================================ update
  function update(dt, time, st, light) {
    st = st || state;
    const night = light ? light.night : 0;
    const dayLight = light ? light.dayLight : 1;
    const dusk = Math.max(0, 1 - Math.abs(dayLight - 0.3) * 4); // golden hour
    const winter = calInfo(st).season === 'winter';

    // ---- pedestrians ----
    for (let i = 0; i < peds.length; i++) {
      const p = peds[i];
      // day/night presence (cheap: scale toward 0)
      const want = p.nightOwl ? 1 : Math.max(0, 1 - night * 1.5);
      p.fade += (want - p.fade) * Math.min(1, dt * 1.5);
      if (p.mode === 1) {
        p.prog += p.speed * dt;
        if (p.prog >= p.dist) {
          p.x = p.tx; p.y = p.ty;
          p.mode = 0;
          p.timer = 0.8 + Math.random() * 3.2;
        }
      } else {
        p.timer -= dt;
        if (p.timer <= 0) { if (pickPedTarget(p)) p.mode = 1; else p.timer = 1.5; }
      }
      const wx = p.mode === 1 ? p.x + p.dx * p.prog : p.x;
      const wy = p.mode === 1 ? p.y + p.dy * p.prog : p.y;
      const walking = p.mode === 1;
      const bob = walking ? Math.abs(Math.sin(time * 8 + p.phase)) * 0.018 : 0;
      const sc = p.fade < 0.03 ? 0 : p.fade;
      const yaw = walking ? Math.atan2(-p.dy, p.dx) - Math.PI / 2 : p.phase;
      p.wx = wx + ox; p.wy = groundH(wx, wy); p.wz = wy + oz;   // cache for pick()
      dummy.position.set(p.wx, p.wy + bob, p.wz);
      dummy.rotation.set(walking ? 0.08 : 0, yaw, walking ? Math.sin(time * 8 + p.phase) * 0.06 : 0);
      dummy.scale.set(sc, sc, sc);
      dummy.updateMatrix();
      pedBodyIM.setMatrixAt(i, dummy.matrix);
      dummy.position.y += 0.165 * sc;
      dummy.updateMatrix();
      pedHeadIM.setMatrixAt(i, dummy.matrix);
    }
    pedBodyIM.instanceMatrix.needsUpdate = true;
    pedHeadIM.instanceMatrix.needsUpdate = true;

    // ---- cars ----
    const carTarget = Math.round(2 + (1 - night) * 7); // 9 day → 2 night
    let active = 0;
    for (let i = 0; i < CAR_SLOTS; i++) if (cars[i].active) active++;
    carSpawnTimer -= dt;
    if (active < carTarget && carSpawnTimer <= 0) {
      for (let i = 0; i < CAR_SLOTS; i++) {
        const c = cars[i];
        if (!c.active) {
          c.pause -= dt;
          if (c.pause <= 0 && spawnCarTrip(c)) { active++; break; }
        }
      }
      carSpawnTimer = 0.9;
    }
    for (let i = 0; i < CAR_SLOTS; i++) {
      const c = cars[i];
      if (c.active) {
        c.t += dt / c.dur;
        if (c.t >= 1) {
          c.active = false;
          c.pause = 1.5 + Math.random() * 4 + (active > carTarget ? 8 : 0);
        }
      }
      if (!c.active) {
        dummy.position.set(0, -20, 0);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(0, 0, 0);
      } else {
        samplePath(c.path, c.t, pathS);
        const ta = Math.atan2(-pathS.hy, pathS.hx);
        let da = ta - c.ang;
        while (da > Math.PI) da -= Math.PI * 2;
        while (da < -Math.PI) da += Math.PI * 2;
        c.ang += da * Math.min(1, dt * 7);
        c.sx = pathS.x + ox; c.sy = groundH(pathS.x, pathS.y) + 0.015; c.sz = pathS.y + oz; // cache for pick()
        dummy.position.set(c.sx, c.sy, c.sz);
        dummy.rotation.set(0, c.ang, 0);
        dummy.scale.set(1, 1, 1);
      }
      dummy.updateMatrix();
      carBodyIM.setMatrixAt(i, dummy.matrix);
      carCabIM.setMatrixAt(i, dummy.matrix);
    }
    carBodyIM.instanceMatrix.needsUpdate = true;
    carCabIM.instanceMatrix.needsUpdate = true;

    // ---- birds ----
    birdIM.visible = night < 0.5;
    if (birdIM.visible) {
      birdMat.uniforms.uTime.value = time;
      let bi = 0;
      for (let f = 0; f < FLOCKS; f++) {
        const fl = flocks[f];
        const t = time * fl.speed + fl.ph;
        const mig = 0.5 + 0.5 * Math.sin(time * fl.mig + fl.ph2);
        const ax = fl.A.x + (fl.B.x - fl.A.x) * mig;
        const az = fl.A.z + (fl.B.z - fl.A.z) * mig;
        const cx = ax + Math.cos(t) * fl.rx;                 // figure-eight
        const cz = az + Math.sin(t * 2) * fl.rz;
        const cy = fl.alt + Math.sin(t * 0.7) * 0.6;
        if (!fl.inited) { fl.px = cx - 0.01; fl.pz = cz; fl.inited = true; }
        const yaw = Math.atan2(-(cz - fl.pz), cx - fl.px);
        fl.px = cx; fl.pz = cz;
        for (let b = 0; b < BIRDS_PER_FLOCK; b++, bi++) {
          const oa = b * 2.4 + time * 0.25;
          const or = 0.35 + b * 0.14;
          dummy.position.set(
            cx + Math.cos(oa) * or,
            cy + Math.sin(b * 1.7 + time * 0.9) * 0.25,
            cz + Math.sin(oa) * or,
          );
          dummy.rotation.set(0, yaw, Math.sin(t * 2 + b) * 0.15);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          birdIM.setMatrixAt(bi, dummy.matrix);
        }
      }
      birdIM.instanceMatrix.needsUpdate = true;
    }

    // ---- chimney smoke ----
    if (smokeStacks.length) {
      const strength = winter ? 1.45 : 0.85;
      cWarm.set('#ffc490');
      const c = smokeMat.uniforms.uColor.value;
      color.set(night > 0.5 ? '#9aa0a8' : '#e6e3dc');
      c.copy(color).lerp(cWarm, dusk * 0.55);
      const breezeX = Math.sin(time * 0.13) * 0.32 + 0.22;
      const breezeZ = Math.cos(time * 0.09) * 0.28;
      for (let i = 0; i < smoke.length; i++) {
        const sp = smoke[i];
        sp.life += dt / sp.dur;
        if (sp.life >= 1) { sp.life -= 1; sp.wob = Math.random() * Math.PI * 2; }
        const l = sp.life;
        const st3 = sp.stack;
        const rise = l * (winter ? 1.35 : 1.0);
        smokePos[i * 3] = st3.x + breezeX * l + Math.sin(sp.wob + l * 5) * 0.05;
        smokePos[i * 3 + 1] = st3.y + rise;
        smokePos[i * 3 + 2] = st3.z + breezeZ * l + Math.cos(sp.wob + l * 4) * 0.05;
        smokeFade[i] = Math.min(1, l * 5) * (1 - l) * strength * 0.55;
        smokeSize[i] = (0.1 + l * 0.34) * (winter ? 1.25 : 1);
      }
      smokePosAttr.needsUpdate = true;
      smokeFadeAttr.needsUpdate = true;
      smokeSizeAttr.needsUpdate = true;
    }
  }

  // ================================================================== pick
  // Raycast against street life. Instanced-mesh raycast would work, but the
  // figures are so tiny that we instead do a generous distance-to-ray test
  // against the cached instance positions (≤ PED_CAP + CAR_SLOTS points —
  // cheap). Nearest hit along the ray wins. → {kind:'ped'|'car', info} | null
  function pick(raycaster) {
    const ro = raycaster.ray.origin, rd = raycaster.ray.direction;
    let best = null, bestT = Infinity;
    const test = (x, y, z, r, kind, info) => {
      const vx = x - ro.x, vy = y - ro.y, vz = z - ro.z;
      const t = vx * rd.x + vy * rd.y + vz * rd.z;      // along-ray distance
      if (t <= 0 || t >= bestT) return;
      const dx = vx - rd.x * t, dy = vy - rd.y * t, dz = vz - rd.z * t;
      if (dx * dx + dy * dy + dz * dz < r * r) { bestT = t; best = { kind, info }; }
    };
    for (let i = 0; i < peds.length; i++) {
      const p = peds[i];
      if (p.fade < 0.25) continue;                      // faded out for the night
      test(p.wx, p.wy + 0.11, p.wz, 0.26, 'ped', p.info);
    }
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (!c.active || !c.info) continue;
      test(c.sx, c.sy + 0.1, c.sz, 0.3, 'car', c.info);
    }
    return best;
  }

  return { group, update, pick };
}
