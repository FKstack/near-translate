import { expect, test } from '@playwright/test';
import { installUserscript, selectParagraph, SELECTED_TRANSLATION } from './harness';

test('an update is checked only on active use; cancel continues translation and prompts again on next use', async ({ page }) => {
  const prompts: string[] = [];
  page.on('dialog', async dialog => { prompts.push(dialog.message()); await dialog.dismiss(); });
  const state = await installUserscript(page, false, { installedVersion: '0.11.4', availableVersion: '0.11.5' });
  await expect(page.getByRole('button', { name: '翻译整个页面', exact: true })).toBeVisible();
  expect(await state.evaluate(state => state.metadataRequests)).toEqual([]);
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect(page.getByText(SELECTED_TRANSLATION, { exact: true })).toBeVisible();
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain('更新后刷新当前页');
  await page.getByRole('button', { name: '恢复原文', exact: true }).click();
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect(page.getByText(SELECTED_TRANSLATION, { exact: true })).toBeVisible();
  expect(prompts).toHaveLength(2);
  expect(await state.evaluate(state => state.metadataRequests)).toEqual([{ method: 'GET', anonymous: true, redirect: 'error',
    url: process.env.NEAR_USERSCRIPT_DISTRIBUTION === 'greasyfork'
      ? 'https://update.greasyfork.org/scripts/601973/%E8%BF%91%E8%AF%91%20%C2%B7%20%E7%BD%91%E9%A1%B5%E9%98%85%E8%AF%BB%E4%B8%8E%E7%BF%BB%E8%AF%91.meta.js'
      : 'https://fkstack.github.io/near-translate/userscript/near-translate.meta.js' }]);
  expect(await state.evaluate(state => state.tabs)).toEqual([]);
  expect(await state.evaluate(state => state.rejected)).toEqual([]);
});

test('accepting an update from the reading shortcut opens this distribution installation and pauses reading', async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  const state = await installUserscript(page, false, { installedVersion: '0.11.4', availableVersion: '0.11.5' });
  await expect(page.getByRole('button', { name: '翻译整个页面', exact: true })).toBeVisible();
  await page.keyboard.press('Alt+Shift+R');
  const install = process.env.NEAR_USERSCRIPT_DISTRIBUTION === 'greasyfork'
    ? 'https://update.greasyfork.org/scripts/601973/%E8%BF%91%E8%AF%91%20%C2%B7%20%E7%BD%91%E9%A1%B5%E9%98%85%E8%AF%BB%E4%B8%8E%E7%BF%BB%E8%AF%91.user.js'
    : 'https://fkstack.github.io/near-translate/userscript/near-translate.user.js';
  await expect.poll(() => state.evaluate(state => state.tabs)).toEqual([install]);
  await expect(page.getByRole('dialog', { name: '近译阅读模式', exact: true })).toHaveCount(0);
  expect(await state.evaluate(state => state.requests)).toEqual([]);
});

test('selection and reading translation each prompt once per active use, with no paragraph prompts', async ({ page }) => {
  let prompts = 0;
  page.on('dialog', async dialog => { prompts++; await dialog.dismiss(); });
  const state = await installUserscript(page, false, { installedVersion: '0.11.4', availableVersion: '0.11.5' });
  await expect(page.getByRole('button', { name: '翻译整个页面', exact: true })).toBeVisible();
  await selectParagraph(page, '#selection');
  await page.getByRole('button', { name: '翻译选中文字', exact: true }).click();
  const card = page.getByRole('dialog', { name: '翻译结果', exact: true });
  await expect(card.getByText(SELECTED_TRANSLATION, { exact: true })).toBeVisible();
  expect(prompts).toBe(1);
  await card.getByRole('button', { name: '关闭翻译', exact: true }).click();
  await page.locator('near-page-translate .np-primary').hover();
  await page.getByRole('button', { name: '阅读模式', exact: true }).click();
  const reader = page.getByRole('dialog', { name: '近译阅读模式', exact: true });
  await expect(reader).toBeVisible();
  expect(prompts).toBe(2);
  await reader.getByRole('button', { name: '翻译正文', exact: true }).click();
  await expect(reader.getByText(SELECTED_TRANSLATION, { exact: true })).toBeVisible();
  expect(prompts).toBe(3);
  expect(await state.evaluate(state => state.metadataRequests.length)).toBe(1);
});

test('installing the latest version ends the reminder', async ({ page }) => {
  let prompts = 0;
  page.on('dialog', async dialog => { prompts++; await dialog.dismiss(); });
  const state = await installUserscript(page, false, { installedVersion: '0.11.5', availableVersion: '0.11.5' });
  await expect(page.getByRole('button', { name: '翻译整个页面', exact: true })).toBeVisible();
  await page.keyboard.press('Alt+Shift+R');
  await expect(page.getByRole('dialog', { name: '近译阅读模式', exact: true })).toBeVisible();
  expect(prompts).toBe(0);
  expect(await state.evaluate(state => state.metadataRequests.length)).toBe(1);
});

test('a failed update check stays quiet and leaves local reading available', async ({ page }) => {
  let prompts = 0;
  page.on('dialog', async dialog => { prompts++; await dialog.dismiss(); });
  const state = await installUserscript(page, false, { installedVersion: '0.11.4', metadataFailure: true });
  await expect(page.getByRole('button', { name: '翻译整个页面', exact: true })).toBeVisible();
  await page.keyboard.press('Alt+Shift+R');
  const reader = page.getByRole('dialog', { name: '近译阅读模式', exact: true });
  await expect(reader).toBeVisible();
  await reader.getByRole('button', { name: '退出阅读模式', exact: true }).click();
  await page.keyboard.press('Alt+Shift+R');
  await expect(reader).toBeVisible();
  expect(prompts).toBe(0);
  expect(await state.evaluate(state => state.metadataRequests.length)).toBe(1);
});
