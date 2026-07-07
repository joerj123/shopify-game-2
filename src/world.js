// Procedural world generation: terrain, settlements, roads, customer segments.
import { makeRng, makeNoise } from './rng.js';

export const MAP_W = 72;
export const MAP_H = 52;

// Terrain codes
export const T = { WATER: 0, SAND: 1, GRASS: 2, FOREST: 3, HILL: 4, MOUNTAIN: 5, ROAD: 6, BRIDGE: 7 };

// ---------------- customer segments ----------------
// prefs are weights over product attributes; cats are category affinities.
export const SEGMENTS = {
  trendsetters: {
    name: 'Trendsetters', color: '#e06fae',
    prefs: { style: .95, quality: .45, utility: .2, eco: .5, tech: .6 },
    priceSens: .3, onlineBias: 1.3,
    cats: { apparel: 1, beauty: .9, gadgets: .7, home: .5, toys: .3, food: .4, outdoor: .2, fitness: .4 },
  },
  families: {
    name: 'Families', color: '#ffd24d',
    prefs: { style: .3, quality: .6, utility: .85, eco: .4, tech: .3 },
    priceSens: .7, onlineBias: 1.0,
    cats: { toys: 1, home: .9, food: .8, apparel: .5, gadgets: .4, outdoor: .5, beauty: .3, fitness: .3 },
  },
  outdoorsy: {
    name: 'Outdoorsy', color: '#6fbf73',
    prefs: { style: .35, quality: .7, utility: .8, eco: .8, tech: .3 },
    priceSens: .45, onlineBias: .9,
    cats: { outdoor: 1, fitness: .8, food: .6, apparel: .5, home: .3, gadgets: .3, toys: .2, beauty: .2 },
  },
  professionals: {
    name: 'Professionals', color: '#5ac8e0',
    prefs: { style: .6, quality: .9, utility: .5, eco: .4, tech: .85 },
    priceSens: .15, onlineBias: 1.25,
    cats: { gadgets: 1, home: .7, apparel: .6, fitness: .6, beauty: .5, food: .5, outdoor: .4, toys: .2 },
  },
  bargainers: {
    name: 'Bargain Hunters', color: '#ff8f5a',
    prefs: { style: .35, quality: .3, utility: .6, eco: .2, tech: .3 },
    priceSens: .95, onlineBias: 1.1,
    cats: { food: .8, home: .8, toys: .8, apparel: .7, gadgets: .6, fitness: .4, outdoor: .4, beauty: .5 },
  },
  seniors: {
    name: 'Seniors', color: '#c792ea',
    prefs: { style: .3, quality: .8, utility: .75, eco: .5, tech: .1 },
    priceSens: .5, onlineBias: .45,
    cats: { home: 1, food: .9, outdoor: .4, apparel: .4, beauty: .4, toys: .5, gadgets: .15, fitness: .2 },
  },
};

const CITY_NAMES = ['Ottermouth', 'Port Snook', 'Greenfall', 'Kettleton', 'New Harbour', 'Falcon City'];
const TOWN_NAMES = ['Maplewick', 'Dunmere', 'Salt Flats', 'Birchby', 'Coalford', 'Wrenfield', 'Elk Grove', 'Tinsley', 'Marrow Bay', 'Hazelbrook'];
const VILLAGE_NAMES = ['Pigeon Hollow', 'Foxholme', 'Little Fen', 'Bramble End', 'Stony Reach', 'Cider Cross', 'Lark Rise', 'Moss Landing', 'Quiet Water', 'Thistledown'];

function segMix(rng, type) {
  // Base mixes per settlement type, jittered per settlement.
  const base = {
    city:    { trendsetters: 24, professionals: 26, families: 18, bargainers: 16, outdoorsy: 8, seniors: 8 },
    town:    { families: 30, bargainers: 22, seniors: 16, trendsetters: 10, professionals: 12, outdoorsy: 10 },
    village: { outdoorsy: 28, seniors: 28, families: 20, bargainers: 14, trendsetters: 4, professionals: 6 },
  }[type];
  const mix = {};
  let total = 0;
  for (const k of Object.keys(base)) {
    const v = Math.max(1, base[k] * rng.range(0.55, 1.55));
    mix[k] = v; total += v;
  }
  for (const k of Object.keys(mix)) mix[k] = mix[k] / total;
  return mix;
}

export function generateWorld(seed) {
  const rng = makeRng(seed);
  const elevNoise = makeNoise(rng);
  const moistNoise = makeNoise(rng);

  // ---------- terrain ----------
  const tiles = new Uint8Array(MAP_W * MAP_H);
  const elev = new Float32Array(MAP_W * MAP_H);
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      // island-ish falloff so edges tend to water
      const nx = x / MAP_W - 0.5, ny = y / MAP_H - 0.5;
      const d = Math.sqrt(nx * nx + ny * ny) * 2;
      let e = elevNoise(x * 0.09, y * 0.09, 4) - d * d * 0.55;
      const m = moistNoise(x * 0.13 + 40, y * 0.13 + 40, 3);
      elev[y * MAP_W + x] = e;
      let t;
      if (e < 0.18) t = T.WATER;
      else if (e < 0.22) t = T.SAND;
      else if (e > 0.62) t = T.MOUNTAIN;
      else if (e > 0.52) t = T.HILL;
      else t = m > 0.55 ? T.FOREST : T.GRASS;
      tiles[y * MAP_W + x] = t;
    }
  }

  // ---------- rivers: born in the highlands, flowing to the sea ----------
  // (they also give the road network something to bridge)
  const riverCount = 2 + (rng.chance(0.5) ? 1 : 0);
  for (let r = 0; r < riverCount; r++) {
    // source: a random high tile
    let sx = 0, sy = 0, best = -Infinity;
    for (let tries = 0; tries < 60; tries++) {
      const x = rng.int(8, MAP_W - 9), y = rng.int(8, MAP_H - 9);
      const e = elev[y * MAP_W + x];
      if (e > best) { best = e; sx = x; sy = y; }
    }
    // mouth: the nearest existing water tile
    let mx = -1, my = -1, md = Infinity;
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        if (tiles[y * MAP_W + x] !== T.WATER) continue;
        const d = Math.hypot(x - sx, y - sy);
        if (d < md) { md = d; mx = x; my = y; }
      }
    }
    if (mx < 0) continue;
    // rivers prefer valleys: cost rises steeply with elevation
    const jitter = rng.int(0, 1 << 30);
    const riverCost = (x, y) => {
      const t = tiles[y * MAP_W + x];
      if (t === T.WATER) return 0.2;
      const e = elev[y * MAP_W + x];
      const wobble = (((x * 73856093) ^ (y * 19349663) ^ jitter) >>> 16 & 15) / 30;
      return 0.5 + e * e * 8 + wobble;
    };
    const path = dijkstra(tiles, { x: sx, y: sy }, { x: mx, y: my }, riverCost);
    if (!path) continue;
    for (const pt of path) {
      const i = pt.y * MAP_W + pt.x;
      if (tiles[i] === T.WATER) break; // joined the sea (or another river)
      tiles[i] = T.WATER;
      elev[i] = Math.min(elev[i], 0.17);
    }
  }

  // ---------- settlements ----------
  const settlements = [];
  const cityNames = rng.shuffle(CITY_NAMES);
  const townNames = rng.shuffle(TOWN_NAMES);
  const villNames = rng.shuffle(VILLAGE_NAMES);

  function isBuildable(x, y) {
    if (x < 3 || y < 3 || x >= MAP_W - 3 || y >= MAP_H - 3) return false;
    const t = tiles[y * MAP_W + x];
    return t === T.GRASS || t === T.FOREST || t === T.SAND;
  }
  function farFromOthers(x, y, minDist) {
    return settlements.every(s => Math.hypot(s.x - x, s.y - y) >= minDist);
  }
  function place(type, count, minDist, popLo, popHi, names) {
    let placed = 0, tries = 0;
    while (placed < count && tries < 4000) {
      tries++;
      const x = rng.int(4, MAP_W - 5), y = rng.int(4, MAP_H - 5);
      if (!isBuildable(x, y) || !farFromOthers(x, y, minDist)) continue;
      const pop = rng.int(popLo, popHi);
      settlements.push({
        id: `s${settlements.length}`,
        name: names[placed % names.length],
        type, x, y, pop,
        wealth: type === 'city' ? rng.range(0.95, 1.35) : type === 'town' ? rng.range(0.8, 1.1) : rng.range(0.6, 0.95),
        onlineAffinity: type === 'city' ? rng.range(0.65, 0.85) : type === 'town' ? rng.range(0.4, 0.6) : rng.range(0.18, 0.38),
        segments: segMix(rng, type),
        researched: false,
        awareness: 0,
        customers: 0,
        satisfaction: 0.72,
      });
      // clear terrain around settlement to grass
      const r = type === 'city' ? 2 : 1;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const tx = x + dx, ty = y + dy;
        if (tx >= 0 && ty >= 0 && tx < MAP_W && ty < MAP_H && tiles[ty * MAP_W + tx] !== T.WATER)
          tiles[ty * MAP_W + tx] = T.GRASS;
      }
      placed++;
    }
  }
  place('city', 3, 16, 90000, 220000, cityNames);
  place('town', 6, 9, 14000, 45000, townNames);
  place('village', 8, 6, 1500, 7000, villNames);

  // ---------- roads: a real network with bridges ----------
  // Cost-based pathfinding: reusing an existing road is nearly free, so links
  // merge into trunk roads. Water is expensive but crossable → bridges appear
  // where a crossing genuinely saves distance.
  const roads = []; // list of {x,y} tile paths for rendering
  const roadCost = (x, y) => {
    const t = tiles[y * MAP_W + x];
    if (t === T.ROAD || t === T.BRIDGE) return 0.3;
    if (t === T.WATER) return 6.5;
    if (t === T.MOUNTAIN) return 70;
    if (t === T.HILL) return 3.5;
    if (t === T.FOREST) return 1.9;
    return 1;
  };
  function carve(from, to) {
    const path = dijkstra(tiles, from, to, roadCost);
    if (!path) return;
    for (const pt of path) {
      const i = pt.y * MAP_W + pt.x;
      if (tiles[i] === T.WATER) tiles[i] = T.BRIDGE;
      else if (tiles[i] !== T.MOUNTAIN && tiles[i] !== T.BRIDGE) tiles[i] = T.ROAD;
    }
    roads.push(path);
  }
  const order = { city: 0, town: 1, village: 2 };
  const nearestOf = (s, pool) => {
    let best = null, bd = Infinity;
    for (const o of pool) {
      if (o === s) continue;
      const d = Math.hypot(o.x - s.x, o.y - s.y);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  };
  // every settlement links to its nearest same-or-larger neighbour…
  for (const s of settlements) {
    const pool = settlements.filter(o => o !== s && (order[o.type] < order[s.type] || (o.type === s.type && o.id < s.id)));
    const best = nearestOf(s, pool);
    if (best) carve(s, best);
  }
  // …and cities link to each other so the trunk network connects
  const cities = settlements.filter(s => s.type === 'city');
  for (let i = 1; i < cities.length; i++) {
    const best = nearestOf(cities[i], cities.slice(0, i));
    if (best) carve(cities[i], best);
  }

  // ---------- port: a harbour on the open-sea coast near the biggest city ----------
  // flood-fill the sea from the map edge so we never dock on an inland lake
  const sea = new Uint8Array(MAP_W * MAP_H);
  {
    const q = [];
    for (let x = 0; x < MAP_W; x++) for (const y of [0, MAP_H - 1]) if (tiles[y * MAP_W + x] === T.WATER) { sea[y * MAP_W + x] = 1; q.push(y * MAP_W + x); }
    for (let y = 0; y < MAP_H; y++) for (const x of [0, MAP_W - 1]) if (tiles[y * MAP_W + x] === T.WATER && !sea[y * MAP_W + x]) { sea[y * MAP_W + x] = 1; q.push(y * MAP_W + x); }
    let qi = 0;
    while (qi < q.length) {
      const cur = q[qi++], cx = cur % MAP_W, cy = (cur / MAP_W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
        const ni = ny * MAP_W + nx;
        if (!sea[ni] && tiles[ni] === T.WATER) { sea[ni] = 1; q.push(ni); }
      }
    }
  }
  const big = [...cities].sort((a, b) => b.pop - a.pop)[0] || settlements[0];
  let port = null, pd = Infinity;
  for (let y = 2; y < MAP_H - 2; y++) {
    for (let x = 2; x < MAP_W - 2; x++) {
      const t = tiles[y * MAP_W + x];
      if (t === T.WATER || t === T.MOUNTAIN || t === T.HILL) continue;
      if (![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => sea[(y + dy) * MAP_W + x + dx])) continue;
      const d = Math.hypot(x - big.x, y - big.y);
      if (d < pd) { pd = d; port = { x, y }; }
    }
  }
  let seaLane = [];
  if (port) {
    carve(port, big);
    seaLane = findSeaLane(tiles, port);
  }

  return { seed, tiles, elev, settlements, roads, port, seaLane, w: MAP_W, h: MAP_H };
}

// Dijkstra over the tile grid with a binary heap. Returns [{x,y}...] or null.
function dijkstra(tiles, from, to, costOf) {
  const w = MAP_W, h = MAP_H;
  const N = w * h;
  const dist = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const start = from.y * w + from.x, goal = to.y * w + to.x;
  dist[start] = 0;
  const hp = [start], hd = [0]; // parallel heap arrays (index, priority)
  const swap = (a, b) => { [hp[a], hp[b]] = [hp[b], hp[a]]; [hd[a], hd[b]] = [hd[b], hd[a]]; };
  const push = (i, d) => {
    hp.push(i); hd.push(d);
    let c = hp.length - 1;
    while (c > 0) { const p = (c - 1) >> 1; if (hd[p] <= hd[c]) break; swap(p, c); c = p; }
  };
  const pop = () => {
    const top = hp[0], td = hd[0];
    const li = hp.pop(), ld = hd.pop();
    if (hp.length) {
      hp[0] = li; hd[0] = ld;
      let c = 0;
      for (;;) {
        let m = c; const l = c * 2 + 1, r = l + 1;
        if (l < hp.length && hd[l] < hd[m]) m = l;
        if (r < hp.length && hd[r] < hd[m]) m = r;
        if (m === c) break; swap(m, c); c = m;
      }
    }
    return [top, td];
  };
  while (hp.length) {
    const [cur, d] = pop();
    if (cur === goal) break;
    if (d > dist[cur]) continue;
    const cx = cur % w, cy = (cur / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 1 || ny < 1 || nx >= w - 1 || ny >= h - 1) continue;
      const nd = d + costOf(nx, ny);
      const ni = ny * w + nx;
      if (nd < dist[ni]) { dist[ni] = nd; prev[ni] = cur; push(ni, nd); }
    }
  }
  if (dist[goal] === Infinity) return null;
  const path = [];
  let cur = goal;
  while (cur !== -1) { path.push({ x: cur % w, y: (cur / w) | 0 }); cur = prev[cur]; }
  return path.reverse();
}

// BFS through open water from the map edge to the tile beside the port —
// the shipping lane freighters follow.
function findSeaLane(tiles, port) {
  const w = MAP_W, h = MAP_H;
  let portWater = null;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (tiles[(port.y + dy) * w + port.x + dx] === T.WATER) { portWater = { x: port.x + dx, y: port.y + dy }; break; }
  }
  if (!portWater) return [];
  const prev = new Int32Array(w * h).fill(-2); // -2 unvisited, -1 source
  const q = [];
  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) if (tiles[y * w + x] === T.WATER && prev[y * w + x] === -2) { prev[y * w + x] = -1; q.push(y * w + x); }
  }
  for (let y = 0; y < h; y++) {
    for (const x of [0, w - 1]) if (tiles[y * w + x] === T.WATER && prev[y * w + x] === -2) { prev[y * w + x] = -1; q.push(y * w + x); }
  }
  const goal = portWater.y * w + portWater.x;
  let qi = 0, found = prev[goal] !== -2;
  while (qi < q.length && !found) {
    const cur = q[qi++];
    const cx = cur % w, cy = (cur / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (prev[ni] !== -2 || tiles[ni] !== T.WATER) continue;
      prev[ni] = cur;
      if (ni === goal) { found = true; break; }
      q.push(ni);
    }
  }
  if (!found) return [portWater];
  const path = [];
  let cur = goal;
  while (cur >= 0) { path.push({ x: cur % w, y: (cur / w) | 0 }); cur = prev[cur]; }
  return path.reverse(); // edge → port
}

// ---------------- settlement tiers (SIM2: living towns) ----------------
// Pop thresholds for tier classification. Sim applies hysteresis around these
// so towns don't flap between tiers.
export const TIER_THRESHOLDS = { town: 9000, city: 70000 };

// tierOf(s) — accepts a settlement or a raw pop number, returns 'village'|'town'|'city'
export function tierOf(s) {
  const pop = typeof s === 'number' ? s : s.pop;
  if (pop >= TIER_THRESHOLDS.city) return 'city';
  if (pop >= TIER_THRESHOLDS.town) return 'town';
  return 'village';
}

export function settlementAt(world, tx, ty, radius = 1.6) {
  let best = null, bd = radius + 0.001;
  for (const s of world.settlements) {
    const d = Math.hypot(s.x - tx, s.y - ty);
    const r = s.type === 'city' ? 2.6 : s.type === 'town' ? 1.9 : 1.4;
    if (d <= r && d < bd) { bd = d; best = s; }
  }
  return best;
}

export function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

// ---------------- road routing (for delivery trucks) ----------------
// BFS over road tiles; settlements count as road-connected. Falls back to a
// straight line if no road route exists. Results cached per world instance.
const routeCache = new WeakMap();

export function findRoute(world, from, to) {
  let cache = routeCache.get(world);
  if (!cache) { cache = new Map(); routeCache.set(world, cache); }
  const key = `${from.x},${from.y}-${to.x},${to.y}`;
  if (cache.has(key)) return cache.get(key);

  const { w, h, tiles } = world;
  const passable = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const t = tiles[y * w + x];
    return t === T.ROAD || t === T.BRIDGE || t === T.GRASS || t === T.SAND; // grass allowed at cost
  };
  const isRoad = (x, y) => { const t = tiles[y * w + x]; return t === T.ROAD || t === T.BRIDGE; };

  // Dijkstra-lite: road cost 1, off-road cost 12 → vehicles stay on roads,
  // cutting across grass only for the last few tiles to the door
  const start = from.y * w + from.x, goal = to.y * w + to.x;
  const dist = new Float32Array(w * h).fill(Infinity);
  const prev = new Int32Array(w * h).fill(-1);
  dist[start] = 0;
  const open = [[0, start]];
  let found = false;
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
    const [d, cur] = open.splice(bi, 1)[0];
    if (cur === goal) { found = true; break; }
    if (d > dist[cur]) continue;
    const cx = cur % w, cy = (cur / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (!passable(nx, ny) && !(nx === to.x && ny === to.y)) continue;
      const cost = isRoad(nx, ny) ? 1 : 12;
      const ni = ny * w + nx, nd = d + cost;
      if (nd < dist[ni]) { dist[ni] = nd; prev[ni] = cur; open.push([nd, ni]); }
    }
    if (open.length > 2600) break; // safety valve
  }

  let path;
  if (found) {
    path = [];
    let cur = goal;
    while (cur !== -1) { path.push({ x: cur % w, y: (cur / w) | 0 }); cur = prev[cur]; }
    path.reverse();
    // thin out long paths for animation smoothness
    if (path.length > 60) path = path.filter((_, i) => i % 2 === 0 || i === path.length - 1);
  } else {
    path = [{ x: from.x, y: from.y }, { x: to.x, y: to.y }];
  }
  cache.set(key, path);
  return path;
}
