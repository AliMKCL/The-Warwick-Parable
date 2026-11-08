import { defineConfig, loadEnv } from 'vite';
import { resolveLlmEnv } from './tools/llm-env';

// The browser never talks to the model server directly. It calls /llm on the
// Vite dev server, which forwards to LLM_BASE_URL. This avoids cross-origin
// errors and keeps the real address (and any key) out of browser code.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const llm = resolveLlmEnv(env);
  const { provider, baseUrl, model } = llm;

  // Narrator voice (optional). The key is added here, on the dev server, and never reaches the browser.
  const ttsKey = env.ELEVENLABS_API_KEY || '';
  const ttsVoice = env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb';
  const ttsBase = env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io';

  return {
    plugins: [
      {
        name: 'whack-model-banner',
        configureServer() {
          // Say which model writes the rooms, so a stale or wrong .env.local is obvious.
          console.log(`\n  Rooms written by: ${llm.label}${llm.problem ? `\n  ⚠ ${llm.problem}` : ''}\n`);
        },
      },
    ],
    define: {
      __LLM_PROVIDER__: JSON.stringify(provider),
      __LLM_MODEL__: JSON.stringify(model),
      __LLM_PARALLEL__: JSON.stringify(llm.parallel),
      __LLM_NO_THINKING__: JSON.stringify(!!llm.noThinking),
      __LLM_EXTRA__: JSON.stringify(llm.extraBody),
      __LLM_LABEL__: JSON.stringify(llm.label),
      __LLM_PROBLEM__: JSON.stringify(llm.problem ?? ''),
      __TTS__: JSON.stringify({
        enabled: !!ttsKey,
        voice: ttsVoice,
        model: env.ELEVENLABS_MODEL || 'eleven_flash_v2_5',
        maxChars: Number(env.ELEVENLABS_MAX_CHARS) || 6000,
      }),
    },
    server: {
      host: '127.0.0.1',
      port: 5188,
      strictPort: true,
      proxy: {
        '/llm': {
          target: baseUrl,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/llm/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (req) => {
              // Model servers may reject browser origins; the request comes from the dev server instead.
              req.removeHeader('origin');
              // Cloud models: the key is added here and never reaches the browser.
              if (llm.apiKey) req.setHeader('authorization', `Bearer ${llm.apiKey}`);
              if (llm.backend === 'openrouter') req.setHeader('x-title', 'whack');
            });
            proxy.on('proxyRes', (res, req) => {
              if ((res.statusCode ?? 200) >= 400) console.error(`[rooms] ${llm.label}: ${req.method} ${req.url} → HTTP ${res.statusCode}`);
            });
            proxy.on('error', (err) => console.error(`[rooms] cannot reach ${baseUrl}: ${err.message}`));
          },
        },
        '/tts': {
          target: ttsBase,
          changeOrigin: true,
          // /tts/<voiceId> → ElevenLabs; the page picks the voice, the server adds the key.
          rewrite: (path) => `/v1/text-to-speech/${path.split('/')[2] || ttsVoice}/stream?output_format=mp3_44100_128`,
          configure: (proxy) => {
            proxy.on('proxyReq', (req) => {
              req.removeHeader('origin');
              req.setHeader('xi-api-key', ttsKey);
            });
          },
        },
      },
    },
    preview: { host: '127.0.0.1', port: 4188, strictPort: true },
    build: { sourcemap: true, chunkSizeWarningLimit: 900 },
  };
});
