import { afterEach, describe, expect, it, vi } from 'vitest';
import { beforeUserAction } from '../../src/shared/before-use';
import { createUserscriptUpdater, isNewerVersion, metadataVersion, requestUpdateMetadata, UPDATE_CHANNELS, type UpdateDependencies } from '../../src/userscript/update';
import type { GMMetadataRequest } from '../../src/userscript/gm';

const DAY = 86_400_000;
const metadata = (version: string) => `// ==UserScript==\n// @name 近译\n// @version ${version}\n// ==/UserScript==\n`;
function fixture() {
  const values = new Map<string, unknown>();
  const dependencies: UpdateDependencies = { currentVersion: '0.11.4', now: () => DAY * 10,
    read: key => structuredClone(values.get(key)), write: (key, value) => { values.set(key, structuredClone(value)); },
    metadata: vi.fn().mockResolvedValue(metadata('0.11.5')), confirm: vi.fn().mockReturnValue(false), open: vi.fn() };
  return { values, dependencies, updater: createUserscriptUpdater('greasyfork', dependencies) };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('strict userscript version metadata', () => {
  it.each(['1.2.4', '1.3.0', '2.0.0'])('compares stable version %s numerically', candidate => {
    expect(isNewerVersion(candidate, '1.2.3')).toBe(true);
    expect(isNewerVersion('1.2.3', candidate)).toBe(false);
  });
  it('follows SemVer prerelease ordering and ignores build identifiers', () => {
    const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
    ordered.slice(1).forEach((item, index) => expect(isNewerVersion(item, ordered[index]!)).toBe(true));
    expect(isNewerVersion('1.0.0+new', '1.0.0+old')).toBe(false);
    expect(isNewerVersion('1.10.0', '1.9.0')).toBe(true);
  });
  it.each(['v1.0.0', '01.0.0', '1.0', '1.0.0-01', '1.0.0.foo', '1.0.0\nalert(1)', '9007199254740992.0.0'])('rejects malformed version %s', value => {
    expect(metadataVersion(metadata(value))).toBeUndefined();
    expect(isNewerVersion(value, '0.0.1')).toBe(false);
  });
  it('accepts one metadata version and rejects code, duplicate versions and oversized Unicode bodies', () => {
    expect(metadataVersion(metadata('0.11.5'))).toBe('0.11.5');
    expect(metadataVersion(`${metadata('0.11.5')}alert('remote code')`)).toBeUndefined();
    expect(metadataVersion(metadata('0.11.5').replace('// @name', '// @version 2.0.0\n// @name'))).toBeUndefined();
    expect(metadataVersion(metadata('0.11.5').replace('// @name', 'alert(1)\n// @name'))).toBeUndefined();
    expect(metadataVersion(metadata('0.11.5').replace('近译', '译'.repeat(24_000)))).toBeUndefined();
  });
});

describe('active-use update choice and shared daily cache', () => {
  it('does nothing at construction; declining continues and the next use asks again without another GET', async () => {
    const { updater, dependencies } = fixture();
    expect(dependencies.metadata).not.toHaveBeenCalled();
    expect(await updater.beforeUse()).toBe(true);
    expect(await updater.beforeUse()).toBe(true);
    expect(dependencies.metadata).toHaveBeenCalledTimes(1);
    expect(dependencies.confirm).toHaveBeenCalledTimes(2);
    expect(dependencies.confirm).toHaveBeenCalledWith(expect.stringContaining('更新后刷新当前页'));
    expect(dependencies.open).not.toHaveBeenCalled();
  });
  it.each(['github', 'greasyfork'] as const)('accepting opens only the fixed %s installation URL and pauses this action', async distribution => {
    const { dependencies } = fixture();
    vi.mocked(dependencies.confirm).mockReturnValue(true);
    expect(await createUserscriptUpdater(distribution, dependencies).beforeUse()).toBe(false);
    expect(dependencies.open).toHaveBeenCalledExactlyOnceWith(UPDATE_CHANNELS[distribution].install);
  });
  it('new installed version is not prompted from the old stored candidate', async () => {
    const { updater, dependencies } = fixture();
    await updater.beforeUse();
    vi.mocked(dependencies.confirm).mockClear();
    const updated = createUserscriptUpdater('greasyfork', { ...dependencies, currentVersion: '0.11.5' });
    expect(await updated.beforeUse()).toBe(true);
    expect(dependencies.confirm).not.toHaveBeenCalled();
    expect(dependencies.metadata).toHaveBeenCalledTimes(1);
  });
  it('reserves before the request, shares cache across pages, and coalesces same-page actions', async () => {
    const { updater, dependencies, values } = fixture();
    let finish!: (value: string) => void;
    vi.mocked(dependencies.metadata).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = updater.beforeUse();
    const duplicate = updater.beforeUse();
    expect(first).toBe(duplicate);
    expect([...values.values()]).toEqual([{ checkedAt: DAY * 10 }]);
    expect(await createUserscriptUpdater('greasyfork', dependencies).beforeUse()).toBe(true);
    expect(dependencies.metadata).toHaveBeenCalledTimes(1);
    finish(metadata('0.11.5'));
    await first;
    expect(await createUserscriptUpdater('greasyfork', dependencies).beforeUse()).toBe(true);
    expect(dependencies.confirm).toHaveBeenCalledTimes(2);
  });
  it('network failure continues the old functionality and suppresses retries for a full 24 hours', async () => {
    const { updater, dependencies } = fixture();
    vi.mocked(dependencies.metadata).mockRejectedValue(new Error('offline'));
    expect(await updater.beforeUse()).toBe(true);
    expect(await createUserscriptUpdater('greasyfork', { ...dependencies, now: () => DAY * 11 - 1 }).beforeUse()).toBe(true);
    expect(dependencies.metadata).toHaveBeenCalledTimes(1);
    expect(await createUserscriptUpdater('greasyfork', { ...dependencies, now: () => DAY * 11 }).beforeUse()).toBe(true);
    expect(dependencies.metadata).toHaveBeenCalledTimes(2);
    expect(dependencies.confirm).not.toHaveBeenCalled();
  });
  it('still offers a previously verified update if the next daily check fails', async () => {
    const { updater, dependencies } = fixture();
    await updater.beforeUse();
    vi.mocked(dependencies.metadata).mockRejectedValue(new Error('offline'));
    await createUserscriptUpdater('greasyfork', { ...dependencies, now: () => DAY * 11 }).beforeUse();
    expect(dependencies.confirm).toHaveBeenCalledTimes(2);
  });
  it('ignores untrusted metadata URL instructions and never opens a page until confirmation', async () => {
    const { updater, dependencies } = fixture();
    vi.mocked(dependencies.metadata).mockResolvedValue(metadata('0.11.5').replace('// @name', '// @downloadURL https://evil.example/install.user.js\n// @name'));
    vi.mocked(dependencies.confirm).mockReturnValue(true);
    await updater.beforeUse();
    expect(dependencies.open).toHaveBeenCalledExactlyOnceWith(UPDATE_CHANNELS.greasyfork.install);
  });
  it('storage failure and unknown installed versions quietly continue without network', async () => {
    const { dependencies } = fixture();
    expect(await createUserscriptUpdater('greasyfork', { ...dependencies, read: () => { throw new Error('storage disabled'); } }).beforeUse()).toBe(true);
    expect(await createUserscriptUpdater('greasyfork', { ...dependencies, currentVersion: '' }).beforeUse()).toBe(true);
    expect(dependencies.metadata).not.toHaveBeenCalled();
  });
});

describe('metadata transport boundaries', () => {
  function setup() {
    vi.stubGlobal('GM_info', { scriptHandler: 'Tampermonkey', version: '5.4.0' });
    let options!: GMMetadataRequest;
    const abort = vi.fn();
    vi.stubGlobal('GM_xmlhttpRequest', vi.fn((request: GMMetadataRequest) => { options = request; return { abort }; }));
    const result = requestUpdateMetadata('greasyfork');
    return { get options() { return options; }, abort, result };
  }
  it('uses anonymous fixed GET with redirects forbidden, an explicit timeout, and no secret/body', async () => {
    const state = setup();
    expect(state.options).toMatchObject({ method: 'GET', url: UPDATE_CHANNELS.greasyfork.metadata, anonymous: true, redirect: 'error', timeout: 5000, responseType: 'text' });
    expect(state.options).not.toHaveProperty('data');
    expect(state.options.headers).toEqual({ Accept: 'text/plain' });
    state.options.onload({ status: 200, finalUrl: UPDATE_CHANNELS.greasyfork.metadata, responseText: metadata('0.11.5') });
    expect(await state.result).toBe(metadata('0.11.5'));
  });
  it.each(['redirect', 'status', 'size', 'declared-size', 'progress'] as const)('rejects %s and aborts', async failure => {
    const state = setup();
    const response = { status: 200, finalUrl: UPDATE_CHANNELS.greasyfork.metadata, responseText: metadata('0.11.5'),
      ...(failure === 'redirect' ? { finalUrl: 'https://evil.example/' } : {}),
      ...(failure === 'status' ? { status: 503 } : {}),
      ...(failure === 'size' ? { responseText: '译'.repeat(24_000) } : {}),
      ...(failure === 'declared-size' ? { responseHeaders: 'Content-Length: 65537\r\n' } : {}),
      ...(failure === 'progress' ? { loaded: 65537 } : {}) };
    const rejected = expect(state.result).rejects.toThrow('更新检查');
    state.options.onload(response);
    await rejected;
    expect(state.abort).toHaveBeenCalledTimes(1);
  });
  it('has its own deadline even if the manager never calls a callback', async () => {
    vi.useFakeTimers();
    const state = setup();
    const rejected = expect(state.result).rejects.toThrow('更新检查');
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(state.abort).toHaveBeenCalledTimes(1);
  });
});

it('optional action hooks preserve synchronous extension behavior, cancellations and failures', async () => {
  const action = vi.fn();
  beforeUserAction(undefined, action);
  expect(action).toHaveBeenCalledTimes(1);
  beforeUserAction(async () => false, action);
  await Promise.resolve();
  expect(action).toHaveBeenCalledTimes(1);
  beforeUserAction(async () => true, action);
  await Promise.resolve();
  expect(action).toHaveBeenCalledTimes(2);
  beforeUserAction(() => Promise.reject(new Error('failed')), action);
  await Promise.resolve();
  expect(action).toHaveBeenCalledTimes(3);
});
