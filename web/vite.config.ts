import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(here, 'src') },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The bundle is served by the Node process on the same origin, so nothing
    // needs to be split or hashed for a CDN.
    sourcemap: false,
  },
  server: {
    port: 5173,
    // `npm run dev` talks to a `dblens --no-open` server on 4321.
    proxy: { '/api': 'http://127.0.0.1:4321' },
  },
});
