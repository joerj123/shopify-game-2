// Settlement building clusters, forest trees, the port, and player premises
// (HQ garage, stores, warehouses, construction sites with animated cranes).
import * as THREE from 'three';
import { T } from '../world.js';
import { makeRng } from '../rng.js';

const WALLS = ['#c8b49a', '#b5a28e', '#a3a9b8', '#d2bd9f', '#af9a83'];
const ROOFS = ['#c4574a', '#a8654c', '#6d7b8d', '#8a9570', '#9a6f78'];
const BRAND = '#3ddc84';

// gabled roof: triangular prism, apex along z
function roofGeometry() {
  const g = new THREE.BufferGeometry();
  // A,B,C,D = base corners; E,F = ridge ends (apex along z). CCW from outside.
  const A = [-0.5, 0, -0.5], B = [0.5, 0, -0.5], C = [0.5, 0, 0.5], D = [-0.5, 0, 0.5];
  const E = [0, 1, -0.5], F = [0, 1, 0.5];
  const v = [
    ...A, ...E, ...B,          // end cap -z
    ...D, ...C, ...F,          // end cap +z
    ...A, ...D, ...F, ...A, ...F, ...E, // left slope
    ...B, ...E, ...F, ...B, ...F, ...C, // right slope
  ];
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3));
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------
// Static world dressing: settlement clusters, trees, rocks, port.
// ------------------------------------------------------------------
export function buildStatic(ctx) {
  const { world, seed, groundH, heightAt, ox, oz } = ctx;
  const group = new THREE.Group();
  group.name = 'static';

  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const roofGeo = roofGeometry();
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  const AWNINGS = ['#c85a3a', '#3a7ac8', '#d8a23a', '#5aa05a', '#a05a9a'];

  // ---------- living settlement clusters (SIM2 §4) ----------
  // Houses live in fixed-capacity per-settlement slot blocks inside shared
  // instanced meshes, so a single settlement can be rebuilt in O(MAXB) when
  // its tier or pop changes — no full-scene rebuild, no reallocations.
  const MAXB = 15;                                   // city house count = slot capacity
  const SLOTS = world.settlements.length * MAXB;
  const TIER_SALT = { village: 0, town: 0x9e37, city: 0x71c3 };
  // pop midpoint / half-range per tier: cluster footprint breathes ±8%
  const POP_MID = { village: [5000, 4000], town: [39500, 30500], city: [145000, 75000] };
  const popScaleOf = (s) => {
    const m = POP_MID[s.type] || POP_MID.village;
    const f = Math.max(-1, Math.min(1, ((s.pop || m[0]) - m[0]) / m[1]));
    return 1 + 0.08 * f;
  };

  // Ground reserved by landmarks and player premise pads (tile coords).
  // Houses rejection-sample against this and against each other, so nothing
  // interpenetrates: fewer houses beats overlapping ones.
  const zones = [];
  const PREMISE_PADS = [[-0.9, -0.9, 0.75], [1.1, 0.6, 0.7], [-1.2, 1.0, 0.8]]; // mirrors PREM_OFFSET
  for (const s of world.settlements)
    for (const [dx, dy, r] of PREMISE_PADS) zones.push({ x: s.x + 0.5 + dx, z: s.y + 0.5 + dy, r });

  // deterministic per-settlement, per-tier house layout (anchor + relative parts)
  function genBuildings(s) {
    const rng = makeRng((seed ^ (s.x * 977 + s.y * 331) ^ (TIER_SALT[s.type] || 0)) >>> 0);
    const count = s.type === 'city' ? 15 : s.type === 'town' ? 8 : 4;
    const spread = (s.type === 'city' ? 2.3 : s.type === 'town' ? 1.5 : 0.9) * popScaleOf(s);
    const out = [];
    const placed = []; // axis-aligned footprints {x, z, hw, hd} — rot is 0 or 90°
    for (let i = 0; i < count; i++) {
      const tower = s.type === 'city' && rng.chance(0.4);
      const hgt = tower ? rng.range(1.5, 2.6) : rng.range(0.42, 0.8);
      const wid = tower ? rng.range(0.5, 0.7) : rng.range(0.5, 0.85);
      const dep = tower ? wid : rng.range(0.5, 0.85);
      const rot = rng.chance(0.5) ? 0 : Math.PI / 2;
      const gabled = !tower && rng.chance(0.7);
      // half extents include the 1.12× roof overhang plus a small gap
      const hw = (rot === 0 ? wid : dep) * 0.56 + 0.04;
      const hd = (rot === 0 ? dep : wid) * 0.56 + 0.04;
      let tx = null, ty = null;
      for (let t = 0; t < 30; t++) {
        const cx = s.x + 0.5 + rng.range(-spread, spread), cy = s.y + 0.5 + rng.range(-spread, spread);
        const tile = world.tiles[Math.floor(cy) * world.w + Math.floor(cx)];
        if (tile === T.WATER || tile === T.BRIDGE || tile === T.ROAD) continue;
        if (placed.some(f => Math.abs(cx - f.x) < hw + f.hw && Math.abs(cy - f.z) < hd + f.hd)) continue;
        if (zones.some(z => (cx - z.x) ** 2 + (cy - z.z) ** 2 < (z.r + Math.max(hw, hd)) ** 2)) continue;
        tx = cx; ty = cy;
        break;
      }
      if (tx == null) continue;
      placed.push({ x: tx, z: ty, hw, hd });
      const b = {
        x: tx + ox, z: ty + oz, gy: groundH(tx, ty) - 0.09,   // sunk slightly into slopes
        hgt, wid, dep, rot, wc: rng.pick(WALLS),
        rwid: wid * 1.12, rdep: dep * 1.12,
        rh: gabled ? rng.range(0.28, 0.44) : 0.09, rc: rng.pick(ROOFS),
        win: null, chim: null, awn: null,
      };
      if (rng.chance(0.75)) {
        // window strip on the building's local +z face (rotated with the box)
        const lz = dep / 2 + 0.015;
        b.win = { ox: Math.sin(rot) * lz, oy: hgt * 0.55, oz: Math.cos(rot) * lz, w: wid * 0.55, h: Math.min(0.28, hgt * 0.4), ph: rng.next() };
      }
      if (gabled && rng.chance(0.45)) b.chim = { ox: wid * 0.22, oy: hgt + 0.3, oz: -dep * 0.2 };
      // shop-front awning strips on some low town/city buildings
      if (!tower && s.type !== 'village' && rng.chance(0.35)) {
        const lz = dep / 2 + 0.04;
        b.awn = { ox: Math.sin(rot) * lz, oy: hgt * 0.42, oz: Math.cos(rot) * lz, w: wid * 0.8, c: rng.pick(AWNINGS) };
      }
      out.push(b);
    }
    return out;
  }

  // festive light points (December) — richer palette; independent of tier
  const festive = [];
  for (const s of world.settlements) {
    const frng = makeRng((seed ^ (s.x * 31 + s.y * 57)) >>> 0);
    for (let i = 0; i < 6; i++) {
      festive.push({
        x: s.x + 0.5 + frng.range(-1.4, 1.4) + ox, z: s.y + 0.5 + frng.range(-1.4, 1.4) + oz,
        c: ['#ff5c5c', '#ffd24d', '#6ee06f', '#5ac8e0', '#c07ae8', '#ff9d5c'][i % 6], ph: i * 1.9 + s.x,
      });
    }
  }

  // instanced meshes at full slot capacity (unused slots hidden underground)
  const wallMat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.85 });
  const wallsIM = new THREE.InstancedMesh(boxGeo, wallMat, SLOTS);
  wallsIM.castShadow = true; wallsIM.receiveShadow = true;
  const roofMat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.8 });
  const roofsIM = new THREE.InstancedMesh(roofGeo, roofMat, SLOTS);
  roofsIM.castShadow = true;
  const winMat = new THREE.MeshBasicMaterial({ color: 0x2a2620, side: THREE.DoubleSide });
  const winGeo = new THREE.PlaneGeometry(1, 1);
  const winIM = new THREE.InstancedMesh(winGeo, winMat, SLOTS);
  const chimGeo = new THREE.BoxGeometry(0.1, 0.3, 0.1);
  const chimMat = new THREE.MeshStandardMaterial({ color: 0x8d7a6a, flatShading: true });
  const chimIM = new THREE.InstancedMesh(chimGeo, chimMat, SLOTS);
  chimIM.castShadow = true;
  const awnGeo = new THREE.BoxGeometry(1, 0.035, 0.16);
  const awnMat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.8 });
  const awnIM = new THREE.InstancedMesh(awnGeo, awnMat, SLOTS);
  awnIM.castShadow = true;
  group.add(wallsIM, roofsIM, winIM, chimIM, awnIM);

  // per-slot render state (winking windows + seasonal roof recolor)
  const winPh = new Float32Array(SLOTS);
  const winOn = new Uint8Array(SLOTS);
  const roofBase = Array.from({ length: SLOTS }, () => new THREE.Color(0x000000));
  let season = 'summer';
  const winterRoof = new THREE.Color('#eef0f2');

  // per-settlement record
  const recs = new Map();
  world.settlements.forEach((s, si) => {
    recs.set(s.id, {
      s, base: si * MAXB,
      builtType: s.type, builtPop: s.pop,
      buildings: [], // filled in after landmarks reserve their ground
      cx: s.x + 0.5 + ox, cz: s.y + 0.5 + oz,
      grewSeen: s.grewTick ?? null, shrunkSeen: s.shrunkTick ?? null,
      pulseUntil: -1, restored: true,
    });
  });

  function hideSlot(im, gi) {
    dummy.position.set(0, -100, 0);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(0.001, 0.001, 0.001);
    dummy.updateMatrix();
    im.setMatrixAt(gi, dummy.matrix);
  }

  // (re)write one settlement's slot block; sc = transient pulse scale about
  // the settlement centre (1 = at rest)
  function writeRec(rec, sc) {
    const winter = season === 'winter';
    for (let k = 0; k < MAXB; k++) {
      const gi = rec.base + k;
      const b = rec.buildings[k];
      if (!b) {
        hideSlot(wallsIM, gi); hideSlot(roofsIM, gi); hideSlot(winIM, gi);
        hideSlot(chimIM, gi); hideSlot(awnIM, gi);
        winOn[gi] = 0;
        roofBase[gi].setScalar(0);
        continue;
      }
      const px = rec.cx + (b.x - rec.cx) * sc, pz = rec.cz + (b.z - rec.cz) * sc;
      // wall
      dummy.position.set(px, b.gy + (b.hgt * sc) / 2, pz);
      dummy.rotation.order = 'XYZ';
      dummy.rotation.set(0, b.rot, 0);
      dummy.scale.set(b.wid * sc, b.hgt * sc, b.dep * sc);
      dummy.updateMatrix();
      wallsIM.setMatrixAt(gi, dummy.matrix);
      wallsIM.setColorAt(gi, color.set(b.wc));
      // roof (gabled prism; flat = squashed)
      dummy.position.set(px, b.gy + b.hgt * sc, pz);
      dummy.scale.set(b.rwid * sc, b.rh * sc, b.rdep * sc);
      dummy.updateMatrix();
      roofsIM.setMatrixAt(gi, dummy.matrix);
      roofBase[gi].set(b.rc);
      color.copy(roofBase[gi]);
      if (winter) color.lerp(winterRoof, 0.75);
      roofsIM.setColorAt(gi, color);
      // window
      if (b.win) {
        dummy.position.set(px + b.win.ox * sc, b.gy + b.win.oy * sc, pz + b.win.oz * sc);
        dummy.scale.set(b.win.w * sc, b.win.h * sc, 1);
        dummy.updateMatrix();
        winIM.setMatrixAt(gi, dummy.matrix);
        winIM.setColorAt(gi, color.setScalar(1));
        winPh[gi] = b.win.ph; winOn[gi] = 1;
      } else { hideSlot(winIM, gi); winOn[gi] = 0; }
      // chimney
      if (b.chim) {
        dummy.position.set(px + b.chim.ox * sc, b.gy + b.chim.oy * sc, pz + b.chim.oz * sc);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(sc, sc, sc);
        dummy.updateMatrix();
        chimIM.setMatrixAt(gi, dummy.matrix);
      } else hideSlot(chimIM, gi);
      // awning (tilted outward from the facade)
      if (b.awn) {
        dummy.position.set(px + b.awn.ox * sc, b.gy + b.awn.oy * sc, pz + b.awn.oz * sc);
        dummy.rotation.order = 'YXZ';
        dummy.rotation.set(0.35, b.rot, 0);
        dummy.scale.set(b.awn.w * sc, sc, sc);
        dummy.updateMatrix();
        awnIM.setMatrixAt(gi, dummy.matrix);
        awnIM.setColorAt(gi, color.set(b.awn.c));
        dummy.rotation.order = 'XYZ';
      } else hideSlot(awnIM, gi);
    }
    wallsIM.instanceMatrix.needsUpdate = true;
    roofsIM.instanceMatrix.needsUpdate = true;
    winIM.instanceMatrix.needsUpdate = true;
    chimIM.instanceMatrix.needsUpdate = true;
    awnIM.instanceMatrix.needsUpdate = true;
    if (wallsIM.instanceColor) wallsIM.instanceColor.needsUpdate = true;
    if (roofsIM.instanceColor) roofsIM.instanceColor.needsUpdate = true;
    if (winIM.instanceColor) winIM.instanceColor.needsUpdate = true;
    if (awnIM.instanceColor) awnIM.instanceColor.needsUpdate = true;
  }

  // streetlamps: instanced pole + warm bulb along road tiles near settlements
  const lampSpots = [];
  {
    const seen = new Set();
    for (const s of world.settlements) {
      const rad = s.type === 'city' ? 3.4 : s.type === 'town' ? 2.4 : 1.6;
      const r = Math.ceil(rad);
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > rad * rad) continue;
        const x = s.x + dx, y = s.y + dy;
        if (x < 0 || y < 0 || x >= world.w || y >= world.h) continue;
        const idx = y * world.w + x;
        if (world.tiles[idx] !== T.ROAD || seen.has(idx)) continue;
        seen.add(idx);
        // deterministic thinning + kerb-side offset
        const hsh = (((x * 73856093) ^ (y * 19349663)) >>> 0) % 100;
        if (hsh > 55) continue;
        const side = (hsh & 1) ? 0.34 : -0.34;
        const vert = world.tiles[idx + ((y > 0) ? -world.w : world.w)] === T.ROAD;
        const tx = x + 0.5 + (vert ? side : 0), ty = y + 0.5 + (vert ? 0 : side);
        lampSpots.push({ tx, ty });
      }
    }
  }
  const poleGeo = new THREE.CylinderGeometry(0.014, 0.02, 0.42, 5);
  poleGeo.translate(0, 0.21, 0);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x4a505c, flatShading: true, roughness: 0.7 });
  const poleIM = new THREE.InstancedMesh(poleGeo, poleMat, Math.max(1, lampSpots.length));
  const bulbGeo = new THREE.SphereGeometry(0.035, 6, 5);
  const bulbMat = new THREE.MeshBasicMaterial({ color: 0x6b6458 }); // day: dull glass; night: warm glow (bloom)
  const bulbIM = new THREE.InstancedMesh(bulbGeo, bulbMat, Math.max(1, lampSpots.length));
  lampSpots.forEach((l, i) => {
    const y = groundH(l.tx, l.ty);
    dummy.position.set(l.tx + ox, y, l.ty + oz);
    dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    poleIM.setMatrixAt(i, dummy.matrix);
    dummy.position.y = y + 0.44;
    dummy.updateMatrix();
    bulbIM.setMatrixAt(i, dummy.matrix);
  });
  group.add(poleIM, bulbIM);

  // ---------- settlement landmarks (silhouette variety) ----------
  const spinners = [];   // windmill blade groups
  const beams = [];      // lighthouse beam groups {g, mat, lampMat}
  const cream = new THREE.MeshStandardMaterial({ color: 0xe9dfc8, flatShading: true, roughness: 0.85 });
  const stone = new THREE.MeshStandardMaterial({ color: 0xb9b2a4, flatShading: true, roughness: 0.9 });
  const darkRoof = new THREE.MeshStandardMaterial({ color: 0x6d7b8d, flatShading: true, roughness: 0.8 });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x7fa8c0, flatShading: true, roughness: 0.18, metalness: 0.55,
    emissive: 0x24384a, emissiveIntensity: 0.35,
  });
  const clockFaceMat = new THREE.MeshBasicMaterial({ color: 0xf3efe2 });
  const capGeo = new THREE.ConeGeometry(0.72, 1, 4);

  const findSpot = (s, rng, rad = 0.35) => {
    let tx = s.x + 0.5, ty = s.y + 0.5;
    for (let t = 0; t < 20; t++) {
      const cx = s.x + 0.5 + rng.range(-1.9, 1.9), cy = s.y + 0.5 + rng.range(-1.9, 1.9);
      const tile = world.tiles[Math.floor(cy) * world.w + Math.floor(cx)];
      if (tile === T.WATER || tile === T.BRIDGE || tile === T.ROAD || heightAt(cx, cy) <= 0.15) continue;
      if (zones.some(z => (cx - z.x) ** 2 + (cy - z.z) ** 2 < (z.r + rad) ** 2)) continue;
      tx = cx; ty = cy;
      break;
    }
    zones.push({ x: tx, z: ty, r: rad }); // houses generate later and keep clear
    return { tx, ty };
  };
  const placeAt = (g, tx, ty, rot) => {
    g.position.set(tx + ox, groundH(tx, ty) - 0.05, ty + oz);
    g.rotation.y = rot;
    g.traverse(o => { if (o.isMesh && o.material !== clockFaceMat && !o.material.transparent) { o.castShadow = true; } });
    group.add(g);
  };

  for (const s of world.settlements) {
    const rng = makeRng((seed ^ (s.x * 7451 + s.y * 2683) ^ 0x1a4d) >>> 0);
    if (s.type === 'city') {
      // clock tower
      {
        const g = new THREE.Group();
        const body = new THREE.Mesh(boxGeo, cream);
        body.scale.set(0.34, 1.7, 0.34); body.position.y = 0.85;
        g.add(body);
        const cap = new THREE.Mesh(capGeo, darkRoof);
        cap.scale.set(0.31, 0.42, 0.31); cap.position.y = 1.91; cap.rotation.y = Math.PI / 4;
        g.add(cap);
        for (const rot of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
          const face = new THREE.Mesh(new THREE.CircleGeometry(0.1, 10), clockFaceMat);
          face.position.set(Math.sin(rot) * 0.176, 1.52, Math.cos(rot) * 0.176);
          face.rotation.y = rot;
          g.add(face);
        }
        const spot = findSpot(s, rng, 0.3);
        placeAt(g, spot.tx, spot.ty, rng.range(0, Math.PI));
      }
      // modern glass tower
      {
        const g = new THREE.Group();
        const hgt = rng.range(2.6, 3.2);
        const body = new THREE.Mesh(boxGeo, glassMat);
        body.scale.set(0.44, hgt, 0.44); body.position.y = hgt / 2;
        g.add(body);
        const crown = new THREE.Mesh(boxGeo, darkRoof);
        crown.scale.set(0.3, 0.1, 0.3); crown.position.y = hgt + 0.05;
        g.add(crown);
        const spot = findSpot(s, rng, 0.35);
        placeAt(g, spot.tx, spot.ty, rng.range(0, Math.PI));
      }
    } else if (s.type === 'town') {
      const spot = findSpot(s, rng, 0.55);
      if (rng.chance(0.5)) {
        // church with steeple
        const g = new THREE.Group();
        const nave = new THREE.Mesh(boxGeo, cream);
        nave.scale.set(0.5, 0.42, 0.78); nave.position.y = 0.21;
        g.add(nave);
        const roof = new THREE.Mesh(roofGeometry(), darkRoof);
        roof.scale.set(0.56, 0.3, 0.82); roof.position.y = 0.42;
        g.add(roof);
        const steeple = new THREE.Mesh(boxGeo, cream);
        steeple.scale.set(0.2, 0.85, 0.2); steeple.position.set(0, 0.42, -0.36);
        g.add(steeple);
        const spire = new THREE.Mesh(capGeo, darkRoof);
        spire.scale.set(0.17, 0.4, 0.17); spire.position.set(0, 1.05, -0.36); spire.rotation.y = Math.PI / 4;
        g.add(spire);
        placeAt(g, spot.tx, spot.ty, rng.range(0, Math.PI * 2));
      } else {
        // windmill with slowly rotating blades
        const g = new THREE.Group();
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.26, 0.85, 7), cream);
        body.position.y = 0.42;
        g.add(body);
        const cap = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.24, 7), darkRoof);
        cap.position.y = 0.96;
        g.add(cap);
        const hub = new THREE.Group();
        hub.position.set(0, 0.82, 0.22);
        const bladeGeo = new THREE.BoxGeometry(0.07, 0.62, 0.02);
        for (let b = 0; b < 4; b++) {
          const blade = new THREE.Mesh(bladeGeo, darkRoof);
          blade.position.y = 0.28;
          const arm = new THREE.Group();
          arm.rotation.z = b * Math.PI / 2;
          arm.add(blade);
          hub.add(arm);
        }
        g.add(hub);
        spinners.push({ hub, ph: rng.range(0, 6) });
        placeAt(g, spot.tx, spot.ty, rng.range(0, Math.PI * 2));
      }
    } else {
      // village: tiny lighthouse if coastal (water within 3 tiles)
      let coastal = false;
      for (let dy = -3; dy <= 3 && !coastal; dy++) for (let dx = -3; dx <= 3; dx++) {
        const x = s.x + dx, y = s.y + dy;
        if (x < 0 || y < 0 || x >= world.w || y >= world.h) continue;
        if (world.tiles[y * world.w + x] === T.WATER) { coastal = true; break; }
      }
      if (!coastal) continue;
      const g = new THREE.Group();
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 0.62, 8), cream);
      base.position.y = 0.31;
      g.add(base);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.115, 0.13, 8), new THREE.MeshStandardMaterial({ color: 0xc4574a, flatShading: true, roughness: 0.85 }));
      band.position.y = 0.31;
      g.add(band);
      const lampMat = new THREE.MeshBasicMaterial({ color: 0x8a8272 }); // warms up at night
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), lampMat);
      lamp.position.y = 0.68;
      g.add(lamp);
      const capL = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.12, 8), darkRoof);
      capL.position.y = 0.79;
      g.add(capL);
      // slow rotating light beam: narrow emissive cone, additive, night only
      const beamMat = new THREE.MeshBasicMaterial({
        color: 0xffe9b0, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      const beamGeo = new THREE.ConeGeometry(0.16, 2.4, 7, 1, true);
      beamGeo.translate(0, -1.2, 0);           // apex at origin
      beamGeo.rotateX(-Math.PI / 2);           // point along +z
      const beamG = new THREE.Group();
      beamG.position.y = 0.68;
      const beam = new THREE.Mesh(beamGeo, beamMat);
      beam.position.z = 0;
      beamG.add(beam);
      g.add(beamG);
      beams.push({ g: beamG, mat: beamMat, lampMat, ph: rng.range(0, 6) });
      const spot = findSpot(s, rng, 0.2);
      placeAt(g, spot.tx, spot.ty, 0);
      void stone;
    }
  }

  // houses last, so they dodge the reserved landmark and premise ground
  for (const rec of recs.values()) {
    rec.buildings = genBuildings(rec.s);
    writeRec(rec, 1);
  }

  // festive lights (visible only in December)
  const festGeo = new THREE.SphereGeometry(0.07, 6, 5);
  const festMat = new THREE.MeshBasicMaterial({ vertexColors: false });
  const festIM = new THREE.InstancedMesh(festGeo, festMat, Math.max(1, festive.length));
  festive.forEach((f, i) => {
    dummy.position.set(f.x, groundH(f.x - ox, f.z - oz) + 0.35, f.z);
    dummy.scale.set(1, 1, 1); dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    festIM.setMatrixAt(i, dummy.matrix);
    festIM.setColorAt(i, color.set(f.c));
  });
  festIM.visible = false;
  group.add(festIM);

  // ---------- trees on forest tiles ----------
  const trees = [];
  for (let y = 0; y < world.h; y++) for (let x = 0; x < world.w; x++) {
    if (world.tiles[y * world.w + x] !== T.FOREST) continue;
    const rng = makeRng((seed ^ (y * world.w + x)) >>> 0);
    const n = 2 + (rng.chance(0.5) ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const tx = x + rng.range(0.18, 0.82), ty = y + rng.range(0.18, 0.82);
      trees.push({ tx, ty, s: rng.range(0.55, 1), hue: rng.range(-0.03, 0.03) });
    }
  }
  const coneGeo = new THREE.ConeGeometry(0.32, 0.9, 6);
  coneGeo.translate(0, 0.75, 0);
  const trunkGeo = new THREE.CylinderGeometry(0.05, 0.07, 0.35, 5);
  trunkGeo.translate(0, 0.17, 0);
  const treeMat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.9 });
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6d4f35, flatShading: true, roughness: 0.95 });
  const treeIM = new THREE.InstancedMesh(coneGeo, treeMat, trees.length);
  const trunkIM = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
  treeIM.castShadow = true; trunkIM.castShadow = true;
  trees.forEach((t, i) => {
    const y = groundH(t.tx, t.ty);
    dummy.position.set(t.tx + ox, y, t.ty + oz);
    dummy.scale.set(t.s, t.s * (0.9 + t.hue * 4), t.s);
    dummy.rotation.set(0, t.hue * 40, 0);
    dummy.updateMatrix();
    treeIM.setMatrixAt(i, dummy.matrix);
    trunkIM.setMatrixAt(i, dummy.matrix);
  });
  group.add(treeIM, trunkIM);
  const treeColor = (season) => {
    const base = { spring: '#4b9450', summer: '#3f7d44', autumn: '#a06f30', winter: '#5d7a6c' }[season] || '#3f7d44';
    trees.forEach((t, i) => treeIM.setColorAt(i, color.set(base).offsetHSL(t.hue, 0, t.hue)));
    if (season === 'winter') trees.forEach((t, i) => { treeIM.getColorAt(i, color); treeIM.setColorAt(i, color.lerp(new THREE.Color('#e8ecec'), 0.35)); });
    treeIM.instanceColor.needsUpdate = true;
  };
  treeColor('summer');

  // ---------- port ----------
  if (world.port) {
    const p = world.port;
    const pg = new THREE.Group();
    const py = groundH(p.x + 0.5, p.y + 0.5);
    pg.position.set(p.x + 0.5 + ox, py, p.y + 0.5 + oz);
    const quay = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.22, 1.7), new THREE.MeshStandardMaterial({ color: 0x9aa0a6, flatShading: true }));
    quay.position.y = 0.06; quay.receiveShadow = true; quay.castShadow = true;
    pg.add(quay);
    // pier toward adjacent water
    let wd = { x: 1, y: 0 };
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const t = world.tiles[(p.y + dy) * world.w + p.x + dx];
      if (t === T.WATER) { wd = { x: dx, y: dy }; break; }
    }
    const pier = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.1, 0.5), new THREE.MeshStandardMaterial({ color: 0xa67c52, flatShading: true }));
    pier.position.set(wd.x * 1.4, -py + 0.16, wd.y * 1.4);
    if (wd.y !== 0) pier.rotation.y = Math.PI / 2;
    pier.castShadow = true;
    pg.add(pier);
    // containers
    const contGeo = new THREE.BoxGeometry(0.42, 0.26, 0.24);
    ['#c85a3a', '#3a7ac8', '#c8a23a', '#5aa05a'].forEach((c, i) => {
      const m = new THREE.Mesh(contGeo, new THREE.MeshStandardMaterial({ color: c, flatShading: true }));
      m.position.set(-0.45 + (i % 2) * 0.48, 0.3 + Math.floor(i / 2) * 0.27, -0.5);
      m.castShadow = true;
      pg.add(m);
    });
    // gantry crane
    const craneMat = new THREE.MeshStandardMaterial({ color: 0xd8b13a, flatShading: true });
    const legGeo = new THREE.BoxGeometry(0.07, 0.9, 0.07);
    for (const sx of [-0.3, 0.3]) {
      const leg = new THREE.Mesh(legGeo, craneMat);
      leg.position.set(sx, 0.6, 0.45);
      pg.add(leg);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.08, 0.08), craneMat);
    beam.position.set(0.2, 1.05, 0.45);
    beam.castShadow = true;
    pg.add(beam);
    const hangC = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.18, 0.18), new THREE.MeshStandardMaterial({ color: 0xc8503a, flatShading: true }));
    hangC.position.set(0.62, 0.72, 0.45);
    pg.add(hangC);
    // shed
    const shed = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.4, 0.5), new THREE.MeshStandardMaterial({ color: 0x8b93a1, flatShading: true }));
    shed.position.set(0.45, 0.35, -0.45);
    shed.castShadow = true;
    pg.add(shed);
    group.add(pg);
  }

  return {
    group,
    setSeason(sea) {
      season = sea;
      treeColor(sea);
      for (let i = 0; i < SLOTS; i++) {
        color.copy(roofBase[i]);
        if (sea === 'winter') color.lerp(winterRoof, 0.75);
        roofsIM.setColorAt(i, color);
      }
      roofsIM.instanceColor.needsUpdate = true;
    },
    // SIM2 living towns: cheap day-throttled check for tier changes / pop
    // drift / grew-shrunk day stamps. Rebuilds ONE settlement's slot block on
    // change and drives a brief scale pulse. townFX(sid, 'grow'|'shrink')
    // fires the fx.js flourish.
    sync(state, time, townFX) {
      if (state.day !== this._day) {
        this._day = state.day;
        for (const rec of recs.values()) {
          const s = rec.s;
          if (s.grewTick != null && s.grewTick !== rec.grewSeen) {
            rec.grewSeen = s.grewTick;
            if (state.day - s.grewTick <= 3) {
              if (townFX) townFX(s.id, 'grow');
              rec.pulseUntil = time + 0.8; rec.restored = false;
            }
          }
          if (s.shrunkTick != null && s.shrunkTick !== rec.shrunkSeen) {
            rec.shrunkSeen = s.shrunkTick;
            if (state.day - s.shrunkTick <= 3) {
              if (townFX) townFX(s.id, 'shrink');
              rec.pulseUntil = time + 0.8; rec.restored = false;
            }
          }
          // tier changed, or pop drifted >5% from what was built → regenerate
          // this settlement's cluster (footprint carries the ±8% pop scale)
          if (s.type !== rec.builtType || Math.abs(s.pop - rec.builtPop) > rec.builtPop * 0.05) {
            rec.builtType = s.type;
            rec.builtPop = s.pop;
            rec.buildings = genBuildings(s);
            writeRec(rec, 1);
          }
        }
      }
      // active scale pulses (rewrites just the pulsing settlement's slots)
      for (const rec of recs.values()) {
        if (rec.pulseUntil > time) {
          const prog = 1 - (rec.pulseUntil - time) / 0.8;
          writeRec(rec, 1 + 0.1 * Math.sin(prog * Math.PI));
        } else if (!rec.restored) {
          rec.restored = true;
          writeRec(rec, 1);
        }
      }
    },
    _day: null,
    // night ∈ [0,1]; december toggles festive lights
    update(time, night, december) {
      const warm = new THREE.Color(0xffca6e).multiplyScalar(0.25 + night * 1.4);
      const dark = new THREE.Color(0x2a2620);
      winMat.color.copy(dark).lerp(warm, Math.min(1, night * 1.3));

      // windows wink on/off subtly at night (throttled, per-instance color)
      if (night > 0.05) {
        if (time - this._winT > 0.3) {
          this._winT = time;
          for (let i = 0; i < SLOTS; i++) {
            if (!winOn[i]) continue;
            // very low wink rate: each window occasionally dips dark
            const w = Math.sin(time * (0.25 + winPh[i] * 0.5) + winPh[i] * 53.0);
            winIM.setColorAt(i, color.setScalar(w > 0.97 ? 0.12 : 1));
          }
          winIM.instanceColor.needsUpdate = true;
          this._winLit = true;
        }
      } else if (this._winLit) {
        for (let i = 0; i < SLOTS; i++) winIM.setColorAt(i, color.setScalar(1));
        winIM.instanceColor.needsUpdate = true;
        this._winLit = false;
      }

      // streetlamp bulbs: dull glass by day → warm bloom-feeding glow at night
      bulbMat.color.set(0x6b6458).lerp(color.set(0xffd9a0).multiplyScalar(1.9), Math.min(1, night * 1.4));

      // windmill blades turn lazily all day
      for (const sp of spinners) sp.hub.rotation.z = time * 0.45 + sp.ph;

      // lighthouse beams sweep slowly, visible only at night
      for (const b of beams) {
        b.g.rotation.y = time * 0.55 + b.ph;
        b.mat.opacity = night * 0.4;
        b.lampMat.color.set(0x8a8272).lerp(color.set(0xfff0c0).multiplyScalar(2.2), Math.min(1, night * 1.5));
      }

      festIM.visible = december;
      if (december && festIM.instanceColor) {
        festive.forEach((f, i) => {
          const tw = Math.sin(time * 3 + f.ph) > 0.4 ? 1 : 0.45;
          festIM.setColorAt(i, color.set(f.c).multiplyScalar(tw * (0.6 + night * 0.6)));
        });
        festIM.instanceColor.needsUpdate = true;
      }
    },
    _winT: -1,
    _winLit: false,
  };
}

// ------------------------------------------------------------------
// Player premises: dynamic, rebuilt when the premise list changes.
// ------------------------------------------------------------------
const PREM_OFFSET = { office: [-0.9, -0.9], store: [1.1, 0.6], warehouse: [-1.2, 1.0] };

function makeCrane(mat) {
  const g = new THREE.Group();
  const tower = new THREE.Mesh(new THREE.BoxGeometry(0.09, 1.5, 0.09), mat);
  tower.position.y = 0.75; tower.castShadow = true;
  g.add(tower);
  const jib = new THREE.Group();
  jib.position.y = 1.45;
  const arm = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.07, 0.07), mat);
  arm.position.x = 0.42; arm.castShadow = true;
  jib.add(arm);
  const counter = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.12, 0.12), mat);
  counter.position.x = -0.22;
  jib.add(counter);
  const cable = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.6, 0.015), new THREE.MeshBasicMaterial({ color: 0x333333 }));
  cable.position.set(0.85, -0.3, 0);
  jib.add(cable);
  const hook = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, 0.14), new THREE.MeshStandardMaterial({ color: 0xc8503a, flatShading: true }));
  hook.position.set(0.85, -0.62, 0);
  jib.add(hook);
  g.add(jib);
  g.userData.jib = jib;
  return g;
}

export class Premises {
  constructor(ctx) {
    this.ctx = ctx;
    this.group = new THREE.Group();
    this.group.name = 'premises';
    this.sig = '';
    this._won = false;
    this.animated = []; // {jib?, flag?, scaffold?, pr}
    this.mats = {
      green: new THREE.MeshStandardMaterial({ color: 0x3ddc84, flatShading: true, roughness: 0.6 }),
      greenDk: new THREE.MeshStandardMaterial({ color: 0x1f8a4f, flatShading: true, roughness: 0.7 }),
      cream: new THREE.MeshStandardMaterial({ color: 0xf1e9d6, flatShading: true, roughness: 0.85 }),
      grey: new THREE.MeshStandardMaterial({ color: 0x8b93a1, flatShading: true, roughness: 0.85 }),
      greyDk: new THREE.MeshStandardMaterial({ color: 0x565e6b, flatShading: true, roughness: 0.9 }),
      glow: new THREE.MeshBasicMaterial({ color: 0xffca6e }),
      sign: new THREE.MeshBasicMaterial({ color: 0x3ddc84 }),
      // franchisee-run stores: warm lime awning/sign so the network reads differently
      franch: new THREE.MeshStandardMaterial({ color: 0xa8d84a, flatShading: true, roughness: 0.6 }),
      franchSign: new THREE.MeshBasicMaterial({ color: 0xd6e85a }),
      gold: new THREE.MeshBasicMaterial({ color: 0xffd24d, side: THREE.DoubleSide }),
      scaffold: new THREE.MeshStandardMaterial({ color: 0xd88a3a, flatShading: true }),
      dirt: new THREE.MeshStandardMaterial({ color: 0x9a7a54, flatShading: true, roughness: 1 }),
      frame: new THREE.MeshStandardMaterial({ color: 0xc9b8998, flatShading: true }),
      stripe: new THREE.MeshBasicMaterial({ color: 0xffd24d }),
    };
    this.mats.frame.color = new THREE.Color(0xc9b899);
  }

  signature(state) {
    return (state.won ? 'W|' : '') +
      state.premises.map(p => `${p.id}:${p.level}:${p.franchise ? 'f' : ''}${p.construction ? (p.construction.isNew ? 'n' : 'u') : '-'}`).join('|');
  }

  sync(state) {
    const sig = this.signature(state);
    if (sig === this.sig) return;
    this.sig = sig;
    this._won = !!state.won;
    this.group.clear();
    this.animated.length = 0;
    for (const pr of state.premises) {
      const s = state.world.settlements.find(o => o.id === pr.sid);
      if (!s) continue;
      const [dx, dy] = PREM_OFFSET[pr.kind] || [0, 0];
      let tx = s.x + 0.5 + dx, ty = s.y + 0.5 + dy;
      // spec offset can land in the sea on coastal settlements — slide toward
      // the settlement centre until we find dry ground
      for (let t = 0; t <= 10 && this.ctx.heightAt(tx, ty) < 0.15; t++) {
        tx = s.x + 0.5 + dx * (1 - t / 10);
        ty = s.y + 0.5 + dy * (1 - t / 10);
      }
      const g = new THREE.Group();
      g.position.set(tx + this.ctx.ox, this.ctx.groundH(tx, ty), ty + this.ctx.oz);
      if (pr.construction && pr.construction.isNew) this.buildSite(g, pr);
      else {
        this.buildPremise(g, pr);
        if (pr.construction) { // upgrade in progress: crane beside the trading building
          const crane = makeCrane(this.mats.scaffold);
          crane.position.set(0.6, 0, 0.4);
          g.add(crane);
          this.animated.push({ jib: crane.userData.jib, pr, phase: Math.random() * 6 });
        }
      }
      this.group.add(g);
    }
  }

  buildPremise(g, pr) {
    const M = this.mats;
    if (pr.kind === 'office') {
      // HQ: garage at level 0, green tower at higher levels — warm emissive windows
      const hs = [0.55, 1.3, 2.2][pr.level] || 0.55;
      const ws = [0.7, 0.8, 1.0][pr.level] || 0.7;
      const body = new THREE.Mesh(new THREE.BoxGeometry(ws, hs, ws * 0.9), pr.level === 0 ? M.cream : M.green);
      body.position.y = hs / 2;
      body.castShadow = true; body.receiveShadow = true;
      g.add(body);
      if (pr.level === 0) {
        // garage door, warm glow
        const door = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.34), M.glow);
        door.position.set(0, 0.2, ws * 0.45 + 0.01);
        g.add(door);
        const roof = new THREE.Mesh(roofGeometry(), M.greenDk);
        roof.scale.set(ws * 1.15, 0.3, ws);
        roof.position.y = hs;
        roof.castShadow = true;
        g.add(roof);
      } else {
        const cap = new THREE.Mesh(new THREE.BoxGeometry(ws * 0.8, 0.08, ws * 0.72), M.greenDk);
        cap.position.y = hs + 0.04;
        g.add(cap);
        for (let i = 0; i < pr.level + 1; i++) {
          const win = new THREE.Mesh(new THREE.PlaneGeometry(ws * 0.6, 0.12), M.glow);
          win.position.set(0, hs * (0.3 + i * 0.25), ws * 0.45 + 0.01);
          g.add(win);
        }
      }
      // waving flag — golden once state.won flips true (SIM2 win state)
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.5, 4), M.greyDk);
      pole.position.set(ws * 0.4, hs + 0.25, 0);
      g.add(pole);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.14), this._won ? M.gold : new THREE.MeshBasicMaterial({ color: 0x3ddc84, side: THREE.DoubleSide }));
      flag.position.set(ws * 0.4 + 0.13, hs + 0.42, 0);
      g.add(flag);
      if (this._won) {
        const finial = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 5), M.gold);
        finial.position.set(ws * 0.4, hs + 0.52, 0);
        g.add(finial);
      }
      this.animated.push({ flag, pr });
    } else if (pr.kind === 'store') {
      const hs = [0.4, 0.6, 0.9][pr.level] || 0.4;
      const ws = [0.55, 0.72, 0.95][pr.level] || 0.55;
      const body = new THREE.Mesh(new THREE.BoxGeometry(ws, hs, ws * 0.85), M.cream);
      body.position.y = hs / 2;
      body.castShadow = true;
      g.add(body);
      // brand-green awning (warm lime on franchisee-run stores)
      const awn = new THREE.Mesh(new THREE.BoxGeometry(ws * 1.08, 0.04, 0.22), pr.franchise ? M.franch : M.green);
      awn.position.set(0, hs * 0.62, ws * 0.46);
      awn.rotation.x = 0.35;
      awn.castShadow = true;
      g.add(awn);
      // emissive sign
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(ws * 0.7, 0.1), pr.franchise ? M.franchSign : M.sign);
      sign.position.set(0, hs * 0.82, ws * 0.43 + 0.01);
      g.add(sign);
      const door = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.28), M.glow);
      door.position.set(0, 0.15, ws * 0.43 + 0.01);
      g.add(door);
    } else { // warehouse
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.55, 0.8), M.grey);
      body.position.y = 0.28;
      body.castShadow = true; body.receiveShadow = true;
      g.add(body);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(1.16, 0.06, 0.86), M.greyDk);
      roof.position.y = 0.58;
      g.add(roof);
      // loading bay: dark door + ramp
      const door = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.34), new THREE.MeshBasicMaterial({ color: 0x2c313a }));
      door.position.set(0, 0.22, 0.41);
      g.add(door);
      const ramp = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.05, 0.3), M.greyDk);
      ramp.position.set(0, 0.03, 0.55);
      g.add(ramp);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 5), M.glow);
      lamp.position.set(0, 0.48, 0.42);
      g.add(lamp);
    }
  }

  buildSite(g, pr) {
    const M = this.mats;
    // dirt pad
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.7, 0.06, 8), M.dirt);
    pad.position.y = 0.03;
    pad.receiveShadow = true;
    g.add(pad);
    // growing frame
    const fullH = pr.kind === 'warehouse' ? 0.55 : pr.kind === 'office' ? 0.6 : 0.45;
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1, 0.5), M.frame);
    frame.castShadow = true;
    g.add(frame);
    // scaffold poles
    for (const [sx, sz] of [[-0.36, -0.3], [0.36, -0.3], [-0.36, 0.3], [0.36, 0.3]]) {
      const pole = new THREE.Mesh(new THREE.BoxGeometry(0.04, fullH + 0.25, 0.04), M.scaffold);
      pole.position.set(sx, (fullH + 0.25) / 2, sz);
      g.add(pole);
    }
    // striped barrier
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.05, 0.05), M.stripe);
    bar.position.set(0, 0.14, 0.55);
    g.add(bar);
    // crane
    const crane = makeCrane(this.mats.scaffold);
    crane.position.set(0.55, 0, -0.4);
    g.add(crane);
    this.animated.push({ jib: crane.userData.jib, frame, fullH, pr, phase: Math.random() * 6 });
  }

  update(time) {
    for (const a of this.animated) {
      if (a.jib) a.jib.rotation.y = Math.sin(time * 1.3 + (a.phase || 0)) * 0.9;
      if (a.frame && a.pr.construction) {
        const prog = 1 - a.pr.construction.daysLeft / a.pr.construction.totalDays;
        const hgt = Math.max(0.04, a.fullH * prog);
        a.frame.scale.y = hgt;
        a.frame.position.y = hgt / 2;
      }
      if (a.flag) a.flag.rotation.y = Math.sin(time * 4) * 0.4;
    }
  }
}
