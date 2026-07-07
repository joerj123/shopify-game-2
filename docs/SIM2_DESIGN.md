# SIM2_DESIGN — the big simulation rework

Spec for the redesigned simulation in `src/sim.js` / `src/world.js` (save
**v4**). This document is the contract for the wave-2 UI agent and the
renderer wave: every new/changed mechanic, export, and state field is listed
here with exact shapes. Everything in `docs/PORT_SPEC.md` §3 still holds
unless explicitly amended below.

Design goals (from player feedback):
1. Legible, dangerous competition — you can lose *after* becoming profitable.
2. Physical stores hold physical goods.
3. Executive pawns you station around the map.
4. Towns grow/shrink with the economy.
5. $1M is the IPO, not the win. The win is **$1B**.

Validated by `scripts/balance-test.mjs` (run: `node scripts/balance-test.mjs [seed]`):
idle play goes bankrupt; steady play IPOs day ~350–420; optimal-ish play hits
$1B around day 2500–4300; a player who coasts after $5M declines into
bankruptcy.

---

## ⚠️ 0. SAVE VERSION 4 — main.js MUST be updated (coordinator)

- `newGame()` now produces `state.v = 4`.
- **`load()` must accept `s.v === 3 || s.v === 4` and call the new export
  `migrateSave(state)` immediately after restoring typed arrays.** It upgrades
  a v3 save **in place** (fills every new field with sane defaults, splits
  rival presence, seeds the CEO at HQ) and is a no-op on v4 saves.
- Additional transient arrays to strip on save / reset on load, alongside the
  existing ones: **`execTravels`** should be *kept* (it's plain data and
  resumes fine), nothing new needs stripping. `pendingGoal/Quest/Event`
  handling is unchanged.
- `sim.js` no longer imports from `./sprites.js` (hashCode is inlined,
  byte-identical FNV-1a) — sim is fully headless (`node` can import it with no
  DOM/three/assets deps). Do not reintroduce presentation imports.

```js
// main.js load() sketch
const s = JSON.parse(raw);
if (s.v !== 3 && s.v !== 4) return null;
s.world.tiles = Uint8Array.from(s.world.tiles);
s.world.elev = Float32Array.from(s.world.elev);
migrateSave(s);            // ← REQUIRED (no-op for v4)
s.shipAnims = []; s.boatAnims = []; s.fxAnims = [];
```

---

## 1. Competition rework — rival agents

### 1.1 State

```js
// RIVALS (export) gained a third entry:
{ id:'primely', name:'Primely', color:'#5ac8e0', style:'disruptor',
  blurb:'same-day-everything megacorp', disruptor:true }

state.rivals = [                       // agent state, parallel to RIVALS
  { id:'bumblebuy'|'verdant'|'primely',
    active: bool,                      // primely starts false (enters mid-game)
    posture: 'expand'|'defend'|'price-war'|'blitz',
    focusSids: [sid, sid, sid],        // its top-3 markets (recomputed weekly)
    lastMove: { day, desc } | null,    // human-readable last weekly move
    prime?: true }                     // primely only, after "Primely Now"
]

state.rivalPresenceBy = { bumblebuy:{[sid]:n}, verdant:{...}, primely:{...} }
state.rivalPresence   = { [sid]: n }   // AGGREGATE of active rivals — kept in
                                       // sync every change; renderer contract
                                       // (business-mode pip) is unchanged.
state.priceWars = [ { sid, rival, daysLeft, discount } ]  // discount 0.16–0.25
state.rivalPromo = { sid, daysLeft, rival } | null        // unchanged semantics

state.competition = {                  // recomputed EVERY tick — render freely
  [sid]: {
    pressure: n,                       // rivalPressure(state, s) incl. promo/war mults
    topRival: 'bumblebuy'|'verdant'|'primely'|null,
    yourShare: 0..1,                   // customers / (pop * 0.25), clamped
    rivalShare: 0..0.95,               // min(0.95, pressure * 0.32)
    priceWar: bool,
    trend: 'up'|'down'|'flat',         // pressure vs ~28-day-old snapshot
  }
}
state.compSnapshots = { [sid]: n }     // internal (monthly pressure snapshots)
state.expectedDeliveryDays = 4         // live delivery expectation (4 → 3 → 2)
```

`rivalPressure(state, s)` (export, unchanged signature) =
`rivalPresence[sid] × 1.6 if promo blitz here × 1.25 if price war here`.

### 1.2 Behavior

- **Weekly moves** (staggered per rival, `(day + i*2) % 7 === 0`): the agent
  picks a posture and executes one move, always announced in the news and
  recorded in `agent.lastMove`:
  - `price-war` — chosen with probability scaling with your lifetime revenue,
    targets a settlement where `yourShare > 0.3` and their presence > 0.35.
    Pushes `state.priceWars` entry (18–32 days). **Effect: your revenue per
    unit in that settlement ×(1−discount)** (volume holds, margin bleeds) and
    pressure ×1.25. Fires `pendingEvent`. When a war ends the rival's presence
    there dips 0.12 (news: "everyone lost money").
  - `expand` — presence +0.28 in a town/city and **immediately poaches ~6% of
    your customers there** (news names the count).
  - `blitz` — the classic `rivalPromo` (10 days, pressure ×1.6).
  - `defend` — +0.08 presence in its `focusSids`.
- **Monthly drift** (dom 1): presence grows where you're winning
  (`yourGrip > 0.5 → +0.07/mo`, cap **2.0 per rival**), decays −0.003 in
  neglected markets.
- **Disruptor arc**: at lifetime revenue ≥ `PRIMELY_ENTRY_REVENUE` ($2.5M)
  Primely activates (presence ~0.9 in cities), `expectedDeliveryDays` drops to
  **3**, big news + `pendingEvent`. At ≥ `PRIMELY_PRIME_REVENUE` ($30M),
  "Primely Now": `expectedDeliveryDays` = **2**. On-time delivery is computed
  against `state.expectedDeliveryDays`, so shipping that used to feel fast now
  bleeds satisfaction.
- **Poaching** (daily): rivals' implied service level is 0.72 (0.80 with
  Primely, 0.88 with Primely Now). Where `s.satisfaction` lags it, you lose
  `customers × 0.03 × min(2, pressure) × gap` per day. Row field `row.poached`.
- **Complacency**: if average daily revenue > $5k and total marketing spend
  < 1.2% of it (and no national campaign), awareness decay steepens
  (×0.975/day instead of ×0.986) and snarky news fires occasionally.
- **Diseconomies of scale**: `costScale(state)` (export) =
  `1 + 0.18·log10(max(1, lifetimeRevenue/5e5))` — multiplies **rent and all
  wages** (staff + execs). ≈×1.05 at $1M, ×1.23 at $10M, ×1.42 at $100M,
  ×1.6 at $1B.
- **Emergency debt instead of instant death**: cash may go negative; the bank
  charges **0.15%/day interest on the overdraft** (row field `row.interest`,
  cumulative `state.debtInterestPaid`). **Bankruptcy at cash < −$50,000**
  (was −15k). Warning news at first dip and nagging below −30k.

### 1.3 UI needs (wave 2)

- **Competition panel** (new tab or Research-tab section): per settlement,
  render `state.competition[sid]` — pressure meter, your share vs rival share
  bars, top rival (name+color from `RIVALS`), trend arrow, PRICE WAR badge.
- **Rival dossier**: for each `state.rivals` agent show posture, focus markets
  (`focusSids` → settlement names), `lastMove.desc`, and active/dormant
  (tease Primely as "???" until active).
- Surface `state.expectedDeliveryDays` next to the on-time stat ("shoppers
  expect ≤ N-day delivery").
- Debt: when cash < 0, show overdraft interest and the −$50k line.

---

## 2. Physical goods in stores

### 2.1 Rules

- **Online** channel: own products sell from the central warehouse pool
  (`p.inventory`, unchanged); catalog products **dropship** (never stock out,
  cost `p.cost` = base×1.62).
- **Physical stores sell ONLY what's on their shelves** (`store.stock`).
  Shelf stock comes from the central pool via a **daily allocation** run:
  each auto-replenish store pulls each listed product up to
  `max(4, ceil(recentDailySales×4))` units, limited by the central pool and by
  `storeLogisticsCap(state)` (export) =
  `(40 + 60/warehouse + 10/shipping-crew) ×1.6 if COO stationed × automation mult`.
- **Wholesale flow for catalog items**: `orderWholesale(state, productId, qty)`
  (export) — min 20 units, unit price `p.wholesaleCost` (= base cost ×1.15 —
  much better than dropship's ×1.62), bulk discounts 8%/15% at 200/500 units,
  arrives by sea+lorry exactly like own stock (`p.incoming`, boat anim).
  This inventory feeds stores; online catalog sales still dropship.
- **Cash-flow accounting fix** (affects the whole game): inventory is paid for
  **when ordered**; sales of stocked goods no longer deduct COGS from cash a
  second time. `row.profit` remains the accrual view
  (revenue − booked COGS − costs); daily cash movement is
  revenue − *cash* COGS (dropship + export production) − costs.
- **Stockouts hurt locally**: if a store misses >30% of ≥3 demanded units in a
  day, that settlement loses satisfaction (−0.006) and awareness (×0.997), and
  the misses count into `missedStock` / `p.missedToday` / `store.missedToday`.
- `p.autoRestock` now also works for catalog products (reorders 200 wholesale
  when pool+inbound < 40, only if you have a store).
- Franchise stores (see §5) are exempt — franchisees self-stock.

### 2.2 State (per store premise, kind 'store')

```js
{ id, sid, kind:'store', level, construction?,
  stock: { [productId]: units },   // shelf inventory
  recent: { [productId]: ema },    // demand forecast (EMA of daily demand)
  autoReplenish: true,             // toggleStoreReplenish(state, premId) flips
  serviceLevel: 0..1,              // EMA of demand met — the service readout
  missedToday: n,                  // missed store sales today
  demandToday: n, metToday: n,     // today's raw counters (internal)
  franchise: false }               // true for franchisee-run stores
```

Catalog products changed: `inventory: 0` (was `null`), plus `incoming: []`,
`autoRestock: false`, `missedToday: 0`, `wholesaleCost: n`.
**UI note:** dropship-vs-stocked is now signalled by `p.source === 'catalog'`,
NOT by `inventory === null`.

### 2.3 UI needs

- Store card: shelf stock table (product → units), **service-level readout**
  (`serviceLevel`, color-code <0.85), auto-replenish toggle
  (`toggleStoreReplenish`), logistics cap (`storeLogisticsCap(state)`).
- Product card (catalog): "dropship $X/unit (online)" + "wholesale $Y/unit
  (stores)" + `WHOLESALE ×200` button (`orderWholesale`), stock line, auto
  checkbox (mirrors own products).
- Stockout alert should now include catalog+listed products with
  `inventory <= 0` **when the player has stores**.

---

## 3. Executive pawns

### 3.1 Exports & state

```js
export const EXEC_ROLES = {
  ceo:      { name:'CEO', icon:'🎩', salary:0,   hireCost:0,    desc:... },
  cmo:      { name:'CMO', icon:'📣', salary:260, hireCost:8000, desc:... },
  coo:      { name:'COO', icon:'⚙️', salary:300, hireCost:9000, desc:... },
  research: { name:'Head of Research', icon:'🔬', salary:240, hireCost:7500, desc:... },
  retail:   { name:'Retail Director', icon:'🏬', salary:220, hireCost:7000, desc:... },
};
hireExec(state, role)        → {ok, msg?}   // one per role; CEO not hireable
fireExec(state, execId)      → {ok, msg?}   // CEO not fireable
assignExec(state, execId, sid|null) → {ok, days?, msg?}  // null → back to HQ
stationedExec(state, role)   → exec|null    // hired AND not travelling

state.execs = [ { id:'exec-<role>', role, name, sid } ]
  // CEO is always present; newGame seeds them, chooseHq sets ceo.sid = hq.
  // sid === null means "in transit".

state.execTravels = [   // RENDERER HOOK — same walk semantics as state.surveys
  { execId, role, name, fromSid, sid,   // sid = destination settlement id
    path,                               // findRoute(world, from, to) → [{x,y},…]
    daysLeft, totalDays }               // sim ticks daysLeft daily; walk
]                                       // fraction = 1 - daysLeft/totalDays
```

Salaries are paid daily (scaled by `costScale`). Effects apply only while
stationed (not travelling):

| Exec | Stationed effect |
|---|---|
| CEO | Awareness gain ×1.5 in that settlement; store capture ×1.15 there. Always somewhere (default HQ). |
| CMO | Marketing awareness gain ×1.35 for all settlements within 15 tiles. |
| COO | Global: ship capacity ×1.25, store replenishment ×1.6. Local: +0.002 satisfaction/day where stationed (if store there). **Gates automation purchases.** |
| Head of Research | At HQ: R&D speed ×1.6. Elsewhere: passive survey — unresearched settlements within 12 tiles gain 4%/day progress (`state.passiveSurvey[sid]` 0..1) until `researched` flips true (free, with news). |
| Retail Director | Store conversion ×1.3 where stationed. **Hiring one unlocks Flagship (level-2) refits outside the HQ settlement** — `upgradeStore` rejects those otherwise with msg "Hire a Retail Director…". |

Travel: `days = max(1, round(1 + distance/9))`; departure & arrival both push
news lines (so the wave-1 build shows something without renderer changes);
arrival is where the renderer should later animate a walker along
`execTravels[i].path` exactly like survey walkers.

### 3.2 UI needs

- **Exec management panel** (Staff tab section or new tab): one card per
  `EXEC_ROLES` — hire button (cost/salary), current station (settlement name
  or "travelling, N days"), reassign flow (pick settlement → `assignExec`),
  fire button. Show per-role effect blurbs (`desc`).
- Settlement modal: list execs stationed here; "station exec here" shortcut.

---

## 4. Living towns

- Monthly (dom 1) every settlement's pop drifts by a **local economy score**:
  your store (level-weighted), warehouse, HQ, happy customers, stationed
  execs, and even rival presence add jobs; price wars subtract. Annualized
  growth clamped to **+4.5%/yr villages, +3.5% towns, +2% cities** (shrink
  caps 3% / 3% / 1.5%). Neglected settlements drift slightly downward.
- **Tier changes** with 3% hysteresis around thresholds
  (`TIER_THRESHOLDS = { town: 9000, city: 70000 }`, exported from world.js and
  re-exported from sim.js along with **`tierOf(settlementOrPop)`**):
  `s.type` actually changes (rents, marketing profiles, costs all follow),
  news + `pendingEvent` fire, and **`s.grewTick = state.day`** or
  **`s.shrunkTick = state.day`** is set — RENDERER HOOK for a
  growth/decline flourish (compare against current `state.day`; fields are
  `null`/absent until first change).
- Strategy consequence: investing in a village you love can grow it into a
  town (bigger segments pool multiplier via pop) — positive feedback the
  player can build around.

**UI needs**: settlement modal + research cards should show tier & pop trend
(pop is now dynamic — show `tierOf(s)` and recent growth if you cache pops);
toast/news already fire on tier change.

---

## 5. The road to $1B

### 5.1 Goal ladder (`GOALS` export, extended)

| id | trigger | reward / effect |
|---|---|---|
| … first 7 unchanged … | | |
| `ipo` | $1M lifetime revenue | **+$250,000 capital injection**; unlocks franchising, national campaigns, automation, brand tiers, exports. Prestige news + confetti. NOT the win. |
| `acquire` | $10M lifetime | Unlocks `acquireRivalOps` (see below). |
| `empire` | $100M lifetime | "Category King": `brandFocus()` bonus floors at 1.05 (scatter penalty waived); label "Empire" when ≥5 categories listed. |
| `billion` | **$1B lifetime** | **THE WIN**: sets `state.won = true`, `state.wonDay`; game keeps running (sandbox). Confetti + news. |

**UI needs**: goal ladder display (replace flat list with a "road to $1B"
ladder); a **win screen** when `state.won` first flips true (main.js should
drain it like the old ipo modal — coordinate with main.js owner; `pendingGoal`
with id `billion` fires exactly once, so the existing pendingGoal drain is a
sufficient trigger). The old `modalIpo` copy must change: IPO is a milestone
("this is the starting line"), not an ending.

### 5.2 Post-IPO scalers (all gated on `goalsDone.includes('ipo')`)

```js
// constants (exports)
NATIONAL_CAMPAIGN = { cost: 150000, days: 21 }
AUTOMATION_TIERS  = [ {name,cost:400k,mult:1.5}, {…1.2M,2.2}, {…4M,3.5} ]
BRAND_TIERS       = [ {name:'Premium Label',cost:300k}, {'Luxury House',1.5M}, {'Icon Status',6M} ]
EXPORT_LEVELS     = [ {cost:200k,perShipment:32k}, {450k,75k}, {1M,170k}, {2.2M,380k},
                      {5M,850k}, {11M,1.9M}, {24M,4.2M}, {52M,9M} ]   // 8 levels
ACQUISITION_COST  = 2000000

// actions (exports, all return {ok, msg?})
setFranchising(state, on)        // toggle; state.franchising
startNationalCampaign(state)     // activeEvents {key:'national', name:'National Campaign', demandMult:1.12}
buyAutomation(state)             // REQUIRES a hired COO; state.automation 0..3
buyBrandTier(state)              // state.brandTier 0..3
upgradeExport(state)             // sign (0→1) or upgrade; at max level = renegotiate for 10% of top cost
acquireRivalOps(state, rivalId)  // once ever; requires 'acquire' goal + $2M
```

- **Franchising** (`state.franchising`): monthly (dom 14), in a settlement
  with no store, satisfaction > 0.72, awareness > 0.4, customers > 1.5% pop —
  60% chance a franchise store opens (premise `{kind:'store', franchise:true,
  level:0}`, no construction). You bank a **$15k fee** and an **8% royalty**
  on its sales (`row.franchiseRev`); no rent, no stock management, capture
  ×0.8. Cap 40 franchises.
- **National campaigns**: 21 days, island-wide awareness +0.028/day and
  demand ×1.12; visible in `activeEvents` (top-bar weather slot picks it up
  automatically).
- **Automation** (COO-gated): multiplies ship capacity AND store logistics
  capacity (×1.5/2.2/3.5).
- **Brand tiers**: price power — perceived fair value ×(1+0.06·tier) and
  product appeal source-mod ×(1+0.04·tier); exports ×(1+0.1·tier).
- **Exports** (`state.exportContract = { level, nextShipDay, lastUpgradeDay }`):
  requires port + ≥1 own product + satisfaction ≥ 0.7. Every 7 days a
  shipment books `perShipment × qualityMult(0.7–1.3, from own-product quality)
  × repMult(0.6–1.15, from satisfaction) × brand × staleness` revenue at 55%
  COGS, pushes a `boatAnims` freighter, occasional news. **Staleness**:
  contracts erode 0.4%/day starting 180 days after the last upgrade
  (floor 25%) — coasting kills the annuity; at max level `upgradeExport`
  renegotiates for $5.2M to reset it. Row field `row.exportRev`.
- **Acquisition**: pay $2M, pick an active rival — its presence collapses
  (×0.15) in its 2 strongest markets and you gain a level-1 store in each
  (instant, no construction) + awareness. Once per game
  (`state.acquiredRival = rivalId`).

**UI needs**: a post-IPO "SCALE" panel with: franchising toggle + franchise
list/royalty stat, national-campaign button (+active countdown), automation
tier buy (COO gate messaging), brand tier buy, export contract card (level,
next shipment day, staleness warning when
`day - lastUpgradeDay > 180`, upgrade/renegotiate button), acquisition flow
(rival picker) once `acquire` goal is done. Everything degrades gracefully
pre-IPO — the sim returns `{ok:false, msg}` with clear copy.

`fmtMoney` now formats billions (`$1.23B`).

### 5.3 Pacing (validated)

- Decent (steady) play: IPO ≈ day 350–420 ($1M), $10M ≈ day 1000.
- Strong play: $100M ≈ day 1900–3500, **$1B ≈ day 2500–4300**.
- Stalling after profitability is fatal: the coaster bot (froze at $5M) went
  bankrupt between day 1400–3600 across seeds via margin compression,
  poaching, awareness fade, contract staleness, scaled costs and the debt
  spiral.
- Global demand constant is now `pop × 0.00058` (was 0.00072) and awareness
  gain coefficient 0.017 (was 0.02) — early game is a touch slower to fit the
  IPO window.

---

## 6. Full delta of exports & state fields

### New exports (sim.js)
`migrateSave(state)` · `costScale(state)` · `orderWholesale(state,pid,qty)` ·
`storeLogisticsCap(state)` · `toggleStoreReplenish(state,premId)` ·
`EXEC_ROLES` · `hireExec(state,role)` · `fireExec(state,execId)` ·
`assignExec(state,execId,sid|null)` · `stationedExec(state,role)` ·
`NATIONAL_CAMPAIGN` · `AUTOMATION_TIERS` · `BRAND_TIERS` · `EXPORT_LEVELS` ·
`ACQUISITION_COST` · `PRIMELY_ENTRY_REVENUE` · `PRIMELY_PRIME_REVENUE` ·
`setFranchising` · `startNationalCampaign` · `buyAutomation` · `buyBrandTier` ·
`upgradeExport` · `acquireRivalOps` · `tierOf` · `TIER_THRESHOLDS`
(last two re-exported from world.js, which also exports them directly).

### New/changed state fields (v4)
`v:4` · `won` · `wonDay` · `rivals` · `rivalPresenceBy` · `priceWars` ·
`competition` · `compSnapshots` · `execs` · `execTravels` · `passiveSurvey` ·
`expectedDeliveryDays` · `franchising` · `automation` · `brandTier` ·
`exportContract` · `acquiredRival` · `debtInterestPaid` ·
store premises: `stock/recent/autoReplenish/serviceLevel/missedToday/franchise` ·
catalog products: `inventory:0/incoming/autoRestock/missedToday/wholesaleCost` ·
settlements: `grewTick/shrunkTick` (and `pop`/`type` are now mutable) ·
history rows: `+interest +exportRev +franchiseRev +poached`.

### Changed semantics (heads-up for existing UI)
- Bankruptcy at **−$50k** (was −15k); old "−$15,000" copy in ui.js/debt news
  is stale (sim's own news line is updated).
- Catalog `inventory` is `0`, not `null` — don't branch on null.
- `GOALS` has 11 entries (was 8); `ipo` reward is now $250,000.
- `state.rivalPresence` remains the aggregate map the renderer reads — but
  values can reach ~4–6 in hot markets (was ≤2.6); the existing pip
  thresholds (>1.2 red) still work.
- On-time is judged against `state.expectedDeliveryDays`, not the
  `EXPECTED_DELIVERY_DAYS` constant.
- `row.profit` is accrual profit; cash delta differs by inventory purchases
  (paid at order) and no longer double-charges stocked COGS.
- Office/warehouse rents and wages shown in the Dashboard "fixed costs" panel
  should be multiplied by `costScale(state)` to match what's charged.
- Exec salaries are part of `row.wages`.

### Renderer hooks (wave gfx)
- `state.execTravels` — walkers like surveys (shape above; walk fraction
  `1 − daysLeft/totalDays`, no 75%-interview plateau needed, but reusing the
  survey walker rendering verbatim looks fine). Distinct sprite tint per role
  is a nice-to-have (`EXEC_ROLES[role].icon`).
- `s.grewTick` / `s.shrunkTick` — day stamps for town growth/decline FX.
- `state.competition[sid].priceWar` — flag for a "price war" overlay on the
  settlement; `state.priceWars[].sid` equivalent.
- `s.pop` and `s.type` change over time — settlement label/building-cluster
  size should re-derive rather than cache forever.
- Everything new also pushes ordinary `news` lines and (where celebratory)
  `fxAnims:{kind:'confetti'}`, so the wave-1 renderer shows signs of life
  without changes.

---

## 7. Balance harness

`scripts/balance-test.mjs` — headless Node, no DOM. Four scripted bots
(idle / steady / aggressive / coaster) run up to 5,200 sim days each
(~3 s total). Exit code 0 iff all four acceptance criteria hold. Run it after
ANY constant change:

```
node scripts/balance-test.mjs          # seed 12345 (canonical)
node scripts/balance-test.mjs 777      # robustness seeds: 777, 424242 also pass
```
