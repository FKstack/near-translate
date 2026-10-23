import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const mocks = vi.hoisted(() => ({ sendMessage: vi.fn(), randomUUID: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: { runtime: { sendMessage: mocks.sendMessage } } }));
vi.mock('wxt/utils/define-content-script', () => ({ defineContentScript: (definition: unknown) => definition }));

import definition from '../../src/entrypoints/network-prepare.content';

interface TestContext { onInvalidated(callback: () => void): void }
const entrypoint = definition as unknown as { registration: string; main(ctx: TestContext): void };
const REQUEST_ID = 'c8ba1690-eec1-4055-a872-d8c84f0249ea';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function flushPromises() {
  // The entrypoint deliberately owns a catch/finally chain, not a page timer.
  for (let turn = 0; turn < 4; turn++) await Promise.resolve();
}

let pageWindow: EventTarget & { top: unknown };
let pageDocument: { visibilityState: string; contentType: string };
let pageLocation: { protocol: string };
let invalidations: (() => void)[];
let context: TestContext;
let readPageContent: Mock<() => never>;
let readPageUrl: Mock<() => never>;
let fetcher: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mocks.sendMessage.mockReset().mockResolvedValue({ ok: true });
  mocks.randomUUID.mockReset().mockReturnValue(REQUEST_ID);
  pageWindow = Object.assign(new EventTarget(), { top: undefined as unknown });
  pageWindow.top = pageWindow;
  pageDocument = { visibilityState: 'visible', contentType: 'text/html' };
  pageLocation = { protocol: 'https:' };
  readPageContent = vi.fn(() => { throw new Error('The preparation entrypoint must not read page text.'); });
  readPageUrl = vi.fn(() => { throw new Error('The preparation entrypoint must not read the page URL.'); });
  Object.defineProperties(pageDocument, { body: { get: readPageContent }, documentElement: { get: readPageContent } });
  Object.defineProperties(pageLocation, { href: { get: readPageUrl }, pathname: { get: readPageUrl }, search: { get: readPageUrl } });
  fetcher = vi.fn(() => { throw new Error('Only the background may prepare its service connection.'); });
  vi.stubGlobal('window', pageWindow);
  vi.stubGlobal('document', pageDocument);
  vi.stubGlobal('location', pageLocation);
  vi.stubGlobal('crypto', { randomUUID: mocks.randomUUID });
  vi.stubGlobal('fetch', fetcher);
  invalidations = [];
  context = { onInvalidated: callback => { invalidations.push(callback); } };
});

afterEach(() => {
  expect(fetcher).not.toHaveBeenCalled();
  expect(readPageContent).not.toHaveBeenCalled();
  expect(readPageUrl).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('metadata-only network preparation content entrypoint', () => {
  it.each(['http:', 'https:'])('sends only an opaque request ID from a visible top-level %s document', async protocol => {
    pageLocation.protocol = protocol;
    expect(entrypoint.registration).toBe('runtime');
    entrypoint.main(context);
    expect(mocks.sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'prepare-translation-network', requestId: REQUEST_ID });
    expect(Object.keys(mocks.sendMessage.mock.calls[0]![0]).sort()).toEqual(['requestId', 'type']);
    expect(invalidations).toHaveLength(1);
    await flushPromises();
  });

  it.each([
    { name: 'a hidden page', hidden: true },
    { name: 'an iframe', iframe: true },
    { name: 'a PDF document', contentType: 'application/pdf' },
    { name: 'a local file', protocol: 'file:' },
    { name: 'an extension page', protocol: 'chrome-extension:' },
    { name: 'an about page', protocol: 'about:' },
    { name: 'a data document', protocol: 'data:' },
  ])('does no work for $name', ({ hidden, iframe, contentType, protocol }) => {
    if (hidden) pageDocument.visibilityState = 'hidden';
    if (iframe) pageWindow.top = {};
    if (contentType) pageDocument.contentType = contentType;
    if (protocol) pageLocation.protocol = protocol;
    const add = vi.spyOn(pageWindow, 'addEventListener');
    entrypoint.main(context);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.randomUUID).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(invalidations).toEqual([]);
  });

  it('cancels its pending request once on pagehide, even if invalidation follows', async () => {
    const response = deferred<unknown>();
    mocks.sendMessage.mockImplementation(message => message.type === 'prepare-translation-network'
      ? response.promise : Promise.resolve({ ok: true }));
    const remove = vi.spyOn(pageWindow, 'removeEventListener');
    entrypoint.main(context);
    pageWindow.dispatchEvent(new Event('pagehide'));
    pageWindow.dispatchEvent(new Event('pagehide'));
    invalidations[0]!();
    expect(mocks.sendMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: 'prepare-translation-network', requestId: REQUEST_ID },
      { type: 'cancel-network-preparation', requestId: REQUEST_ID },
    ]);
    expect(remove).toHaveBeenCalledWith('pagehide', expect.any(Function));
    response.resolve({ ok: true });
    await flushPromises();
    expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('cancels the same request on invalidation and tolerates a rejected cancel acknowledgement', async () => {
    const response = deferred<unknown>();
    mocks.sendMessage.mockImplementation(message => message.type === 'prepare-translation-network'
      ? response.promise : Promise.reject(new Error('The old message channel is gone.')));
    entrypoint.main(context);
    invalidations[0]!();
    invalidations[0]!();
    pageWindow.dispatchEvent(new Event('pagehide'));
    expect(mocks.sendMessage).toHaveBeenLastCalledWith({ type: 'cancel-network-preparation', requestId: REQUEST_ID });
    expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
    response.resolve({ ok: false });
    await flushPromises();
  });

  it.each(['resolved', 'rejected'] as const)('removes the pagehide listener after a %s preparation and no longer cancels', async outcome => {
    const response = deferred<unknown>();
    mocks.sendMessage.mockReturnValue(response.promise);
    const add = vi.spyOn(pageWindow, 'addEventListener');
    const remove = vi.spyOn(pageWindow, 'removeEventListener');
    entrypoint.main(context);
    const listener = add.mock.calls.find(([event]) => event === 'pagehide')![1];
    if (outcome === 'resolved') response.resolve({ ok: true });
    else response.reject(new Error('Preparation is optional.'));
    await flushPromises();
    expect(remove).toHaveBeenCalledWith('pagehide', listener);
    pageWindow.dispatchEvent(new Event('pagehide'));
    invalidations[0]!();
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
  });

  it('cleans up after a synchronous prepare-message throw without leaking a later cancellation', () => {
    mocks.sendMessage.mockImplementation(() => { throw new Error('The extension context was destroyed.'); });
    const add = vi.spyOn(pageWindow, 'addEventListener');
    const remove = vi.spyOn(pageWindow, 'removeEventListener');
    expect(() => entrypoint.main(context)).not.toThrow();
    const listener = add.mock.calls.find(([event]) => event === 'pagehide')![1];
    expect(remove).toHaveBeenCalledWith('pagehide', listener);
    pageWindow.dispatchEvent(new Event('pagehide'));
    invalidations[0]!();
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
  });

  it('cleans up before sending a cancellation that throws synchronously', async () => {
    const response = deferred<unknown>();
    mocks.sendMessage.mockImplementation(message => {
      if (message.type === 'prepare-translation-network') return response.promise;
      throw new Error('The extension context was invalidated.');
    });
    const remove = vi.spyOn(pageWindow, 'removeEventListener');
    entrypoint.main(context);
    expect(() => invalidations[0]!()).not.toThrow();
    expect(remove).toHaveBeenCalledWith('pagehide', expect.any(Function));
    pageWindow.dispatchEvent(new Event('pagehide'));
    invalidations[0]!();
    response.resolve({ ok: true });
    await flushPromises();
    expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
  });
});
