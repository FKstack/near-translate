import { test as base, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

type Extension = { context: BrowserContext; base: string };
export const test = base.extend<{ conversionPage: Page }, { conversionExtension: Extension }>({
  conversionExtension: [async ({}, use) => {
    const extension = resolve(process.env.NEAR_CONVERSION_EXTENSION ?? '.output/edge-mv3');
    const profile = await mkdtemp(resolve('.output/conversion-e2e-profile-'));
    let context: BrowserContext | undefined;
    try {
      context = await chromium.launchPersistentContext(profile, {
        executablePath: process.env.NEAR_BROWSER_EXECUTABLE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: true, ignoreDefaultArgs: ['--disable-extensions'],
        args: ['--enable-unsafe-extension-debugging'],
        viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', acceptDownloads: true,
      });
      const browser = context.browser();
      if (!browser) throw new Error('Isolated Edge browser connection unavailable.');
      const cdp = await browser.newBrowserCDPSession();
      await cdp.send('Extensions.loadUnpacked', { path: extension });
      await cdp.detach();
      await context.route(/^https?:\/\//, route => route.abort('blockedbyclient'));
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      await use({ context, base: new URL(worker.url()).origin.replace('null', `chrome-extension://${new URL(worker.url()).host}`) });
    } finally {
      await context?.close();
      const actual = await realpath(profile);
      if (!relative(resolve('.output'), actual).startsWith('conversion-e2e-profile-')) throw new Error('Refuse removing external profile.');
      await rm(actual, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    }
  }, { scope: 'worker' }],
  conversionPage: async ({ conversionExtension }, use) => {
    const page = await conversionExtension.context.newPage();
    await page.goto(`${conversionExtension.base}/convert.html`);
    await expect(page.getByRole('heading', { name: '文档转换', exact: true })).toBeVisible();
    await use(page);
    await page.close();
  },
});
export { expect };
