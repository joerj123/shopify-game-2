# PORT_SPEC — Shopify Tycoon → Three.js rebuild

Single source of truth for rebuilding the presentation layer (renderer + HTML UI)
of the original vanilla-JS/Canvas-2D game. The simulation modules —
`src/sim.js`, `src/world.js`, `src/rng.js`, `src/data/catalog.js` — are copied
**verbatim** into this repo and MUST NOT be changed. `src/sprites.js` in the
original exports `drawProductSprite(canvas, product)` and `hashCode(str)`;
**`sim.js` imports `hashCode` from `./sprites.js`**, so any rebuilt sprites
module must keep exporting `hashCode` with the same FNV-1a implementation:

```js
export function hashCode(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
```

---

## 0. Architecture & game loop (main.js behavior to reproduce)

```js
import { newGame, simulateDay, chooseHq, pushNews, fmtMoney } from './sim.js';
const SAVE_KEY = 'shopify-tycoon-save-v1';
const DAY_MS = { 1: 1400, 3: 550, 8: 180 };   // ms of real time per sim day, per speed
```

- `Game` holds: `state` (from `load()` or `newGame()`), `speed` (1|3|8),
  `paused` (bool), `modalPause` (bool), `jukebox`, `renderer = new MapRenderer(canvas, state)`,
  `ui = new UI(game)`, `accum` (ms accumulator), `ipoShown = state.goalsDone.includes('ipo')`.
- Boot sequence: bindInput → `renderer.resize()` (+ on window `resize`) →
  `ui.renderTop(); ui.renderPanel(true); ui.renderTicker();` → if `!state.hq`
  run onboarding (paused), else `paused = false` → `requestAnimationFrame(frame)`
  → `setInterval(save, 20000)` autosave.
- **Frame loop**: `dt = min(0.1, (t - lastT)/1000)`. If not paused, not
  modal-paused, `state.hq` set, and not `state.gameOver`: `accum += dt*1000`;
  while `accum >= DAY_MS[speed]` (max **4 steps per frame**): call
  `simulateDay(state)` which returns a metrics `row` (or null).
  - If `row.revenue > 0` and `Math.random() < 0.25` → sfx `'kaching'`.
  - Drain `state.pendingGoal` → `ui.showGoal(g)`; if `g.id === 'ipo'` and not
    yet shown → `ui.modalIpo()` once.
  - Drain `state.pendingQuest` → `ui.showQuest(q)`.
  - Drain `state.pendingEvent` → `ui.showEvent(ev)` + sfx `'goal'`.
  - If `state.gameOver` → `save()` then `ui.modalGameOver()`.
  - After ≥1 step: `ui.renderTop(); ui.renderPanel(); ui.renderTicker();`
- Always (even paused): `renderer.draw(dt)` each frame.
- `pauseForModal(on)` sets `modalPause` — UI calls this from `modal()`.
- `setSpeed(sp)`: sp=0 pauses (`#speed-pause` gets `.active`), else
  `paused=false; speed=sp` and `#speed-${sp}` gets `.active`; all
  `.pxbtn.speed` first lose `.active`.
- Keyboard (ignored when target matches `input,select,textarea`):
  `Space` toggles pause (resumes at last speed), `1`→speed 1, `2`→speed 3, `3`→speed 8.

### Map input (on the map canvas / renderer surface)
- **Pan**: pointerdown starts drag `{x, y, camX, camY}`; on move, convert pixel
  delta to tile delta by inverting iso projection (original 2D:
  `dTx = (dpx/16 + dpy/8)/2; dTy = (dpy/8 - dpx/16)/2` with `dpx,dpy` divided
  by `cam.zoom`); clamp `cam.x` to `[0, world.w]`, `cam.y` to `[0, world.h]`.
  A move of >6px (manhattan) marks the gesture as a drag (suppresses click).
  Canvas gets class `dragging` while down. Tooltip hides while dragging.
- **Hover**: `hit = renderer.hitTest(e.clientX, e.clientY)`; set
  `renderer.hover = hit`. If `hit.settlement`, show `#map-tooltip` positioned
  at `left = min(rectWidth-220, clientX-rect.left+14)`, `top = clientY-rect.top+10`
  with HTML:
  ```html
  <div class="tt-title">{name}</div>
  <div>{pop.toLocaleString()} people · {type}</div>
  <div class="tt-dim">awareness {round(awareness*100)}% · {customers.toLocaleString()} customers</div>
  <div class="tt-dim">{researched ? 'surveyed ✓' : 'not surveyed'} — click to inspect</div>
  ```
  else hide tooltip. Also hide on `pointerleave`.
- **Click** (pointerup, not a drag): if hit a settlement → sfx `'click'`; if
  `renderer.pickMode` → clear pickMode, hide `#map-hint`, remove canvas class
  `placing`, `chooseHq(state, settlement.id)`, then `afterHqPicked(settlement)`.
  Else if `state.hq` → `ui.modalSettlement(settlement)`.
- **Wheel**: `zoom *= (deltaY < 0 ? 1.12 : 0.89)`, clamped `[0.6, 4]`;
  preventDefault (passive:false).

### Onboarding (no HQ yet)
1. Paused. Modal (`noClose:true`): splash title "SHOPIFY TYCOON", sub
   "One garage. One island. 500,000 shoppers who've never heard of you.",
   company-name text input `#company-name` (maxlength 20, default "Acme Goods"),
   dice button `#name-dice` picking a random name from
   `['Acme Goods','Cardboard & Co','Maple Supply','Sundry Club','Parcel Palace','Nice Things Inc','The Goods Dept','Otter Outfitters','Big Little Shop','Crate Expectations']`,
   an explainer paragraph, and `#ob-go` "CHOOSE HEADQUARTERS →".
2. On go: store `companyName` (trimmed, fallback 'Acme Goods', sliced to 20),
   close modal, `renderer.pickMode = true`, canvas class `placing`, show
   `#map-hint` with "CLICK A SETTLEMENT TO PLACE YOUR HQ<br>…cities: rich
   shoppers, brutal rent & rivals · villages: cheap & sleepy · towns: the smart start".
3. `afterHqPicked(settlement)`: `ui.renderTop(); ui.renderPanel(true)`, sfx
   `'goal'`, center camera on the settlement (`cam.x = s.x; cam.y = s.y`),
   `renderer.celebrate(settlement.id)`, then a "WELCOME TO {NAME}" modal
   (noClose) showing starting cash via `fmtMoney(state.cash)` and pointing at
   the FIRST STEPS checklist; its `#welcome-go` button closes, `setSpeed(1)`,
   and `pushNews(state, 'Day one. The garage smells like cardboard and ambition.')`.

### New-game confirm (`#new-btn`)
Modal with `#ng-cancel` (close) and `#ng-go` → `restart()` =
`localStorage.removeItem(SAVE_KEY); location.reload()`.

### Persistence
- `save()`: no-op unless `state.hq`. Serializes
  `{ ...state, shipAnims: [], boatAnims: [], fxAnims: [], pendingGoal: null, pendingQuest: null, pendingEvent: null }`
  with `world.tiles`/`world.elev` converted via `Array.from` (they are
  `Uint8Array`/`Float32Array`). `JSON.stringify` → localStorage.
- `load()`: parse; **reject saves where `s.v !== 3`** (return null → new game).
  Restore `world.tiles = Uint8Array.from(...)`, `world.elev = Float32Array.from(...)`,
  reset `shipAnims = []; boatAnims = []; fxAnims = []`.

### Music button behavior
`#music-btn` click: if jukebox off → `start()`, add `.active`,
`ui.flashNote('♪ ' + trackName)`; else `nextTrack()` and flash new name.
`dblclick` → `stop()`, remove `.active`, flash '♪ off'. Jukebox interface used:
`enabled`, `start()`, `stop()`, `nextTrack()` (returns name), `trackName`,
`sfx(name)` with names used across the app: `'kaching'`, `'goal'`, `'click'`,
`'build'`, `'bad'`.

---

## 1. RENDERER CONTRACT

### 1.1 Public interface (exactly what main.js/ui.js call)

```js
class MapRenderer {
  constructor(canvas, state)      // canvas = #map element; keeps state reference
  cam = { x: state.world.w/2, y: state.world.h/2, zoom: 1.4 }   // tile-space camera, zoom clamped [0.6, 4] by input code
  mode = 'terrain'                // 'terrain' | 'business' — set directly by main.js mode buttons
  hover = null                    // set directly by main.js to hitTest() result (or null)
  pickMode = false                // truthy during HQ placement; renderer draws pulsing rings on ALL settlements
  resize()                        // re-reads canvas bounding rect; dpr = min(2, devicePixelRatio); sets canvas.width/height = rect * dpr
  draw(dt)                        // renders one frame; dt in SECONDS; ALSO ADVANCES/PRUNES state.shipAnims, state.boatAnims, state.fxAnims
  hitTest(clientX, clientY)       // → { tile: {x, y}, settlement: SettlementOrNull }
  celebrate(sid)                  // pushes a ~1.4 s confetti-ring burst at settlement sid's tile position
}
```

`hitTest` uses `settlementAt(state.world, tx, ty)` from world.js: picks the
nearest settlement whose distance ≤ its click radius (city 2.6, town 1.9,
village 1.4 tiles). `tile` is fractional tile coords under the cursor.

**Camera model** (original): isometric diamond, tile width `TW=32`px, height
`TH=16`px, elevation step `EL=9`px per level, world drawn into a big
prerendered per-season canvas; camera centers screen on
`iso(cam.x, cam.y)` scaled by `cam.zoom * dpr`. A Three.js port only needs
to preserve: tile-space cam coords, the zoom range, the pan inversion in
main.js (or replace with its own equivalent input handling), and `hitTest`
returning fractional tile coords + settlement.

**Elevation levels** (used to place things at the right height, and useful for
3D terrain): per tile `lvl`: WATER→0, BRIDGE→1, MOUNTAIN→5, HILL→3, else
grass/sand/forest→ `elev < 0.45 ? 1 : 2`.

### 1.2 Game state the renderer READS (exact shapes)

```js
state.world = {
  seed,                    // number
  tiles,                   // Uint8Array(w*h), codes T = {WATER:0, SAND:1, GRASS:2, FOREST:3, HILL:4, MOUNTAIN:5, ROAD:6, BRIDGE:7}
  elev,                    // Float32Array(w*h), raw noise elevation ~[-0.x .. 1]
  settlements,             // array, see below
  roads,                   // array of paths [{x,y},...] (informational; original renders roads from tile codes, not this)
  port,                    // {x, y} or null — harbour tile (quay, crane, container stacks, pier toward adjacent water)
  seaLane,                 // [{x,y}, ...] water tiles from MAP EDGE (index 0) to the tile beside the port (last) — freighter route
  w: 72, h: 52,            // MAP_W, MAP_H
}

settlement = {
  id: 's0'…,  name, type: 'city'|'town'|'village', x, y, pop,
  wealth,                  // city 0.95–1.35, town 0.8–1.1, village 0.6–0.95
  onlineAffinity,          // city .65–.85, town .4–.6, village .18–.38
  segments,                // {segKey: weight} normalized mix over the 6 SEGMENTS
  researched: false,       // true after survey completes
  awareness: 0,            // 0..1
  customers: 0,
  satisfaction: 0.72,
}

state.hq                   // settlement id string or null
state.premises             // [{id, sid, kind:'office'|'store'|'warehouse', level, construction?}]
                           //   construction = { daysLeft, totalDays, isNew?: true, toLevel?: n }
state.seed                 // used to seed deterministic decoration RNG
state.shipAnims            // vans & lorries — see 1.5
state.boatAnims            // laden freighters — see 1.6
state.fxAnims              // one-shot screen fx — see 1.9
state.surveys              // walking researchers — see 1.7
state.activeEvents         // renderer looks for {key:'storm', stormCenter:{x,y}} to draw storm cloud+rain+lightning
state.rivalPresence        // { [sid]: number } — business-mode red pip
```

The renderer also calls `calInfo(state)` (from sim.js) every frame to get
`{month, dom, year, season, dayOfYear}`. **Season/weather derivation**:
- `season` from month: 3–5 spring, 6–8 summer, 9–11 autumn, else winter.
- Winter → falling snow overlay (~110 flakes, screen-space, drifting sinusoidally)
  and a blue tint `rgba(10,14,40,.1)`; autumn tint `.05`; others none.
- December (`cal.month === 12`) → festive twinkling lights near every
  settlement: 6 dots per settlement in colors `['#ff5c5c','#ffd24d','#6ee06f','#5ac8e0']`,
  each twinkling on `sin(time*3 + i*1.9 + s.x)` with threshold 0.4.
- Storm events → dark cloud blobs around `stormCenter` (5 wobbling ellipses),
  animated rain streaks, and random lightning flash (`Math.random() < 0.02` per frame).

### 1.3 Terrain look (per-season palettes)

Terrain is prerendered once per season and cached. Season palettes (keys:
`grass, grass2, grassLight, forest, sand, rock, snowcap, water, water2, road,
roadDark, dirtSide, dirtSide2, deep, sky, farm, farmRow`):

- spring: grass `#579c46`, forest `#2e6b34`, water `#2e64a6`, sky `#16294a`, farm `#a5854f` …
- summer: grass `#63aa4a`, forest `#2f7434`, water `#2d6db2`, sky `#173154` …
- autumn: grass `#99943f`, forest `#8a5f27` (whole map goes gold/brown), water `#2e5e96`, sky `#141F3E` …
- winter: grass `#d5dde6` (snow-covered), forest `#5b7263`, water `#254c7d`, sky `#101c38` …
(Full palette table is in original render.js lines 13–18; copy values if exact
parity is desired.)

Terrain features to reproduce:
- Water tiles at level 0; land tiles extrude with cliff sides down to sea
  level; strata lines on cliffs ≥2 levels; coastal water darker.
- **Farmland**: deterministic ring of farm tiles around towns/villages
  (not cities): flat GRASS tiles at manhattan distance 3–6 from center where
  `((x*73856093)^(y*19349663)) % 5 < 2`, drawn with row-line texture.
- Seasonal grass decoration (hash-based): spring flowers
  `['#e8657f','#f2ce4e','#e8e5f0','#c777e0']`, summer light patches, autumn
  fallen-leaf dots.
- FOREST tiles: 2–3 layered pine trees (seeded RNG `makeRng(seed ^ tileIndex)`),
  snow-capped in winter.
- MOUNTAIN tiles: variety by `hash % 5` — rocky peak (with snowcap if tall or
  winter), boulders, or grass patch.
- ROAD/BRIDGE: roads drawn as connected ribbons (rounded line strokes 9px dark
  under 6px light) between road-neighbors in +x/+y directions; bridges get
  wooden colors (`#523f2a`/`#8a6f4d`), pilings into the water, plank seams,
  railing highlight. Occasional center-line dashes on straight road.
- **Towns**: per settlement, deterministic building cluster
  (`makeRng(seed ^ (x*977 + y*331))`): city 15 buildings spread ±2.3 tiles,
  town 8 spread ±1.5, village 4 spread ±0.9. Cities get 40%-chance towers
  (height 24–44 px vs houses 8–15). Wall colors from
  `['#b3a08a','#a08e7d','#8f95a5','#c0ab90','#9b8871']`, roofs from
  `['#b34a38','#94573f','#5d6b7d','#7a8560','#8a5f68']`, 70% gabled, 75% have
  lit windows (`#ffd76b`), 45% of gabled houses have chimneys → chimney list
  feeds an ambient smoke-particle system (puffs spawn randomly, ~6/sec chance,
  max 50, live 4 s). Winter roofs go white.
- **Port** (if `world.port`): concrete quay diamond, wooden pier extending
  1.6 tiles toward the adjacent WATER neighbor, 4 colored container boxes
  (`['#c85a3a','#3a7ac8','#c8a23a','#5aa05a']`), yellow gantry crane
  (`#d8b13a`) with hanging red container, grey warehouse shed.

### 1.4 Player premises rendering (reads `state.premises`)

All premises are drawn at fixed offsets from their settlement center:
- `office` at `(s.x - 0.9, s.y - 0.9)` — Shopify-green tower; height/halfwidth
  by `level`: h `[26,46,70]`, hw `[8,10,13]`; colors box
  `('#a6d45e','#527f2b','#3c611d')` with `#95bf47` roof inset, amber windows,
  and a waving green flag (`sin(time*4)` wobble).
- `store` at `(s.x + 1.1, s.y + 0.6)` — pink/purple shop; h `[12,19,30]`, hw
  `[7,9.5,12]` by level; box `('#ef8ec2','#9a55ad','#7a4090')`, candy-stripe
  awning (`#fff`/`#e06fae`), lit doorway, white sign.
- `warehouse` at `(s.x - 1.2, s.y + 1.0)` — grey gabled shed hw 12 h 14, box
  `('#8b93a1','#68707e','#515966')`, roof gable `('#a2aab8','#7d8592')`, dark
  loading door, small light.

**Construction states**:
- `pr.construction && pr.construction.isNew` → draw a construction site
  *instead of* the building: dirt pad, half-built frame whose height =
  `fullH * (1 - daysLeft/totalDays)` (store fullH 12 hw 7, warehouse fullH 14
  hw 12), orange scaffold poles + braces, animated crane (jib sways on
  `sin(time*1.3)`), yellow/black striped site barrier.
- `pr.construction` without `isNew` (an upgrade) → building draws normally
  **plus** a crane beside it (the premise keeps trading).

### 1.5 Vans & lorries — `state.shipAnims`

Pushed by sim.js; **renderer advances and prunes them**:

```js
// van (daily deliveries, batched one per route):
{ key: `${nodeId}-${settlementId}`, kind: 'van',   path, units, t: 0, dur: 4 + path.length/3 }
// lorry (container from port to warehouse):
{ key: `lorry-${productId}-${day}`, kind: 'lorry', path, units, t: 0, dur: 5 + path.length/4 }
```

- `path` = `findRoute(world, from, to)` → array of `{x,y}` tiles (roads
  preferred; may be a 2-point straight line fallback; long paths are thinned).
- Each frame: `a.t += dt / a.dur`; position = linear interpolation along path
  at fraction `min(0.999, t)`, tile pos +0.5 centering; remove when `t >= 1`
  (`shipAnims = shipAnims.filter(a => a.t < 1)`).
- Sim caps: max 8 concurrent van anims, 10 incl. lorries; only routes with
  ≥3 units, top 5 by volume, one per unique `key` per day.
- Visual: drop shadow ellipse; cargo box — lorry `('#d07a3a','#a85a24','#7e441c')`
  (orange container), van `('#f0ece0','#c9c4b4','#95bf47')` (white w/ green);
  "big" (lorry or `units >= 20`) hw 6/h 7 else hw 4/h 5; white cab placed at
  the leading end (heading = sign of `(dx - dy)` screen-right), windscreen,
  wheels, headlight dot.

### 1.6 Freighters — `state.boatAnims` + ambient ferry

```js
{ t: 0, dur: 10 + seaDays*2, qty }    // pushed by orderStock(); max 4 concurrent
```

- Sail along `world.seaLane` from edge (t=0) to port (t=1); renderer advances
  `b.t += dt/b.dur`, prunes at `t >= 1`.
- Ambient: renderer keeps a private `_ferry = {t, dur: 60}` spawned randomly
  (`Math.random() < dt * 0.02`) so the sea is never dead; drawn *unladen*.
- Ship visual: dark hull `#2e3a4a` with red waterline `#c8503a`, white bridge
  tower, funnel smoke puffs, animated wake ellipses; **laden** ships (boatAnims)
  carry 3 colored deck containers `['#c85a3a','#3a7ac8','#c8a23a']`.

### 1.7 Survey researchers — `state.surveys`

```js
{ sid, path, daysLeft, totalDays }   // path = findRoute(world, hq, settlement)
```

Renderer does NOT mutate these (sim ticks daysLeft daily). Walk fraction =
`min(1, (1 - daysLeft/totalDays) / 0.75)` — i.e. the walker covers the path in
the first 75% of the duration, then stands at the destination "interviewing"
(bob stops, a bobbing white `?` speech bubble appears). Visual: tiny pixel
person — navy legs, hi-vis `#e0a83a` jacket, skin `#e8c49a` head, brown
clipboard; leg-bob `|sin(time*7)| * 1.2` while walking.

### 1.8 Celebrations (renderer-local, via `celebrate(sid)`)

`celebrations: [{x, y, t}]` — 12 confetti squares in
`['#95bf47','#ffd24d','#5ac8e0','#e06fae']` exploding outward in a ring
(radius `prog*46`, rising, fading over 1.4 s). Used after HQ placement and by
`ui.celebrateUpgrade`.

### 1.9 Full-screen FX — `state.fxAnims`

```js
{ kind: 'confetti', t: 0 }   // pushed by sim on: flash sale start, BFCM start, any construction completing
```

Renderer advances `fx.t += dt`, prunes at `t >= 4`. Confetti = 140 lazily-
created particles `{x, y (starts above screen), v, c, w, spin}` in the same
4-color palette, falling with sinusoidal wobble, screen-space.

### 1.10 Ambient extras
- **Water sparkles**: ~12% of water tiles get a twinkling white dash (phase-
  offset sine). **Coast foam**: white dashes pulsing on every water tile
  adjacent to land. Both precomputed with `makeRng(seed ^ 0xaa11)`.
- **Cloud shadows + puffs**: 5 clouds (`makeRng(seed ^ 0x77)`), drifting
  +x/+y slowly, wrap at world edge; soft dark ellipse shadow on terrain plus
  translucent white puff cluster ~130 px above.
- **Birds**: up to 2 flocks of 3–6 quadratic-curve "wing" strokes crossing the
  screen, flapping (`sin(time*9)`).
- **Vignette**: radial darkening at screen edges; screen-wide sky gradient
  behind the map (palette `sky` → `deep`).

### 1.11 Settlement labels & business mode

Always: settlement name uppercase, pixel font 9px, centered below the town
(offset +30px for cities, +20 otherwise), on a dark pill `rgba(5,7,14,.72)`;
text `#c6e79b` if `s.customers > 0` else `#d8d4c4`.

**`mode === 'business'`** adds under each label a 44×15 dark box containing:
- **awareness bar** (green `#95bf47`): width `38 * s.awareness` over track `#333852`
- **penetration bar** (blue `#5ac8e0`): width `38 * min(1, s.customers / (s.pop * 0.15))`
- **competition pip** (right side, 4×11 px): from `state.rivalPresence[s.id]`;
  drawn only if > 0; color red `#ff6b6b` if > 1.2, amber `#ffb545` if > 0.6,
  else grey `#8d8fa8`.

**Pick/hover rings**: `pickMode` → pulsing green (`#95bf47`) ellipse ring on
every settlement (`radius TW + 2±2·sin(time*5)`). `hover.settlement` (when not
picking) → static amber `#ffd24d` ellipse ring (radius `TW*1.3 × TH*1.3`).

---

## 2. UI CONTRACT

### 2.1 Public interface consumed by main.js

```js
class UI {
  constructor(game)          // game exposes: state, jukebox, renderer, restart(), pauseForModal(on)
  renderTop()                // top bar stats
  renderPanel(force = false) // active sidebar tab; throttled to ≥900 ms between renders unless force;
                             //   skipped while a range slider is being dragged (unless force); preserves panel scrollTop
  renderTicker()             // news ticker
  modal(html, opts = {})     // fills #modal-box, shows #modal-root, game.pauseForModal(true); returns close();
                             //   unless opts.noClose, clicking the backdrop (#modal-root itself) closes
  modalSettlement(settlement)
  modalGameOver()
  modalIpo()
  showGoal(goal)             // amber toast in #goal-toast, 3.5 s, sfx 'goal'
  showQuest(quest)           // green toast, "+$reward", 2.8 s, sfx 'goal'
  showEvent(ev)              // #event-banner card {icon, name, days, desc}, 5 s
  flashNote(msg)             // red-bordered toast in #goal-toast, 2.2 s (error/info flash)
}
```

Internal `act(fn)` helper wraps every player action: runs `fn()` → sfx
`'build'` on ok / `'bad'` on fail → `flashNote(r.msg)` on failure →
`checkQuests(state)` and immediately show any `pendingQuest` →
`renderPanel(true)` + `renderTop()` → returns `r`.

### 2.2 Required DOM element IDs

Top bar: `#topbar`, `.logo`, `#stat-cash` > `#cash-val` (gets class `negative`
when cash < 0), `#stat-net` > `#net-val`, `#stat-date` > `#date-val`,
`#stat-weather` (hidden via `style.display` when no events) > `#weather-val`,
`#speed-pause`, `#speed-1`, `#speed-3`, `#speed-8` (all `.pxbtn.speed`),
`#music-btn`, `#save-btn`, `#new-btn`.

Map area: `#map` (canvas), `#map-modes` > `#mode-terrain`, `#mode-business`
(`.active` toggled), `#map-tooltip`, `#map-hint`, `#goal-toast`,
`#event-banner` (all use class `hidden` = `display:none !important`).

Sidebar: `#sidebar` > `#tabs` with six `button.tab[data-tab]` —
`dashboard 📊` (initially `.active`), `products 📦`, `stores 🏬`, `staff 👥`,
`marketing 📣`, `research 🔍` — and `#panel` (scrollable content area).

Footer: `#ticker` > `#ticker-inner`. Modal: `#modal-root` > `#modal-box`.

### 2.3 Top bar rendering (renderTop)

- `#cash-val` = `fmtMoney(cash)` **with the `$` stripped** (the `$` is a
  separate amber `.ico` span in HTML).
- `#net-val`: mean of `profit` over last 7 history rows →
  `▲ $X/d` (class `up`, green) or `▼ $X/d` (class `down`, red); `—` if no history.
- `#date-val` = `{seasonEmoji} {MONTHS[month-1]} {dom}, Y{year}` where emojis
  are `{spring:'🌱', summer:'☀️', autumn:'🍂', winter:'❄️'}`.
- `#weather-val` = names of `activeEvents` (those with `.name`) joined by ` · `;
  `#stat-weather` hidden entirely when empty.

### 2.4 Ticker

Last 6 items of `state.news` joined with `&nbsp;&nbsp;&nbsp;•&nbsp;&nbsp;&nbsp;`,
default text "Welcome to Shopify Tycoon." News strings contain HTML (`<b>`).
Only rewrite innerHTML when content changed (`el.dataset.html` guard) so the
CSS marquee animation (`ticker-scroll`, 30 s linear infinite) isn't reset.

### 2.5 Tabs / panels (exact set)

Tab click: switch `.active`, set `this.tab`, sfx `'click'`, `renderPanel(true)`.

#### DASHBOARD
- Title = company name.
- **First-steps quest card** (until all 5 `QUESTS` done): rows `✅/⬜ {icon} {desc}`
  with `+$reward` (or "paid").
- **Stockout alert banner** if any own+listed product has `inventory <= 0`:
  lists names, has a `[data-goto=products]` FIX button that programmatically
  clicks the products tab.
- **Six stat tiles** (2-col grid): Revenue/7d (`m.rev7`, delta % vs prior
  7 days), Profit/7d (`m.profit7`, green/red), Customers (`m.totalCustomers`,
  `+{m.new7} this week ({organic7} organic | all paid)`), CAC (paid)
  (`m.cac` or `—`), LTV (`m.ltv` with `LTV:CAC = X.X×` + `✓ healthy` ≥3 /
  `· thin` ≥1 / `✗ losing on ads`), On-time ship (`pct(state.onTime)`, plus
  `{queue} pkgs queued` or `queue clear`).
- **Three chart canvases**: `#ch-profit` (height 64, signed bar chart, green
  positive `#95bf47` / red negative `#ff6b6b`, zero midline, last 90 days of
  `history.profit`), `#ch-rev` (height 48, bars `#95bf47`, `history.revenue`),
  `#ch-cust` (height 48, bars `#5ac8e0`, `history.customers`). Both chart fns
  print the max value top-left ("1.2k" style) and "no data yet" when empty.
- **TODAY'S P&L** from last history row: Revenue ({orders} orders), − Cost of
  goods, − Rent, − Wages, − Marketing, − Refunds (if any), = Net profit,
  missed sales today / this week (if any).
- **DAILY FIXED COSTS**: one row per premise (`🏢/🏬/🏭 {settlementName}` +
  rent/d from `PREMISE_COSTS`), wages row (staff count), marketing row, total
  burn/day, and "Runway at current losses: N days" when 7-day net < 0
  (`floor(cash / -net7)`, red if < 30).
- **GOALS** list: every `GOALS` entry as `✅/⬜ {name}` + desc or "done".

#### PRODUCTS
- Buttons: `+ SOURCE FROM CATALOG` (`data-act=browse-catalog` → modalCatalog),
  `🔬 R&D` (`data-act=open-rnd` → modalRnd; disabled while `state.rnd`).
- "Product slots: {listed} / {listingCap(state)} listed" (red when full) + note.
- **Brand focus banner** (when ≥1 listed): from `brandFocus(state)` —
  `BRAND: {label.toUpperCase()}` colored good(≥1.08)/mid(≥0.96)/bad, top
  category share %, `appeal ×{bonus.toFixed(2)}`, explanatory note.
- **R&D progress card** while `state.rnd`: `🔬 Developing {category}` with
  `{pct}%` (clamped 0–99) and `~{ceil(daysLeft / (1 + engineers*0.45))} days left`.
- **Product cards** for every `state.products` entry:
  - 48×48 sprite canvas (`drawProductSprite`), name, badge OWN/CATALOG,
    category chip (bg `CATEGORIES[cat].color`) + `· season` + `· sports` suffixes.
  - Attribute pips: `STY/QUA/UTL/ECO/TEC`, `round(v*5)` filled `▮` of 5.
  - Stockout strip (own, listed, inventory ≤0): "🚨 OUT OF STOCK — missed
    ~{missedToday} sales today"; card border goes red.
  - **Price slider**: `min = max(1, ceil(cost))`, `max = round(msrp*2.2)`,
    live-updates `p.price` (direct mutation) and margin % display.
  - LIST/UNLIST button → `toggleListing(state, id)` (flash msg on failure).
  - Own products: `stock: {inventory} (+{inbound} inbound)` (red ≤10),
    `+100` / `+500 -20%` buttons → `orderStock(state, id, qty)` (sfx build/bad),
    `auto` checkbox → sets `p.autoRestock` directly.
  - Catalog products: "dropshipped · ${cost}/unit".
  - "sold {soldTotal}". **Fit line** (listed only): if any settlement is
    researched, best/worst `fitScore(state, p, st)` across surveyed markets;
    else "fit: ??? — survey settlements to see where this sells".

#### STORES (STORES & PREMISES)
- **Office card**: `🏢 {OFFICE_LEVELS[level].name}` @ HQ name; Ship capacity
  `= levelShipCap + activeWarehouses*90 + shipping*30` per day (with
  "(backlog!)" if queue > cap); Queue in packages (red if > 2× cap); Staff
  desks `staffCount(s)/staffCap(s)`; if upgrading — "🏗 Upgrading to {name} —
  N days left"; else UPGRADE button (`data-act=upgrade-office` →
  `upgradeOffice(state)`; on ok → `celebrateUpgrade(hqSid, '🏗 BUILDERS ON SITE', ...)`)
  with delta note (ship X→Y/day · desks A→B · takes N days), or "fully
  upgraded" note at max.
- **Online store card**: if not launched — "not launched" + LAUNCH ONLINE
  STORE ($800) (`data-act=launch-online` → `launchOnlineStore(state)`, sfx
  'goal' on ok). If launched — `🛒 {companyName}.shop  LIVE`, products listed
  count, store level; while `level < 3`, UPGRADE THEME & CHECKOUT button
  (`data-act=upgrade-online`) — **implemented inline in ui.js, not sim.js**:
  cost `= onlineStore.level * 4000`; deduct cash and `onlineStore.level++`;
  on ok `celebrateUpgrade(hq, '🛒 STORE LEVEL {n}!', ...)`.
- **PHYSICAL STORES (Shopify POS)** section: empty-state note ("Click a
  settlement on the map to open one"). Per store premise: under-construction
  card (`🏗 {name} · under construction · opens in N days — rent already
  running`) OR trading card: level name, rent/day, shelf space
  `{shelf} products (best local fit)`, refit-in-progress note or UPGRADE
  button (`data-up-store={premId}` → `upgradeStore(state, premId)`; on ok
  `celebrateUpgrade`) with foot-traffic ×capture and shelf deltas.
- **WAREHOUSES** section: explainer note (90 pkgs/day, 6 desks, sea →
  port → lorry), then one row per warehouse: `🏭` (or `🏗` + "(Nd to finish)")
  name + rent/day. Footer tip about clicking settlements.

`celebrateUpgrade(sid, title, detail)`: `renderer.celebrate(sid)`, sfx 'goal',
recenter camera on the settlement, green-bordered `#goal-toast` with
title + smaller detail line for 3.2 s.

#### STAFF
- "Desks used {staffCount}/{staffCap}" + note (wages daily, hiring costs 10
  days' wages up front).
- One card per role in `STAFF_INFO` order (shipping, support, engineer):
  icon, name, wage/day, desc, current count, `+` (`hire(state, role)`) and
  `−` (`fire(state, role)`) buttons via `act()`.
- "Total wages: $X/day".

#### MARKETING
- Tiles: Daily budget (sum of `state.marketing`), CAC — paid (7d) with
  LTV:CAC ratio annotation. Note explaining organic vs paid.
- One card per channel in `CHANNELS` order (social, search, tv, flyers):
  `{icon} {name}` + `{spend}/day`, description, per-channel stat line when
  `spend14 > 0` (`≈$X/customer · won ~N in 14d`, colored by 3×/1× LTV
  comparison; or "no customers won yet"), and a range slider
  `min=0 max={ch.max} step=10` bound to `state.marketing[key]` (direct
  mutation on input, updating the header spend label live).
  **Flyers slider is disabled with a warning until you own a store premise.**
- **CAMPAIGNS**: flash-sale button `#flash-sale` with three states:
  live (`⚡ FLASH SALE LIVE — N days left`, disabled, pulsing `.live` class),
  cooling (`⚡ FLASH SALE (ready in Nd)`, disabled), ready
  (`⚡ RUN FLASH SALE — $800` → `startFlashSale(state)` via act(), sfx 'goal'
  on ok). Note: "4 days: everything 20% off, shopper attention ×1.55… 32-day cooldown."

#### RESEARCH (CUSTOMER RESEARCH)
Settlements sorted by pop desc; per settlement card:
- `🌆/🏘/🏡 {name}` + pop; "Your customers {n} · sat {pct}"; "Awareness {pct}";
  "Competition" as ⚔ repeated `clamp(round(rivalPressure*2), 1, 4)` times,
  red > 1.2 / green < 0.5, plus " PROMO BLITZ!" when `rivalPromo.sid === id`.
- If `researched`: segment stacked bar (`.seg-bar`, widths = segment %,
  colors `SEGMENTS[k].color`) + legend of top 3, Online affinity %, Wealth as
  💰×`max(1, round(wealth*2))`, and "Best fit product: {name} · {fitScore}"
  (green > 60 / plain > 35 / red).
- Else: "Segments: ??? · Preferences: ???" and either "🚶 Researcher en
  route — results in ~N days" (when a survey with this sid exists) or
  `SURVEY ($cost)` button (`data-research={sid}` → `researchSettlement(state, sid)`
  via act()). Survey cost: city $1200 / town $700 / village $400.

### 2.6 Modals

**modalCatalog** — "SHOPIFY CATALOG": note (dropshipped, Shopify cut, $500
listing fee), `#cat-filter` select (All categories + one option per
`CATEGORIES`), `#cat-grid` 2-col grid of available items
(`catalogAvailable(state)`, i.e. minus already-owned baseIds), each card:
sprite (drawn with `{id, cat}`), name, category chip,
`cost $(c.cost*1.62).toFixed(2) · MSRP ${msrp}` (+season), STY/QUA pips only,
`SOURCE $500` button → `addCatalogProduct(state, id)`; sfx 'kaching'/'bad';
close + rerender panel on success.

**modalRnd** — "R&D LAB": intro (margins ~65-75% vs ~40%, mentions current
engineer count and +45%/engineer speed), CATEGORY choice grid (8 category
cards, default `gadgets`), AMBITION 3-col grid over `RND_TIERS`
(name, `~{days}d base`, cost; default `standard`), DESIGN FOCUS slider 0–100
(Practical ←→ Stylish, default 50, passed as 0–1), CANCEL / START PROJECT →
`startRnd(state, cat, tier, focus)` (sfx build/bad, flash msg on fail).

**modalSettlement(st)** — the map-click hub:
- Header `🌆/🏘/🏡 {NAME}`, rows: Population `{pop} ({type})`, Brand
  awareness %, Your customers, Competition ⚔-pips (same rules as Research).
- If researched: full segment bar + full legend + Online affinity row;
  else note "Shopper segments unknown — run a survey…".
- "🚶 A researcher is on their way here." when applicable.
- Action buttons (each only when applicable):
  - `#ins-survey` `📋 SURVEY ($cost)` — hidden if researched or survey en
    route → `researchSettlement(state, st.id)` then close & **reopen** the modal.
  - `#ins-store` `🏬 OPEN STORE ($setup + $rent/d, Nd build)` — hidden if a
    store premise already exists here → `openStore(state, st.id)`, close.
  - `#ins-wh` `🏭 BUILD WAREHOUSE ($setup + $rent/d, Nd build)` — hidden if a
    warehouse OR office already here → `buildWarehouse(state, st.id)`, close.
  - `#ins-close` CLOSE.

**modalGameOver** (noClose): "BANKRUPT", "The bank has called in its loan.
{company} is no more.", lifetime stats line (revenue/orders/customers),
`#go-restart` START OVER → `game.restart()`.

**modalIpo** (noClose): "🔔 IPO DAY 🔔", "{company} rings the bell —
$1,000,000 in lifetime revenue!", flavor, `#ipo-continue` KEEP BUILDING →
hides `#modal-root` and `pauseForModal(false)` (game continues).

### 2.7 Toasts & banners

- `#goal-toast` (bottom-center of map): shared by showGoal (amber border,
  `🏆 GOAL: {name}` + `+$reward bonus`), showQuest (green, `{icon} {name} ✓`
  + `+$reward`), flashNote (red, plain msg), celebrateUpgrade (green,
  title + detail). Each sets border/text color inline, un-hides, and resets a
  shared timeout (3500/2800/2200/3200 ms respectively).
- `#event-banner` (top-center, cyan border): icon + NAME + "N days" + desc;
  auto-hides after 5 s.

### 2.8 Look & feel tokens (style.css)

CSS vars: `--bg #0b0d18, --panel #1a1d33, --panel-2 #14162a, --bevel-hi
#33395e, --bevel-lo #060810, --cream #ece7d5, --dim #8d8fa8, --green #95bf47,
--green-dk #5e8a2a, --amber #ffc94d, --danger #ff6b6b, --cyan #5ac8e0`.
Fonts: headings/buttons `'Press Start 2P'`, body `'VT323'` (Google Fonts),
`image-rendering: pixelated`. Chrome style: 2px two-tone bevel borders
(raised: hi top/left, lo bottom/right; sunken inverted) on `.pxbtn, .card,
#sidebar, #topbar, #modal-box`. Sidebar fixed at 388 px (300 px < 900 px wide).
Layout: column flex `#topbar / #main (map + sidebar) / #ticker (30px)`;
`html,body overflow:hidden; height:100%`. `.hidden { display:none !important }`.
Modal: fixed overlay `rgba(4,5,12,.8)`, box min 420 / max 640 px, max-height
84vh scrollable. Reduced-motion media query disables ticker marquee and
toast pop animation.

---

## 3. SIM REFERENCE (exports, signatures, key state)

All of these already exist verbatim in `src/sim.js` — listed so the builders
know what to call. All action functions return `{ ok: boolean, msg?: string }`
(plus extras where noted) and mutate `state` directly.

### Constants
- `DAYS_PER_MONTH = 28`; `MONTHS = ['Jan'…'Dec']`; year = 12×28 = 336 days.
- `EXPECTED_DELIVERY_DAYS = 4`.
- `WAGES = { shipping: 22, support: 26, engineer: 55 }` per day.
- `STAFF_INFO = { shipping: {name:'Warehouse Crew', icon:'📦', wage, desc}, support: {'Support Agents','🎧'}, engineer: {'R&D Engineers','🔬'} }`.
- `CHANNELS = { social: {name:'Social Ads', icon:'📱', max:800, half:180, desc, profile:{city:1.25,town:.85,village:.3}}, search: {'Search Ads','🔎',600,140, profile all 1 — boosts conversion not awareness}, tv: {'TV Spots','📺',2000,700, profile:{city:.9,town:1,village:1.15}}, flyers: {'Local Flyers','📄',300,60 — only works in settlements with your store} }`.
- `RND_TIERS = { budget:{name:'Budget',cost:3500,days:28,quality:[.35,.55],costRatio:.24}, standard:{'Standard',9000,48,[.55,.75],.26}, premium:{'Premium',20000,76,[.75,.97],.28} }`.
- `PREMISE_COSTS = { office:{city:{setup:0,rent:95,days:0},town:{0,45,0},village:{0,20,0}}, store:{city:{14000,95,16},town:{6500,42,11},village:{2600,16,7}}, warehouse:{city:{11000,60,15},town:{8000,38,12},village:{6000,22,9}} }`.
- `OFFICE_LEVELS = [ {name:'Garage Office',shipCap:40,staffCap:6,upgradeCost:0,buildDays:0}, {'Loft Office',110,14,9000,12}, {'HQ Tower',260,30,26000,22} ]`.
- `STORE_LEVELS = [ {name:'Pop-up',capture:1,shelf:3}, {'Storefront',1.8,6,upgradeCost:7000,buildDays:8}, {'Flagship',3.1,10,18000,14} ]`.
- `RIVALS = [ {id:'bumblebuy', name:'BumbleBuy', color:'#ffb545', style:'discount', blurb:'big-box discounter'}, {id:'verdant', name:'Verdant & Co', color:'#c792ea', style:'premium', blurb:'upmarket boutique chain'} ]`.
- `QUESTS` (5, each `{id, icon, name, desc, reward, test(s)}`): q-products
  (2 products, $400), q-online (launch store, $400), q-mkt ($50/day marketing,
  $400), q-survey (survey one settlement, $400), q-sale (first sale, $600).
- `GOALS` (8, `{id, name, desc, test(s, row), reward}`): first-sale $500,
  k-day ($1,000 day) $1500, hundred (100 customers) $2000, own-product $3000,
  two-stores $4000, bfcm ($10k day during BFCM w/ onTime>80%) $10000,
  satisfied (1,000 customers, sat>85%) $15000, **ipo** ($1M lifetime revenue) $0.

### Functions
- `newGame(seed?) → state` — see state shape below.
- `calInfo(state) → {month 1-12, dom 1-28, year, season, dayOfYear}`.
- `simulateDay(state) → row | null` — the daily tick (null if gameOver/no hq).
- `chooseHq(state, sid)` — sets `hq`, pushes office premise `{id:'prem-hq', sid, kind:'office', level:0}`, awareness ≥ 0.15.
- `catalogAvailable(state)` — CATALOG minus owned baseIds.
- `addCatalogProduct(state, baseId)` — $500 fee; cost = `base.cost * 1.62`; auto-lists if a slot is free.
- `startRnd(state, cat, tier, focus)` / (internal `finishRnd`).
- `orderStock(state, productId, qty) → {ok, total?}` — bulk discount 6%/12%/20%
  at 100/200/500 units; sea leg 3 days (6 during supplycrunch); pushes a
  boatAnim if < 4 active.
- `fulfillmentNodes(state)` — settlements of active offices/warehouses.
- `upgradeOffice(state)`, `launchOnlineStore(state)` ($800),
  `openStore(state, sid)`, `upgradeStore(state, premId)`, `buildWarehouse(state, sid)`.
- `premiseActive(pr)` — false only while a NEW build is under construction.
- `staffCap(state)`, `staffCount(state)`, `hire(state, role)` (signing =
  10× wage), `fire(state, role)`.
- `listingCap(state)` — 4 without online store; `[_,6,10,14][level]` with.
- `toggleListing(state, productId)`.
- `researchSettlement(state, sid)` — cost by type; walking survey, duration
  `max(2, round(1 + dist/7)) + 2` days.
- `productAppeal(p, seg, wealth, eventCtx, comp)`, `seasonMult(p, cal, ctx)`,
  `fitScore(state, p, settlement) → 0-100`, `brandFocus(state) →
  {hhi, topCat, topShare, bonus, label}`.
- `startFlashSale(state)` — $800, 4 days at 20% off + attention ×1.55, 32-day cooldown, pushes confetti.
- `rivalPressure(state, s)` — presence × 1.6 during a promo blitz there.
- `metrics(state) → {cac, ltv, aov, rev7, ord7, new7, profit7, organic7,
  attrCust7, channels: {[ch]: {spend14, cust14, cac}}, satisfaction, repeat, totalCustomers}`.
- `checkQuests(state)` (exported; UI calls after actions), `pushNews(state, html)`
  (ring buffer of 8), `fmtMoney(n)` → `$1,234` / `$12.3k` / `$1.23M`, negatives `-$…`.

### State shape (`newGame`)

```js
{
  v: 3, seed,
  companyName: 'My Company',
  day: 56,               // starts March 1 (2 * 28), year 1
  year: 1,
  cash: 25000,
  debtWarned: false, gameOver: false,
  world,                                    // see §1.2
  hq: null,
  premises: [],                             // {id, sid, kind, level, construction?}
  onlineStore: null,                        // {level} once launched (1..3)
  products: [],                             // see product shape below
  rnd: null,                                // {cat, tier, focus, daysLeft, totalDays}
  ownCount: 0,
  staff: { shipping: 0, support: 0, engineer: 0 },
  marketing: { social: 0, search: 0, tv: 0, flyers: 0 },   // $/day, UI writes directly
  rivalPresence: { [sid]: number },         // ~0.15..2.6
  rivalPromo: null,                         // {sid, daysLeft, rival}
  mktAttrib: { social:{spend:[],cust:[]}, search:{…}, tv:{…}, flyers:{…} },  // rolling 14
  flashSale: { daysLeft: 0, cooldownUntil: 0 },
  questsDone: [], goalsDone: [],
  queue: 0,                                 // packages waiting to ship
  onTime: 0.95,                             // rolling on-time rate 0..1
  activeEvents: [],                         // {key, name, daysLeft, ...effect fields, stormSids?, stormCenter?}
  news: [],                                 // last 8 HTML strings
  shipAnims: [], boatAnims: [], surveys: [], fxAnims: [],
  history: [],                              // rolling 336 rows: {day, revenue, orders, profit, newCustomers,
                                            //  customers, satisfaction, awareness, cash, queue, onTime,
                                            //  missedStock, mkt, cogs, rent, wages, refunds}
  lifetime: { revenue: 0, orders: 0, customers: 0, mkt: 0 },
  roll: { mkt: [], newCust: [], revenue: [], orders: [] },  // rolling 7
  tutorialStep: 0,
  rngState: seed ^ 0x9e3779b9,
  // transient, set by sim, drained by main.js each step:
  pendingGoal: null, pendingQuest: null, pendingEvent: null,  // pendingEvent = {icon, name, days, desc}
}
```

### Product shape

```js
// catalog-sourced:
{ id: `p{n}-{baseId}`, baseId, name, cat,
  style, quality, utility, eco, tech,      // 0..1
  season: null|'summer'|'winter'|'holiday', sports: bool,
  source: 'catalog',
  cost,                                    // base.cost * 1.62, 2dp
  price, msrp,                             // price starts at msrp; UI slider mutates price
  listed: bool,
  inventory: null,                         // null = dropshipped, never stocks out
  soldTotal: 0 }

// own (R&D) — additionally:
{ id: `own{n}-{hashCode(name)}`, baseId: null, source: 'own',
  inventory: 0, incoming: [],              // incoming: {qty, phase:'sea'|'land', daysLeft}
  autoRestock: false, missedToday: 0 }
```

### Calendar events (fixed)
valentines (Feb 12, 4d, beauty×2.1 apparel×1.4), summerhols (Jun 20, 34d,
outdoor×1.7 toys×1.25 fitness×1.2), halloween (Oct 26, 4d, toys×1.9 food×1.35),
**bfcm** (Nov 24, 4d, ALL demand ×3.4, confetti), xmasrun (Dec 8, 17d, ×1.5 +
toys/home/gadgets), slump (Dec 26, 16d, ×0.62). World Cup: `year % 4 === 2`,
all June, sports×2.6 + TV ads 30% off. Random events (~1/26 daily): storm
(regional, `stormSids` + `stormCenter`, deliveries +2.5d), viral (one category
×2.3), supplycrunch (restocks 6-day sea leg), recession (priceSens +0.35),
influencer shout-out (+0.25 awareness somewhere).

### Segments (world.js `SEGMENTS`) — needed for research UI colors/names
trendsetters `#e06fae`, families `#ffd24d`, outdoorsy `#6fbf73`,
professionals `#5ac8e0`, bargainers (name "Bargain Hunters") `#ff8f5a`,
seniors `#c792ea`. Each has `prefs{style,quality,utility,eco,tech}`,
`priceSens`, `onlineBias`, `cats{...}`.

---

## 4. CATALOG & PRODUCT ASSETS

### 4.1 The 8 categories (`CATEGORIES` in data/catalog.js)

| key | name | color | icon |
|---|---|---|---|
| apparel | Apparel | `#e06fae` | 👕 |
| gadgets | Gadgets | `#5ac8e0` | 🔌 |
| home | Home | `#d9a06b` | 🏠 |
| outdoor | Outdoor | `#6fbf73` | ⛰ |
| beauty | Beauty | `#c792ea` | ✨ |
| toys | Toys | `#ffd24d` | 🧸 |
| food | Food | `#ff8f5a` | 🍯 |
| fitness | Fitness | `#7de8c3` | 🏋 |

### 4.2 Full baked catalog (43 products: id · name · category)

Apparel (7): `c-tee-graphic` Graphic Tee · `c-hoodie` Heavyweight Hoodie (winter)
· `c-beanie` Wool Beanie (winter) · `c-socks` Pattern Sock 3-Pack ·
`c-raincoat` Packable Raincoat · `c-swimsuit` Retro Swimsuit (summer) ·
`c-jersey` Supporter Jersey (sports).

Gadgets (6): `c-earbuds` Wireless Earbuds · `c-charger` Mag Charging Pad ·
`c-lamp-smart` Smart Mood Lamp · `c-tracker` Key Finder Tag · `c-cam` Retro
Instant Camera · `c-speaker` Pocket Speaker (summer).

Home (6): `c-candle` Soy Candle Trio (holiday) · `c-mug` Stoneware Mug ·
`c-blanket` Chunky Knit Blanket (winter) · `c-planter` Self-Watering Planter ·
`c-poster` Vintage Map Print · `c-diffuser` Oil Diffuser.

Outdoor (5): `c-bottle` Insulated Bottle · `c-hammock` Travel Hammock (summer)
· `c-headlamp` Trail Headlamp · `c-cooler` Soft Cooler Bag (summer) ·
`c-multitool` Pocket Multi-Tool.

Beauty (4): `c-serum` Glow Serum · `c-balm` Hand Balm Tin (winter) · `c-spf`
Mineral SPF 50 (summer) · `c-kit-groom` Grooming Kit (holiday).

Toys (5): `c-plush` Mountain Yeti Plush (holiday) · `c-blocks` Wooden Block
Set (holiday) · `c-kite` Stunt Kite (summer) · `c-puzzle` 1000pc Puzzle
(winter) · `c-rc-rover` RC Rock Rover (holiday).

Food (5): `c-honey` Wildflower Honey · `c-coffee` Single-Origin Coffee ·
`c-hotchoc` Hot Cocoa Bombs (winter) · `c-hotsauce` Small-Batch Hot Sauce ·
`c-teabox` Herbal Tea Sampler (winter).

Fitness (5): `c-yogamat` Cork Yoga Mat · `c-bands` Resistance Band Set ·
`c-jumprope` Speed Rope (sports) · `c-shaker` Steel Shaker Bottle (sports) ·
`c-smartrope` Smart Jump Rope (sports).

Each entry also carries `cost, msrp, style, quality, utility, eco, tech,
season, sports?` — read them from `src/data/catalog.js` directly; do not
duplicate values.

### 4.3 R&D product generation (why sprites must be procedural)

`finishRnd` creates products with **generated names**:
`"{FIRSTWORD} {CATWORD[cat]}"` where
`FIRSTWORDS = ['Nimbus','Ember','Cedar','Atlas','Juniper','Comet','Harbor','Fable','Summit','Willow','Pixel','Meadow','Quartz','Drift']`
and `CATWORDS = { apparel:['Thread','Wear','Cloth','Stitch'],
gadgets:['Gizmo','Circuit','Spark','Widget'], home:['Nest','Hearth','Room','Haven'],
outdoor:['Trail','Peak','Camp','Ridge'], beauty:['Glow','Bloom','Velvet','Aura'],
toys:['Play','Wonder','Whimsy','Joy'], food:['Harvest','Pantry','Batch','Crumb'],
fitness:['Motion','Pulse','Core','Stride'] }`.
Attributes: quality uniform in tier range; `style = min(1, U(0.2,0.5) +
focus*0.5 + q*0.15)`; `utility = min(1, U(0.2,0.5) + (1-focus)*0.5 + q*0.1)`;
`eco = U(0.2,0.8)`; `tech = gadgets ? U(0.6,0.95) : U(0,0.4)`; `season = null`;
`sports = (cat==='fitness' && 50%)`. `msrp = round((8 + q*60 + style*14) *
U(0.9,1.15))`; `cost = max(2, round(msrp * tier.costRatio))`. So the **asset
pipeline cannot use a fixed image per product** — any product id/name in any
of the 8 categories must render.

### 4.4 Sprite algorithm (sprites.js — reproduce or replace per-category)

`drawProductSprite(canvas, product)` needs only `{id, cat}`:
16×16 character template per category (chars: `.` transparent, `#` main,
`+` accent, `o` dark shade, `*` highlight), colored deterministically from
`makeRng(hashCode(product.id))`: `baseHue = (CAT_HUE[cat] ± 24) % 360` with
`CAT_HUE = {apparel:330, gadgets:195, home:28, outdoor:120, beauty:275,
toys:48, food:18, fitness:160}`; `accHue = baseHue + pick([40,150,180,210])`;
`sat = U(45,75)`; colors: `# = hsl(baseHue,sat,52)`, `+ = hsl(accHue,sat+8,58)`,
`o = hsl(baseHue,sat-8,26)`, `* = hsl(baseHue,25,88)`. Templates depict:
apparel=hoodie, gadgets=phone/device, home=vase/pot, outdoor=mountain/tent,
beauty=pump bottle, toys=teddy, food=jar, fitness=dumbbell. The full template
strings are in the original `src/sprites.js` — copy them verbatim (16 rows ×
16 chars each). Drawn with nearest-neighbor scaling into a 48×48 canvas.

---

## 5. Gotchas / easy-to-miss behaviors

1. **The renderer owns anim lifecycle**: sim only *pushes* `shipAnims` /
   `boatAnims` / `fxAnims`; `draw(dt)` advances `t` and filters out finished
   ones. If the new renderer doesn't prune, sim's caps (8/10 ships, 4 boats)
   will starve and animations stop appearing. `surveys` and `celebrations`
   are the opposite: surveys tick by sim (daily), celebrations are
   renderer-private.
2. `renderPanel()` is throttled (900 ms) and suppressed during slider drags —
   without this, re-rendering mid-drag destroys the slider being dragged.
   Panel `scrollTop` must be preserved across re-renders.
3. Price slider, marketing sliders, and auto-restock checkbox mutate state
   **directly** (no sim function); online-store upgrade cost/cash logic lives
   **in ui.js**, not sim.js.
4. `fmtMoney` is used everywhere; the top bar strips its `$`. Cash can go
   negative (red); game over at −$15,000.
5. `hitTest` must return `{tile, settlement}` — main.js reads `.settlement`
   for tooltip/click and pickMode flow.
6. Save versioning: only `v === 3` saves load; typed arrays round-trip through
   plain arrays; anim arrays and pending* are stripped on save and reset on load.
7. `state.day` starts at 56 (March 1); a year is 336 days; `calInfo`, not any
   stored field, is the source of month/season — the renderer must re-derive
   season each frame to pick the right terrain palette (and rebuild/cache
   per-season terrain).
8. Business-mode penetration bar denominator is `pop * 0.15`, not pop.
9. The FIX button in the dashboard stockout banner works by programmatically
   clicking the products tab button — tab switching must be event-driven.
10. `checkQuests` is called both daily by sim and immediately by `ui.act()` so
    quest toasts fire the moment the player completes a step, not next tick.
