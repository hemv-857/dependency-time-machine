import { defineConfig } from '@playwright/test';

const PORT = 3111;
const MOCK_PORT = 3112;

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `node e2e/mock-server.mjs`,
      port: MOCK_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
    },
    {
      command: `npx next start -p ${PORT}`,
      port: PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        TM_GITHUB_API_BASE: `http://127.0.0.1:${MOCK_PORT}`,
        TM_OSV_BASE: `http://127.0.0.1:${MOCK_PORT}`,
        TM_NPM_REGISTRY_BASE: `http://127.0.0.1:${MOCK_PORT}`,
        TM_DATA_DIR: 'e2e/.data',
        TM_RUNNER: 'local',
        TM_CONCURRENCY: '2',
        // `next start` implies NODE_ENV=production, where the local runner
        // refuses to execute repo code by design. Safe to lift here: the repo
        // under test is the hermetic local fixture from e2e/mock-server.mjs
        // (zero dependencies, no network), never third-party code.
        TM_ALLOW_UNSAFE_LOCAL_EXEC: '1',
      },
    },
  ],
});
