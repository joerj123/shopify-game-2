// Low-poly island terrain: one merged BufferGeometry, vertex colors, flat shading.
// Also exports heightAt (bilinear tile-corner heights) used by everything that
// stands on the ground, plus bridge meshes and a shore-distance field for water foam.
import * as THREE from 'three';
import { T } from '../world.js';
import { makeRng } from '../rng.js';

export const SEA_LEVEL = 0;
const EL = 0.42;              // world units per elevation level
const SEABED = -0.9;

// Elevation level per spec: WATER 0, BRIDGE 1, MOUNTAIN 5, HILL 3, else elev<0.45?1:2
export function tileLevel(world, x, y) {
  if (x < 0 || y < 0 || x >= world.w || y >= world.h) return 0;
  const t = world.tiles[y * world.w + x];
  if (t === T.WATER) return 0;
  if (t === T.BRIDGE) return 1;
  if (t === T.MOUNTAIN) return 5;
  if (t === T.HILL) return 3;
  return world.elev[y * world.w + x] < 0.45 ? 1 : 2;
}

function tileSurfaceH(world, x, y) {
  const lvl = tileLevel(world, x, y);
  if (lvl === 0) return SEABED;
  // gentle per-level exaggeration; mountains rise a bit extra
  return lvl * EL + (lvl >= 5 ? 0.9 : 0) + (lvl >= 3 ? 0.25 : 0);
}

const hash2 = (x, y) => {
  let h = (x * 374761393 + y * 668265263) ^ 0x5bf03635;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

// ---------------- seasonal palettes ----------------
const PAL = {
  spring: { grass: '#79bd63', grass2: '#6cb257', forest: '#4b9450', sand: '#e8d5a3', hill: '#9cae6d', mtn: '#8d8577', snow: '#efeee9', road: '#b8a98e', bridge: '#a67c52', farm: '#c9a86a', farm2: '#b8945a', bloom: '#e8a3c0' },
  summer: { grass: '#7cb95c', grass2: '#6faf50', forest: '#4e8f4a', sand: '#ecd9a5', hill: '#9aa06b', mtn: '#8d8577', snow: '#efeee9', road: '#b8a98e', bridge: '#a67c52', farm: '#d1ab66', farm2: '#c09755', bloom: '#f0e58a' },
  autumn: { grass: '#b99c48', grass2: '#ad8f40', forest: '#a06f30', sand: '#e6d09b', hill: '#a08d5e', mtn: '#877f70', snow: '#efeee9', road: '#b3a284', bridge: '#9e744c', farm: '#b58a4a', farm2: '#a37a3e', bloom: '#c96f3a' },
  winter: { grass: '#dfe4e8', grass2: '#d3dade', forest: '#6f8577', sand: '#e3ddc9', hill: '#cfd4d6', mtn: '#b5b1a8', snow: '#f4f3ef', road: '#cfc4ae', bridge: '#93704e', farm: '#d8d2c2', farm2: '#c8c2b2', bloom: '#eef0f2' },
};

// Deterministic farmland ring around towns/villages (spec §1.3)
function buildFarmSet(world) {
  const farm = new Set();
  for (const s of world.settlements) {
    if (s.type === 'city') continue;
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
      const md = Math.abs(dx) + Math.abs(dy);
      if (md < 3 || md > 6) continue;
      const x = s.x + dx, y = s.y + dy;
      if (x < 0 || y < 0 || x >= world.w || y >= world.h) continue;
      if (world.tiles[y * world.w + x] !== T.GRASS) continue;
      if ((((x * 73856093) ^ (y * 19349663)) >>> 0) % 5 < 2) farm.add(y * world.w + x);
    }
  }
  return farm;
}

// Distance-to-land (in tiles, clamped) for every tile — drives shoreline foam & shallows.
function buildShoreField(world) {
  const { w, h, tiles } = world;
  const d = new Float32Array(w * h).fill(99);
  const q = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const t = tiles[y * w + x];
    if (t !== T.WATER) { d[y * w + x] = 0; q.push(y * w + x); }
  }
  let qi = 0;
  while (qi < q.length) {
    const cur = q[qi++], cx = cur % w, cy = (cur / w) | 0;
    const nd = d[cur] + 1;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (nd < d[ni]) { d[ni] = nd; q.push(ni); }
    }
  }
  return d;
}

export function buildTerrain(ctx) {
  const { world, seed } = ctx;
  const { w, h } = world;
  const farmSet = buildFarmSet(world);
  const shore = buildShoreField(world);

  // corner heights (w+1)*(h+1): average of the 4 adjacent tile surface heights + micro noise
  const ch = new Float32Array((w + 1) * (h + 1));
  for (let y = 0; y <= h; y++) {
    for (let x = 0; x <= w; x++) {
      const s = (tileSurfaceH(world, x - 1, y - 1) + tileSurfaceH(world, x, y - 1) +
                 tileSurfaceH(world, x - 1, y) + tileSurfaceH(world, x, y)) / 4;
      // micro facet noise on land only, none near roads (keeps vehicles level)
      let n = 0;
      if (s > 0.1) {
        let nearRoad = false;
        for (let dy = -1; dy <= 0 && !nearRoad; dy++) for (let dx = -1; dx <= 0; dx++) {
          const tx = x + dx, ty = y + dy;
          if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
          const t = world.tiles[ty * w + tx];
          if (t === T.ROAD || t === T.BRIDGE) { nearRoad = true; break; }
        }
        if (!nearRoad) n = (hash2(x, y) - 0.5) * 0.16;
      }
      ch[y * (w + 1) + x] = s + n;
    }
  }
  const cornerH = (x, y) => ch[Math.min(h, Math.max(0, y)) * (w + 1) + Math.min(w, Math.max(0, x))];

  function heightAt(tx, ty) {
    // bilinear over corner grid; tx,ty are fractional tile coords
    const x0 = Math.floor(tx), y0 = Math.floor(ty);
    const fx = tx - x0, fy = ty - y0;
    const a = cornerH(x0, y0), b = cornerH(x0 + 1, y0), c = cornerH(x0, y0 + 1), d = cornerH(x0 + 1, y0 + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }
  const groundH = (tx, ty) => Math.max(SEA_LEVEL, heightAt(tx, ty));

  // ---------------- geometry: 2 triangles per tile, non-indexed ----------------
  const triCount = w * h * 2;
  const pos = new Float32Array(triCount * 9);
  const col = new Float32Array(triCount * 9);
  const tileOfTri = new Int32Array(triCount); // tile index → recolor per season
  let pi = 0, ti = 0;
  const ox = -w / 2, oz = -h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i00 = cornerH(x, y), i10 = cornerH(x + 1, y), i01 = cornerH(x, y + 1), i11 = cornerH(x + 1, y + 1);
      const X = x + ox, Z = y + oz;
      // alternate diagonal for a nicer low-poly weave
      const flip = ((x + y) & 1) === 0;
      const quads = flip
        ? [[X, i00, Z, X, i01, Z + 1, X + 1, i10, Z], [X + 1, i10, Z, X, i01, Z + 1, X + 1, i11, Z + 1]]
        : [[X, i00, Z, X + 1, i11, Z + 1, X + 1, i10, Z], [X, i00, Z, X, i01, Z + 1, X + 1, i11, Z + 1]];
      for (const q of quads) {
        pos.set(q, pi); pi += 9;
        tileOfTri[ti++] = y * w + x;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.name = 'terrain';

  // ---------------- coloring (per season) ----------------
  const cA = new THREE.Color(), cB = new THREE.Color();
  function colorize(season) {
    const P = PAL[season] || PAL.summer;
    const rng = makeRng((seed ^ 0x51ab) >>> 0);
    const attr = geo.getAttribute('color');
    for (let t = 0; t < triCount; t++) {
      const tileI = tileOfTri[t];
      const x = tileI % w, y = (tileI / w) | 0;
      const tile = world.tiles[tileI];
      const hgt = (pos[t * 9 + 1] + pos[t * 9 + 4] + pos[t * 9 + 7]) / 3;
      let hex;
      if (tile === T.WATER || tile === T.BRIDGE) {
        // seabed normally, but steep shared corners next to tall land climb
        // above sea level — shade those as rock cliffs, not teal seabed
        hex = hgt > 0.08 ? '#8a8274' : '#254a52';
      } else if (tile === T.SAND) hex = P.sand;
      else if (tile === T.ROAD) hex = P.road;
      else if (tile === T.MOUNTAIN) hex = P.mtn;
      else if (tile === T.HILL) hex = P.hill;
      else if (tile === T.FOREST) hex = P.forest;
      else if (farmSet.has(tileI)) hex = ((x + y * 2) & 2) ? P.farm : P.farm2;
      else hex = hash2(x * 3 + 1, y * 5 + 2) > 0.5 ? P.grass : P.grass2;
      cA.set(hex);
      // seasonal decoration flecks on grass (flowers/leaves)
      if (tile === T.GRASS && !farmSet.has(tileI) && hash2(x * 7, y * 11 + (t & 1)) > 0.92) cA.lerp(cB.set(P.bloom), 0.45);
      // snow caps on high ground (always on mountaintops; everywhere raised in winter)
      // year-round caps read crisper: brighter white, steeper blend
      const snowLine = season === 'winter' ? 0.9 : 3.05;
      if (hgt > snowLine && tile !== T.ROAD) {
        cB.set(season === 'winter' ? P.snow : '#f7f6f1');
        cA.lerp(cB, Math.min(1, (hgt - snowLine) * (season === 'winter' ? 1.4 : 2.1) + 0.42));
      }
      // per-face jitter for the low-poly facet look — subtle hue drift so
      // fields shimmer painterly instead of flat lightness noise
      const j = (hash2(x * 13 + (t & 1) * 7, y * 17) - 0.5) * 0.035;
      const hj = (hash2(x * 29 + (t & 1) * 3, y * 23) - 0.5) * 0.022;
      const sj = (hash2(x * 41, y * 37 + (t & 1) * 5) - 0.5) * 0.06;
      cA.offsetHSL(hj, sj, j);
      // subtle ambient occlusion in valleys near water
      if (hgt < 0.5 && tile !== T.WATER && tile !== T.BRIDGE) cA.multiplyScalar(0.94);
      for (let v = 0; v < 3; v++) { attr.setXYZ(t * 3 + v, cA.r, cA.g, cA.b); }
      void rng;
    }
    attr.needsUpdate = true;
    seasonDetail(season);
  }

  // ---------------- ambient detail (instanced, attached to terrain mesh) ----------------
  // Rocks on hills/mountains, wildflowers on spring/summer grass, bushes on
  // grass↔forest edges, fallen-leaf patches in autumn, boulders on beaches.
  // All deterministic (derived seeds), all children of `mesh` so the renderer's
  // scene.add(terrain.mesh) carries them; raycasting uses non-recursive
  // intersectObject so picking is unaffected.
  const dummy = new THREE.Object3D();
  const dCol = new THREE.Color();
  const tileAt = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? T.WATER : world.tiles[y * w + x];

  // gather placements
  const rocks = [], flowers = [], bushes = [], leaves = [], boulders = [];
  const FLOWER_COLS = ['#e8a3c0', '#f3f0d8', '#f0d06e', '#b9a3e0'];
  {
    const rr = makeRng((seed ^ 0x9e3d) >>> 0);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const tile = tileAt(x, y);
      const r = rr.next(); // one draw per tile keeps the stream stable
      if ((tile === T.HILL || tile === T.MOUNTAIN) && r < (tile === T.MOUNTAIN ? 0.22 : 0.14)) {
        const n = 1 + ((hash2(x * 5, y * 9) * 3) | 0);
        for (let i = 0; i < n; i++) {
          const tx = x + 0.2 + hash2(x * 7 + i, y * 3) * 0.6, ty = y + 0.2 + hash2(x * 3, y * 7 + i) * 0.6;
          rocks.push({ tx, ty, s: 0.07 + hash2(x + i * 17, y - i * 5) * 0.11, ry: hash2(x * 11 + i, y * 13) * 6.28, shade: hash2(x + i, y * 2 + i) });
        }
      } else if (tile === T.GRASS && !farmSet.has(y * w + x)) {
        if (r < 0.13) { // wildflower cluster (spring/summer only)
          const n = 3 + ((hash2(x * 19, y * 21) * 3) | 0);
          for (let i = 0; i < n; i++) {
            flowers.push({
              tx: x + 0.12 + hash2(x * 4 + i * 7, y * 6) * 0.76, ty: y + 0.12 + hash2(x * 6, y * 4 + i * 7) * 0.76,
              c: FLOWER_COLS[(hash2(x * 9 + i, y * 5) * 4) | 0], s: 0.7 + hash2(x + i * 3, y + i) * 0.6,
            });
          }
        } else if (r < 0.24) {
          // bush only on forest-adjacent grass
          if (tileAt(x + 1, y) === T.FOREST || tileAt(x - 1, y) === T.FOREST ||
              tileAt(x, y + 1) === T.FOREST || tileAt(x, y - 1) === T.FOREST) {
            bushes.push({ tx: x + 0.25 + hash2(x, y * 31) * 0.5, ty: y + 0.25 + hash2(x * 31, y) * 0.5, s: 0.1 + hash2(x * 3, y * 3) * 0.09, hue: hash2(x * 2, y * 8) });
          }
        }
        if (hash2(x * 23, y * 27) > 0.86) { // autumn leaf patch
          leaves.push({ tx: x + 0.2 + hash2(x * 8, y * 2) * 0.6, ty: y + 0.2 + hash2(x * 2, y * 8) * 0.6, s: 0.6 + hash2(x, y * 4) * 0.8, warm: hash2(x * 6, y * 6) });
        }
      } else if (tile === T.SAND && boulders.length < 12 && shore[y * w + x] === 0 && hash2(x * 15, y * 33) > 0.93) {
        boulders.push({ tx: x + 0.3 + hash2(x, y) * 0.4, ty: y + 0.3 + hash2(y, x) * 0.4, s: 0.14 + hash2(x * 2, y * 5) * 0.12, ry: hash2(x * 4, y * 4) * 6.28 });
      }
    }
  }

  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const rockMat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.95 });
  const rockIM = new THREE.InstancedMesh(rockGeo, rockMat, Math.max(1, rocks.length + boulders.length));
  rockIM.castShadow = true; rockIM.receiveShadow = true;
  const placeRock = (r, i) => {
    dummy.position.set(r.tx + ox, Math.max(SEA_LEVEL, heightAt(r.tx, r.ty)) + r.s * 0.25, r.ty + oz);
    dummy.rotation.set(0, r.ry, 0);
    dummy.scale.set(r.s * (1 + (r.shade || 0.5) * 0.5), r.s * 0.8, r.s);
    dummy.updateMatrix();
    rockIM.setMatrixAt(i, dummy.matrix);
  };
  rocks.forEach(placeRock);
  boulders.forEach((b, i) => placeRock(b, rocks.length + i));

  const flowerGeo = new THREE.TetrahedronGeometry(0.032);
  const flowerMat = new THREE.MeshBasicMaterial({ vertexColors: false });
  const flowerIM = new THREE.InstancedMesh(flowerGeo, flowerMat, Math.max(1, flowers.length));
  flowers.forEach((f, i) => {
    dummy.position.set(f.tx + ox, heightAt(f.tx, f.ty) + 0.025 * f.s, f.ty + oz);
    dummy.rotation.set(0, f.s * 9, 0.15);
    dummy.scale.setScalar(f.s);
    dummy.updateMatrix();
    flowerIM.setMatrixAt(i, dummy.matrix);
    flowerIM.setColorAt(i, dCol.set(f.c));
  });

  const bushGeo = new THREE.IcosahedronGeometry(1, 0);
  const bushMat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.9 });
  const bushIM = new THREE.InstancedMesh(bushGeo, bushMat, Math.max(1, bushes.length));
  bushIM.castShadow = true;
  bushes.forEach((b, i) => {
    dummy.position.set(b.tx + ox, heightAt(b.tx, b.ty) + b.s * 0.4, b.ty + oz);
    dummy.rotation.set(0, b.hue * 6.28, 0);
    dummy.scale.set(b.s * 1.3, b.s * 0.75, b.s);
    dummy.updateMatrix();
    bushIM.setMatrixAt(i, dummy.matrix);
  });

  const leafGeo = new THREE.CircleGeometry(0.11, 5);
  leafGeo.rotateX(-Math.PI / 2);
  const leafMat = new THREE.MeshBasicMaterial({ vertexColors: false });
  const leafIM = new THREE.InstancedMesh(leafGeo, leafMat, Math.max(1, leaves.length));
  leaves.forEach((l, i) => {
    dummy.position.set(l.tx + ox, heightAt(l.tx, l.ty) + 0.02, l.ty + oz);
    dummy.rotation.set(0, l.warm * 6.28, 0);
    dummy.scale.set(l.s, 1, l.s * 0.8);
    dummy.updateMatrix();
    leafIM.setMatrixAt(i, dummy.matrix);
    leafIM.setColorAt(i, dCol.set(l.warm > 0.5 ? '#c9812f' : '#a8552e').offsetHSL(0, 0, (l.warm - 0.5) * 0.1));
  });
  leafIM.visible = false;
  mesh.add(rockIM, flowerIM, bushIM, leafIM);

  // seasonal states for the detail layer (called from colorize)
  const dCol2 = new THREE.Color();
  function seasonDetail(season) {
    flowerIM.visible = season === 'spring' || season === 'summer';
    leafIM.visible = season === 'autumn';
    // rocks: grey, snow-dusted in winter (simple color lerp)
    const snow = season === 'winter';
    for (let i = 0; i < rocks.length; i++) {
      dCol.set('#8d8577').offsetHSL(0, 0, (rocks[i].shade - 0.5) * 0.12);
      if (snow) dCol.lerp(dCol2.set('#eef0f2'), 0.55 + rocks[i].shade * 0.25);
      rockIM.setColorAt(i, dCol);
    }
    for (let i = 0; i < boulders.length; i++) {
      dCol.set('#9a9284');
      if (snow) dCol.lerp(dCol2.set('#eef0f2'), 0.4);
      rockIM.setColorAt(rocks.length + i, dCol);
    }
    if (rockIM.instanceColor) rockIM.instanceColor.needsUpdate = true;
    // bushes follow foliage season
    const bushBase = { spring: '#5aa14f', summer: '#4c8f45', autumn: '#a5732f', winter: '#7c8f82' }[season] || '#4c8f45';
    for (let i = 0; i < bushes.length; i++) {
      dCol.set(bushBase).offsetHSL((bushes[i].hue - 0.5) * 0.05, 0, (bushes[i].hue - 0.5) * 0.1);
      if (snow) dCol.lerp(dCol2.set('#e6ecec'), 0.45);
      bushIM.setColorAt(i, dCol);
    }
    if (bushIM.instanceColor) bushIM.instanceColor.needsUpdate = true;
    if (flowerIM.instanceColor) flowerIM.instanceColor.needsUpdate = true;
    if (leafIM.instanceColor) leafIM.instanceColor.needsUpdate = true;
  }

  // ---------------- bridges: plank decks + pilings over water ----------------
  const bridgeGroup = new THREE.Group();
  const plankMat = new THREE.MeshStandardMaterial({ color: 0xa67c52, roughness: 0.9, flatShading: true });
  const plankDark = new THREE.MeshStandardMaterial({ color: 0x7d5a39, roughness: 0.95, flatShading: true });
  const deckGeo = new THREE.BoxGeometry(1.06, 0.12, 0.72);
  const pileGeo = new THREE.CylinderGeometry(0.06, 0.08, 1.2, 5);
  const railGeo = new THREE.BoxGeometry(1.02, 0.1, 0.06);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (world.tiles[y * w + x] !== T.BRIDGE) continue;
    // orientation: follow road/bridge neighbors
    const horiz = (x > 0 && [T.ROAD, T.BRIDGE].includes(world.tiles[y * w + x - 1])) ||
                  (x < w - 1 && [T.ROAD, T.BRIDGE].includes(world.tiles[y * w + x + 1]));
    const g = new THREE.Group();
    const deck = new THREE.Mesh(deckGeo, plankMat);
    deck.castShadow = true; deck.receiveShadow = true;
    g.add(deck);
    for (const s of [-1, 1]) {
      const rail = new THREE.Mesh(railGeo, plankDark);
      rail.position.set(0, 0.14, s * 0.34);
      g.add(rail);
      const p1 = new THREE.Mesh(pileGeo, plankDark);
      p1.position.set(-0.35 * s, -0.55, s * 0.28);
      g.add(p1);
      const p2 = new THREE.Mesh(pileGeo, plankDark);
      p2.position.set(0.35 * s, -0.55, -s * 0.28);
      g.add(p2);
    }
    if (!horiz) g.rotation.y = Math.PI / 2;
    g.position.set(x + 0.5 + ox, EL * 0.9, y + 0.5 + oz);
    bridgeGroup.add(g);
  }

  return { mesh, bridgeGroup, heightAt, groundH, colorize, shore, farmSet, ox, oz };
}
