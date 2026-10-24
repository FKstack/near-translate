import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/userscript',
  fullyParallel: false,
  workers: 1,
  timeout: 25_000,
  expect: { timeout: 7_000 },
  retries: 0,
  outputDir: '.output/userscript-test-results',
  reporter: [['list'], ['json', { outputFile: '.output/userscript-e2e-results.json' }]],
  use: {
    browserName: 'chromium',
    headless: true,
    // Manager grants run outside the site's CSP. The harness injects that
    // sandbox closure through DevTools, without changing the shipped page CSP.
    bypassCSP: true,
    viewport: { width: 1280, height: 900 },
    launchOptions: {
      ...(process.env.NEAR_BROWSER_EXECUTABLE ? { executablePath: process.env.NEAR_BROWSER_EXECUTABLE } : {}),
    },
    trace: 'retain-on-failure',
  },
});
