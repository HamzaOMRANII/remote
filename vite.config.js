// CommonJS on purpose: the package isn't "type": "module", matching
// server_monitoring / it.omranisystems.com so pm2 can require() ecosystem configs.
//
// Client source lives in src/client; index.html at the root is the entry.
// `npm run build` writes dist/, which src/server.js serves in production.
// In dev, Vite serves the client on :16011 and proxies /api + the /ws and
// /agent WebSocket upgrades to the backend (src/server.js) on :16010.
const { defineConfig } = require('vite');
const react = require('@vitejs/plugin-react').default;

module.exports = defineConfig({
  plugins: [react()],
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 16011,
    proxy: {
      '/api': 'http://127.0.0.1:16010',
      '/healthz': 'http://127.0.0.1:16010',
      '/ws': { target: 'ws://127.0.0.1:16010', ws: true },
      '/agent': { target: 'ws://127.0.0.1:16010', ws: true },
    },
  },
});
