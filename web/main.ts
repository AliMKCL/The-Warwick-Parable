import './styles.css';
import { createLlmClient } from '../core/llm/client';
import { Game } from './game';
import { Loop } from './render/loop';

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
 *   ?tasks=0    no office tasks: every room after the first is generated with a rule, as before
 *   ?try=balloons,coffee   put these tasks in rooms 1, 2... instead of tasks 1 to 5: any of two_doors, lift,
 *               desk, meeting, smoke, balloons, coffee, canteen, renumbered, pitch, loan, lockdown
 */
const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed')) || Math.floor(Math.random() * 1e9);
const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas')!;
const tryTasks = params.get('try')?.split(',').map((s) => s.trim()).filter(Boolean);
const game = new Game(canvas, {
  seed,
  post: params.get('post') !== '0',
  maxDpr: Number(params.get('dpr')) || 1.5,
  debug: params.get('debug') === '1',
  observeMs: params.has('observe') ? Number(params.get('observe')) * 1000 : undefined,
  forceAmbience: params.get('ambience') ?? undefined,
  // With ?try=, the run is long enough for every listed task plus the first and the last room.
  runLength: Math.max(Number(params.get('rooms')) || 0, tryTasks ? tryTasks.length + 2 : 0) || undefined,
  mute: params.get('mute') === '1',
  tasks: params.get('tasks') !== '0' || !!tryTasks,
  taskOrder: tryTasks,
});

const loop = new Loop(
  (dt, t) => game.update(dt, t),
  () => game.render(performance.now() / 1000),
);
loop.start();

// ---- start, pause and pointer lock ----
let started = false;
let modelReady: Promise<boolean>;
const startButton = document.getElementById('start-button')!;
startButton.addEventListener('click', () => {
  canvas.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (locked && !started) {
    started = true;
    void modelReady.then((ok) => game.begin(ok ? llm : undefined));
  }
  game.player.enabled = locked && !game.hud.inspecting && !game.ended && !game.asking;
  game.hud.start.hidden = locked || game.ended;
  if (started && !testMode) game.setPaused(!locked && !game.ended);
  startButton.textContent = 'Click to continue';
});
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === canvas) game.player.look(e.movementX, e.movementY);
});
document.addEventListener('mousedown', (e) => {
  if (document.pointerLockElement !== canvas) return;
  game.input(`Mouse${e.button}`);
  if (e.button === 0) game.interact();
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 0) game.release();
});
document.addEventListener('wheel', (e) => {
  if (game.asking) game.askAdjust(e.deltaY < 0 ? 1 : -1);
});
addEventListener('keydown', (e) => {
  const playing = document.pointerLockElement === canvas || testMode;
  if (playing && !e.repeat) game.input(e.code);
  if (playing && game.asking) {
    // A task's question is on screen: A/D or arrows adjust, number keys pick, E confirms.
    if (e.code === 'KeyA' || e.code === 'ArrowLeft') game.askAdjust(-1);
    if (e.code === 'KeyD' || e.code === 'ArrowRight') game.askAdjust(1);
    if (/^Digit[1-9]$/.test(e.code)) game.askPick(Number(e.code.slice(5)) - 1);
  }
  if (e.code === 'KeyE' && playing && !e.repeat) game.interact();
  if (e.code === 'KeyM') game.voice.setMuted(game.sound.toggleMute());
});
addEventListener('keyup', (e) => {
  if (e.code === 'KeyE') game.release();
});

// ---- narrator voice status ----
const voiceStatus = document.getElementById('status-voice')!;
voiceStatus.textContent = __TTS__.enabled ? `Voice: ElevenLabs (${__TTS__.model})` : 'Voice: off (subtitles only)';
voiceStatus.className = `status ${__TTS__.enabled ? 'ok' : ''}`;

// ---- model server status on the start screen ----
const llm = createLlmClient(
  { provider: __LLM_PROVIDER__, baseUrl: '/llm', model: __LLM_MODEL__ },
  { fetch: (url, init) => fetch(url, init as RequestInit), now: () => performance.now() },
);
const status = document.getElementById('status-llm')!;
modelReady = llm.ping().then((r) => {
  status.textContent = !r.ok
    ? 'Model: not reachable (rooms will use templates)'
    : r.hasModel
      ? `Model: ${__LLM_MODEL__} ready`
      : `Model: server up, ${__LLM_MODEL__} not installed`;
  status.className = `status ${r.ok && r.hasModel ? 'ok' : 'bad'}`;
  if (r.ok && r.hasModel) warmUp();
  return r.ok && r.hasModel;
});

/** Load the model into memory while the start screen is up, so the first room isn't slowed by it. */
function warmUp() {
  void llm.streamText({ messages: [{ role: 'user', content: 'Say OK.' }], maxTokens: 2 }, () => {}).catch(() => {});
}

// ---- test hooks: let automated checks drive the game without a mouse ----
let testMode = false;
Object.assign(window, {
  __WHACK__: {
    seed,
    async begin() {
      testMode = true;
      game.testMode = true;
      started = true;
      game.hud.start.hidden = true;
      game.begin((await modelReady) ? llm : undefined);
      game.player.enabled = true;
    },
    state() {
      const r = game.room?.spec;
      return {
        room: r && {
          id: r.id, index: r.index, archetype: r.layout.archetype, doors: r.layout.doors,
          anomaly: r.anomaly, variant: r.variant,
          props: r.props.map((p) => ({ id: p.id, recipe: p.recipe, x: p.x, y: p.y, z: p.z, rotY: p.rotY })),
          zones: r.layout.zones ?? [],
        },
        task: r?.task,
        taskResults: game.core.run()?.taskResults ?? [],
        taskLog: game.core.run()?.taskLog.events.length ?? 0,
        holding: !!game.holding,
        smoke: game.room?.smokeLevel() ?? 0,
        player: { x: game.player.position.x, z: game.player.position.z, yaw: game.player.yaw },
        hovered: game.hovered?.info,
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
    /** The question a task has on screen, if any. */
    ask: () => game.hud.askOpen,
    /** Answer it with a given value (an option index, a slider value, or a meter position 0 to 1). */
    answer: (value: number) => game.answerWith(value),
    /** Let go of E (ends a hold-to-use action early). */
    release: () => game.release(),
    /** The office-task log so far (for checks). */
    taskLog: () => game.core.run()?.taskLog.events ?? [],
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
