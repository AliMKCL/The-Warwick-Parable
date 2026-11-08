/**
 * All game audio, synthesised with the Web Audio API: no sound files to
 * download or license. Ambient beds crossfade between rooms; one-shots are
 * short shaped noise and tone bursts.
 */
export class Sound {
  private ctx?: AudioContext;
  private master?: GainNode;
  private bed?: { gain: GainNode; stop(): void; name: string };
  private humScale = 1;
  private noise?: AudioBuffer;
  muted = false;

  constructor(muted = false) {
    this.muted = muted;
  }

  /** Must be called from a user gesture (the start click) for browsers to allow audio. */
  start() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  /** The audio context and output, once started (shared with the narrator's voice). */
  output(): { ctx: AudioContext; out: AudioNode } | undefined {
    return this.ctx && this.master ? { ctx: this.ctx, out: this.master } : undefined;
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.8, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  /** Crossfade to a room's ambient bed: fluorescent_hum, distant_office or silence. */
  setAmbience(name: string) {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.bed?.name === name) return;
    const old = this.bed;
    if (old) {
      old.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.4);
      setTimeout(() => old.stop(), 2500);
    }
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.master);
    const stops: (() => void)[] = [];

    if (name === 'fluorescent_hum') {
      // Mains hum (100/120 Hz family) plus a thin high buzz.
      for (const [f, type, g] of [[120, 'sawtooth', 0.018], [240, 'sine', 0.012], [360, 'sine', 0.005]] as const) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = f;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 900;
        const og = ctx.createGain();
        og.gain.value = g;
        o.connect(lp).connect(og).connect(gain);
        o.start();
        stops.push(() => o.stop());
      }
      stops.push(this.noiseBed(gain, 'bandpass', 3200, 0.004, 4));
      stops.push(this.noiseBed(gain, 'lowpass', 300, 0.02));
    } else if (name === 'distant_office') {
      stops.push(this.noiseBed(gain, 'lowpass', 380, 0.05));
      // Far-off keyboard clatter and the odd muffled thump.
      let alive = true;
      const clatter = () => {
        if (!alive) return;
        const n = 3 + Math.floor(Math.random() * 8);
        for (let i = 0; i < n; i++) setTimeout(() => this.burst({ to: gain, filter: 'bandpass', freq: 1800 + Math.random() * 800, q: 3, dur: 0.025, gain: 0.03 }), i * (70 + Math.random() * 90));
        if (Math.random() < 0.25) this.burst({ to: gain, filter: 'lowpass', freq: 160, dur: 0.18, gain: 0.08 });
        setTimeout(clatter, 2500 + Math.random() * 6000);
      };
      setTimeout(clatter, 1500);
      stops.push(() => (alive = false));
    } else {
      stops.push(this.noiseBed(gain, 'lowpass', 180, 0.012));
    }
    gain.gain.setTargetAtTime(this.humScale, ctx.currentTime, 0.6);
    this.bed = { gain, name, stop: () => stops.forEach((s) => s()) };
  }

  /** Lower the background while the narrator speaks. */
  duck(on: boolean) {
    if (!this.ctx || !this.bed) return;
    this.bed.gain.gain.setTargetAtTime(this.humScale * (on ? 0.4 : 1), this.ctx.currentTime, 0.25);
  }

  /** The hum follows the lights: dimmer room, quieter hum. */
  setLightLevel(level: number) {
    const target = 0.25 + 0.75 * level;
    if (Math.abs(target - this.humScale) < 0.02 || !this.ctx || !this.bed) return;
    this.humScale = target;
    this.bed.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.3);
  }

  footstep() {
    this.burst({ filter: 'lowpass', freq: 520 + Math.random() * 160, dur: 0.07, gain: 0.11 });
    this.burst({ filter: 'bandpass', freq: 2400, q: 1.5, dur: 0.03, gain: 0.015, delay: 0.01 });
  }

  doorOpen() {
    this.tone(1900, 0.012, 0.05, 'square'); // latch
    this.burst({ filter: 'lowpass', freq: 240, dur: 0.45, gain: 0.16, delay: 0.05 });
    this.burst({ filter: 'bandpass', freq: 700, q: 6, dur: 0.35, gain: 0.03, delay: 0.08 }); // hinge
  }

  rattle() {
    for (let i = 0; i < 3; i++) this.tone(1500 + i * 90, 0.01, 0.06, 'square', i * 0.07);
    this.burst({ filter: 'lowpass', freq: 400, dur: 0.12, gain: 0.07 });
  }

  button() {
    this.tone(2200, 0.008, 0.06, 'square');
    this.tone(880, 0.12, 0.05, 'sine', 0.05);
  }

  rustle() {
    this.burst({ filter: 'highpass', freq: 2500, dur: 0.16, gain: 0.04 });
  }

  buzz() {
    this.tone(120, 0.12, 0.05, 'sawtooth');
    this.burst({ filter: 'bandpass', freq: 3000, q: 2, dur: 0.1, gain: 0.03 });
  }

  tick(urgent: boolean) {
    this.tone(urgent ? 1320 : 1000, 0.03, urgent ? 0.07 : 0.04, 'sine');
  }

  private alarmTimer = 0;
  /** A fire alarm bell, kept soft: a slow two-tone chime, not a siren. */
  alarm(on: boolean) {
    clearInterval(this.alarmTimer);
    this.alarmTimer = 0;
    if (!on) return;
    let hi = true;
    const ring = () => {
      this.tone(hi ? 880 : 660, 0.35, 0.035, 'triangle');
      hi = !hi;
    };
    ring();
    this.alarmTimer = window.setInterval(ring, 520);
  }

  /** Paper being picked up. */
  pickup() {
    this.burst({ filter: 'highpass', freq: 1800, dur: 0.22, gain: 0.05 });
  }

  // ---------- building blocks ----------

  private noiseBed(to: AudioNode, type: BiquadFilterType, freq: number, gain: number, q = 0.7): () => void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise!;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(to);
    src.start(0, Math.random() * 1.5);
    return () => src.stop();
  }

  private burst(o: { to?: AudioNode; filter: BiquadFilterType; freq: number; q?: number; dur: number; gain: number; delay?: number }) {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + (o.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noise!;
    const f = ctx.createBiquadFilter();
    f.type = o.filter;
    f.frequency.value = o.freq;
    f.Q.value = o.q ?? 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(o.gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    src.connect(f).connect(g).connect(o.to ?? this.master);
    src.start(t, Math.random());
    src.stop(t + o.dur + 0.05);
  }

  private tone(freq: number, dur: number, gain: number, type: OscillatorType, delay = 0) {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
}
