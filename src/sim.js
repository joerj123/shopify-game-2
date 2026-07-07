// ============================================================
// SHOPIFY TYCOON — simulation engine (SIM2)
// One tick = one in-game day. 12 months × 28 days per year.
//
// SIM2 changes (see docs/SIM2_DESIGN.md for the full spec):
//  - legible, dangerous competition: rival agents w/ postures, price wars,
//    a late-game disruptor ("Primely"), poaching, complacency decay
//  - physical stores hold physical stock (daily allocation + wholesale flow)
//  - executive pawns you station around the map (state.execs / execTravels)
//  - living towns: pop drifts with the local economy, tiers change
//  - goal ladder to $1B: IPO at $1M is a milestone, not the win
//  - save v4 + migrateSave() for v3 saves
//
// This module MUST stay headless-runnable in plain Node (no DOM imports).
// ============================================================
import { generateWorld, SEGMENTS, distance, findRoute, tierOf, TIER_THRESHOLDS } from './world.js';
import { CATALOG, CATEGORIES } from './data/catalog.js';
import { makeRng } from './rng.js';

export { tierOf, TIER_THRESHOLDS };

// FNV-1a — kept byte-identical to sprites.js's hashCode (product ids depend on
// it). Inlined here so sim.js has zero non-headless imports.
function hashCode(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export const DAYS_PER_MONTH = 28;
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const EXPECTED_DELIVERY_DAYS = 4; // baseline; state.expectedDeliveryDays is live value

export const WAGES = { shipping: 22, support: 26, engineer: 55 }; // per day, before scale inflation
export const STAFF_INFO = {
  shipping: { name: 'Warehouse Crew', wage: WAGES.shipping, desc: '+30 packages/day shipping capacity each.' },
  support: { name: 'Support Agents', wage: WAGES.support, desc: 'Each handles ~50 tickets/day. Coverage lifts satisfaction.' },
  engineer: { name: 'R&D Engineers', wage: WAGES.engineer, desc: 'Each speeds product development by 45%.' },
};

export const CHANNELS = {
  social: {
    name: 'Social Ads', max: 800, half: 180,
    desc: 'Reaches cities & towns. Great for online awareness among younger segments.',
    profile: { city: 1.25, town: 0.85, village: 0.3 },
  },
  search: {
    name: 'Search Ads', max: 600, half: 140,
    desc: 'Captures buyers already looking. Boosts online conversion directly.',
    profile: { city: 1.0, town: 1.0, village: 1.0 },
  },
  tv: {
    name: 'TV Spots', max: 2000, half: 700,
    desc: 'Expensive, but reaches everyone — even remote villages. Builds broad awareness.',
    profile: { city: 0.9, town: 1.0, village: 1.15 },
  },
  flyers: {
    name: 'Local Flyers', max: 300, half: 60,
    desc: 'Cheap. Only works around your physical stores — drives foot traffic.',
    profile: { city: 1, town: 1, village: 1 },
  },
};

const FIRSTWORDS = ['Nimbus', 'Ember', 'Cedar', 'Atlas', 'Juniper', 'Comet', 'Harbor', 'Fable', 'Summit', 'Willow', 'Pixel', 'Meadow', 'Quartz', 'Drift'];
const CATWORDS = {
  apparel: ['Thread', 'Wear', 'Cloth', 'Stitch'], gadgets: ['Gizmo', 'Circuit', 'Spark', 'Widget'],
  home: ['Nest', 'Hearth', 'Room', 'Haven'], outdoor: ['Trail', 'Peak', 'Camp', 'Ridge'],
  beauty: ['Glow', 'Bloom', 'Velvet', 'Aura'], toys: ['Play', 'Wonder', 'Whimsy', 'Joy'],
  food: ['Harvest', 'Pantry', 'Batch', 'Crumb'], fitness: ['Motion', 'Pulse', 'Core', 'Stride'],
};

// ---------------- rivals ----------------
export const RIVALS = [
  { id: 'bumblebuy', name: 'BumbleBuy', color: '#ffb545', style: 'discount', blurb: 'big-box discounter' },
  { id: 'verdant', name: 'Verdant & Co', color: '#c792ea', style: 'premium', blurb: 'upmarket boutique chain' },
  { id: 'primely', name: 'Primely', color: '#5ac8e0', style: 'disruptor', blurb: 'same-day-everything megacorp', disruptor: true },
];

// Revenue thresholds for the disruptor arc
export const PRIMELY_ENTRY_REVENUE = 2500000;   // Primely enters the island
export const PRIMELY_PRIME_REVENUE = 30000000;  // Primely launches "Primely Now" (2-day expectations)

function initRivalPresenceBy(world, seed) {
  const rng = makeRng(seed ^ 0x51ab);
  const by = { bumblebuy: {}, verdant: {}, primely: {} };
  for (const s of world.settlements) {
    const base = s.type === 'city' ? 1.0 : s.type === 'town' ? 0.55 : 0.2;
    const total = Math.round(base * rng.range(0.7, 1.3) * 100) / 100;
    // BumbleBuy skews rural/discount; Verdant skews urban/premium
    const bumbleShare = s.type === 'city' ? 0.42 : s.type === 'town' ? 0.58 : 0.72;
    by.bumblebuy[s.id] = round2(total * bumbleShare);
    by.verdant[s.id] = round2(total * (1 - bumbleShare));
    by.primely[s.id] = 0;
  }
  return by;
}

function newRivalAgents() {
  return RIVALS.map(r => ({
    id: r.id,
    active: !r.disruptor,           // Primely enters mid-game
    posture: 'expand',              // 'expand' | 'defend' | 'price-war' | 'blitz'
    focusSids: [],                  // its top markets (for UI)
    lastMove: null,                 // {day, desc} — last weekly move, for UI
  }));
}

export function newGame(seed = (Date.now() & 0x7fffffff)) {
  const world = generateWorld(seed);
  const rivalPresenceBy = initRivalPresenceBy(world, seed);
  const state = {
    v: 4, seed,
    companyName: 'My Company',
    day: 2 * DAYS_PER_MONTH, // start March 1st (spring), year 1
    year: 1,
    cash: 25000,
    debtWarned: false,
    gameOver: false,
    won: false, wonDay: null,
    world,
    hq: null,                    // settlement id
    premises: [],                // {id, sid, kind:'office'|'warehouse'|'store', level, construction?, stock?, ...}
    onlineStore: null,           // {level, listed:[productId]} once launched
    products: [],                // player's portfolio (see addCatalogProduct / R&D)
    rnd: null,                   // active R&D project
    ownCount: 0,
    staff: { shipping: 0, support: 0, engineer: 0 },
    marketing: { social: 0, search: 0, tv: 0, flyers: 0 },
    rivalPresenceBy,             // rivalId → sid → presence
    rivalPresence: {},           // sid → aggregate pressure (renderer contract)
    rivals: newRivalAgents(),    // agent state per rival
    priceWars: [],               // {sid, rival, daysLeft, discount}
    competition: {},             // sid → {pressure, topRival, yourShare, rivalShare, priceWar, trend}
    compSnapshots: {},           // sid → pressure ~28d ago (for trend)
    rivalPromo: null,            // {sid, daysLeft, rival}
    execs: [{ id: 'exec-ceo', role: 'ceo', name: 'You', sid: null }],
    execTravels: [],             // {execId, role, name, fromSid, sid, path, daysLeft, totalDays}
    passiveSurvey: {},           // sid → progress 0..1 (Head of Research)
    expectedDeliveryDays: EXPECTED_DELIVERY_DAYS,
    franchising: false,          // post-IPO: stores self-replicate for a fee share
    automation: 0,               // 0..3 warehouse robot tiers (COO-gated)
    brandTier: 0,                // 0..3 premium brand tiers (price power)
    exportContract: null,        // {level, nextShipDay} once signed
    acquiredRival: null,         // rival id after the $10M acquisition
    debtInterestPaid: 0,
    mktAttrib: { social: { spend: [], cust: [] }, search: { spend: [], cust: [] }, tv: { spend: [], cust: [] }, flyers: { spend: [], cust: [] } },
    flashSale: { daysLeft: 0, cooldownUntil: 0 },
    questsDone: [],
    queue: 0,                    // packages waiting to ship
    onTime: 0.95,                // rolling on-time delivery rate
    activeEvents: [],            // {key,name,daysLeft,...effects}
    news: [],
    shipAnims: [],               // renderer consumes {path,t,dur,kind}
    boatAnims: [],               // freighters on the sea lane
    surveys: [],                 // researchers walking to settlements {sid,path,daysLeft,totalDays}
    fxAnims: [],                 // one-shot map effects
    history: [],                 // per-day metrics rows (rolling 336)
    goalsDone: [],
    lifetime: { revenue: 0, orders: 0, customers: 0, mkt: 0 },
    // 7-day rolling accumulators for CAC etc.
    roll: { mkt: [], newCust: [], revenue: [], orders: [] },
    tutorialStep: 0,
    rngState: seed ^ 0x9e3779b9,
  };
  syncRivalPresence(state);
  return state;
}

// ---------------- save migration (v3 → v4) ----------------
// main.js must call migrateSave(state) after loading ANY save; it upgrades a
// v3 save in place and is a no-op on v4 saves.
export function migrateSave(state) {
  if (!state || state.v >= 4) return state;
  state.v = 4;
  state.won = false; state.wonDay = null;
  // rivals → agents + per-rival presence split
  state.rivals = newRivalAgents();
  const old = state.rivalPresence || {};
  state.rivalPresenceBy = { bumblebuy: {}, verdant: {}, primely: {} };
  for (const s of state.world.settlements) {
    const total = old[s.id] ?? 0.5;
    const bumbleShare = s.type === 'city' ? 0.42 : s.type === 'town' ? 0.58 : 0.72;
    state.rivalPresenceBy.bumblebuy[s.id] = round2(total * bumbleShare);
    state.rivalPresenceBy.verdant[s.id] = round2(total * (1 - bumbleShare));
    state.rivalPresenceBy.primely[s.id] = 0;
    s.grewTick = s.grewTick ?? null;
    s.shrunkTick = s.shrunkTick ?? null;
  }
  state.priceWars = [];
  state.competition = {};
  state.compSnapshots = {};
  // execs
  state.execs = [{ id: 'exec-ceo', role: 'ceo', name: 'You', sid: state.hq }];
  state.execTravels = [];
  state.passiveSurvey = {};
  // logistics / late-game systems
  state.expectedDeliveryDays = EXPECTED_DELIVERY_DAYS;
  state.franchising = false;
  state.automation = 0;
  state.brandTier = 0;
  state.exportContract = null;
  state.acquiredRival = null;
  state.debtInterestPaid = 0;
  // physical goods: stores gain stock; catalog products gain inventory fields
  for (const pr of state.premises) {
    if (pr.kind === 'store') {
      pr.stock = pr.stock || {};
      pr.recent = pr.recent || {};
      pr.autoReplenish = pr.autoReplenish ?? true;
      pr.serviceLevel = pr.serviceLevel ?? 1;
      pr.missedToday = 0;
      pr.franchise = pr.franchise || false;
    }
  }
  for (const p of state.products) {
    if (p.source === 'catalog') {
      p.inventory = p.inventory ?? 0;
      if (p.inventory === null) p.inventory = 0;
      p.incoming = p.incoming || [];
      p.autoRestock = p.autoRestock || false;
      p.missedToday = 0;
      p.wholesaleCost = p.wholesaleCost ?? round2((p.cost / 1.62) * 1.15);
    }
  }
  syncRivalPresence(state);
  pushNews(state, 'The market has changed. Rivals are organised, stores need stock, and $1M is just the beginning.');
  return state;
}

function stateRng(state) {
  // deterministic-ish per call chain; fine for gameplay flavour
  state.rngState = (state.rngState * 1664525 + 1013904223) >>> 0;
  return makeRng(state.rngState);
}

// ---------------- calendar ----------------
export function calInfo(state) {
  const dayOfYear = state.day % (12 * DAYS_PER_MONTH);
  const month = Math.floor(dayOfYear / DAYS_PER_MONTH) + 1; // 1..12
  const dom = (dayOfYear % DAYS_PER_MONTH) + 1;             // 1..28
  const year = Math.floor(state.day / (12 * DAYS_PER_MONTH)) + 1;
  let season;
  if (month >= 3 && month <= 5) season = 'spring';
  else if (month >= 6 && month <= 8) season = 'summer';
  else if (month >= 9 && month <= 11) season = 'autumn';
  else season = 'winter';
  return { month, dom, year, season, dayOfYear };
}

// ---------------- scale economics (diseconomies) ----------------
// Rents and wages inflate as you scale — landlords and labour markets notice
// a giant. ~×1.05 at $1M lifetime revenue, ~×1.42 at $100M, ~×1.6 at $1B.
export function costScale(state) {
  return 1 + 0.18 * Math.log10(Math.max(1, state.lifetime.revenue / 5e5));
}

// ---------------- products ----------------
export function catalogAvailable(state) {
  const ownedIds = new Set(state.products.map(p => p.baseId));
  return CATALOG.filter(c => !ownedIds.has(c.id));
}

export function addCatalogProduct(state, baseId) {
  const base = CATALOG.find(c => c.id === baseId);
  if (!base) return { ok: false, msg: 'Unknown product' };
  const fee = 500;
  if (state.cash < fee) return { ok: false, msg: 'Not enough cash ($500 listing fee)' };
  state.cash -= fee;
  const slotFree = state.products.filter(p => p.listed).length < listingCap(state);
  state.products.push({
    id: `p${state.products.length}-${base.id}`,
    baseId: base.id,
    name: base.name, cat: base.cat,
    style: base.style, quality: base.quality, utility: base.utility, eco: base.eco, tech: base.tech,
    season: base.season, sports: !!base.sports,
    source: 'catalog',
    cost: Math.round(base.cost * 1.62 * 100) / 100, // dropship convenience isn't free
    wholesaleCost: round2(base.cost * 1.15),        // case price for store stock
    price: base.msrp,
    msrp: base.msrp,
    listed: slotFree,
    inventory: 0,   // wholesale units in the warehouse (stores draw from this)
    incoming: [],   // {qty, phase, daysLeft}
    autoRestock: false,
    missedToday: 0,
    soldTotal: 0,
  });
  pushNews(state, slotFree
    ? `Sourced <b>${base.name}</b> from the Shopify catalog.`
    : `Sourced <b>${base.name}</b> — product slots are full, so it's sitting unlisted.`);
  return { ok: true };
}

export const RND_TIERS = {
  budget:   { name: 'Budget',   cost: 3500,  days: 28, quality: [0.35, 0.55], costRatio: 0.24 },
  standard: { name: 'Standard', cost: 9000,  days: 48, quality: [0.55, 0.75], costRatio: 0.26 },
  premium:  { name: 'Premium',  cost: 20000, days: 76, quality: [0.75, 0.97], costRatio: 0.28 },
};

function rndSpeed(state) {
  let sp = 1 + state.staff.engineer * 0.45;
  const hr = stationedExec(state, 'research');
  if (hr && hr.sid === state.hq) sp *= 1.6; // Head of Research at HQ
  return sp;
}

export function startRnd(state, cat, tier, focus) {
  if (state.rnd) return { ok: false, msg: 'R&D team is already on a project' };
  const t = RND_TIERS[tier];
  if (!t) return { ok: false, msg: 'Pick a tier' };
  if (state.cash < t.cost) return { ok: false, msg: `Need $${t.cost.toLocaleString()}` };
  state.cash -= t.cost;
  const eta = Math.max(6, Math.round(t.days / rndSpeed(state)));
  state.rnd = { cat, tier, focus, daysLeft: t.days, totalDays: t.days };
  pushNews(state, `R&D kicked off: a ${t.name.toLowerCase()} ${CATEGORIES[cat].name.toLowerCase()} product. ETA ${eta} days.`);
  return { ok: true };
}

function finishRnd(state) {
  const { cat, tier, focus } = state.rnd;
  const t = RND_TIERS[tier];
  const rng = stateRng(state);
  const q = rng.range(t.quality[0], t.quality[1]);
  // focus: 0 = utility-driven, 1 = style-driven
  const style = Math.min(1, rng.range(0.2, 0.5) + focus * 0.5 + q * 0.15);
  const utility = Math.min(1, rng.range(0.2, 0.5) + (1 - focus) * 0.5 + q * 0.1);
  const name = `${rng.pick(FIRSTWORDS)} ${rng.pick(CATWORDS[cat])}`;
  const msrp = Math.round((8 + q * 60 + style * 14) * rng.range(0.9, 1.15));
  const p = {
    id: `own${state.ownCount++}-${hashCode(name)}`,
    baseId: null,
    name, cat,
    style: round2(style), quality: round2(q), utility: round2(utility),
    eco: round2(rng.range(0.2, 0.8)), tech: round2(cat === 'gadgets' ? rng.range(0.6, 0.95) : rng.range(0, 0.4)),
    season: null, sports: cat === 'fitness' && rng.chance(0.5),
    source: 'own',
    cost: Math.max(2, Math.round(msrp * t.costRatio)),
    price: msrp, msrp,
    listed: false,
    inventory: 0,
    incoming: [], // {qty, daysLeft}
    autoRestock: false,
    missedToday: 0,
    soldTotal: 0,
  };
  state.products.push(p);
  state.rnd = null;
  pushNews(state, `R&D complete! <b>${name}</b> is ready. Order stock and list it.`);
  return p;
}

// Own stock arrives by sea: a freighter sails to the port, then a lorry
// drives the container to your nearest warehouse/office.
export function fulfillmentNodes(state) {
  return state.premises
    .filter(p => (p.kind === 'office' || p.kind === 'warehouse') && !(p.construction && p.construction.isNew))
    .map(p => state.world.settlements.find(s => s.id === p.sid));
}

function landLegDays(state) {
  const port = state.world.port;
  if (!port) return 1;
  const nodes = fulfillmentNodes(state);
  let d = Infinity;
  for (const n of nodes) d = Math.min(d, distance(port, n));
  if (!isFinite(d)) return 2;
  return Math.max(1, Math.round(1 + d / 12));
}

export function orderStock(state, productId, qty) {
  const p = state.products.find(x => x.id === productId);
  if (!p || p.source !== 'own') return { ok: false, msg: 'Not an own product' };
  // bulk discount up to 20%
  const disc = qty >= 500 ? 0.8 : qty >= 200 ? 0.88 : qty >= 100 ? 0.94 : 1;
  const total = Math.round(p.cost * disc * qty);
  if (state.cash < total) return { ok: false, msg: `Need $${total.toLocaleString()}` };
  state.cash -= total;
  const crunch = state.activeEvents.find(e => e.key === 'supplycrunch');
  const seaDays = crunch ? 6 : 3;
  p.incoming.push({ qty, phase: 'sea', daysLeft: seaDays });
  if (state.boatAnims.length < 4) state.boatAnims.push({ t: 0, dur: 10 + seaDays * 2, qty });
  return { ok: true, total };
}

// SIM2: wholesale flow for catalog products — buy cases up front at a much
// better unit price than dropship. This inventory is what physical stores
// sell (dropship serves ONLINE only).
export function orderWholesale(state, productId, qty) {
  const p = state.products.find(x => x.id === productId);
  if (!p || p.source !== 'catalog') return { ok: false, msg: 'Wholesale is for catalog products' };
  if (qty < 20) return { ok: false, msg: 'Minimum wholesale order: 20 units' };
  const disc = qty >= 500 ? 0.85 : qty >= 200 ? 0.92 : 1;
  const total = Math.round(p.wholesaleCost * disc * qty);
  if (state.cash < total) return { ok: false, msg: `Need $${total.toLocaleString()}` };
  state.cash -= total;
  const crunch = state.activeEvents.find(e => e.key === 'supplycrunch');
  const seaDays = crunch ? 6 : 3;
  p.incoming.push({ qty, phase: 'sea', daysLeft: seaDays });
  if (state.boatAnims.length < 4) state.boatAnims.push({ t: 0, dur: 10 + seaDays * 2, qty });
  pushNews(state, `Wholesale order: ${qty} × <b>${p.name}</b> (${fmtMoney(total)}) — cases inbound by sea.`);
  return { ok: true, total };
}

// ---------------- premises / stores ----------------
export const PREMISE_COSTS = {
  office:   { city: { setup: 0, rent: 95, days: 0 },  town: { setup: 0, rent: 45, days: 0 },  village: { setup: 0, rent: 20, days: 0 } },
  store:    { city: { setup: 14000, rent: 95, days: 16 }, town: { setup: 6500, rent: 42, days: 11 }, village: { setup: 2600, rent: 16, days: 7 } },
  warehouse:{ city: { setup: 11000, rent: 60, days: 15 }, town: { setup: 8000, rent: 38, days: 12 }, village: { setup: 6000, rent: 22, days: 9 } },
};
export const OFFICE_LEVELS = [
  { name: 'Garage Office', shipCap: 40, staffCap: 6, upgradeCost: 0, buildDays: 0 },
  { name: 'Loft Office', shipCap: 110, staffCap: 14, upgradeCost: 9000, buildDays: 12 },
  { name: 'HQ Tower', shipCap: 260, staffCap: 30, upgradeCost: 26000, buildDays: 22 },
];

export function chooseHq(state, sid) {
  const s = state.world.settlements.find(x => x.id === sid);
  if (!s || state.hq) return { ok: false };
  state.hq = sid;
  state.premises.push({ id: 'prem-hq', sid, kind: 'office', level: 0 });
  s.awareness = Math.max(s.awareness, 0.15); // hometown knows you
  const ceo = state.execs.find(e => e.role === 'ceo');
  if (ceo) ceo.sid = sid; // the CEO starts at HQ
  pushNews(state, `<b>${state.companyName}</b> opens its headquarters in ${s.name}!`);
  return { ok: true };
}

export function upgradeOffice(state) {
  const office = state.premises.find(p => p.kind === 'office');
  if (office.construction) return { ok: false, msg: 'Builders are already on site' };
  const next = OFFICE_LEVELS[office.level + 1];
  if (!next) return { ok: false, msg: 'Office is maxed out' };
  if (state.cash < next.upgradeCost) return { ok: false, msg: `Need $${next.upgradeCost.toLocaleString()}` };
  state.cash -= next.upgradeCost;
  office.construction = { daysLeft: next.buildDays, totalDays: next.buildDays, toLevel: office.level + 1 };
  pushNews(state, `Construction begins on the <b>${next.name}</b> — ready in ${next.buildDays} days.`);
  return { ok: true };
}

export function launchOnlineStore(state) {
  if (state.onlineStore) return { ok: false };
  const cost = 800;
  if (state.cash < cost) return { ok: false, msg: 'Need $800' };
  state.cash -= cost;
  state.onlineStore = { level: 1 };
  pushNews(state, `<b>${state.companyName}.shop</b> is live on the online store channel!`);
  return { ok: true };
}

export const STORE_LEVELS = [
  { name: 'Pop-up', capture: 1, shelf: 3 },
  { name: 'Storefront', capture: 1.8, shelf: 6, upgradeCost: 7000, buildDays: 8 },
  { name: 'Flagship', capture: 3.1, shelf: 10, upgradeCost: 18000, buildDays: 14 },
];

export function openStore(state, sid) {
  const s = state.world.settlements.find(x => x.id === sid);
  if (!s) return { ok: false };
  if (state.premises.some(p => p.kind === 'store' && p.sid === sid)) return { ok: false, msg: 'Already have a store here' };
  const c = PREMISE_COSTS.store[s.type];
  if (state.cash < c.setup) return { ok: false, msg: `Need $${c.setup.toLocaleString()}` };
  state.cash -= c.setup;
  state.premises.push({
    id: `prem-${state.premises.length}`, sid, kind: 'store', level: 0,
    construction: { daysLeft: c.days, totalDays: c.days, isNew: true },
    stock: {}, recent: {}, autoReplenish: true, serviceLevel: 1, missedToday: 0, franchise: false,
  });
  pushNews(state, `Ground broken on a ${s.type} store in <b>${s.name}</b> — opening in ${c.days} days.`);
  return { ok: true };
}

export function upgradeStore(state, premId) {
  const prem = state.premises.find(p => p.id === premId);
  if (prem.construction) return { ok: false, msg: 'Builders are already on site' };
  const next = STORE_LEVELS[prem.level + 1];
  if (!next) return { ok: false, msg: 'Store is maxed' };
  // SIM2: Flagship refits outside your HQ settlement need a Retail Director
  if (prem.level + 1 >= 2 && prem.sid !== state.hq && !state.execs.some(e => e.role === 'retail')) {
    return { ok: false, msg: 'Hire a Retail Director to run Flagship refits beyond HQ' };
  }
  if (state.cash < next.upgradeCost) return { ok: false, msg: `Need $${next.upgradeCost.toLocaleString()}` };
  state.cash -= next.upgradeCost;
  prem.construction = { daysLeft: next.buildDays, totalDays: next.buildDays, toLevel: prem.level + 1 };
  const s = state.world.settlements.find(x => x.id === prem.sid);
  pushNews(state, `The ${s.name} store is being refit into a <b>${next.name}</b> — ${next.buildDays} days (it trades meanwhile).`);
  return { ok: true };
}

export function buildWarehouse(state, sid) {
  const s = state.world.settlements.find(x => x.id === sid);
  if (!s) return { ok: false };
  if (state.premises.some(p => (p.kind === 'warehouse' || p.kind === 'office') && p.sid === sid))
    return { ok: false, msg: 'Already fulfilling from here' };
  const c = PREMISE_COSTS.warehouse[s.type];
  if (state.cash < c.setup) return { ok: false, msg: `Need $${c.setup.toLocaleString()}` };
  state.cash -= c.setup;
  state.premises.push({
    id: `prem-${state.premises.length}`, sid, kind: 'warehouse', level: 0,
    construction: { daysLeft: c.days, totalDays: c.days, isNew: true },
  });
  pushNews(state, `Warehouse under construction in <b>${s.name}</b> — operational in ${c.days} days.`);
  return { ok: true };
}

// A premise is out of action while its first build is underway (upgrades keep trading)
export function premiseActive(pr) { return !(pr.construction && pr.construction.isNew); }

export function staffCap(state) {
  const office = state.premises.find(p => p.kind === 'office');
  if (!office) return 0;
  let cap = OFFICE_LEVELS[office.level].staffCap;
  cap += state.premises.filter(p => p.kind === 'warehouse' && premiseActive(p)).length * 6;
  return cap;
}

// ---------------- product listing slots ----------------
export function listingCap(state) {
  return state.onlineStore ? [0, 6, 10, 14][state.onlineStore.level] : 4;
}

export function toggleListing(state, productId) {
  const p = state.products.find(x => x.id === productId);
  if (!p) return { ok: false };
  if (p.listed) { p.listed = false; return { ok: true }; }
  const listed = state.products.filter(x => x.listed).length;
  const cap = listingCap(state);
  if (listed >= cap) return { ok: false, msg: `All ${cap} product slots in use — unlist something or upgrade the online store` };
  p.listed = true;
  return { ok: true };
}
export function staffCount(state) { return state.staff.shipping + state.staff.support + state.staff.engineer; }

export function hire(state, role) {
  if (staffCount(state) >= staffCap(state)) return { ok: false, msg: 'Office is full — upgrade it or build a warehouse' };
  const signing = WAGES[role] * 10;
  if (state.cash < signing) return { ok: false, msg: `Need $${signing} signing cost` };
  state.cash -= signing;
  state.staff[role]++;
  return { ok: true };
}
export function fire(state, role) {
  if (state.staff[role] <= 0) return { ok: false };
  state.staff[role]--;
  return { ok: true };
}

// ---------------- executives (SIM2) ----------------
export const EXEC_ROLES = {
  ceo:      { name: 'CEO', salary: 0, hireCost: 0, desc: 'You. Awareness grows 50% faster and the store performs better wherever you are.' },
  cmo:      { name: 'CMO', salary: 260, hireCost: 8000, desc: 'Marketing channels work ~35% harder within ~15 tiles of their post.' },
  coo:      { name: 'COO', salary: 300, hireCost: 9000, desc: '+25% ship capacity, +60% store replenishment island-wide; extra store service where posted. Unlocks warehouse automation.' },
  research: { name: 'Head of Research', salary: 240, hireCost: 7500, desc: 'At HQ: R&D ×1.6. In the field: passively surveys settlements within ~12 tiles.' },
  retail:   { name: 'Retail Director', salary: 220, hireCost: 7000, desc: '+30% store conversion where posted; unlocks Flagship refits beyond HQ.' },
};

const EXEC_NAMES = { cmo: 'Mara Voss', coo: 'Odell Park', research: 'Dr. Lin Faraday', retail: 'Ruth Marlowe' };

export function hireExec(state, role) {
  const def = EXEC_ROLES[role];
  if (!def || role === 'ceo') return { ok: false, msg: 'Unknown role' };
  if (state.execs.some(e => e.role === role)) return { ok: false, msg: `You already have a ${def.name}` };
  if (state.cash < def.hireCost) return { ok: false, msg: `Need $${def.hireCost.toLocaleString()} signing package` };
  state.cash -= def.hireCost;
  state.execs.push({ id: `exec-${role}`, role, name: EXEC_NAMES[role] || def.name, sid: state.hq });
  pushNews(state, `<b>${EXEC_NAMES[role] || def.name}</b> joins as ${def.name}. First day: ${state.world.settlements.find(s => s.id === state.hq)?.name || 'HQ'}.`);
  return { ok: true };
}

export function fireExec(state, execId) {
  const i = state.execs.findIndex(e => e.id === execId);
  if (i < 0) return { ok: false };
  if (state.execs[i].role === 'ceo') return { ok: false, msg: "You can't fire yourself. Believe me, the board has tried." };
  const [ex] = state.execs.splice(i, 1);
  state.execTravels = state.execTravels.filter(t => t.execId !== ex.id);
  pushNews(state, `${ex.name} leaves the company. The corner office is dark tonight.`);
  return { ok: true };
}

// Station an exec at a settlement. Travel takes days — a little pawn walks the
// map (state.execTravels, same walk semantics as surveys). sid=null re-posts
// the exec to HQ.
export function assignExec(state, execId, sid) {
  const ex = state.execs.find(e => e.id === execId);
  if (!ex) return { ok: false, msg: 'No such executive' };
  const destSid = sid || state.hq;
  const dest = state.world.settlements.find(s => s.id === destSid);
  if (!dest) return { ok: false, msg: 'Unknown destination' };
  if (state.execTravels.some(t => t.execId === execId)) return { ok: false, msg: `${ex.name} is already travelling` };
  if (ex.sid === destSid) return { ok: false, msg: `${ex.name} is already there` };
  const fromSid = ex.sid || state.hq;
  const from = state.world.settlements.find(s => s.id === fromSid) || dest;
  const path = findRoute(state.world, from, dest);
  const days = Math.max(1, Math.round(1 + distance(from, dest) / 9));
  ex.sid = null; // effects lapse while on the road
  state.execTravels.push({ execId: ex.id, role: ex.role, name: ex.name, fromSid, sid: destSid, path, daysLeft: days, totalDays: days });
  pushNews(state, `<b>${ex.name}</b> sets out for ${dest.name} — arriving in ~${days} day${days > 1 ? 's' : ''}.`);
  return { ok: true, days };
}

// exec stationed (hired, not travelling) — internal helper, also handy for UI
export function stationedExec(state, role) {
  const ex = state.execs.find(e => e.role === role);
  return ex && ex.sid ? ex : null;
}

// Surveys aren't instant: a researcher sets out on foot from your HQ and
// interviews shoppers when they arrive. Watch the little walker on the map.
export function researchSettlement(state, sid) {
  const s = state.world.settlements.find(x => x.id === sid);
  const cost = s.type === 'city' ? 1200 : s.type === 'town' ? 700 : 400;
  if (s.researched) return { ok: false };
  if (state.surveys.some(sv => sv.sid === sid)) return { ok: false, msg: 'A researcher is already on their way there' };
  if (state.cash < cost) return { ok: false, msg: `Need $${cost}` };
  state.cash -= cost;
  const hq = state.world.settlements.find(x => x.id === state.hq);
  const path = findRoute(state.world, hq, s);
  const days = Math.max(2, Math.round(1 + distance(hq, s) / 7)) + 2; // travel + 2 days of interviews
  state.surveys.push({ sid, path, daysLeft: days, totalDays: days });
  pushNews(state, `A researcher sets out from ${hq.name} to survey <b>${s.name}</b> — back with answers in ~${days} days.`);
  return { ok: true };
}

// ---------------- fit & demand ----------------
export function productAppeal(p, seg, wealth, eventCtx, comp = 1) {
  // attribute match 0..1
  const pr = seg.prefs;
  const attrScore = (p.style * pr.style + p.quality * pr.quality + p.utility * pr.utility + p.eco * pr.eco + p.tech * pr.tech)
    / (pr.style + pr.quality + pr.utility + pr.eco + pr.tech);
  const catAff = seg.cats[p.cat] ?? 0.3;
  // Price elasticity: demand falls steeply above perceived fair value and
  // rises when you undercut it. Competition sharpens the effect.
  // Premium brand tiers raise perceived fair value (price power).
  const fair = p.msrp * (0.75 + p.quality * 0.5) * wealth * (eventCtx.brandFair || 1);
  const ratio = p.price * (eventCtx.priceMult || 1) / Math.max(1, fair);
  const priceSens = Math.min(1.3, seg.priceSens + (eventCtx.priceSensDelta || 0));
  const elasticity = (0.9 + priceSens * 1.8) * (0.7 + 0.3 * Math.min(2, comp));
  const priceAppeal = Math.min(1.5, Math.pow(Math.max(0.03, 1 / Math.max(0.2, ratio)), elasticity));
  return attrScore * catAff * priceAppeal;
}

export function seasonMult(p, cal, eventCtx) {
  let m = 1;
  if (p.season === 'summer') m *= cal.season === 'summer' ? 1.65 : cal.season === 'winter' ? 0.45 : 0.8;
  if (p.season === 'winter') m *= cal.season === 'winter' ? 1.65 : cal.season === 'summer' ? 0.45 : 0.8;
  if (p.season === 'holiday') m *= (cal.month === 11 || cal.month === 12) ? 1.7 : 0.75;
  if (eventCtx.catMult && eventCtx.catMult[p.cat]) m *= eventCtx.catMult[p.cat];
  if (eventCtx.sportsMult && p.sports) m *= eventCtx.sportsMult;
  return m;
}

// Fit score of product in a settlement, 0..100, for UI
export function fitScore(state, p, s) {
  const cal = calInfo(state);
  const ctx = eventContext(state);
  const comp = rivalPressure(state, s);
  let f = 0;
  for (const [k, w] of Object.entries(s.segments)) {
    f += productAppeal(p, SEGMENTS[k], s.wealth, ctx, comp) * w;
  }
  return Math.round(Math.min(1, f * seasonMult(p, cal, ctx) * 2.3) * 100);
}

// Brand focus: a coherent assortment converts better. Post-$100M ("Category
// King") the scatter penalty is waived — an empire spans categories.
export function brandFocus(state) {
  const listed = state.products.filter(p => p.listed);
  if (listed.length === 0) return { hhi: 0, topCat: null, topShare: 0, bonus: 1, label: '—' };
  const counts = {};
  for (const p of listed) counts[p.cat] = (counts[p.cat] || 0) + 1;
  let hhi = 0, topCat = null, topN = 0;
  for (const [cat, n] of Object.entries(counts)) {
    const sh = n / listed.length;
    hhi += sh * sh;
    if (n > topN) { topN = n; topCat = cat; }
  }
  const eff = listed.length < 2 ? 0.55 : hhi;
  let bonus = 0.82 + 0.42 * eff; // scattered ≈ ×0.9, tightly themed ≈ ×1.22
  let label = eff >= 0.6 ? 'Focused' : eff >= 0.38 ? 'Coherent' : 'Scattered';
  if (state.goalsDone && state.goalsDone.includes('empire')) {
    bonus = Math.max(bonus, 1.05); // empire: breadth is a strength
    if (Object.keys(counts).length >= 5) label = 'Empire';
  }
  return { hhi, topCat, topShare: topN / listed.length, bonus, label };
}

// ---------------- flash sale ----------------
export function startFlashSale(state) {
  if (state.flashSale.daysLeft > 0) return { ok: false, msg: 'Sale already running' };
  if (state.day < state.flashSale.cooldownUntil) return { ok: false, msg: `Shoppers need a break — ready in ${state.flashSale.cooldownUntil - state.day} days` };
  if (!state.products.some(p => p.listed)) return { ok: false, msg: 'List some products first' };
  const cost = 800;
  if (state.cash < cost) return { ok: false, msg: 'Need $800' };
  state.cash -= cost;
  state.flashSale.daysLeft = 4;
  state.flashSale.cooldownUntil = state.day + 32;
  state.fxAnims.push({ kind: 'confetti', t: 0 });
  pushNews(state, `<b>FLASH SALE!</b> Everything 20% off for 4 days. The crowds are coming.`);
  return { ok: true };
}

// ---------------- post-IPO scalers (SIM2) ----------------
export const NATIONAL_CAMPAIGN = { cost: 150000, days: 21 };
export const AUTOMATION_TIERS = [
  { name: 'Conveyor Robots', cost: 400000, mult: 1.5 },
  { name: 'Sorting AI', cost: 1200000, mult: 2.2 },
  { name: 'Lights-Out Warehouse', cost: 4000000, mult: 3.5 },
];
export const BRAND_TIERS = [
  { name: 'Premium Label', cost: 300000 },
  { name: 'Luxury House', cost: 1500000 },
  { name: 'Icon Status', cost: 6000000 },
];
export const EXPORT_LEVELS = [
  { cost: 200000,   perShipment: 32000 },
  { cost: 450000,   perShipment: 75000 },
  { cost: 1000000,  perShipment: 170000 },
  { cost: 2200000,  perShipment: 380000 },
  { cost: 5000000,  perShipment: 850000 },
  { cost: 11000000, perShipment: 1900000 },
  { cost: 24000000, perShipment: 4200000 },
  { cost: 52000000, perShipment: 9000000 },
];
export const ACQUISITION_COST = 2000000;

const ipoDone = s => s.goalsDone.includes('ipo');

export function setFranchising(state, on) {
  if (!ipoDone(state)) return { ok: false, msg: 'Franchising unlocks at IPO ($1M lifetime revenue)' };
  state.franchising = !!on;
  pushNews(state, on
    ? 'Franchise program opens. Entrepreneurs across the island want the logo above their door.'
    : 'Franchise program paused. Existing franchisees keep trading.');
  return { ok: true };
}

export function startNationalCampaign(state) {
  if (!ipoDone(state)) return { ok: false, msg: 'National campaigns unlock at IPO' };
  if (state.activeEvents.some(e => e.key === 'national')) return { ok: false, msg: 'A national campaign is already running' };
  if (state.cash < NATIONAL_CAMPAIGN.cost) return { ok: false, msg: `Need ${fmtMoney(NATIONAL_CAMPAIGN.cost)}` };
  state.cash -= NATIONAL_CAMPAIGN.cost;
  state.lifetime.mkt += NATIONAL_CAMPAIGN.cost;
  state.activeEvents.push({ key: 'national', name: 'National Campaign', daysLeft: NATIONAL_CAMPAIGN.days, demandMult: 1.12 });
  state.fxAnims.push({ kind: 'confetti', t: 0 });
  pushNews(state, `<b>${state.companyName}</b> goes national — billboards, primetime, the works. ${NATIONAL_CAMPAIGN.days} days of saturation.`);
  return { ok: true };
}

export function buyAutomation(state) {
  if (!ipoDone(state)) return { ok: false, msg: 'Automation unlocks at IPO' };
  if (!state.execs.some(e => e.role === 'coo')) return { ok: false, msg: 'Robots need a COO to run them. Hire one.' };
  const tier = AUTOMATION_TIERS[state.automation];
  if (!tier) return { ok: false, msg: 'Warehouses are fully automated' };
  if (state.cash < tier.cost) return { ok: false, msg: `Need ${fmtMoney(tier.cost)}` };
  state.cash -= tier.cost;
  state.automation++;
  state.fxAnims.push({ kind: 'confetti', t: 0 });
  pushNews(state, `<b>${tier.name}</b> online. Ship capacity ×${tier.mult} — the warehouse hums at 3am.`);
  return { ok: true };
}

export function buyBrandTier(state) {
  if (!ipoDone(state)) return { ok: false, msg: 'Brand tiers unlock at IPO' };
  const tier = BRAND_TIERS[state.brandTier];
  if (!tier) return { ok: false, msg: 'The brand is already iconic' };
  if (state.cash < tier.cost) return { ok: false, msg: `Need ${fmtMoney(tier.cost)}` };
  state.cash -= tier.cost;
  state.brandTier++;
  pushNews(state, `<b>${state.companyName}</b> ascends to <b>${tier.name}</b>. Shoppers stop asking about the price.`);
  return { ok: true };
}

// Sign (level 0→1) or upgrade the international export contract via the port.
export function upgradeExport(state) {
  if (!ipoDone(state)) return { ok: false, msg: 'Export contracts unlock at IPO' };
  if (!state.world.port) return { ok: false, msg: 'No port on this island' };
  if (!state.products.some(p => p.source === 'own')) return { ok: false, msg: 'Exporters want YOUR products — launch one via R&D first' };
  const m = metrics(state);
  if (m.satisfaction < 0.7) return { ok: false, msg: 'Reputation too weak abroad — get satisfaction above 70%' };
  const lvl = state.exportContract ? state.exportContract.level : 0;
  const next = EXPORT_LEVELS[lvl];
  if (!next) {
    // maxed: renegotiate to refresh staleness at 10% of the top-tier cost
    const cost = Math.round(EXPORT_LEVELS[EXPORT_LEVELS.length - 1].cost * 0.1);
    if (state.cash < cost) return { ok: false, msg: `Need ${fmtMoney(cost)} to renegotiate` };
    state.cash -= cost;
    state.exportContract.lastUpgradeDay = state.day;
    pushNews(state, 'Export contracts renegotiated — the partners are happy again.');
    return { ok: true, renegotiated: true };
  }
  if (state.cash < next.cost) return { ok: false, msg: `Need ${fmtMoney(next.cost)}` };
  state.cash -= next.cost;
  state.exportContract = { level: lvl + 1, nextShipDay: state.day + 7, lastUpgradeDay: state.day };
  pushNews(state, lvl === 0
    ? `Export contract signed! A freighter will leave the port weekly, laden with <b>${state.companyName}</b> goods.`
    : `Export network expanded to <b>tier ${lvl + 1}</b> — bigger ships, farther markets.`);
  return { ok: true };
}

// $10M unlock: acquire one rival's regional operations — absorb its 2
// strongest locations (their presence collapses there, you gain the stores).
export function acquireRivalOps(state, rivalId) {
  if (!state.goalsDone.includes('acquire')) return { ok: false, msg: 'Acquisitions unlock at $10M lifetime revenue' };
  if (state.acquiredRival) return { ok: false, msg: 'Regulators would block a second acquisition' };
  const rival = RIVALS.find(r => r.id === rivalId);
  const agent = state.rivals.find(r => r.id === rivalId);
  if (!rival || !agent || !agent.active) return { ok: false, msg: 'That chain is not for sale' };
  if (state.cash < ACQUISITION_COST) return { ok: false, msg: `Need ${fmtMoney(ACQUISITION_COST)}` };
  state.cash -= ACQUISITION_COST;
  state.acquiredRival = rivalId;
  const pres = state.rivalPresenceBy[rivalId];
  const top = state.world.settlements
    .slice().sort((a, b) => (pres[b.id] || 0) - (pres[a.id] || 0)).slice(0, 2);
  const names = [];
  for (const s of top) {
    pres[s.id] = Math.max(0, (pres[s.id] || 0) * 0.15);
    names.push(s.name);
    if (!state.premises.some(p => p.kind === 'store' && p.sid === s.id)) {
      state.premises.push({
        id: `prem-${state.premises.length}`, sid: s.id, kind: 'store', level: 1,
        stock: {}, recent: {}, autoReplenish: true, serviceLevel: 1, missedToday: 0, franchise: false,
      });
      s.awareness = Math.min(1, s.awareness + 0.2);
    }
  }
  syncRivalPresence(state);
  state.fxAnims.push({ kind: 'confetti', t: 0 });
  pushNews(state, `<b>${state.companyName}</b> acquires ${rival.name}'s regional ops — the ${names.join(' and ')} locations rebrand overnight.`);
  return { ok: true };
}

function eventContext(state) {
  const ctx = { demandMult: 1, catMult: {}, sportsMult: 1, priceSensDelta: 0, shipDelay: 0, stormSids: new Set() };
  if (state.flashSale && state.flashSale.daysLeft > 0) {
    ctx.priceMult = 0.8;      // revenue takes the haircut too
    ctx.attention = 1.55;     // but shoppers flock in
    ctx.demandMult *= 1.1;
  }
  if (state.brandTier > 0) ctx.brandFair = 1 + 0.06 * state.brandTier; // price power
  for (const e of state.activeEvents) {
    if (e.demandMult) ctx.demandMult *= e.demandMult;
    if (e.catMult) for (const [k, v] of Object.entries(e.catMult)) ctx.catMult[k] = (ctx.catMult[k] || 1) * v;
    if (e.sportsMult) ctx.sportsMult *= e.sportsMult;
    if (e.priceSensDelta) ctx.priceSensDelta += e.priceSensDelta;
    if (e.shipDelay) ctx.shipDelay += e.shipDelay;
    if (e.stormSids) e.stormSids.forEach(x => ctx.stormSids.add(x));
    if (e.footfallSid) ctx.footfallSid = e.footfallSid;
  }
  return ctx;
}

// ---------------- events ----------------
const EVENT_BLURBS = {
  valentines: 'Beauty ×2.1 and apparel ×1.4 for 4 days. Romance sells.',
  summerhols: 'Outdoor ×1.7, toys & fitness up, for a month. Get the camping gear listed.',
  halloween: 'Toys ×1.9, food ×1.35 for 4 days. Spooky season.',
  bfcm: 'ALL demand ×3.4 for 4 days. Stock up, staff up — a melted warehouse ruins Christmas.',
  xmasrun: 'Demand ×1.5, gifts (toys/home/gadgets) way up for 17 days.',
  slump: 'Demand ×0.62 for 16 days. Cut marketing, hold cash, plan R&D.',
  worldcup: 'Sports gear ×2.6 for the whole month. TV ads are 30% off.',
  storm: 'Deliveries into the region run ~2.5 days late. Satisfaction risk.',
  viral: 'One category is blowing up online. Ride it.',
  supplycrunch: 'Restocks cost more and take 7 days. Order early.',
  recession: 'Shoppers get price-sensitive. Consider trimming prices.',
  national: 'Island-wide awareness surge and demand +12% while it runs.',
  pricewar: 'A rival is dumping prices in one of your markets. Your margins there are compressed until it ends.',
  primely: 'Primely has landed. Same-day delivery is the new normal — shoppers now expect 3-day shipping everywhere.',
  primelynow: 'Primely Now: 2-day expectations island-wide. Keep the warehouse fast or bleed satisfaction.',
};

const FIXED_EVENTS = [
  { month: 2, dom: 12, key: 'valentines', name: "Valentine's Day", days: 4, catMult: { beauty: 2.1, apparel: 1.4 }, news: 'Valentine’s rush: beauty & apparel demand spikes!' },
  { month: 6, dom: 20, key: 'summerhols', name: 'Summer Holidays', days: 34, catMult: { outdoor: 1.7, toys: 1.25, fitness: 1.2 }, news: 'Summer holidays begin — outdoor gear season!' },
  { month: 10, dom: 26, key: 'halloween', name: 'Halloween', days: 4, catMult: { toys: 1.9, food: 1.35 }, news: 'Halloween week: toys and treats fly off shelves.' },
  { month: 11, dom: 24, key: 'bfcm', name: 'BFCM', days: 4, demandMult: 3.4, news: 'BLACK FRIDAY / CYBER MONDAY! Demand is going vertical. Don’t melt your warehouse.' },
  { month: 12, dom: 8, key: 'xmasrun', name: 'Holiday Shopping', days: 17, demandMult: 1.5, catMult: { toys: 1.9, home: 1.4, gadgets: 1.4 }, news: 'Holiday shopping season — gifts, gifts, gifts.' },
  { month: 12, dom: 26, key: 'slump', name: 'January Slump', days: 16, demandMult: 0.62, news: 'Post-holiday slump. Wallets are closed.' },
];

function rollEvents(state, cal) {
  // fixed calendar events
  for (const fe of FIXED_EVENTS) {
    if (cal.month === fe.month && cal.dom === fe.dom && !state.activeEvents.some(e => e.key === fe.key)) {
      state.activeEvents.push({ ...fe, daysLeft: fe.days });
      pushNews(state, fe.news);
      state.pendingEvent = { name: fe.name, days: fe.days, desc: EVENT_BLURBS[fe.key] || '' };
      if (fe.key === 'bfcm') state.fxAnims.push({ kind: 'confetti', t: 0 });
    }
  }
  // world cup: every 4th year, all of June
  if (cal.year % 4 === 2 && cal.month === 6 && cal.dom === 1 && !state.activeEvents.some(e => e.key === 'worldcup')) {
    state.activeEvents.push({ key: 'worldcup', name: 'World Cup', daysLeft: 28, sportsMult: 2.6, catMult: { fitness: 1.5, apparel: 1.3 }, news: '' });
    pushNews(state, 'THE WORLD CUP KICKS OFF! Sports gear demand explodes for a month.');
    state.pendingEvent = { name: 'World Cup', days: 28, desc: EVENT_BLURBS.worldcup };
  }
  // random events
  const rng = stateRng(state);
  if (rng.chance(1 / 26) && state.activeEvents.length < 4) {
    const roll = rng.next();
    if (roll < 0.3) {
      // storm over a region
      const s = rng.pick(state.world.settlements);
      const hit = state.world.settlements.filter(o => distance(o, s) < 14).map(o => o.id);
      state.activeEvents.push({ key: 'storm', name: 'Storm', daysLeft: rng.int(3, 6), stormSids: hit, stormCenter: { x: s.x, y: s.y } });
      pushNews(state, `A storm batters the ${s.name} region — deliveries there will run late.`);
      state.pendingEvent = { name: `Storm over ${s.name}`, days: 5, desc: EVENT_BLURBS.storm };
    } else if (roll < 0.6) {
      const cat = rng.pick(Object.keys(CATEGORIES));
      state.activeEvents.push({ key: 'viral', name: 'Viral Trend', daysLeft: rng.int(6, 11), catMult: { [cat]: 2.3 } });
      pushNews(state, `${CATEGORIES[cat].name} is going viral online! Ride the trend while it lasts.`);
      state.pendingEvent = { name: `${CATEGORIES[cat].name} is trending`, days: 9, desc: EVENT_BLURBS.viral };
    } else if (roll < 0.75 && state.products.some(p => p.source === 'own')) {
      state.activeEvents.push({ key: 'supplycrunch', name: 'Supply Crunch', daysLeft: rng.int(8, 12) });
      pushNews(state, 'Supply chain crunch — restocks take longer and cost more.');
      state.pendingEvent = { name: 'Supply Crunch', days: 10, desc: EVENT_BLURBS.supplycrunch };
    } else if (roll < 0.9) {
      state.activeEvents.push({ key: 'recession', name: 'Belt-Tightening', daysLeft: rng.int(10, 16), priceSensDelta: 0.35 });
      pushNews(state, 'Consumer confidence dips. Shoppers hunt for bargains.');
      state.pendingEvent = { name: 'Belt-Tightening', days: 13, desc: EVENT_BLURBS.recession };
    } else {
      const s = rng.pick(state.world.settlements.filter(x => x.awareness > 0.05) || state.world.settlements);
      if (s) {
        s.awareness = Math.min(1, s.awareness + 0.25);
        pushNews(state, `A local influencer in ${s.name} shouts out ${state.companyName}! Awareness jumps.`);
      }
    }
  }
  // tick down
  for (const e of state.activeEvents) e.daysLeft--;
  state.activeEvents = state.activeEvents.filter(e => e.daysLeft > 0);
}

// ---------------- store logistics (SIM2 physical goods) ----------------
// Daily capacity for moving warehouse stock onto store shelves.
export function storeLogisticsCap(state) {
  let cap = 40 + state.premises.filter(p => p.kind === 'warehouse' && premiseActive(p)).length * 60
    + state.staff.shipping * 10;
  if (state.execs.some(e => e.role === 'coo' && e.sid)) cap *= 1.6;
  if (state.automation > 0) cap *= AUTOMATION_TIERS[state.automation - 1].mult;
  return Math.round(cap);
}

export function toggleStoreReplenish(state, premId) {
  const pr = state.premises.find(p => p.id === premId);
  if (!pr || pr.kind !== 'store') return { ok: false };
  pr.autoReplenish = !pr.autoReplenish;
  return { ok: true, on: pr.autoReplenish };
}

// Demand-forecast pull: each store tops its shelf products up to ~4 days of
// recent sales, drawing from the central warehouse pool, capped by daily
// logistics capacity. Runs automatically each tick for auto-replenish stores.
function allocateStoreStock(state) {
  let cap = storeLogisticsCap(state);
  const stores = state.premises.filter(p => p.kind === 'store' && premiseActive(p) && !p.franchise);
  for (const pr of stores) {
    pr.stock = pr.stock || {}; pr.recent = pr.recent || {};
    if (pr.autoReplenish === false) continue;
    for (const p of state.products) {
      if (!p.listed || (p.inventory || 0) <= 0) continue;
      const recent = pr.recent[p.id] || 0;
      const target = Math.max(4, Math.ceil(recent * 4));
      const have = pr.stock[p.id] || 0;
      const pull = Math.min(target - have, p.inventory, cap);
      if (pull <= 0) continue;
      pr.stock[p.id] = have + pull;
      p.inventory -= pull;
      cap -= pull;
      if (cap <= 0) return;
    }
  }
}

// ---------------- the daily tick ----------------
export function simulateDay(state) {
  if (state.gameOver || !state.hq) return null;
  state.day++;
  const cal = calInfo(state);
  rollEvents(state, cal);
  const ctx = eventContext(state);
  const rng = stateRng(state);
  const world = state.world;
  const scale = costScale(state);

  // --- incoming stock: freighter → port → lorry → warehouse ---
  for (const p of state.products) {
    if (!p.incoming || !p.incoming.length) continue;
    for (const o of p.incoming) {
      o.daysLeft--;
      if (o.daysLeft <= 0 && o.phase === 'sea') {
        o.phase = 'land';
        o.daysLeft = landLegDays(state);
        pushNews(state, `${o.qty} units of <b>${p.name}</b> docked at the port — lorry en route.`);
        // lorry animation: port → nearest fulfillment node
        const port = world.port;
        if (port) {
          const nodes2 = fulfillmentNodes(state);
          let node = null, nd = Infinity;
          for (const n of nodes2) { const d = distance(port, n); if (d < nd) { nd = d; node = n; } }
          if (node && state.shipAnims.length < 10) {
            const path = findRoute(world, port, node);
            state.shipAnims.push({ key: `lorry-${p.id}-${state.day}`, kind: 'lorry', path, units: o.qty, t: 0, dur: 5 + path.length / 4 });
          }
        }
      }
    }
    const arrived = p.incoming.filter(o => o.daysLeft <= 0 && o.phase === 'land');
    if (arrived.length) {
      const q = arrived.reduce((a, o) => a + o.qty, 0);
      p.inventory = (p.inventory || 0) + q;
      pushNews(state, `${q} units of <b>${p.name}</b> arrived at the warehouse.`);
    }
    p.incoming = p.incoming.filter(o => o.daysLeft > 0);
  }

  // --- surveys: researchers on the road ---
  for (const sv of state.surveys) {
    sv.daysLeft--;
    if (sv.daysLeft <= 0) {
      const s = world.settlements.find(x => x.id === sv.sid);
      s.researched = true;
      pushNews(state, `Survey complete: you now understand shoppers in <b>${s.name}</b>.`);
    }
  }
  state.surveys = state.surveys.filter(sv => sv.daysLeft > 0);

  // --- executives on the road ---
  for (const tr of state.execTravels) {
    tr.daysLeft--;
    if (tr.daysLeft <= 0) {
      const ex = state.execs.find(e => e.id === tr.execId);
      const s = world.settlements.find(x => x.id === tr.sid);
      if (ex && s) {
        ex.sid = tr.sid;
        pushNews(state, `<b>${ex.name}</b> arrives in ${s.name} and gets to work.`);
      }
    }
  }
  state.execTravels = state.execTravels.filter(t => t.daysLeft > 0);

  // --- passive surveying (Head of Research in the field) ---
  const hr = stationedExec(state, 'research');
  if (hr && hr.sid !== state.hq) {
    const at = world.settlements.find(x => x.id === hr.sid);
    if (at) {
      for (const s of world.settlements) {
        if (s.researched || distance(s, at) > 12) continue;
        state.passiveSurvey[s.id] = (state.passiveSurvey[s.id] || 0) + 0.04;
        if (state.passiveSurvey[s.id] >= 1) {
          s.researched = true;
          delete state.passiveSurvey[s.id];
          pushNews(state, `${hr.name}'s field team quietly finishes profiling <b>${s.name}</b>. No invoice required.`);
        }
      }
    }
  }

  // --- construction sites ---
  for (const pr of state.premises) {
    if (!pr.construction) continue;
    if (--pr.construction.daysLeft <= 0) {
      const s = world.settlements.find(x => x.id === pr.sid);
      const wasNew = pr.construction.isNew;
      if (pr.construction.toLevel != null) pr.level = pr.construction.toLevel;
      pr.construction = null;
      if (pr.kind === 'store') {
        if (wasNew) s.awareness = Math.min(1, s.awareness + 0.12);
        pushNews(state, wasNew
          ? `Grand opening! Your store in <b>${s.name}</b> is trading — running Shopify POS.`
          : `The ${s.name} store reopens as a <b>${STORE_LEVELS[pr.level].name}</b>.`);
      } else if (pr.kind === 'warehouse') {
        pushNews(state, `Warehouse in <b>${s.name}</b> is operational — faster deliveries for the region.`);
      } else {
        pushNews(state, `Office upgraded to the <b>${OFFICE_LEVELS[pr.level].name}</b> — more desks and shipping bays.`);
      }
      state.fxAnims.push({ kind: 'confetti', t: 0 });
    }
  }

  // --- R&D progress ---
  if (state.rnd) {
    state.rnd.daysLeft -= rndSpeed(state);
    if (state.rnd.daysLeft <= 0) finishRnd(state);
  }

  // --- auto-restock (own products reorder; catalog reorders wholesale if any store exists) ---
  const anyStore = state.premises.some(p => p.kind === 'store' && premiseActive(p) && !p.franchise);
  for (const p of state.products) {
    if (!p.autoRestock) continue;
    const inbound = (p.incoming || []).reduce((a, o) => a + o.qty, 0);
    if (p.source === 'own') {
      if ((p.inventory || 0) + inbound < 60) {
        const r = orderStock(state, p.id, 200);
        if (r.ok) pushNews(state, `Auto-restock: 200 × <b>${p.name}</b> ordered (${fmtMoney(r.total)}).`);
      }
    } else if (anyStore) {
      if ((p.inventory || 0) + inbound < 40) {
        const r = orderWholesale(state, p.id, 200);
        if (r.ok) pushNews(state, `Auto-restock (wholesale): 200 × <b>${p.name}</b> (${fmtMoney(r.total)}).`);
      }
    }
  }

  // --- flash sale ticks down ---
  if (state.flashSale.daysLeft > 0 && --state.flashSale.daysLeft === 0) {
    pushNews(state, 'Flash sale over. Prices back to normal.');
  }

  // --- rivals act ---
  rivalTick(state, cal);

  // --- marketing → awareness (with per-channel attribution weights) ---
  const storesBySid = {};
  for (const pr of state.premises) if (pr.kind === 'store' && premiseActive(pr)) storesBySid[pr.sid] = pr;
  const chWeight = { social: 0, search: 0, tv: 0, flyers: 0 };
  const cmo = stationedExec(state, 'cmo');
  const cmoAt = cmo ? world.settlements.find(x => x.id === cmo.sid) : null;
  const ceo = stationedExec(state, 'ceo');
  const nationalOn = state.activeEvents.some(e => e.key === 'national');
  // complacency: at scale, coasting on old awareness costs you — decay speeds
  // up when marketing spend is trivial relative to revenue.
  const dailyRev = sum(state.roll.revenue) / Math.max(1, state.roll.revenue.length);
  const mktPlanned = state.marketing.social + state.marketing.search + state.marketing.tv + state.marketing.flyers;
  const complacent = dailyRev > 5000 && !nationalOn && mktPlanned < 0.012 * dailyRev;
  const decay = complacent ? 0.975 : 0.986;
  for (const s of world.settlements) {
    let gain = 0;
    let effMult = 1;
    if (cmoAt && distance(s, cmoAt) <= 15) effMult *= 1.35; // CMO regional lift
    if (ceo && ceo.sid === s.id) effMult *= 1.5;            // the boss is in town
    for (const [ch, spend] of Object.entries(state.marketing)) {
      if (spend <= 0) continue;
      const c = CHANNELS[ch];
      let g = 0;
      if (ch === 'flyers') {
        if (!storesBySid[s.id]) continue; // flyers only near stores
        g = 0.05 * spend / (spend + c.half);
      } else if (ch === 'search') {
        continue; // search boosts conversion, not awareness
      } else {
        g = 0.017 * (c.profile[s.type] || 1) * spend / (spend + c.half);
      }
      g *= effMult;
      gain += g;
      chWeight[ch] += g * s.pop;
    }
    if (nationalOn) gain += 0.028 * effMult; // national campaign blankets the island
    s.awareness = Math.min(1, s.awareness + gain * (1 - s.awareness));
    s.awareness *= decay; // keep spending or fade — faster fade when you coast at scale
  }
  if (complacent && rng.chance(0.02)) {
    pushNews(state, `Analysts say <b>${state.companyName}</b> has "gone quiet". Awareness is slipping — rivals fill the silence.`);
  }
  const searchBoost = state.marketing.search > 0
    ? 1 + 0.5 * state.marketing.search / (state.marketing.search + CHANNELS.search.half) : 1;
  if (state.marketing.search > 0) {
    chWeight.search = (searchBoost - 1) * world.settlements.reduce((a, s) => a + s.pop * s.onlineAffinity * s.awareness, 0) * 0.15;
  }
  const focus = brandFocus(state);

  // --- fulfillment nodes (construction sites don't ship) ---
  const nodes = fulfillmentNodes(state);
  const office = state.premises.find(p => p.kind === 'office');
  let shipCapacity = OFFICE_LEVELS[office.level].shipCap
    + state.premises.filter(p => p.kind === 'warehouse' && premiseActive(p)).length * 90
    + state.staff.shipping * 30;
  if (state.execs.some(e => e.role === 'coo' && e.sid)) shipCapacity *= 1.25;
  if (state.automation > 0) shipCapacity *= AUTOMATION_TIERS[state.automation - 1].mult;
  shipCapacity = Math.round(shipCapacity);

  // --- store shelf replenishment (trucks now MEAN something) ---
  allocateStoreStock(state);
  for (const pr of state.premises) {
    if (pr.kind === 'store') { pr.missedToday = 0; pr.demandToday = 0; pr.metToday = 0; }
  }

  // --- demand simulation (attention model) ---
  // cogs = booked cost of goods (P&L view). cogsPaid = cash actually leaving
  // today (dropship + export production). Own/wholesale inventory was already
  // paid for when ordered — charging it again at sale would double-count.
  let orders = 0, revenue = 0, cogs = 0, cogsPaid = 0, newCustomers = 0, missedStock = 0, franchiseRev = 0;
  for (const p of state.products) p.missedToday = 0;
  const listedOnline = state.onlineStore ? state.products.filter(p => p.listed) : [];
  const perSettlementOrders = [];
  const brandSrc = 1 + 0.04 * state.brandTier;
  const srcMod = (p) => (p.source === 'own' ? 1.18 : 0.85) * brandSrc;
  const retail = stationedExec(state, 'retail');
  const warBySid = {};
  for (const w of state.priceWars) warBySid[w.sid] = w;

  // online sale: own products draw the central pool; catalog dropships freely
  const sellOnline = (p, units) => {
    if (p.source === 'own') {
      const sold = Math.min(units, p.inventory || 0);
      p.inventory -= sold;
      p.missedToday += units - sold;
      missedStock += units - sold;
      return { sold, unitCost: p.cost, paidNow: false }; // stock already paid for
    }
    return { sold: units, unitCost: p.cost, paidNow: true }; // dropship — paid per order, worse margin
  };
  // store sale: only what's on the shelf sells (own OR wholesale stock)
  const sellStore = (pr, p, units) => {
    pr.stock = pr.stock || {}; pr.recent = pr.recent || {};
    const have = pr.stock[p.id] || 0;
    const sold = Math.min(units, have);
    pr.stock[p.id] = have - sold;
    const missed = units - sold;
    pr.missedToday += missed; p.missedToday += missed; missedStock += missed;
    pr.demandToday += units; pr.metToday += sold;
    pr.recent[p.id] = (pr.recent[p.id] || 0) * 0.7 + units * 0.3; // demand forecast EMA
    return { sold, unitCost: p.source === 'own' ? p.cost : (p.wholesaleCost ?? p.cost), paidNow: false };
  };

  for (const s of world.settlements) {
    const store = storesBySid[s.id];
    if (!state.onlineStore && !store) { continue; }
    let nearest = Infinity, nearestNode = null;
    for (const n of nodes) { const d = distance(n, s); if (d < nearest) { nearest = d; nearestNode = n; } }

    // reputation gates demand: unhappy customers talk.
    const rep = 0.25 + 0.75 * Math.pow(s.satisfaction, 1.6);
    const shopperBase = s.pop * 0.00058 * ctx.demandMult * rep;
    const rivalP = rivalPressure(state, s);
    const comp = Math.min(2, rivalP);
    // price war: you're forced to match dumping prices — volume holds, margin bleeds
    const war = warBySid[s.id];
    const warMult = war ? (1 - war.discount) : 1;
    let sOrders = 0, sRevenue = 0;

    // physical shelf: a store only carries its best-fitting products
    let shelf = null;
    if (store) {
      const cap = STORE_LEVELS[store.level].shelf;
      const all = state.products.filter(p => p.listed);
      shelf = all.map(p => {
        let a = 0;
        for (const [k, w2] of Object.entries(s.segments)) a += productAppeal(p, SEGMENTS[k], s.wealth, ctx, comp) * w2;
        return { p, a: a * seasonMult(p, cal, ctx) };
      }).sort((x, y) => y.a - x.a).slice(0, cap).map(x => x.p);
    }

    for (const [segKey, segW] of Object.entries(s.segments)) {
      const seg = SEGMENTS[segKey];
      // ---- online ----
      if (listedOnline.length) {
        const shoppers = shopperBase * segW * s.onlineAffinity * seg.onlineBias * s.awareness;
        if (shoppers > 0.001) {
          const appeals = listedOnline.map(p =>
            Math.pow(Math.max(0, productAppeal(p, seg, s.wealth, ctx, comp) * seasonMult(p, cal, ctx) * srcMod(p) * focus.bonus), 1.6));
          const A = appeals.reduce((a, b) => a + b, 0) * (ctx.attention || 1);
          const share = A / (A + rivalP + 0.85); // rival chains + "didn't buy anything"
          let purchases = shoppers * share * 0.6 * searchBoost * (0.85 + 0.15 * state.onlineStore.level);
          purchases = Math.floor(purchases + (rng.next() < (purchases % 1) ? 1 : 0));
          for (let i = 0; i < listedOnline.length && purchases > 0; i++) {
            if (A <= 0) break;
            const p = listedOnline[i];
            let units = Math.round(purchases * appeals[i] / A);
            const r = sellOnline(p, units);
            if (r.sold <= 0) continue;
            p.soldTotal += r.sold;
            sOrders += r.sold;
            sRevenue += r.sold * p.price * (ctx.priceMult || 1) * warMult;
            cogs += r.sold * r.unitCost;
            if (r.paidNow) cogsPaid += r.sold * r.unitCost;
          }
        }
      }
      // ---- physical store (POS) — sells only what's on its shelves ----
      if (store) {
        let capture = STORE_LEVELS[store.level].capture * (ctx.footfallSid === s.id ? 2 : 1);
        if (retail && retail.sid === s.id) capture *= 1.3; // Retail Director on the floor
        if (ceo && ceo.sid === s.id) capture *= 1.15;      // CEO shakes hands
        const foot = shopperBase * segW * (1 - s.onlineAffinity * 0.55) * (0.25 + s.awareness * 0.75) * capture * 0.65;
        const stocked = shelf;
        if (stocked.length && foot > 0.001) {
          const appeals = stocked.map(p =>
            Math.pow(Math.max(0, productAppeal(p, seg, s.wealth, ctx, comp) * seasonMult(p, cal, ctx) * srcMod(p) * focus.bonus), 1.6));
          const A = appeals.reduce((a, b) => a + b, 0) * (ctx.attention || 1);
          const share = A / (A + rivalP * 0.8 + 0.85); // rivals compete a bit less on the high street
          let purchases = foot * share * 0.6;
          purchases = Math.floor(purchases + (rng.next() < (purchases % 1) ? 1 : 0));
          if (store.franchise) {
            // franchisees run their own stock; you book a royalty on their sales
            for (let i = 0; i < stocked.length && purchases > 0; i++) {
              if (A <= 0) break;
              const p = stocked[i];
              const units = Math.round(purchases * appeals[i] / A * 0.8);
              if (units <= 0) continue;
              const gross = units * p.price * (ctx.priceMult || 1) * warMult;
              franchiseRev += gross * 0.08;
              sOrders += Math.round(units * 0.1); // a trickle of brand customers
            }
          } else {
            for (let i = 0; i < stocked.length && purchases > 0; i++) {
              if (A <= 0) break;
              const p = stocked[i];
              let units = Math.round(purchases * appeals[i] / A);
              const r = sellStore(store, p, units);
              if (r.sold <= 0) continue;
              p.soldTotal += r.sold;
              orders += r.sold;
              revenue += r.sold * p.price * (ctx.priceMult || 1) * warMult;
              cogs += r.sold * r.unitCost;
              if (r.paidNow) cogsPaid += r.sold * r.unitCost;
              // walk-ins don't need shipping
            }
          }
        }
      }
    }

    if (sOrders > 0) {
      orders += sOrders; revenue += sRevenue;
      perSettlementOrders.push({ s, units: sOrders, dist: nearest, node: nearestNode, storm: ctx.stormSids.has(s.id) });
      const penetration = s.customers / Math.max(1, s.pop * 0.25);
      const freshShare = Math.max(0.15, 1 - penetration - s.satisfaction * 0.3);
      const fresh = Math.round(sOrders * Math.min(0.9, freshShare));
      s.customers = Math.min(s.pop, s.customers + fresh);
      newCustomers += fresh;
    }
  }
  revenue += franchiseRev;

  // --- store service level & stockout fallout ---
  for (const pr of state.premises) {
    if (pr.kind !== 'store' || !premiseActive(pr) || pr.franchise) continue;
    const met = pr.demandToday > 0 ? pr.metToday / pr.demandToday : 1;
    pr.serviceLevel = (pr.serviceLevel ?? 1) * 0.85 + met * 0.15;
    if (pr.demandToday >= 3 && met < 0.7) {
      const s = world.settlements.find(x => x.id === pr.sid);
      s.satisfaction = Math.max(0.2, s.satisfaction - 0.006);       // empty shelves annoy
      s.awareness = Math.max(0, s.awareness * 0.997);               // and word gets around
    }
  }

  // --- shipping & on-time delivery ---
  state.queue += perSettlementOrders.reduce((a, o) => a + o.units, 0);
  const shipped = Math.min(state.queue, shipCapacity);
  state.queue -= shipped;
  // orders stuck > ~8 days get cancelled and refunded
  let refunds = 0;
  const stale = Math.max(0, state.queue - shipCapacity * 8);
  if (stale > 0) {
    const m7 = state.roll.revenue, o7 = state.roll.orders;
    const aov = sum(o7) > 0 ? sum(m7) / sum(o7) : 25;
    const cancelled = Math.ceil(stale * 0.5);
    state.queue -= cancelled;
    refunds = cancelled * aov;
    revenue -= refunds;
    pushNews(state, `${cancelled} orders cancelled after waiting too long — ${fmtMoney(refunds)} refunded.`);
  }
  const backlogDays = shipCapacity > 0 ? state.queue / shipCapacity : 5;
  const expDays = state.expectedDeliveryDays ?? EXPECTED_DELIVERY_DAYS;
  let onTimeSum = 0, onTimeN = 0;
  for (const o of perSettlementOrders) {
    const transit = 1 + o.dist / 13 + (o.storm ? 2.5 : 0) + ctx.shipDelay;
    const total = transit + backlogDays;
    const onTime = total <= expDays ? 1 : Math.max(0, 1 - (total - expDays) * 0.3);
    onTimeSum += onTime * o.units; onTimeN += o.units;
  }
  // truck animations: batched — one truck per route per day
  const routes = perSettlementOrders.filter(o => o.node && o.units >= 3)
    .sort((a, b) => b.units - a.units).slice(0, 5);
  for (const o of routes) {
    if (state.shipAnims.length >= 8) break;
    if (state.shipAnims.some(a => a.key === `${o.node.id}-${o.s.id}`)) continue;
    const path = findRoute(world, o.node, o.s);
    state.shipAnims.push({ key: `${o.node.id}-${o.s.id}`, kind: 'van', path, units: o.units, t: 0, dur: 4 + path.length / 3 });
  }
  const todayOnTime = onTimeN > 0 ? onTimeSum / onTimeN : 1;
  state.onTime = state.onTime * 0.85 + todayOnTime * 0.15;

  // --- support & satisfaction ---
  const tickets = orders * 0.16;
  const supportCap = state.staff.support * 50 + 12;
  const coverage = Math.min(1, supportCap / Math.max(1, tickets));
  const avgQuality = state.products.filter(p => p.listed).reduce((a, p, _, arr) => a + p.quality / arr.length, 0) || 0.5;
  const satTarget = 0.3 * avgQuality + 0.45 * state.onTime + 0.25 * coverage;
  const coo = stationedExec(state, 'coo');
  for (const s of world.settlements) {
    if (s.customers > 0) s.satisfaction = s.satisfaction * 0.95 + satTarget * 0.05;
    if (coo && coo.sid === s.id && storesBySid[s.id]) s.satisfaction = Math.min(1, s.satisfaction + 0.002);
  }

  // --- rival poaching: where your satisfaction lags theirs, they eat you ---
  const primely = state.rivals.find(r => r.id === 'primely');
  const rivalService = primely && primely.active ? (state.expectedDeliveryDays <= 2 ? 0.88 : 0.8) : 0.72;
  let poachedTotal = 0;
  for (const s of world.settlements) {
    if (s.customers <= 0) continue;
    const gap = rivalService - s.satisfaction;
    if (gap <= 0.02) continue;
    const pressure = Math.min(2, rivalPressure(state, s));
    const lost = Math.floor(s.customers * 0.03 * pressure * gap);
    if (lost > 0) { s.customers -= lost; poachedTotal += lost; }
  }
  if (poachedTotal > 30 && rng.chance(0.12)) {
    pushNews(state, `Rivals poached ~${poachedTotal} of your customers today. Their service beats yours where you're slipping.`);
  }

  // --- repeat purchases (existing customers reorder) ---
  let repeatOrders = 0;
  if (listedOnline.length || Object.keys(storesBySid).length) {
    for (const s of world.settlements) {
      if (s.customers <= 0) continue;
      const rate = Math.pow(s.satisfaction, 2.2) * 0.011 * ctx.demandMult;
      let units = s.customers * rate;
      units = Math.floor(units + (rng.next() < (units % 1) ? 1 : 0));
      if (units <= 0) continue;
      const pool = listedOnline.length ? listedOnline : state.products.filter(p => p.listed);
      if (!pool.length) continue;
      const topSeg = SEGMENTS[Object.entries(s.segments).sort((a, b) => b[1] - a[1])[0][0]];
      const weights = pool.map(p => Math.max(0.01, productAppeal(p, topSeg, s.wealth, ctx, Math.min(2, rivalPressure(state, s)))));
      let pick = rng.next() * weights.reduce((a, b) => a + b, 0);
      let p = pool[0];
      for (let i = 0; i < pool.length; i++) { pick -= weights[i]; if (pick <= 0) { p = pool[i]; break; } }
      const war = warBySid[s.id];
      const warMult = war ? (1 - war.discount) : 1;
      let r;
      if (listedOnline.length) r = sellOnline(p, units);
      else {
        const st = storesBySid[s.id];
        if (!st || st.franchise) continue;
        r = sellStore(st, p, units);
      }
      if (r.sold <= 0) continue;
      p.soldTotal += r.sold;
      repeatOrders += r.sold; revenue += r.sold * p.price * (ctx.priceMult || 1) * warMult; cogs += r.sold * r.unitCost;
      if (r.paidNow) cogsPaid += r.sold * r.unitCost;
      if (listedOnline.length) state.queue += Math.round(r.sold * 0.7);
    }
  }
  orders += repeatOrders;

  // --- international exports (post-IPO, via the port) ---
  let exportRev = 0;
  if (state.exportContract && state.day >= state.exportContract.nextShipDay) {
    const lvl = state.exportContract.level;
    const per = EXPORT_LEVELS[lvl - 1].perShipment;
    const ownQ = state.products.filter(p => p.source === 'own');
    const qMult = ownQ.length ? 0.7 + ownQ.reduce((a, p) => a + p.quality, 0) / ownQ.length * 0.6 : 0.7;
    const m = metrics(state);
    const repMult = 0.6 + Math.min(1, Math.max(0, m.satisfaction)) * 0.55;
    // stale contracts erode: partners renegotiate around you if you stop investing
    const sinceUpgrade = state.day - (state.exportContract.lastUpgradeDay ?? state.day);
    const stale = Math.max(0.25, 1 - 0.004 * Math.max(0, sinceUpgrade - 180));
    exportRev = Math.round(per * qMult * repMult * (1 + 0.1 * state.brandTier) * stale);
    revenue += exportRev;
    const exportCogs = Math.round(exportRev * 0.55);
    cogs += exportCogs;
    cogsPaid += exportCogs;
    state.exportContract.nextShipDay = state.day + 7;
    if (stale < 0.85 && state.day % 56 === 0) pushNews(state, 'Export partners grumble: your contracts are getting stale. Renegotiate (upgrade) or watch the volumes shrink.');
    if (state.boatAnims.length < 4) state.boatAnims.push({ t: 0, dur: 14, qty: 400 * lvl });
    if (rng.chance(0.3)) pushNews(state, `Export shipment departs — ${fmtMoney(exportRev)} of <b>${state.companyName}</b> goods bound overseas.`);
  }

  // --- franchising: stores self-replicate where the brand is loved ---
  if (state.franchising && cal.dom === 14) {
    const cands = world.settlements.filter(s =>
      !state.premises.some(p => p.kind === 'store' && p.sid === s.id) &&
      s.satisfaction > 0.72 && s.awareness > 0.4 && s.customers > s.pop * 0.015);
    const franchiseCount = state.premises.filter(p => p.franchise).length;
    if (cands.length && franchiseCount < 40 && rng.chance(0.6)) {
      const s = rng.pick(cands);
      state.premises.push({
        id: `prem-${state.premises.length}`, sid: s.id, kind: 'store', level: 0,
        franchise: true, stock: {}, recent: {}, autoReplenish: false, serviceLevel: 1, missedToday: 0,
      });
      state.cash += 15000; // franchise fee
      s.awareness = Math.min(1, s.awareness + 0.1);
      pushNews(state, `A franchisee opens a <b>${state.companyName}</b> store in ${s.name} — $15k fee banked, 8% royalty flows.`);
    }
  }

  // --- living towns: monthly pop drift + tier changes ---
  if (cal.dom === 1) townTick(state, rng);

  // --- daily costs (rents & wages inflate with your scale — diseconomies) ---
  let rent = 0;
  for (const pr of state.premises) {
    if (pr.franchise) continue; // franchisees pay their own rent
    const s = world.settlements.find(x => x.id === pr.sid);
    rent += PREMISE_COSTS[pr.kind === 'office' ? 'office' : pr.kind][s.type].rent;
  }
  rent = Math.round(rent * scale);
  let wages = state.staff.shipping * WAGES.shipping + state.staff.support * WAGES.support + state.staff.engineer * WAGES.engineer;
  wages += state.execs.reduce((a, e) => a + EXEC_ROLES[e.role].salary, 0);
  wages = Math.round(wages * scale);
  const worldCup = state.activeEvents.some(e => e.key === 'worldcup');
  const tvSpend = worldCup ? state.marketing.tv * 0.7 : state.marketing.tv;
  const mktToday = state.marketing.social + state.marketing.search + tvSpend + state.marketing.flyers;
  // emergency debt: the bank floats you, at a price
  let interest = 0;
  if (state.cash < 0) {
    interest = Math.round(-state.cash * 0.0015); // ~0.15%/day on the overdraft
    state.debtInterestPaid += interest;
  }
  const costs = rent + wages + mktToday + interest;
  const profit = revenue - cogs - costs;          // accrual view (row/P&L)
  state.cash += revenue - cogsPaid - costs;       // cash view (inventory was pre-paid)

  // --- per-channel CAC attribution ---
  const totalW = Object.values(chWeight).reduce((a, b) => a + b, 0);
  const attributable = totalW > 0 ? Math.round(newCustomers * 0.8) : 0;
  for (const ch of Object.keys(CHANNELS)) {
    const cust = totalW > 0 ? attributable * chWeight[ch] / totalW : 0;
    const spend = ch === 'tv' ? tvSpend : state.marketing[ch];
    pushRoll14(state.mktAttrib[ch].spend, spend);
    pushRoll14(state.mktAttrib[ch].cust, cust);
  }

  // --- lifetime + rolling metrics ---
  state.lifetime.revenue += revenue;
  state.lifetime.orders += orders;
  state.lifetime.customers += newCustomers;
  state.lifetime.mkt += mktToday;
  pushRoll(state.roll.mkt, mktToday); pushRoll(state.roll.newCust, newCustomers);
  pushRoll(state.roll.revenue, revenue); pushRoll(state.roll.orders, orders);

  const totalCustomers = world.settlements.reduce((a, s) => a + s.customers, 0);
  const avgSat = totalCustomers > 0
    ? world.settlements.reduce((a, s) => a + s.satisfaction * s.customers, 0) / totalCustomers : 0.72;
  const avgAware = world.settlements.reduce((a, s) => a + s.awareness * s.pop, 0) / world.settlements.reduce((a, s) => a + s.pop, 0);

  const row = {
    day: state.day, revenue, orders, profit, newCustomers,
    customers: totalCustomers, satisfaction: avgSat, awareness: avgAware,
    cash: state.cash, queue: state.queue, onTime: state.onTime,
    missedStock, mkt: mktToday, cogs, rent, wages, refunds,
    interest, exportRev, franchiseRev, poached: poachedTotal,
  };
  state.history.push(row);
  if (state.history.length > 336) state.history.shift();

  // --- competition breakdown for the UI ---
  updateCompetition(state, cal);

  // --- alerts ---
  if (missedStock > 5) pushNews(state, `Stockouts! You missed ~${missedStock} sales today. Reorder inventory.`);
  if (backlogDays > 2 && orders > 10) pushNews(state, `Warehouse backlog is ${Math.round(backlogDays)} days deep. Hire crew or build a warehouse.`);
  if (state.cash < 0 && !state.debtWarned) {
    state.debtWarned = true;
    pushNews(state, 'You are in the red. The bank extends emergency credit at 0.15%/day — it calls everything in at -$50,000.');
  }
  if (state.cash >= 0) state.debtWarned = false;
  if (state.cash < -30000 && rng.chance(0.06)) pushNews(state, `The bank calls. Again. You owe ${fmtMoney(-state.cash)} and the interest is compounding.`);
  if (state.cash < -50000) {
    state.gameOver = true;
    pushNews(state, `The bank calls in its loans. <b>${state.companyName}</b> is bankrupt.`);
  }

  checkGoals(state, row);
  checkQuests(state);
  return row;
}

// ---------------- living towns ----------------
function townTick(state, rng) {
  const world = state.world;
  for (const s of world.settlements) {
    // local economy score ~0..1: your footprint + healthy competition + happy shoppers = jobs
    let e = 0;
    const store = state.premises.find(p => p.kind === 'store' && p.sid === s.id && premiseActive(p));
    if (store) e += (store.franchise ? 0.12 : 0.22) + 0.1 * store.level;
    if (state.premises.some(p => p.kind === 'warehouse' && p.sid === s.id && premiseActive(p))) e += 0.2;
    if (state.hq === s.id) e += 0.15;
    e += Math.min(0.3, s.customers / Math.max(1, s.pop * 0.2) * 0.3) * s.satisfaction;
    e += Math.min(0.1, rivalPressure(state, s) * 0.05); // rivals bring some jobs too
    if (state.priceWars.some(w => w.sid === s.id)) e -= 0.08;
    if (state.execs.some(x => x.sid === s.id)) e += 0.05;
    // annualized drift, capped; cities move slower
    const maxGrow = s.type === 'city' ? 0.02 : s.type === 'town' ? 0.035 : 0.045;
    const maxShrink = s.type === 'city' ? 0.015 : 0.03;
    const rate = Math.max(-maxShrink, Math.min(maxGrow, (e - 0.2) * 0.09)) * rng.range(0.8, 1.2);
    s.pop = Math.max(400, Math.round(s.pop * (1 + rate / 12)));

    // tier transitions with hysteresis
    const t = tierOf(s.pop);
    if (t !== s.type) {
      const up = (t === 'city' && s.type !== 'city') || (t === 'town' && s.type === 'village');
      const threshold = t === 'city' || s.type === 'city' ? TIER_THRESHOLDS.city : TIER_THRESHOLDS.town;
      const past = up ? s.pop >= threshold * 1.03 : s.pop < threshold * 0.97;
      if (past) {
        const old = s.type;
        s.type = t;
        if (up) {
          s.grewTick = state.day;
          pushNews(state, `<b>${s.name}</b> is booming — officially a ${t} now. Your investment built this.`);
          state.pendingEvent = { name: `${s.name} grows into a ${t}`, days: 0, desc: `Population ${s.pop.toLocaleString()}. Bigger market, bigger rents.` };
        } else {
          s.shrunkTick = state.day;
          pushNews(state, `Hard times: <b>${s.name}</b> shrinks from ${old} to ${t}. Shops are boarding up.`);
          state.pendingEvent = { name: `${s.name} declines to a ${t}`, days: 0, desc: `Population ${s.pop.toLocaleString()}. Cheaper rents, fewer shoppers.` };
        }
      }
    }
  }
}

// ---------------- first-steps quests (onboarding) ----------------
export const QUESTS = [
  { id: 'q-products', name: 'Stock the shelves', desc: 'Get 2 products (catalog or R&D)', reward: 400, test: s => s.products.length >= 2 },
  { id: 'q-online', name: 'Go live', desc: 'Launch your online store', reward: 400, test: s => !!s.onlineStore },
  { id: 'q-mkt', name: 'Make some noise', desc: 'Spend at least $50/day on marketing', reward: 400, test: s => Object.values(s.marketing).reduce((a, b) => a + b, 0) >= 50 },
  { id: 'q-survey', name: 'Know your customer', desc: 'Survey a settlement', reward: 400, test: s => s.world.settlements.some(x => x.researched) },
  { id: 'q-sale', name: 'First sale', desc: 'Sell something', reward: 600, test: s => s.lifetime.orders >= 1 },
];

export function checkQuests(state) {
  if (state.questsDone.length >= QUESTS.length) return;
  for (const q of QUESTS) {
    if (state.questsDone.includes(q.id)) continue;
    if (q.test(state)) {
      state.questsDone.push(q.id);
      state.cash += q.reward;
      state.pendingQuest = q;
    }
  }
}

function pushRoll(arr, v) { arr.push(v); if (arr.length > 7) arr.shift(); }
function pushRoll14(arr, v) { arr.push(v); if (arr.length > 14) arr.shift(); }
const sum = a => a.reduce((x, y) => x + y, 0);

// ---------------- rivals (SIM2 agents) ----------------
export function rivalPressure(state, s) {
  let p = state.rivalPresence[s.id] ?? 0.5;
  if (state.rivalPromo && state.rivalPromo.sid === s.id) p *= 1.6;
  if (state.priceWars && state.priceWars.some(w => w.sid === s.id)) p *= 1.25;
  return p;
}

function syncRivalPresence(state) {
  const agg = {};
  for (const s of state.world.settlements) {
    let t = 0;
    for (const r of state.rivals || []) {
      if (!r.active) continue;
      t += state.rivalPresenceBy[r.id][s.id] || 0;
    }
    // fresh newGame: agents may not exist yet during init — fall back to raw sum
    if (!state.rivals) t = Object.values(state.rivalPresenceBy).reduce((a, by) => a + (by[s.id] || 0), 0);
    agg[s.id] = round2(t);
  }
  state.rivalPresence = agg;
}

function yourShareOf(state, s) {
  return Math.min(1, s.customers / Math.max(1, s.pop * 0.25));
}

function rivalTick(state, cal) {
  if (state.rivalPromo && --state.rivalPromo.daysLeft <= 0) state.rivalPromo = null;
  // price wars burn down
  for (const w of state.priceWars) w.daysLeft--;
  const ended = state.priceWars.filter(w => w.daysLeft <= 0);
  for (const w of ended) {
    const s = state.world.settlements.find(x => x.id === w.sid);
    const rival = RIVALS.find(r => r.id === w.rival);
    // both sides bled — their presence dips a touch
    state.rivalPresenceBy[w.rival][w.sid] = Math.max(0.1, (state.rivalPresenceBy[w.rival][w.sid] || 0.3) - 0.12);
    pushNews(state, `The ${s.name} price war fizzles out. ${rival.name} quietly raises prices again. Everyone lost money.`);
  }
  state.priceWars = state.priceWars.filter(w => w.daysLeft > 0);

  // disruptor entry checks
  const primely = state.rivals.find(r => r.id === 'primely');
  if (primely && !primely.active && state.lifetime.revenue >= PRIMELY_ENTRY_REVENUE) {
    primely.active = true;
    const rng0 = stateRng(state);
    for (const s of state.world.settlements) {
      state.rivalPresenceBy.primely[s.id] = s.type === 'city' ? round2(0.9 * rng0.range(0.8, 1.2))
        : s.type === 'town' ? round2(0.45 * rng0.range(0.8, 1.2)) : 0.1;
    }
    state.expectedDeliveryDays = 3;
    syncRivalPresence(state);
    pushNews(state, `<b>PRIMELY HAS LANDED.</b> Drone depots overnight, vans everywhere. Shoppers now expect 3-day delivery — island-wide.`);
    state.pendingEvent = { name: 'Primely enters the market', days: 0, desc: EVENT_BLURBS.primely };
    return;
  }
  if (primely && primely.active && !primely.prime && state.lifetime.revenue >= PRIMELY_PRIME_REVENUE) {
    primely.prime = true;
    state.expectedDeliveryDays = 2;
    pushNews(state, `Primely launches <b>Primely Now</b>: 2-day delivery everywhere. Your warehouse just got slower by comparison.`);
    state.pendingEvent = { name: 'Primely Now', days: 0, desc: EVENT_BLURBS.primelynow };
  }

  const world = state.world;
  const rng = stateRng(state);

  // monthly presence drift: rivals mass where you're winning, neglect quiet markets
  if (cal.dom === 1) {
    for (const r of state.rivals) {
      if (!r.active) continue;
      const pres = state.rivalPresenceBy[r.id];
      for (const s of world.settlements) {
        const yourGrip = s.customers / Math.max(1, s.pop * 0.1);
        let delta = 0;
        if (yourGrip > 0.5) delta = 0.07 * rng.range(0.6, 1.4);
        else if (yourGrip > 0.15) delta = 0.025 * rng.range(0.5, 1.2);
        else delta = -0.003;
        pres[s.id] = Math.max(0.05, Math.min(2.0, (pres[s.id] || 0.2) + delta));
      }
    }
    syncRivalPresence(state);
  }

  // weekly agent moves (staggered so rivals act on different days)
  for (let i = 0; i < state.rivals.length; i++) {
    const agent = state.rivals[i];
    if (!agent.active) continue;
    if ((state.day + i * 2) % 7 !== 0) continue;
    const rival = RIVALS.find(r => r.id === agent.id);
    const pres = state.rivalPresenceBy[agent.id];
    // focus markets = its top-3 presence settlements
    agent.focusSids = world.settlements
      .slice().sort((a, b) => (pres[b.id] || 0) - (pres[a.id] || 0)).slice(0, 3).map(s => s.id);

    // pick a posture from the board room
    const contested = world.settlements.filter(s => yourShareOf(state, s) > 0.3 && (pres[s.id] || 0) > 0.35);
    const scaleHeat = Math.min(1, state.lifetime.revenue / 3e6); // they fear you as you grow
    let posture;
    const roll = rng.next();
    if (contested.length && roll < 0.25 + 0.35 * scaleHeat) posture = 'price-war';
    else if (roll < 0.55) posture = 'expand';
    else if (roll < 0.75) posture = 'blitz';
    else posture = 'defend';
    agent.posture = posture;

    if (posture === 'price-war' && contested.length && !state.priceWars.some(w => w.rival === agent.id)) {
      const t = rng.pick(contested);
      const discount = agent.id === 'primely' ? 0.25 : rival.style === 'discount' ? 0.22 : 0.16;
      state.priceWars.push({ sid: t.id, rival: agent.id, daysLeft: rng.int(18, 32), discount });
      agent.lastMove = { day: state.day, desc: `started a price war in ${t.name}` };
      pushNews(state, `<b>${rival.name}</b> slashes prices in ${t.name} — a price war! Your margins there are getting crushed.`);
      state.pendingEvent = { name: `Price war in ${t.name}`, days: 25, desc: EVENT_BLURBS.pricewar };
    } else if (posture === 'expand') {
      // open a location where the market is big and they're thin — visibly cuts your penetration
      const cands = world.settlements.filter(s => s.type !== 'village' || agent.id === 'bumblebuy');
      const t = cands.length ? rng.pick(cands) : rng.pick(world.settlements);
      pres[t.id] = Math.min(2.0, (pres[t.id] || 0.2) + 0.28);
      const poached = Math.floor(t.customers * 0.06);
      t.customers -= poached;
      agent.lastMove = { day: state.day, desc: `opened a location in ${t.name}` };
      pushNews(state, `<b>${rival.name}</b> opens a new ${rival.blurb} location in ${t.name}${poached > 5 ? ` — ~${poached} of your customers wander in for a look` : ''}.`);
    } else if (posture === 'blitz') {
      const targets = world.settlements.filter(x => x.customers > 20);
      const t = targets.length ? rng.pick(targets) : rng.pick(world.settlements);
      state.rivalPromo = { sid: t.id, daysLeft: 10, rival: agent.id };
      agent.lastMove = { day: state.day, desc: `launched a promo blitz in ${t.name}` };
      pushNews(state, `<b>${rival.name}</b> launches a promo blitz in ${t.name} — expect a fight for shoppers there.`);
    } else {
      // defend: shore up their own turf
      for (const sid of agent.focusSids) pres[sid] = Math.min(2.0, (pres[sid] || 0.2) + 0.08);
      agent.lastMove = { day: state.day, desc: `doubled down on its home markets` };
      if (rng.chance(0.5)) pushNews(state, `Retail press: ${rival.name} reports ${rng.pick(['strong', 'record', 'soft', 'mixed'])} quarterly results and "renewed focus on core markets".`);
    }
    syncRivalPresence(state);
  }
}

// per-settlement competition breakdown the UI renders
function updateCompetition(state, cal) {
  const comp = {};
  for (const s of state.world.settlements) {
    const pressure = round2(rivalPressure(state, s));
    let topRival = null, topP = 0;
    for (const r of state.rivals) {
      if (!r.active) continue;
      const p = state.rivalPresenceBy[r.id][s.id] || 0;
      if (p > topP) { topP = p; topRival = r.id; }
    }
    const yourShare = round2(yourShareOf(state, s));
    const rivalShare = round2(Math.min(0.95, pressure * 0.32));
    const prev = state.compSnapshots[s.id];
    const trend = prev == null ? 'flat' : pressure > prev + 0.08 ? 'up' : pressure < prev - 0.08 ? 'down' : 'flat';
    comp[s.id] = {
      pressure, topRival, yourShare, rivalShare,
      priceWar: state.priceWars.some(w => w.sid === s.id),
      trend,
    };
  }
  state.competition = comp;
  if (cal.dom === 1) {
    for (const s of state.world.settlements) state.compSnapshots[s.id] = comp[s.id].pressure;
  }
}

// ---------------- derived metrics for UI ----------------
export function metrics(state) {
  const mkt7 = sum(state.roll.mkt), new7 = sum(state.roll.newCust);
  const rev7 = sum(state.roll.revenue), ord7 = sum(state.roll.orders);
  const profit7 = sum(state.history.slice(-7).map(r => r.profit));
  // CAC counts marketing-attributed customers only (organic ≈ free)
  const attrCust7 = Object.values(state.mktAttrib).reduce((a, ch) => a + sum(ch.cust.slice(-7)), 0);
  const cac = attrCust7 > 0.5 ? mkt7 / attrCust7 : null;
  const organic7 = Math.max(0, new7 - attrCust7);
  const channels = {};
  for (const [ch, d] of Object.entries(state.mktAttrib)) {
    const sp = sum(d.spend), cu = sum(d.cust);
    channels[ch] = { spend14: sp, cust14: cu, cac: cu > 0.5 ? sp / cu : null };
  }
  const aov = ord7 > 0 ? rev7 / ord7 : 0;
  const listed = state.products.filter(p => p.listed);
  const marginRate = listed.length ? listed.reduce((a, p) => a + (p.price - p.cost) / Math.max(1, p.price), 0) / listed.length : 0.4;
  const totalCustomers = state.world.settlements.reduce((a, s) => a + s.customers, 0);
  const avgSat = totalCustomers > 0
    ? state.world.settlements.reduce((a, s) => a + s.satisfaction * s.customers, 0) / totalCustomers : 0.72;
  const repeat = Math.min(0.9, Math.pow(avgSat, 2.2) * 0.6);
  const ltv = aov * marginRate * (1 / (1 - repeat));
  return { cac, ltv, aov, rev7, ord7, new7, profit7, organic7, attrCust7, channels, satisfaction: avgSat, repeat, totalCustomers };
}

// ---------------- goals: the road to $1B ----------------
export const GOALS = [
  { id: 'first-sale', name: 'First Sale', desc: 'Sell your first product', test: (s) => s.lifetime.orders >= 1, reward: 500 },
  { id: 'k-day', name: '$1,000 Day', desc: 'Make $1,000 revenue in a single day', test: (s, r) => r && r.revenue >= 1000, reward: 1500 },
  { id: 'hundred', name: '100 Customers', desc: 'Acquire 100 customers', test: (s, r) => r && r.customers >= 100, reward: 2000 },
  { id: 'own-product', name: 'Inventor', desc: 'Launch your own product', test: (s) => s.products.some(p => p.source === 'own'), reward: 3000 },
  { id: 'two-stores', name: 'Chain Reaction', desc: 'Run 2 physical stores', test: (s) => s.premises.filter(p => p.kind === 'store').length >= 2, reward: 4000 },
  { id: 'bfcm', name: 'BFCM Survivor', desc: 'Do a $10,000 day during BFCM with on-time > 80%', test: (s, r) => r && r.revenue >= 10000 && s.onTime > 0.8 && s.activeEvents.some(e => e.key === 'bfcm'), reward: 10000 },
  { id: 'satisfied', name: 'Beloved Brand', desc: '1,000 customers with satisfaction over 85%', test: (s, r) => r && r.customers >= 1000 && r.satisfaction > 0.85, reward: 15000 },
  { id: 'ipo', name: 'IPO', desc: '$1M lifetime revenue — ring the bell. Unlocks franchising, national campaigns, automation, brand tiers & exports. +$250k capital.', test: (s) => s.lifetime.revenue >= 1000000, reward: 250000 },
  { id: 'acquire', name: 'Consolidator', desc: '$10M lifetime revenue — unlocks acquiring a rival\'s regional operations.', test: (s) => s.lifetime.revenue >= 10000000, reward: 0 },
  { id: 'empire', name: 'Category King', desc: '$100M lifetime revenue — your multi-category empire converts everywhere (scatter penalty waived).', test: (s) => s.lifetime.revenue >= 100000000, reward: 0 },
  { id: 'billion', name: 'The Billion', desc: '$1,000,000,000 lifetime revenue. The trillion-dollar track. THE WIN.', test: (s) => s.lifetime.revenue >= 1000000000, reward: 0 },
];

function checkGoals(state, row) {
  for (const g of GOALS) {
    if (state.goalsDone.includes(g.id)) continue;
    if (g.test(state, row)) {
      state.goalsDone.push(g.id);
      state.cash += g.reward;
      state.pendingGoal = g;
      if (g.id === 'ipo') {
        state.fxAnims.push({ kind: 'confetti', t: 0 });
        pushNews(state, `<b>${state.companyName}</b> IPOs at $1M lifetime revenue! $250k lands in the account. Franchising, national campaigns & export desks unlock. This is the STARTING line.`);
      } else if (g.id === 'acquire') {
        pushNews(state, `The bankers are circling: at $10M revenue you can now <b>acquire a rival's regional ops</b> (${fmtMoney(ACQUISITION_COST)}).`);
      } else if (g.id === 'empire') {
        pushNews(state, `$100M. <b>${state.companyName}</b> is a multi-category empire — breadth now sells itself.`);
      } else if (g.id === 'billion') {
        state.won = true;
        state.wonDay = state.day;
        state.fxAnims.push({ kind: 'confetti', t: 0 });
        pushNews(state, `<b>ONE BILLION DOLLARS.</b> ${state.companyName} is on the trillion-dollar track. The island will never be the same.`);
      }
    }
  }
}

// ---------------- news ----------------
export function pushNews(state, html) {
  state.news.push(html);
  if (state.news.length > 8) state.news.shift();
}

function round2(x) { return Math.round(x * 100) / 100; }

export function fmtMoney(n) {
  const neg = n < 0;
  const abs = Math.abs(n);
  let s;
  if (abs >= 1e9) s = (abs / 1e9).toFixed(2) + 'B';
  else if (abs >= 1e6) s = (abs / 1e6).toFixed(2) + 'M';
  else if (abs >= 1e4) s = (abs / 1e3).toFixed(1) + 'k';
  else s = Math.round(abs).toLocaleString();
  return (neg ? '-$' : '$') + s;
}
