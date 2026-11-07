import { describe, expect, it } from 'vitest';
import { createLlmClient, LlmError } from '../../core/llm/client';
import { extractJson } from '../../core/llm/json';
import type { HttpFetch } from '../../core/llm/types';

const schema = { type: 'object', properties: { a: { type: 'number' } } };
const req = { messages: [{ role: 'user' as const, content: 'hi' }], schema, schemaName: 't', maxTokens: 50 };

function mockFetch(handler: (url: string, body: any) => { status?: number; json?: unknown; text?: string }): {
  fetch: HttpFetch;
  calls: { url: string; body: any }[];
} {
  const calls: { url: string; body: any }[] = [];
  const fetch: HttpFetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    const r = handler(url, body);
    const text = r.text ?? JSON.stringify(r.json);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => text };
  };
  return { fetch, calls };
}

let clock = 0;
const now = () => (clock += 100);

describe('LLM client', () => {
  it('sends schema-constrained, non-thinking requests to Ollama and reports speed', async () => {
    const { fetch, calls } = mockFetch(() => ({
      json: { message: { content: '{"a": 1}' }, prompt_eval_count: 20, eval_count: 10, eval_duration: 0.5e9 },
    }));
    const client = createLlmClient({ provider: 'ollama', baseUrl: '/llm', model: 'm' }, { fetch, now });
    const res = await client.completeJson<{ a: number }>(req);
    expect(res.value.a).toBe(1);
    expect(res.timings.outputTokensPerSec).toBe(20);
    expect(calls[0]?.url).toBe('/llm/api/chat');
    expect(calls[0]?.body.format).toEqual(schema);
    expect(calls[0]?.body.think).toBe(false);
    expect(calls[0]?.body.options.num_predict).toBe(50);
  });

  it('uses json_schema response_format for OpenAI-compatible servers', async () => {
    const { fetch, calls } = mockFetch(() => ({
      json: { choices: [{ message: { content: '<think>hmm</think>{"a": 2}' } }], usage: { completion_tokens: 5 } },
    }));
    const client = createLlmClient({ provider: 'openai', baseUrl: 'http://x/', model: 'm' }, { fetch, now });
    const res = await client.completeJson<{ a: number }>(req);
    expect(res.value.a).toBe(2);
    expect(calls[0]?.url).toBe('http://x/v1/chat/completions');
    expect(calls[0]?.body.response_format.type).toBe('json_schema');
  });

  it('classifies failures', async () => {
    const down: HttpFetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const c1 = createLlmClient({ provider: 'ollama', baseUrl: '/llm', model: 'm' }, { fetch: down, now });
    await expect(c1.completeJson(req)).rejects.toMatchObject({ kind: 'unreachable' });

    const { fetch } = mockFetch(() => ({ status: 404, text: 'model not found' }));
    const c2 = createLlmClient({ provider: 'ollama', baseUrl: '/llm', model: 'm' }, { fetch, now });
    await expect(c2.completeJson(req)).rejects.toBeInstanceOf(LlmError);
  });

  it('ping finds the configured model', async () => {
    const { fetch } = mockFetch(() => ({ json: { models: [{ name: 'qwen3.6:35b-a3b' }, { name: 'llama3:latest' }] } }));
    const client = createLlmClient({ provider: 'ollama', baseUrl: '/llm', model: 'qwen3.6:35b-a3b' }, { fetch, now });
    expect(await client.ping()).toMatchObject({ ok: true, hasModel: true });
    const other = createLlmClient({ provider: 'ollama', baseUrl: '/llm', model: 'llama3' }, { fetch, now });
    expect((await other.ping()).hasModel).toBe(true);
  });
});

describe('extractJson', () => {
  it('handles fences and stray text', () => {
    expect(extractJson('```json\n{"x":1}\n```')).toEqual({ x: 1 });
    expect(extractJson('Sure! {"x":2} hope that helps')).toEqual({ x: 2 });
    expect(() => extractJson('no json here')).toThrow();
  });
});
