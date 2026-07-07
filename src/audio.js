// WebAudio generative jukebox — warm lo-fi / synthwave-lite, no samples.
// Layered detuned pads, sine sub-bass, swung filtered-noise percussion,
// feedback delay + generated-impulse reverb, gentle master lowpass.
// Public API (unchanged): class Jukebox — .enabled, .trackIndex, .trackName,
// .trackCount, .start(), .stop(), .toggle(), .nextTrack(), .sfx(name).

const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12); // midi → Hz

// Each track: key/tempo/mood. Melodies + rhythm variation are generated on
// the fly so tracks loop without being loops.
const TRACKS = [
  {
    // Mellow, dusty, head-nod. C major with a lydian shimmer in the pads.
    name: 'Garage Days', bpm: 84, root: 60,
    scale: [0, 2, 4, 7, 9, 11],
    chords: [[0, 4, 7, 11], [-3, 0, 4, 7], [5, 9, 12, 16], [-5, -1, 2, 7]],
    padWave: 'sawtooth', leadWave: 'triangle', bassWave: 'sine',
    swing: 0.28, density: 0.30, hatDensity: 0.55, cutoff: 1500,
    padVol: 0.055, kick: [0, 10], snare: [8], energy: 0.7,
  },
  {
    // Upbeat, optimistic. G mixolydian, bouncier drums, busier lead.
    name: 'Growth Loop', bpm: 106, root: 55,
    scale: [0, 2, 4, 5, 7, 9, 10],
    chords: [[0, 4, 7, 10], [5, 9, 12], [-2, 2, 5, 9], [3, 7, 10, 14]],
    padWave: 'sawtooth', leadWave: 'triangle', bassWave: 'sine',
    swing: 0.18, density: 0.50, hatDensity: 0.85, cutoff: 2100,
    padVol: 0.05, kick: [0, 6, 10], snare: [4, 12], energy: 1.0,
  },
  {
    // Moody late-night drift. A minor, slow, sparse, long reverb tails.
    name: 'Night Shift', bpm: 74, root: 57,
    scale: [0, 3, 5, 7, 10],
    chords: [[0, 3, 7, 10], [-4, 0, 3, 7], [-2, 2, 5, 8], [-4, 0, 3, 10]],
    padWave: 'triangle', leadWave: 'sine', bassWave: 'sine',
    swing: 0.32, density: 0.22, hatDensity: 0.35, cutoff: 1100,
    padVol: 0.075, kick: [0], snare: [8], energy: 0.55,
  },
  {
    // Triumphant, widescreen. D major, driving, brightest filter.
    name: 'IPO Eve', bpm: 118, root: 62,
    scale: [0, 2, 4, 5, 7, 9, 11],
    chords: [[0, 4, 7, 12], [-3, 0, 4, 9], [-7, -3, 0, 5], [-5, -1, 2, 7]],
    padWave: 'sawtooth', leadWave: 'triangle', bassWave: 'triangle',
    swing: 0.10, density: 0.55, hatDensity: 0.9, cutoff: 2600,
    padVol: 0.05, kick: [0, 4, 8, 12], snare: [4, 12], energy: 1.15,
  },
];

const STEPS_PER_BAR = 16; // 16th-note grid

export class Jukebox {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.trackIndex = 0;
    this.step = 0;
    this.timer = null;
    this.master = null;
    this.rand = Math.random;
    this._mel = 0;
  }
  get trackName() { return TRACKS[this.trackIndex].name; }
  get trackCount() { return TRACKS.length; }

  _ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this._buildGraph();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  // Persistent node graph, built once:
  //   music/sfx buses → master gain → gentle lowpass → soft compressor → out
  //   sends: feedback ping-pong delay, convolver reverb (generated impulse)
  _buildGraph() {
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass'; tone.frequency.value = 9500; tone.Q.value = 0.4;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20; comp.knee.value = 24;
    comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.25;
    this.master.connect(tone); tone.connect(comp); comp.connect(ctx.destination);

    this.musicBus = ctx.createGain(); this.musicBus.gain.value = 0.2;
    this.sfxBus = ctx.createGain(); this.sfxBus.gain.value = 0.12;
    this.musicBus.connect(this.master);
    this.sfxBus.connect(this.master);

    // Feedback ping-pong delay (dotted-8th feel, retuned per track).
    this.delayL = ctx.createDelay(1.5);
    this.delayR = ctx.createDelay(1.5);
    const fbL = ctx.createGain(); fbL.gain.value = 0.32;
    const fbR = ctx.createGain(); fbR.gain.value = 0.32;
    const dampL = ctx.createBiquadFilter(); dampL.type = 'lowpass'; dampL.frequency.value = 3200;
    const dampR = ctx.createBiquadFilter(); dampR.type = 'lowpass'; dampR.frequency.value = 3200;
    const panL = ctx.createStereoPanner(); panL.pan.value = -0.6;
    const panR = ctx.createStereoPanner(); panR.pan.value = 0.6;
    this.delaySend = ctx.createGain(); this.delaySend.gain.value = 1;
    this.delaySend.connect(this.delayL);
    this.delayL.connect(dampL); dampL.connect(fbL); fbL.connect(this.delayR);
    this.delayR.connect(dampR); dampR.connect(fbR); fbR.connect(this.delayL);
    dampL.connect(panL); dampR.connect(panR);
    const delayOut = ctx.createGain(); delayOut.gain.value = 0.5;
    panL.connect(delayOut); panR.connect(delayOut);
    delayOut.connect(this.musicBus);

    // Cheap reverb: convolver fed a generated exponentially-decaying noise IR.
    this.verb = ctx.createConvolver();
    this.verb.buffer = this._impulse(2.2, 2.8);
    this.verbSend = ctx.createGain(); this.verbSend.gain.value = 1;
    const verbOut = ctx.createGain(); verbOut.gain.value = 0.45;
    this.verbSend.connect(this.verb); this.verb.connect(verbOut);
    verbOut.connect(this.musicBus);

    // Shared pad filter with a slow LFO breathing the cutoff.
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass'; this.padFilter.frequency.value = 1400;
    this.padFilter.Q.value = 0.7;
    this.padFilter.connect(this.musicBus);
    const padVerbTap = ctx.createGain(); padVerbTap.gain.value = 0.5;
    this.padFilter.connect(padVerbTap); padVerbTap.connect(this.verbSend);
    this.padLfo = ctx.createOscillator();
    this.padLfo.type = 'sine'; this.padLfo.frequency.value = 0.07;
    this.padLfoAmt = ctx.createGain(); this.padLfoAmt.gain.value = 500;
    this.padLfo.connect(this.padLfoAmt);
    this.padLfoAmt.connect(this.padFilter.frequency);
    this.padLfo.start();
  }

  _impulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  _tuneToTrack(t) {
    const beat = 60 / t.bpm;
    const now = this.ctx.currentTime;
    this.delayL.delayTime.setTargetAtTime(beat * 0.75, now, 0.1);
    this.delayR.delayTime.setTargetAtTime(beat * 0.75, now, 0.1);
    this.padFilter.frequency.setTargetAtTime(t.cutoff, now, 0.5);
    this.padLfoAmt.gain.setTargetAtTime(t.cutoff * 0.35, now, 0.5);
  }

  toggle() {
    if (this.enabled) { this.stop(); return false; }
    this.start(); return true;
  }
  start() {
    this._ensure();
    this.enabled = true;
    this.step = 0;
    this._tuneToTrack(TRACKS[this.trackIndex]);
    // Fade the music bus in so starts aren't abrupt.
    const now = this.ctx.currentTime;
    this.musicBus.gain.cancelScheduledValues(now);
    this.musicBus.gain.setValueAtTime(0.0001, now);
    this.musicBus.gain.exponentialRampToValueAtTime(0.2, now + 0.8);
    this._scheduleLoop();
  }
  stop() {
    this.enabled = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.ctx && this.musicBus) {
      const now = this.ctx.currentTime;
      this.musicBus.gain.cancelScheduledValues(now);
      this.musicBus.gain.setValueAtTime(this.musicBus.gain.value, now);
      this.musicBus.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
      setTimeout(() => {
        if (!this.enabled && this.musicBus) this.musicBus.gain.value = 0.2;
      }, 400);
    }
  }
  nextTrack() {
    this.trackIndex = (this.trackIndex + 1) % TRACKS.length;
    this.step = 0;
    this._mel = 0;
    if (this.ctx) this._tuneToTrack(TRACKS[this.trackIndex]);
    return this.trackName;
  }

  _scheduleLoop() {
    if (!this.enabled) return;
    const t = TRACKS[this.trackIndex];
    const stepDur = 60 / t.bpm / 4; // 16th notes
    const now = this.ctx.currentTime;
    const CHUNK = 8;
    for (let i = 0; i < CHUNK; i++) {
      const s = this.step + i;
      // Swing: push every off-16th late.
      const swing = (s % 2 === 1) ? t.swing * stepDur : 0;
      this._playStep(s, now + i * stepDur + swing, stepDur, t);
    }
    this.step += CHUNK;
    this.timer = setTimeout(() => this._scheduleLoop(), stepDur * CHUNK * 1000 - 60);
  }

  _playStep(step, when, dur, t) {
    const bar = Math.floor(step / STEPS_PER_BAR) % t.chords.length;
    const chord = t.chords[bar];
    const inBar = step % STEPS_PER_BAR;
    const barLen = dur * STEPS_PER_BAR;
    const phrase = Math.floor(step / STEPS_PER_BAR) % 8; // 8-bar arc

    // --- Pad: detuned pair per chord tone, held a whole bar, L/R spread.
    if (inBar === 0) {
      chord.forEach((c, i) => {
        const pan = [-0.5, 0.5, -0.25, 0.25][i % 4];
        this._padNote(t.padWave, NOTE(t.root - 12 + c), when, barLen * 1.15,
          t.padVol, pan);
      });
    }

    // --- Sub-bass: root anchors, gentle octave/fifth movement.
    if (inBar === 0 || inBar === 8) {
      this._tone(t.bassWave, NOTE(t.root - 24 + chord[0]), when, dur * 7,
        0.22, 0, 0.02);
    } else if (t.energy >= 1 && inBar === 11 && this.rand() < 0.6) {
      this._tone(t.bassWave, NOTE(t.root - 24 + chord[0] + 7), when, dur * 3,
        0.14, 0, 0.02);
    }

    // --- Drums (softened, lo-fi) ---
    if (t.kick.includes(inBar)) this._kick(when, 0.3 * t.energy);
    if (t.snare.includes(inBar)) this._snare(when, 0.12 * t.energy);
    if (inBar % 2 === 0 && this.rand() < t.hatDensity) {
      const open = inBar === 14 && this.rand() < 0.3;
      this._hat(when, (inBar % 4 === 0 ? 0.05 : 0.03) * t.energy, open);
    }

    // --- Lead: random walk on the scale, rests between phrases,
    //     quieter early in the 8-bar arc so the track breathes.
    const arc = phrase < 2 ? 0.4 : phrase < 6 ? 1 : 0.7;
    if (inBar % 2 === 0 && this.rand() < t.density * arc) {
      this._mel += Math.floor(this.rand() * 3) - 1;
      this._mel = Math.max(-2, Math.min(t.scale.length + 4, this._mel));
      const oct = Math.floor(this._mel / t.scale.length);
      const deg = ((this._mel % t.scale.length) + t.scale.length) % t.scale.length;
      const midi = t.root + 12 * (1 + oct) + t.scale[deg];
      const long = this.rand() < 0.25;
      this._pluck(t.leadWave, NOTE(midi), when, dur * (long ? 5 : 2.2), 0.10);
    }

    // --- Sparkle: rare high chord tone shimmer into the reverb.
    if (inBar === 12 && this.rand() < 0.25) {
      const c = chord[1 + Math.floor(this.rand() * (chord.length - 1))];
      this._pluck('sine', NOTE(t.root + 24 + c), when, dur * 4, 0.05);
    }
  }

  // ---------- voices ----------

  // Simple enveloped tone into the music bus (dry).
  _tone(wave, freq, when, dur, vol, pan, attack) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = wave; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(vol, when + (attack || 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g);
    if (pan) {
      const p = ctx.createStereoPanner(); p.pan.value = pan;
      g.connect(p); p.connect(this.musicBus);
    } else {
      g.connect(this.musicBus);
    }
    o.start(when); o.stop(when + dur + 0.05);
  }

  // Pad voice: two oscillators detuned ± cents, panned apart, slow
  // attack/release, routed through the shared LFO'd lowpass (+ reverb tap).
  _padNote(wave, freq, when, dur, vol, pan) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const atk = Math.min(0.6, dur * 0.25);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(vol, when + atk);
    g.gain.setValueAtTime(vol, when + dur * 0.6);
    g.gain.linearRampToValueAtTime(0.0001, when + dur);
    for (const [cents, side] of [[-7, -0.4], [7, 0.4]]) {
      const o = ctx.createOscillator();
      o.type = wave; o.frequency.value = freq; o.detune.value = cents;
      const p = ctx.createStereoPanner(); p.pan.value = pan + side * 0.5;
      o.connect(p); p.connect(g);
      o.start(when); o.stop(when + dur + 0.1);
    }
    g.connect(this.padFilter);
  }

  // Lead pluck: tone with its own quick-closing lowpass, sent to delay+verb.
  _pluck(wave, freq, when, dur, vol) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = wave; o.frequency.value = freq;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.Q.value = 1;
    f.frequency.setValueAtTime(freq * 6, when);
    f.frequency.exponentialRampToValueAtTime(freq * 1.5, when + dur * 0.8);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(vol, when + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(f); f.connect(g);
    g.connect(this.musicBus);
    const dSend = ctx.createGain(); dSend.gain.value = 0.35;
    const vSend = ctx.createGain(); vSend.gain.value = 0.3;
    g.connect(dSend); dSend.connect(this.delaySend);
    g.connect(vSend); vSend.connect(this.verbSend);
    o.start(when); o.stop(when + dur + 0.05);
  }

  _noise(when, dur, vol, type, freq, dest) {
    const ctx = this.ctx;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = ctx.createGain(); g.gain.value = vol;
    src.connect(f); f.connect(g); g.connect(dest || this.musicBus);
    src.start(when);
  }

  _hat(when, vol, open) {
    this._noise(when, open ? 0.18 : 0.05, vol, 'highpass', 7500);
  }
  _snare(when, vol) {
    this._noise(when, 0.12, vol, 'bandpass', 1800);
    this._tone('triangle', 180, when, 0.08, vol * 0.6, 0, 0.002);
  }
  _kick(when, vol) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(105, when);
    o.frequency.exponentialRampToValueAtTime(38, when + 0.12);
    g.gain.setValueAtTime(vol, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.16);
    o.connect(g); g.connect(this.musicBus);
    o.start(when); o.stop(when + 0.2);
  }

  // SFX voice: dry-ish, into the (quieter) sfx bus, small verb tail.
  _blip(wave, freq, when, dur, vol, glideTo) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = wave;
    o.frequency.setValueAtTime(freq, when);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, when + dur);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(vol, when + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g); g.connect(this.sfxBus);
    const v = ctx.createGain(); v.gain.value = 0.25;
    g.connect(v); v.connect(this.verbSend);
    o.start(when); o.stop(when + dur + 0.05);
  }

  // ---------- SFX (work even if music is off, once ctx exists) ----------
  sfx(kind) {
    try { this._ensure(); } catch { return; }
    const t = this.ctx.currentTime;
    if (kind === 'kaching') {
      // Bright little coin arpeggio with a sparkle on top.
      [1318.5, 1568, 1975.5, 2637].forEach((f, i) => {
        this._blip('triangle', f, t + i * 0.05, 0.14, 0.5);
        this._blip('sine', f * 2, t + i * 0.05, 0.1, 0.15);
      });
    } else if (kind === 'click') {
      // Soft tick: tiny filtered noise + faint sine tap.
      this._noise(t, 0.03, 0.18, 'bandpass', 2500, this.sfxBus);
      this._blip('sine', 900, t, 0.04, 0.12);
    } else if (kind === 'goal') {
      // Warm 3-note fanfare, slightly overlapping, plus a soft octave cap.
      [[523.25, 0], [659.25, 0.11], [784, 0.22]].forEach(([f, dt]) => {
        this._blip('triangle', f, t + dt, 0.3, 0.4);
        this._blip('sine', f / 2, t + dt, 0.3, 0.2);
      });
      this._blip('sine', 1046.5, t + 0.33, 0.45, 0.25);
    } else if (kind === 'bad') {
      this._blip('triangle', 220, t, 0.22, 0.35, 175);
      this._blip('triangle', 165, t + 0.16, 0.3, 0.3, 130);
    } else if (kind === 'build') {
      this._kick(t, 0.25);
      this._noise(t + 0.05, 0.09, 0.2, 'lowpass', 1200, this.sfxBus);
      this._blip('sine', 330, t + 0.02, 0.12, 0.2);
    }
  }
}
