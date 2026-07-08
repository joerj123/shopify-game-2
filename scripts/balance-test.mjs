#!/usr/bin/env node
// ============================================================
// SIM2 balance harness — plays scripted strategies headlessly.
//   node scripts/balance-test.mjs [seed]
//
// Acceptance targets:
//   idle       → must go bankrupt
//   steady     → survives, IPO between day 350-900
//   aggressive → $1B between day 2200-4500
//   coaster    → plays well to $5M lifetime then freezes → must decline
//                into real danger (negative cash or sustained losses)
// ============================================================
import {
  newGame, simulateDay, chooseHq, addCatalogProduct, catalogAvailable,
  launchOnlineStore, openStore, buildWarehouse, upgradeOffice, upgradeStore,
  hire, startRnd, orderStock, orderWholesale, toggleListing,
  hireExec, assignExec, setFranchising, startNationalCampaign,
  buyAutomation, buyBrandTier, upgradeExport, acquireRivalOps,
  metrics, staffCap, staffCount, listingCap, premiseActive,
  OFFICE_LEVELS, STORE_LEVELS, EXPORT_LEVELS, AUTOMATION_TIERS, BRAND_TIERS, RIVALS,
  fmtMoney,
} from '../src/sim.js';

const SEED = Number(process.argv[2] || 12345);

// ---------------- bot helpers ----------------
function pickHq(state) {
  // biggest town: decent market, sane rent
  const towns = state.world.settlements.filter(s => s.type === 'town');
  const t = towns.sort((a, b) => b.pop - a.pop)[0] || state.world.settlements[0];
  chooseHq(state, t.id);
  return t;
}

function sourceFocusedCatalog(state, n) {
  // pick a coherent set (brand focus bonus): best category by margin*quality depth
  const avail = catalogAvailable(state);
  const byCat = {};
  for (const c of avail) {
    const margin = (c.msrp - c.cost * 1.62) / c.msrp;
    const score = margin * (0.5 + c.quality) * c.msrp; // absolute $ contribution
    (byCat[c.cat] = byCat[c.cat] || []).push({ c, score });
  }
  let bestCat = null, bestScore = -1;
  for (const [cat, arr] of Object.entries(byCat)) {
    arr.sort((a, b) => b.score - a.score);
    const s = arr.slice(0, n).reduce((a, x) => a + x.score, 0);
    if (s > bestScore) { bestScore = s; bestCat = cat; }
  }
  let added = 0;
  for (const { c } of byCat[bestCat]) {
    if (added >= n) break;
    if (addCatalogProduct(state, c.id).ok) added++;
  }
  return added;
}

function keepStaffed(state) {
  const row = state.history[state.history.length - 1];
  if (!row) return;
  const cap = staffCap(state);
  // shipping: clear the backlog
  if (state.queue > 40 && staffCount(state) < cap && state.cash > 3000) hire(state, 'shipping');
  // support: cover tickets
  const need = Math.ceil((row.orders * 0.16 - 12) / 50);
  if (state.staff.support < need && staffCount(state) < cap && state.cash > 3000) hire(state, 'support');
}

function scaleMarketing(state, mult = 1) {
  const m = metrics(state);
  const dailyRev = m.rev7 / 7;
  state.marketing.social = Math.min(800, Math.round((150 + dailyRev * 0.06) * mult));
  state.marketing.search = Math.min(600, Math.round((100 + dailyRev * 0.04) * mult));
  state.marketing.tv = dailyRev > 2500 ? Math.min(2000, Math.round(dailyRev * 0.06 * mult)) : 0;
  state.marketing.flyers = state.premises.some(p => p.kind === 'store' && premiseActive(p)) ? 60 : 0;
}

function restockAll(state) {
  for (const p of state.products) {
    if (!p.listed) continue;
    const inbound = (p.incoming || []).reduce((a, o) => a + o.qty, 0);
    const level = (p.inventory || 0) + inbound;
    if (p.source === 'own' && level < 150 && state.cash > p.cost * 500 * 0.8 + 8000) {
      orderStock(state, p.id, 500);
      p.autoRestock = true;
    } else if (p.source === 'catalog' && level < 100 && state.cash > p.wholesaleCost * 200 + 8000
      && state.premises.some(x => x.kind === 'store')) {
      orderWholesale(state, p.id, 200);
      p.autoRestock = true;
    }
  }
}

function listBest(state) {
  const cap = listingCap(state);
  const listed = state.products.filter(p => p.listed).length;
  if (listed >= cap) return;
  const unlisted = state.products.filter(p => !p.listed)
    .sort((a, b) => (b.quality + b.utility) - (a.quality + a.utility));
  for (const p of unlisted) {
    if (state.products.filter(x => x.listed).length >= cap) break;
    toggleListing(state, p.id);
  }
}

// ---------------- strategies ----------------
function idleStrategy(state, day) {
  if (day === 1) {
    const c = catalogAvailable(state)[0];
    addCatalogProduct(state, c.id);
  }
  // ...and then he went fishing.
}

function steadyStrategy(state, day) {
  if (day === 1) {
    sourceFocusedCatalog(state, 3);
    launchOnlineStore(state);
    state.marketing.social = 150;
    state.marketing.search = 100;
  }
  if (day % 7 !== 0) return; // checks in weekly — a reasonable human
  const m = metrics(state);
  keepStaffed(state);
  scaleMarketing(state, 1);
  listBest(state);
  restockAll(state);

  // grow the footprint at a sensible pace
  const stores = state.premises.filter(p => p.kind === 'store');
  const warehouses = state.premises.filter(p => p.kind === 'warehouse');
  if (stores.length === 0 && state.cash > 32000 && m.rev7 > 4000) {
    const city = state.world.settlements.filter(s => s.type === 'city').sort((a, b) => b.pop - a.pop)[0];
    if (city) openStore(state, city.id);
  }
  if (warehouses.length === 0 && state.cash > 25000 && m.rev7 > 6000) {
    const city = state.world.settlements.filter(s => s.type === 'city' &&
      !state.premises.some(p => p.kind === 'store' && p.sid === s.id)).sort((a, b) => b.pop - a.pop)[0] ||
      state.world.settlements.filter(s => s.type === 'city').sort((a, b) => b.pop - a.pop)[0];
    if (city) buildWarehouse(state, city.id);
  }
  if (stores.length === 1 && state.cash > 40000 && m.rev7 > 12000) {
    const city = state.world.settlements.filter(s => s.type === 'city' &&
      !state.premises.some(p => p.kind === 'store' && p.sid === s.id)).sort((a, b) => b.pop - a.pop)[0];
    if (city) openStore(state, city.id);
  }
  const office = state.premises.find(p => p.kind === 'office');
  if (!office.construction && OFFICE_LEVELS[office.level + 1] &&
    state.cash > OFFICE_LEVELS[office.level + 1].upgradeCost + 15000 && state.queue > 40) upgradeOffice(state);

  // one R&D product at a time once cash allows
  if (!state.rnd && state.products.filter(p => p.source === 'own').length < 2 && state.cash > 30000 && metrics(state).rev7 > 5000) {
    startRnd(state, 'home', 'standard', 0.4);
  }
  // modest post-IPO usage
  if (state.goalsDone.includes('ipo')) {
    if (!state.franchising) setFranchising(state, true);
    const lvl = state.exportContract ? state.exportContract.level : 0;
    if (lvl < 2 && EXPORT_LEVELS[lvl] && state.cash > EXPORT_LEVELS[lvl].cost + 60000) upgradeExport(state);
  }
}

function aggressiveStrategy(state, day) {
  if (day === 1) {
    sourceFocusedCatalog(state, 4);
    launchOnlineStore(state);
    state.marketing.social = 250;
    state.marketing.search = 150;
  }
  if (day % 4 !== 0) return; // hands-on operator
  const m = metrics(state);
  keepStaffed(state);
  scaleMarketing(state, 1.4);
  listBest(state);
  restockAll(state);

  const stores = state.premises.filter(p => p.kind === 'store' && !p.franchise);
  const warehouses = state.premises.filter(p => p.kind === 'warehouse');
  if (stores.length === 0 && state.cash > 28000 && m.rev7 > 3000) {
    const city = state.world.settlements.filter(s => s.type === 'city').sort((a, b) => b.pop - a.pop)[0];
    if (city) openStore(state, city.id);
  }
  if (warehouses.length === 0 && state.cash > 25000 && m.rev7 > 5000) {
    const city = state.world.settlements.filter(s => s.type === 'city').sort((a, b) => b.pop - a.pop)[0];
    if (city) buildWarehouse(state, city.id);
  }
  // roll out stores to every city and town when rich (but never raid the export fund)
  const exportLvl = state.exportContract ? state.exportContract.level : 0;
  const savingFor = state.goalsDone.includes('ipo') && EXPORT_LEVELS[exportLvl] ? EXPORT_LEVELS[exportLvl].cost * 0.5 : 0;
  if (state.cash > 80000 + savingFor && m.rev7 > 15000) {
    const target = state.world.settlements.filter(s => s.type !== 'village' &&
      !state.premises.some(p => p.kind === 'store' && p.sid === s.id)).sort((a, b) => b.pop - a.pop)[0];
    if (target) openStore(state, target.id);
  }
  if (warehouses.length < 3 && state.cash > 90000 + savingFor && m.rev7 > 30000) {
    const t = state.world.settlements.filter(s => s.type !== 'village' &&
      !state.premises.some(p => (p.kind === 'warehouse' || p.kind === 'office') && p.sid === s.id))
      .sort((a, b) => b.pop - a.pop)[0];
    if (t) buildWarehouse(state, t.id);
  }
  const office = state.premises.find(p => p.kind === 'office');
  if (!office.construction && OFFICE_LEVELS[office.level + 1] &&
    state.cash > OFFICE_LEVELS[office.level + 1].upgradeCost + 12000) upgradeOffice(state);
  // upgrade stores
  for (const pr of stores) {
    if (pr.construction) continue;
    const next = STORE_LEVELS[pr.level + 1];
    if (next && state.cash > next.upgradeCost + 40000 + savingFor) upgradeStore(state, pr.id);
  }
  // R&D pipeline
  if (!state.rnd && state.cash > 45000 + savingFor * 0.5 && m.rev7 > 6000) {
    startRnd(state, ['home', 'gadgets', 'fitness'][state.ownCount % 3], state.cash > 120000 ? 'premium' : 'standard', 0.5);
  }
  // engineers speed R&D
  if (state.staff.engineer < 3 && staffCount(state) < staffCap(state) && state.cash > 30000 && m.rev7 > 8000) hire(state, 'engineer');

  // executives (staged — salaries are real money)
  if (state.cash > 60000 && m.rev7 > 25000) {
    hireExec(state, 'coo');
    hireExec(state, 'cmo');
  }
  if (state.cash > 80000 && m.rev7 > 45000) {
    hireExec(state, 'retail');
    hireExec(state, 'research');
    // station CMO & retail in the biggest city; keep COO/research at HQ
    const city = state.world.settlements.filter(s => s.type === 'city').sort((a, b) => b.pop - a.pop)[0];
    if (city) {
      const cmo = state.execs.find(e => e.role === 'cmo');
      if (cmo && cmo.sid === state.hq) assignExec(state, cmo.id, city.id);
      const rd = state.execs.find(e => e.role === 'retail');
      if (rd && rd.sid === state.hq) assignExec(state, rd.id, city.id);
    }
  }

  // post-IPO scalers: strict priority — the export ladder compounds hardest.
  if (state.goalsDone.includes('ipo')) {
    if (!state.franchising) setFranchising(state, true);
    const lvl = state.exportContract ? state.exportContract.level : 0;
    const nextExport = EXPORT_LEVELS[lvl];
    if (nextExport && state.cash > nextExport.cost + 60000) upgradeExport(state);
    if (!nextExport && state.cash > 8000000) upgradeExport(state); // renegotiate at max
    // secondary buys only from cash beyond a capped export reserve
    const reserve = nextExport ? Math.min(nextExport.cost * 0.5, 2000000) : 300000;
    const spare = state.cash - reserve;
    if (state.automation < AUTOMATION_TIERS.length && lvl >= 2 &&
      spare > AUTOMATION_TIERS[state.automation].cost + 60000) buyAutomation(state);
    if (state.brandTier < BRAND_TIERS.length && lvl >= 3 &&
      spare > BRAND_TIERS[state.brandTier].cost + 60000) buyBrandTier(state);
    if (lvl >= 4 && spare > 300000 && !state.activeEvents.some(e => e.key === 'national')) startNationalCampaign(state);
  }
  if (state.goalsDone.includes('acquire') && !state.acquiredRival && state.cash > 2600000) {
    acquireRivalOps(state, 'bumblebuy');
  }
}

function coasterStrategy(state, day) {
  if (state.lifetime.revenue < 5e6) return aggressiveStrategy(state, day);
  // $5M: "we've made it." Stops adjusting: no new markets/products, marketing
  // frozen at whatever it was, staff frozen, no post-IPO moves. Auto-restock
  // toggles stay on (the ops team keeps the lights on; leadership golfs).
}

// ---------------- runner ----------------
function run(name, strategy, maxDays) {
  const state = newGame(SEED);
  pickHq(state);
  const res = {
    name, bankruptDay: null, ipoDay: null, d10M: null, d100M: null, d1B: null,
    peakCash: 0, endCash: 0, endLifetime: 0, endDay: 0, maxDays,
    frozeDay: null, lossStreakDays: 0, worstCashAfterFreeze: null, peakRev7: 0, endRev7: 0,
  };
  let day = 0, lossStreak = 0;
  while (day < maxDays && !state.gameOver) {
    day++;
    strategy(state, day);
    const row = simulateDay(state);
    if (!row) break;
    res.peakCash = Math.max(res.peakCash, state.cash);
    if (!res.ipoDay && state.goalsDone.includes('ipo')) res.ipoDay = day;
    if (!res.d10M && state.lifetime.revenue >= 1e7) res.d10M = day;
    if (!res.d100M && state.lifetime.revenue >= 1e8) res.d100M = day;
    if (!res.d1B && state.lifetime.revenue >= 1e9) res.d1B = day;
    if (name === 'coaster' && !res.frozeDay && state.lifetime.revenue >= 5e6) res.frozeDay = day;
    if (res.frozeDay) {
      res.worstCashAfterFreeze = res.worstCashAfterFreeze == null ? state.cash : Math.min(res.worstCashAfterFreeze, state.cash);
      if (row.profit < 0) lossStreak++; else lossStreak = 0;
      res.lossStreakDays = Math.max(res.lossStreakDays, lossStreak);
    }
    const m = metrics(state);
    res.peakRev7 = Math.max(res.peakRev7, m.rev7);
    if (name === 'aggressive' && res.d1B) break; // won — stop the clock
  }
  if (state.gameOver) res.bankruptDay = day;
  res.endCash = state.cash;
  res.endLifetime = state.lifetime.revenue;
  res.endDay = day;
  res.endRev7 = metrics(state).rev7;
  res.won = state.won;
  return res;
}

// ---------------- verdicts ----------------
function verdicts(r) {
  switch (r.name) {
    case 'idle':
      return [r.bankruptDay != null, r.bankruptDay != null ? `bankrupt d${r.bankruptDay}` : 'NEVER went bankrupt'];
    case 'steady': {
      // windows widened after the 2026-07 rebalance: the early game is
      // deliberately kinder now (see scripts/viability-test.mjs)
      const ok = r.bankruptDay == null && r.ipoDay != null && r.ipoDay >= 280 && r.ipoDay <= 900;
      return [ok, r.bankruptDay != null ? `DIED d${r.bankruptDay}` : r.ipoDay == null ? 'no IPO' : `IPO d${r.ipoDay} (want 280-900)`];
    }
    case 'aggressive': {
      const ok = r.d1B != null && r.d1B >= 1800 && r.d1B <= 4500;
      return [ok, r.d1B == null ? `no $1B (lifetime ${fmtMoney(r.endLifetime)} @ d${r.endDay})` : `$1B d${r.d1B} (want 1800-4500)`];
    }
    case 'coaster': {
      const revCollapse = r.endRev7 < r.peakRev7 * 0.5;
      // "real decline" = bankruptcy, overdraft, sustained losses, OR the
      // business visibly withering (revenue less than half its peak).
      const declined = r.bankruptDay != null || (r.worstCashAfterFreeze != null && r.worstCashAfterFreeze < 0) || r.lossStreakDays >= 200 || revCollapse;
      return [declined, `froze d${r.frozeDay ?? '—'}; ` + (r.bankruptDay != null ? `bankrupt d${r.bankruptDay}` :
        `worst cash ${fmtMoney(r.worstCashAfterFreeze ?? r.endCash)}, loss streak ${r.lossStreakDays}d, rev7 ${fmtMoney(r.endRev7)} vs peak ${fmtMoney(r.peakRev7)}${revCollapse ? ' (collapsed)' : ''}`)];
    }
  }
}

const t0 = Date.now();
const runs = [
  run('idle', idleStrategy, 3000),
  run('steady', steadyStrategy, 1400),
  run('aggressive', aggressiveStrategy, 4600),
  run('coaster', coasterStrategy, 5200),
];

console.log(`\nSIM2 balance test — seed ${SEED} — ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('strategy', 12) + pad('verdict', 6) + pad('IPO', 7) + pad('$10M', 7) + pad('$100M', 7) + pad('$1B', 7) + pad('end day', 9) + pad('end cash', 11) + pad('lifetime rev', 14) + 'detail');
console.log('-'.repeat(110));
let allPass = true;
for (const r of runs) {
  const [ok, detail] = verdicts(r);
  allPass = allPass && ok;
  console.log(
    pad(r.name, 12) + pad(ok ? 'PASS' : 'FAIL', 6) +
    pad(r.ipoDay ?? '—', 7) + pad(r.d10M ?? '—', 7) + pad(r.d100M ?? '—', 7) + pad(r.d1B ?? '—', 7) +
    pad(r.endDay, 9) + pad(fmtMoney(r.endCash), 11) + pad(fmtMoney(r.endLifetime), 14) + detail);
}
console.log('');
process.exit(allPass ? 0 : 1);
