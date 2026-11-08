import { describe, expect, it } from 'vitest';
import { resolveLlmEnv } from '../../tools/llm-env';

describe('model settings', () => {
  it('reads the OpenRouter settings', () => {
    const r = resolveLlmEnv({ MODEL_BACKEND: 'openrouter', OPENROUTER_API_KEY: 'k', PARALLEL_ROOMS: '3' });
    expect(r).toMatchObject({ provider: 'openai', baseUrl: 'https://openrouter.ai/api', model: 'qwen/qwen3.6-35b-a3b', apiKey: 'k', parallel: 3 });
    expect(r.extraBody).toBeDefined();
    expect(r.problem).toBeUndefined();
    expect(r.label).toBe('OpenRouter · qwen/qwen3.6-35b-a3b · 3 at a time');
  });

  it('flags a missing key instead of failing silently', () => {
    expect(resolveLlmEnv({ MODEL_BACKEND: 'openrouter' }).problem).toMatch(/OPENROUTER_API_KEY/);
  });

  it('ignores old LLM_* values once MODEL_BACKEND is set, so a leftover line cannot win', () => {
    const r = resolveLlmEnv({ MODEL_BACKEND: 'ollama', LLM_BASE_URL: 'https://openrouter.ai/api', LLM_MODEL: 'qwen/x' });
    expect(r).toMatchObject({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.6:35b-a3b' });
  });

  it('still understands the old LLM_* names', () => {
    expect(resolveLlmEnv({ LLM_PROVIDER: 'openai', LLM_BASE_URL: 'https://openrouter.ai/api', LLM_API_KEY: 'k', LLM_MODEL: 'qwen/qwen3.6-35b-a3b' }).backend).toBe('openrouter');
    expect(resolveLlmEnv({ LLM_BASE_URL: 'http://127.0.0.1:11999' })).toMatchObject({ backend: 'ollama', baseUrl: 'http://127.0.0.1:11999' });
    expect(resolveLlmEnv({ LLM_PROVIDER: 'openai', LLM_MODEL: 'x' }).backend).toBe('lmstudio');
  });
});
