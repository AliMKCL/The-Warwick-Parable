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
 */
const params = new URLSearchParams(location.search);
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
  game.player.enabled = locked && !game.hud.inspecting && !game.ended;
  game.hud.start.hidden = locked || game.ended;
  startButton.textContent = 'Click to continue';
});
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === canvas) game.player.look(e.movementX, e.movementY);
});
document.addEventListener('mousedown', (e) => {
  if (document.pointerLockElement === canvas && e.button === 0) game.interact();
});
addEventListener('keydown', (e) => {
  if (e.code === 'KeyE' && (document.pointerLockElement === canvas || testMode)) game.interact();
  if (e.code === 'KeyM') game.voice.setMuted(game.sound.toggleMute());
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
          anomaly: r.anomaly,
          props: r.props.map((p) => ({ id: p.id, recipe: p.recipe, x: p.x, z: p.z })),
        },
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
