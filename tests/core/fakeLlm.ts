import type { LlmClient } from '../../core/llm/client';
import { LlmError } from '../../core/llm/client';
import type { JsonRequest } from '../../core/llm/types';

/**
 * A stand-in for the model. It reads the prompt like the real model would
 * (slot IDs and their allowed props) and answers with valid content, unless
 * told to misbehave.
 */
export function fakeLlm(o: {
  mode?: 'good' | 'bad-then-good' | 'always-bad' | 'down';
  delayMs?: number;
  calls?: { user: string }[];
} = {}): LlmClient {
  let n = 0;
  return {
    config: { provider: 'ollama', baseUrl: 'fake', model: 'fake' },
    async completeJson<T>(req: JsonRequest) {
      n++;
      const user = req.messages.filter((m) => m.role === 'user').at(-1)!.content;
      o.calls?.push({ user: req.messages[1]!.content });
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      if ((req.signal as AbortSignal | undefined)?.aborted) throw new LlmError('Request cancelled', 'aborted');
      if (o.mode === 'down') throw new LlmError('Cannot reach the model server', 'unreachable');
      const bad = o.mode === 'always-bad' || (o.mode === 'bad-then-good' && n === 1);
      if (bad) return { value: { title: 'x', slots: [] } as T, raw: '{"title":"x","slots":[]}', timings: { totalMs: 1 } };
      const prompt = req.messages[1]!.content;
      const slots = [...prompt.matchAll(/^- (s\d+): .*Allowed: (.+)$/gm)].map((m) => ({ slot: m[1]!, prop: m[2]!.split(', ')[0]! }));
      const doors = [...prompt.matchAll(/^- (d\d+): on the/gm)].map((m) => m[1]!);
      const value = {
        title: 'The Room of Second Thoughts',
        ambience: 'warm',
        slots: slots.map((s) => ({ ...s, text: 'YOU HESITATED', inspect: 'It knows you waited.' })),
        doors: doors.map((d, i) => ({ door: d, label: `door ${i}`, line: 'Go on.' })),
        suggest_door: /recommends one exit/.test(prompt) ? doors[0] : undefined,
        rule_line: /# This room's rule\nNone/.test(prompt) ? '' : 'There is a rule here.',
        rule_done_line: /# This room's rule\nNone/.test(prompt) ? '' : 'The rule is satisfied.',
        narrator_enter: 'You took your time. The building noticed.',
        thread_plant: 'Someone else has your badge.',
        thread_resolve: /^- (t\d+):/m.exec(prompt)?.[1] ?? 'none',
        fact: 'The building keeps a record of every pause.',
      };
      void user;
      return { value: value as T, raw: JSON.stringify(value), timings: { totalMs: 5 } };
    },
    async streamText(_req, onChunk) {
      if (o.mode === 'down') throw new LlmError('down', 'unreachable');
      onChunk('Interesting');
      onChunk('Interesting choice.');
      return { text: 'Interesting choice.', timings: { totalMs: 2 } };
    },
    async ping() {
      return { ok: o.mode !== 'down', models: ['fake'], hasModel: o.mode !== 'down' };
    },
  };
}
