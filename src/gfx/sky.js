// Sky dome, sun/ambient lighting, day/night cycle, drifting cloud puffs.
import * as THREE from 'three';
import { makeRng } from '../rng.js';

const SKY_SEASON = {
  spring: { top: '#7fb8e8', bot: '#dceef2' },
  summer: { top: '#6fb2ea', bot: '#e6f2ee' },
  autumn: { top: '#8fa9c9', bot: '#ead9c2' },
  winter: { top: '#9db4c9', bot: '#e8ecef' },
};
const NIGHT = { top: '#0d1b33', bot: '#1c2c49' };
const DUSK = { sun: '#ff9d5c', amb: '#8a76a8' };

export function buildSky(ctx) {
  const { scene, world, seed } = ctx;

  // ---------- gradient dome ----------
  const skyUniforms = {
    uTop: { value: new THREE.Color(SKY_SEASON.summer.top) },
    uBot: { value: new THREE.Color(SKY_SEASON.summer.bot) },
    uStars: { value: 0 },
    uTime: { value: 0 },
    uHaze: { value: 0 },
    uHazeCol: { value: new THREE.Color('#ffb87a') },
  };
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(240, 24, 14),
    new THREE.ShaderMaterial({
      uniforms: skyUniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: /* glsl */`
        varying vec3 vPos;
        void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform vec3 uTop, uBot, uHazeCol;
        uniform float uStars, uTime, uHaze;
        varying vec3 vPos;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        void main() {
          float t = clamp(vPos.y / 180.0, 0.0, 1.0);
          vec3 col = mix(uBot, uTop, pow(t, 0.72));
          // warm horizon haze band at dawn/dusk
          if (uHaze > 0.005) {
            float band = exp(-abs(t - 0.05) * 11.0);
            col = mix(col, uHazeCol, band * uHaze * 0.7);
          }
          if (uStars > 0.01) {
            vec2 sp = floor(vPos.xz * 0.5 + vPos.y);
            float rnd = hash(sp);
            float star = step(0.997, rnd) * uStars * smoothstep(0.15, 0.5, t);
            // subtle per-star twinkle: each star breathes at its own rate
            float tw = 0.72 + 0.28 * sin(uTime * (0.8 + rnd * 2.6) + rnd * 47.0);
            col += star * 0.85 * tw;
          }
          gl_FragColor = vec4(col, 1.0);
        }`,
    })
  );
  dome.name = 'sky';
  scene.add(dome);

  // ---------- lights ----------
  const sun = new THREE.DirectionalLight(0xfff2d8, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const ext = Math.max(world.w, world.h) * 0.62;
  Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 10, far: 160 });
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.5;
  scene.add(sun, sun.target);

  const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x6f6a58, 0.75);
  scene.add(hemi);
  const amb = new THREE.AmbientLight(0xffffff, 0.12);
  scene.add(amb);

  // ---------- moon: low-poly disc + soft additive glow (feeds bloom) ----------
  const moon = new THREE.Group();
  const moonMat = new THREE.MeshBasicMaterial({ color: 0xe9edf4, transparent: true, opacity: 0, fog: false });
  const moonDisc = new THREE.Mesh(new THREE.IcosahedronGeometry(6.5, 1), moonMat);
  moon.add(moonDisc);
  const moonGlowMat = new THREE.MeshBasicMaterial({
    color: 0xaebfdd, transparent: true, opacity: 0, fog: false,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  moon.add(new THREE.Mesh(new THREE.IcosahedronGeometry(10.5, 1), moonGlowMat));
  moon.visible = false;
  scene.add(moon);

  // ---------- cloud puffs: small drifters + a couple of big soft cumulus ----------
  const rng = makeRng((seed ^ 0x77) >>> 0);
  const blobGeo = new THREE.IcosahedronGeometry(1, 0);
  const clouds = [];
  for (let i = 0; i < 8; i++) {
    const big = i >= 6; // 2 big soft cumulus
    const g = new THREE.Group();
    const cloudMat = new THREE.MeshLambertMaterial({
      color: 0xffffff, transparent: true, opacity: big ? 0.78 : 0.88,
      flatShading: true, emissive: 0xffffff, emissiveIntensity: 0.12,
    });
    const n = big ? 6 + Math.floor(rng.next() * 3) : 3 + Math.floor(rng.next() * 3);
    for (let b = 0; b < n; b++) {
      const m = new THREE.Mesh(blobGeo, cloudMat);
      const s = big ? rng.range(2.6, 5.2) : rng.range(1.4, 3.2);
      m.scale.set(s * rng.range(1.1, 1.7), s * (big ? 0.62 : 0.55), s);
      m.position.set(rng.range(-3.5, 3.5) * (big ? 1.8 : 1), rng.range(-0.4, big ? 0.9 : 0.4), rng.range(-1.6, 1.6) * (big ? 1.6 : 1));
      m.castShadow = false; // cloud shadows read as artifacts on the low-poly ground
      g.add(m);
    }
    g.position.set(rng.range(-world.w / 2, world.w / 2), big ? rng.range(19, 24) : rng.range(14, 19), rng.range(-world.h / 2, world.h / 2));
    const speed = big ? rng.range(0.08, 0.16) : rng.range(0.14, 0.32);
    scene.add(g);
    clouds.push({ g, speed, mat: cloudMat, baseOp: cloudMat.opacity });
  }

  // fog for depth
  scene.fog = new THREE.Fog(0xdceef2, 90, 220);

  const sunColor = new THREE.Color();
  const cTop = new THREE.Color(), cBot = new THREE.Color(), cTmp = new THREE.Color();
  const cTmp2 = new THREE.Vector3(), cTmp3 = new THREE.Vector3();
  let dayT = 0.32; // start mid-morning

  return {
    sun,
    // dayLight in [0,1]; nightGlow ~ how lit windows should be
    state: { dayLight: 1, night: 0, sunDir: new THREE.Vector3() },
    update(dt, time, season, stormDim, camTarget, camPos) {
      this._camPos = camPos;
      // slow real-time cycle (~7 min per day, short bright nights)
      dayT = (dayT + dt / 420) % 1;
      // sun elevation: bias so most of the cycle is daytime
      const ang = dayT * Math.PI * 2;
      const elev = Math.sin(ang) * 0.9 + 0.42;             // -0.48 .. 1.32
      const dayLight = THREE.MathUtils.clamp(elev * 1.7, 0, 1);
      const dusk = THREE.MathUtils.clamp(1 - Math.abs(elev) * 3.2, 0, 1); // near horizon
      const night = 1 - THREE.MathUtils.smoothstep(dayLight, 0.02, 0.25);

      // sun direction; at deep night the light hands over to the moon
      // (opposite azimuth) so water glints and shadows read as moonlight
      const sunD = cTmp2.set(Math.cos(ang * 0.7 + 0.8), Math.max(0.12, elev), Math.sin(ang * 0.7 + 0.8)).normalize();
      const moonD = cTmp3.set(-Math.cos(ang * 0.7 + 0.8), Math.max(0.2, -elev * 0.8 + 0.35), -Math.sin(ang * 0.7 + 0.8)).normalize();
      const sd = this.state.sunDir.copy(sunD).lerp(moonD, night).normalize();
      sun.position.copy(sd).multiplyScalar(90);
      sun.target.position.set(0, 0, 0);
      sunColor.set(0xfff2d8).lerp(cTmp.set(DUSK.sun), dusk * 0.85).lerp(cTmp.set('#b9c8e2'), night);
      sun.color.copy(sunColor);
      sun.intensity = (0.5 + 2.3 * dayLight) * (1 - stormDim * 0.55);
      hemi.intensity = (0.38 + 0.5 * dayLight) * (1 - stormDim * 0.4);
      amb.intensity = 0.16 + 0.05 * dayLight;

      // sky colors: season day → dusk (warm-to-violet grade) → night
      const S = SKY_SEASON[season] || SKY_SEASON.summer;
      cTop.set(S.top).lerp(cTmp.set('#b06a8a'), dusk * 0.5).lerp(cTmp.set('#5a4a7a'), dusk * dusk * 0.35).lerp(cTmp.set(NIGHT.top), night);
      cBot.set(S.bot).lerp(cTmp.set('#ffc98a'), dusk * 0.6).lerp(cTmp.set('#ff9d6e'), dusk * dusk * 0.3).lerp(cTmp.set(NIGHT.bot), night);
      if (stormDim > 0) { cTop.lerp(cTmp.set('#3a4352'), stormDim * 0.55); cBot.lerp(cTmp.set('#59606c'), stormDim * 0.55); }
      skyUniforms.uTop.value.copy(cTop);
      skyUniforms.uBot.value.copy(cBot);
      skyUniforms.uStars.value = night;
      skyUniforms.uTime.value = time;
      // warm horizon haze band, strongest at dawn/dusk, gone in storms
      skyUniforms.uHaze.value = dusk * (1 - stormDim * 0.8);
      skyUniforms.uHazeCol.value.set('#ffb87a').lerp(cTmp.set('#e58a9a'), dusk * 0.4);
      scene.fog.color.copy(cBot);

      if (camTarget) dome.position.set(camTarget.x, 0, camTarget.z);

      // moon rides the dome opposite the sun; soft glow feeds bloom
      const moonVis = night * (1 - stormDim * 0.7);
      moon.visible = moonVis > 0.02;
      if (moon.visible) {
        moon.position.copy(moonD).multiplyScalar(200);
        if (camTarget) { moon.position.x += camTarget.x; moon.position.z += camTarget.z; }
        moonMat.opacity = moonVis;
        moonGlowMat.opacity = moonVis * 0.35;
      }

      // drift clouds, wrap at edges; fade out near the camera so we never fly through one
      for (const c of clouds) {
        c.g.position.x += c.speed * dt;
        c.g.position.z += c.speed * 0.55 * dt;
        if (c.g.position.x > world.w / 2 + 14) c.g.position.x = -world.w / 2 - 14;
        if (c.g.position.z > world.h / 2 + 12) c.g.position.z = -world.h / 2 - 10;
        const dCam = this._camPos ? c.g.position.distanceTo(this._camPos) : 99;
        const fade = THREE.MathUtils.clamp((dCam - 8) / 8, 0, 1);
        c.mat.opacity = c.baseOp * fade;
        c.g.visible = fade > 0.02;
      }

      this.state.dayLight = dayLight;
      this.state.night = night;
      return { dayLight, night, sunColor, sunDir: sd };
    },
  };
}
