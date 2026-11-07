/** Fill {{placeholders}} in a Markdown template. Unknown placeholders are left visible so mistakes are obvious. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Rooms in a run, counting the first waiting room. The last one leads to the ending. */
export const RUN_LENGTH = 7;

export function storyStage(index: number): string {
  if (index <= 1) return 'opening: introduce the building and its attention';
  if (index <= 3) return 'escalation: the building gets more personal';
  if (index === 4) return 'twist: reveal that the building has been built around the player';
  return 'finale: the building confronts the player with who they have shown themselves to be';
}
