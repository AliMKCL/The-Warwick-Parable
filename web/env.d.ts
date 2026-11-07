/// <reference types="vite/client" />
declare const __LLM_PROVIDER__: 'ollama' | 'openai';
declare const __LLM_MODEL__: string;
declare const __TTS__: { enabled: boolean; voice: string; model: string; maxChars: number };
declare const __LLM_PARALLEL__: number;
declare const __LLM_NO_THINKING__: boolean;
