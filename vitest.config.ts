import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60000,
    env: { TM_DATA_DIR: '.tmp-test-data' },
  },
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
});
