import { resolveLlmEnv, type ResolvedLlmEnv } from '../../tools/llm-env';

/**
 * The player's own keys, entered on the start screen and kept only in this
 * browser (localStorage). They are sent only to the service they belong to:
 * the model provider and ElevenLabs. Nothing here is ever part of the build.
 *
 * Where the game gets its model and voice from, in order:
 *  1. Keys the player saved here: the browser calls the provider directly.
 *  2. Running with `npm run dev`: the dev server's /llm and /tts proxies, set
 *     up from .env.local (unchanged behaviour for the team).
 *  3. The published site with no keys: no model (rooms from templates) and no
 *     voice (subtitles only). The game plays the same; only the writing differs.
 */

export type RoomsBackend = 'off' | 'openrouter' | 'ollama' | 'lmstudio';

export interface PlayerKeys {
  rooms: RoomsBackend;
  openrouterKey?: string;
  openrouterModel?: string;
  ollamaUrl?: string;
  ollamaModel?: string;
  lmstudioUrl?: string;
  lmstudioModel?: string;
  elevenlabsKey?: string;
  elevenlabsVoice?: string;
}

const STORE = 'warwick-parable.keys.v1';

/** The build's voice settings (vite.config.ts); defaults where they aren't defined, e.g. in unit tests. */
const TTS: { enabled: boolean; voice: string; model: string; maxChars: number } =
  typeof __TTS__ !== 'undefined' ? __TTS__ : { enabled: false, voice: 'JBFqnCBsd6RMkjVDRZzb', model: 'eleven_flash_v2_5', maxChars: 6000 };

export const DEFAULTS = {
  openrouterModel: 'qwen/qwen3.6-35b-a3b',
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen3.6:35b-a3b',
  lmstudioUrl: 'http://127.0.0.1:1234',
  elevenlabsVoice: TTS.voice,
};

export function loadKeys(): PlayerKeys {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) {
      const k = JSON.parse(raw) as PlayerKeys;
      if (k && typeof k === 'object') return { ...k, rooms: k.rooms ?? 'off' };
    }
  } catch {
    // Storage blocked or corrupt: behave as if nothing was saved.
  }
  return { rooms: 'off' };
}

export function saveKeys(k: PlayerKeys): void {
  const clean = Object.fromEntries(Object.entries(k).map(([key, v]) => [key, typeof v === 'string' ? v.trim() : v]).filter(([, v]) => v !== '' && v !== undefined));
  try {
    localStorage.setItem(STORE, JSON.stringify(clean));
  } catch {
    // Private browsing etc.: the keys work for this page only.
  }
}

export function forgetKeys(): void {
  try {
    localStorage.removeItem(STORE);
  } catch {
    // nothing to forget
  }
}

/** True when this page is served by `npm run dev`, which has the /llm and /tts proxies. */
export const HAS_PROXY = import.meta.env.DEV;

export interface RoomsSource {
  /** Where requests go: a provider's URL (player keys) or the dev proxy. */
  config: ResolvedLlmEnv;
  /** 'player' when the player's own keys are used; 'dev' for the .env.local proxy. */
  via: 'player' | 'dev';
}

/** The model that writes the rooms, or undefined for template rooms. */
export function roomsSource(keys: PlayerKeys = loadKeys()): RoomsSource | undefined {
  if (keys.rooms !== 'off') {
    const config = resolveLlmEnv({
      MODEL_BACKEND: keys.rooms,
      OPENROUTER_API_KEY: keys.openrouterKey,
      OPENROUTER_MODEL: keys.openrouterModel || DEFAULTS.openrouterModel,
      OLLAMA_URL: keys.ollamaUrl || DEFAULTS.ollamaUrl,
      OLLAMA_MODEL: keys.ollamaModel || DEFAULTS.ollamaModel,
      LMSTUDIO_URL: keys.lmstudioUrl || DEFAULTS.lmstudioUrl,
      LMSTUDIO_MODEL: keys.lmstudioModel,
      // A cloud provider can write several rooms at once; a model on the player's own machine queues them.
      PARALLEL_ROOMS: keys.rooms === 'openrouter' ? '3' : '1',
    });
    return { config, via: 'player' };
  }
  if (HAS_PROXY && typeof __LLM_PROVIDER__ !== 'undefined') {
    return {
      via: 'dev',
      config: {
        backend: 'ollama', provider: __LLM_PROVIDER__, baseUrl: '/llm', model: __LLM_MODEL__,
        noThinking: __LLM_NO_THINKING__, extraBody: __LLM_EXTRA__, parallel: __LLM_PARALLEL__,
        label: __LLM_LABEL__, ...(__LLM_PROBLEM__ ? { problem: __LLM_PROBLEM__ } : {}),
      },
    };
  }
  return undefined;
}

export interface VoiceSettings {
  enabled: boolean;
  voice: string;
  model: string;
  maxChars: number;
  /** Set when the browser calls ElevenLabs itself with the player's key (otherwise the dev proxy adds the key). */
  direct?: { baseUrl: string; apiKey: string };
  via?: 'player' | 'dev';
}

export function voiceSettings(keys: PlayerKeys = loadKeys()): VoiceSettings {
  const base = { model: TTS.model, maxChars: TTS.maxChars };
  if (keys.elevenlabsKey) {
    return {
      ...base, enabled: true, via: 'player',
      voice: keys.elevenlabsVoice || DEFAULTS.elevenlabsVoice,
      direct: { baseUrl: 'https://api.elevenlabs.io', apiKey: keys.elevenlabsKey },
    };
  }
  if (HAS_PROXY && TTS.enabled) return { ...base, enabled: true, voice: TTS.voice, via: 'dev' };
  return { ...base, enabled: false, voice: TTS.voice };
}
