/// <reference types="vite/client" />
declare const __LLM_PROVIDER__: 'ollama' | 'openai';
declare const __LLM_MODEL__: string;
declare const __TTS__: { enabled: boolean; voice: string; model: string; maxChars: number };
declare const __LLM_PARALLEL__: number;
declare const __LLM_NO_THINKING__: boolean;
declare const __LLM_EXTRA__: Record<string, unknown> | undefined;
declare const __LLM_LABEL__: string;
declare const __LLM_PROBLEM__: string;

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}
