import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API server binds 127.0.0.1 only; the dev server proxies /api to it so the
// browser only ever talks to one origin.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    port: 5178,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5179',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
});
