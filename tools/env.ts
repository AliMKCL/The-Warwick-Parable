import { existsSync } from 'node:fs';
import type { LlmConfig } from '../core/llm/types';
import { resolveLlmEnv } from './llm-env';

/** Loads .env then .env.local (later wins) into process.env, like Vite does. */
export function loadProjectEnv(): void {
  for (const file of ['.env', '.env.local']) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

export function llmConfigFromEnv(): LlmConfig & { label: string; problem?: string } {
  return resolveLlmEnv(process.env);
}

/** Rooms generated at the same time (LLM_PARALLEL). */
export function parallelFromEnv(): number {
  return resolveLlmEnv(process.env).parallel;
}
