import { existsSync } from 'node:fs';
import type { LlmConfig, LlmProvider } from '../core/llm/types';

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
  };
}
