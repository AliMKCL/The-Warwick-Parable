/** All on-screen text: reticle, prompts, the inspect card, narrator subtitles, fades and the start screen. */
export class Hud {
  private el = (id: string) => document.getElementById(id)!;
  private reticle = this.el('reticle');
  private prompt = this.el('prompt');
  private subtitle = this.el('subtitle');
  private inspect = this.el('inspect');
  private fadeEl = this.el('fade');
  readonly start = this.el('start');
  private typing = 0;
  private hideTimer = 0;
  private waitTimer = 0;
  private waitingEl = this.el('waiting');
  private timerEl = this.el('timer');
  private timerTick = 0;
  /** Called once per second of a countdown with the seconds left. */
  onTimerSecond?: (left: number) => void;
  /** Line currently on screen, and finished lines waiting their turn. */
  private current?: { id: string; shownAt: number; done: boolean; text: string };
  private queue: string[] = [];

  setPrompt(key: string | null, text = '') {
    this.reticle.classList.toggle('active', !!key);
    this.prompt.innerHTML = key ? `<kbd>${key}</kbd>${escapeHtml(text)}` : escapeHtml(text);
  }

  showInspect(title: string, text: string) {
    this.el('inspect-title').textContent = title;
    this.el('inspect-text').textContent = text;
    this.inspect.hidden = false;
  }
  hideInspect() {
    this.inspect.hidden = true;
  }
  get inspecting() {
    return !this.inspect.hidden;
  }

  /**
   * Narrator lines from core. Streamed lines (final = false) update in place
   * as words arrive; a new line waits until the one on screen has been read.
   */
  narrate(id: string, text: string, final: boolean) {
    const cur = this.current;
    if (cur && cur.id === id) {
      cur.text = text;
      cur.done = final;
      clearInterval(this.typing);
      this.subtitle.textContent = text;
      if (final) this.scheduleHide(text);
      return;
    }
    if (!final) {
      // A streamed line takes over straight away.
      this.queue = [];
      this.show(id, text, false);
      return;
    }
    if (cur && (!cur.done || performance.now() - cur.shownAt < readingMs(cur.text) * 0.6)) {
      this.queue.push(text);
      return;
    }
    this.show(id, text, true);
  }

  private show(id: string, text: string, typed: boolean) {
    this.current = { id, shownAt: performance.now(), done: typed, text };
    if (typed) this.say(text);
    else {
      clearInterval(this.typing);
      clearTimeout(this.hideTimer);
      this.subtitle.textContent = text;
      this.subtitle.classList.add('show');
    }
  }

  private scheduleHide(text: string) {
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.next(), readingMs(text));
  }

  private next() {
    const text = this.queue.shift();
    if (text) this.show(`q${performance.now()}`, text, true);
    else {
      this.subtitle.classList.remove('show');
      this.current = undefined;
    }
  }

  /** Countdown at the top of the screen; null hides it. */
  timer(seconds: number | null, label: string) {
    clearInterval(this.timerTick);
    if (seconds === null) {
      this.timerEl.classList.remove('show');
      return;
    }
    const end = performance.now() + seconds * 1000;
    let lastLeft = -1;
    const draw = () => {
      const left = Math.max(0, Math.ceil((end - performance.now()) / 1000));
      if (left !== lastLeft && lastLeft !== -1) this.onTimerSecond?.(left);
      lastLeft = left;
      this.timerEl.innerHTML = `<span>${escapeHtml(label)}</span>0:${String(left).padStart(2, '0')}`;
      this.timerEl.classList.toggle('urgent', left <= 10);
      if (left <= 0) clearInterval(this.timerTick);
    };
    draw();
    this.timerEl.classList.add('show');
    this.timerTick = window.setInterval(draw, 250);
  }

  /** After a moment in the dark between rooms, admit that something is being prepared. */
  waiting(on: boolean) {
    clearTimeout(this.waitTimer);
    if (on) this.waitTimer = window.setTimeout(() => this.waitingEl.classList.add('show'), 1600);
    else this.waitingEl.classList.remove('show');
  }

  /** Narrator line, typed out, then faded after a reading-time pause. */
  say(text: string) {
    clearInterval(this.typing);
    clearTimeout(this.hideTimer);
    this.subtitle.textContent = '';
    this.subtitle.classList.add('show');
    let i = 0;
    this.typing = window.setInterval(() => {
      i += 2;
      this.subtitle.textContent = text.slice(0, i);
      if (i >= text.length) {
        clearInterval(this.typing);
        this.scheduleHide(text);
      }
    }, 28);
  }

  /** Fade to black (true) or back in (false); resolves when done. */
  fade(toBlack: boolean): Promise<void> {
    this.fadeEl.classList.toggle('clear', !toBlack);
    return new Promise((r) => setTimeout(r, 470));
  }
}

function readingMs(text: string) {
  return 2200 + text.length * 45;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
