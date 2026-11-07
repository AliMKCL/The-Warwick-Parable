/// <reference types="vite/client" />
declare const __LLM_PROVIDER__: 'ollama' | 'openai';
declare const __LLM_MODEL__: string;
declare const __TTS__: { enabled: boolean; model: string; maxChars: number };
