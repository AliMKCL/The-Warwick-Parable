import { defineConfig, loadEnv } from 'vite';

// The browser never talks to the model server directly. It calls /llm on the
// Vite dev server, which forwards to LLM_BASE_URL. This avoids cross-origin
// errors and keeps the real address (and any key) out of browser code.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const provider = env.LLM_PROVIDER || 'ollama';
  const baseUrl = env.LLM_BASE_URL || (provider === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234');
  const model = env.LLM_MODEL || 'qwen3.6:35b-a3b';

  // Narrator voice (optional). The key is added here, on the dev server, and never reaches the browser.
  const ttsKey = env.ELEVENLABS_API_KEY || '';
  const ttsVoice = env.ELEVENLABS_VOICE_ID || 'qxePw1S1QmBgjlU3GIy5';
  const ttsBase = env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io';

  return {
    define: {
      __LLM_PROVIDER__: JSON.stringify(provider),
      __LLM_MODEL__: JSON.stringify(model),
      __TTS__: JSON.stringify({
        enabled: !!ttsKey,
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
            // Model servers may reject browser origins; the request comes from the dev server instead.
            proxy.on('proxyReq', (req) => req.removeHeader('origin'));
          },
        },
        '/tts': {
          target: ttsBase,
          changeOrigin: true,
          rewrite: () => `/v1/text-to-speech/${ttsVoice}/stream?output_format=mp3_44100_128`,
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
