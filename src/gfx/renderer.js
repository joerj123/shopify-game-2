// WorldRenderer — Three.js world renderer for Shopify Tycoon 3D.
// Public contract (consumed by main.js / ui.js):
//   new WorldRenderer(canvas, state) · resize() · draw(dt) · cam {x,y,zoom}
//   hitTest(clientX, clientY) → {tile, settlement} · hover · pickMode · mode
//   celebrate(sid) · focus(x, y) · attachInput({onHover, onSettlementClick})
// draw(dt) also advances AND PRUNES state.shipAnims / boatAnims / fxAnims.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { settlementAt } from '../world.js';
import { calInfo } from '../sim.js';
import { buildTerrain, SEA_LEVEL } from './terrain.js';
import { buildWater } from './water.js';
import { buildSky } from './sky.js';
import { buildStatic, Premises } from './buildings.js';
import { Vehicles } from './vehicles.js';
import { buildExecs } from './execs.js';
import { Overlay } from './overlay.js';
import { FX } from './fx.js';
import { buildLife } from './life.js';

// Tilt-shift depth of field: separable 9-tap gaussian whose radius ramps with
// distance from a horizontal focus band centered on screen middle. Runs as two
// ShaderPasses (H then V) in LINEAR space (after bloom, before OutputPass) so
// tone mapping / sRGB conversion happen once, afterwards, as before.
const TiltShiftShader = {
  uniforms: {
    tDiffuse: { value: null },
    uDir: { value: new THREE.Vector2(1, 0) },     // (1,0) = horizontal pass, (0,1) = vertical
    uTexel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
    uMax: { value: 2.5 },                          // max blur radius in device px (scaled by dpr)
    uBand: { value: 0.225 },                       // half-height of the sharp band (~45% of screen)
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uDir;
    uniform vec2 uTexel;
    uniform float uMax;
    uniform float uBand;
    varying vec2 vUv;
    void main() {
      float d = abs(vUv.y - 0.5);
      float amt = smoothstep(uBand, 0.5, d) * uMax;
      vec2 stp = uDir * uTexel * amt;
      vec4 c = texture2D(tDiffuse, vUv) * 0.227027;
      c += texture2D(tDiffuse, vUv + stp * 1.0) * 0.1945946;
      c += texture2D(tDiffuse, vUv - stp * 1.0) * 0.1945946;
      c += texture2D(tDiffuse, vUv + stp * 2.0) * 0.1216216;
      c += texture2D(tDiffuse, vUv - stp * 2.0) * 0.1216216;
      c += texture2D(tDiffuse, vUv + stp * 3.0) * 0.054054;
      c += texture2D(tDiffuse, vUv - stp * 3.0) * 0.054054;
      c += texture2D(tDiffuse, vUv + stp * 4.0) * 0.016216;
      c += texture2D(tDiffuse, vUv - stp * 4.0) * 0.016216;
      gl_FragColor = c;
    }`,
};

const VignetteShader = {
  uniforms: { tDiffuse: { value: null }, uStrength: { value: 0.42 } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uStrength;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 p = vUv - 0.5;
      float v = 1.0 - dot(p, p) * uStrength * 1.6;
      gl_FragColor = vec4(c.rgb * clamp(v, 0.0, 1.0), c.a);
    }`,
};

export class WorldRenderer {
  constructor(canvas, state) {
    this.canvas = canvas;
    this.state = state;
    const world = state.world;

    // ---- public contract fields ----
    this.cam = { x: world.w / 2, y: world.h / 2, zoom: 1.4 };
    this.mode = 'terrain';
    this.hover = null;
    this.pickMode = false;

    // ---- three core ----
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.5, 500);
    this.yaw = Math.PI * 0.25;      // orbit angle
    this.pitch = 0.7;               // ~40° from horizontal
    this.baseDist = 40;

    // ---- world modules ----
    const terrain = buildTerrain({ world, seed: state.seed });
    this.terrain = terrain;
    const ctx = {
      world, seed: state.seed, scene: this.scene,
      heightAt: terrain.heightAt,
      groundH: terrain.groundH,
      ox: terrain.ox, oz: terrain.oz,
    };
    this.ctx = ctx;
    this.scene.add(terrain.mesh, terrain.bridgeGroup);

    this.water = buildWater(ctx, terrain.shore);
    this.scene.add(this.water.mesh);

    this.sky = buildSky(ctx);
    this.staticB = buildStatic(ctx);
    this.scene.add(this.staticB.group);

    this.premises = new Premises(ctx);
    this.scene.add(this.premises.group);

    this.vehicles = new Vehicles(ctx);
    this.scene.add(this.vehicles.group);

    this.execs = buildExecs(ctx);       // SIM2 executive pawns
    this.scene.add(this.execs.group);

    this.overlay = new Overlay(ctx);
    this.scene.add(this.overlay.group);

    this.fx = new FX(ctx);
    this.scene.add(this.fx.group);
    this._townFX = (sid, kind) => this.fx.townFX(sid, kind);   // living-town flourish hook

    this.life = buildLife(ctx, state);
    this.scene.add(this.life.group);

    // initial season
    this.season = calInfo(state).season;
    terrain.colorize(this.season);
    this.staticB.setSeason(this.season);

    // ---- post ----
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.32, 0.7, 0.85);
    this.composer.addPass(this.bloom);
    // tilt-shift DoF (miniature look) — linear space, before tone mapping
    this.tiltShift = true;
    this.tiltH = new ShaderPass(TiltShiftShader);
    this.tiltH.uniforms.uDir.value.set(1, 0);
    this.tiltV = new ShaderPass(TiltShiftShader);
    this.tiltV.uniforms.uDir.value.set(0, 1);
    this.composer.addPass(this.tiltH);
    this.composer.addPass(this.tiltV);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(new ShaderPass(VignetteShader));

    // ---- misc state ----
    this.time = 0;
    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.camTarget = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._camInit = false;
    this._handlers = null;
    this._drag = null;
    this._keys = new Set();     // currently-held nav keys (KeyboardEvent.code)
    this._groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -SEA_LEVEL);
    this._v3 = new THREE.Vector3();

    // ---- cinematics state ----
    this._fly = null;        // active fly-to: {t, dur, sx, sy, tx, ty, z0}
    this._idleT = 0;         // seconds since last user input
    this._driftHold = 0;     // short suppression of idle drift after wheel
    this._pop = 0;           // exposure-pop timer (celebrations)
  }

  // ================= sizing =================
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width), h = Math.max(1, rect.height);
    // Post chain (bloom + tilt-shift) at full retina is the frame budget's
    // biggest line item; 1.5 is visually indistinguishable at this art style.
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w * dpr, h * dpr);
    for (const p of [this.tiltH, this.tiltV]) {
      p.uniforms.uTexel.value.set(1 / (w * dpr), 1 / (h * dpr));
      p.uniforms.uMax.value = 2.5 * dpr;   // ~2.5px at DPR 1
    }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ================= camera =================
  // Eased fly-to over ~1.1s (easeInOutCubic) with a gentle zoom dip. A second
  // call mid-flight retargets from the current position; drag/wheel cancels.
  focus(x, y) {
    const world = this.state.world;
    this._fly = {
      t: 0, dur: 1.1,
      sx: this.cam.x, sy: this.cam.y,
      tx: Math.min(world.w, Math.max(0, x)),
      ty: Math.min(world.h, Math.max(0, y)),
      z0: this._fly ? this._fly.z0 : this.cam.zoom,   // keep undipped zoom on retarget
    };
  }

  // Smooth keyboard nav, applied every frame while keys are held.
  // WASD/arrows pan (screen-relative, scaled by 1/zoom), +/- zoom toward
  // screen center, Q/E rotate yaw. R (one-shot) is handled in attachInput.
  _updateKeys(dt) {
    const k = this._keys;
    if (!k.size) return;
    let px = 0, py = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) py += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) py -= 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) px -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) px += 1;
    if (px || py) {
      const speed = (18 / this.cam.zoom) * dt;
      // screen-up on the ground is the direction from camera toward target
      const fx = -Math.cos(this.yaw), fy = -Math.sin(this.yaw);   // forward (tile coords)
      const rx = Math.sin(this.yaw), ry = -Math.cos(this.yaw);    // screen-right
      const n = px && py ? Math.SQRT1_2 : 1;                      // no diagonal boost
      this.cam.x += (fx * py + rx * px) * speed * n;
      this.cam.y += (fy * py + ry * px) * speed * n;
    }
    if (k.has('Equal') || k.has('NumpadAdd')) this.cam.zoom = Math.min(4, this.cam.zoom * (1 + 1.6 * dt));
    if (k.has('Minus') || k.has('NumpadSubtract')) this.cam.zoom = Math.max(0.6, this.cam.zoom / (1 + 1.6 * dt));
    if (k.has('KeyQ')) this.yaw -= 1.4 * dt;
    if (k.has('KeyE')) this.yaw += 1.4 * dt;
  }

  _updateCinematics(dt) {
    // fly-to
    const f = this._fly;
    if (f) {
      f.t += dt;
      const p = Math.min(1, f.t / f.dur);
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      this.cam.x = f.sx + (f.tx - f.sx) * e;
      this.cam.y = f.sy + (f.ty - f.sy) * e;
      this.cam.zoom = f.z0 * (1 - 0.15 * Math.sin(Math.PI * p));  // zoom dip at midpoint
      if (p >= 1) { this.cam.x = f.tx; this.cam.y = f.ty; this.cam.zoom = f.z0; this._fly = null; }
    }
    // idle cinematic drift: pick mode, or 45s without input; halts while dragging
    this._idleT += dt;
    if (this._driftHold > 0) this._driftHold -= dt;
    if (!this._drag && this._driftHold <= 0 && (this.pickMode || this._idleT > 45)) {
      this.yaw += 0.02 * dt;
    }
  }

  _updateCamera(dt, immediate = false) {
    const world = this.state.world;
    this.cam.x = Math.min(world.w, Math.max(0, this.cam.x));
    this.cam.y = Math.min(world.h, Math.max(0, this.cam.y));
    this.cam.zoom = Math.min(4, Math.max(0.6, this.cam.zoom));
    const tx = this.cam.x - world.w / 2, tz = this.cam.y - world.h / 2;
    const ty = Math.max(SEA_LEVEL, this.terrain.heightAt(this.cam.x, this.cam.y));
    const target = this._v3.set(tx, ty, tz);
    const k = immediate ? 1 : 1 - Math.exp(-10 * dt);
    this.camTarget.lerp(target, this._camInit ? k : 1);
    const dist = this.baseDist / this.cam.zoom;
    const cy = Math.sin(this.pitch) * dist;
    const ch = Math.cos(this.pitch) * dist;
    const px = this.camTarget.x + Math.cos(this.yaw) * ch;
    const pz = this.camTarget.z + Math.sin(this.yaw) * ch;
    if (this._camInit && !immediate) this._camPos.lerp(this._v3.set(px, this.camTarget.y + cy, pz), k);
    else this._camPos.set(px, this.camTarget.y + cy, pz);
    this._camInit = true;
    this.camera.position.copy(this._camPos);
    this.camera.lookAt(this.camTarget);
  }

  _groundPoint(clientX, clientY, out) {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.terrain.mesh, false);
    if (hits.length && hits[0].point.y >= SEA_LEVEL - 0.02) { out.copy(hits[0].point); return out; }
    // underwater terrain (seabed) or no land hit → use the sea surface instead
    if (this.raycaster.ray.intersectPlane(this._groundPlane, out)) return out;
    if (hits.length) { out.copy(hits[0].point); return out; }
    return null;
  }

  // ================= picking =================
  hitTest(clientX, clientY) {
    const world = this.state.world;
    const p = this._groundPoint(clientX, clientY, this._v3);
    if (!p) return { tile: { x: this.cam.x, y: this.cam.y }, settlement: null, citizen: null };
    const tx = p.x + world.w / 2, ty = p.z + world.h / 2;
    const settlement = settlementAt(world, tx, ty);
    // _groundPoint already aimed this.raycaster at the cursor; when no
    // settlement is under it, try tiny street-life (peds/cars) instead
    const citizen = settlement ? null : this.life.pick(this.raycaster);
    return { tile: { x: tx, y: ty }, settlement, citizen };
  }

  celebrate(sid) { this.fx.celebrate(sid); this._pop = 0.15; }

  // ================= input (pan / zoom / orbit / pick) =================
  attachInput(handlers) {
    this._handlers = handlers;
    const el = this.canvas;
    const grab = new THREE.Vector3();

    el.addEventListener('pointerdown', (e) => {
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic events have no active pointer */ }
      this._fly = null;          // user takes over: cancel any fly-to
      this._idleT = 0;           // and stop idle drift instantly
      this._driftHold = 2;
      const orbit = e.button === 2 || (e.button === 0 && (e.ctrlKey || e.altKey));
      this._drag = {
        button: e.button, orbit,
        sx: e.clientX, sy: e.clientY,
        lx: e.clientX, ly: e.clientY,
        moved: 0,
        camX: this.cam.x, camY: this.cam.y,
        yaw: this.yaw, pitch: this.pitch,
      };
      if (!orbit) {
        const p = this._groundPoint(e.clientX, e.clientY, grab);
        this._drag.grabbed = p ? p.clone() : null;
      }
    });

    el.addEventListener('pointermove', (e) => {
      const d = this._drag;
      if (!d) {
        // hover picking (suppressed while dragging)
        const hit = this.hitTest(e.clientX, e.clientY);
        this.hover = hit;
        el.style.cursor = (hit.settlement || hit.citizen) ? 'pointer' : '';
        if (this._handlers) this._handlers.onHover(hit, e.clientX, e.clientY);
        return;
      }
      d.moved += Math.abs(e.clientX - d.lx) + Math.abs(e.clientY - d.ly);
      if (d.moved > 6 && !d.isDrag) {
        d.isDrag = true;
        el.classList.add('dragging');
        this.hover = null;
        if (this._handlers) this._handlers.onHover(null, e.clientX, e.clientY);
      }
      if (d.orbit) {
        this.yaw = d.yaw + (e.clientX - d.sx) * 0.006;
        this.pitch = Math.min(1.25, Math.max(0.45, d.pitch + (e.clientY - d.sy) * 0.004));
        this._updateCamera(0, true);
      } else if (d.isDrag && d.grabbed) {
        // keep the grabbed ground point under the cursor
        this._updateCamera(0, true);
        const p = this._groundPoint(e.clientX, e.clientY, grab);
        if (p) {
          this.cam.x += d.grabbed.x - p.x;
          this.cam.y += d.grabbed.z - p.z;
          this._updateCamera(0, true);
        }
      }
      d.lx = e.clientX; d.ly = e.clientY;
    });

    const end = (e) => {
      const d = this._drag;
      this._drag = null;
      el.classList.remove('dragging');
      if (!d) return;
      if (!d.isDrag && d.button === 0 && this._handlers) {
        const hit = this.hitTest(e.clientX, e.clientY);
        if (hit.settlement) this._handlers.onSettlementClick(hit.settlement);
        else if (hit.citizen && this._handlers.onCitizenClick) this._handlers.onCitizenClick(hit.citizen, e.clientX, e.clientY);
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', () => { this._drag = null; el.classList.remove('dragging'); });
    el.addEventListener('pointerleave', (e) => {
      this.hover = null;
      if (!this._drag && this._handlers) this._handlers.onHover(null, e.clientX, e.clientY);
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._fly = null;
      this._idleT = 0;
      this._driftHold = 2;
      const world = this.state.world;
      const before = this._groundPoint(e.clientX, e.clientY, grab);
      const k = e.deltaY < 0 ? 1.12 : 0.89;
      const oldZoom = this.cam.zoom;
      this.cam.zoom = Math.min(4, Math.max(0.6, this.cam.zoom * k));
      if (before) {
        // move the camera target toward the cursor point so it stays put
        const f = 1 - oldZoom / this.cam.zoom;
        this.cam.x += (before.x + world.w / 2 - this.cam.x) * f;
        this.cam.y += (before.z + world.h / 2 - this.cam.y) * f;
      }
    }, { passive: false });

    // ---- keyboard nav (window-level: the canvas rarely has focus) ----
    // WASD/arrows pan · +/- zoom · Q/E rotate · R reset view. main.js owns
    // Space/1/2/3 on its own listener; we neither consume nor duplicate them.
    const PAN_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
    const NAV_CODES = new Set([...PAN_CODES, 'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract', 'KeyQ', 'KeyE']);
    window.addEventListener('keydown', (e) => {
      if (e.target && e.target.matches && e.target.matches('input,select,textarea')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'KeyR') { this.yaw = Math.PI * 0.25; this.pitch = 0.7; this._idleT = 0; return; }
      if (!NAV_CODES.has(e.code)) return;
      e.preventDefault();               // arrows scroll the page otherwise
      this._keys.add(e.code);
      this._idleT = 0;
      this._driftHold = 2;
      if (PAN_CODES.has(e.code)) this._fly = null;   // user takes over: cancel fly-to
    });
    window.addEventListener('keyup', (e) => { this._keys.delete(e.code); });
    window.addEventListener('blur', () => this._keys.clear());
  }

  // ================= frame =================
  draw(dt) {
    this.time += dt;
    const state = this.state;
    const cal = calInfo(state);

    // seasonal recolor (terrain rebuilt once; only colors change)
    if (cal.season !== this.season) {
      this.season = cal.season;
      this.terrain.colorize(this.season);
      this.staticB.setSeason(this.season);
    }

    // weather
    const storm = (state.activeEvents || []).find(ev => ev.key === 'storm');
    const stormDim = storm ? 1 : 0;

    // sky, sun, day/night
    const light = this.sky.update(dt, this.time, this.season, stormDim, this.camTarget, this.camera.position);
    this.water.update(this.time, light.sunDir, light.sunColor, light.dayLight * (1 - stormDim * 0.4));
    this.staticB.sync(state, this.time, this._townFX);   // living towns: day-throttled tier/pop check
    this.staticB.update(this.time, light.night, cal.month === 12);

    // dynamic world objects
    this.premises.sync(state);           // cheap dirty-check; rebuilds only on change
    this.premises.update(this.time);
    this.vehicles.update(dt, this.time, state, light.night);   // advances + prunes shipAnims/boatAnims
    this.execs.update(dt, this.time, state);   // exec pawns (execTravels is sim-pruned; read-only)
    this.life.update(dt, this.time, state, light);
    const flash = this.fx.update(dt, this.time, state, cal, this.camTarget, !!storm, storm && storm.stormCenter);

    // overlays
    this.overlay.update(this.time, state, this.mode, this.pickMode, this.hover, this.cam.zoom);

    // camera + render
    this._updateKeys(dt);
    this._updateCinematics(dt);
    this._updateCamera(dt);
    if (this._pop > 0) this._pop -= dt;                    // celebration exposure pop
    const pop = this._pop > 0 ? (this._pop / 0.15) * 0.22 : 0;
    this.tiltH.enabled = this.tiltV.enabled = !!this.tiltShift;
    this.renderer.toneMappingExposure = 1.05 * (1 - stormDim * 0.18) + flash * 1.4 + pop;
    this.bloom.strength = 0.26 + light.night * 0.22;
    this.composer.render();
  }
}
