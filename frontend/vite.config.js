import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies both REST and WebSocket traffic to the Express backend
// so the browser only ever talks to one origin (no CORS in development).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:4000', ws: true },
    },
  },
});
