import { defineConfig } from '@playwright/test';
import userscript from './playwright.userscript.config';

process.env.NEAR_USERSCRIPT_DISTRIBUTION = 'greasyfork';

export default defineConfig({
  ...userscript,
  outputDir: '.output/greasyfork-test-results',
  reporter: [['list'], ['json', { outputFile: '.output/greasyfork-e2e-results.json' }]],
});
