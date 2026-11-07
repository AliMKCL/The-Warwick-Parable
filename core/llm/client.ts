import { extractJson } from './json';
import type { HttpFetch, JsonRequest, JsonResult, LlmConfig, LlmDeps, LlmTimings } from './types';

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: 'unreachable' | 'http' | 'bad_output',
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface LlmClient {
  readonly config: LlmConfig;
  /** One request whose output must match req.schema. */
  completeJson<T = unknown>(req: JsonRequest): Promise<JsonResult<T>>;
  /** Cheap reachability check: lists models and confirms the configured one is there. */
  ping(): Promise<{ ok: boolean; models: string[]; hasModel: boolean; error?: string }>;
}

export function createLlmClient(config: LlmConfig, deps: LlmDeps): LlmClient {
  const base = config.baseUrl.replace(/\/$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

  async function post(path: string, body: unknown): Promise<unknown> {
    const res = await call(deps.fetch, `${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    return res;
  }

  return {
    config,

    async completeJson<T>(req: JsonRequest): Promise<JsonResult<T>> {
      const started = deps.now();
      let content: string;
      let timings: LlmTimings;

      if (config.provider === 'ollama') {
        const data = (await post('/api/chat', {
          model: config.model,
          messages: req.messages,
          stream: false,
          format: req.schema,
          think: false,
          options: { temperature: req.temperature ?? 0.8, num_predict: req.maxTokens },
        })) as OllamaChatResponse;
        content = data.message?.content ?? '';
        timings = {
          totalMs: deps.now() - started,
          promptTokens: data.prompt_eval_count,
          outputTokens: data.eval_count,
          outputTokensPerSec:
            data.eval_count && data.eval_duration ? data.eval_count / (data.eval_duration / 1e9) : undefined,
        };
      } else {
        const data = (await post('/v1/chat/completions', {
          model: config.model,
          messages: req.messages,
          max_tokens: req.maxTokens,
          temperature: req.temperature ?? 0.8,
          response_format: {
            type: 'json_schema',
            json_schema: { name: req.schemaName, schema: req.schema, strict: true },
          },
        })) as OpenAiChatResponse;
        content = data.choices?.[0]?.message?.content ?? '';
        const totalMs = deps.now() - started;
        timings = {
          totalMs,
          promptTokens: data.usage?.prompt_tokens,
          outputTokens: data.usage?.completion_tokens,
        };
      }

      try {
        return { value: extractJson(content) as T, raw: content, timings };
      } catch (err) {
        throw new LlmError((err as Error).message, 'bad_output');
      }
    },

    async ping() {
      try {
        if (config.provider === 'ollama') {
          const data = (await call(deps.fetch, `${base}/api/tags`, { method: 'GET', headers })) as OllamaTags;
          const models = (data.models ?? []).map((m) => m.name);
          return { ok: true, models, hasModel: models.some((m) => sameModel(m, config.model)) };
        }
        const data = (await call(deps.fetch, `${base}/v1/models`, { method: 'GET', headers })) as OpenAiModels;
        const models = (data.data ?? []).map((m) => m.id);
        return { ok: true, models, hasModel: models.some((m) => sameModel(m, config.model)) };
      } catch (err) {
        return { ok: false, models: [], hasModel: false, error: (err as Error).message };
      }
    },
  };
}

function sameModel(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/:latest$/, '');
  return norm(a) === norm(b);
}

async function call(
  fetchFn: HttpFetch,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<unknown> {
  let res;
  try {
    res = await fetchFn(url, init);
  } catch (err) {
    throw new LlmError(`Cannot reach the model server at ${url}: ${(err as Error).message}`, 'unreachable');
  }
  const text = await res.text();
  if (!res.ok) throw new LlmError(`Model server answered ${res.status}: ${text.slice(0, 300)}`, 'http', res.status);
  try {
    return JSON.parse(text);
  } catch {
    throw new LlmError(`Model server sent non-JSON: ${text.slice(0, 160)}`, 'bad_output');
  }
}

interface OllamaChatResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;
}
interface OllamaTags {
  models?: { name: string }[];
}
interface OpenAiChatResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}
interface OpenAiModels {
  data?: { id: string }[];
}
