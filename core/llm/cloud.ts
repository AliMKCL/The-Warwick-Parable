import type { LlmConfig } from './types';

/**
 * Settings for OpenRouter (https://openrouter.ai), the cloud option: only use
 * providers that enforce our JSON Schema, and turn the model's reasoning off
 * (reasoning makes rooms several times slower and isn't needed for this writing).
 */
export const OPENROUTER_EXTRA: NonNullable<LlmConfig['extraBody']> = {
  provider: { require_parameters: true },
  reasoning: { effort: 'none' },
};

export function isOpenRouter(baseUrl: string, flag?: string): boolean {
  return /openrouter\.ai/.test(baseUrl) || flag === '1';
}
