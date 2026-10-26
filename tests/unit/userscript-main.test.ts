import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { mountPageTranslator } from '../../src/page/mount';
import type { createReadingMode } from '../../src/reading/mount';

const fixtures = vi.hoisted(() => ({
  page: vi.fn(), reading: vi.fn(), selection: vi.fn(), runtime: vi.fn(),
  beforeUse: vi.fn(), disposePage: vi.fn(), disposeReading: vi.fn(), disposeSelection: vi.fn(),
  disposeRuntime: vi.fn(), disposeStatus: vi.fn(), openReading: vi.fn(),
  registerMenu: vi.fn(), unregisterMenu: vi.fn(),
}));
vi.mock('../../src/page/mount', () => ({ mountPageTranslator: fixtures.page }));
vi.mock('../../src/reading/mount', () => ({ createReadingMode: fixtures.reading }));
vi.mock('../../src/selection/mount', () => ({ mountSelectionTranslator: fixtures.selection }));
vi.mock('../../src/platform/service-status', () => ({ TranslationServiceStatusClient: class { dispose = fixtures.disposeStatus; } }));
vi.mock('../../src/userscript/runtime', () => ({ installRuntime: fixtures.runtime }));
vi.mock('../../src/userscript/Settings', () => ({ mountSettings: vi.fn() }));
vi.mock('../../src/userscript/locations', () => ({ SETTINGS_URL: 'https://example.test/settings', isSettingsPage: () => false }));
vi.mock('../../src/userscript/update', () => ({ createUserscriptUpdater: () => ({ beforeUse: fixtures.beforeUse }) }));

let pageWindow: EventTarget & { top?: unknown };
const flush = async () => { for (let index = 0; index < 6; index++) await Promise.resolve(); };
beforeEach(() => {
  vi.clearAllMocks(); vi.resetModules();
  fixtures.runtime.mockResolvedValue(fixtures.disposeRuntime);
  fixtures.page.mockReturnValue(fixtures.disposePage);
  fixtures.selection.mockReturnValue(fixtures.disposeSelection);
  fixtures.reading.mockReturnValue({ open: fixtures.openReading, close: vi.fn(), dispose: fixtures.disposeReading });
  fixtures.beforeUse.mockResolvedValue(true);
  fixtures.registerMenu.mockImplementation((name: string) => name);
  pageWindow = new EventTarget(); pageWindow.top = pageWindow;
  vi.stubGlobal('window', pageWindow);
  vi.stubGlobal('location', { href: 'https://example.test/article', protocol: 'https:' });
  vi.stubGlobal('document', Object.assign(new EventTarget(), {
    contentType: 'text/html', querySelector: () => null, documentElement: { append: vi.fn() },
  }));
  vi.stubGlobal('GM_registerMenuCommand', fixtures.registerMenu);
  vi.stubGlobal('GM_unregisterMenuCommand', fixtures.unregisterMenu);
  vi.stubGlobal('GM_openInTab', vi.fn());
});
afterEach(() => {
  pageWindow.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }));
  vi.unstubAllGlobals();
});

describe('userscript composition root', () => {
  it('injects one workload policy into page and lazy reading entry points while retaining shared gates and cleanup', async () => {
    const { userscriptPageExecutionPolicy } = await import('../../src/shared/translation-policy');
    await import('../../src/userscript/main'); await flush();
    expect(fixtures.page).toHaveBeenCalledOnce(); expect(fixtures.reading).not.toHaveBeenCalled();
    const pageOptions = fixtures.page.mock.calls[0]![0] as Parameters<typeof mountPageTranslator>[0];
    expect(pageOptions!.executionPolicy).toBe(userscriptPageExecutionPolicy);
    expect(pageOptions!.beforeUse).toBe(fixtures.beforeUse);
    const seed = new Map([['original', '译文']]); pageOptions!.onRead!(seed);
    const readingOptions = fixtures.reading.mock.calls[0]![0] as Parameters<typeof createReadingMode>[0];
    expect(readingOptions!.executionPolicy).toBe(userscriptPageExecutionPolicy);
    expect(readingOptions!.beforeUse).toBe(fixtures.beforeUse);
    expect(readingOptions!.serviceStatus).toBe(pageOptions!.serviceStatus);
    expect(fixtures.openReading).toHaveBeenCalledExactlyOnceWith(seed);
    const readingAction = vi.fn(); pageOptions!.onReadingAction!(readingAction);
    fixtures.registerMenu.mock.calls.find(([name]) => name === '近译 · 阅读当前网页')![1]();
    expect(readingAction).toHaveBeenCalledOnce(); expect(fixtures.reading).toHaveBeenCalledOnce();
    pageWindow.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }));
    for (const dispose of [fixtures.disposePage, fixtures.disposeReading, fixtures.disposeSelection, fixtures.disposeRuntime, fixtures.disposeStatus]) {
      expect(dispose).toHaveBeenCalledOnce();
    }
    expect(fixtures.unregisterMenu).toHaveBeenCalledTimes(2);
  });
});
