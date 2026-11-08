import type { TaskEvent } from '../protocol';
import type { GameData } from '../room/types';
import { scoreTask, type Score, type ScoreContext } from './metrics';
import { isOfficeModule, OFFICE_MODULES } from './office';
import type { TaskId } from './params';

/** Scores any task, 1 to 11: tasks 1 to 5 in metrics.ts, tasks 6 to 11 in their own modules. */
export function scoreAny(id: string, events: TaskEvent[], ctx: ScoreContext): Score {
  return isOfficeModule(id) ? OFFICE_MODULES[id].score(events, ctx) : scoreTask(id as TaskId, events, ctx);
}

export function taskTitle(id: string, data: GameData): string {
  return isOfficeModule(id) ? data.tasks.office[id].title : data.tasks[id as TaskId].title;
}

export function taskBrief(id: string, data: GameData): string {
  return isOfficeModule(id) ? data.tasks.office[id].brief : data.tasks[id as TaskId].brief;
}
