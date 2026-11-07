import type { CoreMessage, CorePort, GameEvent } from '../protocol';
import type { GameData } from '../room/types';
import { Run } from './run';

/** Core behind the message protocol. The Three.js adapter calls it directly; a Godot build would reach it over a WebSocket. */
export function createCore(data: GameData): CorePort & { run(): Run | undefined } {
  const listeners = new Set<(m: CoreMessage) => void>();
  let run: Run | undefined;
  let lineCount = 0;

  const emit = (m: CoreMessage) => listeners.forEach((l) => l(m));
  const say = (text: string) => emit({ type: 'narrator_line', lineId: `l${++lineCount}`, text, final: true });

  return {
    run: () => run,
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(event: GameEvent) {
      if (event.type === 'run_started') {
        run = new Run(event.seed, data);
        run.record(event);
        const room = run.start();
        emit({ type: 'load_room', spec: room });
        say(room.narrator.onEnter);
        return;
      }
      if (!run) return;
      run.record(event);
      if (event.type === 'door_chosen') {
        const room = run.next(event.doorId);
        emit({ type: 'load_room', spec: room });
        say(room.narrator.onEnter);
      } else if (event.type === 'pressed') {
        const lines = data.templates.narratorPress;
        say(lines[run.events.filter((e) => e.type === 'pressed').length % lines.length]!);
      } else if (event.type === 'door_hovered' && event.seconds >= 1.5) {
        const line = run.current?.narrator.doors[event.doorId];
        if (line) say(line);
      }
    },
  };
}
