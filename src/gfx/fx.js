// One-shot effects: celebrate() layered bursts (ground ring + confetti
// fountain + firework rockets), state.fxAnims confetti rain, money floaters,
// weather particles (rain/snow), storm cloud + lightning flash.
// draw() advances AND PRUNES state.fxAnims here (spec §1.9).
// All celebration/floater systems are pooled — zero steady-state allocations.
import * as THREE from 'three';

const CONFETTI = [0x3ddc84, 0xffd24d, 0x5ac8e0, 0xe06fae];

// celebration particle modes (RISE/DUST added for SIM2 living-town FX)
const DEAD = 0, CONF = 1, ROCKET = 2, SPARK = 3, RISE = 4, DUST = 5;
const GRAV = [0, 3.2, 2.6, 3.4, -0.25, 1.4];   // indexed by mode (RISE floats up)
const CELEB_N = 250;
const HIDDEN_Y = -1000;

function makeMoneyTexture(color, glow) {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 40;
  const c2 = cv.getContext('2d');
  c2.font = 'bold 26px Outfit, Sora, Avenir Next, system-ui, sans-serif';
  c2.textAlign = 'center'; c2.textBaseline = 'middle';
  c2.shadowColor = glow;
  c2.shadowBlur = 7;
  c2.fillStyle = color;
  c2.fillText('+$', 32, 21);
  const tex = new THREE.CanvasTexture(cv);
  return tex;
}

export class FX {
  constructor(ctx) {
    this.ctx = ctx;
    this.group = new THREE.Group();
    this.group.name = 'fx';
    this.fxParticles = new Map(); // fxAnim → {points, data}
    this.lightning = 0;

    // ---- pooled celebration particles: one additive Points, 250 slots ----
    // Additive blending so fading a particle's color to black fades it out
    // without needing per-particle opacity.
    {
      const pos = new Float32Array(CELEB_N * 3);
      const col = new Float32Array(CELEB_N * 3);
      for (let i = 0; i < CELEB_N; i++) pos[i * 3 + 1] = HIDDEN_Y;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      this.celebPoints = new THREE.Points(geo, new THREE.PointsMaterial({
        size: 0.16, vertexColors: true, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      this.celebPoints.frustumCulled = false;
      this.group.add(this.celebPoints);
      this.cData = [];
      this.cFree = [];
      for (let i = 0; i < CELEB_N; i++) {
        this.cData.push({ mode: DEAD, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 0, r: 0, g: 0, b: 0 });
        this.cFree.push(i);
      }
      this._col = new THREE.Color();
    }

    // ---- pooled expanding ground rings (celebrate) ----
    this.rings = [];
    {
      const geo = new THREE.RingGeometry(0.55, 0.75, 40);
      geo.rotateX(-Math.PI / 2);
      for (let i = 0; i < 3; i++) {
        const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
          color: 0x3ddc84, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
        }));
        mesh.visible = false;
        this.group.add(mesh);
        this.rings.push({ mesh, t: -1 });
      }
    }

    // ---- pooled money floaters ("+$" above earning premises) ----
    this.money = [];
    {
      const texes = [
        makeMoneyTexture('#3ddc84', 'rgba(61,220,132,0.9)'),
        makeMoneyTexture('#7ee2a8', 'rgba(126,226,168,0.9)'),
        makeMoneyTexture('#4fcf90', 'rgba(79,207,144,0.9)'),
      ];
      for (let i = 0; i < 12; i++) {
        const spr = new THREE.Sprite(new THREE.SpriteMaterial({
          map: texes[i % 3], transparent: true, opacity: 0, depthWrite: false,
        }));
        spr.scale.set(0.7, 0.44, 1);
        spr.visible = false;
        this.group.add(spr);
        this.money.push({ spr, t: -1 });
      }
      this._moneyCd = 0;
      this._lastDay = -1;
      this._wonCd = 6;   // first ambient win burst shortly after the $1B flip
    }

    // ---- precipitation: one Points cloud recycled for rain & snow ----
    const N = 700;
    this.precipN = N;
    const pos = new Float32Array(N * 3);
    this.precipSeed = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      this.precipSeed[i * 2] = Math.random();
      this.precipSeed[i * 2 + 1] = Math.random();
      pos[i * 3] = 0; pos[i * 3 + 1] = -100; pos[i * 3 + 2] = 0;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.precipMat = new THREE.PointsMaterial({ color: 0xdfeef5, size: 0.09, transparent: true, opacity: 0.7, depthWrite: false, sizeAttenuation: true });
    this.precip = new THREE.Points(geo, this.precipMat);
    this.precip.frustumCulled = false;
    this.precip.visible = false;
    this.group.add(this.precip);

    // ---- storm cloud blob group (moved to stormCenter when active) ----
    this.stormCloud = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0x3c4450, transparent: true, opacity: 0.9, flatShading: true });
    const blob = new THREE.IcosahedronGeometry(1, 0);
    for (let i = 0; i < 5; i++) {
      const m = new THREE.Mesh(blob, mat);
      m.scale.set(1.8 + (i % 3), 0.8, 1.4 + ((i * 7) % 3) * 0.5);
      m.position.set((i - 2) * 1.6, (i % 2) * 0.5, ((i * 3) % 4) - 1.5);
      this.stormCloud.add(m);
    }
    this.stormCloud.position.y = 9;
    this.stormCloud.visible = false;
    this.group.add(this.stormCloud);
  }

  _spawnCeleb(mode, x, y, z, vx, vy, vz, age, life, colorHex) {
    if (this.cFree.length === 0) return;
    const i = this.cFree.pop();
    const p = this.cData[i];
    p.mode = mode; p.x = x; p.y = y; p.z = z;
    p.vx = vx; p.vy = vy; p.vz = vz;
    p.age = age; p.life = life;
    this._col.set(colorHex);
    p.r = this._col.r; p.g = this._col.g; p.b = this._col.b;
  }

  // layered burst at a settlement: expanding ground ring + 2-stage confetti
  // fountain + 6 firework rockets that arc up and pop into sparks
  celebrate(sid) {
    const { world, groundH, ox, oz } = this.ctx;
    const s = world.settlements.find(o => o.id === sid);
    if (!s) return;
    const x = s.x + 0.5 + ox, z = s.y + 0.5 + oz;
    const y = groundH(s.x + 0.5, s.y + 0.5) + 0.15;

    // ground ring
    for (const rg of this.rings) {
      if (rg.t >= 0) continue;
      rg.t = 0;
      rg.mesh.visible = true;
      rg.mesh.position.set(x, y + 0.05, z);
      rg.mesh.scale.set(0.3, 1, 0.3);
      break;
    }
    // confetti fountain, two stages (second wave delayed 0.35s via negative age)
    for (let stage = 0; stage < 2; stage++) {
      for (let i = 0; i < 52; i++) {
        const ang = Math.random() * Math.PI * 2;
        const sp = 0.3 + Math.random() * 0.9;
        this._spawnCeleb(CONF, x, y + 0.2, z,
          Math.cos(ang) * sp, 2.1 + Math.random() * 1.5, Math.sin(ang) * sp,
          stage * -0.35, 1.1 + Math.random() * 0.5, CONFETTI[i % 4]);
      }
    }
    // 6 rockets arcing outward; each pops into sparks when its fuse ends
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2 + Math.random() * 0.5;
      const sp = 0.8 + Math.random() * 0.8;
      this._spawnCeleb(ROCKET, x, y + 0.2, z,
        Math.cos(ang) * sp, 3.4 + Math.random() * 1.1, Math.sin(ang) * sp,
        -0.1 - Math.random() * 0.25, 0.55 + Math.random() * 0.3, 0xfff3c9);
    }
  }

  // SIM2 living towns: 'grow' = green sparkles rising over the cluster,
  // 'shrink' = grey dust settling. Pooled — reuses the celebration particles.
  townFX(sid, kind) {
    const { world, groundH, ox, oz } = this.ctx;
    const s = world.settlements.find(o => o.id === sid);
    if (!s) return;
    const cx = s.x + 0.5 + ox, cz = s.y + 0.5 + oz;
    const y = groundH(s.x + 0.5, s.y + 0.5);
    const rad = s.type === 'city' ? 2.2 : s.type === 'town' ? 1.5 : 1.0;
    if (kind === 'grow') {
      for (let i = 0; i < 36; i++) {
        const ang = Math.random() * Math.PI * 2, r = Math.random() * rad;
        this._spawnCeleb(RISE, cx + Math.cos(ang) * r, y + 0.1, cz + Math.sin(ang) * r,
          (Math.random() - 0.5) * 0.15, 0.7 + Math.random() * 0.8, (Math.random() - 0.5) * 0.15,
          -Math.random() * 0.6, 1.1 + Math.random() * 0.6, i % 3 ? 0x3ddc84 : 0x7ee2a8);
      }
    } else {
      for (let i = 0; i < 30; i++) {
        const ang = Math.random() * Math.PI * 2, r = Math.random() * rad;
        this._spawnCeleb(DUST, cx + Math.cos(ang) * r, y + 0.5 + Math.random() * 0.6, cz + Math.sin(ang) * r,
          (Math.random() - 0.5) * 0.3, -0.1 - Math.random() * 0.2, (Math.random() - 0.5) * 0.3,
          -Math.random() * 0.5, 0.9 + Math.random() * 0.5, i % 2 ? 0x9aa0a6 : 0x6b7280);
      }
    }
  }

  // SIM2 win state: after $1B (state.won) the HQ settlement gets a cheap
  // ambient golden confetti burst every ~45s.
  _updateWin(dt, state) {
    if (!state.won || !state.hq) return;
    this._wonCd -= dt;
    if (this._wonCd > 0) return;
    this._wonCd = 45;
    const { world, groundH, ox, oz } = this.ctx;
    const s = world.settlements.find(o => o.id === state.hq);
    if (!s) return;
    const x = s.x + 0.5 + ox, z = s.y + 0.5 + oz;
    const y = groundH(s.x + 0.5, s.y + 0.5) + 0.3;
    for (let i = 0; i < 40; i++) {
      const ang = Math.random() * Math.PI * 2, sp = 0.25 + Math.random() * 0.7;
      this._spawnCeleb(CONF, x, y, z,
        Math.cos(ang) * sp, 1.8 + Math.random() * 1.2, Math.sin(ang) * sp,
        -Math.random() * 0.4, 1.0 + Math.random() * 0.5, i % 3 ? 0xffd24d : 0x3ddc84);
    }
  }

  _updateCelebrations(dt) {
    const attr = this.celebPoints.geometry.getAttribute('position');
    const cattr = this.celebPoints.geometry.getAttribute('color');
    for (let i = 0; i < CELEB_N; i++) {
      const p = this.cData[i];
      if (p.mode === DEAD) continue;
      p.age += dt;
      if (p.age < 0) { attr.setY(i, HIDDEN_Y); continue; }   // delayed stage / fuse
      if (p.age >= p.life) {
        if (p.mode === ROCKET) {
          // pop: burst of sparks at the rocket's apex
          const hex = CONFETTI[i % 4];
          for (let k = 0; k < 19; k++) {
            const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
            const sp = 1.2 + Math.random() * 1.6;
            this._spawnCeleb(SPARK, p.x, p.y, p.z,
              Math.sin(ph) * Math.cos(th) * sp, Math.cos(ph) * sp + 0.4, Math.sin(ph) * Math.sin(th) * sp,
              0, 0.55 + Math.random() * 0.35, hex);
          }
        }
        p.mode = DEAD;
        attr.setY(i, HIDDEN_Y);
        this.cFree.push(i);
        continue;
      }
      p.vy -= GRAV[p.mode] * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      attr.setXYZ(i, p.x, p.y, p.z);
      const fade = 1 - p.age / p.life;    // additive: fading color → invisible
      cattr.setXYZ(i, p.r * fade, p.g * fade, p.b * fade);
    }
    attr.needsUpdate = true;
    cattr.needsUpdate = true;

    for (const rg of this.rings) {
      if (rg.t < 0) continue;
      rg.t += dt;
      if (rg.t >= 0.9) { rg.t = -1; rg.mesh.visible = false; continue; }
      const f = rg.t / 0.9;
      const sc = 0.3 + f * 4.2;
      rg.mesh.scale.set(sc, 1, sc);
      rg.mesh.material.opacity = 0.65 * (1 - f);
    }
  }

  _updateMoney(dt, state) {
    this._moneyCd -= dt;
    // trigger on sim-day boundaries → cadence naturally scales with game speed
    // (~1/1.4s at speed 1), capped by the cooldown + 12-sprite pool.
    if (state.day !== this._lastDay) {
      const first = this._lastDay < 0;
      this._lastDay = state.day;
      const h = state.history;
      const row = h && h.length ? h[h.length - 1] : null;
      if (!first && row && row.revenue > 0 && this._moneyCd <= 0 && Math.random() < 0.8) {
        // pick a random store/office premises without allocating
        const prems = state.premises;
        let count = 0;
        for (let i = 0; i < prems.length; i++) {
          const k = prems[i].kind;
          if (k === 'store' || k === 'office') count++;
        }
        if (count > 0) {
          let pick = (Math.random() * count) | 0, sid = null;
          for (let i = 0; i < prems.length; i++) {
            const k = prems[i].kind;
            if (k !== 'store' && k !== 'office') continue;
            if (pick-- === 0) { sid = prems[i].sid; break; }
          }
          const sts = state.world.settlements;
          let s = null;
          for (let i = 0; i < sts.length; i++) if (sts[i].id === sid) { s = sts[i]; break; }
          if (s) {
            for (const fl of this.money) {
              if (fl.t >= 0) continue;
              const { groundH, ox, oz } = this.ctx;
              const px = s.x + 0.5 + (Math.random() - 0.5) * 1.4;
              const py = s.y + 0.5 + (Math.random() - 0.5) * 1.4;
              fl.t = 0;
              fl.spr.visible = true;
              fl.spr.position.set(px + ox, groundH(px, py) + 0.9, py + oz);
              this._moneyCd = 0.35;
              break;
            }
          }
        }
      }
    }
    for (const fl of this.money) {
      if (fl.t < 0) continue;
      fl.t += dt;
      if (fl.t >= 1.3) { fl.t = -1; fl.spr.visible = false; continue; }
      const f = fl.t / 1.3;
      fl.spr.position.y += 0.75 * dt;
      fl.spr.material.opacity = f < 0.12 ? f / 0.12 : 1 - (f - 0.12) / 0.88;
    }
  }

  update(dt, time, state, cal, camTarget, stormActive, stormCenter) {
    // ---- celebrations (pooled ring + fountain + rockets) ----
    this._updateCelebrations(dt);

    // ---- money floaters ----
    this._updateMoney(dt, state);

    // ---- ambient win-state confetti at HQ (state.won) ----
    this._updateWin(dt, state);

    // ---- state.fxAnims: advance + prune (renderer owns lifecycle) ----
    for (const fx of state.fxAnims) fx.t += dt;
    state.fxAnims = state.fxAnims.filter(fx => fx.t < 4);
    const live = new Set(state.fxAnims);
    for (const [fx, rec] of this.fxParticles) {
      if (!live.has(fx)) {
        this.group.remove(rec.points);
        rec.points.geometry.dispose();
        rec.points.material.dispose();
        this.fxParticles.delete(fx);
      }
    }
    for (const fx of state.fxAnims) {
      if (fx.kind !== 'confetti') continue;
      let rec = this.fxParticles.get(fx);
      if (!rec) {
        // 140 confetti squares raining over the camera's view
        const n = 140;
        const pos = new Float32Array(n * 3);
        const col = new Float32Array(n * 3);
        const data = [];
        const c = new THREE.Color();
        for (let i = 0; i < n; i++) {
          data.push({
            x: camTarget.x + (Math.random() - 0.5) * 22,
            y: 7 + Math.random() * 8,
            z: camTarget.z + (Math.random() - 0.5) * 16,
            v: 1.6 + Math.random() * 1.6,
            w: Math.random() * 6,
            drift: 0.6 + Math.random() * 0.8,
          });
          c.set(CONFETTI[i % 4]);
          col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        const points = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.18, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false }));
        points.frustumCulled = false;
        rec = { points, data };
        this.fxParticles.set(fx, rec);
        this.group.add(points);
      }
      const attr = rec.points.geometry.getAttribute('position');
      rec.data.forEach((p, i) => {
        const y = p.y - fx.t * p.v;
        attr.setXYZ(i, p.x + Math.sin(fx.t * 2 + p.w) * p.drift, y, p.z);
      });
      attr.needsUpdate = true;
      rec.points.material.opacity = fx.t > 3 ? (4 - fx.t) : 0.95;
    }

    // ---- precipitation ----
    const snowing = cal.season === 'winter';
    const raining = stormActive;
    this.precip.visible = snowing || raining;
    if (this.precip.visible) {
      const attr = this.precip.geometry.getAttribute('position');
      const span = 24, hgt = 12;
      const fall = raining && !snowing ? 14 : 2.2;
      this.precipMat.size = raining && !snowing ? 0.06 : 0.1;
      this.precipMat.color.set(raining && !snowing ? 0xa9c4d4 : 0xf4f7fa);
      this.precipMat.opacity = raining && !snowing ? 0.55 : 0.8;
      for (let i = 0; i < this.precipN; i++) {
        const sx = this.precipSeed[i * 2], sz = this.precipSeed[i * 2 + 1];
        let y = hgt - ((time * fall + sx * 97) % hgt);
        let x = camTarget.x + (sx - 0.5) * span;
        let z = camTarget.z + (sz - 0.5) * span * 0.8;
        if (snowing && !raining) x += Math.sin(time * 1.3 + sz * 20) * 0.7; // drifting flakes
        attr.setXYZ(i, x, y, z);
      }
      attr.needsUpdate = true;
    }

    // ---- storm cloud + lightning ----
    this.stormCloud.visible = !!(stormActive && stormCenter);
    let flash = 0;
    if (this.stormCloud.visible) {
      const { ox, oz } = this.ctx;
      this.stormCloud.position.x = stormCenter.x + ox + Math.sin(time * 0.4) * 0.8;
      this.stormCloud.position.z = stormCenter.y + oz + Math.cos(time * 0.3) * 0.8;
      this.stormCloud.children.forEach((m, i) => { m.position.y = (i % 2) * 0.5 + Math.sin(time * 0.8 + i) * 0.25; });
      if (Math.random() < 0.02) this.lightning = 1;
    }
    if (this.lightning > 0) {
      flash = this.lightning;
      this.lightning = Math.max(0, this.lightning - dt * 7);
    }
    return flash; // renderer adds it to exposure
  }
}
