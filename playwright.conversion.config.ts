import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e', testMatch: 'conversion-*.spec.ts',
  fullyParallel: false, workers: 1,
  timeout: 60_000, expect: { timeout: 12_000 }, retries: 0,
  outputDir: '.output/conversion-test-results',
  reporter: [['list'], ['json', { outputFile: '.output/conversion-e2e-results.json' }]],
  use: { trace: 'retain-on-failure' },
});
