import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The dev server proxies the API so the browser only ever talks to one origin.
 * That keeps CORS out of the development loop and means the production build
 * can be served from the same host as the API without changing a single URL.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/v1': { target: 'http://localhost:3001', changeOrigin: true },
      '/healthz': { target: 'http://localhost:3001', changeOrigin: true },
      '/readyz': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
