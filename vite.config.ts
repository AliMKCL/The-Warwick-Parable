import { defineConfig, loadEnv } from 'vite';

// The browser never talks to the model server directly. It calls /llm on the
// Vite dev server, which forwards to LLM_BASE_URL. This avoids cross-origin
// errors and keeps the real address (and any key) out of browser code.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const provider = env.LLM_PROVIDER || 'ollama';
  const baseUrl = env.LLM_BASE_URL || (provider === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234');
  const model = env.LLM_MODEL || 'qwen3.6:35b-a3b';

  return {
    define: {
      __LLM_PROVIDER__: JSON.stringify(provider),
      __LLM_MODEL__: JSON.stringify(model),
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
      },
    },
    preview: { host: '127.0.0.1', port: 4188, strictPort: true },
    build: { sourcemap: true, chunkSizeWarningLimit: 900 },
  };
});
