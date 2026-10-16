import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@shared': fileURLToPath(new URL('./shared', import.meta.url)) } },
  test: { include: ['server/**/*.test.ts', 'shared/**/*.test.ts'], environment: 'node' },
});
