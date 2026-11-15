import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  plugins: [react()],
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  build: { outDir: resolve(__dirname, 'out/web'), emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:8080', '/media': 'http://localhost:8080' } },
});
