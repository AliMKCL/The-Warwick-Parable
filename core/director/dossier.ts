import type { LlmClient } from '../llm/client';
import { TRAITS } from '../profile/profile';
import type { Dossier, Evidence, TraitName, Verdict } from '../protocol';
import type { GameData } from '../room/types';
import type { Run } from '../run/run';
import { fill } from './prompts';

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'summary', 'hesitation', 'curiosity', 'compliance', 'impulsivity', 'closing'],
  properties: {
    name: { type: 'string', maxLength: 48 },
    summary: { type: 'string', maxLength: 420 },
    hesitation: { type: 'string', maxLength: 170 },
    curiosity: { type: 'string', maxLength: 170 },
    compliance: { type: 'string', maxLength: 170 },
    impulsivity: { type: 'string', maxLength: 170 },
    closing: { type: 'string', maxLength: 180 },
  },
};

/** The strongest pieces of evidence for each trait. */
export function topMoments(evidence: Evidence[], n = 3): Record<TraitName, Evidence[]> {
  const out = {} as Record<TraitName, Evidence[]>;
  for (const t of TRAITS) out[t] = evidence.filter((e) => e.trait === t).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, n);
  return out;
}

/** Asks the model for the verdict; falls back to a template after `timeoutMs` or on any failure. */
export async function writeVerdict(run: Run, data: GameData, llm?: LlmClient, timeoutMs = 20000): Promise<{ verdict: Verdict; source: 'model' | 'template' }> {
  const fallback = { verdict: templateVerdict(run), source: 'template' as const };
  if (!llm || run.modelOff) return fallback;
  const p = data.prompts;
  const moments = topMoments(run.profile.evidence, 5);
  const user = fill(p.dossierUser, {
    rooms: run.rooms.map((r) => `- Room ${r.index} "${r.title}" (${r.layout.archetype.replace('_', ' ')}, ${r.ambience}${r.rule ? `, rule: ${r.rule.id.replaceAll('_', ' ')}` : ''})`).join('\n'),
    traits: TRAITS.map((t) => `## ${t}: ${run.profile.traits[t].toFixed(2)}\n${moments[t].map((e) => `- room ${e.room}: ${e.reason} (${e.delta > 0 ? '+' : ''}${e.delta})`).join('\n') || '- no evidence'}`).join('\n'),
    threads: run.threads.map((t) => `- ${t.text}${t.resolvedIn !== undefined ? ` (explained in room ${t.resolvedIn})` : ' (never explained)'}`).join('\n') || '- none',
    minutes: Math.max(1, Math.round((run.events.at(-1)?.t ?? 0) / 60)),
    inspected: run.events.filter((e) => e.type === 'inspected').length,
  });
  const timer = globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown };
  try {
    const res = await Promise.race([
      llm.completeJson<Verdict>({
        messages: [{ role: 'system', content: fill(p.dossierSystem, { world: p.world.trim() }) }, { role: 'user', content: user }],
        schema: VERDICT_SCHEMA,
        schemaName: 'verdict',
        maxTokens: 600,
        temperature: 0.8,
      }),
      new Promise<'timeout'>((r) => timer.setTimeout(() => r('timeout'), timeoutMs)),
    ]);
    if (res === 'timeout' || !res.value?.name || !res.value?.summary) return fallback;
    return { verdict: res.value, source: 'model' };
  } catch {
    return fallback;
  }
}

const NAMES: Record<TraitName, [low: string, high: string]> = {
  hesitation: ['The Decider', 'The Lingerer'],
  curiosity: ['The Shortcut', 'The Reader'],
  compliance: ['The Contrarian', 'The Model Employee'],
  impulsivity: ['The Careful One', 'The Button-Presser'],
};

/** A verdict built from the evidence alone, for when the model is unavailable. */
export function templateVerdict(run: Run): Verdict {
  const ranked = run.profile.ranked();
  const top = ranked[0]!;
  const name = NAMES[top.trait][top.value >= 0.5 ? 1 : 0];
  const moments = topMoments(run.profile.evidence, 1);
  const line = (t: TraitName) => {
    const m = moments[t][0];
    const v = run.profile.traits[t];
    return m ? `${v >= 0.5 ? 'Noted' : 'Also noted'}: you ${m.reason}.` : 'Nothing worth recording. Which is itself a record.';
  };
  const strongest = run.profile.evidence.slice().sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
  return {
    name,
    summary: `${top.words[0]!.toUpperCase()}${top.words.slice(1).split(':')[0]}, by every measure we have.${strongest ? ` The clearest sign: you ${strongest.reason}.` : ''} The building has adjusted itself accordingly.`,
    hesitation: line('hesitation'),
    curiosity: line('curiosity'),
    compliance: line('compliance'),
    impulsivity: line('impulsivity'),
    closing: 'Your file is complete. The building will remember you, even if you do not remember it.',
  };
}

export function buildDossier(run: Run, verdict: Verdict, source: 'model' | 'template'): Dossier {
  const ev = run.events;
  return {
    seed: run.seed,
    seconds: Math.round(ev.at(-1)?.t ?? 0),
    verdict,
    verdictSource: source,
    traits: { ...run.profile.traits },
    moments: topMoments(run.profile.evidence),
    rooms: run.rooms.map((r, i) => ({
      index: r.index,
      title: r.title,
      archetype: r.layout.archetype,
      ambience: r.ambience,
      source: r.source,
      genMs: r.genMs,
      rule: r.rule?.id,
      fact: r.fact,
      traitsAtEntry: run.traitHistory[i] ?? { ...run.profile.traits },
      behaviour: r.provenance?.behaviour ?? [],
      profile: r.provenance?.profile ?? [],
      seed: r.seed,
      size: `${r.layout.width}×${r.layout.depth} m`,
    })),
    threads: run.threads.map(({ text, room, resolvedIn }) => ({ text, room, resolvedIn })),
    stats: {
      inspected: ev.filter((e) => e.type === 'inspected').length,
      pressed: ev.filter((e) => e.type === 'pressed').length,
      stoodStill: Math.round(ev.reduce((a, e) => a + (e.type === 'idle' ? e.seconds : 0), 0)),
      doorsTried: ev.filter((e) => e.type === 'door_tried').length,
    },
    tasks: run.finalTaskResults(),
    baseline: { ...(run.baseline() ?? {}) },
  };
}
