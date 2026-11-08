import { LlmError, type LlmClient } from '../llm/client';
import type { ChatMessage, LlmTimings } from '../llm/types';
import { placeInSlot } from '../room/geometry';
import type { Assignment } from '../room/place';
import type { GameData, Layout, Side, Slot } from '../room/types';
import { pick, type Rng } from '../util/random';
import { describeRule, type RoomRule } from '../rules/rules';
import { fill, storyStage } from './prompts';
import { roomContentSchema, type ModelRoomContent } from './schema';

export interface ContentContext {
  index: number;
  layout: Layout;
  entranceLabel: string;
  /** One line per earlier room: title and the fact it established. */
  story: string[];
  /** What the player has done, newest room last. */
  behaviour: string[];
  /** Trait readout, strongest first. */
  profile: string[];
  /** The mechanic this room will run, if any. */
  rule?: Omit<RoomRule, 'line' | 'doneLine'>;
  /** Unresolved story threads. */
  threads: { id: string; text: string }[];
  /** Rooms in this run, counting the first. */
  runLength: number;
  data: GameData;
}

export interface GeneratedContent {
  content: ModelRoomContent;
  /** The model's slot choices as placement requests. */
  assignments: Assignment[];
  /** Slots the model was asked to fill (the rest get plain furniture). */
  modelSlots: Set<string>;
  timings: LlmTimings;
  repaired: boolean;
}

const MAX_MODEL_SLOTS = 8;
const WALL: Record<Side, string> = { n: 'north', s: 'south', e: 'east', w: 'west' };

/**
 * Chooses which slots the model fills: everything that shows text or draws
 * the eye (wall-mounted, centre, desks), up to a cap so output stays short.
 */
export function pickModelSlots(layout: Layout, data: GameData, rng: Rng): Slot[] {
  const fitsText = (s: Slot) => data.props.some((p) => p.text && placeInSlot(p, s));
  const ranked = layout.slots
    .filter((s) => !s.tags.includes('partition'))
    .map((s) => ({ s, score: (s.kind === 'center' ? 3 : s.kind === 'wall_mounted' ? 2 : s.tags.includes('desk') ? 1.5 : fitsText(s) ? 1 : 0) + rng() }))
    .filter((x) => x.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MODEL_SLOTS);
  return ranked.map((x) => x.s);
}

export function buildRoomMessages(ctx: ContentContext, slots: Slot[]): { messages: ChatMessage[]; schema: Record<string, unknown>; propIds: string[] } {
  const { data, layout } = ctx;
  const p = data.prompts;
  const catalogue = data.props
    .map((r) => `| ${r.id} | ${r.name.toLowerCase()} | ${r.text ? r.text.style : 'no text'} |`)
    .join('\n');
  const system = fill(p.roomSystem, { world: p.world.trim(), catalogue });

  const allowed = (s: Slot) => data.props.filter((r) => placeInSlot(r, s)).map((r) => r.id);
  const slotLines = slots.map((s) => {
    const where =
      s.kind === 'wall_mounted' ? `on the ${WALL[s.side!]} wall, at eye level`
      : s.kind === 'wall' ? `against the ${WALL[s.side!]} wall`
      : s.kind === 'center' ? 'in the middle of the room'
      : s.tags.includes('desk') ? 'a desk position on the floor'
      : 'on the floor';
    return `- ${s.id}: ${where}, ${Math.max(...s.span)} m wide. Allowed: ${allowed(s).join(', ')}`;
  });
  const exits = layout.doors.filter((d) => !d.entrance);
  const user = fill(p.roomUser, {
    index: ctx.index,
    total: ctx.runLength - 1,
    stage: storyStage(ctx.index, ctx.runLength - 1),
    profile: ctx.profile.map((s) => `- ${s}`).join('\n'),
    rule: ctx.rule ? describeRule(ctx.rule) : 'None. Leave "rule_line" and "rule_done_line" empty.',
    threads: ctx.threads.length ? ctx.threads.map((t) => `- ${t.id}: ${t.text}`).join('\n') : '- None yet.',
    archetype: layout.archetype.replace('_', ' '),
    width: layout.width,
    depth: layout.depth,
    ceiling: layout.ceiling,
    entrance_label: ctx.entranceLabel || 'unmarked',
    ambiences: Object.keys(data.ambience).join(', '),
    story: ctx.story.length ? ctx.story.map((s) => `- ${s}`).join('\n') : '- Nothing yet. This is the first room after the waiting room.',
    behaviour: ctx.behaviour.length ? ctx.behaviour.map((s) => `- ${s}`).join('\n') : '- Nothing recorded yet.',
    min_slots: Math.min(3, slots.length),
    slots: slotLines.join('\n'),
    exits: exits.map((d) => `- ${d.id}: on the ${WALL[d.side]} wall`).join('\n'),
  });

  const propIds = [...new Set(slots.flatMap(allowed))];
  const schema = roomContentSchema({
    slotIds: slots.map((s) => s.id),
    propIds,
    exitIds: exits.map((d) => d.id),
    ambiences: Object.keys(data.ambience),
    minSlots: Math.min(3, slots.length),
    maxSlots: slots.length,
    threadIds: ctx.threads.map((t) => t.id),
    suggest: ctx.rule?.id === 'narrator_suggests',
  });
  return { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], schema, propIds };
}

/**
 * Asks the model for a room's content. If the answer is unusable, the
 * problems are sent back once for a corrected answer. Throws if both fail,
 * and the caller falls back to templates.
 */
export async function generateRoomContent(
  llm: LlmClient,
  ctx: ContentContext,
  rng: Rng,
  signal?: unknown,
): Promise<GeneratedContent> {
  const slots = pickModelSlots(ctx.layout, ctx.data, rng);
  const { messages, schema } = buildRoomMessages(ctx, slots);
  const ask = (msgs: ChatMessage[]) =>
    llm.completeJson<ModelRoomContent>({ messages: msgs, schema, schemaName: 'room_content', maxTokens: 900, temperature: 0.85, signal });

  let repaired = false;
  let res;
  let problems: string[] = [];
  try {
    res = await ask(messages);
    problems = checkContent(res.value, ctx, slots);
  } catch (err) {
    if (err instanceof LlmError && err.kind !== 'bad_output') throw err;
    problems = [(err as Error).message];
  }
  if (problems.length) {
    repaired = true;
    const retry: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: res?.raw ?? '' },
      { role: 'user', content: `That answer has problems:\n${problems.map((p) => `- ${p}`).join('\n')}\nReturn the corrected JSON only.` },
    ];
    res = await ask(retry);
    problems = checkContent(res.value, ctx, slots);
    if (problems.length) throw new LlmError(`Model content unusable after repair: ${problems.join('; ')}`, 'bad_output');
  }
  const content = res!.value;
  const assignments: Assignment[] = content.slots.map((s) => ({
    slot: s.slot,
    recipe: s.prop,
    surfaceText: s.text?.replace(/\\n/g, '\n').trim() || undefined,
    inspectText: s.inspect?.trim() || undefined,
    featured: true,
  }));
  return { content, assignments, modelSlots: new Set(slots.map((s) => s.id)), timings: res!.timings, repaired };
}

/** Problems worth one repair round. Minor issues (a prop that won't fit) are handled later by placement instead. */
function checkContent(c: ModelRoomContent, ctx: ContentContext, slots: Slot[]): string[] {
  const problems: string[] = [];
  if (!c || typeof c !== 'object') return ['answer is not a JSON object'];
  if (!Array.isArray(c.slots) || !c.slots.length) problems.push('"slots" is empty');
  if (!c.narrator_enter?.trim()) problems.push('"narrator_enter" is empty');
  const exits = ctx.layout.doors.filter((d) => !d.entrance).map((d) => d.id);
  const named = new Set((c.doors ?? []).map((d) => d.door));
  const missing = exits.filter((id) => !named.has(id));
  if (missing.length) problems.push(`doors missing: ${missing.join(', ')}`);
  if (ctx.rule && !c.rule_line?.trim()) problems.push('"rule_line" is empty but this room has a rule');
  if (ctx.rule?.id === 'narrator_suggests' && !exits.includes(c.suggest_door ?? '')) problems.push('"suggest_door" must be one of the exit ids');
  const slotIds = new Set(slots.map((s) => s.id));
  const unknown = (c.slots ?? []).filter((s) => !slotIds.has(s.slot)).map((s) => s.slot);
  if (unknown.length) problems.push(`unknown slots: ${unknown.join(', ')}`);
  const usable = (c.slots ?? []).filter((s) => {
    const slot = slots.find((x) => x.id === s.slot);
    const recipe = ctx.data.props.find((r) => r.id === s.prop);
    return slot && recipe && placeInSlot(recipe, slot);
  });
  if (c.slots?.length && usable.length < Math.ceil(c.slots.length / 2))
    problems.push('most props were put in slots they do not fit; use only the allowed IDs for each slot');
  return problems;
}

/** A spoken reaction when the player walks through a door. Template fallback when there is no model. */
export function fallbackDoorLine(data: GameData, rng: Rng): string {
  return pick(rng, data.templates.narratorDoor);
}
