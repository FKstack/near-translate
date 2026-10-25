import { expect, test, type Page } from '@playwright/test';
import { createEncryptedKeyVault } from '../../src/platform/key-vault';
import { INERT_TRANSLATION, MODEL_ENDPOINT, OLLAMA_ENDPOINT, SELECTED_TEXT, SELECTED_TRANSLATION, installUserscript, selectParagraph, settingsClick, settingsField } from './harness';

const STORAGE_PREFIX = 'near-translate:userscript:v1:';
const LEGACY_PASSPHRASE = 'test-only-old-vault-passphrase';
const LEGACY_KEY = 'fake-old-userscript-model-key';

async function legacySettings(provider: 'deepseek' | 'ollama' = 'deepseek'): Promise<Record<string, unknown>> {
  const baseUrl = provider === 'ollama' ? 'http://localhost:11434/v1' : 'https://api.deepseek.com';
  const profile = { baseUrl, model: 'test-model', jsonMode: false };
  const { vault } = await createEncryptedKeyVault(LEGACY_PASSPHRASE, { [provider]: { baseUrl, apiKey: LEGACY_KEY } });
  return {
    [STORAGE_PREFIX + 'settings:v1']: { schemaVersion: 3, translationEngine: 'model', provider, ...profile,
      sourceLanguage: 'en', targetLanguage: 'zh-Hans', enabled: true, includeContext: false, sentenceAnalysisEnabled: false,
      connectionRevision: 1, profiles: { [provider]: profile } },
    [STORAGE_PREFIX + 'key-vault:v1']: vault,
  };
}

async function saveModelSettings(page: Page): Promise<Record<string, unknown>> {
  const state = await installUserscript(page, true);
  await expect.poll(() => state.evaluate(state => Boolean(state.settingsRoot?.querySelector('select')))).toBe(true);
  await settingsField(state, '翻译方式', 'model');
  await settingsField(state, 'DeepSeek API Key', 'fake-stream-model-key');
  await settingsField(state, '划词翻译附带附近一句上下文', false);
  await settingsField(state, '长句翻译后追加句子拆解（额外一次模型请求）', false);
  await settingsClick(state, '保存设置');
  await expect.poll(() => state.evaluate(state => state.settingsRoot?.querySelector('[role="status"]')?.textContent)).toContain('设置已保存');
  return state.evaluate(state => Object.fromEntries(state.storage));
}

test('fresh installation reads articles without API setup or translation requests', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const state = await installUserscript(page);
  await expect(page.getByRole('button', { name: '翻译整个页面', exact: true })).toBeVisible();
  const original = await page.locator('#source-article').innerHTML();
  await page.locator('near-page-translate .np-primary').hover();
  await page.getByRole('button', { name: '阅读模式', exact: true }).click();
  const reader = page.getByRole('dialog', { name: '近译阅读模式', exact: true });
  await expect(reader).toBeVisible();
  await expect(reader.locator('.nr-content')).toContainText(SELECTED_TEXT);
  await expect(reader.locator('pre')).toContainText('Do not translate this code block');
  expect(await state.evaluate(state => state.requests)).toEqual([]);
  await reader.getByRole('button', { name: '退出阅读模式', exact: true }).click();
  await expect(reader).toHaveCount(0);
  expect(await page.locator('#source-article').innerHTML()).toBe(original);
  await expect(page.locator('#source-control')).toBeEnabled();
  expect(await state.evaluate(state => state.rejected)).toEqual([]);
  expect(errors).toEqual([]);
});

test('whole-page translation uses the GM transport and restores the original markup', async ({ page }) => {
  const state = await installUserscript(page);
  await expect(page.getByRole('button', { name: '翻译整个页面', exact: true })).toBeVisible();
  const original = await page.locator('#source-article').innerHTML();
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect(page.getByText(SELECTED_TRANSLATION, { exact: true })).toBeVisible();
  await expect(page.getByText(INERT_TRANSLATION, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '恢复原文', exact: true })).toBeVisible();
  await expect(page.locator('near-page-translation img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { translationExecuted?: boolean }).translationExecuted)).toBeUndefined();
  const requests = await state.evaluate(state => state.requests);
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    expect(request).toMatchObject({ anonymous: true, body: { target_lang: 'zh-Hans' } });
    expect(request.body.text.join('\n')).not.toMatch(/Do not translate|must not leave|已有中文/);
  }
  await page.getByRole('button', { name: '恢复原文', exact: true }).click();
  await expect(page.locator('near-page-translation[data-near-translation]')).toHaveCount(0);
  expect(await page.locator('#source-article').innerHTML()).toBe(original);
  expect(await state.evaluate(state => state.rejected)).toEqual([]);
});

test('selection translation works through the same userscript sandbox transport', async ({ page }) => {
  const state = await installUserscript(page);
  await expect(page.getByRole('button', { name: '翻译整个页面', exact: true })).toBeVisible();
  await selectParagraph(page, '#selection');
  await page.getByRole('button', { name: '翻译选中文字', exact: true }).click();
  const card = page.getByRole('dialog', { name: '翻译结果', exact: true });
  await expect(card.getByText(SELECTED_TRANSLATION, { exact: true })).toBeVisible();
  expect((await state.evaluate(state => state.requests)).flatMap(request => request.body.text)).toEqual([SELECTED_TEXT]);
  await card.getByRole('button', { name: '关闭翻译', exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('#selection')).toHaveText(SELECTED_TEXT);
  expect(await state.evaluate(state => state.rejected)).toEqual([]);
});

test('ordinary sites expose no GM capabilities or credential form', async ({ page }) => {
  const state = await installUserscript(page);
  await expect(page.getByRole('button', { name: '翻译整个页面', exact: true })).toBeVisible();
  expect(await page.evaluate(() => Object.getOwnPropertyNames(window).filter(key => /^GM(?:_|$)/.test(key)))).toEqual([]);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByLabel(/API Key|API Base URL/)).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);
  await state.evaluate(state => {
    const settings = [...state.menus.values()].find(menu => menu.title === '近译 · 翻译设置');
    if (!settings) throw new Error('Missing sandbox-owned settings menu.');
    settings.callback();
  });
  expect(await state.evaluate(state => state.tabs)).toEqual(['https://fkstack.github.io/near-translate/userscript/settings.html']);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  expect(await state.evaluate(state => state.requests)).toEqual([]);
  expect(await state.evaluate(state => state.rejected)).toEqual([]);
});

test('the dedicated settings page keeps a closed UI and saves ordinary configuration', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const state = await installUserscript(page, true);
  await expect.poll(() => state.evaluate(state => Boolean(state.settingsRoot?.querySelector('select')))).toBe(true);
  await expect(page.locator('near-userscript-settings')).toBeVisible();
  expect(await page.locator('near-userscript-settings').evaluate(element => element.shadowRoot)).toBeNull();
  expect(await state.evaluate(state => state.settingsRoot?.mode)).toBe('closed');
  await settingsField(state, '源语言', 'en');
  await settingsField(state, '目标语言', 'ja');
  await settingsField(state, '启用翻译', false);
  await settingsClick(state, '保存设置');
  await expect.poll(() => state.evaluate(state => state.settingsRoot?.querySelector('[role="status"]')?.textContent)).toContain('设置已保存');
  const storage = await state.evaluate(state => Object.fromEntries(state.storage));
  const reloaded = await installUserscript(page, true, {}, storage);
  await expect.poll(() => reloaded.evaluate(state => Boolean(state.settingsRoot?.querySelector('select')))).toBe(true);
  expect(await reloaded.evaluate(state => {
    const fields = [...state.settingsRoot!.querySelectorAll('label')];
    const field = (label: string) => fields.find(element => element.firstChild?.textContent?.trim() === label
      || [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim() === label)?.querySelector('input,select');
    return { source: (field('源语言') as HTMLSelectElement)?.value, target: (field('目标语言') as HTMLSelectElement)?.value,
      enabled: (field('启用翻译') as HTMLInputElement)?.checked };
  })).toEqual({ source: 'en', target: 'ja', enabled: false });
  expect(await reloaded.evaluate(state => state.requests)).toEqual([]);
  expect(await reloaded.evaluate(state => state.rejected)).toEqual([]);
  expect(errors).toEqual([]);
});

test('a model Key saves without creating a passphrase and is never refilled into the settings form', async ({ page }) => {
  const state = await installUserscript(page, true);
  await expect.poll(() => state.evaluate(state => Boolean(state.settingsRoot?.querySelector('select')))).toBe(true);
  await settingsField(state, '翻译方式', 'model');
  const fakeKey = 'fake-userscript-only-key';
  await settingsField(state, 'DeepSeek API Key', fakeKey);
  await settingsClick(state, '保存设置');
  await expect.poll(() => state.evaluate(state => state.settingsRoot?.querySelector('[role="status"]')?.textContent)).toBe('设置已保存，返回网页即可翻译。');
  expect(await state.evaluate(state => ({
    passwords: [...state.settingsRoot?.querySelectorAll('input[type="password"]') ?? []].map(input => (input as HTMLInputElement).value),
    details: state.settingsRoot?.querySelector('details') !== null,
    text: state.settingsRoot?.textContent,
  }))).toMatchObject({ passwords: [''], details: false });
  const storage = await state.evaluate(state => Object.fromEntries(state.storage));
  expect(JSON.stringify(storage)).toContain(fakeKey);
  expect(storage[STORAGE_PREFIX + 'key-vault:v1']).toBeUndefined();
  const reloaded = await installUserscript(page, true, {}, storage);
  await expect.poll(() => reloaded.evaluate(state => state.settingsRoot?.querySelector('input[type="password"]')?.getAttribute('placeholder'))).toBe('已保存，留空保留');
  expect(await reloaded.evaluate(state => (state.settingsRoot?.querySelector('input[type="password"]') as HTMLInputElement)?.value)).toBe('');
  expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(fakeKey);
  expect(await page.evaluate(() => Object.getOwnPropertyNames(window).filter(key => /^GM(?:_|$)/.test(key)))).toEqual([]);
  expect(await reloaded.evaluate(state => state.requests)).toEqual([]);
  expect(await reloaded.evaluate(state => state.rejected)).toEqual([]);
});

test('a saved model Key works in new article documents without unlocking or entering it again', async ({ page }) => {
  const state = await installUserscript(page, true);
  await expect.poll(() => state.evaluate(state => Boolean(state.settingsRoot?.querySelector('select')))).toBe(true);
  await settingsField(state, '翻译方式', 'model');
  await settingsField(state, 'DeepSeek API Key', 'fake-saved-model-key');
  await settingsField(state, '划词翻译附带附近一句上下文', false);
  await settingsField(state, '长句翻译后追加句子拆解（额外一次模型请求）', false);
  await settingsClick(state, '保存设置');
  await expect.poll(() => state.evaluate(state => state.settingsRoot?.querySelector('[role="status"]')?.textContent)).toContain('设置已保存');
  // A blank Key field on a later save preserves the stored credential.
  await settingsField(state, '模型名称', 'test-saved-model');
  await settingsClick(state, '保存设置');
  await expect.poll(() => state.evaluate(state => state.settingsRoot?.querySelector('[role="status"]')?.textContent)).toContain('设置已保存');
  const storage = await state.evaluate(state => Object.fromEntries(state.storage));
  for (let index = 0; index < 2; index++) {
    const article = await page.context().newPage();
    const articleState = await installUserscript(article, false, {}, storage, { pauseAfterFirstDelta: true });
    await expect(article.getByRole('button', { name: '翻译整个页面', exact: true })).toBeVisible();
    expect(await articleState.evaluate(state => [...state.menus.values()].map(menu => menu.title))).not.toContain('近译 · 解锁本页模型 Key');
    await selectParagraph(article, '#selection');
    await article.getByRole('button', { name: '翻译选中文字', exact: true }).click();
    const card = article.getByRole('dialog', { name: '翻译结果', exact: true });
    await expect(card.locator('.nt-text')).toHaveText(SELECTED_TRANSLATION.slice(0, 2));
    await expect(card.locator('.nt-loading')).toBeVisible();
    const beforeEof = await articleState.evaluate(state => state.transportEvents);
    expect(beforeEof.some(event => event.type === 'load')).toBe(true);
    expect(beforeEof.some(event => event.type === 'eof')).toBe(false);
    const chunks = beforeEof.filter(event => event.type === 'chunk');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(event => event.crossRealm === true)).toBe(true);
    expect(chunks.some(event => event.splitsUtf8)).toBe(true);
    await articleState.evaluate(state => state.releaseStreams());
    await expect(card.getByText(SELECTED_TRANSLATION, { exact: true })).toBeVisible();
    await expect(card.locator('.nt-loading')).toHaveCount(0);
    const requests = await articleState.evaluate(state => state.requests);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: MODEL_ENDPOINT, responseType: 'stream', anonymous: true, headers: { authorization: 'Bearer fake-saved-model-key' } });
    expect(await article.evaluate(() => document.documentElement.outerHTML)).not.toContain('fake-saved-model-key');
    expect(await article.evaluate(() => Object.getOwnPropertyNames(window).filter(key => /^GM(?:_|$)/.test(key)))).toEqual([]);
    expect(await articleState.evaluate(state => state.rejected)).toEqual([]);
    await article.close();
  }
});

test('the explicit complete-responseText compatibility path still translates model responses', async ({ page }) => {
  const storage = await saveModelSettings(page);
  const state = await installUserscript(page, false, {}, storage, { responseMode: 'text' });
  await expect(page.getByRole('button', { name: '翻译整个页面', exact: true })).toBeVisible();
  await selectParagraph(page, '#selection');
  await page.getByRole('button', { name: '翻译选中文字', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '翻译结果', exact: true }).locator('.nt-text')).toHaveText(SELECTED_TRANSLATION);
  expect((await state.evaluate(state => state.requests))[0]).toMatchObject({ responseType: 'stream' });
  expect(await state.evaluate(state => state.transportEvents.map(event => event.type))).toEqual(['text']);
});

test('a saved DeepSeek Key translates whole-page batches through cross-realm NDJSON streams', async ({ page }) => {
  const storage = await saveModelSettings(page);
  const state = await installUserscript(page, false, {}, storage, { pauseAfterFirstDelta: true });
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  const bar = page.locator('near-page-translate .np-bar');
  await expect(page.locator('near-page-translation[data-state="done"]').first()).toBeVisible();
  await expect(bar).toHaveAttribute('data-status', 'running');
  expect(await state.evaluate(state => state.transportEvents.some(event => event.type === 'eof'))).toBe(false);
  await state.evaluate(state => state.releaseStreams());
  await expect(bar).toHaveAttribute('data-status', 'done');
  const total = Number(await bar.getAttribute('data-total'));
  expect(total).toBeGreaterThan(3);
  await expect(bar).toHaveAttribute('data-completed', String(total));
  await expect(bar).toHaveAttribute('data-failed', '0');
  await expect(page.locator('near-page-translation[data-state="done"]')).toHaveCount(total);
  await expect(page.locator('near-page-translation[data-state="error"]')).toHaveCount(0);
  await expect(page.getByText(SELECTED_TRANSLATION, { exact: true })).toBeVisible();
  await expect(page.getByText(INERT_TRANSLATION, { exact: true })).toBeVisible();
  await expect(page.locator('near-page-translation img')).toHaveCount(0);
  const requests = await state.evaluate(state => state.requests);
  expect(requests.length).toBeGreaterThan(0);
  const sources: string[] = [];
  for (const request of requests) {
    expect(request).toMatchObject({ url: MODEL_ENDPOINT, responseType: 'stream', anonymous: true, headers: { authorization: 'Bearer fake-stream-model-key' } });
    const user = request.body.messages?.find(message => message.role === 'user');
    const batch = JSON.parse(user!.content) as { segments: Array<{ i: number; text: string }> };
    expect(batch.segments.length).toBeGreaterThan(1);
    sources.push(...batch.segments.map(segment => segment.text));
  }
  expect(sources).toContain(SELECTED_TEXT);
  expect(sources.join('\n')).not.toMatch(/Do not translate|must not leave|已有中文|Website navigation|Original page control/);
  const chunks = await state.evaluate(state => state.transportEvents.filter(event => event.type === 'chunk'));
  expect(chunks.every(event => event.crossRealm)).toBe(true);
  expect(chunks.some(event => event.splitsUtf8)).toBe(true);
  expect(await state.evaluate(state => state.rejected)).toEqual([]);
});

test('closing a translation card cancels a live GM stream and prevents late output', async ({ page }) => {
  const storage = await saveModelSettings(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const state = await installUserscript(page, false, {}, storage, { pauseAfterFirstDelta: true });
  await expect(page.getByRole('button', { name: '翻译整个页面', exact: true })).toBeVisible();
  await selectParagraph(page, '#selection');
  await page.getByRole('button', { name: '翻译选中文字', exact: true }).click();
  const card = page.getByRole('dialog', { name: '翻译结果', exact: true });
  await expect(card.locator('.nt-text')).toHaveText(SELECTED_TRANSLATION.slice(0, 2));
  await card.getByRole('button', { name: '关闭翻译', exact: true }).click();
  await expect.poll(() => state.evaluate(state => state.transportEvents.some(event => event.type === 'abort'))).toBe(true);
  await state.evaluate(state => state.releaseStreams());
  await expect(card).toHaveCount(0);
  expect(await state.evaluate(state => state.transportEvents.some(event => event.type === 'eof'))).toBe(false);
  expect(await state.evaluate(state => state.requests.length)).toBe(1);
  expect(await state.evaluate(state => state.rejected)).toEqual([]);
  expect(errors).toEqual([]);
});

test('a GM stream read failure becomes a retryable card error after partial output', async ({ page }) => {
  const storage = await saveModelSettings(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const state = await installUserscript(page, false, {}, storage, { pauseAfterFirstDelta: true, failAfterFirstDelta: true });
  await expect(page.getByRole('button', { name: '翻译整个页面', exact: true })).toBeVisible();
  await selectParagraph(page, '#selection');
  await page.getByRole('button', { name: '翻译选中文字', exact: true }).click();
  const card = page.getByRole('dialog', { name: '翻译结果', exact: true });
  await expect(card.locator('.nt-text')).toHaveText(SELECTED_TRANSLATION.slice(0, 2));
  await state.evaluate(state => state.releaseStreams());
  await expect(card.getByRole('alert')).toBeVisible();
  await expect(card.getByRole('button', { name: '重试', exact: true })).toBeVisible();
  await expect(card.locator('.nt-loading')).toHaveCount(0);
  expect(await state.evaluate(state => state.transportEvents.some(event => event.type === 'failure'))).toBe(true);
  expect(await state.evaluate(state => state.transportEvents.some(event => event.type === 'eof'))).toBe(false);
  expect(await state.evaluate(state => state.requests.length)).toBe(1);
  expect(await card.textContent()).not.toContain('Simulated GM stream');
  expect(errors).toEqual([]);
});

test('a whole-page network failure pauses its queue with one notice until the user retries', async ({ page }) => {
  const state = await installUserscript(page, false, {}, {}, { failRequests: 1 });
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  const bar = page.locator('near-page-translate .np-bar');
  await expect(bar).toHaveAttribute('data-status', 'stopped');
  await expect(bar).toHaveAttribute('data-error-code', 'NETWORK');
  await expect(bar.getByRole('status')).not.toBeEmpty();
  await expect(bar.getByRole('status')).toHaveCount(1);
  await expect(page.locator('near-page-translation[data-state="error"]')).toHaveCount(0);
  const requestCount = await state.evaluate(state => state.requests.length);
  await page.locator('#source-article').evaluate(article => {
    const paragraph = document.createElement('p');
    paragraph.textContent = 'Content added while paused must wait for an explicit translation request.';
    article.append(paragraph);
  });
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(250);
  expect(await state.evaluate(state => state.requests.length)).toBe(requestCount);
  await state.evaluate(state => state.failNextRequests(0));
  await page.locator('near-page-translate .np-primary').hover();
  await bar.getByRole('button', { name: '重试未完成部分', exact: true }).click();
  await expect(page.getByText(SELECTED_TRANSLATION, { exact: true })).toBeVisible();
  await expect(bar).toHaveAttribute('data-status', 'done');
  await expect(bar).not.toHaveAttribute('data-error-code', 'NETWORK');
  await expect(page.locator('near-page-translation[data-state="error"]')).toHaveCount(0);
  expect(await state.evaluate(state => state.requests.length)).toBeGreaterThan(requestCount);
  expect(await state.evaluate(state => state.rejected)).toEqual([]);
});

test('deleting the saved Key stops model translation in a later document', async ({ page }) => {
  const state = await installUserscript(page, true);
  await expect.poll(() => state.evaluate(state => Boolean(state.settingsRoot?.querySelector('select')))).toBe(true);
  await settingsField(state, '翻译方式', 'model');
  await settingsField(state, 'DeepSeek API Key', 'fake-key-to-delete');
  await settingsClick(state, '保存设置');
  await expect.poll(() => state.evaluate(state => state.settingsRoot?.querySelector('[role="status"]')?.textContent)).toContain('设置已保存');
  await settingsField(state, '保存时删除此服务的 Key', true);
  await settingsClick(state, '保存设置');
  await expect.poll(() => state.evaluate(state => state.settingsRoot?.querySelector('input[type="password"]')?.getAttribute('placeholder'))).toBe('填写 API Key');
  const storage = await state.evaluate(state => Object.fromEntries(state.storage));
  expect(JSON.stringify(storage)).not.toContain('fake-key-to-delete');
  const article = await page.context().newPage();
  const articleState = await installUserscript(article, false, {}, storage);
  await expect(article.getByRole('button', { name: '翻译整个页面', exact: true })).toBeVisible();
  await article.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect(article.getByText(/API Key/)).toBeVisible();
  expect(await articleState.evaluate(state => state.requests)).toEqual([]);
  expect(await articleState.evaluate(state => state.rejected)).toEqual([]);
});

test('remote settings changes clear an unfinished Key without locking the form or losing other edits', async ({ page }) => {
  const state = await installUserscript(page, true);
  await expect.poll(() => state.evaluate(state => Boolean(state.settingsRoot?.querySelector('select')))).toBe(true);
  await settingsField(state, '翻译方式', 'model');
  await settingsField(state, 'DeepSeek API Key', 'fake-remote-saved-key');
  await settingsClick(state, '保存设置');
  await expect.poll(() => state.evaluate(state => state.settingsRoot?.querySelector('[role="status"]')?.textContent)).toContain('设置已保存');
  const storage = await state.evaluate(state => Object.fromEntries(state.storage));
  await settingsField(state, '模型名称', 'unsaved-draft-model');
  await settingsField(state, 'API Base URL', 'https://unsaved-model.invalid/v1');
  await settingsField(state, 'DeepSeek API Key', 'fake-unsaved-remote-key');
  const otherPage = await page.context().newPage();
  const other = await installUserscript(otherPage, true, {}, storage);
  await expect.poll(() => other.evaluate(state => Boolean(state.settingsRoot?.querySelector('select')))).toBe(true);
  await settingsField(other, '模型名称', 'remote-saved-model');
  await settingsClick(other, '保存设置');
  await expect.poll(() => other.evaluate(state => state.settingsRoot?.querySelector('[role="status"]')?.textContent)).toContain('设置已保存');
  const changed = await other.evaluate(state => Object.fromEntries(state.storage));
  await state.evaluate((state, changed) => { for (const [key, value] of Object.entries(changed)) state.remoteWrite(key, value); }, changed);
  await expect.poll(() => state.evaluate(state => state.settingsRoot?.querySelector('[role="status"]')?.textContent)).toContain('另一页面更新');
  expect(await state.evaluate(state => {
    const fields = [...state.settingsRoot!.querySelectorAll('label')];
    const field = (label: string) => fields.find(element => element.firstChild?.textContent?.trim() === label
      || [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim() === label)?.querySelector('input') as HTMLInputElement | undefined;
    return { key: field('DeepSeek API Key')?.value, disabled: field('DeepSeek API Key')?.disabled,
      model: field('模型名称')?.value, baseUrl: field('API Base URL')?.value,
      unlock: [...state.settingsRoot!.querySelectorAll('button')].some(button => button.textContent?.includes('解锁')) };
  })).toEqual({ key: '', disabled: false, model: 'unsaved-draft-model', baseUrl: 'https://unsaved-model.invalid/v1', unlock: false });
  expect(await state.evaluate(state => JSON.stringify(Object.fromEntries(state.storage)))).not.toContain('fake-unsaved-remote-key');
  expect(await state.evaluate(state => state.requests)).toEqual([]);
});

test('the optional old-Key import preserves the old vault on error and needs its old passphrase only once', async ({ page }) => {
  const storage = await legacySettings();
  const state = await installUserscript(page, true, {}, storage);
  await expect.poll(() => state.evaluate(state => Boolean(state.settingsRoot?.querySelector('details')))).toBe(true);
  expect(await state.evaluate(state => state.settingsRoot?.querySelector('details')?.open)).toBe(false);
  await settingsClick(state, '导入旧版保存的 Key');
  await settingsField(state, '旧版口令', 'incorrect-old-passphrase');
  await settingsClick(state, '导入旧版 Key');
  await expect.poll(() => state.evaluate(state => state.settingsRoot?.querySelector('[role="alert"]')?.textContent)).toMatch(/口令|导入/);
  expect(await state.evaluate(state => state.storage.get('near-translate:userscript:v1:key-vault:v1'))).toEqual(storage[STORAGE_PREFIX + 'key-vault:v1']);
  await settingsField(state, '旧版口令', LEGACY_PASSPHRASE);
  await settingsClick(state, '导入旧版 Key');
  await expect.poll(() => state.evaluate(state => state.settingsRoot?.querySelector('[role="status"]')?.textContent)).toContain('旧版 Key 已导入');
  const migrated = await state.evaluate(state => Object.fromEntries(state.storage));
  expect(migrated[STORAGE_PREFIX + 'key-vault:v1']).toEqual(storage[STORAGE_PREFIX + 'key-vault:v1']);
  expect(JSON.stringify(migrated)).not.toContain(LEGACY_PASSPHRASE);
  const article = await page.context().newPage();
  const articleState = await installUserscript(article, false, {}, migrated);
  await expect(article.getByRole('button', { name: '翻译整个页面', exact: true })).toBeVisible();
  await selectParagraph(article, '#selection');
  await article.getByRole('button', { name: '翻译选中文字', exact: true }).click();
  await expect(article.getByRole('dialog', { name: '翻译结果', exact: true }).getByText(SELECTED_TRANSLATION, { exact: true })).toBeVisible();
  expect((await articleState.evaluate(state => state.requests))[0]).toMatchObject({ headers: { authorization: 'Bearer ' + LEGACY_KEY } });
});

test('an old encrypted Key can be replaced directly without entering the old passphrase', async ({ page }) => {
  const storage = await legacySettings();
  const state = await installUserscript(page, true, {}, storage);
  await expect.poll(() => state.evaluate(state => Boolean(state.settingsRoot?.querySelector('select')))).toBe(true);
  await settingsField(state, 'DeepSeek API Key', 'fake-reentered-model-key');
  await settingsClick(state, '保存设置');
  await expect.poll(() => state.evaluate(state => state.settingsRoot?.querySelector('[role="status"]')?.textContent)).toBe('设置已保存，返回网页即可翻译。');
  const replaced = await state.evaluate(state => Object.fromEntries(state.storage));
  expect(replaced[STORAGE_PREFIX + 'key-vault:v1']).toEqual(storage[STORAGE_PREFIX + 'key-vault:v1']);
  const article = await page.context().newPage();
  const articleState = await installUserscript(article, false, {}, replaced);
  await expect(article.getByRole('button', { name: '翻译整个页面', exact: true })).toBeVisible();
  await selectParagraph(article, '#selection');
  await article.getByRole('button', { name: '翻译选中文字', exact: true }).click();
  await expect(article.getByRole('dialog', { name: '翻译结果', exact: true }).getByText(SELECTED_TRANSLATION, { exact: true })).toBeVisible();
  expect((await articleState.evaluate(state => state.requests))[0]).toMatchObject({ headers: { authorization: 'Bearer fake-reentered-model-key' } });
});

test('an old encrypted Ollama Key can be discarded without its passphrase to use an unauthenticated local model', async ({ page }) => {
  const storage = await legacySettings('ollama');
  const state = await installUserscript(page, true, {}, storage);
  await expect.poll(() => state.evaluate(state => Boolean(state.settingsRoot?.querySelector('select')))).toBe(true);
  expect(await state.evaluate(state => state.settingsRoot?.querySelector('input[type="password"]')?.getAttribute('placeholder'))).toBe('无鉴权接口可留空');
  expect(await state.evaluate(state => state.settingsRoot?.querySelector('details')?.open)).toBe(false);
  await settingsField(state, '保存时删除此服务的 Key', true);
  await settingsClick(state, '保存设置');
  await expect.poll(() => state.evaluate(state => state.settingsRoot?.querySelector('[role="status"]')?.textContent)).toBe('设置已保存，返回网页即可翻译。');
  const discarded = await state.evaluate(state => Object.fromEntries(state.storage));
  expect(discarded[STORAGE_PREFIX + 'key-vault:v1']).toEqual(storage[STORAGE_PREFIX + 'key-vault:v1']);
  expect(await state.evaluate(state => state.settingsRoot?.querySelector('details'))).toBeNull();
  const article = await page.context().newPage();
  const articleState = await installUserscript(article, false, {}, discarded);
  await expect(article.getByRole('button', { name: '翻译整个页面', exact: true })).toBeVisible();
  await selectParagraph(article, '#selection');
  await article.getByRole('button', { name: '翻译选中文字', exact: true }).click();
  await expect(article.getByRole('dialog', { name: '翻译结果', exact: true }).getByText(SELECTED_TRANSLATION, { exact: true })).toBeVisible();
  const requests = await articleState.evaluate(state => state.requests);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ url: OLLAMA_ENDPOINT, anonymous: true });
  expect(requests[0]!.headers).not.toHaveProperty('authorization');
  expect(await articleState.evaluate(state => state.rejected)).toEqual([]);
});
