/** Fill {{placeholders}} in a Markdown template. Unknown placeholders are left visible so mistakes are obvious. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Default rooms in a run, counting the first waiting room. The last one leads to the ending. */
export const RUN_LENGTH = 7;

/** Story stage for room `index` when `last` is the final room's index. */
export function storyStage(index: number, last = RUN_LENGTH - 1): string {
  if (index >= last) return 'finale: the building confronts the player with who they have shown themselves to be; its single exit leads to their file';
  if (index === last - 1 && last >= 4) return 'twist: reveal that the building has been built around the player';
  if (index <= Math.max(1, Math.floor(last / 3))) return 'opening: introduce the building and its attention';
  return 'escalation: the building gets more personal';
}
