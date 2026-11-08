/**
 * Reads the model settings from .env.local (shared by the dev server and the
 * Node scripts). Pure function: no Node APIs, so vite.config can import it.
 *
 *   MODEL_BACKEND        openrouter | ollama | lmstudio
 *   PARALLEL_ROOMS       rooms generated at the same time (1 for local servers that queue)
 *   OPENROUTER_API_KEY   OPENROUTER_MODEL
 *   OLLAMA_URL           OLLAMA_MODEL
 *   LMSTUDIO_URL         LMSTUDIO_MODEL
 *
 * The older LLM_PROVIDER / LLM_BASE_URL / LLM_MODEL / LLM_API_KEY / LLM_PARALLEL
 * names still work when MODEL_BACKEND is not set.
 */
import { OPENROUTER_EXTRA } from '../core/llm/cloud';
import type { LlmConfig } from '../core/llm/types';

export type Backend = 'openrouter' | 'ollama' | 'lmstudio';

export interface ResolvedLlmEnv extends LlmConfig {
  backend: Backend;
  parallel: number;
  /** One line for logs and the start screen, e.g. "OpenRouter · qwen/qwen3.6-35b-a3b · 3 at a time". */
  label: string;
  /** Set when the settings are incomplete. */
  problem?: string;
}

export function resolveLlmEnv(env: Record<string, string | undefined>): ResolvedLlmEnv {
  const backend = pickBackend(env);
  const parallel = Math.max(1, Number(env.PARALLEL_ROOMS ?? env.LLM_PARALLEL) || 1);
  let out: ResolvedLlmEnv;

  if (backend === 'openrouter') {
    const apiKey = env.OPENROUTER_API_KEY || (env.MODEL_BACKEND ? '' : env.LLM_API_KEY) || '';
    out = {
      backend, parallel, provider: 'openai',
      baseUrl: env.OPENROUTER_URL || 'https://openrouter.ai/api',
      model: env.OPENROUTER_MODEL || (env.MODEL_BACKEND ? '' : env.LLM_MODEL) || 'qwen/qwen3.6-35b-a3b',
      apiKey,
      extraBody: OPENROUTER_EXTRA,
      label: '',
      problem: apiKey ? undefined : 'OPENROUTER_API_KEY is empty',
    };
  } else if (backend === 'lmstudio') {
    out = {
      backend, parallel, provider: 'openai',
      baseUrl: env.LMSTUDIO_URL || (env.MODEL_BACKEND ? '' : env.LLM_BASE_URL) || 'http://127.0.0.1:1234',
      model: env.LMSTUDIO_MODEL || (env.MODEL_BACKEND ? '' : env.LLM_MODEL) || '',
      noThinking: true,
      label: '',
    };
    if (!out.model) out.problem = 'LMSTUDIO_MODEL is empty';
  } else {
    out = {
      backend, parallel, provider: 'ollama',
      baseUrl: env.OLLAMA_URL || (env.MODEL_BACKEND ? '' : env.LLM_BASE_URL) || 'http://127.0.0.1:11434',
      model: env.OLLAMA_MODEL || (env.MODEL_BACKEND ? '' : env.LLM_MODEL) || 'qwen3.6:35b-a3b',
      label: '',
    };
  }
  const name = { openrouter: 'OpenRouter', ollama: 'Ollama', lmstudio: 'LM Studio' }[backend];
  out.label = `${name} · ${out.model || '(no model set)'} · ${parallel} at a time`;
  return out;
}

function pickBackend(env: Record<string, string | undefined>): Backend {
  const b = (env.MODEL_BACKEND || '').toLowerCase();
  if (b === 'openrouter' || b === 'ollama' || b === 'lmstudio') return b;
  // Older settings: infer from LLM_PROVIDER / LLM_BASE_URL.
  if (/openrouter\.ai/.test(env.LLM_BASE_URL || '') || env.LLM_OPENROUTER === '1') return 'openrouter';
  if ((env.LLM_PROVIDER || '') === 'openai') return 'lmstudio';
  return 'ollama';
}
