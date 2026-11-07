import { extractJson } from './json';
import type {
  ByteStream, HttpFetch, JsonRequest, JsonResult, LlmConfig, LlmDeps, LlmTimings, TextRequest,
} from './types';

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: 'unreachable' | 'http' | 'bad_output' | 'aborted',
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface LlmClient {
  readonly config: LlmConfig;
  /** One request whose output must match req.schema. */
  completeJson<T = unknown>(req: JsonRequest): Promise<JsonResult<T>>;
  /** Free text, delivered piece by piece as it is generated. */
  streamText(req: TextRequest, onChunk: (textSoFar: string) => void): Promise<{ text: string; timings: LlmTimings }>;
  /** Cheap reachability check: lists models and confirms the configured one is there. */
  ping(): Promise<{ ok: boolean; models: string[]; hasModel: boolean; error?: string }>;
}

export function createLlmClient(config: LlmConfig, deps: LlmDeps): LlmClient {
  const base = config.baseUrl.replace(/\/$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  const ollama = config.provider === 'ollama';

  return {
    config,

    async completeJson<T>(req: JsonRequest): Promise<JsonResult<T>> {
      const started = deps.now();
      let content: string;
      let timings: LlmTimings;
      const init = (body: unknown) => ({ method: 'POST', headers, body: JSON.stringify(body), signal: req.signal });

      if (ollama) {
        const data = (await call(deps.fetch, `${base}/api/chat`, init({
          model: config.model,
          messages: req.messages,
          stream: false,
          format: req.schema,
          think: false,
          keep_alive: '30m',
          options: { temperature: req.temperature ?? 0.8, num_predict: req.maxTokens },
        }))) as OllamaChatResponse;
        content = data.message?.content ?? '';
        timings = {
          totalMs: deps.now() - started,
          promptTokens: data.prompt_eval_count,
          outputTokens: data.eval_count,
          outputTokensPerSec:
            data.eval_count && data.eval_duration ? data.eval_count / (data.eval_duration / 1e9) : undefined,
        };
      } else {
        const data = (await call(deps.fetch, `${base}/v1/chat/completions`, init({
          model: config.model,
          messages: req.messages,
          max_tokens: req.maxTokens,
          temperature: req.temperature ?? 0.8,
          response_format: { type: 'json_schema', json_schema: { name: req.schemaName, schema: req.schema, strict: true } },
        }))) as OpenAiChatResponse;
        content = data.choices?.[0]?.message?.content ?? '';
        timings = {
          totalMs: deps.now() - started,
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

    async streamText(req, onChunk) {
      const started = deps.now();
      let firstTokenMs: number | undefined;
      const body = ollama
        ? { model: config.model, messages: req.messages, stream: true, think: false, keep_alive: '30m',
            options: { temperature: req.temperature ?? 0.9, num_predict: req.maxTokens } }
        : { model: config.model, messages: req.messages, stream: true, max_tokens: req.maxTokens, temperature: req.temperature ?? 0.9 };
      const url = ollama ? `${base}/api/chat` : `${base}/v1/chat/completions`;
      let res;
      try {
        res = await deps.fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: req.signal });
      } catch (err) {
        throw toLlmError(err, url);
      }
      if (!res.ok) throw new LlmError(`Model server answered ${res.status}: ${(await res.text()).slice(0, 300)}`, 'http', res.status);

      let text = '';
      let outputTokens: number | undefined;
      const handleLine = (line: string) => {
        const l = line.trim();
        if (!l) return;
        let piece = '';
        if (ollama) {
          const j = safeJson(l) as OllamaStreamChunk | undefined;
          piece = j?.message?.content ?? '';
          if (j?.done) outputTokens = j.eval_count;
        } else {
          if (!l.startsWith('data:')) return;
          const payload = l.slice(5).trim();
          if (payload === '[DONE]') return;
          piece = (safeJson(payload) as OpenAiStreamChunk | undefined)?.choices?.[0]?.delta?.content ?? '';
        }
        if (piece) {
          if (firstTokenMs === undefined) firstTokenMs = deps.now() - started;
          text += piece;
          onChunk(cleanText(text));
        }
      };
      try {
        if (res.body) await readLines(res.body, handleLine);
        else (await res.text()).split('\n').forEach(handleLine);
      } catch (err) {
        throw toLlmError(err, url);
      }
      return { text: cleanText(text), timings: { totalMs: deps.now() - started, firstTokenMs, outputTokens } };
    },

    async ping() {
      try {
        if (ollama) {
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

/** Remove reasoning blocks and wrapping quotes from free text. */
function cleanText(s: string): string {
  return s.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim().replace(/^["“]|["”]$/g, '');
}

async function readLines(stream: ByteStream, onLine: (line: string) => void) {
  const Decoder = (globalThis as unknown as { TextDecoder: new () => { decode(b?: Uint8Array, o?: { stream: boolean }): string } }).TextDecoder;
  const decoder = new Decoder();
  const reader = stream.getReader();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      onLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer) onLine(buffer);
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return undefined; }
}

function sameModel(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/:latest$/, '');
  return norm(a) === norm(b);
}

function toLlmError(err: unknown, url: string): LlmError {
  if (err instanceof LlmError) return err;
  const e = err as { name?: string; message?: string };
  if (e?.name === 'AbortError') return new LlmError('Request cancelled', 'aborted');
  return new LlmError(`Cannot reach the model server at ${url}: ${e?.message ?? String(err)}`, 'unreachable');
}

async function call(
  fetchFn: HttpFetch,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: unknown },
): Promise<unknown> {
  let res;
  try {
    res = await fetchFn(url, init);
  } catch (err) {
    throw toLlmError(err, url);
  }
  const text = await res.text();
  if (!res.ok) throw new LlmError(`Model server answered ${res.status}: ${text.slice(0, 300)}`, 'http', res.status);
  try {
    return JSON.parse(text);
  } catch {
    throw new LlmError(`Model server sent non-JSON: ${text.slice(0, 160)}`, 'bad_output');
  }
}

interface OllamaChatResponse { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number; eval_duration?: number }
interface OllamaStreamChunk { message?: { content?: string }; done?: boolean; eval_count?: number }
interface OllamaTags { models?: { name: string }[] }
interface OpenAiChatResponse { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }
interface OpenAiStreamChunk { choices?: { delta?: { content?: string } }[] }
interface OpenAiModels { data?: { id: string }[] }
