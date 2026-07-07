// Animated water: two scrolling sine layers in the vertex shader, shoreline
// foam driven by a distance-to-land texture, sun specular, slight transparency.
import * as THREE from 'three';
import { SEA_LEVEL } from './terrain.js';

export function buildWater(ctx, shore) {
  const { world } = ctx;
  const { w, h } = world;

  // shore-distance data texture (R = distance in tiles / 6, clamped)
  const data = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) data[i] = Math.min(255, Math.round(Math.min(6, shore[i]) / 6 * 255));
  const shoreTex = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.UnsignedByteType);
  shoreTex.magFilter = THREE.LinearFilter;
  shoreTex.minFilter = THREE.LinearFilter;
  // the water plane is 4x the map — never let border texels smear outward
  shoreTex.wrapS = THREE.ClampToEdgeWrapping;
  shoreTex.wrapT = THREE.ClampToEdgeWrapping;
  shoreTex.needsUpdate = true;

  const uniforms = {
    uTime: { value: 0 },
    uShore: { value: shoreTex },
    uDeep: { value: new THREE.Color('#1b6f8f') },
    uDeepFar: { value: new THREE.Color('#155b7d') },
    uShallow: { value: new THREE.Color('#3ba7c9') },
    uFoam: { value: new THREE.Color('#eef7f4') },
    uNightCol: { value: new THREE.Color('#101d33') },
    uMoonCol: { value: new THREE.Color('#cfdcec') },
    uSunDir: { value: new THREE.Vector3(0.5, 0.8, 0.3) },
    uSunColor: { value: new THREE.Color('#fff2d8') },
    uDayLight: { value: 1 },
    uMapSize: { value: new THREE.Vector2(w, h) },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    vertexShader: /* glsl */`
      uniform float uTime;
      varying vec2 vTile;
      varying vec3 vWorldPos;
      varying float vWave;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        float w1 = sin(wp.x * 1.7 + uTime * 1.1) * 0.035;
        float w2 = sin(wp.z * 2.3 - uTime * 0.8 + wp.x * 0.6) * 0.03;
        float w3 = sin((wp.x + wp.z) * 3.1 + uTime * 1.7) * 0.012; // second octave
        wp.y += w1 + w2 + w3;
        vWave = (w1 + w2 + w3 * 1.5) * 14.0;
        vWorldPos = wp.xyz;
        vTile = wp.xz; // world xz == tile coords - map/2
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uShore;
      uniform vec3 uDeep, uDeepFar, uShallow, uFoam, uSunColor, uNightCol, uMoonCol;
      uniform vec3 uSunDir;
      uniform float uTime, uDayLight;
      uniform vec2 uMapSize;
      varying vec2 vTile;
      varying vec3 vWorldPos;
      varying float vWave;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
                   mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
      void main() {
        vec2 uv = (vTile + uMapSize * 0.5) / uMapSize;
        // The shore-distance field only covers the map; the water plane is 4x
        // larger. Outside the field there is no data — clamped edge texels
        // would smear coastal distances into open sea as giant foam stripes.
        // Fade to "far offshore" (d = 1) within half a tile past the border.
        vec2 edgeT = (abs(uv - 0.5) - 0.5) * uMapSize; // tiles beyond map edge
        float valid = 1.0 - clamp(max(edgeT.x, edgeT.y) / 0.5, 0.0, 1.0);
        float d = mix(1.0, texture2D(uShore, clamp(uv, 0.0, 1.0)).r, valid); // 0 at land, 1 far out
        // deeper color gradient with distance from shore
        vec3 col = mix(uShallow, uDeep, smoothstep(0.04, 0.5, d));
        col = mix(col, uDeepFar, smoothstep(0.5, 0.95, d));
        // broad moving swell tint (kept low-frequency to avoid moiré)
        float rip = sin(vTile.x * 0.55 + uTime * 0.6) * sin(vTile.y * 0.42 - uTime * 0.45);
        col += rip * 0.018;
        // foam lives only near coastlines: hard-fade to zero past ~2 tiles
        float nearCoast = 1.0 - smoothstep(0.26, 0.34, d);
        // shoreline foam: pulsing band whose edge breathes with drifting noise
        float breathe = (vnoise(vTile * 0.9 + vec2(uTime * 0.22, -uTime * 0.17)) - 0.5) * 0.07;
        float band = smoothstep(0.16 + breathe, 0.02, d);
        float pulse = 0.55 + 0.45 * sin(uTime * 1.4 - d * 34.0 + breathe * 40.0);
        float foam = band * pulse * nearCoast;
        // sparkle foam on wave crests just off the beach (never in open sea)
        foam += smoothstep(0.75, 1.0, vWave) * 0.12 * step(0.1, d) * nearCoast;
        col = mix(col, uFoam, clamp(foam, 0.0, 1.0) * 0.85);
        // animated normal perturbation: cheap time-scrolled second octave
        vec2 np = vec2(
          sin(vTile.x * 2.2 + uTime * 1.3) + sin((vTile.x + vTile.y) * 1.4 - uTime * 0.9),
          cos(vTile.y * 1.9 - uTime * 1.1) + sin((vTile.y - vTile.x) * 1.6 + uTime * 0.7));
        vec3 nrm = normalize(vec3(vWave * 0.12 + np.x * 0.05, 1.0, vWave * 0.09 + np.y * 0.05));
        vec3 viewDir = normalize(cameraPosition - vWorldPos);
        vec3 hv = normalize(normalize(uSunDir) + viewDir);
        float night = 1.0 - smoothstep(0.05, 0.3, uDayLight);
        // glint: warm sun by day, cool narrow moon glint at night (uSunDir = moon then)
        float spec = pow(max(dot(nrm, hv), 0.0), mix(90.0, 220.0, night));
        // sun-glint sparkles: screen-door specular boost, twinkling per cell
        float cell = hash(floor(gl_FragCoord.xy / 3.0));
        float sparkle = step(0.965, fract(cell + uTime * (0.35 + cell * 0.4)));
        spec *= 1.0 + sparkle * 3.5;
        vec3 glintCol = mix(uSunColor, uMoonCol, night);
        col += glintCol * spec * mix(0.6 * uDayLight, 0.5, night);
        // night: settle into dark navy instead of plain darkening
        col = mix(col * mix(0.45, 1.0, uDayLight), uNightCol + col * 0.18, night * 0.85);
        gl_FragColor = vec4(col, 0.97);
      }`,
  });

  const geo = new THREE.PlaneGeometry(w * 4, h * 4, 128, 96);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = SEA_LEVEL;
  mesh.name = 'water';
  mesh.renderOrder = 1;

  // opaque seabed far below so deep water never shows the sky through it
  const seabed = new THREE.Mesh(
    new THREE.PlaneGeometry(w * 4, h * 4),
    new THREE.MeshBasicMaterial({ color: 0x14424e })
  );
  seabed.rotation.x = -Math.PI / 2;
  seabed.position.y = -1.0;
  mesh.add(seabed);

  return {
    mesh,
    update(time, sunDir, sunColor, dayLight) {
      uniforms.uTime.value = time;
      uniforms.uSunDir.value.copy(sunDir);
      uniforms.uSunColor.value.copy(sunColor);
      uniforms.uDayLight.value = dayLight;
    },
  };
}
