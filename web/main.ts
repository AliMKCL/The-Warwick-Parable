import './styles.css';
import { createLlmClient } from '../core/llm/client';
import { Game } from './game';
import { Loop } from './render/loop';
import { gameData } from '../core/data';
import { ARCHETYPES, CHOICE_ROOM, type Archetype } from '../core/room/layouts';
import type { LayoutInput } from '../core/testrooms/config';
import { Recorder } from './telemetry/recorder';
import { endSession, logEvent, startSession, telemetryConfigured, type SelfRatings, type Trait } from './telemetry/telemetry';
import { roomsSource, voiceSettings } from './settings/keys';
import { mountKeysPanel } from './ui/keys';

/**
 * Entry point. URL options:
 *   ?seed=123   replay a specific run
 *   ?post=0     turn off post-processing (if the frame rate is low)
 *   ?dpr=2      render at full Retina resolution (default 1.5)
 *   ?debug=1    show frame rate, room info and generation status
 *   ?observe=8  seconds to watch the player before generating the next rooms
 *   ?ambience=warm  draw every room in one mood (cold, warm, sickly, dim)
 *   ?mute=1     start with sound off (M toggles it)
 *   ?rooms=5    rooms per run, counting the first (default 7)
 *   ?layout=lift_lobby,l_gallery,u_gallery  force room types in turn from room 1 (to see a specific room)
 *   ?tests=4&fillers=2  test rooms and filler rooms between the waiting room and the finale (data/layout.json)
 *   ?pool=exit_timer,lift_wait  only draw these tests (ids in core/testrooms/kinds); gamble:3 sets a weight
 *   ?select=weighted  draw tests by the old hand-written weights instead of Bayesian information gain (adaptive)
 *   ?focus=8    adaptive: lean harder towards the most informative test (0 = off, default from data/layout.json)
 */
const params = new URLSearchParams(location.search);
/** Who writes the rooms: the player's own key, the dev server's model, or nobody (templates). */
const rooms = roomsSource();
const seed = Number(params.get('seed')) || Math.floor(Math.random() * 1e9);
const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas')!;
const game = new Game(canvas, {
  seed,
  post: params.get('post') !== '0',
  maxDpr: Number(params.get('dpr')) || 1.5,
  debug: params.get('debug') === '1',
  observeMs: params.has('observe') ? Number(params.get('observe')) * 1000 : undefined,
  forceAmbience: params.get('ambience') ?? undefined,
  runLength: Number(params.get('rooms')) || undefined,
  forceArchetypes: parseLayouts(params.get('layout')),
  layout: parseRunLayout(params),
  concurrency: rooms?.config.parallel ?? 1,
  mute: params.get('mute') === '1',
});

const loop = new Loop(
  (dt, t) => game.update(dt, t),
  () => game.render(performance.now() / 1000),
);
loop.start();

// ---- start, pause and pointer lock ----
let started = false;
let modelReady: Promise<boolean>;
const startButton = document.getElementById('start-button') as HTMLButtonElement;
startButton.addEventListener('click', () => {
  if (!started && !readyToBegin()) return;
  canvas.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (locked && !started) {
    started = true;
    const ratings = selfRatings();
    if (telemetryConfigured && consent.checked) record(ratings);
    research.hidden = true;
    void modelReady.then((ok) => game.begin(ok ? llm : undefined, ratings));
    keysPanel.hidden = true;
  }
  game.player.enabled = locked && !game.hud.inspecting && !game.ended && !game.asking;
  game.hud.start.hidden = locked || game.ended;
  startButton.textContent = 'Click to continue';
  startButton.disabled = false;
});
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === canvas) game.player.look(e.movementX, e.movementY);
});
document.addEventListener('mousedown', (e) => {
  if (document.pointerLockElement !== canvas) return;
  game.input(`Mouse${e.button}`);
  if (e.button === 0) game.interact();
});
document.addEventListener('wheel', (e) => {
  if (game.asking) game.askAdjust(e.deltaY < 0 ? 1 : -1);
});
addEventListener('keydown', (e) => {
  // Typing a key or a model name on the start screen is not playing.
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
  const playing = document.pointerLockElement === canvas || testMode;
  if (playing && !e.repeat) game.input(e.code);
  if (playing && game.asking) {
    // A test's question is on screen: A/D or arrows adjust, number keys pick, E confirms.
    if (e.code === 'KeyA' || e.code === 'ArrowLeft') game.askAdjust(-1);
    if (e.code === 'KeyD' || e.code === 'ArrowRight') game.askAdjust(1);
    if (/^Digit[1-9]$/.test(e.code)) game.askPick(Number(e.code.slice(5)) - 1);
  }
  if (e.code === 'KeyE' && playing && !e.repeat) game.interact();
  if (e.code === 'KeyM') game.voice.setMuted(game.sound.toggleMute());
});

// ---- self-ratings (required: the dossier compares them with what you did) and research consent ----
// Consent is only asked when Supabase is configured; without it nothing is ever sent.
const research = document.getElementById('research') as HTMLFormElement;
const consent = document.getElementById('consent') as HTMLInputElement;
const consentRow = document.getElementById('consent-row')!;
const hint = document.getElementById('research-hint')!;
const TRAITS: Trait[] = ['risk', 'patience', 'social', 'exploration'];
const rated = new Set<Trait>();
consentRow.hidden = !telemetryConfigured;
research.addEventListener('submit', (e) => e.preventDefault());
for (const row of research.querySelectorAll<HTMLElement>('.rate')) {
  const trait = row.dataset.trait as Trait;
  const label = row.textContent!.trim();
  row.classList.add('unset');
  row.insertAdjacentHTML('beforeend', `<input type="range" name="rate-${trait}" min="1" max="5" step="1" value="3" aria-label="${label}, 1 not at all to 5 very" /><output>–</output>`);
  const input = row.querySelector('input')!, out = row.querySelector('output')!;
  // A slider has no "empty" value, so it counts as set once it has been touched.
  const set = () => {
    rated.add(trait);
    row.classList.remove('unset');
    out.textContent = input.value;
    updateBegin();
  };
  for (const ev of ['input', 'change', 'pointerup']) input.addEventListener(ev, set);
  input.addEventListener('keydown', (e) => ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(e.key) && setTimeout(set));
}
consent.addEventListener('change', updateBegin);
function readyToBegin() {
  return rated.size === TRAITS.length && (!telemetryConfigured || consent.checked);
}
function updateBegin() {
  if (started) return;
  startButton.disabled = !readyToBegin();
  const left = TRAITS.length - rated.size;
  hint.textContent = left ? `Set ${left === TRAITS.length ? 'all four sliders' : `${left} more slider${left > 1 ? 's' : ''}`} to begin.`
    : telemetryConfigured && !consent.checked ? 'Tick the box to begin.' : '';
}
updateBegin();
function selfRatings(): SelfRatings {
  const get = (t: Trait) => (rated.has(t) ? Number(research.querySelector<HTMLInputElement>(`input[name="rate-${t}"]`)!.value) : null);
  return { risk: get('risk'), patience: get('patience'), social: get('social'), exploration: get('exploration') };
}
/** Starts a research session and listens to the game. Must run before game.begin() so the first room is seen. */
function record(selfRatings: SelfRatings | null) {
  void startSession(selfRatings);
  const recorder = new Recorder({
    log: logEvent,
    end: (profile, predictions) => void endSession(profile, predictions),
    now: () => performance.now(),
    inspectable: (id) => {
      const r = gameData.props.find((p) => p.id === id);
      return !!r?.inspectable && r.interact !== 'button';
    },
  });
  // A telemetry bug must never break the game.
  const safe = <T,>(fn: (x: T) => void) => (x: T) => {
    try { fn(x); } catch (err) { console.warn('[telemetry] recorder failed; the game continues.', err); }
  };
  game.tap = { event: safe((e) => recorder.event(e)), message: safe((m) => recorder.message(m)), act: safe((a) => recorder.act(a)) };
}

// ---- narrator voice status ----
const voiceStatus = document.getElementById('status-voice')!;
const voice = voiceSettings();
voiceStatus.textContent = !voice.enabled
  ? 'Voice: off (subtitles only)'
  : `Voice: ElevenLabs (${voice.model}${voice.via === 'player' ? ', your key' : ''})`;
voiceStatus.className = `status ${voice.enabled ? 'ok' : ''}`;

// ---- your own keys (optional): saved in this browser only ----
const keysPanel = mountKeysPanel(document.getElementById('ai-keys') as HTMLDetailsElement, { rooms, voice });

// ---- model status on the start screen ----
const status = document.getElementById('status-llm')!;
const llm = rooms && createLlmClient(rooms.config, { fetch: (url, init) => fetch(url, init as RequestInit), now: () => performance.now() });
const label = rooms?.config.label ?? '';
modelReady = !llm || !rooms
  ? Promise.resolve(false)
  : rooms.config.problem
    ? Promise.resolve(false)
    : llm.ping().then(async (r) => {
      const keyProblem = r.ok && r.hasModel ? await checkKey(rooms.config) : undefined;
      const ok = r.ok && r.hasModel && !keyProblem;
      const where = rooms.via === 'dev' ? 'details in the npm run dev terminal' : 'check your settings under "Use your own AI keys"';
      status.textContent = keyProblem
        ? `Rooms: ${label}: ${keyProblem}, so rooms will use templates.`
        : !r.ok
          ? `Rooms: ${label} not reachable (${(r.error ?? 'no answer').replace(/:\s*$/, '').slice(0, 110)}; ${where}), so rooms will use templates.`
          : r.hasModel
            ? `Rooms: ${label} ready${rooms.via !== 'player' ? '' : rooms.config.backend === 'openrouter' ? ' (your key)' : ' (on your computer)'}`
            : `Rooms: ${label}: the server is up but doesn't have this model, so rooms will use templates.`;
      status.className = `status ${ok ? 'ok' : 'bad'}`;
      // Local models are loaded into memory while the start screen is up; a cloud model needs no warming.
      if (ok && rooms.config.backend !== 'openrouter') warmUp();
      return ok;
    });
if (!rooms) {
  status.textContent = 'Rooms: written from templates. To have them written live as you play, add a model key below.';
  status.className = 'status';
} else if (rooms.config.problem) {
  status.textContent = `Rooms: ${label}. ${rooms.config.problem}, so rooms will use templates.`;
  status.className = 'status bad';
}

/** Load the model into memory while the start screen is up, so the first room isn't slowed by it. */
function warmUp() {
  void llm?.streamText({ messages: [{ role: 'user', content: 'Say OK.' }], maxTokens: 2 }, () => {}).catch(() => {});
}

/**
 * OpenRouter lists its models without a key, so the ping alone can't tell a
 * wrong key. Ask OpenRouter about the key itself; only a clear refusal counts.
 */
async function checkKey(config: NonNullable<typeof rooms>['config']): Promise<string | undefined> {
  if (config.backend !== 'openrouter' || !config.apiKey) return undefined;
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/v1/key`, { headers: { authorization: `Bearer ${config.apiKey}` } });
    if (res.status === 401 || res.status === 403) return 'OpenRouter refused the key';
  } catch {
    // Can't tell from here; the first room will show it.
  }
  return undefined;
}

// ---- test hooks: let automated checks drive the game without a mouse ----
let testMode = false;
Object.assign(window, {
  __WHACK__: {
    seed,
    /**
     * `telemetry` records this run as if the player had agreed on the start screen, with those self-ratings.
     * `selfRatings` sets the ratings the dossier compares against (defaults to `telemetry`'s).
     */
    async begin(opts: { telemetry?: SelfRatings | null; selfRatings?: SelfRatings } = {}) {
      testMode = true;
      game.testMode = true;
      started = true;
      if (opts.telemetry !== undefined) record(opts.telemetry);
      game.hud.start.hidden = true;
      game.begin((await modelReady) ? llm : undefined, opts.selfRatings ?? opts.telemetry ?? undefined);
      keysPanel.hidden = true;
      game.player.enabled = true;
    },
    state() {
      const r = game.room?.spec;
      return {
        room: r && {
          id: r.id, index: r.index, archetype: r.layout.archetype, doors: r.layout.doors, source: r.source,
          anomaly: r.anomaly, variant: r.variant,
          props: r.props.map((p) => ({ id: p.id, recipe: p.recipe, x: p.x, y: p.y, z: p.z, rotY: p.rotY })),
        },
        player: { x: game.player.position.x, z: game.player.position.z, yaw: game.player.yaw },
        corridor: game.corridorState(),
        hovered: game.hovered?.info,
        ask: game.hud.askOpen?.id,
        /** The room's test has started (after the narrator has introduced the room). */
        ruleStarted: !!(r && game.core.run()?.ruleStarts.has(r.id)),
        events: game.core.run()?.events.map((e) => e.type) ?? [],
        source: r?.source,
        rule: r?.rule,
        profile: game.profile?.traits,
        evidence: game.profile?.evidence.length ?? 0,
        locked: game.room?.doors.filter((d) => d.locked).map((d) => d.door.id) ?? [],
        lights: game.room?.lightLevel(),
        ended: game.ended,
        voice: { enabled: game.voice.enabled, error: game.voice.lastError },
        dossier: game.dossier,
        title: r?.title,
        gen: game.core.run()?.plansStatus(),
        frame: game.renderer.info.render.frame,
      };
    },
    /** Stand at (x, z) and look at a point. */
    lookFrom(x: number, z: number, tx: number, ty: number, tz: number) {
      game.player.placeAt(x, z, Math.atan2(-(tx - x), -(tz - z)));
      game.player.pitch = Math.atan2(ty - 1.62, Math.hypot(tx - x, tz - z));
    },
    interact: () => game.interact(),
    /** Answer the question on screen with a value (an option index, a slider value, or a meter position 0–1). */
    answer: (value: number) => game.answerWith(value),
    /** The question on screen, if any. */
    ask: () => game.hud.askOpen,
    /** Play every sound once; returns the audio state. */
    soundCheck() {
      const s = game.sound;
      s.start();
      for (const bed of ['fluorescent_hum', 'distant_office', 'silence']) s.setAmbience(bed);
      s.footstep(); s.doorOpen(); s.rattle(); s.button(); s.rustle(); s.buzz(); s.tick(true);
      return (s as unknown as { ctx?: AudioContext }).ctx?.state ?? 'none';
    },
    /** Show a rule effect directly (for checking visuals). */
    effect: (e: unknown) => game.applyEffect(e as never),
    /** Walk up to an exit and open it. */
    useDoor(id: string) {
      const d = game.room?.spec.layout.doors.find((x) => x.id === id);
      if (!d) return false;
      const dir = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] }[d.side];
      const px = d.cx + 0.5 - dir[0] * 0.2, pz = d.cz + 0.5 - dir[1] * 0.2;
      (window as any).__WHACK__.lookFrom(px, pz, d.cx + 0.5 + dir[0], 1.2, d.cz + 0.5 + dir[1]);
      return true;
    },
  },
});

/** `?layout=lift_lobby,l_gallery`: room types to force, ignoring unknown names. */
function parseLayouts(v: string | null): Archetype[] | undefined {
  const known: readonly string[] = [...ARCHETYPES, CHOICE_ROOM];
  const list = (v ?? '').split(',').map((x) => x.trim()).filter((x): x is Archetype => known.includes(x));
  return list.length ? list : undefined;
}

/** `?tests=4&fillers=2&pool=exit_timer,gamble:3`: the run's layout on top of data/layout.json (id:weight sets a weight). */
function parseRunLayout(p: URLSearchParams): LayoutInput | undefined {
  const n = (k: string) => (p.has(k) && Number.isFinite(Number(p.get(k))) ? Math.max(0, Math.floor(Number(p.get(k)))) : undefined);
  const ids = p.get('pool')?.split(',').map((x) => x.trim()).filter(Boolean) ?? [];
  const pool = ids.some((x) => x.includes(':'))
    ? Object.fromEntries(ids.map((x) => { const [id, w] = x.split(':'); return [id!, Number(w ?? 1) || 1]; }))
    : ids;
  const sel = p.get('select');
  const out: LayoutInput = { tests: n('tests'), fillers: n('fillers'), pool: ids.length ? pool : undefined, selection: sel === 'weighted' || sel === 'adaptive' ? sel : undefined, focus: p.has('focus') && Number.isFinite(Number(p.get('focus'))) ? Number(p.get('focus')) : undefined };
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}
