// Gamified Shopify catalog. Attributes are 0–1: style, quality, utility, eco, tech.
// season: null | 'summer' | 'winter' | 'holiday'
// cost = wholesale/dropship unit cost. Catalog products are dropshipped (no inventory),
// but Shopify takes a sourcing cut — margins are thinner than your own products.
//
// If scripts/fetch-catalog.mjs succeeds against the real Catalog API it writes
// src/data/catalog.live.js which is merged on top of this baked set.

export const CATEGORIES = {
  apparel:  { name: 'Apparel',  color: '#e06fae' },
  gadgets:  { name: 'Gadgets',  color: '#5ac8e0' },
  home:     { name: 'Home',     color: '#d9a06b' },
  outdoor:  { name: 'Outdoor',  color: '#6fbf73' },
  beauty:   { name: 'Beauty',   color: '#c792ea' },
  toys:     { name: 'Toys',     color: '#ffd24d' },
  food:     { name: 'Food',     color: '#ff8f5a' },
  fitness:  { name: 'Fitness',  color: '#7de8c3' },
};

export const CATALOG = [
  // ---------- apparel ----------
  { id: 'c-tee-graphic',   name: 'Graphic Tee',           cat: 'apparel', cost: 6,  msrp: 22, style: .8, quality: .4, utility: .3, eco: .3, tech: 0,  season: null },
  { id: 'c-hoodie',        name: 'Heavyweight Hoodie',    cat: 'apparel', cost: 14, msrp: 48, style: .7, quality: .6, utility: .6, eco: .3, tech: 0,  season: 'winter' },
  { id: 'c-beanie',        name: 'Wool Beanie',           cat: 'apparel', cost: 4,  msrp: 16, style: .6, quality: .5, utility: .5, eco: .5, tech: 0,  season: 'winter' },
  { id: 'c-socks',         name: 'Pattern Sock 3-Pack',   cat: 'apparel', cost: 3,  msrp: 14, style: .7, quality: .4, utility: .5, eco: .3, tech: 0,  season: null },
  { id: 'c-raincoat',      name: 'Packable Raincoat',     cat: 'apparel', cost: 18, msrp: 62, style: .5, quality: .6, utility: .8, eco: .4, tech: .1, season: null },
  { id: 'c-swimsuit',      name: 'Retro Swimsuit',        cat: 'apparel', cost: 8,  msrp: 34, style: .8, quality: .5, utility: .4, eco: .2, tech: 0,  season: 'summer' },
  { id: 'c-jersey',        name: 'Supporter Jersey',      cat: 'apparel', cost: 12, msrp: 45, style: .7, quality: .5, utility: .3, eco: .2, tech: 0,  season: null, sports: true },
  // ---------- gadgets ----------
  { id: 'c-earbuds',       name: 'Wireless Earbuds',      cat: 'gadgets', cost: 16, msrp: 59, style: .6, quality: .5, utility: .7, eco: .1, tech: .9, season: null },
  { id: 'c-charger',       name: 'Mag Charging Pad',      cat: 'gadgets', cost: 8,  msrp: 29, style: .5, quality: .5, utility: .8, eco: .2, tech: .8, season: null },
  { id: 'c-lamp-smart',    name: 'Smart Mood Lamp',       cat: 'gadgets', cost: 12, msrp: 44, style: .8, quality: .5, utility: .5, eco: .2, tech: .8, season: null },
  { id: 'c-tracker',       name: 'Key Finder Tag',        cat: 'gadgets', cost: 6,  msrp: 24, style: .3, quality: .5, utility: .9, eco: .1, tech: .8, season: null },
  { id: 'c-cam',           name: 'Retro Instant Camera',  cat: 'gadgets', cost: 34, msrp: 99, style: .9, quality: .6, utility: .4, eco: .2, tech: .7, season: null },
  { id: 'c-speaker',       name: 'Pocket Speaker',        cat: 'gadgets', cost: 11, msrp: 39, style: .6, quality: .4, utility: .6, eco: .1, tech: .8, season: 'summer' },
  // ---------- home ----------
  { id: 'c-candle',        name: 'Soy Candle Trio',       cat: 'home',    cost: 7,  msrp: 28, style: .7, quality: .6, utility: .3, eco: .8, tech: 0,  season: 'holiday' },
  { id: 'c-mug',           name: 'Stoneware Mug',         cat: 'home',    cost: 5,  msrp: 19, style: .6, quality: .7, utility: .6, eco: .6, tech: 0,  season: null },
  { id: 'c-blanket',       name: 'Chunky Knit Blanket',   cat: 'home',    cost: 19, msrp: 69, style: .8, quality: .7, utility: .6, eco: .5, tech: 0,  season: 'winter' },
  { id: 'c-planter',       name: 'Self-Watering Planter', cat: 'home',    cost: 9,  msrp: 32, style: .6, quality: .5, utility: .7, eco: .8, tech: .2, season: null },
  { id: 'c-poster',        name: 'Vintage Map Print',     cat: 'home',    cost: 4,  msrp: 24, style: .9, quality: .5, utility: .1, eco: .4, tech: 0,  season: null },
  { id: 'c-diffuser',      name: 'Oil Diffuser',          cat: 'home',    cost: 10, msrp: 36, style: .7, quality: .5, utility: .5, eco: .6, tech: .3, season: null },
  // ---------- outdoor ----------
  { id: 'c-bottle',        name: 'Insulated Bottle',      cat: 'outdoor', cost: 8,  msrp: 32, style: .6, quality: .7, utility: .8, eco: .8, tech: .1, season: null },
  { id: 'c-hammock',       name: 'Travel Hammock',        cat: 'outdoor', cost: 13, msrp: 45, style: .5, quality: .6, utility: .7, eco: .5, tech: 0,  season: 'summer' },
  { id: 'c-headlamp',      name: 'Trail Headlamp',        cat: 'outdoor', cost: 9,  msrp: 34, style: .3, quality: .6, utility: .9, eco: .2, tech: .5, season: null },
  { id: 'c-cooler',        name: 'Soft Cooler Bag',       cat: 'outdoor', cost: 15, msrp: 54, style: .4, quality: .6, utility: .8, eco: .3, tech: .1, season: 'summer' },
  { id: 'c-multitool',     name: 'Pocket Multi-Tool',     cat: 'outdoor', cost: 11, msrp: 42, style: .4, quality: .8, utility: .95, eco: .3, tech: .2, season: null },
  // ---------- beauty ----------
  { id: 'c-serum',         name: 'Glow Serum',            cat: 'beauty',  cost: 9,  msrp: 38, style: .8, quality: .6, utility: .4, eco: .5, tech: .2, season: null },
  { id: 'c-balm',          name: 'Hand Balm Tin',         cat: 'beauty',  cost: 4,  msrp: 15, style: .5, quality: .6, utility: .6, eco: .7, tech: 0,  season: 'winter' },
  { id: 'c-spf',           name: 'Mineral SPF 50',        cat: 'beauty',  cost: 6,  msrp: 24, style: .5, quality: .7, utility: .8, eco: .6, tech: .1, season: 'summer' },
  { id: 'c-kit-groom',     name: 'Grooming Kit',          cat: 'beauty',  cost: 14, msrp: 49, style: .7, quality: .6, utility: .6, eco: .3, tech: .2, season: 'holiday' },
  // ---------- toys ----------
  { id: 'c-plush',         name: 'Mountain Yeti Plush',   cat: 'toys',    cost: 6,  msrp: 24, style: .8, quality: .5, utility: .1, eco: .3, tech: 0,  season: 'holiday' },
  { id: 'c-blocks',        name: 'Wooden Block Set',      cat: 'toys',    cost: 12, msrp: 44, style: .6, quality: .8, utility: .5, eco: .9, tech: 0,  season: 'holiday' },
  { id: 'c-kite',          name: 'Stunt Kite',            cat: 'toys',    cost: 7,  msrp: 26, style: .7, quality: .5, utility: .3, eco: .4, tech: 0,  season: 'summer' },
  { id: 'c-puzzle',        name: '1000pc Puzzle',         cat: 'toys',    cost: 5,  msrp: 22, style: .7, quality: .6, utility: .2, eco: .5, tech: 0,  season: 'winter' },
  { id: 'c-rc-rover',      name: 'RC Rock Rover',         cat: 'toys',    cost: 21, msrp: 69, style: .6, quality: .5, utility: .2, eco: .1, tech: .8, season: 'holiday' },
  // ---------- food ----------
  { id: 'c-honey',         name: 'Wildflower Honey',      cat: 'food',    cost: 5,  msrp: 18, style: .5, quality: .8, utility: .5, eco: .8, tech: 0,  season: null },
  { id: 'c-coffee',        name: 'Single-Origin Coffee',  cat: 'food',    cost: 7,  msrp: 24, style: .6, quality: .8, utility: .6, eco: .6, tech: 0,  season: null },
  { id: 'c-hotchoc',       name: 'Hot Cocoa Bombs',       cat: 'food',    cost: 6,  msrp: 22, style: .8, quality: .6, utility: .3, eco: .4, tech: 0,  season: 'winter' },
  { id: 'c-hotsauce',      name: 'Small-Batch Hot Sauce', cat: 'food',    cost: 4,  msrp: 16, style: .7, quality: .7, utility: .4, eco: .5, tech: 0,  season: null },
  { id: 'c-teabox',        name: 'Herbal Tea Sampler',    cat: 'food',    cost: 6,  msrp: 21, style: .6, quality: .7, utility: .4, eco: .7, tech: 0,  season: 'winter' },
  // ---------- fitness ----------
  { id: 'c-yogamat',       name: 'Cork Yoga Mat',         cat: 'fitness', cost: 12, msrp: 44, style: .6, quality: .7, utility: .7, eco: .9, tech: 0,  season: null },
  { id: 'c-bands',         name: 'Resistance Band Set',   cat: 'fitness', cost: 6,  msrp: 24, style: .3, quality: .5, utility: .8, eco: .3, tech: 0,  season: null },
  { id: 'c-jumprope',      name: 'Speed Rope',            cat: 'fitness', cost: 4,  msrp: 15, style: .4, quality: .5, utility: .7, eco: .3, tech: .1, season: null, sports: true },
  { id: 'c-shaker',        name: 'Steel Shaker Bottle',   cat: 'fitness', cost: 5,  msrp: 19, style: .4, quality: .6, utility: .7, eco: .5, tech: .1, season: null, sports: true },
  { id: 'c-smartrope',     name: 'Smart Jump Rope',       cat: 'fitness', cost: 15, msrp: 54, style: .5, quality: .5, utility: .6, eco: .2, tech: .9, season: null, sports: true },
];
