// In-scene settlement labels (canvas-texture sprites), business-mode overlay
// (awareness domes, penetration rings, competition pips, SIM2 price-war rings
// + crossed-swords badges) and pick/hover rings.
import * as THREE from 'three';

// crossed-swords badge for active price wars (two crossed strokes)
function swordsTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const c2 = cv.getContext('2d');
  c2.fillStyle = 'rgba(40,10,10,.85)';
  c2.beginPath(); c2.arc(32, 32, 28, 0, Math.PI * 2); c2.fill();
  c2.strokeStyle = 'rgba(255,110,94,.9)';
  c2.lineWidth = 3; c2.stroke();
  c2.strokeStyle = '#ffb0a6';
  c2.lineWidth = 6;
  c2.lineCap = 'round';
  c2.beginPath();
  c2.moveTo(21, 21); c2.lineTo(43, 43);
  c2.moveTo(43, 21); c2.lineTo(21, 43);
  c2.stroke();
  return new THREE.CanvasTexture(cv);
}

function labelTexture(name, lit) {
  const pad = 18, fs = 34;
  const cv = document.createElement('canvas');
  const c2 = cv.getContext('2d');
  c2.font = `600 ${fs}px Outfit, Sora, "Avenir Next", system-ui, sans-serif`;
  const tw = Math.ceil(c2.measureText(name.toUpperCase()).width);
  cv.width = tw + pad * 2;
  cv.height = fs + pad * 1.4;
  const g = cv.getContext('2d');
  const r = cv.height / 2;
  g.fillStyle = 'rgba(12,16,24,.78)';
  g.beginPath();
  g.roundRect(0, 0, cv.width, cv.height, r);
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,.14)';
  g.lineWidth = 2;
  g.stroke();
  g.font = `600 ${fs}px Outfit, Sora, "Avenir Next", system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = lit ? '#a9e07b' : '#f2f0ea';
  g.fillText(name.toUpperCase(), cv.width / 2, cv.height / 2 + 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 2;
  return { tex, aspect: cv.width / cv.height };
}

export class Overlay {
  constructor(ctx) {
    this.ctx = ctx;
    this.group = new THREE.Group();
    this.group.name = 'overlay';
    this.items = new Map(); // sid → {label, lit, dome, ring, pip, pickRing, hoverable}
    const { world, groundH, ox, oz } = ctx;

    const domeGeo = new THREE.SphereGeometry(1, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    const domeMat = new THREE.MeshBasicMaterial({ color: 0x3ddc84, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide });
    const ringGeo = new THREE.RingGeometry(0.82, 1, 40);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x5ac8e0, transparent: true, opacity: 0.9, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
    const pickGeo = new THREE.RingGeometry(0.86, 1, 36);
    const pipGeo = new THREE.OctahedronGeometry(0.14);

    // price-war visuals: one shared pulsing material + swords sprite material
    const warGeo = new THREE.RingGeometry(0.78, 0.95, 40);
    this.warMat = new THREE.MeshBasicMaterial({ color: 0xff5c4d, transparent: true, opacity: 0.5, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
    this.swordMat = new THREE.SpriteMaterial({ map: swordsTexture(), transparent: true, depthWrite: false });

    for (const s of world.settlements) {
      const y = groundH(s.x + 0.5, s.y + 0.5);
      const base = new THREE.Group();
      base.position.set(s.x + 0.5 + ox, y, s.y + 0.5 + oz);

      const { tex, aspect } = labelTexture(s.name, false);
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
      const lh = 0.44;
      label.scale.set(lh * aspect, lh, 1);
      label.position.y = s.type === 'city' ? 2.6 : 1.7;
      label.renderOrder = 10;
      base.add(label);

      const dome = new THREE.Mesh(domeGeo, domeMat.clone());
      dome.renderOrder = 5;
      base.add(dome);

      const ring = new THREE.Mesh(ringGeo, ringMat.clone());
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.14;
      ring.renderOrder = 8;
      base.add(ring);

      const pip = new THREE.Mesh(pipGeo, new THREE.MeshBasicMaterial({ color: 0x8d8fa8 }));
      pip.position.set(0.9, 1.1, 0);
      base.add(pip);

      const pickRing = new THREE.Mesh(pickGeo, new THREE.MeshBasicMaterial({ color: 0x3ddc84, transparent: true, opacity: 0.9, depthWrite: false, depthTest: false, side: THREE.DoubleSide }));
      pickRing.rotation.x = -Math.PI / 2;
      pickRing.position.y = 0.14;
      pickRing.renderOrder = 9;
      base.add(pickRing);

      // price-war ring (slow red pulse) + crossed-swords badge
      const warRing = new THREE.Mesh(warGeo, this.warMat);
      warRing.rotation.x = -Math.PI / 2;
      warRing.position.y = 0.1;
      warRing.renderOrder = 8;
      warRing.visible = false;
      base.add(warRing);

      const swords = new THREE.Sprite(this.swordMat);
      swords.scale.set(0.5, 0.5, 1);
      swords.position.set(-0.9, 1.1, 0);
      swords.renderOrder = 10;
      swords.visible = false;
      base.add(swords);

      this.group.add(base);
      this.items.set(s.id, { s, base, label, lit: false, dome, ring, pip, pickRing, warRing, swords });
    }

    // hover ring (single, amber)
    this.hoverRing = new THREE.Mesh(new THREE.RingGeometry(0.88, 1, 40), new THREE.MeshBasicMaterial({ color: 0xffb84d, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
    this.hoverRing.rotation.x = -Math.PI / 2;
    this.hoverRing.visible = false;
    this.hoverRing.renderOrder = 7;
    this.group.add(this.hoverRing);
  }

  update(time, state, mode, pickMode, hover, zoom) {
    const labelFade = THREE.MathUtils.clamp((zoom - 0.75) / 0.5, 0, 1);
    const business = mode === 'business';
    this.warMat.opacity = 0.35 + 0.22 * Math.sin(time * 1.7);   // shared slow red pulse
    for (const it of this.items.values()) {
      const s = it.s;
      // label: regenerate tint when customers appear
      const lit = s.customers > 0;
      if (lit !== it.lit) {
        it.lit = lit;
        const { tex, aspect } = labelTexture(s.name, lit);
        it.label.material.map.dispose();
        it.label.material.map = tex;
        const lh = 0.44;
        it.label.scale.set(lh * aspect, lh, 1);
      }
      it.label.material.opacity = labelFade;
      it.label.visible = labelFade > 0.02;
      it.label.position.y = s.type === 'city' ? 2.6 : 1.7;   // living towns: tier can change

      // business overlay
      const clickR = s.type === 'city' ? 2.6 : s.type === 'town' ? 1.9 : 1.4;
      if (business) {
        const aw = s.awareness || 0;
        it.dome.visible = aw > 0.01;
        const dr = 0.8 + aw * clickR * 1.6;
        it.dome.scale.set(dr, dr * 0.55, dr);
        it.dome.material.opacity = 0.2 + aw * 0.3;

        const pen = Math.min(1, s.customers / (s.pop * 0.15));
        it.ring.visible = pen > 0.005;
        const rr = 0.7 + pen * clickR * 1.6;
        it.ring.scale.set(rr, rr, 1);

        // competition pip on the SIM2 pressure scale (state.competition):
        // amber > 1.5, red > 3 or active price war; falls back to the
        // aggregate rivalPresence map on older states
        const comp = state.competition && state.competition[s.id];
        const pressure = comp ? comp.pressure : ((state.rivalPresence && state.rivalPresence[s.id]) || 0);
        const war = comp ? comp.priceWar
          : !!(state.priceWars && state.priceWars.length && state.priceWars.some(w => w.sid === s.id));
        const hot = war || pressure > 3;
        it.pip.visible = pressure > 0.05;
        if (it.pip.visible) {
          it.pip.material.color.set(hot ? 0xff6b5e : pressure > 1.5 ? 0xffb84d : 0x8d8fa8);
          it.pip.position.y = 1.35 + Math.sin(time * 2.4 + s.x) * 0.1;
          const ps = hot ? 2.0 : pressure > 1.5 ? 1.5 : 1.1;
          it.pip.scale.set(ps, ps, ps);
          it.pip.rotation.y = time * 1.2;
        }

        // price war: slow-pulsing red ring + crossed swords
        it.warRing.visible = war;
        it.swords.visible = war;
        if (war) {
          const wr = clickR * (0.92 + 0.07 * Math.sin(time * 1.7 + s.y));
          it.warRing.scale.set(wr, wr, 1);
          it.swords.position.y = 1.15 + Math.sin(time * 1.7 + s.y) * 0.06;
        }
      } else {
        it.dome.visible = it.ring.visible = it.pip.visible = false;
        it.warRing.visible = it.swords.visible = false;
      }

      // pick-mode pulsing rings on every settlement
      it.pickRing.visible = !!pickMode;
      if (pickMode) {
        const pr = clickR * (0.85 + 0.1 * Math.sin(time * 5));
        it.pickRing.scale.set(pr, pr, 1);
        it.pickRing.material.opacity = 0.6 + 0.3 * Math.sin(time * 5);
      }
    }

    // hover ring
    const hs = !pickMode && hover && hover.settlement;
    this.hoverRing.visible = !!hs;
    if (hs) {
      const it = this.items.get(hs.id);
      if (it) {
        this.hoverRing.position.copy(it.base.position);
        this.hoverRing.position.y += 0.07;
        const r = (hs.type === 'city' ? 2.6 : hs.type === 'town' ? 1.9 : 1.4) * 0.75;
        this.hoverRing.scale.set(r, r, 1);
      }
    }
  }
}
