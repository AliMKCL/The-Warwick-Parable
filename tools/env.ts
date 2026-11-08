import { existsSync } from 'node:fs';
import type { LlmConfig, LlmProvider } from '../core/llm/types';
import { isOpenRouter, OPENROUTER_EXTRA } from '../core/llm/cloud';

/** Loads .env then .env.local (later wins) into process.env, like Vite does. */
export function loadProjectEnv(): void {
  for (const file of ['.env', '.env.local']) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

export function llmConfigFromEnv(): LlmConfig {
  const provider = (process.env.LLM_PROVIDER || 'ollama') as LlmProvider;
  return {
    provider,
    baseUrl: process.env.LLM_BASE_URL || (provider === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234'),
    model: process.env.LLM_MODEL || 'qwen3.6:35b-a3b',
    apiKey: process.env.LLM_API_KEY || undefined,
    noThinking:
      provider === 'openai' &&
      /127\.0\.0\.1|localhost/.test(process.env.LLM_BASE_URL || 'http://127.0.0.1:1234') &&
      !isOpenRouter(process.env.LLM_BASE_URL || '', process.env.LLM_OPENROUTER),
    extraBody: isOpenRouter(process.env.LLM_BASE_URL || '', process.env.LLM_OPENROUTER) ? OPENROUTER_EXTRA : undefined,
  };
}

/** Rooms generated at the same time (LLM_PARALLEL). */
export function parallelFromEnv(): number {
  return Math.max(1, Number(process.env.LLM_PARALLEL) || 1);
}
