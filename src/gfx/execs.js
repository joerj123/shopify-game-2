// Executive board-game pawns (SIM2 §3). Stationed execs (state.execs with a
// sid) stand at a deterministic per-role offset beside their settlement with a
// soft idle bob and a brand-green glow ring. Travelling execs follow their
// state.execTravels path like survey walkers (faster bob, briefcase in hand).
// OWNERSHIP: state.execTravels is SIM-OWNED — sim.js ticks daysLeft daily and
// prunes arrivals itself (unlike shipAnims/boatAnims). We only read it.
import * as THREE from 'three';

const ROLES = ['ceo', 'cmo', 'coo', 'research', 'retail'];
const ROLE_COLOR = { ceo: 0xffd24d, cmo: 0xe06fae, coo: 0x8d94a3, research: 0x5ac8e0, retail: 0xd07a3a };
const ROLE_TEXT = { ceo: 'CEO', cmo: 'CMO', coo: 'COO', research: 'R&D', retail: 'RET' };

// linear interpolation along a tile path (+0.5 centering) — same semantics as
// the survey-walker sampler in vehicles.js
function samplePath(path, f, out) {
  const n = path.length;
  if (n === 0) { out.x = 0; out.y = 0; out.hx = 1; out.hy = 0; return out; }
  if (n === 1) { out.x = path[0].x + 0.5; out.y = path[0].y + 0.5; out.hx = 1; out.hy = 0; return out; }
  const t = Math.min(0.999, Math.max(0, f)) * (n - 1);
  const i = Math.floor(t), r = t - i;
  const a = path[i], b = path[Math.min(n - 1, i + 1)];
  out.x = a.x + (b.x - a.x) * r + 0.5;
  out.y = a.y + (b.y - a.y) * r + 0.5;
  const j = Math.min(n - 1, i + 1);
  const la = path[Math.max(0, j - 1)], lb = path[j];
  out.hx = lb.x - la.x; out.hy = lb.y - la.y;
  if (out.hx === 0 && out.hy === 0) { out.hx = 1; out.hy = 0; }
  return out;
}

// floating role badge: dark round token with a short role abbreviation
function iconTexture(role) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const c2 = cv.getContext('2d');
  c2.fillStyle = 'rgba(12,16,24,.82)';
  c2.beginPath(); c2.arc(32, 32, 26, 0, Math.PI * 2); c2.fill();
  c2.strokeStyle = 'rgba(255,255,255,.25)';
  c2.lineWidth = 3; c2.stroke();
  c2.textAlign = 'center'; c2.textBaseline = 'middle';
  c2.fillStyle = '#' + new THREE.Color(ROLE_COLOR[role]).getHexString();
  c2.font = 'bold 20px system-ui, sans-serif';
  c2.fillText(ROLE_TEXT[role], 32, 33);
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 2;
  return tex;
}

export function buildExecs(ctx) {
  const { world, groundH, heightAt, ox, oz } = ctx;
  const group = new THREE.Group();
  group.name = 'execs';

  // shared geometry/materials for every pawn (max 5 pawns ever)
  const baseGeo = new THREE.CylinderGeometry(0.1, 0.115, 0.045, 10);
  const bodyGeo = new THREE.CylinderGeometry(0.038, 0.082, 0.27, 10);
  const collarGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.028, 10);
  const headGeo = new THREE.SphereGeometry(0.058, 8, 6);
  const caseGeo = new THREE.BoxGeometry(0.07, 0.055, 0.024);
  const ringGeo = new THREE.RingGeometry(0.14, 0.2, 24);
  ringGeo.rotateX(-Math.PI / 2);
  const collarMat = new THREE.MeshStandardMaterial({ color: 0xf4f1e8, flatShading: true, roughness: 0.6 });
  const caseMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, flatShading: true, roughness: 0.8 });
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x3ddc84, transparent: true, opacity: 0.35,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const roleMats = {}, icons = {};
  const roleMat = (role) => roleMats[role] ||
    (roleMats[role] = new THREE.MeshStandardMaterial({ color: ROLE_COLOR[role] || 0xffffff, flatShading: true, roughness: 0.55 }));
  const iconTex = (role) => icons[role] || (icons[role] = iconTexture(role));

  function makePawn(role) {
    const g = new THREE.Group();
    const mat = roleMat(role);
    const base = new THREE.Mesh(baseGeo, mat);
    base.position.y = 0.022;
    base.castShadow = true;
    g.add(base);
    const body = new THREE.Mesh(bodyGeo, mat);
    body.position.y = 0.18;
    body.castShadow = true;
    g.add(body);
    const collar = new THREE.Mesh(collarGeo, collarMat);   // tiny white collar band
    collar.position.y = 0.325;
    g.add(collar);
    const head = new THREE.Mesh(headGeo, mat);
    head.position.y = 0.402;
    head.castShadow = true;
    g.add(head);
    const icon = new THREE.Sprite(new THREE.SpriteMaterial({ map: iconTex(role), transparent: true, depthWrite: false }));
    icon.scale.set(0.21, 0.21, 1);
    icon.position.y = 0.66;
    g.add(icon);
    const ring = new THREE.Mesh(ringGeo, ringMat);         // glow ring in brand green
    ring.position.y = 0.02;
    ring.renderOrder = 6;
    g.add(ring);
    const briefcase = new THREE.Mesh(caseGeo, caseMat);    // shown while travelling
    briefcase.position.set(0.02, 0.16, 0.085);
    briefcase.visible = false;
    g.add(briefcase);
    const idx = Math.max(0, ROLES.indexOf(role));
    return { g, icon, ring, briefcase, ph: idx * 1.7, idx, sid: null, stype: null, sRef: null, tx: 0, ty: 0, gy: 0 };
  }

  // deterministic per-role station spot beside the settlement (slides toward
  // the centre if the offset lands in the sea on coastal settlements)
  function stationSpot(s, idx, rec) {
    const rad = s.type === 'city' ? 2.2 : s.type === 'town' ? 1.6 : 1.1;
    const ang = idx * (Math.PI * 2 / 5) + 0.7;
    let tx = s.x + 0.5 + Math.cos(ang) * rad, ty = s.y + 0.5 + Math.sin(ang) * rad;
    for (let t = 1; t <= 10 && heightAt(tx, ty) < 0.15; t++) {
      const f = 1 - t / 10;
      tx = s.x + 0.5 + Math.cos(ang) * rad * f;
      ty = s.y + 0.5 + Math.sin(ang) * rad * f;
    }
    rec.tx = tx; rec.ty = ty; rec.gy = groundH(tx, ty);
    rec.sid = s.id; rec.stype = s.type;
  }

  const pawns = new Map();                       // execId → pawn record
  const sPos = { x: 0, y: 0, hx: 1, hy: 0 };     // shared path sample (no per-frame allocs)

  return {
    group,
    update(dt, time, state) {
      const execs = state.execs || [];
      const travels = state.execTravels || [];

      // drop pawns for fired execs
      if (pawns.size) {
        for (const [id, rec] of pawns) {
          let found = false;
          for (let i = 0; i < execs.length; i++) if (execs[i].id === id) { found = true; break; }
          if (!found) { group.remove(rec.g); pawns.delete(id); }
        }
      }

      for (let i = 0; i < execs.length; i++) {
        const ex = execs[i];
        let rec = pawns.get(ex.id);
        if (!rec) { rec = makePawn(ex.role); pawns.set(ex.id, rec); group.add(rec.g); }

        let tr = null;
        for (let j = 0; j < travels.length; j++) if (travels[j].execId === ex.id) { tr = travels[j]; break; }

        if (tr) {
          // on the road: walk the sim path, brisker bob, briefcase out
          const f = Math.min(1, 1 - tr.daysLeft / tr.totalDays);
          const p = samplePath(tr.path, f, sPos);
          const bob = Math.abs(Math.sin(time * 8 + rec.ph)) * 0.045;
          rec.g.visible = true;
          rec.g.position.set(p.x + ox, groundH(p.x, p.y) + bob, p.y + oz);
          rec.g.rotation.y = Math.atan2(-p.hy, p.hx);
          rec.briefcase.visible = true;
          rec.ring.visible = false;
          rec.sid = null;                       // re-derive station spot on arrival
        } else if (ex.sid) {
          // stationed: deterministic spot beside the settlement, soft idle bob.
          // Re-derive when the exec moves OR the settlement changes tier
          // (living towns: stance radius follows s.type).
          if (rec.sid !== ex.sid) {
            rec.sRef = world.settlements.find(o => o.id === ex.sid) || null;
            if (rec.sRef) stationSpot(rec.sRef, rec.idx, rec);
          } else if (rec.sRef && rec.sRef.type !== rec.stype) {
            stationSpot(rec.sRef, rec.idx, rec);
          }
          const bob = 0.018 + Math.sin(time * 2.2 + rec.ph) * 0.018;
          rec.g.visible = true;
          rec.g.position.set(rec.tx + ox, rec.gy + bob, rec.ty + oz);
          rec.g.rotation.y = rec.ph;            // stable, per-role facing
          rec.briefcase.visible = false;
          rec.ring.visible = true;
          rec.ring.position.y = 0.02 - bob;     // glow ring stays glued to the ground
        } else {
          // in transit but travel record not visible yet (transient) — hide
          rec.g.visible = false;
        }
      }

      ringMat.opacity = 0.28 + 0.16 * Math.sin(time * 2.6);
    },
  };
}
