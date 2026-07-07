# Shopify Tycoon 3D

A cozy, low-poly 3D entrepreneurship sim built with Three.js. Grow a retail empire from a garage office on a procedurally generated island: source products, run online and physical stores, out-position rival chains, survive BFCM, and ring the IPO bell.

This is a full presentation rebuild of the original `shopify-game` (Canvas 2D, pixel art) — same deep simulation, all-new 3D world, UI, art, and soundtrack.

## Run it

```sh
npm install
npm run dev
# → http://localhost:5173
```

## What's new vs the original

- **Stylized 3D island** — low-poly terrain with vertex-colored flat shading, animated water with shoreline foam, drifting clouds, soft shadows, bloom.
- **Living world** — day/night cycle (emissive windows at night), four seasons recoloring the island, rain/snow/storms, December festive lights, delivery trucks on the road network, freighters on the sea lane, construction cranes, survey walkers.
- **AI-generated art** — 71 images via OpenAI `gpt-image-1`: every catalog product, R&D archetypes per category, title hero, rival emblems, event cards. Regenerate with `node scripts/gen-assets.mjs` (needs `OPENAI_API_KEY` in `.env`; idempotent).
- **Glass UI** — dark warm dashboard with sparkline charts, segment bars, product cards, event toasts.
- **Lo-fi generative soundtrack** — four WebAudio tracks (Garage Days, Growth Loop, Night Shift, IPO Eve) plus soft sfx. Click ♪ to start, click again to change track, double-click to stop.

## How to play

1. **Name your company and pick a headquarters.** Cities ship more and have richer shoppers, but rent is steep and rivals are strongest there.
2. **Get products** — source from the Shopify catalog (instant, thin margins) or run R&D (slow, expensive, high margins and differentiation).
3. **Curate, don't hoard.** Shopper attention is split between your products and the rival chains. A focused brand converts better than a junk drawer.
4. **Match products to markets.** Survey settlements to reveal segment mixes, wealth, and competition; product cards show their best/worst market fit.
5. **Ship on time.** Backlogs and distance make deliveries late → satisfaction → reputation → demand.
6. **Mind CAC vs LTV**, watch the rivals expand, and ride the seasonal calendar (BFCM ×3.4!).

**The arc:** $1M lifetime revenue rings the IPO bell (+$250k capital, unlocks franchising, national campaigns, warehouse automation, brand tiers and port exports) → $10M lets you acquire a rival's regional ops → **$1B wins**. **Lose:** slide to −$50,000 of interest-bearing overdraft and the bank takes the keys — price wars, poaching and rising costs make coasting fatal.

### Sim 2.0 systems

- **Competition you can read**: rivals are agents with postures (expand / defend / price-war / blitz) and weekly moves in the news; the Research tab shows per-town pressure, your share vs theirs, and active price wars. A Prime-like disruptor enters once you're big and raises delivery expectations island-wide.
- **Physical stores hold physical goods**: shelves are stocked from your warehouses (or wholesale case orders for catalog items); dropshipping serves online only. Stockouts hurt.
- **Executive pawns**: hire a CMO, COO, Head of Research and Retail Director, and station them in settlements for local effects — they physically walk there across the board.
- **Living towns**: settlements grow or shrink with their local economy (your jobs and service vs rival pressure), visibly changing size and even tier.
- **Peek at people**: hover/click pedestrians for their segment and what they wish someone sold nearby — live market research.

### Controls

- **Space** pause · **1/2/3** speed
- **Drag / WASD / arrows** pan · **wheel / + −** zoom · **right-drag / Q / E** rotate · **R** reset view
- **Map / Biz** toggle: terrain vs business view (green dome = awareness, blue ring = market penetration, red pip = heavy competition)
- Click any settlement to inspect, open a store, build a warehouse, or survey

## Tech

Vite + Three.js; no other runtime dependencies. The simulation (`src/sim.js`, `src/world.js`) is engine-agnostic vanilla JS ported unchanged from the original — procedural island generation with rivers/roads/bridges via Dijkstra, an attention-share demand model with AI rivals, segment-based conversion, logistics with per-order delivery routing. Renderer in `src/gfx/` (~1,850 lines across 8 modules). LocalStorage autosave.

`docs/PORT_SPEC.md` documents the sim↔presentation contract; `docs/ART_DIRECTION.md` is the visual bible.
