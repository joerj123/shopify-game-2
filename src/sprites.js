// Image resolution for generated art + hashCode (sim.js imports hashCode from here).
// Replaces the original procedural pixel-sprite module: instead of drawing 16x16
// sprites we resolve baked PNGs from the assets manifest.
import { ASSETS } from './data/assets-manifest.js';
import { CATEGORIES, CATALOG } from './data/catalog.js';

// FNV-1a — must stay byte-identical to the original (sim.js product ids depend on it).
export function hashCode(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Manifest normalisation. The generator's contract shape is nested:
//   { titleHero, garage, rivals:{id:path}, events:{key:path},
//     products:{id:path}, rnd:{category:[path1,path2]} }
// but we also accept a flat manifest ('product:c-x', 'rnd:apparel-1',
// 'event:storm', 'ui:title-hero', 'ui:rival-bumblebuy', 'ui:garage') so the UI
// works with whichever version of the generator ran last.
// ---------------------------------------------------------------------------
function normalize(raw) {
  const out = { titleHero: null, garage: null, rivals: {}, events: {}, products: {}, rnd: {} };
  if (!raw || typeof raw !== 'object') return out;

  const looksNested = raw.products || raw.rnd || raw.events || raw.rivals || raw.titleHero;
  if (looksNested) {
    out.titleHero = raw.titleHero || null;
    out.garage = raw.garage || null;
    Object.assign(out.rivals, raw.rivals || {});
    Object.assign(out.events, raw.events || {});
    Object.assign(out.products, raw.products || {});
    for (const [cat, v] of Object.entries(raw.rnd || {})) out.rnd[cat] = Array.isArray(v) ? v.filter(Boolean) : [v];
    return out;
  }

  for (const [key, path] of Object.entries(raw)) {
    if (typeof path !== 'string') continue;
    const i = key.indexOf(':');
    if (i < 0) continue;
    const ns = key.slice(0, i), rest = key.slice(i + 1);
    if (ns === 'product') out.products[rest] = path;
    else if (ns === 'rnd') {
      const m = rest.match(/^(.+)-(\d+)$/);
      if (m) {
        const arr = (out.rnd[m[1]] = out.rnd[m[1]] || []);
        arr[parseInt(m[2], 10) - 1] = path;
      }
    } else if (ns === 'event') out.events[rest] = path;
    else if (ns === 'ui') {
      if (rest === 'title-hero') out.titleHero = path;
      else if (rest === 'garage') out.garage = path;
      else if (rest.startsWith('rival-')) out.rivals[rest.slice(6)] = path;
    }
  }
  for (const cat of Object.keys(out.rnd)) out.rnd[cat] = out.rnd[cat].filter(Boolean);
  return out;
}

export const ART = normalize(ASSETS);

// ---------------------------------------------------------------------------
// productImage(product) → path | null
//  - baked catalog products resolve by baseId (state products carry the base
//    catalog id in .baseId; raw catalog entries pass their own .id)
//  - R&D / own products pick one of two per-category renders, stable per id
//  - graceful fallbacks: category R&D art → any catalog image of the category
// ---------------------------------------------------------------------------
export function productImage(product) {
  if (!product) return null;
  if (product.id && ART.products[product.id]) return ART.products[product.id];
  if (product.baseId && ART.products[product.baseId]) return ART.products[product.baseId];

  const cat = product.cat && CATEGORIES[product.cat] ? product.cat : 'home';
  const variants = ART.rnd[cat];
  if (variants && variants.length) {
    const seed = hashCode(String(product.id || product.name || cat));
    return variants[seed % variants.length];
  }
  // last resort: first catalog product of the same category that has art
  const sibling = CATALOG.find((c) => c.cat === cat && ART.products[c.id]);
  if (sibling) return ART.products[sibling.id];
  return null;
}

// Map a pending-event ({icon, name, ...}) or activeEvent to one of the 8 baked
// event art keys. Returns a path or null (unknown events show no art).
export function eventImage(ev) {
  if (!ev) return null;
  const name = String(ev.name || ev).toLowerCase();
  let key = null;
  if (name.includes('bfcm') || name.includes('black friday')) key = 'bfcm-rush';
  else if (name.includes('storm')) key = 'storm';
  else if (name.includes('trending') || name.includes('viral')) key = 'viral-trend';
  else if (name.includes('supply')) key = 'supply-crunch';
  else if (name.includes('world cup')) key = 'world-cup';
  else if (name.includes('slump') || name.includes('belt')) key = 'slump';
  else if (name.includes('holiday') || name.includes('halloween') || name.includes('valentine') || name.includes('summer')) key = 'holiday';
  else if (name.includes('ipo')) key = 'ipo-bell';
  return key ? ART.events[key] || null : null;
}

export function rivalImage(idOrRival) {
  if (!idOrRival) return null;
  const id = typeof idOrRival === 'string' ? idOrRival : idOrRival.id;
  return ART.rivals[id] || null;
}
