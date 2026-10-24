import { expect, test } from '@playwright/test';
import { INERT_TRANSLATION, SELECTED_TEXT, SELECTED_TRANSLATION, installUserscript, selectParagraph, settingsClick, settingsField } from './harness';

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
  expect(await state.evaluate(state => (state.settingsRoot?.querySelector('select') as HTMLSelectElement).value)).toBe('deepl-web');
  await settingsField(state, '翻译方式', 'model');
  await settingsField(state, '源语言', 'en');
  await settingsField(state, '目标语言', 'ja');
  await settingsField(state, '启用翻译', false);
  await settingsClick(state, '保存设置');
  await expect.poll(() => state.evaluate(state => state.settingsRoot?.querySelector('[role="status"]')?.textContent)).toContain('设置已保存');
  const stored = await state.evaluate(state => state.storage.get('near-translate:userscript:v1:settings:v1'));
  expect(stored).toMatchObject({ schemaVersion: 3, translationEngine: 'model', sourceLanguage: 'en', targetLanguage: 'ja', enabled: false });
  expect(JSON.stringify(stored)).not.toContain('apiKey');
  expect(await state.evaluate(state => state.requests)).toEqual([]);
  expect(await state.evaluate(state => state.rejected)).toEqual([]);
  expect(errors).toEqual([]);
});

test('settings encrypt a simulated model Key and clear secret inputs after saving', async ({ page }) => {
  const state = await installUserscript(page, true);
  await expect.poll(() => state.evaluate(state => Boolean(state.settingsRoot?.querySelector('select')))).toBe(true);
  await settingsField(state, '翻译方式', 'model');
  const fakeKey = 'fake-userscript-only-key';
  const fakePassphrase = 'test-only-vault-passphrase';
  await settingsField(state, '设置密钥库口令', fakePassphrase);
  await settingsField(state, '确认口令', fakePassphrase);
  await settingsClick(state, '创建密钥库');
  await expect.poll(() => state.evaluate(state => state.settingsRoot?.querySelector('[role="status"]')?.textContent)).toContain('已解锁');
  await settingsField(state, 'DeepSeek API Key', fakeKey);
  await settingsClick(state, '保存设置');
  await expect.poll(() => state.evaluate(state => state.settingsRoot?.querySelector('[role="status"]')?.textContent)).toContain('设置已保存');
  const storage = await state.evaluate(state => Object.fromEntries(state.storage));
  const vault = storage['near-translate:userscript:v1:key-vault:v1'];
  expect(vault).toMatchObject({ version: 1, savedProviders: ['deepseek'], cipher: { name: 'AES-GCM' }, kdf: { name: 'PBKDF2' } });
  expect(vault).toHaveProperty('ciphertext');
  expect(JSON.stringify(storage)).not.toContain(fakeKey);
  expect(JSON.stringify(storage)).not.toContain(fakePassphrase);
  expect(JSON.stringify(storage['near-translate:userscript:v1:settings:v1'])).not.toContain('apiKey');
  expect(await state.evaluate(state => [...state.settingsRoot?.querySelectorAll('input[type="password"]') ?? []]
    .every(input => (input as HTMLInputElement).value === ''))).toBe(true);
  expect(await page.evaluate(() => Object.getOwnPropertyNames(window).filter(key => /^GM(?:_|$)/.test(key)))).toEqual([]);
  expect(await state.evaluate(state => state.requests)).toEqual([]);
  expect(await state.evaluate(state => state.rejected)).toEqual([]);
});

test('remote settings changes lock the vault, clear the unsaved Key, and preserve connection edits', async ({ page }) => {
  const state = await installUserscript(page, true);
  await expect.poll(() => state.evaluate(state => Boolean(state.settingsRoot?.querySelector('select')))).toBe(true);
  await settingsField(state, '翻译方式', 'model');
  const passphrase = 'test-only-remote-lock-passphrase';
  await settingsField(state, '设置密钥库口令', passphrase);
  await settingsField(state, '确认口令', passphrase);
  await settingsClick(state, '创建密钥库');
  await expect.poll(() => state.evaluate(state => state.settingsRoot?.querySelector('[role="status"]')?.textContent)).toContain('已解锁');
  await settingsField(state, '模型名称', 'unsaved-draft-model');
  await settingsField(state, 'API Base URL', 'https://unsaved-model.invalid/v1');
  await settingsField(state, 'DeepSeek API Key', 'fake-unsaved-remote-lock-key');
  await state.evaluate(state => {
    const key = 'near-translate:userscript:v1:settings:v1';
    const previous = state.storage.get(key) as Record<string, unknown>;
    state.remoteWrite(key, { ...previous, connectionRevision: Number(previous.connectionRevision) + 1 });
  });
  await expect.poll(() => state.evaluate(state => state.settingsRoot?.querySelector('[role="status"]')?.textContent)).toContain('另一页面更改');
  expect(await state.evaluate(state => {
    const root = state.settingsRoot!;
    const field = (label: string) => [...root.querySelectorAll('label')].find(element => element.firstChild?.textContent?.trim() === label
      || [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim() === label)
      ?.querySelector('input') as HTMLInputElement | undefined;
    const key = field('DeepSeek API Key');
    return {
      key: { value: key?.value, disabled: key?.disabled },
      model: field('模型名称')?.value,
      baseUrl: field('API Base URL')?.value,
      unlock: [...root.querySelectorAll('button')].some(button => button.textContent?.trim() === '解锁密钥库'),
      passphrase: field('密钥库口令')?.value,
    };
  })).toEqual({ key: { value: '', disabled: true }, model: 'unsaved-draft-model', baseUrl: 'https://unsaved-model.invalid/v1', unlock: true, passphrase: '' });
  expect(await state.evaluate(state => JSON.stringify(Object.fromEntries(state.storage)))).not.toContain('fake-unsaved-remote-lock-key');
  expect(await page.evaluate(() => Object.hasOwn(window, 'remoteWrite'))).toBe(false);
  expect(await state.evaluate(state => state.requests)).toEqual([]);
  expect(await state.evaluate(state => state.rejected)).toEqual([]);
});
