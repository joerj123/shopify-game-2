// Shopify Tycoon 3D — boot, game loop, input, onboarding, persistence.
import { newGame, simulateDay, chooseHq, pushNews, fmtMoney, migrateSave } from './sim.js';
import { SEGMENTS } from './world.js';
import { WorldRenderer } from './gfx/renderer.js';
import { UI } from './ui.js';
import { Jukebox } from './audio.js';
import { ASSETS } from './data/assets-manifest.js';

const SAVE_KEY = 'shopify-tycoon-3d-save-v1';
const DAY_MS = { 1: 1400, 3: 550, 8: 180 };

class Game {
  constructor() {
    window.__game = this; // debug handle
    this.state = this.load() || newGame();
    this.speed = 1;
    this.paused = true;
    this.modalPause = false;
    this.jukebox = new Jukebox();
    this.canvas = document.getElementById('map');
    this.renderer = new WorldRenderer(this.canvas, this.state);
    this.ui = new UI(this);
    this.accum = 0;
    this.lastT = performance.now();
    this.ipoShown = this.state.goalsDone.includes('ipo');
    this.winShown = this.state.goalsDone.includes('billion');
    this.bindInput();
    this.renderer.resize();
    window.addEventListener('resize', () => this.renderer.resize());
    this.ui.renderTop();
    this.ui.renderPanel(true);
    this.ui.renderTicker();

    if (!this.state.hq) this.onboarding();
    else if (this.state.gameOver) this.ui.modalGameOver();
    else this.paused = false;

    requestAnimationFrame((t) => this.frame(t));
    setInterval(() => this.save(), 20000); // autosave
  }

  // ================= loop =================
  frame(t) {
    const dt = Math.min(0.1, (t - this.lastT) / 1000);
    this.lastT = t;

    if (!this.paused && !this.modalPause && this.state.hq && !this.state.gameOver) {
      this.accum += dt * 1000;
      const dayMs = DAY_MS[this.speed];
      let steps = 0;
      while (this.accum >= dayMs && steps < 4) {
        this.accum -= dayMs;
        steps++;
        const row = simulateDay(this.state);
        if (row && row.revenue > 0 && Math.random() < 0.25) this.jukebox.sfx('kaching');
        if (this.state.pendingGoal) {
          const g = this.state.pendingGoal;
          this.state.pendingGoal = null;
          this.ui.showGoal(g);
          if (g.id === 'ipo' && !this.ipoShown) { this.ipoShown = true; this.ui.modalIpo(); }
          if (g.id === 'billion' && !this.winShown) { this.winShown = true; this.ui.modalWin(); }
        }
        if (this.state.pendingQuest) {
          const q = this.state.pendingQuest;
          this.state.pendingQuest = null;
          this.ui.showQuest(q);
        }
        if (this.state.pendingEvent) {
          const ev = this.state.pendingEvent;
          this.state.pendingEvent = null;
          this.ui.showEvent(ev);
          this.jukebox.sfx('goal');
        }
        if (this.state.gameOver) { this.save(); this.ui.modalGameOver(); }
      }
      if (steps > 0) {
        this.ui.renderTop();
        this.ui.renderPanel();
        this.ui.renderTicker();
      }
    }

    this.renderer.draw(dt);
    requestAnimationFrame((t2) => this.frame(t2));
  }

  pauseForModal(on) { this.modalPause = on; }

  setSpeed(sp) {
    document.querySelectorAll('.btn.speed').forEach(b => b.classList.remove('active'));
    if (sp === 0) { this.paused = true; document.getElementById('speed-pause').classList.add('active'); }
    else {
      this.paused = false; this.speed = sp;
      document.getElementById(`speed-${sp}`).classList.add('active');
    }
  }

  // ================= input =================
  bindInput() {
    document.getElementById('speed-pause').addEventListener('click', () => this.setSpeed(0));
    document.getElementById('speed-1').addEventListener('click', () => this.setSpeed(1));
    document.getElementById('speed-3').addEventListener('click', () => this.setSpeed(3));
    document.getElementById('speed-8').addEventListener('click', () => this.setSpeed(8));
    document.getElementById('save-btn').addEventListener('click', () => { this.save(); this.ui.flashNote('Game saved'); });
    document.getElementById('new-btn').addEventListener('click', () => {
      const close = this.ui.modal(`
        <h2>Start a new game?</h2>
        <p class="small-note">A fresh island, a fresh company. Your current save will be deleted.</p>
        <div class="modal-btns">
          <button class="btn" id="ng-cancel">Cancel</button>
          <button class="btn green" id="ng-go">New game</button>
        </div>`);
      document.getElementById('ng-cancel').addEventListener('click', close);
      document.getElementById('ng-go').addEventListener('click', () => this.restart());
    });
    const setMode = (mode) => {
      this.renderer.mode = mode;
      document.getElementById('mode-terrain').classList.toggle('active', mode === 'terrain');
      document.getElementById('mode-business').classList.toggle('active', mode === 'business');
    };
    document.getElementById('mode-terrain').addEventListener('click', () => setMode('terrain'));
    document.getElementById('mode-business').addEventListener('click', () => setMode('business'));
    document.getElementById('music-btn').addEventListener('click', () => {
      const btn = document.getElementById('music-btn');
      if (!this.jukebox.enabled) {
        this.jukebox.start();
        btn.classList.add('active');
        this.ui.flashNote(`♪ ${this.jukebox.trackName}`);
        btn.dataset.on = '1';
      } else {
        const name = this.jukebox.nextTrack();
        this.ui.flashNote(`♪ ${name}`);
      }
    });
    document.getElementById('music-btn').addEventListener('dblclick', () => {
      this.jukebox.stop();
      document.getElementById('music-btn').classList.remove('active');
      this.ui.flashNote('♪ off');
    });

    window.addEventListener('keydown', (e) => {
      if (e.target && e.target.matches && e.target.matches('input,select,textarea')) return;
      if (e.code === 'Space') { e.preventDefault(); this.paused ? this.setSpeed(this.speed) : this.setSpeed(0); }
      if (e.key === '1') this.setSpeed(1);
      if (e.key === '2') this.setSpeed(3);
      if (e.key === '3') this.setSpeed(8);
    });

    // Camera pan/zoom/orbit lives inside the renderer (raycast-based picking).
    // Tooltip helpers: settlements get the classic card; hovered street life
    // (pedestrians / civilian cars) gets a market-intel card. Clicking a
    // pedestrian pins a slightly richer card for 4s.
    this.ttPinnedUntil = 0;
    const tooltipEl = () => document.getElementById('map-tooltip');
    const placeTooltip = (tooltip, clientX, clientY) => {
      const r = this.canvas.getBoundingClientRect();
      tooltip.classList.remove('hidden');
      tooltip.style.left = Math.min(r.width - 230, clientX - r.left + 14) + 'px';
      tooltip.style.top = (clientY - r.top + 10) + 'px';
    };
    const citizenHtml = (c, rich) => {
      if (c.kind === 'car') {
        return `<div class="tt-title">On the road</div>
          <div>${escapeHtml(c.info.label)}</div>`;
      }
      const seg = SEGMENTS[c.info.segment] || SEGMENTS.families;
      let html = `<div class="tt-title">${escapeHtml(c.info.name)}</div>
        <div><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${seg.color};margin-right:5px"></span>${escapeHtml(seg.name)} · ${escapeHtml(c.info.home)}</div>
        <div class="tt-dim">“${escapeHtml(c.info.wish)}”</div>`;
      if (rich) {
        html += `<div class="tt-dim">price sensitivity ${Math.round(seg.priceSens * 100)}% · ${seg.onlineBias >= 1 ? 'happy to shop online' : 'prefers local shops'}</div>
          <div class="tt-dim">a few of these wishes tell you what to stock here</div>`;
      }
      return html;
    };
    this.renderer.attachInput({
      onHover: (hit, clientX, clientY) => {
        const tooltip = tooltipEl();
        const s = hit && hit.settlement, c = hit && hit.citizen;
        if (!s && !c) {
          if (performance.now() < this.ttPinnedUntil) return;   // keep pinned citizen card
          tooltip.classList.add('hidden');
          return;
        }
        this.ttPinnedUntil = 0;
        placeTooltip(tooltip, clientX, clientY);
        if (s) {
          tooltip.innerHTML = `<div class="tt-title">${escapeHtml(s.name)}</div>
            <div>${s.pop.toLocaleString()} people · ${s.type}</div>
            <div class="tt-dim">awareness ${Math.round(s.awareness * 100)}% · ${s.customers.toLocaleString()} customers</div>
            <div class="tt-dim">${s.researched ? 'surveyed ✓' : 'not surveyed'} — click to inspect</div>`;
        } else {
          tooltip.innerHTML = citizenHtml(c, false);
        }
      },
      onCitizenClick: (c, clientX, clientY) => {
        this.jukebox.sfx('click');
        const tooltip = tooltipEl();
        placeTooltip(tooltip, clientX, clientY);
        tooltip.innerHTML = citizenHtml(c, c.kind === 'ped');
        this.ttPinnedUntil = performance.now() + 4000;
        clearTimeout(this._ttPinTimer);
        this._ttPinTimer = setTimeout(() => {
          if (performance.now() >= this.ttPinnedUntil) tooltip.classList.add('hidden');
        }, 4100);
      },
      onSettlementClick: (settlement) => {
        this.jukebox.sfx('click');
        if (this.renderer.pickMode) {
          this.renderer.pickMode = false;
          document.getElementById('map-hint').classList.add('hidden');
          this.canvas.classList.remove('placing');
          chooseHq(this.state, settlement.id);
          this.afterHqPicked(settlement);
        } else if (this.state.hq) {
          this.ui.modalSettlement(settlement);
        }
      },
    });
  }

  // ================= onboarding =================
  onboarding() {
    this.paused = true;
    const NAMES = ['Acme Goods', 'Cardboard & Co', 'Maple Supply', 'Sundry Club', 'Parcel Palace', 'Nice Things Inc', 'The Goods Dept', 'Otter Outfitters', 'Big Little Shop', 'Crate Expectations'];
    const close = this.ui.modal(`
      <div class="splash">
        <div class="splash-hero" style="background-image:url('${ASSETS.titleHero}')"></div>
        <div class="splash-body">
          <div class="splash-title">Shopify<br>Tycoon</div>
          <p class="splash-sub">One garage. One island. 500,000 shoppers who've never heard of you.</p>
          <h3>Name your company</h3>
          <div style="display:flex;gap:8px">
            <input type="text" id="company-name" maxlength="20" value="Acme Goods" autocomplete="off">
            <button class="btn" id="name-dice" title="Random name">Random</button>
          </div>
          <h3>The shape of the game</h3>
          <p class="small-note">
            Pick products shoppers in each town actually want — then out-price, out-ship and
            out-brand <b>BumbleBuy</b> and <b>Verdant &amp; Co</b>, who are already everywhere.<br><br>
            Survive the January slump. Feast at BFCM. Ring the IPO bell at $1M —
            then franchise, export and out-muscle <b>Primely</b> all the way to <b>$1B</b>.<br>
            Sink to −$50k in debt and the bank takes the keys.
          </p>
          <div class="modal-btns"><button class="btn green" id="ob-go">Choose headquarters →</button></div>
        </div>
      </div>
    `, { noClose: true, splash: true });
    const nameInput = document.getElementById('company-name');
    nameInput.focus(); nameInput.select();
    document.getElementById('name-dice').addEventListener('click', () => {
      nameInput.value = NAMES[Math.floor(Math.random() * NAMES.length)];
      this.jukebox.sfx('click');
    });
    document.getElementById('ob-go').addEventListener('click', () => {
      this.state.companyName = (nameInput.value.trim() || 'Acme Goods').slice(0, 20);
      close();
      this.renderer.pickMode = true;
      this.canvas.classList.add('placing');
      const hint = document.getElementById('map-hint');
      hint.classList.remove('hidden');
      hint.innerHTML = 'Click a settlement to place your HQ<br><span class="dim">cities: rich shoppers, brutal rent &amp; rivals · villages: cheap &amp; sleepy · towns: the smart start</span>';
    });
  }

  afterHqPicked(settlement) {
    this.ui.renderTop();
    this.ui.renderPanel(true);
    this.jukebox.sfx('goal');
    this.renderer.focus(settlement.x, settlement.y);
    this.renderer.celebrate(settlement.id);
    const close = this.ui.modal(`
      <h2>Welcome to ${escapeHtml(settlement.name)}</h2>
      <p>Your garage office is open. You have <b class="amber">${fmtMoney(this.state.cash)}</b> and a big idea.</p>
      <p class="small-note">Your <b class="green">first steps</b> checklist is on the dashboard —
      each step pays a small bonus. Start with the Products tab.</p>
      <div class="modal-btns"><button class="btn green" id="welcome-go">Let's go</button></div>
    `, { noClose: true });
    document.getElementById('welcome-go').addEventListener('click', () => {
      close();
      this.setSpeed(1);
      pushNews(this.state, 'Day one. The garage smells like cardboard and ambition.');
    });
  }

  // ================= persistence =================
  save() {
    if (!this.state.hq) return;
    try {
      const s = { ...this.state, shipAnims: [], boatAnims: [], fxAnims: [], pendingGoal: null, pendingQuest: null, pendingEvent: null };
      s.world = { ...this.state.world, tiles: Array.from(this.state.world.tiles), elev: Array.from(this.state.world.elev) };
      localStorage.setItem(SAVE_KEY, JSON.stringify(s));
    } catch (e) { console.warn('save failed', e); }
  }
  load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (s.v !== 3 && s.v !== 4) return null;
      s.world.tiles = Uint8Array.from(s.world.tiles);
      s.world.elev = Float32Array.from(s.world.elev);
      s.shipAnims = []; s.boatAnims = []; s.fxAnims = [];
      migrateSave(s);   // upgrades v3 in place; no-op for v4
      return s;
    } catch (e) { console.warn('load failed', e); return null; }
  }
  restart() {
    localStorage.removeItem(SAVE_KEY);
    location.reload();
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

new Game();
