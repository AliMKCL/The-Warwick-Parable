import { pick, type Rng } from '../util/random';
import { placeInSlot } from './geometry';
import type { Assignment } from './place';
import type { GameData, Layout, PropRecipe, Slot, TextStyle } from './types';

/** Which props suit which archetype, by slot kind. The template filler and the model prompt both use this. */
export const PREFERRED: Record<string, Partial<Record<Slot['kind'] | 'desk' | 'partition', string[]>>> = {
  waiting_room: {
    wall: ['bench_waiting', 'plant_potted', 'water_cooler', 'coat_rack', 'trash_bin', 'plant_dead', 'vending_machine'],
    wall_mounted: ['sign_wall', 'poster_wall', 'clock_wall', 'memo_board'],
    center: ['table_round', 'plant_potted', 'water_cooler'],
  },
  corridor: {
    wall: ['water_cooler', 'plant_dead', 'trash_bin', 'filing_cabinet', 'box_stack', 'copier'],
    wall_mounted: ['poster_wall', 'sign_wall', 'memo_board', 'clock_wall'],
  },
  open_office: {
    desk: ['terminal_desk', 'desk_office', 'terminal_desk'],
    partition: ['partition_low'],
    wall: ['filing_cabinet', 'bookshelf', 'copier', 'box_stack', 'plant_potted', 'water_cooler'],
    wall_mounted: ['whiteboard', 'poster_wall', 'memo_board', 'clock_wall', 'sign_wall'],
  },
  hub: {
    center: ['table_round', 'water_cooler', 'plant_potted'],
    wall: ['vending_machine', 'bench_waiting', 'bookshelf', 'plant_dead', 'filing_cabinet'],
    wall_mounted: ['sign_wall', 'poster_wall', 'clock_wall', 'whiteboard'],
  },
};

export function candidatesFor(slot: Slot, archetype: string, data: GameData): PropRecipe[] {
  const prefs = PREFERRED[archetype] ?? {};
  const key = slot.tags.includes('desk') ? 'desk' : slot.tags.includes('partition') ? 'partition' : slot.kind;
  const ids = prefs[key] ?? [];
  return ids
    .map((id) => data.props.find((p) => p.id === id))
    .filter((p): p is PropRecipe => !!p && !!placeInSlot(p, slot));
}

/** Fallback content: no model involved, but still seeded, so no two rooms match. */
export function templateAssignments(
  layout: Layout,
  data: GameData,
  rng: Rng,
  opts: { index: number; forceCenter?: string },
): Assignment[] {
  const t = data.templates;
  const counts = new Map<string, number>();
  const usedText = new Set<string>();
  const out: Assignment[] = [];

  for (const slot of layout.slots) {
    if (slot.kind === 'center' && opts.forceCenter) {
      out.push(withText({ slot: slot.id, recipe: opts.forceCenter }, data, rng, opts.index));
      continue;
    }
    const isStructural = slot.tags.includes('desk') || slot.tags.includes('partition');
    if (!isStructural && rng() < 0.25) continue; // breathing room
    const options = candidatesFor(slot, layout.archetype, data).filter(
      (p) => isStructural || (counts.get(p.id) ?? 0) < 2,
    );
    if (!options.length) continue;
    const recipe = pick(rng, options);
    counts.set(recipe.id, (counts.get(recipe.id) ?? 0) + 1);
    out.push(withText({ slot: slot.id, recipe: recipe.id }, data, rng, opts.index));
  }
  return out;

  function withText(a: Assignment, d: GameData, r: Rng, index: number): Assignment {
    const recipe = d.props.find((p) => p.id === a.recipe)!;
    if (recipe.text) a.surfaceText = recipe.interact === 'button' ? 'PRESS' : textFor(recipe.text.style, r, index);
    if (recipe.inspectable) {
      const pool = t.inspect[recipe.id] ?? (a.surfaceText ? [] : t.inspect.default ?? []);
      a.inspectText = pool.length ? pick(r, pool) : a.surfaceText;
    }
    return a;
  }

  function textFor(style: TextStyle, r: Rng, index: number): string {
    const pool = {
      sign: t.signs, poster: t.posters, screen: t.screens, whiteboard: t.whiteboards, paper: t.papers, label: t.labels,
    }[style];
    const fresh = pool.filter((x) => !usedText.has(x));
    const text = pick(r, fresh.length ? fresh : pool);
    usedText.add(text);
    return text.replaceAll('{next}', String(index + 2));
  }
}
