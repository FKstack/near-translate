import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 35_000,
  expect: { timeout: 8_000 },
  retries: 0,
  outputDir: 'test-results',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: { trace: 'retain-on-failure' },
  webServer: {
    command: 'node tests/e2e/server.mjs',
    url: 'http://127.0.0.1:4177',
    reuseExistingServer: false,
    timeout: 10_000,
  },
});
