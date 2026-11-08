/// <reference types="vite/client" />
declare const __LLM_PROVIDER__: 'ollama' | 'openai';
declare const __LLM_MODEL__: string;
declare const __TTS__: { enabled: boolean; voice: string; model: string; maxChars: number };

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}
