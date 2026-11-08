import type { AskSpec } from '../../core/protocol';

/** All on-screen text: reticle, prompts, the inspect card, narrator subtitles, fades and the start screen. */
export class Hud {
  private el = (id: string) => document.getElementById(id)!;
  private askEl = this.el('ask');
  private statusEl = this.el('status');
  /** The question on screen, if any: its spec, when it opened, and the current choice or slider value. */
  private asking?: { spec: AskSpec; openedAt: number; value: number; tick: number };

  /** A short status line (energy, party score, what you're holding); null hides it. */
  status(text: string | null) {
    this.statusEl.textContent = text ?? '';
    this.statusEl.classList.toggle('show', !!text);
  }

  /** Show a task's question: pick an option, set a slider, or stop a moving marker. null closes it. */
  ask(spec: AskSpec | null) {
    if (this.asking) clearInterval(this.asking.tick);
    this.asking = undefined;
    if (!spec) {
      this.askEl.classList.remove('show');
      return;
    }
    const value = spec.mode === 'slider' ? spec.value : 0;
    this.asking = { spec, openedAt: performance.now(), value, tick: 0 };
    if (spec.mode === 'meter') this.asking.tick = window.setInterval(() => this.drawAsk(), 16);
    this.drawAsk();
    this.askEl.classList.add('show');
  }

  get askOpen(): AskSpec | undefined {
    return this.asking?.spec;
  }

  /** Move the choice or the slider: -1 left, +1 right. */
  askAdjust(dir: number) {
    const a = this.asking;
    if (!a) return;
    if (a.spec.mode === 'choice') a.value = (a.value + dir + a.spec.options.length) % a.spec.options.length;
    else if (a.spec.mode === 'slider') a.value = Math.max(a.spec.min, Math.min(a.spec.max, a.value + dir * a.spec.step));
    this.drawAsk();
  }

  /** Pick option n directly (number keys). */
  askPick(n: number) {
    const a = this.asking;
    if (a?.spec.mode !== 'choice' || n < 0 || n >= a.spec.options.length) return;
    a.value = n;
    this.drawAsk();
  }

  /** The answer as it stands now, and how long the question has been open. */
  askAnswer(): { id: string; value: number; seconds: number } | undefined {
    const a = this.asking;
    if (!a) return undefined;
    const value = a.spec.mode === 'meter' ? this.meterPos() : a.value;
    return { id: a.spec.id, value: Math.round(value * 1000) / 1000, seconds: Math.round((performance.now() - a.openedAt) / 100) / 10 };
  }

  private meterPos(): number {
    const a = this.asking;
    if (a?.spec.mode !== 'meter') return 0;
    const phase = (((performance.now() - a.openedAt) / 1000) * a.spec.speed) % 2;
    return phase < 1 ? phase : 2 - phase;
  }

  private drawAsk() {
    const a = this.asking;
    if (!a) return;
    const s = a.spec;
    let body = '', help = '';
    if (s.mode === 'choice') {
      body = `<div class="opts">${s.options.map((o, i) => `<span class="${i === a.value ? 'on' : ''}"><b>${i + 1}</b>${escapeHtml(o)}</span>`).join('')}</div>`;
      help = 'A / D or 1–' + s.options.length + ' to choose · E to confirm';
    } else if (s.mode === 'slider') {
      const pct = ((a.value - s.min) / Math.max(1, s.max - s.min)) * 100;
      body = `<div class="value">${a.value}${escapeHtml(s.unit ?? '')}</div><div class="bar"><i style="width:${pct}%"></i></div>`;
      help = 'A / D or scroll to adjust · E to confirm';
    } else {
      const pos = this.meterPos() * 100;
      body = `<div class="bar meter"><u style="left:${s.zone[0] * 100}%;width:${(s.zone[1] - s.zone[0]) * 100}%"></u><em style="left:${pos}%"></em></div>`;
      help = 'E to stop';
    }
    this.askEl.innerHTML = `<h3>${escapeHtml(s.title)}</h3>${s.text ? `<p>${escapeHtml(s.text)}</p>` : ''}${body}<small>${help}</small>`;
  }
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

  /** Drop obsolete room commentary when crossing into a new narrative space. */
  clearNarration() {
    clearInterval(this.typing);
    clearTimeout(this.hideTimer);
    this.current = undefined;
    this.queue = [];
    this.subtitle.textContent = '';
    this.subtitle.classList.remove('show');
  }

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
  waiting(on: boolean, text = 'the building is preparing something') {
    clearTimeout(this.waitTimer);
    if (on) this.waitingEl.textContent = text;
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
