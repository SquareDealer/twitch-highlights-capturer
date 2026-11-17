import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared') } },
  test: {
    environment: 'node',
    pool: 'forks',
    globals: true,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    testTimeout: 20000,
  },
});
