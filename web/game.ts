import * as THREE from 'three';
import { gameData } from '../core/data';
import type { CoreMessage, GameEvent, ProfileSnapshot, RuleEffect, SelfRatings } from '../core/protocol';
import { createCore } from '../core/run/core';
import type { LlmClient } from '../core/llm/client';
import type { RoomSpec } from '../core/room/types';
import type { Archetype } from '../core/room/layouts';
import type { LayoutInput } from '../core/testrooms/config';
import { Player } from './player/player';
import { createPost, type Post } from './render/post';
import { createRenderer } from './render/renderer';
import { buildRoom, type DoorView, type RoomView } from './room/buildRoom';
import { corridorStory, createCorridor } from '../core/corridors/corridor';
import { connectedColliders, crossed, joinRooms, walkableIn } from './room/connections';
import type { InteractInfo } from './room/buildProp';
import { MaterialLibrary } from './room/materials';
import { Hud } from './ui/hud';
import { Sound } from './audio/sound';
import { Voice } from './audio/voice';
import { showDossier } from './ui/dossier';
import type { Dossier } from '../core/protocol';
import type { Act } from './telemetry/recorder';

export interface GameOptions {
  seed: number;
  maxAnomalies?: number;
  /** Debug: room types to force for rooms 1, 2, 3… (`?layout=`). */
  forceArchetypes?: Archetype[];
  /** `?tests= ?fillers= ?pool=`: the run's layout, on top of data/layout.json. */
  layout?: LayoutInput;
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
  /** Rooms generated at once (LLM_PARALLEL in .env.local). */
  concurrency?: number;
}

const REACH = 2.6;
/** Position samples per second, for tests that watch movement (the office tasks). */
const SAMPLE_HZ = 10;
const CENTER = new THREE.Vector2(0, 0);

interface Passage {
  view: RoomView;
  from: RoomView;
  door: DoorView;
  entrance: DoorView;
  exit: DoorView;
  entered: boolean;
  fromDisposed: boolean;
  exitRequested: boolean;
  next?: RoomView;
}

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
  private lastTransfer = '';
  profile?: ProfileSnapshot;
  private moving = true;
  private post?: Post;
  private materials = new MaterialLibrary(gameData.materials);
  room?: RoomView;
  private passage?: Passage;
  private behind?: { view: RoomView; closing: DoorView; entrance: DoorView };
  private startedAt = 0;
  private busy = false;
  private raycaster = new THREE.Raycaster();
  hovered?: { info: InteractInfo; object: THREE.Object3D; since: number; doorHoverSent: boolean; gazeReportAt?: number };
  private wasIdle = false;
  private frames = 0;
  private fpsTime = 0;
  private fps = 0;
  /** Telemetry listens here: events sent to core, messages back, and clicks. It never changes the game. */
  tap?: { event(e: GameEvent): void; message(m: CoreMessage): void; act(a: Act): void };

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
  begin(llm?: LlmClient, selfRatings?: SelfRatings) {
    this.sound.start();
    this.core = createCore(gameData, { corridors: true, llm, observeMs: this.opts.observeMs, runLength: this.opts.runLength, concurrency: this.opts.concurrency, maxAnomalies: this.opts.maxAnomalies, forceArchetypes: this.opts.forceArchetypes, layout: this.opts.layout });
    this.core.onMessage((m) => this.handle(m));
    this.startedAt = performance.now();
    this.send({ type: 'run_started', seed: this.opts.seed, t: 0, ...(selfRatings ? { selfRatings } : {}) });
  }

  send(e: GameEvent) {
    this.tap?.event(e);
    this.core.send(e);
  }

  /** A key or mouse button went down while playing: the raw input stream, for tests that measure it. */
  input(key: string) {
    if (!this.room || this.busy || this.ended) return;
    this.send({ type: 'input', roomId: this.room.spec.id, key, target: this.hovered?.info.id, t: round(this.time) });
  }

  /** A test's question is on screen: A/D, arrows and the wheel adjust it; number keys pick an option. */
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
      return;
    }
    const h = this.hovered;
    if (!h || this.busy || !this.room) return;
    const roomId = this.room.spec.id;
    const t = this.time;
    if (this.passage?.entered) {
      if (h.info.kind === 'door') {
        if (!this.passage.next) this.passage.view.setPropText('interlock', 'TRANSFER IN PROGRESS\nPLEASE WAIT');
        this.passage.exitRequested = true;
        this.send({ type: 'corridor_exit_requested', roomId, t });
        this.openPassageExit();
      } else if (h.info.kind === 'inspect' || h.info.kind === 'button') {
        if (h.info.kind === 'inspect') {
          this.sound.rustle();
          this.hud.showInspect(h.info.name, h.info.text ?? '');
          this.player.enabled = false;
        } else {
          this.sound.button();
          this.passage.view.setPropText(h.info.id, 'ACKNOWLEDGED');
        }
        this.send({ type: 'corridor_interacted', roomId, objectId: h.info.id, t });
      } else if (h.info.kind === 'locked') this.sound.rattle();
      return;
    }
    // Opening an exit is reversible until the player actually crosses its threshold.
    if (h.info.kind !== 'door' || this.room.doors.find((d) => d.door.id === h.info.id)?.locked)
      this.tap?.act({ kind: h.info.kind, id: h.info.id, locked: h.info.kind === 'door' ? true : undefined });
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
        this.send({ type: 'inspected', roomId, objectId: h.info.id, t });
        break;
      case 'button': {
        const knob = h.object.children.find((c) => (c as THREE.Mesh).material && ((c as THREE.Mesh).material as THREE.Material).name === 'red_button');
        this.sound.button();
        if (knob) {
          knob.position.y -= 0.025;
          setTimeout(() => (knob.position.y += 0.025), 220);
        }
        // The lift's call button lights up and stays lit, as call buttons do.
        // (The material is shared between rooms, so the lit one is a copy.)
        const lamp = h.object.children.find((c) => ((c as THREE.Mesh).material as THREE.Material | undefined)?.name === 'call_glow') as THREE.Mesh | undefined;
        if (lamp) {
          const lit = (lamp.material as THREE.MeshStandardMaterial).clone();
          lit.name = 'call_glow_lit';
          lit.emissiveIntensity = 2.2;
          lamp.material = lit;
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
        this.sound.rattle();
        break;
    }
  }

  private async openDoor(doorId: string) {
    const view = this.room?.doors.find((d) => d.door.id === doorId);
    if (!view || !this.room) return;
    if (!this.core.run()?.finished) {
      if (this.passage?.door === view) return;
      if (this.passage) {
        this.passage.door.target = 0;
        this.passage.door.passage.visible = true;
        this.removeView(this.passage.view);
      }
      const spec = createCorridor(this.room.spec, view.door, corridorStory(this.room.spec, view.door, this.core.run()!.events, gameData), gameData);
      const corridor = buildRoom(spec, gameData, this.materials);
      const entrance = corridor.doors.find((d) => d.door.entrance)!;
      const exit = corridor.doors.find((d) => !d.door.entrance)!;
      exit.indicator?.color.set('#bf8b20');
      exit.indicator?.emissive.set('#ffb52e');
      joinRooms(this.room, view, corridor, entrance);
      this.scene.add(corridor.group);
      this.passage = { view: corridor, from: this.room, door: view, entrance, exit, entered: false, fromDisposed: false, exitRequested: false };
      view.target = 1;
      this.sound.doorOpen();
      return;
    }
    this.busy = true;
    this.tap?.act({ kind: 'door', id: doorId, locked: false });
    view.target = 1;
    this.sound.doorOpen();
    await wait(380);
    await this.hud.fade(true);
    this.hud.waiting(true, this.core.run()?.finished ? 'the building is preparing your file' : undefined);
    this.send({ type: 'door_chosen', roomId: this.room.spec.id, doorId, t: this.time });
  }

  private handle(m: CoreMessage) {
    this.tap?.message(m);
    if (m.type === 'load_room') void this.loadRoom(m.spec);
    else if (m.type === 'corridor_ready') {
      if (m.timing) this.lastTransfer = `transfer ${(m.timing.corridorMs / 1000).toFixed(1)}s · exit wait ${(m.timing.exitWaitMs / 1000).toFixed(1)}s · ${m.spec.source}`;
      this.prepareArrival(m.spec);
    }
    else if (m.type === 'narrator_line') {
      if (m.interrupt) { this.hud.clearNarration(); this.voice.stop(); }
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
      this.genStatus = `model ${m.model} ×${this.opts.concurrency ?? 1} · ` + m.doors.map((d) => `${d.door}:${d.status}${d.ms ? ` ${(d.ms / 1000).toFixed(1)}s` : ''}`).join(' ');
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
    if (this.passage?.entered) return;
    const room = this.room;
    if (!room) return;
    if (e.kind === 'lights') room.setLights(e.level, e.seconds);
    else if (e.kind === 'doors') room.setLocked(e.locked);
    else if (e.kind === 'timer') this.hud.timer(e.seconds, e.label);
    else if (e.kind === 'display') room.setPropText(e.prop, e.text);
    else if (e.kind === 'glance') room.glance(e.prop, e.at, e.seconds, this.player.position);
    else if (e.kind === 'disable') room.disableProp(e.prop);
    else if (e.kind === 'ask') {
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
  }

  private shakeLeft = 0;
  private sampleAcc = 0;

  /** Fade out, put the player somewhere (a corridor that loops back), fade in after `dark` seconds. */
  private async teleport(x: number, z: number, yaw: number, dark: number) {
    this.busy = true;
    await this.hud.fade(true);
    this.player.placeAt(x, z, yaw);
    await wait(Math.max(0, dark * 1000 - 940));
    await this.hud.fade(false);
    this.busy = false;
  }

  /** Position at 10 Hz, for tests that watch movement; nothing between rooms. */
  private sample(room: RoomView, dt: number) {
    if (this.busy || this.ended || !this.startedAt) return;
    this.sampleAcc += dt;
    if (this.sampleAcc < 1 / SAMPLE_HZ) return;
    this.sampleAcc %= 1 / SAMPLE_HZ;
    const p = this.player.position;
    this.send({ type: 'move', roomId: room.spec.id, x: round(p.x), z: round(p.z), t: round(this.time) });
  }

  private removeView(view: RoomView) {
    this.scene.remove(view.group);
    view.dispose();
  }

  private ambience(view: RoomView) {
    this.scene.fog = view.fog;
    this.scene.background = view.background;
    this.renderer.toneMappingExposure = view.exposure;
    if (view.grade) this.post?.setGrade(view.grade);
    this.sound.setAmbience(view.sound);
    this.sound.setLightLevel(1);
  }

  private prepareArrival(spec: RoomSpec) {
    const p = this.passage;
    if (!p || !p.entered || p.next) return;
    if (this.opts.forceAmbience) spec = { ...spec, ambience: this.opts.forceAmbience };
    const view = buildRoom(spec, gameData, this.materials, true);
    const entrance = view.doors.find((d) => d.door.entrance)!;
    joinRooms(p.view, p.exit, view, entrance);
    p.next = view;
    p.view.setPropText('interlock', 'TRANSFER CLEARED\nPROCEED');
    p.exit.indicator?.color.set('#2f8f4e');
    p.exit.indicator?.emissive.set('#34c759');
    this.scene.add(view.group);
    this.voice.prefetch(spec.narrator.onEnter);
    if (spec.rule?.line) this.voice.prefetch(spec.rule.line);
    if (p.exitRequested) this.openPassageExit();
  }

  private openPassageExit() {
    const p = this.passage;
    if (!p?.next || p.exit.target === 1) return;
    p.exit.target = 1;
    this.sound.doorOpen();
  }

  /** Physical threshold crossings, with no fade or camera teleport. */
  private updatePassage() {
    const p = this.passage;
    if (p && !p.entered && !p.door.locked && p.door.open > 0.8 && crossed(p.from, p.door, this.player.position)) {
      p.entered = true;
      p.door.target = 0;
      p.door.locked = p.entrance.locked = true;
      this.hovered = undefined;
      this.hud.timer(null, '');
      this.player.eyeHeight = 1.62;
      this.ambience(p.view);
      this.sound.rattle();
      // Refresh the receipt with actions taken between opening the door and crossing it.
      const story = corridorStory(p.from.spec, p.door.door, this.core.run()!.events, gameData);
      for (const object of p.view.interactables) {
        const info = object.userData.interact as InteractInfo | undefined;
        if (info?.id === 'receipt') info.text = story.receipt;
        if (info?.id === 'archive') info.text = story.archive;
      }
      this.tap?.act({ kind: 'door', id: p.door.door.id, locked: false });
      this.send({ type: 'door_chosen', roomId: p.from.spec.id, doorId: p.door.door.id, t: this.time });
    }
    if (p?.entered && !p.fromDisposed && p.door.open < 0.01) {
      p.entrance.open = p.entrance.target = 0;
      p.entrance.pivot.rotation.y = 0;
      p.entrance.pivot.visible = true;
      this.removeView(p.from);
      p.fromDisposed = true;
    }
    if (p?.entered && p.next && p.exit.open > 0.8 && crossed(p.view, p.exit, this.player.position)) {
      const next = p.next;
      const entrance = next.doors.find((d) => d.door.entrance)!;
      p.exit.target = 0;
      p.exit.locked = entrance.locked = true;
      if (!p.fromDisposed) this.removeView(p.from);
      if (this.behind) this.removeView(this.behind.view);
      // Rebase all visible geometry together to keep the active room's coordinates small.
      const offset = next.group.position.clone();
      p.view.group.position.sub(offset);
      next.group.position.set(0, 0, 0);
      this.player.translate(-offset.x, -offset.z);
      this.behind = { view: p.view, closing: p.exit, entrance };
      this.room = next;
      this.passage = undefined;
      this.hovered = undefined;
      this.wasIdle = false;
      this.moving = true;
      this.ambience(next);
      this.send({ type: 'corridor_exited', roomId: p.from.spec.id, t: this.time });
      this.send({ type: 'room_entered', roomId: next.spec.id, t: this.time });
    }
    if (this.behind && this.behind.closing.open < 0.01) {
      const { view, entrance } = this.behind;
      entrance.open = entrance.target = 0;
      entrance.pivot.rotation.y = 0;
      entrance.pivot.visible = true;
      this.removeView(view);
      this.behind = undefined;
    }
  }

  /** The visible passage and props, also used by integration tests without bypassing collision. */
  corridorState() {
    const p = this.passage;
    if (!p) return undefined;
    return { entered: p.entered, ready: !!p.next, x: p.view.group.position.x, z: p.view.group.position.z,
      layout: p.view.spec.layout, props: p.view.spec.props, door: p.door.door, exitOpen: p.exit.open,
      sealed: p.entrance.locked, fromDisposed: p.fromDisposed };
  }

  private async loadRoom(spec: RoomSpec) {
    // Fetch the lines this room is about to say while it loads.
    this.voice.prefetch(spec.narrator.onEnter);
    if (spec.rule?.line) this.voice.prefetch(spec.rule.line);
    this.busy = true;
    await this.hud.fade(true);
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
    const p = this.passage;
    const views = p ? [p.fromDisposed ? undefined : p.from, p.view, p.next] : [this.room];
    if (this.behind) views.push(this.behind.view);
    const live = views.filter((v): v is RoomView => !!v);
    if (live.length) {
      this.player.update(dt, (cx, cz) => walkableIn(live, cx, cz), connectedColliders(live));
      for (const view of live) view.update(dt, t);
      this.updatePassage();
    }
    const room = this.passage?.entered ? this.passage.view : this.room;
    if (this.passage?.entered && room?.corridorEvent) {
      const event = room.corridorEvent.update(dt, { x: this.player.position.x - room.group.position.x, z: this.player.position.z - room.group.position.z });
      if (event) this.sound.play(event === 'paper_gust' ? 'paper' : event === 'falling_art' ? 'clunk' : 'pop');
    }
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
      this.sample(room, dt);
      const erased = room.anomaly?.update(dt, t, this.player.position, this.hovered?.info.id);
      if (erased && room.spec.anomaly) this.send({ type: 'anomaly_action', roomId: room.spec.id, anomalyId: room.spec.anomaly.id, action: 'erase', t: this.time });
      if (this.player.stepped) this.sound.footstep();
      if (room.consumeFlicker()) this.sound.buzz();
      this.sound.setLightLevel(room.lightLevel());
      this.updateHover(room);
      if (!this.passage?.entered) {
        this.trackIdle(room);
        this.trackMotion(room);
      }
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
      let visible: THREE.Object3D | null = hit.object;
      while (visible && visible.visible) visible = visible.parent;
      if (visible) continue;
      let o: THREE.Object3D | null = hit.object;
      while (o && !o.userData.interact) o = o.parent;
      if (o) found = { info: o.userData.interact as InteractInfo, object: o };
      break; // only the nearest surface counts, so walls hide what's behind them
    }
    const prev = this.hovered;
    const t = this.time;
    if (prev && prev.info.id !== found?.info.id) {
      const seconds = t - prev.since;
      if (!this.passage?.entered && seconds >= 0.6 && prev.info.kind !== 'door' && prev.info.kind !== 'locked')
        this.send({ type: 'looked_at', roomId: room.spec.id, objectId: prev.info.id, seconds: round(seconds), t });
    }
    if (!found) {
      this.hovered = undefined;
    } else if (!prev || prev.info.id !== found.info.id) {
      this.hovered = { ...found, since: t, doorHoverSent: false };
    }
    const h = this.hovered;
    if (h && h.info.kind === 'anomaly' && t - h.since >= 3 && (h.gazeReportAt === undefined || (room.spec.anomaly?.id === 'borrowed_clock' && t - h.gazeReportAt >= 1))) {
      h.gazeReportAt = t;
      this.send({ type: 'looked_at', roomId: room.spec.id, objectId: h.info.id, seconds: round(t - h.since), t });
    }
    if (!this.passage?.entered && h && h.info.kind === 'door' && !h.doorHoverSent && t - h.since >= 1.5) {
      h.doorHoverSent = true;
      this.send({ type: 'door_hovered', roomId: room.spec.id, doorId: h.info.id, seconds: round(t - h.since), t });
    }
    if (this.busy || this.hud.inspecting || !h) this.hud.setPrompt(null);
    else if (h.info.kind === 'anomaly') this.hud.setPrompt('E', h.info.name);
    else if (h.info.kind === 'inspect') this.hud.setPrompt('E', `Inspect ${h.info.name.toLowerCase()}`);
    else if (h.info.kind === 'button') this.hud.setPrompt('E', h.info.verb ?? 'Press');
    else if (this.passage?.entered && h.info.kind === 'door' && !this.passage.next)
      this.passage.exitRequested
        ? this.hud.setPrompt(null, 'Transfer interlock engaged. The door will open when ready; you can still explore.')
        : this.hud.setPrompt('E', 'Request transfer — interlock engaged');
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
      this.lastTransfer,
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
