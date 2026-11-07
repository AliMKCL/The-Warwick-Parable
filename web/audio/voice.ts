/**
 * The narrator's spoken voice, via ElevenLabs through the dev server's /tts
 * proxy (which adds the API key). Lines are spoken one after another, cached
 * by text so repeats cost nothing, and capped per page load to protect credits.
 */
export class Voice {
  private cache = new Map<string, Promise<string | null>>();
  private queue: string[] = [];
  private playing?: HTMLAudioElement;
  private charsUsed = 0;
  muted = false;
  /** Called with true while the narrator is speaking (to duck the ambience). */
  onSpeaking?: (speaking: boolean) => void;
  lastError?: string;

  constructor(private cfg: { enabled: boolean; model: string; maxChars: number }) {}

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
    if (!this.playing) void this.next();
  }

  /** Stop talking now (e.g. at the end of the run). */
  stop() {
    this.queue = [];
    this.playing?.pause();
    this.playing = undefined;
    this.onSpeaking?.(false);
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.playing) this.playing.muted = m;
  }

  private async next(): Promise<void> {
    const text = this.queue.shift();
    if (!text) {
      this.playing = undefined;
      this.onSpeaking?.(false);
      return;
    }
    const url = await this.audioFor(text);
    if (!url) return this.next();
    const audio = new Audio(url);
    audio.muted = this.muted;
    this.playing = audio;
    this.onSpeaking?.(true);
    audio.onended = audio.onerror = () => void this.next();
    try {
      await audio.play();
    } catch {
      void this.next();
    }
  }

  private audioFor(text: string): Promise<string | null> {
    let p = this.cache.get(text);
    if (p) return p;
    if (this.charsUsed + text.length > this.cfg.maxChars) {
      this.lastError = 'character limit for this session reached';
      return Promise.resolve(null);
    }
    this.charsUsed += text.length;
    p = fetch('/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({
        text,
        model_id: this.cfg.model,
        // Steady, dry delivery: fairly stable, little added emotion, slightly unhurried.
        voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true, speed: 0.95 },
      }),
    })
      .then(async (res) => {
        if (!res.ok) {
          this.lastError = `ElevenLabs answered ${res.status}: ${(await res.text()).slice(0, 160)}`;
          console.warn('[voice]', this.lastError);
          return null;
        }
        return URL.createObjectURL(await res.blob());
      })
      .catch((err) => {
        this.lastError = String(err);
        return null;
      });
    this.cache.set(text, p);
    return p;
  }
}

function clean(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}
