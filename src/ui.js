// UI layer: sidebar panels, modals, product cards, charts, toasts, ticker.
// Faithful port of the original game's UI with a redesigned presentation
// (dark warm glass, generated product art, SVG sparklines).
import {
  calInfo, metrics, fmtMoney, MONTHS, GOALS, DAYS_PER_MONTH,
  catalogAvailable, addCatalogProduct, startRnd, orderStock, RND_TIERS,
  launchOnlineStore, openStore, upgradeStore, buildWarehouse, upgradeOffice,
  hire, fire, researchSettlement, staffCap, staffCount,
  CHANNELS, STAFF_INFO, OFFICE_LEVELS, STORE_LEVELS, PREMISE_COSTS, fitScore,
  brandFocus, startFlashSale, QUESTS, WAGES, checkQuests,
  toggleListing, listingCap, premiseActive, RIVALS,
  costScale, orderWholesale, storeLogisticsCap, toggleStoreReplenish,
  EXEC_ROLES, hireExec, fireExec, assignExec,
  NATIONAL_CAMPAIGN, AUTOMATION_TIERS, BRAND_TIERS, EXPORT_LEVELS, ACQUISITION_COST,
  PRIMELY_ENTRY_REVENUE, setFranchising, startNationalCampaign, buyAutomation,
  buyBrandTier, upgradeExport, acquireRivalOps,
  deleteProduct, setAutoPrice, segmentFit, advisorTips, ADVISOR_INFO, DROPSHIP_MARKUP,
} from './sim.js';
import { CATEGORIES } from './data/catalog.js';
import { SEGMENTS } from './world.js';
import { productImage, eventImage, rivalImage, ART } from './sprites.js';

export class UI {
  constructor(game) {
    this.game = game;             // {state, jukebox, renderer, restart(), pauseForModal()}
    this.tab = 'dashboard';
    this.dragging = false;
    this.panel = document.getElementById('panel');
    this.lastRender = 0;
    // juice state — all guarded so the 900ms rerender loop never restarts animations
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this._lastTab = null;              // detects real tab switches vs periodic rerenders
    this._sparkDrawn = new Set();      // sparkline draw-in runs once per tab open
    this._tileCache = new Map();       // stat-tile values; pulse only on change
    this._cashShown = undefined;       // currently displayed (tweened) cash value
    this._cashTarget = undefined;
    this._hintsChecked = false;
    this._tickerQueue = [];            // headlines waiting for their 3s slot
    this._tickerSeen = null;           // last state.news item already enqueued
    this._tickerBusy = false;
    document.getElementById('ticker-inner')?.classList.add('show');
    document.addEventListener('pointerdown', (e) => { if (e.target.matches('input[type=range]')) this.dragging = true; });
    document.addEventListener('pointerup', () => { this.dragging = false; });

    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.tab = btn.dataset.tab;
        this.game.jukebox.sfx('click');
        this.renderPanel(true);
      });
    });
  }

  get s() { return this.game.state; }

  // ================= top bar =================
  renderTop() {
    const s = this.s;
    const cal = calInfo(s);
    this._setCash(s.cash);
    if (s.hq) this._maybeShowKeyHints();
    const h7 = s.history.slice(-7);
    const netEl = document.getElementById('net-val');
    if (h7.length) {
      const net = h7.reduce((a, r) => a + r.profit, 0) / h7.length;
      netEl.innerHTML = `<span class="${net >= 0 ? 'up' : 'down'}">${net >= 0 ? '▲' : '▼'} ${fmtMoney(Math.abs(net))}/d</span>`;
    } else netEl.textContent = '—';
    document.getElementById('date-val').textContent = `${MONTHS[cal.month - 1]} ${cal.dom}, Y${cal.year}`;
    const ev = s.activeEvents.filter(e => e.name).map(e => e.name).join(' · ');
    document.getElementById('weather-val').textContent = ev || '';
    document.getElementById('stat-weather').style.display = ev ? '' : 'none';
  }

  // rAF tween the cash readout (~400ms ease-out) + direction glow on the pill.
  // Only kicks off when the target actually changes, so periodic renderTop
  // calls with the same value are free.
  _setCash(target) {
    const cashEl = document.getElementById('cash-val');
    cashEl.classList.toggle('negative', target < 0);
    if (this._cashShown === undefined || this.reduced) {
      this._cashShown = this._cashTarget = target;
      cashEl.textContent = fmtMoney(target).replace('$', '');
      return;
    }
    if (target === this._cashTarget) return;
    const from = this._cashShown;
    this._cashTarget = target;
    const stat = document.getElementById('stat-cash');
    stat.classList.remove('cash-up', 'cash-down');
    void stat.offsetWidth; // restart the glow animation
    stat.classList.add(target > from ? 'cash-up' : 'cash-down');
    cancelAnimationFrame(this._cashRaf);
    const t0 = performance.now(), dur = 400;
    const tick = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3); // ease-out cubic
      this._cashShown = from + (target - from) * e;
      cashEl.textContent = fmtMoney(this._cashShown).replace('$', '');
      if (k < 1) this._cashRaf = requestAnimationFrame(tick);
    };
    this._cashRaf = requestAnimationFrame(tick);
  }

  // keyboard hint chips: bottom-left, once ever (localStorage flag), 6s
  _maybeShowKeyHints() {
    if (this._hintsChecked) return;
    this._hintsChecked = true;
    const KEY = 'shopify-tycoon-keyhints-v1';
    try { if (localStorage.getItem(KEY)) return; localStorage.setItem(KEY, '1'); } catch (e) { return; }
    const el = document.getElementById('key-hints');
    if (!el) return;
    el.classList.remove('hidden');
    setTimeout(() => {
      el.classList.add('bye');
      setTimeout(() => el.classList.add('hidden'), 600);
    }, 6000);
  }

  // News ticker v2: one headline at a time, cross-faded on a fixed cadence.
  // No marquee — at 8× speed the old scroll restarted on every new item and
  // flickered. New items queue up; the queue drops old ones under pressure so
  // the display never lags far behind the sim.
  renderTicker() {
    const items = this.s.news;
    if (!items.length) return;
    const last = items[items.length - 1];
    if (last === this._tickerSeen) return;
    // enqueue everything we haven't shown yet (bounded)
    const seenIdx = this._tickerSeen != null ? items.lastIndexOf(this._tickerSeen) : -1;
    for (const it of items.slice(seenIdx + 1)) this._tickerQueue.push(it);
    if (this._tickerQueue.length > 3) this._tickerQueue.splice(0, this._tickerQueue.length - 3);
    this._tickerSeen = last;
    if (!this._tickerBusy) this._drainTicker();
  }

  _drainTicker() {
    const next = this._tickerQueue.shift();
    if (next == null) { this._tickerBusy = false; return; }
    this._tickerBusy = true;
    const el = document.getElementById('ticker-inner');
    el.classList.remove('show');
    setTimeout(() => {
      el.innerHTML = next; // news is sim-authored html (product names pre-escaped)
      el.classList.add('show');
    }, this.reduced ? 0 : 220);
    clearTimeout(this._tickerT);
    this._tickerT = setTimeout(() => this._drainTicker(), 3200);
  }

  // ================= panel dispatcher =================
  renderPanel(force = false) {
    if (this.dragging && !force) return;
    // don't rerender under an open <select> (exec assignment dropdowns)
    const ae = document.activeElement;
    if (!force && ae && ae.tagName === 'SELECT' && this.panel.contains(ae)) return;
    const now = performance.now();
    if (!force && now - this.lastRender < 900) return;
    this.lastRender = now;
    const tabChanged = this._lastTab !== this.tab;
    this._lastTab = this.tab;
    if (tabChanged) this._sparkDrawn.delete(this.tab); // re-arm draw-in for this open
    const fn = {
      dashboard: () => this.renderDashboard(),
      products: () => this.renderProducts(),
      stores: () => this.renderStores(),
      staff: () => this.renderStaff(),
      marketing: () => this.renderMarketing(),
      research: () => this.renderResearch(),
      advisors: () => this.renderAdvisors(),
      goals: () => this.renderGoals(),
      empire: () => this.renderEmpire(),
    }[this.tab];
    // preserve scroll across re-renders
    const sc = this.panel.scrollTop;
    fn();
    this.panel.scrollTop = sc;
    // any [data-goto=tab] button jumps to that tab
    this.panel.querySelectorAll('[data-goto]').forEach(b =>
      b.addEventListener('click', () => document.querySelector(`[data-tab=${b.dataset.goto}]`)?.click()));
    this._afterRender(tabChanged);
  }

  // post-render juice. Every effect here is guarded (dataset-style flags on the
  // instance) so the periodic 900ms rerender never restarts an animation:
  // sparklines draw in once per tab open, tiles pulse only on value change,
  // and the panel slide plays only on a real tab switch.
  _afterRender(tabChanged) {
    if (this.reduced) return;
    if (!this._sparkDrawn.has(this.tab)) {
      this._sparkDrawn.add(this.tab);
      this.panel.querySelectorAll('svg.spark').forEach(el => el.classList.add('draw'));
    }
    this.panel.querySelectorAll('.tile').forEach(t => {
      const label = t.querySelector('.t-label'), val = t.querySelector('.t-value');
      if (!label || !val) return;
      const key = this.tab + '|' + label.textContent;
      const prev = this._tileCache.get(key);
      if (prev !== undefined && prev !== val.textContent && !tabChanged) val.classList.add('bump');
      this._tileCache.set(key, val.textContent);
    });
    if (tabChanged) {
      this.panel.classList.remove('panel-in');
      void this.panel.offsetWidth;
      this.panel.classList.add('panel-in');
    }
  }

  // ================= DASHBOARD =================
  renderDashboard() {
    const s = this.s, m = metrics(s);
    const last = s.history[s.history.length - 1];
    const rev7 = m.rev7, revPrev = s.history.slice(-14, -7).reduce((a, r) => a + r.revenue, 0);
    const delta = revPrev > 0 ? ((rev7 - revPrev) / revPrev * 100) : 0;
    const ratio = m.cac != null && m.cac > 0 ? m.ltv / m.cac : null;
    const missed7 = s.history.slice(-7).reduce((a, r) => a + (r.missedStock || 0), 0);
    // stockouts: own products always need central stock; catalog products only
    // need it for store shelves (online catalog sales dropship, never out)
    const hasStores = s.premises.some(p => p.kind === 'store' && premiseActive(p) && !p.franchise);
    const stockouts = s.products.filter(p => p.listed && (p.inventory || 0) <= 0 && (p.source === 'own' || hasStores));
    const scale = costScale(s);

    // active price wars — margin compression the player must see
    const warHtml = s.priceWars.length ? `<div class="alert-banner war"><b>Price war${s.priceWars.length > 1 ? 's' : ''}:</b> ${s.priceWars.map(w => {
      const st2 = s.world.settlements.find(x => x.id === w.sid);
      const rv = RIVALS.find(r => r.id === w.rival);
      return `${rivalEmblem(w.rival)}<b>${esc(rv ? rv.name : w.rival)}</b> is dumping prices in ${esc(st2 ? st2.name : '?')} — your revenue there −${Math.round(w.discount * 100)}%, ${w.daysLeft}d left`;
    }).join('<br>')}</div>` : '';

    // emergency debt — overdraft, daily interest, the −$50k line
    const debtHtml = s.cash < 0 ? `<div class="alert-banner debt"><b>Overdraft: ${fmtMoney(-s.cash)}.</b> The bank is floating you at 0.15%/day — ${fmtMoney(Math.max(1, Math.round(-s.cash * 0.0015)))}/day interest${s.debtInterestPaid > 0 ? ` (${fmtMoney(s.debtInterestPaid)} paid so far)` : ''}. It calls everything in at <b>−$50,000</b>.</div>` : '';

    // first-steps quests until all done
    let questHtml = '';
    if (s.questsDone.length < QUESTS.length) {
      questHtml = `<div class="quest-card">
        <div class="q-title">First steps</div>
        ${QUESTS.map(q => {
          const done = s.questsDone.includes(q.id);
          return `<div class="quest-row ${done ? 'done' : ''}"><span class="q-check">${done ? '✓' : ''}</span><span class="q-desc">${esc(q.desc)}</span><span class="q-reward">${done ? 'paid' : '+' + fmtMoney(q.reward)}</span></div>`;
        }).join('')}
      </div>`;
    }

    // daily fixed costs — rents & wages inflate with costScale (diseconomies)
    const rentRows = s.premises.filter(pr => !pr.franchise).map(pr => {
      const st2 = s.world.settlements.find(x => x.id === pr.sid);
      const rent = Math.round(PREMISE_COSTS[pr.kind === 'office' ? 'office' : pr.kind][st2.type].rent * scale);
      return { label: `${st2.name} (${pr.kind})${pr.kind === 'store' && pr.franchise ? ' (franchise)' : ''}`, amount: rent };
    });
    const execSalaries = s.execs.reduce((a, e) => a + EXEC_ROLES[e.role].salary, 0);
    const wageTotal = Math.round((s.staff.shipping * WAGES.shipping + s.staff.support * WAGES.support + s.staff.engineer * WAGES.engineer) * scale);
    const execTotal = Math.round(execSalaries * scale);
    const mktTotal = Object.values(s.marketing).reduce((a, b) => a + b, 0);
    const burn = rentRows.reduce((a, r) => a + r.amount, 0) + wageTotal + execTotal + mktTotal;
    const net7 = s.history.slice(-7).reduce((a, r) => a + r.profit, 0) / Math.max(1, s.history.slice(-7).length);
    const runway = net7 < 0 && s.cash > 0 ? Math.floor(s.cash / -net7) : null;
    const debtRunway = net7 < 0 && s.cash <= 0 ? Math.floor((50000 + s.cash) / -net7) : null;

    const profitD = s.history.slice(-90).map(r => r.profit);
    const revD = s.history.slice(-90).map(r => r.revenue);
    const custD = s.history.slice(-90).map(r => r.customers);

    this.panel.innerHTML = `
      <div class="ptitle">${esc(s.companyName)}</div>
      ${questHtml}
      ${debtHtml}
      ${warHtml}
      ${stockouts.length ? `<div class="alert-banner"><b>Out of stock:</b> ${stockouts.map(p => esc(p.name)).join(', ')} — you're turning customers away! <button class="btn small danger" data-goto="products">Fix</button></div>` : ''}
      ${advisorStrip(s)}
      <div class="tiles">
        ${tile('Revenue / 7d', fmtMoney(rev7), 'money', delta ? `${delta > 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(0)}% vs prior week` : '', delta >= 0 ? 'up' : 'down')}
        ${tile('Profit / 7d', fmtMoney(m.profit7), m.profit7 >= 0 ? 'good' : 'bad', m.profit7 >= 0 ? 'in the black' : 'burning cash', m.profit7 >= 0 ? 'up' : 'down')}
        ${tile('Customers', m.totalCustomers.toLocaleString(), 'good', `+${m.new7} this week (${m.organic7 > 0 ? Math.round(m.organic7) + ' organic' : 'all paid'})`, 'up')}
        ${tile('Orders / 7d', m.ord7.toLocaleString(), '', `${m.newOrd7.toLocaleString()} first-time · ${m.repOrd7.toLocaleString()} returning`)}
        ${tile('CAC (paid)', m.cac != null ? fmtMoney(m.cac) : '—', 'cyan', 'cost per NEW customer won by ads')}
        ${tile('LTV', fmtMoney(m.ltv), 'cyan', ratio != null ? `LTV:CAC = ${ratio.toFixed(1)}× ${ratio >= 3 ? '✓ healthy' : ratio >= 1 ? '· thin' : '✗ losing on ads'}` : 'margin on repeat orders over a customer\'s life', ratio != null ? (ratio >= 3 ? 'up' : ratio < 1 ? 'down' : '') : '')}
        ${tile('Satisfaction', pct(m.satisfaction), m.satisfaction > 0.8 ? 'good' : m.satisfaction > 0.6 ? '' : 'bad', 'drives repeat orders & blocks poaching')}
        ${tile('On-time ship', pct(s.onTime), s.onTime > 0.85 ? 'good' : s.onTime > 0.6 ? '' : 'bad', `shoppers expect ≤${s.expectedDeliveryDays ?? 4}d${s.queue > 0 ? ` · ${s.queue} queued` : ''}`)}
      </div>
      ${chartBox('Daily profit — last 90 days', sparkSigned(profitD), profitD.length ? '±' + fmtShort(Math.max(...profitD.map(Math.abs), 1)) : '')}
      ${chartBox('Daily revenue', sparkLine(revD, 'var(--green)', 44), revD.length ? 'peak ' + fmtShort(Math.max(...revD, 1)) : '')}
      ${chartBox('Customers', sparkLine(custD, 'var(--cyan)', 44), custD.length ? 'peak ' + fmtShort(Math.max(...custD, 1)) : '')}
      <div class="psub">Today's P&amp;L</div>
      ${last ? `
      <div class="prow"><span class="k">Revenue (${last.orders} orders)</span><span class="v money">${fmtMoney(last.revenue)}</span></div>
      <div class="prow"><span class="k">− Cost of goods</span><span class="v">${fmtMoney(-(last.cogs || 0))}</span></div>
      <div class="prow"><span class="k">− Rent</span><span class="v">${fmtMoney(-(last.rent || 0))}</span></div>
      <div class="prow"><span class="k">− Wages</span><span class="v">${fmtMoney(-(last.wages || 0))}</span></div>
      <div class="prow"><span class="k">− Marketing</span><span class="v">${fmtMoney(-(last.mkt || 0))}</span></div>
      ${last.interest ? `<div class="prow"><span class="k">− Overdraft interest</span><span class="v bad">${fmtMoney(-last.interest)}</span></div>` : ''}
      ${last.refunds ? `<div class="prow"><span class="k">− Refunds (late orders)</span><span class="v bad">${fmtMoney(-last.refunds)}</span></div>` : ''}
      <div class="prow total"><span class="k"><b>= Net profit</b></span><span class="v ${last.profit >= 0 ? 'good' : 'bad'}"><b>${fmtMoney(last.profit)}</b></span></div>
      ${last.exportRev ? `<div class="prow"><span class="k">incl. export shipment</span><span class="v good">${fmtMoney(last.exportRev)}</span></div>` : ''}
      ${last.franchiseRev ? `<div class="prow"><span class="k">incl. franchise royalties</span><span class="v good">${fmtMoney(last.franchiseRev)}</span></div>` : ''}
      ${last.poached > 0 ? `<div class="prow"><span class="k">Customers poached by rivals</span><span class="v bad">−${last.poached}</span></div>` : ''}
      ${last.missedStock > 0 ? `<div class="prow"><span class="k">Missed sales (stockouts)</span><span class="v bad">~${last.missedStock} units</span></div>` : ''}
      ${missed7 > 0 ? `<div class="prow"><span class="k">Missed this week</span><span class="v bad">~${missed7} units</span></div>` : ''}
      ` : '<div class="small-note">No trading yet.</div>'}
      <div class="psub">Daily fixed costs</div>
      ${rentRows.map(r => `<div class="prow"><span class="k">${esc(r.label)}</span><span class="v">${fmtMoney(r.amount)}/d</span></div>`).join('')}
      <div class="prow"><span class="k">Wages (${Object.values(s.staff).reduce((a, b) => a + b, 0)} staff)</span><span class="v">${fmtMoney(wageTotal)}/d</span></div>
      ${execTotal > 0 ? `<div class="prow"><span class="k">Executive salaries (${s.execs.length - 1})</span><span class="v">${fmtMoney(execTotal)}/d</span></div>` : ''}
      <div class="prow"><span class="k">Marketing</span><span class="v">${fmtMoney(mktTotal)}/d</span></div>
      <div class="prow total"><span class="k"><b>Total costs</b></span><span class="v money"><b>${fmtMoney(burn)}/day</b></span></div>
      ${scale > 1.02 ? `<div class="small-note tight">Rents &amp; wages run ×${scale.toFixed(2)} at your size — landlords and labour markets notice a giant.</div>` : ''}
      ${runway != null ? `<div class="prow"><span class="k">Runway at current losses</span><span class="v ${runway < 30 ? 'bad' : ''}">${runway} days</span></div>` : ''}
      ${debtRunway != null ? `<div class="prow"><span class="k bad">Bankruptcy (−$50k) at current losses</span><span class="v bad">~${Math.max(0, debtRunway)} days</span></div>` : ''}
      ${nextGoalRow(s)}
    `;
  }

  // ================= PRODUCTS =================
  renderProducts() {
    const s = this.s;
    const focus = brandFocus(s);
    const focusCls = focus.bonus >= 1.08 ? 'good' : focus.bonus >= 0.96 ? 'mid' : 'bad';
    const listedN = s.products.filter(p => p.listed).length;
    const cap = listingCap(s);
    let html = `<div class="ptitle">Products</div>
      <div class="btn-row">
        <button class="btn green" data-act="browse-catalog">+ Source from catalog</button>
        <button class="btn" data-act="open-rnd" ${s.rnd ? 'disabled' : ''}>R&amp;D</button>
      </div>
      <div class="prow"><span class="k">Product slots</span><span class="v ${listedN >= cap ? 'bad' : ''}">${listedN} / ${cap} listed</span></div>
      <div class="small-note">You can only merchandise so many products at once — upgrade the online store for more slots. Physical stores shelve only their best-fitting few.</div>
      ${(() => {
        const hasCmo = s.execs.some(e => e.role === 'cmo');
        return `<label class="auto-label autoprice-row ${hasCmo ? '' : 'disabled'}" title="${hasCmo ? 'The CMO probes the demand curve weekly and nudges every listed price toward its profit sweet spot' : 'Hire a CMO (Staff tab) to unlock'}">
          <input type="checkbox" data-act="autoprice" ${s.autoPrice ? 'checked' : ''} ${hasCmo ? '' : 'disabled'}>
          CMO pricing desk — auto-optimize prices${hasCmo ? '' : ' <span class="dim">(needs a CMO)</span>'}
        </label>`;
      })()}
      ${s.products.filter(p => p.listed).length ? `<div class="focus-banner">
        <div class="fb-line"><span class="fb-label ${focusCls}">Brand: ${esc(focus.label)}</span>
        ${focus.topCat ? `<span class="fb-stat">${CATEGORIES[focus.topCat].name} ${Math.round(focus.topShare * 100)}%</span>` : ''}
        <span class="fb-stat">appeal ×${focus.bonus.toFixed(2)}</span></div>
        <div class="small-note tight">A coherent range converts better. Shoppers trust a ${focus.topCat ? CATEGORIES[focus.topCat].name.toLowerCase() : ''} brand more than a junk drawer.</div>
      </div>` : ''}`;
    if (s.rnd) {
      const pctDone = Math.round((1 - s.rnd.daysLeft / s.rnd.totalDays) * 100);
      html += `<div class="card"><div class="prow"><span class="k">Developing ${CATEGORIES[s.rnd.cat].name}</span><span class="v">${Math.max(0, Math.min(99, pctDone))}%</span></div>
        <div class="progress"><div style="width:${Math.max(0, Math.min(99, pctDone))}%"></div></div>
        <div class="small-note tight">${RND_TIERS[s.rnd.tier].name} tier · ~${Math.max(1, Math.ceil(s.rnd.daysLeft / (1 + s.staff.engineer * 0.45)))} days left. Engineers speed this up.</div></div>`;
    }
    if (!s.products.length) {
      html += `<div class="small-note">No products yet. Source something quick from the Shopify catalog to start selling, or invest in R&amp;D for high-margin products of your own.</div>`;
    }
    for (const p of s.products) html += this.productCard(p);
    this.panel.innerHTML = html;
    this.bindProductEvents();
    this.panel.querySelector('[data-act=browse-catalog]')?.addEventListener('click', () => this.modalCatalog());
    this.panel.querySelector('[data-act=open-rnd]')?.addEventListener('click', () => this.modalRnd());
    this.panel.querySelector('[data-act=autoprice]')?.addEventListener('change', (e) => {
      const r = setAutoPrice(this.s, e.target.checked);
      this.game.jukebox.sfx(r.ok ? 'click' : 'bad');
      if (!r.ok && r.msg) this.flashNote(r.msg);
      this.renderPanel(true);
    });
  }

  productCard(p) {
    const s = this.s;
    const margin = p.price > 0 ? (p.price - p.cost) / p.price : 0;
    const incoming = p.incoming?.reduce((a, o) => a + o.qty, 0) || 0;
    const hasStores = s.premises.some(x => x.kind === 'store' && premiseActive(x) && !x.franchise);
    // catalog products dropship online (never out) — they only "stock out" for store shelves
    const isOut = p.listed && (p.inventory || 0) <= 0 && (p.source === 'own' || (p.source === 'catalog' && hasStores));
    // where does this product fit? (only surveyed markets tell you)
    const surveyed = s.world.settlements.filter(x => x.researched);
    let fitHtml = '';
    if (surveyed.length && p.listed) {
      const fits = surveyed.map(st => ({ st, f: fitScore(s, p, st) })).sort((a, b) => b.f - a.f);
      const best = fits[0], worst = fits[fits.length - 1];
      fitHtml = `<div class="fit-line">fit: <span class="${best.f > 55 ? 'good' : ''}">${esc(best.st.name)} ${best.f}</span>${fits.length > 1 ? ` · worst: ${esc(worst.st.name)} ${worst.f}` : ''} <span class="ultradim">(surveyed markets)</span></div>`;
    } else if (p.listed) {
      fitHtml = `<div class="fit-line dim">fit: ??? — survey settlements to see where this sells</div>`;
    }
    return `<div class="card prod-card ${isOut ? 'out' : ''}" data-pid="${p.id}">
      <div class="prod-img">${prodImg(p)}</div>
      <div class="prod-info">
        <div class="prod-head">
          <span class="prod-name">${esc(p.name)}</span>
          <span class="badge ${p.source === 'own' ? 'own' : 'catalog'}">${p.source === 'own' ? 'OWN' : 'CATALOG'}</span>
        </div>
        <span class="prod-cat" style="--chip:${CATEGORIES[p.cat].color}">${CATEGORIES[p.cat].name}${p.season ? ' · ' + p.season : ''}${p.sports ? ' · sports' : ''}</span>
        <div class="prod-attrs">
          ${pips('STY', p.style)} ${pips('QUA', p.quality)} ${pips('UTL', p.utility)} ${pips('ECO', p.eco)} ${pips('TEC', p.tech)}
        </div>
        ${segChips(p)}
        ${isOut ? `<div class="stockout-strip">${p.source === 'catalog' ? 'No store stock — shelves are going bare' : 'Out of stock'} — missed ~${p.missedToday || 0} sales today</div>` : ''}
        <div class="prod-price-row">
          <span class="price-val money">$${p.price}</span>
          <input type="range" min="${Math.max(1, Math.ceil(p.cost))}" max="${Math.round(p.msrp * 2.2)}" value="${p.price}" data-price="${p.id}">
          <span class="margin-val dim">${Math.round(margin * 100)}%&nbsp;margin</span>
        </div>
        ${p.source === 'own' ? `<div class="stock-bar" title="${p.inventory} units in stock"><div class="${p.inventory <= 10 ? 'low' : ''}" style="width:${Math.max(0, Math.min(100, p.inventory / 2))}%"></div></div>` : ''}
        <div class="prod-actions">
          <button class="btn small ${p.listed ? '' : 'green'}" data-list="${p.id}">${p.listed ? 'Unlist' : 'List'}</button>
          ${p.source === 'own' ? `
            <span class="${p.inventory <= 10 ? 'bad' : ''}">stock: ${p.inventory}${incoming ? ` <span class="cyan">(+${incoming} inbound)</span>` : ''}</span>
            <button class="btn small" data-stock="${p.id}" data-qty="100">+100</button>
            <button class="btn small" data-stock="${p.id}" data-qty="500">+500 <span class="green">−20%</span></button>
            <label class="auto-label" title="Reorders ahead of demand so you never hit zero"><input type="checkbox" data-auto="${p.id}" ${p.autoRestock ? 'checked' : ''}> auto</label>
          ` : ''}
          <span class="dim sold">${(p.vel || 0) >= 0.1 ? `~${p.vel < 10 ? p.vel.toFixed(1) : Math.round(p.vel)}/day · ` : ''}sold ${p.soldTotal}</span>
          ${!p.listed ? `<button class="btn small danger" data-del="${p.id}" title="Discontinue — leftover stock liquidated at 40%">Delete</button>` : ''}
        </div>
        ${p.source === 'catalog' ? `
        <div class="prod-actions wholesale-row">
          <span class="${hasStores && p.listed && (p.inventory || 0) <= 0 ? 'bad' : ''}">stock: ${p.inventory || 0}${incoming ? ` <span class="cyan">(+${incoming} inbound)</span>` : ''}</span>
          <button class="btn small" data-wholesale="${p.id}" data-qty="20" title="Minimum wholesale order">+20</button>
          <button class="btn small" data-wholesale="${p.id}" data-qty="200">+200 <span class="green">−8%</span></button>
          <button class="btn small" data-wholesale="${p.id}" data-qty="500">+500 <span class="green">−15%</span></button>
          <label class="auto-label" title="Reorders ahead of demand so you never hit zero"><input type="checkbox" data-auto="${p.id}" ${p.autoRestock ? 'checked' : ''}> auto</label>
        </div>
        <div class="small-note tight">Stocked units cost <b class="green">$${p.wholesaleCost}</b>/unit and ship online or from store shelves. Anything unstocked dropships at <b>$${p.cost}</b>/unit — stock is margin.</div>` : ''}
        ${fitHtml}
      </div>
    </div>`;
  }

  bindProductEvents() {
    this.panel.querySelectorAll('input[data-price]').forEach(inp => {
      inp.addEventListener('input', () => {
        const p = this.s.products.find(x => x.id === inp.dataset.price);
        p.price = parseInt(inp.value, 10);
        const card = inp.closest('.prod-card');
        card.querySelector('.price-val').textContent = '$' + p.price;
        const margin = p.price > 0 ? (p.price - p.cost) / p.price : 0;
        card.querySelector('.margin-val').innerHTML = `${Math.round(margin * 100)}%&nbsp;margin`;
      });
    });
    this.panel.querySelectorAll('[data-list]').forEach(btn => {
      btn.addEventListener('click', () => {
        const r = toggleListing(this.s, btn.dataset.list);
        this.game.jukebox.sfx(r.ok ? 'click' : 'bad');
        if (!r.ok && r.msg) this.flashNote(r.msg);
        this.renderPanel(true);
      });
    });
    this.panel.querySelectorAll('[data-stock]').forEach(btn => {
      btn.addEventListener('click', () => {
        const r = orderStock(this.s, btn.dataset.stock, parseInt(btn.dataset.qty, 10));
        this.game.jukebox.sfx(r.ok ? 'build' : 'bad');
        if (!r.ok) this.flashNote(r.msg);
        this.renderPanel(true);
      });
    });
    this.panel.querySelectorAll('[data-wholesale]').forEach(btn => {
      btn.addEventListener('click', () => {
        const r = orderWholesale(this.s, btn.dataset.wholesale, parseInt(btn.dataset.qty, 10));
        this.game.jukebox.sfx(r.ok ? 'build' : 'bad');
        if (!r.ok) this.flashNote(r.msg);
        this.renderPanel(true);
      });
    });
    this.panel.querySelectorAll('[data-auto]').forEach(cb => {
      cb.addEventListener('change', () => {
        const p = this.s.products.find(x => x.id === cb.dataset.auto);
        p.autoRestock = cb.checked;
        this.game.jukebox.sfx('click');
      });
    });
    this.panel.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = this.s.products.find(x => x.id === btn.dataset.del);
        if (!p) return;
        const close = this.modal(`
          <h2>Discontinue ${esc(p.name)}?</h2>
          <p class="small-note">${(p.inventory || 0) > 0 ? `The ${p.inventory} leftover units are liquidated at 40 cents on the dollar.` : 'It has no stock left.'} ${p.source === 'catalog' ? 'You can re-source it from the catalog later.' : 'R&D products are gone for good.'}</p>
          <div class="modal-btns">
            <button class="btn" id="del-cancel">Keep it</button>
            <button class="btn danger" id="del-go">Delete</button>
          </div>`);
        document.getElementById('del-cancel').addEventListener('click', close);
        document.getElementById('del-go').addEventListener('click', () => {
          const r = deleteProduct(this.s, p.id);
          this.game.jukebox.sfx(r.ok ? 'build' : 'bad');
          if (!r.ok && r.msg) this.flashNote(r.msg);
          close();
          this.renderPanel(true);
        });
      });
    });
  }

  // ================= STORES =================
  renderStores() {
    const s = this.s;
    const office = s.premises.find(p => p.kind === 'office');
    const hqS = s.world.settlements.find(x => x.id === s.hq);
    const lvl = OFFICE_LEVELS[office.level];
    const next = OFFICE_LEVELS[office.level + 1];
    const stores = s.premises.filter(p => p.kind === 'store' && !p.franchise);
    const franchises = s.premises.filter(p => p.kind === 'store' && p.franchise);
    const whs = s.premises.filter(p => p.kind === 'warehouse');
    let shipCap = lvl.shipCap + whs.filter(premiseActive).length * 90 + s.staff.shipping * 30;
    if (s.execs.some(e => e.role === 'coo' && e.sid)) shipCap *= 1.25;   // COO stationed
    if (s.automation > 0) shipCap *= AUTOMATION_TIERS[s.automation - 1].mult;
    shipCap = Math.round(shipCap);

    let html = `<div class="ptitle">Stores &amp; premises</div>
      <div class="card office-card">
        ${office.level === 0 && ART.garage ? `<img class="office-art" src="${ART.garage}" alt="">` : ''}
        <div class="prow"><span class="k">${lvl.name}</span><span class="v">${esc(hqS.name)}</span></div>
        <div class="prow"><span class="k">Ship capacity</span><span class="v">${shipCap}/day ${s.queue > shipCap ? '<span class="bad">(backlog!)</span>' : ''}</span></div>
        <div class="prow"><span class="k">Queue</span><span class="v ${s.queue > shipCap * 2 ? 'bad' : ''}">${s.queue} packages</span></div>
        <div class="prow"><span class="k">Staff desks</span><span class="v">${staffCount(s)}/${staffCap(s)}</span></div>
        ${office.construction
          ? `<div class="small-note">Upgrading to <b>${OFFICE_LEVELS[office.construction.toLevel].name}</b> — ${office.construction.daysLeft} days left</div>`
          : next ? `<button class="btn green" data-act="upgrade-office">Upgrade → ${next.name} (${fmtMoney(next.upgradeCost)})</button>
        <div class="small-note tight">ship ${lvl.shipCap}→<b class="green">${next.shipCap}</b>/day · desks ${lvl.staffCap}→<b class="green">${next.staffCap}</b> · takes ${next.buildDays} days</div>` : '<div class="small-note">Office fully upgraded — a proper HQ tower.</div>'}
      </div>`;

    // online store
    if (!s.onlineStore) {
      html += `<div class="card">
        <div class="prow"><span class="k">Online Store</span><span class="v bad">not launched</span></div>
        <div class="small-note">Reach every settlement on the map — city dwellers especially love shopping online. Ships from your warehouses.</div>
        <button class="btn green" data-act="launch-online">Launch online store ($800)</button>
      </div>`;
    } else {
      const listed = s.products.filter(p => p.listed).length;
      html += `<div class="card">
        <div class="prow"><span class="k">${esc(s.companyName)}.shop</span><span class="v live-pill">LIVE</span></div>
        <div class="prow"><span class="k">Products listed</span><span class="v">${listed}</span></div>
        <div class="prow"><span class="k">Store level</span><span class="v">${s.onlineStore.level}</span></div>
        ${s.onlineStore.level < 3 ? `<button class="btn" data-act="upgrade-online">Upgrade theme &amp; checkout (${fmtMoney(s.onlineStore.level * 4000)}) → +10% conversion</button>` : ''}
      </div>`;
    }

    html += `<div class="psub">Physical stores (Shopify POS)</div>`;
    if (!stores.length) html += `<div class="small-note">No physical stores. Some shoppers — especially in villages and among seniors — rarely buy online. Click a settlement on the map to open one there.</div>`;
    else html += `<div class="prow"><span class="k">Shelf logistics</span><span class="v">${storeLogisticsCap(s)} units/day</span></div>
      <div class="small-note tight">Daily capacity for moving warehouse stock onto shelves. Warehouses, crew, a stationed COO and automation raise it. Stores sell only what's on their shelves.</div>`;
    for (const pr of stores) {
      const st2 = s.world.settlements.find(x => x.id === pr.sid);
      const sl = STORE_LEVELS[pr.level];
      const nx = STORE_LEVELS[pr.level + 1];
      if (pr.construction && pr.construction.isNew) {
        html += `<div class="card">
          <div class="prow"><span class="k">${esc(st2.name)}</span><span class="v">under construction</span></div>
          <div class="small-note tight">Opens in <b>${pr.construction.daysLeft}</b> day${pr.construction.daysLeft === 1 ? '' : 's'} — rent already running (${fmtMoney(PREMISE_COSTS.store[st2.type].rent)}/day).</div>
        </div>`;
        continue;
      }
      const svc = pr.serviceLevel ?? 1;
      const shelfRows = Object.entries(pr.stock || {}).filter(([, u]) => u > 0)
        .map(([pid, u]) => {
          const p = s.products.find(x => x.id === pid);
          return p ? `<div class="shelf-row"><span>${esc(p.name)}</span><span class="${u <= 3 ? 'bad' : ''}">${u}</span></div>` : '';
        }).join('');
      html += `<div class="card">
        <div class="prow"><span class="k">${esc(st2.name)}</span><span class="v">${sl.name}</span></div>
        <div class="prow"><span class="k">Rent</span><span class="v money">${fmtMoney(PREMISE_COSTS.store[st2.type].rent)}/day</span></div>
        <div class="prow"><span class="k">Shelf space</span><span class="v">${sl.shelf} products (best local fit)</span></div>
        <div class="prow"><span class="k">Service level</span><span class="v ${svc < 0.85 ? 'bad' : 'good'}">${pct(svc)}${pr.missedToday ? ` · <span class="bad">missed ${pr.missedToday} today</span>` : ''}</span></div>
        <div class="shelf-box">${shelfRows || `<div class="small-note tight">Shelves are empty — get units into the central warehouse (order stock or wholesale) and the daily replenishment run fills them.</div>`}</div>
        <label class="auto-label"><input type="checkbox" data-replenish="${pr.id}" ${pr.autoReplenish !== false ? 'checked' : ''}> auto-replenish from warehouse</label>
        ${pr.construction
          ? `<div class="small-note tight">Refit to <b>${STORE_LEVELS[pr.construction.toLevel].name}</b> — ${pr.construction.daysLeft} days left (still trading)</div>`
          : nx ? `<button class="btn green" data-up-store="${pr.id}">Upgrade → ${nx.name} (${fmtMoney(nx.upgradeCost)})</button>
        <div class="small-note tight">foot traffic ×${sl.capture}→<b class="green">×${nx.capture}</b> · shelf ${sl.shelf}→<b class="green">${nx.shelf}</b> · ${nx.buildDays}-day refit</div>` : '<div class="small-note">Flagship — as big as they come.</div>'}
      </div>`;
    }
    if (franchises.length) {
      html += `<div class="psub">Franchise stores</div>
        <div class="small-note">Franchisees stock and staff their own stores — you bank an 8% royalty and pay no rent.</div>`;
      for (const pr of franchises) {
        const st2 = s.world.settlements.find(x => x.id === pr.sid);
        html += `<div class="prow"><span class="k">${esc(st2.name)}</span><span class="v dim">franchise · 8% royalty</span></div>`;
      }
    }

    html += `<div class="psub">Warehouses</div>
      <div class="small-note">Each warehouse adds 90 pkgs/day capacity, 6 staff desks, and speeds delivery to its region. Stock arrives by ship at the port, then lorries haul it to your nearest warehouse. Click a settlement on the map to build.</div>`;
    for (const pr of whs) {
      const st2 = s.world.settlements.find(x => x.id === pr.sid);
      html += `<div class="prow"><span class="k">${esc(st2.name)}${premiseActive(pr) ? '' : ` <span class="dim">(${pr.construction.daysLeft}d to finish)</span>`}</span><span class="v money">${fmtMoney(PREMISE_COSTS.warehouse[st2.type].rent)}/day</span></div>`;
    }
    html += `<div class="small-note tip">Tip: click any settlement on the map to open a store, build a warehouse, or survey shoppers there.</div>`;

    this.panel.innerHTML = html;
    this.panel.querySelector('[data-act=upgrade-office]')?.addEventListener('click', () => {
      const r = this.act(() => upgradeOffice(this.s));
      if (r.ok) {
        const o = this.s.premises.find(p => p.kind === 'office');
        this.celebrateUpgrade(o.sid, `Builders on site`,
          `${OFFICE_LEVELS[o.construction.toLevel].name} ready in ${o.construction.totalDays} days`);
      }
    });
    this.panel.querySelector('[data-act=launch-online]')?.addEventListener('click', () => {
      const r = this.act(() => launchOnlineStore(this.s));
      if (r.ok) this.game.jukebox.sfx('goal');
    });
    this.panel.querySelector('[data-act=upgrade-online]')?.addEventListener('click', () => {
      const r = this.act(() => {
        const cost = this.s.onlineStore.level * 4000;
        if (this.s.cash < cost) return { ok: false, msg: `Need ${fmtMoney(cost)}` };
        this.s.cash -= cost; this.s.onlineStore.level++;
        return { ok: true };
      });
      if (r.ok) this.celebrateUpgrade(this.s.hq, `Store level ${this.s.onlineStore.level}!`, 'sharper theme · faster checkout · better conversion');
    });
    this.panel.querySelectorAll('[data-up-store]').forEach(b =>
      b.addEventListener('click', () => {
        const r = this.act(() => upgradeStore(this.s, b.dataset.upStore));
        if (r.ok) {
          const pr = this.s.premises.find(p => p.id === b.dataset.upStore);
          this.celebrateUpgrade(pr.sid, `Refit underway`, `${STORE_LEVELS[pr.construction.toLevel].name} in ${pr.construction.totalDays} days`);
        }
      }));
    this.panel.querySelectorAll('[data-replenish]').forEach(cb =>
      cb.addEventListener('change', () => {
        toggleStoreReplenish(this.s, cb.dataset.replenish);
        this.game.jukebox.sfx('click');
      }));
  }

  celebrateUpgrade(sid, title, detail) {
    this.game.renderer.celebrate(sid);
    this.game.jukebox.sfx('goal');
    const s = this.s.world.settlements.find(x => x.id === sid);
    if (s) {
      if (typeof this.game.renderer.focus === 'function') this.game.renderer.focus(s.x, s.y);
      else if (this.game.renderer.cam) { this.game.renderer.cam.x = s.x; this.game.renderer.cam.y = s.y; }
    }
    const el = document.getElementById('goal-toast');
    el.className = 'toast green-toast';
    retoast(el);
    el.innerHTML = `<div class="toast-title">${esc(title)}</div><div class="toast-sub">${esc(detail)}</div>`;
    clearTimeout(this._noteT);
    this._noteT = setTimeout(() => fadeToast(el), 3200);
  }

  // ================= STAFF =================
  renderStaff() {
    const s = this.s;
    let html = `<div class="ptitle">Staff</div>
      <div class="prow"><span class="k">Desks used</span><span class="v">${staffCount(s)} / ${staffCap(s)}</span></div>
      <div class="small-note">Wages are paid daily. Hiring costs 10 days' wages up front. Upgrade the office or build warehouses for more desks.</div>`;
    for (const [role, info] of Object.entries(STAFF_INFO)) {
      html += `<div class="card staff-row">
        <div class="staff-mid">
          <div class="staff-name">${info.name} <span class="dim">· ${fmtMoney(info.wage)}/day</span></div>
          <div class="small-note tight">${info.desc}</div>
        </div>
        <span class="staff-count">${s.staff[role]}</span>
        <div class="staff-btns">
          <button class="btn small" data-hire="${role}" title="Hire">+</button>
          <button class="btn small" data-fire="${role}" title="Let go">−</button>
        </div>
      </div>`;
    }
    const scale = costScale(s);
    // ---- executives (SIM2): pawns you hire and station around the map ----
    html += `<div class="psub">Executives</div>
      <div class="small-note">Execs are pawns. Station them where they're needed — travel takes days and their effects pause on the road. One per role.</div>`;
    const hqName = s.world.settlements.find(x => x.id === s.hq)?.name || 'HQ';
    const sorted = [...s.world.settlements].sort((a, b) => b.pop - a.pop);
    for (const [role, def] of Object.entries(EXEC_ROLES)) {
      const ex = s.execs.find(e => e.role === role);
      if (!ex) {
        if (role === 'ceo') continue; // always present
        html += `<div class="card staff-row exec-card">
          <div class="staff-mid">
            <div class="staff-name">${def.name} <span class="dim">· ${fmtMoney(def.salary)}/day</span></div>
            <div class="small-note tight">${esc(def.desc)}</div>
          </div>
          <div class="staff-btns"><button class="btn small green" data-hire-exec="${role}">Hire ${fmtMoney(def.hireCost)}</button></div>
        </div>`;
        continue;
      }
      const travel = s.execTravels.find(t => t.execId === ex.id);
      let station;
      if (travel) {
        const dest = s.world.settlements.find(x => x.id === travel.sid);
        station = `<span class="cyan">en route to ${esc(dest ? dest.name : '?')} — ${travel.daysLeft}d</span>`;
      } else if (ex.sid === s.hq) station = `at HQ (${esc(hqName)})`;
      else if (ex.sid) station = `stationed in ${esc(s.world.settlements.find(x => x.id === ex.sid)?.name || '?')}`;
      else station = `<span class="dim">unassigned</span>`;
      html += `<div class="card exec-card">
        <div class="staff-row">
          <div class="staff-mid">
            <div class="staff-name">${esc(ex.name)} <span class="dim">· ${def.name}${def.salary ? ` · ${fmtMoney(def.salary)}/day` : ''}</span></div>
            <div class="small-note tight">${station}</div>
          </div>
          ${role !== 'ceo' ? `<div class="staff-btns"><button class="btn small" data-fire-exec="${ex.id}" title="Let go"></button></div>` : ''}
        </div>
        <div class="small-note tight">${esc(def.desc)}</div>
        <div class="exec-assign">
          <select data-assign-exec="${ex.id}" ${travel ? 'disabled' : ''}>
            <option value="">Send to…</option>
            <option value="${s.hq}">HQ — ${esc(hqName)}</option>
            ${sorted.filter(x => x.id !== s.hq).map(x => `<option value="${x.id}">${esc(x.name)} (${x.type})</option>`).join('')}
          </select>
        </div>
      </div>`;
    }
    const staffWages = Object.entries(s.staff).reduce((a, [r, n]) => a + n * STAFF_INFO[r].wage, 0);
    const execWages = s.execs.reduce((a, e) => a + EXEC_ROLES[e.role].salary, 0);
    html += `<div class="prow total"><span class="k">Total wages${scale > 1.02 ? ` <span class="dim">(×${scale.toFixed(2)} scale)</span>` : ''}</span><span class="v money">${fmtMoney(Math.round((staffWages + execWages) * scale))}/day</span></div>`;
    this.panel.innerHTML = html;
    this.panel.querySelectorAll('[data-hire]').forEach(b => b.addEventListener('click', () => this.act(() => hire(this.s, b.dataset.hire))));
    this.panel.querySelectorAll('[data-fire]').forEach(b => b.addEventListener('click', () => this.act(() => fire(this.s, b.dataset.fire))));
    this.panel.querySelectorAll('[data-hire-exec]').forEach(b => b.addEventListener('click', () => {
      const r = this.act(() => hireExec(this.s, b.dataset.hireExec));
      if (r.ok) this.game.jukebox.sfx('goal');
    }));
    this.panel.querySelectorAll('[data-fire-exec]').forEach(b => b.addEventListener('click', () => this.act(() => fireExec(this.s, b.dataset.fireExec))));
    this.panel.querySelectorAll('[data-assign-exec]').forEach(sel => sel.addEventListener('change', () => {
      const sid = sel.value;
      if (!sid) return;
      this.act(() => assignExec(this.s, sel.dataset.assignExec, sid));
    }));
  }

  // ================= MARKETING =================
  renderMarketing() {
    const s = this.s, m = metrics(s);
    const total = Object.values(s.marketing).reduce((a, b) => a + b, 0);
    let html = `<div class="ptitle">Marketing</div>
      <div class="tiles">
        ${tile('Daily budget', fmtMoney(total), 'money')}
        ${tile('CAC — paid (7d)', m.cac != null ? fmtMoney(m.cac) : '—', 'cyan', m.cac != null && m.ltv > 0 ? `LTV:CAC ${(m.ltv / Math.max(1, m.cac)).toFixed(1)}× ${m.ltv / Math.max(1, m.cac) >= 3 ? '✓' : m.ltv / Math.max(1, m.cac) < 1 ? '✗ ads lose money' : ''}` : 'spend ÷ customers won by ads')}
      </div>
      <div class="small-note">CAC only counts customers your ads brought in — word-of-mouth customers (${Math.round(m.organic7)} this week) are free. Each channel shows its own cost per customer below. Diminishing returns: spreading beats maxing one channel.</div>`;
    for (const [key, ch] of Object.entries(CHANNELS)) {
      const spend = s.marketing[key];
      const disabled = key === 'flyers' && !s.premises.some(p => p.kind === 'store');
      const chStat = m.channels[key];
      let statLine = '';
      if (chStat && chStat.spend14 > 0) {
        statLine = chStat.cac != null
          ? `<span class="${m.ltv > chStat.cac * 3 ? 'good' : m.ltv < chStat.cac ? 'bad' : ''}">≈${fmtMoney(chStat.cac)}/customer</span> · won ~${Math.round(chStat.cust14)} in 14d`
          : `<span class="bad">no customers won yet</span>`;
      }
      html += `<div class="mk-channel card ${disabled ? 'disabled' : ''}">
        <div class="mk-head"><span class="mk-name">${ch.name}</span><span class="mk-spend">${fmtMoney(spend)}/day</span></div>
        <div class="mk-desc">${ch.desc}${disabled ? ' <span class="bad">Needs a physical store.</span>' : ''}</div>
        ${statLine ? `<div class="mk-desc stat">${statLine}</div>` : ''}
        <input type="range" min="0" max="${ch.max}" step="10" value="${spend}" data-mkt="${key}" ${disabled ? 'disabled' : ''}>
      </div>`;
    }
    // flash sale lever
    const fs = s.flashSale;
    const cooldown = Math.max(0, fs.cooldownUntil - s.day);
    let fsLabel, fsDisabled = false;
    if (fs.daysLeft > 0) { fsLabel = `Flash sale live — ${fs.daysLeft} day${fs.daysLeft === 1 ? '' : 's'} left`; fsDisabled = true; }
    else if (cooldown > 0) { fsLabel = `Flash sale (ready in ${cooldown}d)`; fsDisabled = true; }
    else fsLabel = 'Run flash sale — $800';
    html += `<div class="psub">Campaigns</div>
      <button class="btn amber-btn flash-btn ${fs.daysLeft > 0 ? 'live' : ''}" id="flash-sale" ${fsDisabled ? 'disabled' : ''}>${fsLabel}</button>
      <div class="small-note">4 days: everything 20% off, shopper attention ×1.55. Great before BFCM or to break into a contested town. 32-day cooldown.</div>`;

    this.panel.innerHTML = html;
    this.panel.querySelectorAll('[data-mkt]').forEach(inp => {
      inp.addEventListener('input', () => {
        this.s.marketing[inp.dataset.mkt] = parseInt(inp.value, 10);
        inp.closest('.mk-channel').querySelector('.mk-spend').textContent = fmtMoney(parseInt(inp.value, 10)) + '/day';
      });
    });
    this.panel.querySelector('#flash-sale')?.addEventListener('click', () => {
      const r = this.act(() => startFlashSale(this.s));
      if (r.ok) this.game.jukebox.sfx('goal');
    });
  }

  // ================= RESEARCH =================
  // rival dossier + per-settlement competition breakdown (state.competition)
  renderRivals() {
    const s = this.s;
    const postureInfo = {
      'expand': ['expanding', ''],
      'defend': ['defending its turf', ''],
      'price-war': ['waging a price war', 'bad'],
      'blitz': ['running promo blitzes', 'mid'],
    };
    let html = `<div class="psub">The competition</div>
      <div class="small-note"><b>How it works:</b> each rival holds <i>presence</i> in every settlement. Presence → pressure, which shrinks your share of shoppers and makes them pickier on price. Rivals poach your customers wherever their service beats your satisfaction, mass presence where you're winning, and start price wars that crush your margins locally. Fight back with satisfaction, awareness, stores and stocked shelves.</div>`;
    for (const r of RIVALS) {
      const agent = s.rivals?.find(a => a.id === r.id);
      if (!agent) continue;
      if (!agent.active) {
        // tease the disruptor until it enters
        html += `<div class="card rival-card dormant">
          <div class="prow"><span class="k strong">???</span><span class="v dim">not on the island… yet</span></div>
          <div class="small-note tight">Rumours of a same-day-everything megacorp scouting the island. Analysts expect a move once someone's revenue passes ${fmtMoney(PRIMELY_ENTRY_REVENUE)}.</div>
        </div>`;
        continue;
      }
      const [pLabel, pCls] = postureInfo[agent.posture] || [agent.posture, ''];
      const focusNames = (agent.focusSids || []).map(sid => s.world.settlements.find(x => x.id === sid)?.name).filter(Boolean);
      const wars = s.priceWars.filter(w => w.rival === r.id);
      html += `<div class="card rival-card" style="--rival:${r.color}">
        <div class="prow"><span class="k strong">${rivalEmblem(r.id)}<span style="color:${r.color}">${esc(r.name)}</span></span><span class="v posture ${pCls}">${pLabel}</span></div>
        <div class="small-note tight">${esc(r.blurb)}${r.id === 'primely' ? (agent.prime ? ' · <b class="bad">Primely Now — 2-day delivery everywhere</b>' : ' · same-day pressure on delivery expectations') : ''}</div>
        ${focusNames.length ? `<div class="prow"><span class="k">Focus markets</span><span class="v">${focusNames.map(esc).join(' · ')}</span></div>` : ''}
        ${agent.lastMove ? `<div class="prow"><span class="k">Last move</span><span class="v dim">${esc(agent.lastMove.desc)} <span class="ultradim">(${s.day - agent.lastMove.day}d ago)</span></span></div>` : ''}
        ${wars.map(w => `<div class="prow"><span class="k bad">Price war</span><span class="v bad">${esc(s.world.settlements.find(x => x.id === w.sid)?.name || '?')} · −${Math.round(w.discount * 100)}% · ${w.daysLeft}d left</span></div>`).join('')}
      </div>`;
    }
    html += `<div class="prow"><span class="k">Delivery expectation</span><span class="v ${(s.expectedDeliveryDays ?? 4) <= 2 ? 'bad' : ''}">shoppers expect ≤${s.expectedDeliveryDays ?? 4}-day delivery</span></div>
      <div class="small-note tight">Island-wide. Your on-time rate (${pct(s.onTime)}) is judged against this — disruptors keep ratcheting it down.</div>`;
    return html;
  }

  // compact competition breakdown block for a settlement (research card + modal)
  compBlock(st) {
    const s = this.s;
    const c = s.competition?.[st.id];
    if (!c) return '';
    const top = c.topRival ? RIVALS.find(r => r.id === c.topRival) : null;
    const trend = c.trend === 'up' ? '<span class="bad">▲ rising</span>' : c.trend === 'down' ? '<span class="good">▼ easing</span>' : '<span class="ultradim">— steady</span>';
    let y = Math.max(0, c.yourShare), rv = Math.max(0, c.rivalShare);
    const tot = y + rv;
    if (tot > 1) { y /= tot; rv /= tot; }
    return `<div class="comp-block ${c.priceWar ? 'war' : ''}">
      <div class="comp-head">
        <span class="comp-label">Competition</span>
        ${c.priceWar ? '<span class="war-badge">PRICE WAR</span>' : ''}
        <span class="comp-trend">${trend}</span>
        <span class="comp-pressure ${c.pressure > 1.2 ? 'bad' : c.pressure < 0.5 ? 'good' : ''}">pressure ${c.pressure.toFixed(1)}</span>
      </div>
      <div class="share-bar"><div class="sb-you" style="width:${(y * 100).toFixed(1)}%"></div><div class="sb-rival" style="width:${(rv * 100).toFixed(1)}%${top ? `;background:${top.color}` : ''}"></div></div>
      <div class="comp-legend"><span class="good">you ${pct(c.yourShare)}</span><span>${top ? `${rivalEmblem(top.id)}<span style="color:${top.color}">${esc(top.name)} leads</span> · ` : ''}<span class="dim">rivals ${pct(c.rivalShare)}</span></span></div>
    </div>`;
  }

  renderResearch() {
    const s = this.s;
    let html = `<div class="ptitle">Research &amp; competition</div>`;
    html += this.renderRivals();
    html += `<div class="psub">Settlements</div>
      <div class="small-note">Every settlement has a different mix of shopper segments. Survey them to see who lives there and what they want — then match products to markets.</div>`;
    const sorted = [...s.world.settlements].sort((a, b) => b.pop - a.pop);
    for (const st of sorted) {
      const cost = st.type === 'city' ? 1200 : st.type === 'town' ? 700 : 400;
      const blitz = s.rivalPromo?.sid === st.id;
      const grew = st.grewTick != null && s.day - st.grewTick < 90;
      const shrunk = st.shrunkTick != null && s.day - st.shrunkTick < 90;
      html += `<div class="card">
        <div class="prow">
          <span class="k strong">${esc(st.name)}</span>
          <span class="v">${st.pop.toLocaleString()} pop${grew ? ' <span class="good">▲</span>' : shrunk ? ' <span class="bad">▼</span>' : ''}</span>
        </div>
        ${grew ? `<div class="small-note tight good">Recently grew into a ${st.type} — bigger market, bigger rents.</div>` : ''}
        ${shrunk ? `<div class="small-note tight bad">Recently declined to a ${st.type} — fewer shoppers, cheaper rents.</div>` : ''}
        <div class="prow"><span class="k">Your customers</span><span class="v">${st.customers.toLocaleString()} · sat ${pct(st.satisfaction)}</span></div>
        <div class="prow"><span class="k">Awareness</span><span class="v">${pct(st.awareness)}</span></div>
        ${this.compBlock(st)}
        ${blitz ? `<div class="prow"><span class="k"></span><span class="v">${rivalEmblem(s.rivalPromo.rival)}<span class="bad">PROMO BLITZ — pressure ×1.6 for ${s.rivalPromo.daysLeft}d</span></span></div>` : ''}`;
      if (st.researched) {
        html += segBar(st.segments) +
          `<div class="seg-legend">` +
          Object.entries(st.segments).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) =>
            `<span><span class="seg-dot" style="background:${SEGMENTS[k].color}"></span>${SEGMENTS[k].name} ${pct(v)}</span>`).join('') + `</div>
          <div class="prow"><span class="k">Online affinity</span><span class="v">${pct(st.onlineAffinity)}</span></div>
          <div class="prow"><span class="k">Wealth</span><span class="v">${'$'.repeat(Math.max(1, Math.round(st.wealth * 2)))}</span></div>`;
        if (s.products.length) {
          const best = [...s.products].sort((a, b) => fitScore(s, b, st) - fitScore(s, a, st))[0];
          const f = fitScore(s, best, st);
          html += `<div class="prow"><span class="k">Best fit product</span><span class="v ${f > 60 ? 'good' : f > 35 ? '' : 'bad'}">${esc(best.name)} · ${f}</span></div>`;
        }
      } else {
        const sv = s.surveys.find(x => x.sid === st.id);
        const passive = s.passiveSurvey?.[st.id];
        html += `<div class="res-unknown">Segments: ??? · Preferences: ???</div>
          ${passive ? `<div class="small-note tight cyan">Head of Research's field team is profiling this market — ${pct(Math.min(1, passive))} done (free).</div>` : ''}
          ${sv
            ? `<div class="small-note tight">Researcher en route — results in ~${sv.daysLeft} day${sv.daysLeft === 1 ? '' : 's'}</div>`
            : `<button class="btn small" data-research="${st.id}">Survey (${fmtMoney(cost)})</button>
               <div class="small-note tight">A researcher walks there from HQ — farther towns take longer.</div>`}`;
      }
      html += `</div>`;
    }
    this.panel.innerHTML = html;
    this.panel.querySelectorAll('[data-research]').forEach(b =>
      b.addEventListener('click', () => this.act(() => researchSettlement(this.s, b.dataset.research))));
  }

  // ================= ADVISORS =================
  // Rule-based coaching: what's broken, why it matters, what to do.
  renderAdvisors() {
    const s = this.s;
    const tips = advisorTips(s);
    let html = `<div class="ptitle">Advisors</div>
      <div class="small-note">Your team's read on the business — worst problems first. Fix the red ones before they fix you.</div>`;
    if (!tips.length) {
      html += `<div class="card advisor-clear"><div class="ac-icon">✅</div>
        <div><b>Nothing on fire.</b><div class="small-note tight">The advisors are drinking coffee. Grow marketing, add products, or expand — and check back when something changes.</div></div></div>`;
    }
    for (const t of tips) html += tipCard(t);
    html += `<div class="psub">How the machine works</div>
      <div class="card cheat-card">
        <div class="prow"><span class="k">Awareness</span><span class="v dim">ads &amp; stores make shoppers notice you</span></div>
        <div class="prow"><span class="k">Fit &amp; price</span><span class="v dim">right product, fair price → they buy</span></div>
        <div class="prow"><span class="k">CAC</span><span class="v dim">ad spend ÷ NEW customers it won</span></div>
        <div class="prow"><span class="k">Satisfaction</span><span class="v dim">45% on-time · 30% quality · 25% support</span></div>
        <div class="prow"><span class="k">Repeat orders</span><span class="v dim">happy customers reorder — that margin is LTV</span></div>
        <div class="prow"><span class="k">Margins</span><span class="v dim">dropship &lt; wholesale stock &lt; your own products</span></div>
      </div>`;
    this.panel.innerHTML = html;
  }

  // ================= GOALS (the road to $1B) =================
  renderGoals() {
    const s = this.s;
    const next = GOALS.find(g => !s.goalsDone.includes(g.id));
    const cal = calInfo(s);
    const daysIn = s.day - 2 * DAYS_PER_MONTH;
    let html = `<div class="ptitle">The road to $1B</div>`;
    if (s.won) {
      html += `<div class="card win-banner"><b>YOU WON.</b> ${fmtMoney(s.lifetime.revenue)} lifetime — the island is yours. Sandbox mode from here.</div>`;
    } else if (next) {
      html += `<div class="small-note">Every milestone pays out. $1M (the IPO) is the starting line — the win is <b>$1,000,000,000</b> lifetime revenue.</div>`;
    }
    html += goalLadder(s);
    html += `<div class="psub">Company history</div>
      <div class="prow"><span class="k">Founded</span><span class="v">${daysIn.toLocaleString()} days ago (year ${cal.year})</span></div>
      <div class="prow"><span class="k">Lifetime revenue</span><span class="v money">${fmtMoney(s.lifetime.revenue)}</span></div>
      <div class="prow"><span class="k">Orders shipped</span><span class="v">${s.lifetime.orders.toLocaleString()}</span></div>
      <div class="prow"><span class="k">Customers won</span><span class="v">${s.lifetime.customers.toLocaleString()}</span></div>
      <div class="prow"><span class="k">Marketing spent</span><span class="v">${fmtMoney(s.lifetime.mkt)}</span></div>
      ${s.debtInterestPaid ? `<div class="prow"><span class="k">Lost to overdraft interest</span><span class="v bad">${fmtMoney(s.debtInterestPaid)}</span></div>` : ''}`;
    if (s.questsDone.length < QUESTS.length) {
      html += `<div class="psub">First steps</div>` + QUESTS.map(q => {
        const done = s.questsDone.includes(q.id);
        return `<div class="quest-row ${done ? 'done' : ''}"><span class="q-check">${done ? '✓' : ''}</span><span class="q-desc">${esc(q.desc)}</span><span class="q-reward">${done ? 'paid' : '+' + fmtMoney(q.reward)}</span></div>`;
      }).join('');
    }
    this.panel.innerHTML = html;
  }

  // ================= EMPIRE (post-IPO scalers) =================
  renderEmpire() {
    const s = this.s;
    const ipo = s.goalsDone.includes('ipo');
    let html = `<div class="ptitle">Empire</div>`;

    if (!ipo) {
      const p = Math.min(100, s.lifetime.revenue / 1e6 * 100);
      html += `<div class="card locked-card">
        <div class="prow"><span class="k strong">Unlocks at IPO</span><span class="v">${fmtMoney(s.lifetime.revenue)} / $1.00M lifetime</span></div>
        <div class="progress"><div style="width:${p.toFixed(1)}%"></div></div>
        <div class="small-note tight">Ring the bell at $1M lifetime revenue: +$250k capital, and everything below opens up. The IPO is the starting line — the win is <b>$1B</b>.</div>
      </div>
      <div class="psub">What's coming</div>
      <div class="prow"><span class="k">Franchising</span><span class="v dim">stores open themselves, 8% royalty</span></div>
      <div class="prow"><span class="k">National campaigns</span><span class="v dim">island-wide awareness blitz</span></div>
      <div class="prow"><span class="k">Warehouse automation</span><span class="v dim">ship &amp; shelf capacity ×1.5–3.5</span></div>
      <div class="prow"><span class="k">Brand tiers</span><span class="v dim">price power — charge more, sell more</span></div>
      <div class="prow"><span class="k">Export contracts</span><span class="v dim">weekly overseas revenue via the port</span></div>
      <div class="prow"><span class="k">Rival acquisition</span><span class="v dim">at $10M — buy out a rival's region</span></div>`;
      this.panel.innerHTML = html;
      return;
    }

    // ---- franchising ----
    const franchises = s.premises.filter(p => p.franchise);
    const roy7 = s.history.slice(-7).reduce((a, r) => a + (r.franchiseRev || 0), 0);
    html += `<div class="card">
      <div class="prow"><span class="k strong">Franchising</span><span class="v ${s.franchising ? 'good' : 'dim'}">${s.franchising ? 'OPEN' : 'paused'}</span></div>
      <div class="small-note tight">Where the brand is loved (sat &gt; 72%, awareness &gt; 40%), entrepreneurs open stores for you: $15k fee each + 8% royalty on sales. No rent, no stocking — they run themselves.</div>
      <div class="prow"><span class="k">Franchises</span><span class="v">${franchises.length} / 40</span></div>
      ${roy7 > 0 ? `<div class="prow"><span class="k">Royalties (7d)</span><span class="v money">${fmtMoney(roy7)}</span></div>` : ''}
      <button class="btn ${s.franchising ? '' : 'green'}" data-act="franchise-toggle">${s.franchising ? 'Pause program' : 'Open franchise program'}</button>
    </div>`;

    // ---- national campaign ----
    const nc = s.activeEvents.find(e => e.key === 'national');
    html += `<div class="card">
      <div class="prow"><span class="k strong">National campaign</span><span class="v ${nc ? 'good' : ''}">${nc ? `LIVE — ${nc.daysLeft}d left` : fmtMoney(NATIONAL_CAMPAIGN.cost)}</span></div>
      <div class="small-note tight">${NATIONAL_CAMPAIGN.days} days of saturation: island-wide awareness surge and demand +12%. Also keeps analysts from calling you complacent.</div>
      <button class="btn amber-btn ${nc ? 'live' : ''}" data-act="national" ${nc ? 'disabled' : ''}>${nc ? 'Campaign running' : `Launch (${fmtMoney(NATIONAL_CAMPAIGN.cost)})`}</button>
    </div>`;

    // ---- automation (COO-gated) ----
    const hasCoo = s.execs.some(e => e.role === 'coo');
    const autoTier = AUTOMATION_TIERS[s.automation];
    html += `<div class="card">
      <div class="prow"><span class="k strong">Warehouse automation</span><span class="v">${s.automation > 0 ? `${AUTOMATION_TIERS[s.automation - 1].name} (×${AUTOMATION_TIERS[s.automation - 1].mult})` : 'none'}</span></div>
      <div class="small-note tight">Multiplies ship capacity AND store-shelf logistics. ${hasCoo ? '' : '<span class="bad">Robots need a COO to run them — hire one in Staff.</span>'}</div>
      ${autoTier
        ? `<button class="btn ${hasCoo ? 'green' : ''}" data-act="automation">Install ${autoTier.name} — ×${autoTier.mult} (${fmtMoney(autoTier.cost)})</button>`
        : '<div class="small-note tight good">Fully automated — the warehouse hums at 3am.</div>'}
    </div>`;

    // ---- brand tiers ----
    const brandTier = BRAND_TIERS[s.brandTier];
    html += `<div class="card">
      <div class="prow"><span class="k strong">Brand</span><span class="v">${s.brandTier > 0 ? BRAND_TIERS[s.brandTier - 1].name : 'no premium label'}</span></div>
      <div class="small-note tight">Price power: each tier raises perceived fair value +6%, product appeal +4% and export revenue +10%. Shoppers stop asking about the price.</div>
      ${brandTier
        ? `<button class="btn green" data-act="brand">Ascend to ${brandTier.name} (${fmtMoney(brandTier.cost)})</button>`
        : '<div class="small-note tight good">Icon Status — the brand is the product.</div>'}
    </div>`;

    // ---- export contract ----
    const ec = s.exportContract;
    if (!ec) {
      html += `<div class="card">
        <div class="prow"><span class="k strong">Export contract</span><span class="v dim">not signed</span></div>
        <div class="small-note tight">Needs the port, at least one product of your own (R&amp;D), and satisfaction ≥ 70%. A freighter then leaves weekly with ~${fmtMoney(EXPORT_LEVELS[0].perShipment)} of goods (quality &amp; reputation adjust it).</div>
        <button class="btn green" data-act="export">Sign contract (${fmtMoney(EXPORT_LEVELS[0].cost)})</button>
      </div>`;
    } else {
      const nextL = EXPORT_LEVELS[ec.level];
      const since = s.day - (ec.lastUpgradeDay ?? s.day);
      const staleMult = Math.max(0.25, 1 - 0.004 * Math.max(0, since - 180));
      const lastShip = [...s.history].reverse().find(r => r.exportRev > 0);
      html += `<div class="card ${staleMult < 1 ? 'stale' : ''}">
        <div class="prow"><span class="k strong">Export contract</span><span class="v">tier ${ec.level} / ${EXPORT_LEVELS.length}</span></div>
        <div class="prow"><span class="k">Base shipment</span><span class="v money">${fmtMoney(EXPORT_LEVELS[ec.level - 1].perShipment)}/week</span></div>
        ${lastShip ? `<div class="prow"><span class="k">Last shipment booked</span><span class="v">${fmtMoney(lastShip.exportRev)}</span></div>` : ''}
        <div class="prow"><span class="k">Next freighter</span><span class="v">${Math.max(0, ec.nextShipDay - s.day)}d</span></div>
        ${staleMult < 1
          ? `<div class="small-note tight bad">Contracts are going stale — partners renegotiate around you. Currently earning ×${staleMult.toFixed(2)}. Upgrade to reset.</div>`
          : since > 120 ? `<div class="small-note tight">Contracts start eroding ${180 - since} days from now — keep investing.</div>` : ''}
        ${nextL
          ? `<button class="btn green" data-act="export">Expand to tier ${ec.level + 1} — ${fmtMoney(nextL.perShipment)}/week (${fmtMoney(nextL.cost)})</button>`
          : `<button class="btn" data-act="export">Renegotiate — reset staleness (${fmtMoney(Math.round(EXPORT_LEVELS[EXPORT_LEVELS.length - 1].cost * 0.1))})</button>`}
      </div>`;
    }

    // ---- rival acquisition ($10M unlock) ----
    const acqDone = s.goalsDone.includes('acquire');
    if (s.acquiredRival) {
      const rv = RIVALS.find(r => r.id === s.acquiredRival);
      html += `<div class="card">
        <div class="prow"><span class="k strong">Acquisition</span><span class="v good">done</span></div>
        <div class="small-note tight">You absorbed ${rivalEmblem(s.acquiredRival)}<b>${esc(rv ? rv.name : s.acquiredRival)}</b>'s regional operations. Regulators would block a second bite.</div>
      </div>`;
    } else if (!acqDone) {
      const p10 = Math.min(100, s.lifetime.revenue / 1e7 * 100);
      html += `<div class="card locked-card">
        <div class="prow"><span class="k strong">Rival acquisition</span><span class="v">${fmtMoney(s.lifetime.revenue)} / $10.0M</span></div>
        <div class="progress"><div style="width:${p10.toFixed(1)}%"></div></div>
        <div class="small-note tight">At $10M lifetime revenue the bankers will let you buy a rival's regional ops (${fmtMoney(ACQUISITION_COST)}): its presence collapses in its 2 strongest markets and you inherit a store in each.</div>
      </div>`;
    } else {
      const targets = s.rivals.filter(a => a.active);
      html += `<div class="card">
        <div class="prow"><span class="k strong">Acquire a rival's regional ops</span><span class="v money">${fmtMoney(ACQUISITION_COST)}</span></div>
        <div class="small-note tight">One shot, ever: their presence collapses (×0.15) in their 2 strongest markets and you gain a level-1 store in each, overnight.</div>
        <div class="btn-row">
        ${targets.map(a => {
          const rv = RIVALS.find(r => r.id === a.id);
          return `<button class="btn" data-acquire="${a.id}">${rivalEmblem(a.id)}Buy out ${esc(rv.name)}</button>`;
        }).join('')}
        </div>
      </div>`;
    }

    this.panel.innerHTML = html;
    this.panel.querySelector('[data-act=franchise-toggle]')?.addEventListener('click', () => this.act(() => setFranchising(this.s, !this.s.franchising)));
    this.panel.querySelector('[data-act=national]')?.addEventListener('click', () => {
      const r = this.act(() => startNationalCampaign(this.s));
      if (r.ok) this.game.jukebox.sfx('goal');
    });
    this.panel.querySelector('[data-act=automation]')?.addEventListener('click', () => {
      const r = this.act(() => buyAutomation(this.s));
      if (r.ok) this.game.jukebox.sfx('goal');
    });
    this.panel.querySelector('[data-act=brand]')?.addEventListener('click', () => {
      const r = this.act(() => buyBrandTier(this.s));
      if (r.ok) this.game.jukebox.sfx('goal');
    });
    this.panel.querySelector('[data-act=export]')?.addEventListener('click', () => {
      const r = this.act(() => upgradeExport(this.s));
      if (r.ok) this.game.jukebox.sfx('goal');
    });
    this.panel.querySelectorAll('[data-acquire]').forEach(b => b.addEventListener('click', () => {
      const r = this.act(() => acquireRivalOps(this.s, b.dataset.acquire));
      if (r.ok) this.game.jukebox.sfx('goal');
    }));
  }

  // ================= modals =================
  modal(html, opts = {}) {
    const root = document.getElementById('modal-root');
    const box = document.getElementById('modal-box');
    box.classList.toggle('splash-box', !!opts.splash);
    box.innerHTML = html;
    root.classList.remove('hidden');
    this.game.pauseForModal(true);
    const close = () => {
      root.classList.add('hidden');
      this.game.pauseForModal(false);
      window.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    if (!opts.noClose) {
      root.onclick = (e) => { if (e.target === root) close(); };
      window.addEventListener('keydown', onKey);
      const x = document.createElement('button');
      x.className = 'modal-x';
      x.textContent = '';
      x.addEventListener('click', close);
      box.appendChild(x);
    } else root.onclick = null;
    return close;
  }

  modalCatalog() {
    const s = this.s;
    const avail = catalogAvailable(s);
    const close = this.modal(`
      <h2>Shopify Catalog</h2>
      <p class="small-note">Catalog products can start selling online today: orders dropship automatically (no inventory, but a hefty per-unit cut). Order wholesale cases later for a much better unit price — stocked units ship online <i>and</i> fill store shelves. $500 listing fee each. The "loved by" chips show who buys it — match them to what your surveyed towns look like.</p>
      <div class="filter-row">
        <select id="cat-filter"><option value="">All categories</option>
        ${Object.entries(CATEGORIES).map(([k, c]) => `<option value="${k}">${c.name}</option>`).join('')}</select>
      </div>
      <div class="catalog-grid" id="cat-grid"></div>
    `);
    const grid = document.getElementById('cat-grid');
    const renderGrid = (filter) => {
      const items = avail.filter(c => !filter || c.cat === filter);
      grid.innerHTML = items.map(c => `
        <div class="card cat-card">
          <div class="prod-img">${prodImg({ id: c.id, cat: c.cat })}</div>
          <div class="prod-info">
            <div class="prod-name">${esc(c.name)}</div>
            <span class="prod-cat" style="--chip:${CATEGORIES[c.cat].color}">${CATEGORIES[c.cat].name}</span>
            <div class="small-note tight">dropship $${(c.cost * DROPSHIP_MARKUP).toFixed(2)} · wholesale $${(c.cost * 1.15).toFixed(2)} · MSRP $${c.msrp}${c.season ? ' · ' + c.season : ''}</div>
            <div class="prod-attrs">${pips('STY', c.style)} ${pips('QUA', c.quality)}</div>
            ${segChips({ ...c, price: c.msrp })}
            <button class="btn small green" data-source="${c.id}">Source $500</button>
          </div>
        </div>`).join('') || '<p class="small-note">Nothing left in this category.</p>';
      grid.querySelectorAll('[data-source]').forEach(b => b.addEventListener('click', () => {
        const r = addCatalogProduct(s, b.dataset.source);
        this.game.jukebox.sfx(r.ok ? 'kaching' : 'bad');
        if (!r.ok) { this.flashNote(r.msg); return; }
        close();
        this.renderPanel(true);
      }));
    };
    renderGrid('');
    document.getElementById('cat-filter').addEventListener('change', (e) => renderGrid(e.target.value));
  }

  modalRnd() {
    const s = this.s;
    let cat = 'gadgets', tier = 'standard', focus = 0.5;
    const close = this.modal(`
      <h2>R&amp;D Lab</h2>
      <p class="small-note">Develop your own product: ~65-75% margins vs ~40% on catalog items, but you'll pay up front, wait for development, and hold inventory. ${s.staff.engineer} engineer${s.staff.engineer === 1 ? '' : 's'} on staff (+${Math.round(s.staff.engineer * 45)}% speed).</p>
      <h3>Category</h3>
      <div class="choice-grid" id="rnd-cats">
        ${Object.entries(CATEGORIES).map(([k, c]) => `<button class="choice-card ${k === cat ? 'selected' : ''}" data-cat="${k}"><div class="cc-title">${c.name}</div></button>`).join('')}
      </div>
      <h3>Ambition</h3>
      <div class="choice-grid three" id="rnd-tiers">
        ${Object.entries(RND_TIERS).map(([k, t]) => `<button class="choice-card ${k === tier ? 'selected' : ''}" data-tier="${k}">
          <div class="cc-title">${t.name}</div>
          <div class="cc-desc">~${t.days}d base</div>
          <div class="cc-cost">${fmtMoney(t.cost)}</div>
        </button>`).join('')}
      </div>
      <h3>Design focus</h3>
      <div class="focus-row">
        <span class="dim">Practical</span>
        <input type="range" id="rnd-focus" min="0" max="100" value="50">
        <span class="dim">Stylish</span>
      </div>
      <div class="modal-btns">
        <button class="btn" id="rnd-cancel">Cancel</button>
        <button class="btn green" id="rnd-go">Start project</button>
      </div>
    `);
    document.getElementById('rnd-cats').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cat]'); if (!b) return;
      cat = b.dataset.cat;
      document.querySelectorAll('#rnd-cats .choice-card').forEach(x => x.classList.toggle('selected', x.dataset.cat === cat));
    });
    document.getElementById('rnd-tiers').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tier]'); if (!b) return;
      tier = b.dataset.tier;
      document.querySelectorAll('#rnd-tiers .choice-card').forEach(x => x.classList.toggle('selected', x.dataset.tier === tier));
    });
    document.getElementById('rnd-focus').addEventListener('input', (e) => { focus = e.target.value / 100; });
    document.getElementById('rnd-cancel').addEventListener('click', close);
    document.getElementById('rnd-go').addEventListener('click', () => {
      const r = startRnd(s, cat, tier, focus);
      this.game.jukebox.sfx(r.ok ? 'build' : 'bad');
      if (!r.ok) { this.flashNote(r.msg); return; }
      close(); this.renderPanel(true);
    });
  }

  // settlement inspector — the map click hub
  modalSettlement(st) {
    const s = this.s;
    const hasStore = s.premises.some(p => p.kind === 'store' && p.sid === st.id);
    const hasWh = s.premises.some(p => (p.kind === 'warehouse' || p.kind === 'office') && p.sid === st.id);
    const storeCost = PREMISE_COSTS.store[st.type];
    const whCost = PREMISE_COSTS.warehouse[st.type];
    const surveyCost = st.type === 'city' ? 1200 : st.type === 'town' ? 700 : 400;
    const blitz = s.rivalPromo?.sid === st.id;
    const grew = st.grewTick != null && s.day - st.grewTick < 90;
    const shrunk = st.shrunkTick != null && s.day - st.shrunkTick < 90;
    const execsHere = s.execs.filter(e => e.sid === st.id);
    const execsInbound = s.execTravels.filter(t => t.sid === st.id);
    const sendable = s.execs.filter(e => e.sid !== st.id && !s.execTravels.some(t => t.execId === e.id));
    const close = this.modal(`
      <h2>${esc(st.name)}</h2>
      <div class="prow"><span class="k">Population</span><span class="v">${st.pop.toLocaleString()} (${st.type})${grew ? ' <span class="good">growing</span>' : shrunk ? ' <span class="bad">shrinking</span>' : ''}</span></div>
      <div class="prow"><span class="k">Brand awareness</span><span class="v">${pct(st.awareness)}</span></div>
      <div class="prow"><span class="k">Your customers</span><span class="v">${st.customers.toLocaleString()}</span></div>
      ${this.compBlock(st)}
      ${blitz ? `<div class="prow"><span class="k"></span><span class="v">${rivalEmblem(s.rivalPromo.rival)}<span class="bad">PROMO BLITZ — ${s.rivalPromo.daysLeft}d</span></span></div>` : ''}
      ${execsHere.length ? `<div class="prow"><span class="k">Executives here</span><span class="v">${execsHere.map(e => `${EXEC_ROLES[e.role].name} ${esc(e.name)}`).join(' · ')}</span></div>` : ''}
      ${execsInbound.length ? `<div class="prow"><span class="k">Inbound</span><span class="v cyan">${execsInbound.map(t => `${EXEC_ROLES[t.role].name} ${esc(t.name)} — ${t.daysLeft}d`).join(' · ')}</span></div>` : ''}
      ${st.researched ? `
        ${segBar(st.segments)}
        <div class="seg-legend">${Object.entries(st.segments).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
          `<span><span class="seg-dot" style="background:${SEGMENTS[k].color}"></span>${SEGMENTS[k].name} ${pct(v)}</span>`).join('')}</div>
        <div class="prow"><span class="k">Online affinity</span><span class="v">${pct(st.onlineAffinity)}</span></div>
      ` : `<p class="small-note">Shopper segments unknown — run a survey to reveal who lives here.</p>`}
      ${s.surveys.some(x => x.sid === st.id) ? `<p class="small-note">A researcher is on their way here.</p>` : ''}
      ${sendable.length ? `<div class="exec-send"><span class="dim">Station an exec here:</span> ${sendable.map(e => `<button class="btn small" data-send-exec="${e.id}" title="${esc(EXEC_ROLES[e.role].desc)}">${EXEC_ROLES[e.role].name} ${esc(e.name)}</button>`).join(' ')}</div>` : ''}
      <div class="modal-btns wrap">
        ${!st.researched && !s.surveys.some(x => x.sid === st.id) ? `<button class="btn" id="ins-survey">Survey (${fmtMoney(surveyCost)})</button>` : ''}
        ${!hasStore ? `<button class="btn green" id="ins-store">Open store (${fmtMoney(storeCost.setup)} + ${fmtMoney(storeCost.rent)}/d, ${storeCost.days}d build)</button>` : ''}
        ${!hasWh ? `<button class="btn" id="ins-wh">Build warehouse (${fmtMoney(whCost.setup)} + ${fmtMoney(whCost.rent)}/d, ${whCost.days}d build)</button>` : ''}
        <button class="btn" id="ins-close">Close</button>
      </div>
    `);
    document.getElementById('ins-close').addEventListener('click', close);
    document.getElementById('ins-survey')?.addEventListener('click', () => { this.act(() => researchSettlement(s, st.id)); close(); this.modalSettlement(st); });
    document.getElementById('ins-store')?.addEventListener('click', () => { this.act(() => openStore(s, st.id)); close(); });
    document.getElementById('ins-wh')?.addEventListener('click', () => { this.act(() => buildWarehouse(s, st.id)); close(); });
    document.querySelectorAll('#modal-box [data-send-exec]').forEach(b =>
      b.addEventListener('click', () => { this.act(() => assignExec(s, b.dataset.sendExec, st.id)); close(); }));
  }

  modalGameOver() {
    const s = this.s;
    this.modal(`
      <h2 class="bad">Bankrupt</h2>
      <p>The overdraft sank below <b>−$50,000</b> and the bank called in everything. ${esc(s.companyName)} is no more.</p>
      <p class="small-note">Lifetime: ${fmtMoney(s.lifetime.revenue)} revenue · ${s.lifetime.orders.toLocaleString()} orders · ${s.lifetime.customers.toLocaleString()} customers${s.debtInterestPaid ? ` · ${fmtMoney(s.debtInterestPaid)} lost to overdraft interest` : ''}.</p>
      <div class="modal-btns"><button class="btn green" id="go-restart">Start over</button></div>
    `, { noClose: true });
    document.getElementById('go-restart').addEventListener('click', () => this.game.restart());
  }

  // IPO is a milestone, not the win — the win is modalWin() at $1B.
  modalIpo() {
    const art = eventImage('ipo');
    this.modal(`
      ${art ? `<div class="event-art" style="background-image:url('${art}')"></div>` : ''}
      <h2 class="amber">IPO DAY</h2>
      <p>${esc(this.s.companyName)} rings the bell — $1,000,000 in lifetime revenue, and <b class="green">+$250,000</b> of fresh capital lands in the account.</p>
      <p>Don't celebrate too long: this is the <b>starting line</b>. The <b>Empire</b> tab just unlocked — franchising, national campaigns, warehouse automation, brand tiers and export contracts. The rivals get meaner from here, and the road ends at <b class="amber">$1,000,000,000</b>.</p>
      <div class="modal-btns"><button class="btn green" id="ipo-continue">Open the Empire tab →</button></div>
    `, { noClose: true });
    document.getElementById('ipo-continue').addEventListener('click', () => {
      document.getElementById('modal-root').classList.add('hidden');
      this.game.pauseForModal(false);
      document.querySelector('[data-tab=empire]')?.click();
    });
  }

  // THE WIN — $1B lifetime revenue. Game keeps running (sandbox).
  modalWin() {
    const s = this.s;
    const art = (ART.events && ART.events['ipo-bell']) || eventImage('ipo');
    const days = Math.max(1, (s.wonDay ?? s.day) - 2 * DAYS_PER_MONTH); // founded on day 56
    const years = Math.floor(days / (12 * DAYS_PER_MONTH));
    const stores = s.premises.filter(p => p.kind === 'store' && !p.franchise).length;
    const franchises = s.premises.filter(p => p.franchise).length;
    const employees = staffCount(s) + Math.max(0, s.execs.length - 1);
    const customers = s.world.settlements.reduce((a, x) => a + x.customers, 0);
    try { this.game.renderer.celebrate?.(s.hq); } catch (e) { /* renderer optional */ }
    this.game.jukebox.sfx('goal');
    this.modal(`
      ${art ? `<div class="event-art win-art" style="background-image:url('${art}')"></div>` : ''}
      <h2 class="win-title">ONE BILLION DOLLARS</h2>
      <p class="win-sub">${esc(s.companyName)} — from a garage that smelled like cardboard to a ${fmtMoney(s.lifetime.revenue)} empire. The island will never be the same.</p>
      <div class="win-stats">
        <div class="win-stat"><div class="ws-val">${days.toLocaleString()}</div><div class="ws-label">days in business${years > 0 ? ` (~${years}y)` : ''}</div></div>
        <div class="win-stat"><div class="ws-val money">${fmtMoney(s.lifetime.revenue)}</div><div class="ws-label">lifetime revenue</div></div>
        <div class="win-stat"><div class="ws-val">${s.lifetime.orders.toLocaleString()}</div><div class="ws-label">orders shipped</div></div>
        <div class="win-stat"><div class="ws-val">${customers.toLocaleString()}</div><div class="ws-label">customers</div></div>
        <div class="win-stat"><div class="ws-val">${stores}</div><div class="ws-label">stores</div></div>
        <div class="win-stat"><div class="ws-val">${franchises}</div><div class="ws-label">franchises</div></div>
        <div class="win-stat"><div class="ws-val">${employees}</div><div class="ws-label">employees</div></div>
        <div class="win-stat"><div class="ws-val">${s.premises.filter(p => p.kind === 'warehouse').length}</div><div class="ws-label">warehouses</div></div>
      </div>
      <p class="small-note">The trillion-dollar track stretches ahead. The simulation keeps running — sandbox from here on out.</p>
      <div class="modal-btns"><button class="btn green" id="win-continue">Keep playing</button></div>
    `, { noClose: true });
    document.getElementById('win-continue').addEventListener('click', () => {
      document.getElementById('modal-root').classList.add('hidden');
      this.game.pauseForModal(false);
    });
  }

  // ================= helpers =================
  act(fn) {
    const r = fn();
    this.game.jukebox.sfx(r.ok ? 'build' : 'bad');
    if (!r.ok && r.msg) this.flashNote(r.msg);
    // instant quest feedback on player actions
    checkQuests(this.s);
    if (this.s.pendingQuest) { const q = this.s.pendingQuest; this.s.pendingQuest = null; this.showQuest(q); }
    this.renderPanel(true);
    this.renderTop();
    return r;
  }

  flashNote(msg) {
    const el = document.getElementById('goal-toast');
    el.className = 'toast red-toast';
    retoast(el);
    el.innerHTML = `<div class="toast-title">${esc(msg)}</div>`;
    clearTimeout(this._noteT);
    this._noteT = setTimeout(() => fadeToast(el), 2200);
  }

  showEvent(ev) {
    const el = document.getElementById('event-banner');
    const art = eventImage(ev);
    el.innerHTML = `${art ? `<div class="eb-art" style="background-image:url('${art}')"></div>` : ''}
      <div class="eb-body">
        <div class="eb-head"><div><div class="eb-name">${esc(ev.name)}</div><div class="eb-days">${ev.days} days</div></div></div>
        ${ev.desc ? `<div class="eb-desc">${esc(ev.desc)}</div>` : ''}
      </div>`;
    el.classList.remove('hidden');
    retoast(el);
    clearTimeout(this._evT);
    this._evT = setTimeout(() => fadeToast(el), 5000);
  }

  showQuest(q) {
    const el = document.getElementById('goal-toast');
    el.className = 'toast green-toast';
    retoast(el);
    el.innerHTML = `<div class="toast-title">${esc(q.name)} ✓</div><div class="toast-sub amber">+${fmtMoney(q.reward)}</div>`;
    this.game.jukebox.sfx('goal');
    clearTimeout(this._noteT);
    this._noteT = setTimeout(() => fadeToast(el), 2800);
  }

  showGoal(goal) {
    const el = document.getElementById('goal-toast');
    el.className = 'toast amber-toast';
    retoast(el);
    el.innerHTML = `<div class="toast-title">GOAL: ${esc(goal.name)}</div>${goal.reward ? `<div class="toast-sub green">+${fmtMoney(goal.reward)} bonus</div>` : ''}`;
    this.game.jukebox.sfx('goal');
    clearTimeout(this._noteT);
    this._noteT = setTimeout(() => fadeToast(el), 3500);
  }
}

// restart the slide-in animation when a toast re-fires
function retoast(el) {
  clearTimeout(el._byeT);
  el.classList.remove('bye');
  el.style.animation = 'none';
  void el.offsetWidth; // reflow
  el.style.animation = '';
}

// soft slide+fade out before hiding (CSS .bye handles the motion)
function fadeToast(el) {
  el.classList.add('bye');
  clearTimeout(el._byeT);
  el._byeT = setTimeout(() => { el.classList.remove('bye'); el.classList.add('hidden'); }, 260);
}

// ---------- tiny helpers ----------
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function pct(x) { return Math.round(x * 100) + '%'; }

function prodImg(p) {
  const src = productImage(p);
  if (src) return `<img src="${src}" alt="" loading="lazy">`;
  const cat = CATEGORIES[p.cat];
  return `<span class="prod-img-ph" style="background:${cat ? cat.color : 'var(--stroke-strong)'}"></span>`;
}

function rivalEmblem(id) {
  const src = rivalImage(id);
  const rival = RIVALS.find(r => r.id === id);
  return src ? `<img class="rival-emblem" src="${src}" alt="${rival ? esc(rival.name) : ''}" title="${rival ? esc(rival.name) : ''}"> ` : '';
}

function segBar(segments) {
  return `<div class="seg-bar">` +
    Object.entries(segments).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
      `<div style="width:${(v * 100).toFixed(1)}%;background:${SEGMENTS[k].color}" title="${SEGMENTS[k].name} ${pct(v)}"></div>`).join('') +
    `</div>`;
}

function tile(label, value, cls = '', delta = '', deltaCls = '') {
  return `<div class="tile"><div class="t-label">${label}</div><div class="t-value ${cls}">${value}</div>${delta ? `<div class="t-delta ${deltaCls}">${delta}</div>` : ''}</div>`;
}

// one advisor tip → card (sev drives the accent color)
const SEV_LABEL = { urgent: 'FIX NOW', warn: 'ATTENTION', tip: 'TIP' };
function tipCard(t) {
  const who = ADVISOR_INFO[t.who] || { name: t.who, icon: '💡' };
  return `<div class="card tip-card sev-${t.sev}">
    <div class="tip-head">
      <span class="tip-icon">${who.icon}</span>
      <span class="tip-title">${esc(t.title)}</span>
      <span class="tip-sev">${SEV_LABEL[t.sev] || ''}</span>
    </div>
    <div class="tip-body">${esc(t.body)}</div>
    <div class="tip-foot"><span class="tip-who">${esc(who.name)}</span>
      ${t.tab ? `<button class="btn small" data-goto="${t.tab}">Go →</button>` : ''}</div>
  </div>`;
}

// dashboard headline: the advisors' top concerns (urgent/warn only)
function advisorStrip(s) {
  const top = advisorTips(s).filter(t => t.sev !== 'tip').slice(0, 2);
  if (!top.length) return '';
  return `<div class="advisor-strip">
    ${top.map(t => `<div class="as-row sev-${t.sev}">
      <span class="tip-icon">${(ADVISOR_INFO[t.who] || {}).icon || '💡'}</span>
      <span class="as-text"><b>${esc(t.title)}</b></span>
      ${t.tab ? `<button class="btn small" data-goto="${t.tab}">Fix</button>` : ''}
    </div>`).join('')}
    <button class="as-more" data-goto="advisors">All advice →</button>
  </div>`;
}

// dashboard footer: compact pointer at the next milestone (full ladder lives
// in the Goals tab)
function nextGoalRow(s) {
  const next = GOALS.find(g => !s.goalsDone.includes(g.id));
  if (!next) return '';
  const thr = REV_GOALS[next.id];
  const p = thr ? Math.min(100, s.lifetime.revenue / thr * 100) : null;
  return `<div class="psub">Next milestone</div>
    <div class="card next-goal">
      <div class="prow"><span class="k strong">→ ${esc(next.name)}</span>
        ${next.reward ? `<span class="v amber">+${fmtMoney(next.reward)}</span>` : ''}</div>
      <div class="small-note tight">${esc(next.desc)}</div>
      ${p != null ? `<div class="progress goal-progress"><div style="width:${p.toFixed(1)}%"></div></div>
      <div class="ladder-progress-label">${fmtMoney(s.lifetime.revenue)} / ${fmtMoney(thr)} lifetime revenue</div>` : ''}
      <button class="btn small" data-goto="goals">The road to $1B →</button>
    </div>`;
}

// which segments love this product — colored chips for the top fits
function segChips(p, n = 2) {
  const fits = segmentFit(p).slice(0, n).filter(x => x.rel > 0.25);
  if (!fits.length) return '';
  return `<div class="seg-chips" title="Which shopper segments this appeals to most">loved by ${fits.map(x =>
    `<span class="seg-chip" style="--seg:${x.color}">${esc(x.name)}</span>`).join(' ')}</div>`;
}

// the "road to $1B" ladder — next goal highlighted, revenue goals get a
// lifetime-revenue progress bar
const REV_GOALS = { ipo: 1e6, acquire: 1e7, empire: 1e8, billion: 1e9 };
function goalLadder(s) {
  const next = GOALS.find(g => !s.goalsDone.includes(g.id));
  return GOALS.map(g => {
    const done = s.goalsDone.includes(g.id);
    const isNext = next && g.id === next.id;
    const thr = REV_GOALS[g.id];
    let bar = '';
    if (isNext && thr) {
      const p = Math.min(100, s.lifetime.revenue / thr * 100);
      bar = `<div class="progress goal-progress"><div style="width:${p.toFixed(1)}%"></div></div>
        <div class="ladder-progress-label">${fmtMoney(s.lifetime.revenue)} / ${fmtMoney(thr)} lifetime revenue</div>`;
    }
    return `<div class="ladder-row ${done ? 'done' : ''} ${isNext ? 'next' : ''}">
      <span class="ladder-check">${done ? '✓' : isNext ? '→' : ''}</span>
      <span class="ladder-body">
        <span class="ladder-name">${esc(g.name)}</span>
        ${done ? '' : `<span class="ladder-desc">${esc(g.desc)}</span>`}
        ${bar}
      </span>
      ${g.reward ? `<span class="ladder-reward ${done ? 'dim' : 'amber'}">${done ? 'paid' : '+' + fmtMoney(g.reward)}</span>` : ''}
    </div>`;
  }).join('');
}

function pips(label, v) {
  const n = Math.max(0, Math.min(5, Math.round(v * 5)));
  let dots = '';
  for (let i = 0; i < 5; i++) dots += `<i class="${i < n ? 'on' : ''}"></i>`;
  return `<span class="attr-bar">${label}<span class="attr-pips">${dots}</span></span>`;
}

function fmtShort(n) {
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(Math.round(n));
}

function chartBox(title, svg, maxLabel) {
  return `<div class="chart-box"><div class="chart-head"><span>${title}</span><span class="chart-max">${maxLabel || ''}</span></div>${svg}</div>`;
}

// smooth line + soft area fill (revenue / customers)
function sparkLine(data, color, h = 44) {
  if (!data.length) return `<div class="chart-empty">no data yet</div>`;
  const w = 320;
  const max = Math.max(...data, 1);
  const n = data.length;
  const step = n > 1 ? w / (n - 1) : w;
  const pt = (v, i) => `${(i * step).toFixed(1)},${(h - 2 - (Math.max(0, v) / max) * (h - 8)).toFixed(1)}`;
  const pts = data.map((v, i) => pt(v, i));
  if (n === 1) pts.push(pt(data[0], 1));
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <path d="M0,${h} L${pts.join(' L')} L${w},${h} Z" fill="${color}" opacity="0.13"/>
    <polyline points="${pts.join(' ')}" pathLength="600" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
  </svg>`;
}

// signed bar chart around a zero midline (daily profit)
function sparkSigned(data, h = 56) {
  if (!data.length) return `<div class="chart-empty">no data yet</div>`;
  const w = 320;
  const maxAbs = Math.max(...data.map(Math.abs), 1);
  const mid = h / 2;
  const bw = w / Math.max(data.length, 30);
  let bars = '';
  data.forEach((v, i) => {
    const bh = Math.max(0.8, Math.abs(v) / maxAbs * (mid - 3));
    const y = v >= 0 ? mid - bh : mid;
    bars += `<rect x="${(i * bw).toFixed(2)}" y="${y.toFixed(2)}" width="${Math.max(0.8, bw - 0.7).toFixed(2)}" height="${bh.toFixed(2)}" fill="${v >= 0 ? 'var(--green)' : 'var(--danger)'}" opacity="${v >= 0 ? 0.9 : 0.85}"/>`;
  });
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    ${bars}
    <line x1="0" y1="${mid}" x2="${w}" y2="${mid}" stroke="rgba(255,255,255,.18)" stroke-width="1" vector-effect="non-scaling-stroke"/>
  </svg>`;
}
