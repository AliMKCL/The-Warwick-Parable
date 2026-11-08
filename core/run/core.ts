import { buildDossier, writeVerdict } from '../director/dossier';
import { fill } from '../director/prompts';
import type { LlmClient } from '../llm/client';
import type { CoreMessage, CorePort, GameEvent } from '../protocol';
import type { GameData } from '../room/types';
import { Run, type RunOptions } from './run';
import type { RoomSpec } from '../room/types';
import { corridorStory, CORRIDOR_PREPARE_MS, CORRIDOR_EXIT_WAIT_MS, ROOM_OBSERVE_MS, type CorridorStory } from '../corridors/corridor';

export interface CoreOptions {
  /** The adapter physically joins rooms with playable passages. */
  corridors?: boolean;
  maxAnomalies?: number;
  llm?: LlmClient;
  waitMs?: number;
  /** Additional wait at a corridor exit, bounded by the overall preparation timeout. */
  corridorExitWaitMs?: number;
  observeMs?: number;
  /** Rooms in a run, counting the first (default 7). */
  runLength?: number;
  /** Rooms generated at the same time (see RunOptions.concurrency). */
  concurrency?: number;
  /** Debug: force room types for rooms 1, 2, 3… (see RunOptions). */
  forceArchetypes?: RunOptions['forceArchetypes'];
  /** Test and filler counts and the test pool, on top of data/layout.json (see RunOptions.layout). */
  layout?: RunOptions['layout'];
}

interface PassageState { from: string; door: string; story: CorridorStory; used: Set<string>; next?: RoomSpec; startedAt: number; exitRequestedAt?: number; exitTimer?: ReturnType<typeof setTimeout> }

/**
 * Core behind the message protocol. The Three.js adapter calls it directly;
 * a Godot build would reach it over a WebSocket.
 */
export function createCore(data: GameData, opts: CoreOptions = {}): CorePort & { run(): Run | undefined } {
  const listeners = new Set<(m: CoreMessage) => void>();
  let run: Run | undefined;
  let lineCount = 0;

  const emit = (m: CoreMessage) => listeners.forEach((l) => l(m));
  const say = (text: string, interrupt = false) => emit({ type: 'narrator_line', lineId: `l${++lineCount}`, text, final: true, ...(interrupt ? { interrupt } : {}) });
  let passage: PassageState | undefined;
  const now = () => Date.now();
  /** Resolves once the current room's entry line has been said; the room's rule starts after it. */
  let introduced: Promise<void> = Promise.resolve();
  const runOpts = (): RunOptions => ({
    llm: opts.llm,
    waitMs: opts.waitMs,
    observeMs: opts.observeMs ?? (opts.corridors ? ROOM_OBSERVE_MS : undefined),
    runLength: opts.runLength,
    concurrency: opts.concurrency,
    forceArchetypes: opts.forceArchetypes,
    layout: opts.layout,
    onStatus: (doors) => emit({ type: 'gen_status', doors, model: run?.modelOff ? 'off' : 'on' }),
    maxAnomalies: opts.maxAnomalies,
    onAnomaly: (effect) => emit({ type: 'anomaly_effect', effect }),
    onEffect: (effect) => emit({ type: 'rule_effect', effect }),
    onSay: say,
    onProfile: (profile) => emit({ type: 'profile', profile }),
    onTaskResult: (result, log) => emit({ type: 'task_result', result, log }),
  });

  /** A live, streamed reaction to the door the player just chose. Returns when the line is finished. */
  async function reactToDoor(doorId: string): Promise<boolean> {
    const room = run?.current;
    const door = room?.layout.doors.find((d) => d.id === doorId);
    if (!run || !room || !door || !opts.llm || run.modelOff) return false;
    const p = data.prompts;
    const warned = room.narrator.doors[doorId];
    const lineId = `l${++lineCount}`;
    try {
      const { text } = await opts.llm.streamText(
        {
          messages: [
            { role: 'system', content: fill(p.narratorSystem, { world: p.world.trim() }) },
            {
              role: 'user',
              content: fill(p.narratorUser, {
                room_title: room.title,
                door_label: door.label || 'unmarked',
                door_note: warned ? `If they hesitated at it, you would have said: "${warned}"` : '',
                behaviour: run.describe(room).map((l) => `- ${l}`).join('\n') || '- Nothing in particular.',
              }),
            },
          ],
          maxTokens: 70,
          temperature: 0.9,
        },
        (soFar) => emit({ type: 'narrator_line', lineId, text: soFar, final: false }),
      );
      emit({ type: 'narrator_line', lineId, text, final: true });
      return !!text;
    } catch {
      return false;
    }
  }

  return {
    run: () => run,
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(event: GameEvent) {
      if (event.type === 'run_started') {
        run?.depart();
        if (passage?.exitTimer !== undefined) clearTimeout(passage.exitTimer);
        passage = undefined;
        introduced = Promise.resolve();
        run = new Run(event.seed, data, runOpts());
        run.selfRatings = event.selfRatings;
        run.record(event);
        const room = run.start();
        emit({ type: 'load_room', spec: room });
        say(room.narrator.onEnter);
        emit({ type: 'profile', profile: run.profile.snapshot() });
        return;
      }
      if (!run) return;
      const r = run;
      if ('roomId' in event && event.roomId !== r.current?.id) return;
      if (passage) {
        if (event.type === 'corridor_interacted') {
          r.record(event);
          const reply = passage.story.replies[event.objectId];
          if (reply && !passage.used.has(event.objectId)) { passage.used.add(event.objectId); say(reply); }
        } else if (event.type === 'corridor_exit_requested') {
          if (passage.exitRequestedAt === undefined) {
            r.record(event);
            passage.exitRequestedAt = now();
            if (!passage.next) {
              say('The next department has not released the interlock yet. Your file appears to require a little more consideration.');
              const waiting = passage;
              passage.exitTimer = setTimeout(() => {
                if (run === r && passage === waiting && !waiting.next) r.finishPreparation(waiting.door);
              }, opts.corridorExitWaitMs ?? CORRIDOR_EXIT_WAIT_MS);
            }
          }
        } else if (event.type === 'corridor_exited' && passage.next) {
          r.record(event);
          const room = passage.next;
          passage = undefined;
          r.arrive(room);
          const lines = room.gambleResult ? data.templates.gamble[room.gambleResult] : [];
          const outcome = lines.length ? lines[r.gambles.length % lines.length]! : '';
          say([outcome, room.narrator.onEnter].filter(Boolean).join(' '), true);
          introduced = new Promise((res) => setTimeout(res, Math.min(9000, 1200 + room.narrator.onEnter.length * 35)));
        }
        return;
      }
      if (event.type.startsWith('corridor_')) return;
      r.record(event);
      if (event.type === 'room_entered' && event.roomId === r.current?.id && r.current.rule) {
        const received = now();
        const roomId = event.roomId;
        void introduced.then(() =>
          setTimeout(() => {
            if (run === r && !passage && r.current?.id === roomId) r.startRule(event.t + (now() - received) / 1000);
          }, 900),
        );
      } else if (event.type === 'door_chosen' && (r.finished || r.leavesEarly(event.doorId))) {
        r.depart();
        // The final exit (or a won gamble that skips the last room): write the player's file.
        if (!r.finished) say(data.templates.gamble.shortcutEnd[0]!);
        void (async () => {
          const { verdict, source } = await writeVerdict(r, data, opts.llm);
          if (run === r) emit({ type: 'run_ended', dossier: buildDossier(r, verdict, source, data) });
        })();
      } else if (event.type === 'door_chosen') {
        if (opts.corridors) {
          const from = r.current!;
          const door = from.layout.doors.find((d) => d.id === event.doorId && !d.entrance);
          if (!door) return;
          const current: PassageState = { from: from.id, door: door.id, story: corridorStory(from, door, r.events, data), used: new Set<string>(), startedAt: now() };
          passage = current;
          r.depart();
          say(current.story.entry, true);
          void r.prepareNext(door.id, opts.waitMs ?? CORRIDOR_PREPARE_MS).then((room) => {
            if (run !== r || passage !== current) return;
            if (current.exitTimer !== undefined) clearTimeout(current.exitTimer);
            current.next = room;
            emit({ type: 'corridor_ready', spec: room, timing: {
              corridorMs: now() - current.startedAt,
              exitWaitMs: current.exitRequestedAt === undefined ? 0 : now() - current.exitRequestedAt,
            } });
            if (current.exitRequestedAt !== undefined) say('The interlock is released. The next department will see you now.');
          });
          return;
        }
        let markIntroduced!: () => void;
        introduced = new Promise<void>((res) => (markIntroduced = res));
        void (async () => {
          // React live only when the next room is already built, so the
          // reaction never delays the room itself.
          const ready = r.plansStatus().find((p) => p.door === event.doorId)?.status === 'ready';
          const reaction = ready ? reactToDoor(event.doorId) : Promise.resolve(false);
          const room = await r.next(event.doorId);
          emit({ type: 'load_room', spec: room });
          await Promise.race([reaction, new Promise<void>((res) => setTimeout(() => res(), 7000))]);
          // Arrived through a 50/50 door: say what the coin decided before anything else.
          const g = data.templates.gamble;
          const outcome = room.gambleResult ? g[room.gambleResult][r.gambles.length % g[room.gambleResult].length]! : '';
          if (outcome) say(outcome);
          say(room.narrator.onEnter);
          // Give the entry line time to be read before the rule speaks.
          setTimeout(() => markIntroduced(), Math.min(9000, 1200 + (outcome.length + room.narrator.onEnter.length) * 35));
        })();
      } else if (event.type === 'pressed' && r.current?.props.find((p) => p.id === event.objectId)?.recipe === 'button_pedestal') {
        const lines = data.templates.narratorPress;
        say(lines[r.events.filter((e) => e.type === 'pressed').length % lines.length]!);
      } else if (event.type === 'door_hovered' && event.seconds >= 1.5) {
        const line = r.current?.narrator.doors[event.doorId];
        if (line) say(line);
      }
    },
  };
}

declare function setTimeout(fn: () => void, ms: number): unknown;

declare function clearTimeout(id: unknown): void;
