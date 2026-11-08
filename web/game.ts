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
import { Voice } from './audio/voice';
import { showDossier } from './ui/dossier';
import type { Dossier } from '../core/protocol';

export interface GameOptions {
  seed: number;
  maxAnomalies?: number;
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
  /** Stage the office tasks in rooms 1 to 5 (default on; ?tasks=0 turns them off). */
  tasks?: boolean;
  /** Which tasks fill rooms 1, 2, 3... (?try=balloons,coffee); default tasks 1 to 5. */
  taskOrder?: string[];
}

/** Position samples per second for the office-task log. */
const SAMPLE_HZ = 10;

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
  readonly voice = new Voice(__TTS__);
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
  hovered?: { info: InteractInfo; object: THREE.Object3D; since: number; doorHoverSent: boolean; gazeReportAt?: number };
  private wasIdle = false;
  private frames = 0;
  private fpsTime = 0;
  private fps = 0;
  /** Paused time (pointer lock lost) is left out of the run clock, so it never counts in a timing metric. */
  private pausedAt = 0;
  private pausedTotal = 0;
  private sampleAcc = 0;
  /** The inspect card on screen, and when it opened. */
  private reading?: { id: string; since: number };
  /** A hold-to-use action in progress. */
  holding?: { id: string; since: number; need: number; verb: string };

  constructor(
    private canvas: HTMLCanvasElement,
    private opts: GameOptions,
  ) {
    this.sound = new Sound(opts.mute);
    this.voice.setMuted(!!opts.mute);
    this.voice.onSpeaking = (on) => this.sound.duck(on);
    this.voice.getContext = () => this.sound.output();
    this.voice.onError = (msg) => {
      const el = document.getElementById('status-voice');
      if (el) { el.textContent = `Voice problem: ${msg}`; el.className = 'status bad'; }
    };
    this.hud.onTimerSecond = (left) => left <= 10 && this.sound.tick(left <= 5);
    this.hud.onShown = (lineId) => this.startedAt && this.send({ type: 'narrator_shown', lineId, t: this.time });
    this.renderer = createRenderer(canvas);
    this.renderer.info.autoReset = false;
    if (opts.post) this.post = createPost(this.renderer, this.scene, this.player.camera);
    this.raycaster.far = REACH;
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  /** Seconds since the run started, not counting time spent paused. */
  get time() {
    const now = this.pausedAt || performance.now();
    return (now - this.startedAt - this.pausedTotal) / 1000;
  }

  /** The pause screen is up (or not). */
  setPaused(paused: boolean) {
    if (paused && !this.pausedAt) {
      this.pausedAt = performance.now();
      this.release();
    } else if (!paused && this.pausedAt) {
      this.pausedTotal += performance.now() - this.pausedAt;
      this.pausedAt = 0;
    }
    this.hud.pauseTimer(paused);
  }

  /** A key or mouse button went down while playing (WASD included): the raw input stream for the task log. */
  input(key: string) {
    if (!this.room || this.busy || this.ended || this.pausedAt) return;
    this.send({ type: 'input', roomId: this.room.spec.id, key, target: this.hovered?.info.id, t: round3(this.time) });
  }

  /** E or the mouse button came back up: ends a hold-to-use action early. */
  release() {
    const h = this.holding;
    if (!h || !this.room) return;
    this.holding = undefined;
    this.hud.progress(null);
    this.send({ type: 'hold_end', roomId: this.room.spec.id, objectId: h.id, seconds: round(this.time - h.since), completed: false, t: this.time });
  }

  /** Start a run. With no model (or an unreachable one), rooms are filled from templates. */
  begin(llm?: LlmClient) {
    this.sound.start();
    this.core = createCore(gameData, { llm, observeMs: this.opts.observeMs, runLength: this.opts.runLength, maxAnomalies: this.opts.maxAnomalies, tasks: this.opts.tasks, taskOrder: this.opts.taskOrder });
    this.core.onMessage((m) => this.handle(m));
    this.startedAt = performance.now();
    this.send({ type: 'run_started', seed: this.opts.seed, t: 0 });
  }

  send(e: GameEvent) {
    this.core.send(e);
  }

  /** A task's question is on screen: A/D, arrows and the wheel adjust it; number keys pick an option. */
  askAdjust(dir: number) {
    this.hud.askAdjust(dir);
  }
  askPick(n: number) {
    this.hud.askPick(n);
  }
  get asking() {
    return !!this.hud.askOpen;
  }

  private closeAsk() {
    this.hud.ask(null);
    if (!this.ended && (document.pointerLockElement || this.testMode)) this.player.enabled = true;
  }
  /** Set by the test hooks, which play without pointer lock. */
  testMode = false;

  /** Test hook: answer the open question with a given value. */
  answerWith(value: number): boolean {
    const a = this.hud.askAnswer();
    if (!a || !this.room) return false;
    this.closeAsk();
    this.send({ type: 'answer', roomId: this.room.spec.id, askId: a.id, value, seconds: a.seconds, t: this.time });
    return true;
  }

  /** Press E or click. */
  interact() {
    const answer = this.hud.askAnswer();
    if (answer && this.room) {
      // Confirm the question on screen.
      this.closeAsk();
      this.sound.play('click');
      this.send({ type: 'answer', roomId: this.room.spec.id, askId: answer.id, value: answer.value, seconds: answer.seconds, t: this.time });
      return;
    }
    if (this.hud.inspecting) {
      this.hud.hideInspect();
      this.player.eyeHeight = 1.62;
      this.player.enabled = true;
      const r = this.reading;
      this.reading = undefined;
      if (r && this.room) this.send({ type: 'inspect_closed', roomId: this.room.spec.id, objectId: r.id, seconds: round(this.time - r.since), t: this.time });
      return;
    }
    if (this.holding) return;
    const h = this.hovered;
    if (!h || this.busy || !this.room) return;
    const roomId = this.room.spec.id;
    const t = this.time;
    switch (h.info.kind) {
      case 'anomaly':
        if (this.room.spec.anomaly) {
          this.sound.button();
          this.send({ type: 'anomaly_action', roomId, anomalyId: this.room.spec.anomaly.id, action: h.info.action ?? 'use', t });
        }
        break;
      case 'inspect':
        this.sound.rustle();
        this.hud.showInspect(h.info.name, h.info.text ?? '');
        this.player.enabled = false;
        this.reading = { id: h.info.id, since: t };
        this.send({ type: 'inspected', roomId, objectId: h.info.id, t });
        break;
      case 'hold':
        this.holding = { id: h.info.id, since: t, need: h.info.holdSeconds ?? 5, verb: h.info.verb ?? 'Hold' };
        this.hud.progress(0, this.holding.verb);
        this.send({ type: 'hold_start', roomId, objectId: h.info.id, t });
        break;
      case 'button': {
        const knob = h.object.children.find((c) => (c as THREE.Mesh).material && ((c as THREE.Mesh).material as THREE.Material).name === 'red_button');
        if (h.info.verb?.startsWith('Pick up')) this.sound.pickup();
        else if (!h.info.verb?.startsWith('Talk')) this.sound.button();
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
    else if (m.type === 'narrator_line') {
      this.hud.narrate(m.lineId, m.text, m.final);
      if (m.final) this.voice.speak(m.text);
    }
    else if (m.type === 'anomaly_effect') {
      if (m.effect.roomId === this.room?.spec.id) {
        this.room.anomaly?.apply(m.effect);
        if (this.room.spec.anomaly?.id === 'reflection' && m.effect.stage === 1) this.player.eyeHeight = 1.08;
        if (this.room.spec.anomaly?.id === 'false_exit' && m.effect.stage > 0) this.room.setLights(0.12, 0.7);
        this.hud.showInspect('Building notice', m.effect.text);
        this.player.enabled = false;
      }
    }
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
    this.voice.stop();
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
    else if (e.kind === 'smoke') room.smoke(e.from, e.level, e.seconds);
    else if (e.kind === 'display') room.setPropText(e.prop, e.text);
    else if (e.kind === 'glance') room.glance(e.prop, e.at, e.seconds, this.player.position);
    else if (e.kind === 'disable') room.disableProp(e.prop);
    else if (e.kind === 'ask') {
      this.release();
      this.hud.ask(e.ask);
      this.player.enabled = false;
    } else if (e.kind === 'ask_close') {
      if (this.hud.askOpen && (e.id === '*' || this.hud.askOpen.id === e.id)) this.closeAsk();
    } else if (e.kind === 'shake') this.shakeLeft = Math.min(1, e.seconds);
    else if (e.kind === 'sound') this.sound.play(e.name);
    else if (e.kind === 'scale') room.scaleProp(e.prop, e.scale);
    else if (e.kind === 'turn') room.turnProp(e.prop, e.at);
    else if (e.kind === 'status') this.hud.status(e.text);
    else if (e.kind === 'teleport') void this.teleport(e.x, e.z, e.yaw, e.dark);
    else if (e.kind === 'hide') room.hideProp(e.prop);
    else if (e.kind === 'alarm') this.sound.alarm(e.on);
  }

  private shakeLeft = 0;

  /** Fade out, put the player somewhere (a corridor that loops back), fade in after `dark` seconds. */
  private async teleport(x: number, z: number, yaw: number, dark: number) {
    this.busy = true;
    await this.hud.fade(true);
    this.player.placeAt(x, z, yaw);
    await wait(Math.max(0, dark * 1000 - 940));
    await this.hud.fade(false);
    this.busy = false;
  }

  private async loadRoom(spec: RoomSpec) {
    // Fetch the lines this room is about to say while it loads.
    this.voice.prefetch(spec.narrator.onEnter);
    if (spec.rule?.line) this.voice.prefetch(spec.rule.line);
    this.busy = true;
    await this.hud.fade(true);
    this.holding = undefined;
    this.hud.progress(null);
    this.sound.alarm(false);
    this.hud.ask(null);
    this.hud.status(null);
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
    this.player.eyeHeight = 1.62;
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
      if (this.shakeLeft > 0) {
        // A short, small shake (the buzzer): no flashing, just the view jolting.
        this.shakeLeft -= dt;
        const k = Math.max(0, this.shakeLeft) * 0.06;
        this.player.camera.position.x += (Math.random() - 0.5) * k;
        this.player.camera.position.y += (Math.random() - 0.5) * k;
      }
      room.update(dt, t);
      const erased = room.anomaly?.update(dt, t, this.player.position, this.hovered?.info.id);
      if (erased && room.spec.anomaly) this.send({ type: 'anomaly_action', roomId: room.spec.id, anomalyId: room.spec.anomaly.id, action: 'erase', t: this.time });
      if (this.player.stepped) this.sound.footstep();
      if (room.consumeFlicker()) this.sound.buzz();
      this.sound.setLightLevel(room.lightLevel());
      this.updateHover(room);
      this.trackIdle(room);
      this.trackMotion(room);
      this.trackHold(room);
      this.sample(room, dt);
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

  /** Position at 10 Hz for the office-task log; nothing while paused or between rooms. */
  private sample(room: RoomView, dt: number) {
    if (this.busy || this.pausedAt || this.ended || !this.startedAt) return;
    this.sampleAcc += dt;
    if (this.sampleAcc < 1 / SAMPLE_HZ) return;
    this.sampleAcc %= 1 / SAMPLE_HZ;
    const p = this.player.position;
    this.send({ type: 'move', roomId: room.spec.id, x: round3(p.x), z: round3(p.z), t: round3(this.time) });
  }

  /** A hold-to-use action: completes after its time, and stops if the player looks away. */
  private trackHold(room: RoomView) {
    const h = this.holding;
    if (!h) return;
    if (this.hovered?.info.id !== h.id) return this.release();
    const done = (this.time - h.since) / h.need;
    this.hud.progress(done, h.verb);
    if (done >= 1) {
      this.holding = undefined;
      this.hud.progress(null);
      this.sound.button();
      this.send({ type: 'hold_end', roomId: room.spec.id, objectId: h.id, seconds: round(this.time - h.since), completed: true, t: this.time });
    }
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
    // Some things can only be used up close (no glowing highlights: finding them is up to the player).
    const reach = found?.info.reach, at = found?.info.at;
    if (reach && at && Math.hypot(this.player.position.x - at[0], this.player.position.z - at[1]) > reach) found = undefined;
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
      // An interaction prompt just appeared: the start of a reaction time.
      if (found.info.kind !== 'locked' && !this.busy && !this.hud.inspecting) this.send({ type: 'prompt', roomId: room.spec.id, objectId: found.info.id, t });
    }
    const h = this.hovered;
    if (h && h.info.kind === 'anomaly' && t - h.since >= 3 && (h.gazeReportAt === undefined || (room.spec.anomaly?.id === 'borrowed_clock' && t - h.gazeReportAt >= 1))) {
      h.gazeReportAt = t;
      this.send({ type: 'looked_at', roomId: room.spec.id, objectId: h.info.id, seconds: round(t - h.since), t });
    }
    if (h && h.info.kind === 'door' && !h.doorHoverSent && t - h.since >= 1.5) {
      h.doorHoverSent = true;
      this.send({ type: 'door_hovered', roomId: room.spec.id, doorId: h.info.id, seconds: round(t - h.since), t });
    }
    if (this.busy || this.hud.inspecting || this.hud.askOpen || !h) this.hud.setPrompt(null);
    else if (h.info.kind === 'anomaly') this.hud.setPrompt('E', h.info.name);
    else if (h.info.kind === 'inspect') this.hud.setPrompt('E', `Inspect ${h.info.name.toLowerCase()}`);
    else if (h.info.kind === 'button') this.hud.setPrompt('E', h.info.verb ?? 'Press');
    else if (h.info.kind === 'hold') this.hud.setPrompt(this.holding ? null : 'E', this.holding ? '' : h.info.verb ?? 'Hold');
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
function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}
