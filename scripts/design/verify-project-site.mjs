import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

// Manual QA for the built public site. No user browser profile, external
// requests, dependencies, or long-running preview service are involved.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const site = path.join(root, '.output/userscript-site');
const output = path.join(root, '.output/project-site-checks');
const prefix = '/near-translate/';
const summary = {
  checkedAt: new Date().toISOString(),
  scope: 'Isolated Chromium, loopback static build, no external runtime requests.',
  viewports: [], localLinks: [], checks: [], pageErrors: [], consoleErrors: [],
  externalRequests: [], failedRequests: [], issues: [], screenshots: [],
};
const record = (name, passed, details) => {
  summary.checks.push({ name, passed, ...(details === undefined ? {} : { details }) });
  if (!passed) summary.issues.push(name);
};
const mime = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'],
  ['.js', 'application/javascript; charset=utf-8'], ['.md', 'text/markdown; charset=utf-8'],
]);
let origin;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, origin ?? 'http://127.0.0.1');
    if (!['GET', 'HEAD'].includes(request.method) || !url.pathname.startsWith(prefix)) {
      response.writeHead(404).end(); return;
    }
    let file = path.resolve(site, decodeURIComponent(url.pathname.slice(prefix.length)));
    const relative = path.relative(site, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      response.writeHead(404).end(); return;
    }
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    const bytes = await readFile(file);
    response.writeHead(200, {
      'Content-Type': mime.get(path.extname(file)) ?? 'application/octet-stream',
      'Content-Length': bytes.length, 'Cache-Control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch {
    response.writeHead(404).end();
  }
});

let browser;
await mkdir(output, { recursive: true });
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  const homepage = `${origin}${prefix}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.NEAR_BROWSER_EXECUTABLE ? { executablePath: process.env.NEAR_BROWSER_EXECUTABLE } : {}),
  });
  const context = await browser.newContext({ reducedMotion: 'reduce', deviceScaleFactor: 1 });
  await context.route('**/*', route => {
    const request = route.request();
    if (new URL(request.url()).origin === origin) return route.continue();
    summary.externalRequests.push(request.url());
    return route.abort('blockedbyclient');
  });
  for (const width of [360, 390, 768, 1024, 1440]) {
    const page = await context.newPage();
    await page.setViewportSize({ width, height: 960 });
    page.on('pageerror', error => summary.pageErrors.push({ width, message: error.message }));
    page.on('console', message => {
      if (message.type() === 'error') summary.consoleErrors.push({ width, message: message.text() });
    });
    page.on('requestfailed', request => summary.failedRequests.push({ width, url: request.url(), error: request.failure()?.errorText }));
    const response = await page.goto(homepage, { waitUntil: 'networkidle' });
    record(`${width}px homepage responds`, response?.status() === 200);
    await page.keyboard.press('Tab');
    const firstFocus = await page.evaluate(() => ({
      text: document.activeElement?.textContent?.trim(),
      href: document.activeElement?.getAttribute('href'),
      top: document.activeElement?.getBoundingClientRect().top,
    }));
    record(`${width}px keyboard starts with visible skip link`, firstFocus.href === '#main' && firstFocus.top >= 0, firstFocus);
    await page.keyboard.press('Enter');
    record(`${width}px skip link reaches main`, new URL(page.url()).hash === '#main');

    if (width === 360) {
      const links = await page.locator('a[href], link[href]').evaluateAll(elements => elements.map(element => ({
        href: element.getAttribute('href'), resolved: element.href,
      })));
      const checked = new Set();
      for (const link of links) {
        const url = new URL(link.resolved);
        if (url.origin !== origin) continue;
        if (url.hash && url.pathname === prefix) {
          const id = decodeURIComponent(url.hash.slice(1));
          record(`Anchor ${url.hash} exists`, await page.evaluate(id => document.getElementById(id) !== null, id));
        }
        url.hash = '';
        if (checked.has(url.href)) continue;
        checked.add(url.href);
        const result = await fetch(url, { redirect: 'error' });
        summary.localLinks.push({ path: url.pathname, status: result.status });
        record(`Local resource ${url.pathname} responds`, result.status === 200);
        await result.arrayBuffer();
      }
    }

    record(`${width}px hero installation CTA targets install section`,
      await page.locator('.hero a[href="#install"]').count() > 0);
    record(`${width}px extension download entry preserved`,
      await page.locator('#install a[href="https://github.com/FKstack/near-translate/releases/latest"]').count() > 0);
    record(`${width}px script installation entry preserved`,
      await page.locator('#install a[href="./userscript/"]').count() > 0);
    record(`${width}px script guide entry preserved`,
      await page.locator('a[href="./userscript/guide.html"]').count() > 0);
    record(`${width}px script settings entry preserved`,
      await page.locator('a[href="./userscript/settings.html"]').count() > 0);

    const scenes = ['word', 'sentence', 'reading'];
    record(`${width}px word demo selected initially`, await page.locator('#scene-word').isChecked());
    for (const selected of scenes) {
      await page.locator(`.mode-label[for="scene-${selected}"]`).click();
      record(`${width}px ${selected} demo radio selected`, await page.locator(`#scene-${selected}`).isChecked());
      for (const candidate of scenes) {
        const visible = await page.locator(`.scene-${candidate}`).isVisible();
        record(`${width}px ${selected} selection ${candidate} panel visibility`, visible === (candidate === selected));
      }
      const size = await page.evaluate(() => ({
        viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth,
      }));
      record(`${width}px ${selected} demo has no horizontal overflow`,
        size.document <= width + 1 && size.body <= width + 1, size);
    }
    await page.locator('.mode-label[for="scene-word"]').click();
    await page.locator('#scene-word').press('ArrowRight');
    record(`${width}px demo ArrowRight selects sentence`, await page.locator('#scene-sentence').isChecked());
    record(`${width}px demo ArrowRight displays sentence`, await page.locator('.scene-sentence').isVisible()
      && !await page.locator('.scene-word').isVisible() && !await page.locator('.scene-reading').isVisible());
    // Restore the initial panel for the remaining checks and deliverable images.
    await page.locator('.mode-label[for="scene-word"]').click();

    const images = page.locator('img');
    for (let index = 0; index < await images.count(); index += 1) {
      const image = images.nth(index);
      if (!await image.isVisible()) continue;
      await image.scrollIntoViewIfNeeded();
      await image.evaluate(async image => { if (!image.complete) await image.decode(); });
    }
    const imageState = await images.evaluateAll(elements => elements.map(image => ({
      src: image.getAttribute('src'), loaded: image.complete && image.naturalWidth > 0,
      width: image.naturalWidth, height: image.naturalHeight,
    })));
    record(`${width}px all images load`, imageState.every(image => image.loaded), imageState);

    const dimensions = await page.evaluate(() => ({
      viewport: window.innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth,
      overflowing: [...document.body.querySelectorAll('*')].filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.left < -1 || rect.right > window.innerWidth + 1);
      }).slice(0, 8).map(element => ({
        tag: element.tagName, class: element.className,
        left: Math.round(element.getBoundingClientRect().left), right: Math.round(element.getBoundingClientRect().right),
      })),
    }));
    summary.viewports.push({ width, ...dimensions });
    record(`${width}px no horizontal overflow`, dimensions.document <= width + 1 && dimensions.body <= width + 1, dimensions);

    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    if (width === 390 || width === 1440) {
      const name = width === 390 ? 'brand-mobile.png' : 'brand-desktop.png';
      await page.screenshot({ path: path.join(output, name), fullPage: true });
      summary.screenshots.push(path.join(output, name));
      const heroName = width === 390 ? 'brand-mobile-hero.png' : 'brand-desktop-hero.png';
      await page.screenshot({ path: path.join(output, heroName), fullPage: false });
      summary.screenshots.push(path.join(output, heroName));
    }
    await page.close();
  }
  await context.close();
  record('No page errors', summary.pageErrors.length === 0);
  record('No console errors', summary.consoleErrors.length === 0);
  record('No external runtime requests', summary.externalRequests.length === 0);
  record('No failed runtime requests', summary.failedRequests.length === 0);
} catch (error) {
  summary.issues.push(error.message);
} finally {
  if (browser) await browser.close();
  if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const { checks, ...report } = summary;
  await writeFile(path.join(output, 'summary.json'), JSON.stringify({
    ...report, passed: summary.issues.length === 0, checkCount: checks.length,
    failedChecks: checks.filter(check => !check.passed),
  }, null, 2) + '\n');
}
console.log(JSON.stringify({
  passed: summary.issues.length === 0, checks: summary.checks.length, issues: summary.issues,
  viewports: summary.viewports.map(({ width, document, body }) => ({ width, document, body })),
  localLinks: summary.localLinks.length, externalRequests: summary.externalRequests.length,
  screenshots: summary.screenshots, summary: path.join(output, 'summary.json'),
}, null, 2));
if (summary.issues.length) process.exitCode = 1;
