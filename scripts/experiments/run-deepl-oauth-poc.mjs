// Isolated, visible OAuth POC. Never reads a real profile, site DOM, cookies or token storage.
import assert from 'node:assert/strict';
import { copyFile, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const workspace = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const source = resolve(workspace, 'scripts/experiments/deepl-oauth-poc');
const root = resolve(workspace, '.output/deepl-oauth-poc');
const extensionDirectory = resolve(root, 'extension');
const profileDirectory = resolve(root, 'profile');
const refreshUiOnly = process.argv.includes('--refresh-ui');
const autoConnect = !process.argv.includes('--no-connect');
let context;
let polling;
let finish;
let pollBusy = false;
let previousSummary = '';
let latestSummary;
let stopping = false;

function requireChild(parent, child) {
  const path = relative(parent, child);
  assert(path && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`), 'POC path must stay inside its workspace.');
}
async function prepareDirectory(path, parent) {
  await mkdir(path, { recursive: true });
  const canonical = await realpath(path);
  requireChild(parent, canonical);
  return canonical;
}
function stop() {
  if (stopping) return;
  stopping = true;
  finish?.();
}
async function main() {
  const canonicalOutput = await prepareDirectory(resolve(workspace, '.output'), workspace);
  const canonicalRoot = await prepareDirectory(root, canonicalOutput);
  const canonicalExtension = await prepareDirectory(extensionDirectory, canonicalRoot);
  for (const name of ['index.html', 'ui.js']) await copyFile(resolve(source, name), resolve(canonicalExtension, name));
  if (refreshUiOnly) {
    console.log('已更新隔离 POC 的 HTML/JS；请在原测试页面使用浏览器刷新。未启动浏览器、未复制 worker、未读取凭证。');
    return;
  }
  await copyFile(resolve(source, 'worker.js'), resolve(canonicalExtension, 'worker.js'));
  await writeFile(resolve(canonicalExtension, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: '近译 DeepL 官方授权验证（隔离 POC）',
    version: '0.0.1',
    description: '仅验证官方 OAuth、工具发现与公开短文本；非生产扩展。',
    permissions: ['identity', 'storage'],
    host_permissions: ['https://mcp.deepl.com/*'],
    background: { service_worker: 'worker.js' },
    options_ui: { page: 'index.html', open_in_tab: true },
  }, null, 2) + '\n');
  const canonicalProfile = await prepareDirectory(profileDirectory, canonicalRoot);
  context = await chromium.launchPersistentContext(canonicalProfile, {
    channel: 'msedge', headless: false, timeout: 20_000,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--disable-background-networking', '--no-first-run', '--no-default-browser-check'],
  });
  const closed = new Promise(resolveClosed => { finish = resolveClosed; });
  context.on('close', stop);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const cdp = await context.browser().newBrowserCDPSession();
  let loaded;
  try { loaded = await cdp.send('Extensions.loadUnpacked', { path: canonicalExtension }); }
  finally { await cdp.detach(); }
  assert(/^[a-p]{32}$/.test(loaded?.id), 'Expected an isolated extension ID.');
  const extensionId = loaded.id;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/index.html`);
  console.log(JSON.stringify({ event: 'isolated-poc-opened', extensionId, browser: 'Edge', profile: '.output/deepl-oauth-poc/profile', automaticConsent: false }));
  console.log('请在可见的 DeepL 官方窗口亲自登录并同意授权。此进程只观察 POC 公开状态，不读取登录页面或凭证。');

  async function observe() {
    if (pollBusy || stopping || page.isClosed()) return;
    pollBusy = true;
    try {
      // Evaluate only our own extension page; never inspect official login/consent pages.
      const summary = await page.evaluate(async expectedId => {
        if (location.protocol !== 'chrome-extension:' || location.hostname !== expectedId) return null;
        const reply = await chrome.runtime.sendMessage({ type: 'poc-status' });
        if (!reply?.ok || !reply.status) return { phase: 'status-unavailable' };
        const status = reply.status;
        return {
          phase: typeof status.phase === 'string' ? status.phase.slice(0, 60) : 'unknown',
          connected: status.connected === true,
          registered: status.registered === true,
          hasRefreshToken: status.hasRefreshToken === true,
          protocolVersion: typeof status.protocolVersion === 'string' ? status.protocolVersion.slice(0, 80) : null,
          toolCount: Array.isArray(status.tools) ? status.tools.length : 0,
        };
      }, extensionId);
      if (!summary) return;
      latestSummary = summary;
      const serialized = JSON.stringify(summary);
      if (serialized !== previousSummary) {
        previousSummary = serialized;
        console.log(JSON.stringify({ event: 'poc-status', ...summary }));
      }
    } catch { /* A refresh/closed page must not expose browser error URLs or OAuth fields. */ }
    finally { pollBusy = false; }
  }
  await observe();
  if (autoConnect && latestSummary?.connected !== true && latestSummary?.phase !== 'authorizing') {
    const connect = page.locator('#connect');
    if (await connect.isEnabled()) {
      await connect.click();
      console.log('已触发 POC 连接按钮；官方登录和同意步骤由用户操作。');
    }
  }
  polling = setInterval(() => void observe(), 2000);
  console.log('POC 运行中。终止此进程只关闭该隔离浏览器；专用 profile 暂时保留。');
  await closed;
}
try { await main(); }
catch {
  // Do not print arbitrary browser/runtime errors: they may contain authorization URLs.
  console.error('隔离 DeepL POC 未能启动或继续运行。请检查本机 Edge、POC worker 与专用 profile 是否被另一进程占用。');
  process.exitCode = 1;
} finally {
  clearInterval(polling);
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  await context?.close().catch(() => {});
}
