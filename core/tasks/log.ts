import type { TaskEvent } from '../protocol';

/**
 * The shared, append-only event log every office task writes to (build spec
 * "Event log"). Times are seconds on the run clock, which excludes paused
 * time. Metrics are pure functions of this log, so a session can be rescored
 * or replayed later from the log alone.
 */
export class TaskLog {
  readonly events: TaskEvent[] = [];

  emit(task: string, type: string, data: Record<string, unknown>, t: number): TaskEvent {
    const e: TaskEvent = { t: Math.round(t * 1000) / 1000, task, type, data };
    this.events.push(e);
    return e;
  }

  /** Events of one task occurrence (tasks are keyed by room id, so a repeat is a separate slice). */
  slice(task: string): TaskEvent[] {
    return this.events.filter((e) => e.task === task);
  }
}
