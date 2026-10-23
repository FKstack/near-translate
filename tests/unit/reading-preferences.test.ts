import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_READING_PREFERENCES, normalizeReadingPreferences, type ReadingPreferences } from '../../src/shared/reading';

const mocks = vi.hoisted(() => ({
  stored: {} as Record<string, unknown>,
  get: vi.fn(), set: vi.fn(), restrict: vi.fn(), readSettings: vi.fn(), saveSettings: vi.fn(),
}));
vi.mock('wxt/browser', () => ({ browser: { storage: { local: { get: mocks.get, set: mocks.set } } } }));
vi.mock('../../src/platform/settings', () => ({
  restrictStorageAccess: mocks.restrict, readSettings: mocks.readSettings, saveSettings: mocks.saveSettings,
}));

const KEY = 'reading-preferences:v1';
const preferenceKeys = ['theme', 'fontSize', 'lineHeight', 'width', 'columnWidth', 'fontFamily', 'focus', 'letterSpacing',
  'wordSpacing', 'paragraphSpacing', 'textAlign', 'codeWrap', 'translationScale', 'translationStyle', 'colors', 'mode', 'savedStyle'].sort();
const preferences = (changes: Partial<ReadingPreferences> = {}): ReadingPreferences => ({ ...DEFAULT_READING_PREFERENCES, ...changes });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let index = 0; index < 6; index++) await Promise.resolve(); }

describe('reading preference normalization', () => {
  it.each([undefined, null, false, 42, 'dark', []])('uses safe defaults for non-record input %j', input => {
    expect(normalizeReadingPreferences(input)).toEqual(DEFAULT_READING_PREFERENCES);
  });

  it.each([
    [-100, 14], [13.9, 14], [16, 16], [20.49, 20], [20.5, 21], [36, 36], [100, 36],
    [NaN, 20], [Infinity, 20], [-Infinity, 20], ['24', 20],
  ])('bounds and rounds font size %j to %j', (input, expected) => {
    expect(normalizeReadingPreferences({ fontSize: input }).fontSize).toBe(expected);
  });

  it.each([
    [-100, 1.4], [1.39, 1.4], [1.5, 1.5], [1.856, 1.86], [2.4, 2.4], [100, 2.4],
    [NaN, 1.85], [Infinity, 1.85], [-Infinity, 1.85], ['1.9', 1.85],
  ])('bounds and rounds line height %j to %j', (input, expected) => {
    expect(normalizeReadingPreferences({ lineHeight: input }).lineHeight).toBe(expected);
  });

  it.each(['paper', 'sepia', 'dark', 'system', 'contrast', 'custom'] as const)('keeps the supported %s theme', theme => {
    expect(normalizeReadingPreferences({ theme }).theme).toBe(theme);
  });

  it.each(['original', 'bilingual', 'translation'] as const)('keeps the supported %s mode', mode => {
    expect(normalizeReadingPreferences({ mode }).mode).toBe(mode);
  });

  it.each(['narrow', 'comfortable', 'wide', 'custom'] as const)('keeps the supported %s width', width => {
    expect(normalizeReadingPreferences({ width }).width).toBe(width);
  });

  it('keeps all supported fields and accepts only boolean true for focus', () => {
    const input = preferences({ theme: 'paper', fontSize: 28, lineHeight: 2.2, width: 'wide', fontFamily: 'sans', mode: 'bilingual', focus: true });
    expect(normalizeReadingPreferences(input)).toEqual(input);
    for (const focus of ['true', 1, [], {}, null]) expect(normalizeReadingPreferences({ focus }).focus).toBe(false);
  });

  it('falls back for unknown enums and malformed field types', () => {
    expect(normalizeReadingPreferences({ theme: 'DARK', mode: 'side-by-side', width: 'full', fontFamily: 'monospace', focus: 'yes' }))
      .toEqual(DEFAULT_READING_PREFERENCES);
    expect(normalizeReadingPreferences({ theme: ['dark'], mode: ['translation'], width: ['wide'] }))
      .toEqual(DEFAULT_READING_PREFERENCES);
    expect(normalizeReadingPreferences({ theme: {}, mode: {}, width: {}, fontFamily: ['sans'] }))
      .toEqual(DEFAULT_READING_PREFERENCES);
  });

  it('drops arbitrary article, URL and key fields instead of retaining caller content', () => {
    const input = { ...preferences({ theme: 'dark' }), articleText: 'private article body', html: '<p>private</p>',
      url: 'https://private.example/article', apiKey: 'private-api-key', key: 'private-key', settings: { enabled: true } };
    const value = normalizeReadingPreferences(input);
    expect(value).toEqual(preferences({ theme: 'dark' }));
    expect(Object.keys(value).sort()).toEqual(preferenceKeys);
    expect(JSON.stringify(value)).not.toMatch(/private|articleText|apiKey|settings/);
    value.theme = 'paper';
    expect(input.theme).toBe('dark'); expect(DEFAULT_READING_PREFERENCES.theme).toBe('sepia');
  });
});

describe('reading preference storage', () => {
  let storage: typeof import('../../src/platform/reading-preferences');

  beforeEach(async () => {
    vi.resetModules();
    mocks.stored = { 'settings:v1': { apiKey: 'settings-secret', model: 'untouched-model' } };
    mocks.get.mockReset().mockImplementation(async (key: string) => ({ [key]: mocks.stored[key] }));
    mocks.set.mockReset().mockImplementation(async (value: Record<string, unknown>) => { Object.assign(mocks.stored, value); });
    mocks.restrict.mockReset().mockResolvedValue(undefined);
    mocks.readSettings.mockReset(); mocks.saveSettings.mockReset();
    storage = await import('../../src/platform/reading-preferences');
  });

  it('reads only its independent key and normalizes missing or malformed stored data without writes', async () => {
    expect(await storage.readReadingPreferences()).toEqual(DEFAULT_READING_PREFERENCES);
    mocks.stored[KEY] = { theme: 'unknown', fontSize: 99, lineHeight: 0, mode: 'unknown', url: 'private-url', apiKey: 'private-key' };
    expect(await storage.readReadingPreferences()).toEqual(preferences({ fontSize: 36, lineHeight: 1.4 }));
    expect(mocks.get.mock.calls).toEqual([[KEY], [KEY]]);
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.readSettings).not.toHaveBeenCalled(); expect(mocks.saveSettings).not.toHaveBeenCalled();
    expect(mocks.stored['settings:v1']).toEqual({ apiKey: 'settings-secret', model: 'untouched-model' });
  });

  it('persists only normalized content-free preferences and leaves model settings untouched', async () => {
    const input = { theme: 'dark', fontSize: 44, lineHeight: 1, width: 'narrow', fontFamily: 'sans', mode: 'translation', focus: true,
      article: 'private article', url: 'https://private.example', apiKey: 'private-key', profiles: { secret: true } };
    const expected = preferences({ theme: 'dark', fontSize: 36, lineHeight: 1.4, width: 'narrow', fontFamily: 'sans', mode: 'translation', focus: true });
    expect(await storage.saveReadingPreferences(input)).toEqual(expected);
    expect(mocks.set).toHaveBeenCalledExactlyOnceWith({ [KEY]: expected });
    expect(Object.keys(mocks.stored[KEY] as Record<string, unknown>).sort()).toEqual(preferenceKeys);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.readSettings).not.toHaveBeenCalled(); expect(mocks.saveSettings).not.toHaveBeenCalled();
    expect(mocks.stored['settings:v1']).toEqual({ apiKey: 'settings-secret', model: 'untouched-model' });
  });

  it.each(['read', 'save'] as const)('restricts storage access before a %s touches local storage', async operation => {
    const access = deferred<void>(); mocks.restrict.mockReturnValueOnce(access.promise);
    const task = operation === 'read' ? storage.readReadingPreferences() : storage.saveReadingPreferences({ theme: 'paper' });
    await flush();
    expect(mocks.restrict).toHaveBeenCalledTimes(1);
    expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.set).not.toHaveBeenCalled();
    access.resolve(undefined); await task;
    expect(operation === 'read' ? mocks.get : mocks.set).toHaveBeenCalledTimes(1);
  });

  it('serializes writes so a slower earlier save cannot overwrite a later preference', async () => {
    const gate = deferred<void>(); const started = deferred<void>();
    mocks.set.mockImplementationOnce(async (value: Record<string, unknown>) => {
      started.resolve(undefined); await gate.promise; Object.assign(mocks.stored, value);
    });
    const first = storage.saveReadingPreferences({ theme: 'paper' });
    const second = storage.saveReadingPreferences({ theme: 'dark' });
    await started.promise; await flush();
    expect(mocks.set).toHaveBeenCalledTimes(1); expect(mocks.stored[KEY]).toBeUndefined();
    gate.resolve(undefined); await Promise.all([first, second]);
    expect(mocks.set.mock.calls.map(([value]) => (value as Record<string, ReadingPreferences>)[KEY]!.theme)).toEqual(['paper', 'dark']);
    expect(mocks.stored[KEY]).toEqual(preferences({ theme: 'dark' }));
  });

  it('waits for a pending write before reading instead of returning an older preference', async () => {
    const gate = deferred<void>(); const started = deferred<void>();
    mocks.stored[KEY] = preferences({ theme: 'paper' });
    mocks.set.mockImplementationOnce(async (value: Record<string, unknown>) => {
      started.resolve(undefined); await gate.promise; Object.assign(mocks.stored, value);
    });
    const saving = storage.saveReadingPreferences({ theme: 'dark' }); await started.promise;
    let settled = false;
    const reading = storage.readReadingPreferences().then(value => { settled = true; return value; });
    await flush(); expect(settled).toBe(false); expect(mocks.get).not.toHaveBeenCalled();
    gate.resolve(undefined); await saving;
    expect(await reading).toEqual(preferences({ theme: 'dark' })); expect(mocks.get).toHaveBeenCalledExactlyOnceWith(KEY);
  });

  it.each(['access', 'write'] as const)('does not poison later saves after a failed %s', async failure => {
    if (failure === 'access') mocks.restrict.mockRejectedValueOnce(new Error('access failed'));
    else mocks.set.mockRejectedValueOnce(new Error('write failed'));
    const failed = storage.saveReadingPreferences({ theme: 'paper' });
    const observedFailure = expect(failed).rejects.toThrow(`${failure} failed`);
    const succeeding = storage.saveReadingPreferences({ theme: 'dark' });
    await observedFailure; expect(await succeeding).toEqual(preferences({ theme: 'dark' }));
    expect(await storage.readReadingPreferences()).toEqual(preferences({ theme: 'dark' }));
    expect(mocks.set).toHaveBeenCalledTimes(failure === 'access' ? 1 : 2);
  });
});
