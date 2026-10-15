import { defineConfig } from '@playwright/test';
import { readFileSync } from 'node:fs';

const packageVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 35_000,
  expect: { timeout: 8_000 },
  retries: 0,
  outputDir: 'test-results',
  metadata: { extensionVersion: packageVersion },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }], ['json', { outputFile: '.output/e2e-results.json' }]],
  use: { trace: 'retain-on-failure' },
  webServer: {
    command: 'node tests/e2e/server.mjs',
    url: 'http://127.0.0.1:4177',
    reuseExistingServer: false,
    timeout: 10_000,
  },
});
