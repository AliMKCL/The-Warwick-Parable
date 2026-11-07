/**
 * Model access, kept free of browser and Node types so core stays portable.
 * The adapter (or a Node script) passes in its own fetch and clock.
 */

export type LlmProvider = 'ollama' | 'openai';

export interface LlmConfig {
  provider: LlmProvider;
  /** Browser: '/llm' (the Vite proxy). Node: the server address, e.g. http://127.0.0.1:11434 */
  baseUrl: string;
  model: string;
  apiKey?: string;
}

/** The subset of fetch core needs. globalThis.fetch satisfies it in browsers and Node 22+. */
export type HttpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface LlmDeps {
  fetch: HttpFetch;
  /** Milliseconds; performance.now in the browser, Date.now is fine in Node. */
  now: () => number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface JsonRequest {
  messages: ChatMessage[];
  /** A JSON Schema the output must follow (constrained decoding where the server supports it). */
  schema: Record<string, unknown>;
  schemaName: string;
  maxTokens: number;
  temperature?: number;
}

export interface LlmTimings {
  totalMs: number;
  promptTokens?: number;
  outputTokens?: number;
  /** Output tokens per second, when the server reports it. */
  outputTokensPerSec?: number;
}

export interface JsonResult<T> {
  value: T;
  raw: string;
  timings: LlmTimings;
}
