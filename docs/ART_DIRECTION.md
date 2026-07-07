# Shopify Tycoon 3D — Art Direction

One cohesive look across the 3D world and the HTML UI. Read this before writing any visual code.

## Mood
Cozy premium strategy game. Think *Townscaper* × *Two Point Hospital* × *Monument Valley*: soft low-poly forms, warm golden-hour light, gentle motion everywhere. Nothing harsh, nothing neon, nothing "retro pixel". It should look like a shipped indie hit, not a tech demo.

## 3D world (renderer)
- **Terrain**: low-poly island, one merged mesh with vertex colors, flat shading, gentle elevation exaggeration. Slightly rounded color noise per tile so fields aren't flat fills.
- **Palette (terrain)**: water deep `#1b6f8f` → shallow `#3ba7c9`; sand `#e8d5a3`; grass `#7cb95c` (season-shifted); forest `#4e8f4a` + darker cone/blob trees; hill `#9aa06b`; mountain `#8d8577` with snow caps `#efeee9`; road `#b8a98e` ribbons; bridge planks `#a67c52`.
- **Seasons** tint grass/forest: spring fresh green, summer saturated, autumn `#c9973f` shift, winter desaturated + snow on ground/roofs.
- **Water**: animated shader — two scrolling sine layers, foam ring at shoreline, subtle specular from sun. Slight transparency over a darker seabed plane.
- **Buildings**: chunky stylized boxes with colored roofs; cities = clusters incl. 2-3 small towers, towns = houses, villages = cottages. Player buildings glow: store = brand-colored awning + emissive sign, warehouse = big flat-roof box with loading bay, HQ = the garage (warm emissive windows). Construction = wooden scaffold + crane arm that rotates.
- **Vehicles**: rounded box delivery trucks (player-brand color) following road paths with smooth bearing turns; freighter on the sea lane leaving a foam wake.
- **Sky & light**: gradient sky dome, warm key directional sun + soft ambient; slow day cycle tied to game days (dawn/dusk hues); night = cool blue + emissive windows. Soft round cloud puffs (billboard or merged low-poly blobs) drifting.
- **Weather**: rain = GPU particle streaks + darker light; storm = same + flash; snow in winter.
- **Post**: subtle bloom (emissives, water sparkle), vignette. Keep it restrained.
- **Camera**: orthographic-feel perspective (fov ~30) at iso-like pitch (~40°), orbitable ±, smooth damped pan/zoom. Business mode overlays: translucent green awareness domes, blue penetration rings, red competition pips floating.

## UI (HTML/CSS)
- **Style**: dark warm glassmorphism. Background panels `rgba(20,24,32,.82)` with `backdrop-filter: blur(14px)`, 14px radius, 1px `rgba(255,255,255,.08)` border, soft shadow.
- **Accent palette**: brand green `#3ddc84` (money/positive), amber `#ffb84d` (attention), coral `#ff6b5e` (danger/rivals), sky `#5ac8e0` (info). Text `#f2f0ea` on dark; dim `#9aa3ad`.
- **Type**: 'Sora' or 'Outfit' style geometric sans via system fallback stack (`Outfit, Sora, Avenir Next, system-ui`) — bundle nothing. Headings 600, numbers tabular-lining (`font-variant-numeric: tabular-nums`).
- **Product cards**: generated images (from `src/data/assets-manifest.js`) on cream `#f6f1e7` rounded tiles — the images have that exact background so they blend seamlessly.
- **Motion**: 150–250ms ease-out transitions; toasts slide+fade; money changes pulse; no bouncy overshoot.
- **Buttons**: pill, subtle gradient, pressable (1px translate). Primary = green gradient.
- **Charts** (finance): thin-line sparkline SVGs, green/coral, soft area fill.

## Title / onboarding
Full-screen hero using `assets/img/ui/title-hero.png` with dark gradient overlay, game logotype in UI type, glass card for company naming. Should feel like a store-page splash.

## Don'ts
No pixel fonts, no scanlines, no drop-shadowed neon, no emoji as icons in the world (UI emoji are ok sparingly), no pure black or pure white anywhere.
