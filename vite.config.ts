import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** The backend (`src/server`); in development Vite serves the page and forwards API and media requests to it. */
const backend = `http://127.0.0.1:${process.env.THR_PORT ?? 3717}`;

export default defineConfig({
  root: resolve(import.meta.dirname, 'src/web'),
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared') } },
  plugins: [react()],
  build: { outDir: resolve(import.meta.dirname, 'out/web'), emptyOutDir: true },
  server: {
    // The Twitch Embed only accepts `parent=localhost`, so the page must be opened by that name.
    host: 'localhost',
    port: 5173,
    strictPort: true,
    open: true,
    proxy: { '/api': backend, '/media': backend },
  },
});
