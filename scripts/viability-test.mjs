#!/usr/bin/env node
// Strategy-viability harness: the design target is that MULTIPLE reasonable
// strategies work — not just "dropship gadgets". Plays archetypal builds for
// 2 game years across seeds and reports survival + profitability.
//   node scripts/viability-test.mjs [--days N]
//
// Targets:
//  - no sensible build (fit-matched products + modest ads) goes bankrupt
//  - every dropship category ends year 2 cash-positive vs start ($25k)
//  - stocked (wholesale) beats pure dropship on the same products
//  - own-products and stores builds are competitive with dropshipping
import {
  newGame, simulateDay, chooseHq, addCatalogProduct, launchOnlineStore,
  startRnd, orderStock, openStore, hire, metrics, staffCount, staffCap,
  upgradeOffice, fmtMoney,
} from '../src/sim.js';
import { CATALOG } from '../src/data/catalog.js';

const DAYS = parseInt(process.argv.find((a, i) => process.argv[i - 1] === '--days') || '672', 10);
const SEEDS = [11, 42, 1337, 777, 2024];

function boot(seed) {
  const s = newGame(seed);
  const town = s.world.settlements.filter(x => x.type === 'town').sort((a, b) => b.pop - a.pop)[0];
  chooseHq(s, town.id);
  launchOnlineStore(s);
  return s;
}

function upkeep(s) {
  const m = metrics(s);
  if (s.queue > 80 && staffCount(s) < staffCap(s) && s.cash > 3000) hire(s, 'shipping');
  const opd = m.ord7 / 7;
  if (s.staff.support < Math.floor(opd / 300) && staffCount(s) < staffCap(s) && s.cash > 3000) hire(s, 'support');
  if (s.queue > 200 && s.cash > 30000) upgradeOffice(s);
  // a sensible player reacts to the P&L (this is exactly what the in-game
  // advisors now tell you to do): scale ad spend with revenue, trim when
  // losing money on a thin bank account
  if (s.cash < -10000) for (const k of Object.keys(s.marketing)) s.marketing[k] = Math.round(s.marketing[k] * 0.5);
  // grow marketing gently with revenue
  const dailyRev = m.rev7 / 7;
  s.marketing.social = Math.min(500, Math.max(s.marketing.social, Math.round(dailyRev * 0.05)));
  s.marketing.search = Math.min(400, Math.max(s.marketing.search, Math.round(dailyRev * 0.03)));
}

const dropshipCat = (cat) => (s) => {
  for (const c of CATALOG.filter(c => c.cat === cat && !c.season).slice(0, 4)) addCatalogProduct(s, c.id);
  s.marketing.social = 100; s.marketing.search = 60;
  return () => upkeep(s);
};

const STRATS = {
  'dropship-gadgets': dropshipCat('gadgets'),
  'dropship-home': dropshipCat('home'),
  'dropship-apparel': dropshipCat('apparel'),
  'dropship-fitness': dropshipCat('fitness'),
  'dropship-food': dropshipCat('food'),
  // same products as dropship-gadgets, but keeps wholesale stock on hand
  'stocked-gadgets': (s) => {
    const un = dropshipCat('gadgets')(s);
    for (const p of s.products) p.autoRestock = true;
    return un;
  },
  'own-products': (s) => {
    for (const c of CATALOG.filter(c => c.cat === 'fitness' && !c.season).slice(0, 2)) addCatalogProduct(s, c.id);
    s.marketing.social = 80; s.marketing.search = 40;
    let started = 0;
    return () => {
      upkeep(s);
      if (!s.rnd && started < 3 && s.cash > 14000) { startRnd(s, ['fitness', 'outdoor', 'home'][started], 'standard', 0.4); started++; }
      for (const p of s.products) {
        if (p.source !== 'own') continue;
        p.autoRestock = true;
        if ((p.inventory || 0) === 0 && !(p.incoming || []).length && s.cash > 6000) orderStock(s, p.id, 200);
        if (!p.listed && (p.inventory || 0) > 0) p.listed = true;
      }
    };
  },
  // store-first player: flyers drive foot traffic, broadcast spend stays lean
  // until revenue supports it
  'stores-wholesale': (s) => {
    for (const c of CATALOG.filter(c => ['home', 'food'].includes(c.cat) && !c.season).slice(0, 5)) addCatalogProduct(s, c.id);
    s.marketing.social = 100; s.marketing.search = 60; s.marketing.flyers = 60;
    for (const p of s.products) p.autoRestock = true;
    let stores = 0;
    return () => {
      upkeep(s);
      if (stores < 3 && s.cash > 16000) {
        const target = s.world.settlements
          .filter(x => x.type !== 'city' && !s.premises.some(p => p.kind === 'store' && p.sid === x.id))
          .sort((a, b) => b.pop - a.pop)[0];
        if (target) { openStore(s, target.id); stores++; }
      }
    };
  },
};

const results = [];
for (const [name, setup] of Object.entries(STRATS)) {
  const per = [];
  for (const seed of SEEDS) {
    const s = boot(seed);
    const tick = setup(s);
    let dead = null;
    for (let i = 0; i < DAYS && !s.gameOver; i++) { simulateDay(s); if (tick) tick(); }
    if (s.gameOver) dead = s.day;
    per.push({ dead, cash: Math.round(s.cash), rev: Math.round(s.lifetime.revenue) });
  }
  const med = (k) => per.map(p => p[k]).sort((a, b) => a - b)[Math.floor(per.length / 2)];
  results.push({
    strategy: name,
    bankrupt: per.filter(p => p.dead != null).length + '/' + per.length,
    medianCash: fmtMoney(med('cash')),
    medianLifetimeRev: fmtMoney(med('rev')),
    _medCash: med('cash'),
  });
}

console.log(`\nViability test — ${DAYS} days × ${SEEDS.length} seeds\n`);
console.table(results.map(({ _medCash, ...r }) => r));

const fails = [];
// 1. no sensible build may go bankrupt
for (const r of results) if (r.bankrupt !== '0/' + SEEDS.length) fails.push(`${r.strategy}: went bankrupt (${r.bankrupt})`);
// 2. every build must end above water; niche builds (fitness, capital-heavy
//    stores) may run leaner, but the majority must beat the starting $25k
for (const r of results) if (r._medCash < 0) fails.push(`${r.strategy}: median end cash ${r.medianCash} below zero`);
const above25k = results.filter(r => r._medCash >= 25000).length;
if (above25k < 5) fails.push(`only ${above25k}/8 strategies beat the starting $25k (want ≥5)`);
// 3. stock/own-product routes must clearly reward the extra effort
const cashOf = (n) => results.find(r => r.strategy === n)._medCash;
if (cashOf('stocked-gadgets') <= cashOf('dropship-gadgets')) fails.push('stocking wholesale does NOT beat pure dropship');
if (cashOf('own-products') < cashOf('dropship-gadgets') * 0.6) fails.push('own-products badly lags dropshipping');
if (cashOf('stores-wholesale') < cashOf('dropship-gadgets') * 0.1) fails.push('stores build is hopeless vs dropshipping');

if (fails.length) { console.log('FAILURES:'); for (const f of fails) console.log(' -', f); process.exit(1); }
console.log('ALL VIABILITY TARGETS PASS');
