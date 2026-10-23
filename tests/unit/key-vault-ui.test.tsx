// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionSettings } from '../../src/shared/contracts';
import type { KeyVaultStatus } from '../../src/shared/key-vault';
import { KeyVaultPanel } from '../../src/ui/key-vault/KeyVaultPanel';

let root: Root;
let container: HTMLDivElement;
const fresh: KeyVaultStatus = { configured: false, locked: true, migrationRequired: false, savedProviders: [] };
const unlocked: KeyVaultStatus = { configured: true, locked: false, migrationRequired: false, savedProviders: ['deepseek'] };
const settings = (status: KeyVaultStatus) => ({ profiles: { deepseek: { hasApiKey: true } }, vault: status }) as ConnectionSettings;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function mount(status: KeyVaultStatus, sendMessage = vi.fn(async () => ({ ok: true, status: unlocked, settings: settings(unlocked) }))) {
  const changed = vi.fn(); const busy = vi.fn();
  function Harness() {
    const [value, setValue] = useState(status);
    return createElement(KeyVaultPanel, { status: value, sendMessage, onBusyChange: busy,
      onChanged: next => { changed(next); setValue(next.vault!); } });
  }
  await act(async () => root.render(createElement(Harness)));
  return { sendMessage, changed, busy };
}
async function fill(id: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() {
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === text);
  if (!button) throw new Error('Missing button: ' + text);
  await act(async () => button.click());
}

describe('key vault settings user flows', () => {
  it('requires matching independent passphrases, preserves spaces, and clears inputs after creation', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const ui = await mount(fresh);
    expect(container.textContent).toContain('不要把 API Key 填作口令');
    expect(container.textContent).toContain('口令无法找回');
    for (const input of container.querySelectorAll('input')) {
      expect(input.type).toBe('password'); expect(input.autocomplete).toBe('off');
    }
    const passphrase = '  test-only-password phrase  ';
    await fill('vault-passphrase', passphrase); await fill('vault-confirmation', 'mismatching-test-password');
    await submit(); expect(ui.sendMessage).not.toHaveBeenCalled();
    expect(container.querySelector('[role=alert]')?.textContent).toContain('不一致');
    await fill('vault-confirmation', passphrase); await submit();
    expect(ui.sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'create-key-vault', passphrase });
    expect(ui.changed).toHaveBeenCalledOnce(); expect(ui.busy.mock.calls).toEqual([[true], [false]]);
    expect(container.querySelector('input')).toBeNull(); expect(container.textContent).not.toContain(passphrase);
    expect(container.textContent).toContain('已创建并解锁'); expect(storage).not.toHaveBeenCalled();
  });

  it('explains legacy migration before sending a create command', async () => {
    const ui = await mount({ ...fresh, migrationRequired: true, savedProviders: ['deepseek'] });
    expect(container.textContent).toContain('所有服务的已有 Key 加密迁移');
    expect(container.textContent).toContain('加密迁移已有 Key');
    await fill('vault-passphrase', 'migration-test-password'); await fill('vault-confirmation', 'migration-test-password'); await submit();
    expect(ui.sendMessage).toHaveBeenCalledWith({ type: 'create-key-vault', passphrase: 'migration-test-password' });
    expect(container.querySelector('[role=status]')?.textContent).toContain('已加密迁移');
  });

  it.each(['too-short', 'x'.repeat(129)])('blocks invalid passphrase length without a runtime call', async passphrase => {
    const ui = await mount(fresh);
    await fill('vault-passphrase', passphrase); await fill('vault-confirmation', passphrase); await submit();
    expect(ui.sendMessage).not.toHaveBeenCalled();
    expect(container.querySelector('[role=alert]')?.textContent).toContain('12–128');
  });

  it('keeps the saved-key explanation when locked and clears a rejected password', async () => {
    const sendMessage = vi.fn(async () => ({ ok: false, error: '口令不正确，请重试。' }));
    await mount({ ...unlocked, locked: true }, sendMessage as never);
    expect(container.textContent).toContain('无需重新填写');
    await fill('vault-passphrase', 'wrong-test-password'); await submit();
    expect(container.querySelector('[role=alert]')?.textContent).toBe('口令不正确，请重试。');
    expect(container.querySelector<HTMLInputElement>('#vault-passphrase')?.value).toBe('');
    expect(container.textContent).toContain('已锁定');
    expect(container.textContent).not.toContain('尚未配置 Key');
  });

  it('unlocks using a password field and reveals no stored API key', async () => {
    const ui = await mount({ ...unlocked, locked: true });
    await fill('vault-passphrase', 'unlock-test-password'); await submit();
    expect(ui.sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'unlock-key-vault', passphrase: 'unlock-test-password' });
    expect(container.querySelector('input')).toBeNull(); expect(container.textContent).toContain('密钥库已解锁');
  });

  it('locks without resending a password and allows changing a password with confirmation', async () => {
    const sendMessage = vi.fn(async (message: unknown) => {
      const status = (message as { type: string }).type === 'lock-key-vault' ? { ...unlocked, locked: true } : unlocked;
      return { ok: true, status, settings: settings(status) };
    });
    const ui = await mount(unlocked, sendMessage as never);
    await click('更改口令');
    await fill('vault-passphrase', 'current-test-password'); await fill('vault-new-passphrase', 'new-test-password'); await fill('vault-confirmation', 'new-test-password'); await submit();
    expect(ui.sendMessage).toHaveBeenCalledWith({ type: 'change-key-vault-passphrase', currentPassphrase: 'current-test-password', newPassphrase: 'new-test-password' });
    expect(container.querySelector('input')).toBeNull();
    await click('锁定密钥库');
    expect(ui.sendMessage).toHaveBeenLastCalledWith({ type: 'lock-key-vault' });
    expect(container.textContent).toContain('已锁定');
    expect(container.querySelector<HTMLInputElement>('#vault-passphrase')?.value).toBe('');
  });

  it('clears unsubmitted secret fields when cancelling a password change', async () => {
    const ui = await mount(unlocked);
    await click('更改口令'); await fill('vault-passphrase', 'unsubmitted-test-password'); await click('取消更改');
    expect(container.querySelector('input')).toBeNull(); await click('更改口令');
    expect(container.querySelector<HTMLInputElement>('#vault-passphrase')?.value).toBe(''); expect(ui.sendMessage).not.toHaveBeenCalled();
  });

  it('refreshes the locked state after a partially committed password rotation fails', async () => {
    const locked = { ...unlocked, locked: true };
    const sendMessage = vi.fn(async () => ({ ok: false, status: locked, settings: settings(locked), error: '新口令已生效，请用新口令重新解锁。' }));
    const ui = await mount(unlocked, sendMessage as never);
    await click('更改口令'); await fill('vault-passphrase', 'current-test-password'); await fill('vault-new-passphrase', 'new-test-password'); await fill('vault-confirmation', 'new-test-password'); await submit();
    expect(ui.changed).toHaveBeenCalledWith(expect.objectContaining({ vault: locked }));
    expect(container.textContent).toContain('已锁定'); expect(container.textContent).toContain('解锁密钥库');
    expect(container.querySelector('#vault-new-passphrase')).toBeNull(); expect(container.querySelector<HTMLInputElement>('#vault-passphrase')?.value).toBe('');
    expect(container.querySelector('[role=alert]')?.textContent).toBe('新口令已生效，请用新口令重新解锁。');
  });
});
