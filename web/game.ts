import * as THREE from 'three';
import { gameData } from '../core/data';
import type { CoreMessage, GameEvent, ProfileSnapshot, RuleEffect } from '../core/protocol';
import { createCore } from '../core/run/core';
import type { LlmClient } from '../core/llm/client';
import type { RoomSpec } from '../core/room/types';
import { Player } from './player/player';
import { createPost, type Post } from './render/post';
import { createRenderer } from './render/renderer';
import { buildRoom, type RoomView } from './room/buildRoom';
import type { InteractInfo } from './room/buildProp';
import { MaterialLibrary } from './room/materials';
import { Hud } from './ui/hud';
import { Sound } from './audio/sound';
import { showDossier } from './ui/dossier';
import type { Dossier } from '../core/protocol';

export interface GameOptions {
  seed: number;
  post: boolean;
  maxDpr: number;
  debug: boolean;
  /** Seconds to watch the player before generating the next rooms (see Run). */
  observeMs?: number;
  /** Debug: draw every room with this ambience. */
  forceAmbience?: string;
  mute?: boolean;
  /** Rooms per run, counting the first (default 7). */
  runLength?: number;
}

const REACH = 2.6;
const CENTER = new THREE.Vector2(0, 0);

/**
 * The Three.js adapter. It draws whatever RoomSpec core sends, moves the
 * player, and reports what the player does. It never decides what happens.
 */
export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly player = new Player();
  readonly hud = new Hud();
  readonly sound: Sound;
  core: ReturnType<typeof createCore> = createCore(gameData);
  private genStatus = '';
  profile?: ProfileSnapshot;
  private moving = true;
  private post?: Post;
  private materials = new MaterialLibrary(gameData.materials);
  room?: RoomView;
  private startedAt = 0;
  private busy = false;
  private raycaster = new THREE.Raycaster();
  hovered?: { info: InteractInfo; object: THREE.Object3D; since: number; doorHoverSent: boolean };
  private wasIdle = false;
  private frames = 0;
  private fpsTime = 0;
  private fps = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private opts: GameOptions,
  ) {
    this.sound = new Sound(opts.mute);
    this.hud.onTimerSecond = (left) => left <= 10 && this.sound.tick(left <= 5);
    this.renderer = createRenderer(canvas);
    this.renderer.info.autoReset = false;
    if (opts.post) this.post = createPost(this.renderer, this.scene, this.player.camera);
    this.raycaster.far = REACH;
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  get time() {
    return (performance.now() - this.startedAt) / 1000;
  }

  /** Start a run. With no model (or an unreachable one), rooms are filled from templates. */
  begin(llm?: LlmClient) {
    this.sound.start();
    this.core = createCore(gameData, { llm, observeMs: this.opts.observeMs, runLength: this.opts.runLength });
    this.core.onMessage((m) => this.handle(m));
    this.startedAt = performance.now();
    this.send({ type: 'run_started', seed: this.opts.seed, t: 0 });
  }

  send(e: GameEvent) {
    this.core.send(e);
  }

  /** Press E or click. */
  interact() {
    if (this.hud.inspecting) {
      this.hud.hideInspect();
      this.player.enabled = true;
      return;
    }
    const h = this.hovered;
    if (!h || this.busy || !this.room) return;
    const roomId = this.room.spec.id;
    const t = this.time;
    switch (h.info.kind) {
      case 'inspect':
        this.sound.rustle();
        this.hud.showInspect(h.info.name, h.info.text ?? '');
        this.player.enabled = false;
        this.send({ type: 'inspected', roomId, objectId: h.info.id, t });
        break;
      case 'button': {
        const knob = h.object.children.find((c) => (c as THREE.Mesh).material && ((c as THREE.Mesh).material as THREE.Material).name === 'red_button');
        this.sound.button();
        if (knob) {
          knob.position.y -= 0.025;
          setTimeout(() => (knob.position.y += 0.025), 220);
        }
        this.send({ type: 'pressed', roomId, objectId: h.info.id, t });
        break;
      }
      case 'door': {
        const view = this.room.doors.find((d) => d.door.id === h.info.id);
        if (view?.locked) {
          this.send({ type: 'door_tried', roomId, doorId: h.info.id, t });
          this.sound.rattle();
          view.pivot.rotation.y = 0.03; // a rattle
          setTimeout(() => (view.pivot.rotation.y = 0), 90);
        } else this.openDoor(h.info.id);
        break;
      }
      case 'locked':
        break;
    }
  }

  private async openDoor(doorId: string) {
    const view = this.room?.doors.find((d) => d.door.id === doorId);
    if (!view || !this.room) return;
    this.busy = true;
    view.target = 1;
    this.sound.doorOpen();
    await wait(380);
    await this.hud.fade(true);
    this.hud.waiting(true, this.core.run()?.finished ? 'the building is preparing your file' : undefined);
    this.send({ type: 'door_chosen', roomId: this.room.spec.id, doorId, t: this.time });
  }

  private handle(m: CoreMessage) {
    if (m.type === 'load_room') void this.loadRoom(m.spec);
    else if (m.type === 'narrator_line') this.hud.narrate(m.lineId, m.text, m.final);
    else if (m.type === 'rule_effect') this.applyEffect(m.effect);
    else if (m.type === 'profile') this.profile = m.profile;
    else if (m.type === 'run_ended') void this.endRun(m.dossier);
    else if (m.type === 'gen_status')
      this.genStatus = `model ${m.model} · ` + m.doors.map((d) => `${d.door}:${d.status}${d.ms ? ` ${(d.ms / 1000).toFixed(1)}s` : ''}`).join(' ');
  }

  dossier?: Dossier;

  private async endRun(d: Dossier) {
    this.dossier = d;
    this.ended = true;
    this.player.enabled = false;
    this.hud.waiting(false);
    this.hud.timer(null, '');
    this.sound.setAmbience('silence');
    if (document.pointerLockElement) document.exitPointerLock();
    showDossier(document.getElementById('dossier')!, d);
  }
  ended = false;

  /** Show a rule's effect. Core decides; this only draws it. */
  applyEffect(e: RuleEffect) {
    const room = this.room;
    if (!room) return;
    if (e.kind === 'lights') room.setLights(e.level, e.seconds);
    else if (e.kind === 'doors') room.setLocked(e.locked);
    else if (e.kind === 'timer') this.hud.timer(e.seconds, e.label);
  }

  private async loadRoom(spec: RoomSpec) {
    this.busy = true;
    await this.hud.fade(true);
    if (this.room) {
      this.scene.remove(this.room.group);
      this.room.dispose();
    }
    if (this.opts.forceAmbience) spec = { ...spec, ambience: this.opts.forceAmbience };
    const view = buildRoom(spec, gameData, this.materials);
    this.room = view;
    this.scene.add(view.group);
    this.scene.fog = view.fog;
    this.scene.background = view.background;
    this.renderer.toneMappingExposure = view.exposure;
    if (view.grade) this.post?.setGrade(view.grade);
    this.sound.setAmbience(view.sound);
    this.sound.setLightLevel(1);
    const s = spec.layout.spawn;
    this.player.placeAt(s.x, s.z, s.yaw);
    this.hovered = undefined;
    this.moving = true;
    this.hud.timer(null, '');
    this.renderer.compile(this.scene, this.player.camera);
    this.send({ type: 'room_entered', roomId: spec.id, t: this.time });
    this.hud.waiting(false);
    await this.hud.fade(false);
    this.busy = false;
  }

  update(dt: number, t: number) {
    const room = this.room;
    if (room) {
      this.player.update(dt, room.isWalkable, room.colliders);
      room.update(dt, t);
      if (this.player.stepped) this.sound.footstep();
      if (room.consumeFlicker()) this.sound.buzz();
      this.sound.setLightLevel(room.lightLevel());
      this.updateHover(room);
      this.trackIdle(room);
      this.trackMotion(room);
    }
    this.frames++;
    if (t - this.fpsTime >= 1) {
      this.fps = this.frames / (t - this.fpsTime);
      this.frames = 0;
      this.fpsTime = t;
      if (this.opts.debug) this.showDebug();
    }
  }

  render(t: number) {
    this.renderer.info.reset();
    if (this.post) this.post.render(t);
    else this.renderer.render(this.scene, this.player.camera);
  }

  private updateHover(room: RoomView) {
    this.raycaster.setFromCamera(CENTER, this.player.camera);
    const hits = this.raycaster.intersectObject(room.group, true);
    let found: { info: InteractInfo; object: THREE.Object3D } | undefined;
    for (const hit of hits) {
      let o: THREE.Object3D | null = hit.object;
      while (o && !o.userData.interact) o = o.parent;
      if (o) found = { info: o.userData.interact as InteractInfo, object: o };
      break; // only the nearest surface counts, so walls hide what's behind them
    }
    const prev = this.hovered;
    const t = this.time;
    if (prev && prev.info.id !== found?.info.id) {
      const seconds = t - prev.since;
      if (seconds >= 0.6 && prev.info.kind !== 'door' && prev.info.kind !== 'locked')
        this.send({ type: 'looked_at', roomId: room.spec.id, objectId: prev.info.id, seconds: round(seconds), t });
    }
    if (!found) {
      this.hovered = undefined;
    } else if (!prev || prev.info.id !== found.info.id) {
      this.hovered = { ...found, since: t, doorHoverSent: false };
    }
    const h = this.hovered;
    if (h && h.info.kind === 'door' && !h.doorHoverSent && t - h.since >= 1.5) {
      h.doorHoverSent = true;
      this.send({ type: 'door_hovered', roomId: room.spec.id, doorId: h.info.id, seconds: round(t - h.since), t });
    }
    if (this.busy || this.hud.inspecting || !h) this.hud.setPrompt(null);
    else if (h.info.kind === 'inspect') this.hud.setPrompt('E', `Inspect ${h.info.name.toLowerCase()}`);
    else if (h.info.kind === 'button') this.hud.setPrompt('E', 'Press');
    else if (h.info.kind === 'door')
      room.doors.find((d) => d.door.id === h.info.id)?.locked
        ? this.hud.setPrompt('E', `${h.info.name[0]!.toUpperCase()}${h.info.name.slice(1)} is locked`)
        : this.hud.setPrompt('E', `Open ${h.info.name}`);
    else this.hud.setPrompt(null, 'The way you came. It will not open.');
  }

  /** Tell core when the player stops walking (after 1.5 s) and when they start again. */
  private trackMotion(room: RoomView) {
    if (this.busy) return;
    const standing = this.player.standingFor;
    if (this.moving && standing >= 1.5) {
      this.moving = false;
      this.send({ type: 'motion', roomId: room.spec.id, moving: false, t: round(this.time - standing) });
    } else if (!this.moving && standing < 0.05) {
      this.moving = true;
      this.send({ type: 'motion', roomId: room.spec.id, moving: true, t: this.time });
    }
  }

  private trackIdle(room: RoomView) {
    const still = this.player.stillFor;
    if (still >= 6) this.wasIdle = true;
    else if (this.wasIdle && still < 0.1) {
      this.wasIdle = false;
      // stillFor was reset by movement; report how long the pause lasted.
      this.send({ type: 'idle', roomId: room.spec.id, seconds: round(this.lastStill), t: this.time });
    }
    this.lastStill = still >= 0.1 ? still : this.lastStill;
  }
  private lastStill = 0;

  private resize() {
    const w = this.canvas.clientWidth || innerWidth, h = this.canvas.clientHeight || innerHeight;
    const dpr = Math.min(devicePixelRatio || 1, this.opts.maxDpr);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.post?.setSize(w, h, dpr);
    this.player.camera.aspect = w / h;
    this.player.camera.updateProjectionMatrix();
  }

  private showDebug() {
    const el = document.getElementById('debug')!;
    el.hidden = false;
    const r = this.room?.spec;
    const p = this.player.position;
    el.textContent = [
      `fps ${this.fps.toFixed(0)}  calls ${this.renderer.info.render.calls}  tris ${this.renderer.info.render.triangles}`,
      r ? `room ${r.index} ${r.layout.archetype} ${r.layout.width}x${r.layout.depth} · ${r.ambience} · ${r.source}${r.genMs ? ` ${(r.genMs / 1000).toFixed(1)}s` : ''}` : 'no room',
      r ? `"${r.title}"` : '',
      this.genStatus,
      `pos ${p.x.toFixed(1)}, ${p.z.toFixed(1)}  yaw ${this.player.yaw.toFixed(2)}`,
      `events ${this.core.run()?.events.length ?? 0}${r?.rule ? ` · rule ${r.rule.id}` : ''}`,
      this.profile ? Object.entries(this.profile.traits).map(([k, v]) => `${k.slice(0, 4)} ${v.toFixed(2)}`).join('  ') : '',
      this.profile?.evidence.at(-1) ? `last: ${this.profile.evidence.at(-1)!.trait} ${this.profile.evidence.at(-1)!.delta > 0 ? '+' : ''}${this.profile.evidence.at(-1)!.delta} ${this.profile.evidence.at(-1)!.reason}` : '',
    ].join('\n');
  }
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
function round(n: number) {
  return Math.round(n * 10) / 10;
}
