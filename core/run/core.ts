import { fill } from '../director/prompts';
import type { LlmClient } from '../llm/client';
import type { CoreMessage, CorePort, GameEvent } from '../protocol';
import type { GameData } from '../room/types';
import { Run, type RunOptions } from './run';

export interface CoreOptions {
  llm?: LlmClient;
  waitMs?: number;
  observeMs?: number;
}

/**
 * Core behind the message protocol. The Three.js adapter calls it directly;
 * a Godot build would reach it over a WebSocket.
 */
export function createCore(data: GameData, opts: CoreOptions = {}): CorePort & { run(): Run | undefined } {
  const listeners = new Set<(m: CoreMessage) => void>();
  let run: Run | undefined;
  let lineCount = 0;

  const emit = (m: CoreMessage) => listeners.forEach((l) => l(m));
  const say = (text: string) => emit({ type: 'narrator_line', lineId: `l${++lineCount}`, text, final: true });
  const now = () => Date.now();
  /** Resolves once the current room's entry line has been said; the room's rule starts after it. */
  let introduced: Promise<void> = Promise.resolve();
  const runOpts = (): RunOptions => ({
    llm: opts.llm,
    waitMs: opts.waitMs,
    observeMs: opts.observeMs,
    onStatus: (doors) => emit({ type: 'gen_status', doors, model: run?.modelOff ? 'off' : 'on' }),
    onEffect: (effect) => emit({ type: 'rule_effect', effect }),
    onSay: say,
    onProfile: (profile) => emit({ type: 'profile', profile }),
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
        run = new Run(event.seed, data, runOpts());
        run.record(event);
        const room = run.start();
        emit({ type: 'load_room', spec: room });
        say(room.narrator.onEnter);
        emit({ type: 'profile', profile: run.profile.snapshot() });
        return;
      }
      if (!run) return;
      const r = run;
      r.record(event);
      if (event.type === 'room_entered' && event.roomId === r.current?.id && r.current.rule) {
        const received = now();
        const roomId = event.roomId;
        void introduced.then(() =>
          setTimeout(() => {
            if (r.current?.id === roomId) r.startRule(event.t + (now() - received) / 1000);
          }, 900),
        );
      } else if (event.type === 'door_chosen') {
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
          say(room.narrator.onEnter);
          // Give the entry line time to be read before the rule speaks.
          setTimeout(() => markIntroduced(), Math.min(6000, 1200 + room.narrator.onEnter.length * 35));
        })();
      } else if (event.type === 'pressed') {
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
