// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionSettings } from '../../src/shared/contracts';
import { LegacyKeyImport } from '../../src/ui/settings/LegacyKeyImport';

let root: Root;
let container: HTMLDivElement;
const settings = { profiles: { deepseek: { hasApiKey: true } }, legacyKeyMigrationAvailable: false } as ConnectionSettings;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function mount(available = true, sendMessage = vi.fn(async () => ({ ok: true, settings }))) {
  const changed = vi.fn(), busy = vi.fn();
  function Harness() {
    const [shown, setShown] = useState(available);
    return createElement(LegacyKeyImport, { available: shown, sendMessage, onBusyChange: busy,
      onChanged: next => { changed(next); setShown(next.legacyKeyMigrationAvailable === true); } });
  }
  await act(async () => root.render(createElement(Harness)));
  return { sendMessage, changed, busy };
}
async function fill(value: string) {
  const input = container.querySelector<HTMLInputElement>('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() {
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}

describe('optional legacy Key import', () => {
  it('adds no password step for new or already migrated users', async () => {
    const ui = await mount(false);
    expect(container.childElementCount).toBe(0);
    expect(ui.sendMessage).not.toHaveBeenCalled();
  });
  it('keeps old import collapsed and allows re-entering Key instead', async () => {
    await mount();
    expect(container.querySelector('details')?.open).toBe(false);
    expect(container.textContent).toContain('可以直接重新填写');
    expect(container.querySelector<HTMLInputElement>('input')?.type).toBe('password');
    expect(container.textContent).not.toContain('创建密钥库');
    expect(container.textContent).not.toContain('锁定密钥库');
  });
  it('imports once with the original passphrase and removes the completed recovery entry', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const ui = await mount();
    await fill('  old-test-passphrase  '); await submit();
    expect(ui.sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'import-legacy-keys', passphrase: '  old-test-passphrase  ' });
    expect(ui.changed).toHaveBeenCalledExactlyOnceWith(settings);
    expect(ui.busy.mock.calls).toEqual([[true], [false]]);
    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).not.toContain('old-test-passphrase');
    expect(storage).not.toHaveBeenCalled();
  });
  it('clears a rejected password and leaves the optional import available', async () => {
    const send = vi.fn(async () => ({ ok: false, error: '口令不正确，旧版数据仍保留。' }));
    const ui = await mount(true, send as never);
    await fill('incorrect-test-passphrase'); await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('旧版数据仍保留');
    expect(container.querySelector<HTMLInputElement>('input')?.value).toBe('');
    expect(ui.changed).not.toHaveBeenCalled();
    expect(container.querySelector('details')).not.toBeNull();
  });
  it('does not send an empty recovery password', async () => {
    const ui = await mount(); await submit();
    expect(ui.sendMessage).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('重新填写 API Key');
  });
});
