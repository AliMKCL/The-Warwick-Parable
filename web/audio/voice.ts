/**
 * The narrator's spoken voice, via ElevenLabs through the dev server's /tts
 * proxy (which adds the API key). Lines are spoken one after another, cached
 * by text so repeats cost nothing, and capped per page load to protect credits.
 */
/** ElevenLabs' built-in "George" (British storyteller): works on every plan, used if the chosen voice is refused. */
export const FALLBACK_VOICE = 'JBFqnCBsd6RMkjVDRZzb';

export class Voice {
  private cache = new Map<string, Promise<AudioBuffer | null>>();
  private queue: string[] = [];
  private playing?: AudioBufferSourceNode;
  private fetching = false;
  private epoch = 0;
  private voiceId: string;
  /** The game's AudioContext (unlocked by the start click), so Safari doesn't block playback. */
  getContext?: () => { ctx: AudioContext; out: AudioNode } | undefined;
  /** Shown on the start/pause screen when something goes wrong. */
  onError?: (message: string) => void;
  private charsUsed = 0;
  muted = false;
  /** Called with true while the narrator is speaking (to duck the ambience). */
  onSpeaking?: (speaking: boolean) => void;
  lastError?: string;

  constructor(private cfg: { enabled: boolean; voice: string; model: string; maxChars: number }) {
    this.voiceId = cfg.voice;
  }

  get enabled() {
    return this.cfg.enabled;
  }

  /** Fetch audio ahead of time so the line plays without delay later. */
  prefetch(text: string) {
    if (this.cfg.enabled && clean(text)) void this.audioFor(clean(text));
  }

  speak(text: string) {
    const t = clean(text);
    if (!this.cfg.enabled || !t) return;
    // Never let the narrator fall far behind the subtitles: drop the oldest waiting line.
    if (this.queue.length >= 2) this.queue.shift();
    this.queue.push(t);
    this.prefetch(t);
    if (!this.playing && !this.fetching) void this.next();
  }

  /** Stop talking now (e.g. at the end of the run). */
  stop() {
    this.epoch++;
    this.fetching = false;
    this.queue = [];
    try { this.playing?.stop(); } catch { /* already stopped */ }
    this.playing = undefined;
    this.onSpeaking?.(false);
  }

  setMuted(m: boolean) {
    this.muted = m;
  }

  private request(text: string, voice: string) {
    return fetch(`/tts/${voice}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({
        text,
        model_id: this.cfg.model,
        // Steady, dry delivery: fairly stable, little added emotion, slightly unhurried.
        voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true, speed: 0.95 },
      }),
    });
  }

  private fail(message: string) {
    this.lastError = message;
    console.warn('[voice]', message);
    this.onError?.(message);
  }

  private async next(): Promise<void> {
    const epoch = this.epoch;
    const text = this.queue.shift();
    if (!text) {
      this.playing = undefined;
      this.onSpeaking?.(false);
      return;
    }
    this.fetching = true;
    const buffer = await this.audioFor(text);
    if (epoch !== this.epoch) return;
    this.fetching = false;
    const out = this.getContext?.();
    if (!buffer || !out || this.muted) return this.next();
    const src = out.ctx.createBufferSource();
    src.buffer = buffer;
    const gain = out.ctx.createGain();
    gain.gain.value = 1.1;
    src.connect(gain).connect(out.out);
    this.playing = src;
    this.onSpeaking?.(true);
    src.onended = () => { if (epoch === this.epoch) void this.next(); };
    src.start();
  }

  private audioFor(text: string): Promise<AudioBuffer | null> {
    let p = this.cache.get(text);
    if (p) return p;
    if (this.charsUsed + text.length > this.cfg.maxChars) {
      this.lastError = 'character limit for this session reached';
      return Promise.resolve(null);
    }
    this.charsUsed += text.length;
    p = this.request(text, this.voiceId)
      .then(async (res) => {
        // A plan that can't use this voice (e.g. a library voice on the free plan), or an unknown voice:
        // switch to a built-in voice for the rest of the session and try again.
        if ((res.status === 402 || res.status === 403 || res.status === 404) && this.voiceId !== FALLBACK_VOICE) {
          this.fail(`voice ${this.voiceId} refused (${res.status}: ${(await res.text()).slice(0, 140)}); using the built-in George voice instead`);
          this.voiceId = FALLBACK_VOICE;
          res = await this.request(text, this.voiceId);
        }
        if (!res.ok) {
          this.fail(`ElevenLabs answered ${res.status}: ${(await res.text()).slice(0, 160)}`);
          return null;
        }
        const ctx = this.getContext?.()?.ctx;
        if (!ctx) return null;
        return await ctx.decodeAudioData(await res.arrayBuffer());
      })
      .catch((err) => {
        this.fail(String(err));
        return null;
      });
    this.cache.set(text, p);
    return p;
  }
}

function clean(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}
