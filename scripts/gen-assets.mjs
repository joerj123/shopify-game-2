#!/usr/bin/env node
// Generates all game art assets via the OpenAI Images API (gpt-image-1).
// Idempotent: skips files that already exist on disk. Safe to re-run.
// Usage: node scripts/gen-assets.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG, CATEGORIES } from '../src/data/catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMG_DIR = path.join(ROOT, 'assets', 'img');
const MANIFEST_PATH = path.join(ROOT, 'src', 'data', 'assets-manifest.js');

// ---------- .env parse (no deps) ----------
const envText = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const API_KEY = envText
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.startsWith('OPENAI_API_KEY='))
  .map((l) => l.slice('OPENAI_API_KEY='.length).replace(/^["']|["']$/g, ''))[0];
if (!API_KEY) {
  console.error('OPENAI_API_KEY not found in .env');
  process.exit(1);
}

// ---------- job list ----------
const productPrompt = (name, catName) =>
  `Single ${name}, ${catName} product, charming stylized 3D render, soft studio lighting, slight isometric angle, centered on plain warm cream background (#f6f1e7), no text, no watermark, subtle soft shadow, pastel-leaning premium palette`;

// R&D archetype subjects per category, two per category, with a subtle inventive/futuristic twist.
const RND_SUBJECTS = {
  apparel: [
    'sleek jacket with softly glowing woven adaptive fibers',
    'minimalist sneaker with a gently luminous self-lacing sole',
  ],
  gadgets: [
    'palm-sized holographic personal assistant orb on a small stand',
    'translucent folding pocket device with a faint levitating screen',
  ],
  home: [
    'floating self-watering planter with a soft hovering glow ring',
    'ambient smart lamp shaped like a levitating pebble',
  ],
  outdoor: [
    'compact self-erecting tent pod with soft solar-fabric shimmer',
    'futuristic insulated flask with a subtle temperature aura display',
  ],
  beauty: [
    'elegant skincare vial with a softly iridescent smart dropper',
    'compact mirror device with a gentle holographic glow',
  ],
  toys: [
    'friendly rounded robot companion toy with softly glowing eyes',
    'magnetic levitating building blocks gently floating in a stack',
  ],
  food: [
    'artisanal jar of shimmering galaxy honey with a soft glow',
    'sleek self-heating travel mug with a subtle steam halo',
  ],
  fitness: [
    'smart yoga mat with softly glowing guide lines',
    'futuristic dumbbell with a gentle adaptive-weight light ring',
  ],
};

const EVENTS = {
  'bfcm-rush':
    'midnight shopping frenzy outside a glowing warehouse, forklifts and parcels, warm warehouse lights against a deep blue night',
  storm:
    'dramatic storm over a small island harbour, heavy rain and wind-bent palm trees, waves against the pier, moody lighting',
  'viral-trend':
    'a smartphone glowing brightly surrounded by confetti, floating hearts and social buzz sparkles, joyful energy',
  'supply-crunch':
    'rows of empty open shipping containers at a quiet port at dawn, idle cranes, muted hopeful light',
  'ipo-bell':
    'a big ceremonial brass bell being rung amid bursting confetti and streamers, celebratory crowd silhouettes, warm golden light',
  'world-cup':
    'festive town street decked with colorful flags and bunting, a big outdoor screen glowing at dusk, cheering crowd silhouettes',
  holiday:
    'snowy cozy town square strung with warm holiday lights, decorated tree, glowing shop windows, gentle falling snow',
  slump:
    'grey quiet january street with closed shutters, one small hopeful shop with a warm open sign glow and a single customer approaching',
};

const jobs = [];

for (const p of CATALOG) {
  jobs.push({
    key: `product:${p.id}`,
    rel: `products/${p.id}.png`,
    prompt: productPrompt(p.name, CATEGORIES[p.cat].name),
    size: '1024x1024',
    quality: 'medium',
  });
}

for (const [cat, subjects] of Object.entries(RND_SUBJECTS)) {
  subjects.forEach((subject, i) => {
    jobs.push({
      key: `rnd:${cat}-${i + 1}`,
      rel: `rnd/${cat}-${i + 1}.png`,
      prompt: productPrompt(subject, CATEGORIES[cat].name),
      size: '1024x1024',
      quality: 'medium',
    });
  });
}

jobs.push({
  key: 'ui:title-hero',
  rel: 'ui/title-hero.png',
  prompt:
    'Epic warm title illustration for a cozy business-empire strategy game: a stylized low-poly island seen from the air at golden hour, tiny towns with glowing windows, delivery trucks on winding roads, a small cargo ship approaching a harbour, soft volumetric clouds, painterly, no text, no watermark',
  size: '1536x1024',
  quality: 'high',
});

jobs.push({
  key: 'ui:rival-bumblebuy',
  rel: 'ui/rival-bumblebuy.png',
  prompt:
    'Flat modern logo-badge style mascot emblem for a smug corporate mega-store: a confident smug cartoon bee in a tiny business suit, circular badge, bold yellow and black palette, clean vector look, no text, no watermark, plain background',
  size: '1024x1024',
  quality: 'medium',
});
jobs.push({
  key: 'ui:rival-verdant',
  rel: 'ui/rival-verdant.png',
  prompt:
    'Flat modern logo-badge style emblem for an elegant upscale boutique company: refined leafy laurel and botanical motif, crest-like circular badge, deep green and gold palette, luxurious clean vector look, no text, no watermark, plain background',
  size: '1024x1024',
  quality: 'medium',
});

for (const [ev, scene] of Object.entries(EVENTS)) {
  jobs.push({
    key: `event:${ev}`,
    rel: `ui/event-${ev}.png`,
    prompt: `Painterly cozy illustration card for a business strategy game event: ${scene}, warm stylized painterly style, soft light, no text, no watermark`,
    size: '1024x1024',
    quality: 'medium',
  });
}

jobs.push({
  key: 'ui:garage',
  rel: 'ui/garage.png',
  prompt:
    'Painterly cozy illustration: small startup garage office at dusk, glowing window, parcels stacked, bicycle, string lights, no text, no watermark',
  size: '1024x1024',
  quality: 'medium',
});

// ---------- generation with concurrency + retries ----------
const CONCURRENCY = 4;
const MAX_RETRIES = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generateOne(job) {
  const outPath = path.join(IMG_DIR, job.rel);
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
    console.log(`skip  ${job.rel} (exists)`);
    return { job, status: 'skipped' };
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-image-1',
          prompt: job.prompt,
          size: job.size,
          quality: job.quality,
          n: 1,
        }),
      });
      if (res.status === 429 || res.status >= 500) {
        const wait = Math.min(60000, 2000 * 2 ** attempt) + Math.random() * 1000;
        console.warn(`retry ${job.rel} (HTTP ${res.status}), waiting ${(wait / 1000).toFixed(1)}s`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 400)}`);
      }
      const json = await res.json();
      const b64 = json.data?.[0]?.b64_json;
      if (!b64) throw new Error('no b64_json in response');
      const buf = Buffer.from(b64, 'base64');
      // sanity: PNG header
      if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) {
        throw new Error('response is not a PNG');
      }
      fs.writeFileSync(outPath, buf);
      console.log(`done  ${job.rel} (${(buf.length / 1024).toFixed(0)} KB)`);
      return { job, status: 'generated' };
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        console.error(`FAIL  ${job.rel}: ${err.message}`);
        return { job, status: 'failed', error: err.message };
      }
      const wait = Math.min(60000, 2000 * 2 ** attempt) + Math.random() * 1000;
      console.warn(`retry ${job.rel} (${err.message}), waiting ${(wait / 1000).toFixed(1)}s`);
      await sleep(wait);
    }
  }
}

async function run() {
  console.log(`${jobs.length} images total`);
  const queue = [...jobs];
  const results = [];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const job = queue.shift();
      results.push(await generateOne(job));
    }
  });
  await Promise.all(workers);

  // ---------- manifest (only files that exist and are valid PNGs) ----------
  const isValidPng = (rel) => {
    const p = path.join(IMG_DIR, rel);
    if (!fs.existsSync(p) || fs.statSync(p).size === 0) return false;
    const fd = fs.openSync(p, 'r');
    const head = Buffer.alloc(8);
    fs.readSync(fd, head, 0, 8, 0);
    fs.closeSync(fd);
    return head.readUInt32BE(0) === 0x89504e47;
  };
  const url = (rel) => `/assets/img/${rel}`;

  const assets = { rivals: {}, events: {}, products: {}, rnd: {} };
  if (isValidPng('ui/title-hero.png')) assets.titleHero = url('ui/title-hero.png');
  if (isValidPng('ui/garage.png')) assets.garage = url('ui/garage.png');
  for (const r of ['bumblebuy', 'verdant']) {
    if (isValidPng(`ui/rival-${r}.png`)) assets.rivals[r] = url(`ui/rival-${r}.png`);
  }
  for (const ev of Object.keys(EVENTS)) {
    if (isValidPng(`ui/event-${ev}.png`)) assets.events[ev] = url(`ui/event-${ev}.png`);
  }
  for (const p of CATALOG) {
    if (isValidPng(`products/${p.id}.png`)) assets.products[p.id] = url(`products/${p.id}.png`);
  }
  for (const cat of Object.keys(RND_SUBJECTS)) {
    const arr = [`rnd/${cat}-1.png`, `rnd/${cat}-2.png`].filter(isValidPng).map(url);
    if (arr.length) assets.rnd[cat] = arr;
  }
  const manifest =
    '// Auto-generated by scripts/gen-assets.mjs — do not edit by hand.\n' +
    'export const ASSETS = ' +
    JSON.stringify(assets, null, 2) +
    ';\n';
  fs.writeFileSync(MANIFEST_PATH, manifest);
  console.log(`manifest written: ${MANIFEST_PATH}`);

  const failed = results.filter((r) => r.status === 'failed');
  const generated = results.filter((r) => r.status === 'generated').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  console.log(`generated=${generated} skipped=${skipped} failed=${failed.length}`);
  if (failed.length) {
    for (const f of failed) console.error(`  failed: ${f.job.rel} — ${f.error}`);
    process.exit(2);
  }
}

run();
