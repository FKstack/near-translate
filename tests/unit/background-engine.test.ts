import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredSettings, TranslationInput, TranslationServerMessage } from '../../src/shared/contracts';
import { DEEPL_WEB_ORIGIN } from '../../src/shared/translation-engine';
import type { KeyVaultStatus } from '../../src/shared/key-vault';

let VaultError: new (message: string) => Error;

const state = vi.hoisted(() => ({
  settings: undefined as unknown as StoredSettings,
  readSettings: vi.fn(), saveSettings: vi.fn(), contains: vi.fn(), updateSessionRules: vi.fn(),
  deeplConstructed: vi.fn(), modelConstructed: vi.fn(), deeplTranslate: vi.fn(), modelTranslate: vi.fn(),
  prepareNetwork: vi.fn(), cancelPreparation: vi.fn(), enableFree: vi.fn(), serviceStatus: vi.fn(),
  broadcastStatus: vi.fn(), persistCooldown: vi.fn(), loadCooldown: vi.fn(), reservePreparation: vi.fn(),
  vault: undefined as unknown as KeyVaultStatus,
  vaultStatus: vi.fn(), createVault: vi.fn(), unlockVault: vi.fn(), lockVault: vi.fn(), changeVault: vi.fn(),
  connectionSettings: vi.fn(), broadcastPublic: vi.fn(),
  onConnect: undefined as unknown as (port: unknown) => void,
  onMessage: undefined as unknown as (message: unknown, sender: unknown, respond: (result: unknown) => void) => boolean,
  onRemoved: undefined as unknown as () => void,
}));

vi.mock('wxt/browser', () => ({ browser: {
  runtime: {
    id: 'test-extension', getURL: (path: string) => `chrome-extension://test-extension/${path}`,
    onConnect: { addListener: (listener: typeof state.onConnect) => { state.onConnect = listener; } },
    onMessage: { addListener: (listener: typeof state.onMessage) => { state.onMessage = listener; } },
    onInstalled: { addListener: vi.fn() }, onStartup: { addListener: vi.fn() }, openOptionsPage: vi.fn(),
  },
  permissions: {
    contains: state.contains, onAdded: { addListener: vi.fn() },
    onRemoved: { addListener: (listener: typeof state.onRemoved) => { state.onRemoved = listener; } },
  },
  declarativeNetRequest: { updateSessionRules: state.updateSessionRules },
} }));
vi.mock('../../src/platform/settings', () => ({
  readSettings: state.readSettings, saveSettings: state.saveSettings, enableFreeTranslation: state.enableFree,
  restrictStorageAccess: async () => undefined,
  publicSettings: async () => ({}), connectionSettings: state.connectionSettings,
  keyVaultStatus: state.vaultStatus, createKeyVault: state.createVault, unlockKeyVault: state.unlockVault,
  lockKeyVault: state.lockVault, changeKeyVaultPassphrase: state.changeVault,
  WEB_ORIGINS: ['http://*/*', 'https://*/*'],
}));
vi.mock('../../src/platform/web-access', () => ({
  broadcastPublicSettings: state.broadcastPublic, broadcastTranslationStatus: state.broadcastStatus, synchronizeContentRegistration: async () => undefined,
}));
vi.mock('../../src/platform/deepl-web-state', () => ({
  createDeepLWebCooldownState: () => ({ loadCooldownUntil: state.loadCooldown, persistCooldownUntil: state.persistCooldown }),
  createDeepLWebPreparationState: () => ({ reservePreparation: state.reservePreparation }),
}));
vi.mock('../../src/providers/deepl-web', () => ({ DeepLWebProvider: class {
  constructor(transport: unknown, options: unknown) { state.deeplConstructed(transport, options); }
  translate(input: TranslationInput, signal: AbortSignal) { return state.deeplTranslate(input, signal); }
  prepareNetwork() { return state.prepareNetwork(); }
  cancelPreparation() { state.cancelPreparation(); }
  getServiceStatus() { return state.serviceStatus(); }
} }));
vi.mock('../../src/providers/openai-compatible', () => ({ OpenAICompatibleProvider: class {
  constructor(configuration: unknown) { state.modelConstructed(configuration); }
  translate(input: TranslationInput, signal: AbortSignal) { return state.modelTranslate(input, signal); }
} }));

function connect(trusted = true) {
  const messages: TranslationServerMessage[] = [];
  let receive!: (message: unknown) => void;
  let disconnect!: () => void;
  const port = {
    name: 'near-translate:v1',
    sender: { id: 'test-extension', url: trusted ? 'chrome-extension://test-extension/reader.html' : 'https://example.com/' },
    postMessage: (message: TranslationServerMessage) => { messages.push(message); },
    onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
    onDisconnect: { addListener: (listener: typeof disconnect) => { disconnect = listener; } },
  };
  state.onConnect(port);
  return {
    messages, disconnect: () => disconnect(),
    start: (input: TranslationInput, requestId = 'request-1') => receive({ type: 'translate', requestId, input }),
  };
}

async function completed(port: ReturnType<typeof connect>) {
  await vi.waitFor(() => expect(port.messages.some(message => ['result', 'analysis', 'error'].includes(message.type))).toBe(true));
}

async function* result(input: TranslationInput) {
  yield { type: 'result', result: { kind: 'text', translation: `译文：${input.text}` } };
}

async function* waiting(_input: TranslationInput, signal: AbortSignal) {
  await new Promise<void>(resolve => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const providerOptions = () => state.deeplConstructed.mock.calls[0]![1] as {
  onDiagnostic(value: object): void; persistCooldownUntil(until: number): Promise<void>;
};
const rateDiagnostic = () => ({ at: Date.now(), httpStatus: 429, bodyOutcome: 'timeout', bodyCompletedAt: Date.now() });

describe('background engine boundary', () => {
  it('only exposes content-free metrics to trusted extension pages', () => {
    const blocked = vi.fn();
    state.onMessage({ type: 'get-translation-metrics' }, { id: 'test-extension', url: 'https://example.com/' }, blocked);
    expect(blocked).not.toHaveBeenCalled();
    const allowed = vi.fn();
    state.onMessage({ type: 'get-translation-metrics' }, { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' }, allowed);
    expect(allowed).toHaveBeenCalledWith(expect.objectContaining({ requestCount: 0, requests: [] }));
    expect(JSON.stringify(allowed.mock.calls)).not.toContain('kept-model-secret');
  });

  it('keeps bounded detached rate-limit diagnostics behind the trusted message boundary', () => {
    const options = state.deeplConstructed.mock.calls[0]![1] as { onDiagnostic(value: object): void };
    for (let index = 0; index < 70; index++) options.onDiagnostic({ at: index, httpStatus: 429, rpcErrorCode: 1042911,
      bodyOutcome: 'json', bodyCompletedAt: index + 1 });
    const allowed = vi.fn();
    state.onMessage({ type: 'get-translation-metrics' }, { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' }, allowed);
    const first = allowed.mock.calls[0]![0].rateLimitDiagnostics;
    expect(first).toHaveLength(64);
    expect(first[0].at).toBe(6);
    first[0].rpcErrorCode = 0;
    const again = vi.fn();
    state.onMessage({ type: 'get-translation-metrics' }, { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' }, again);
    expect(again.mock.calls[0]![0].rateLimitDiagnostics[0].rpcErrorCode).toBe(1042911);
  });

  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubGlobal('defineBackground', (setup: () => void) => ({ main: setup }));
    state.settings = {
      schemaVersion: 2, translationEngine: 'deepl-web', connectionRevision: 0, enabled: true,
      includeContext: true, sentenceAnalysisEnabled: true, provider: 'deepseek',
      model: 'deepseek-flash', apiKey: 'kept-model-secret', baseUrl: 'https://api.deepseek.com', jsonMode: true, profiles: {},
    };
    state.readSettings.mockImplementation(async () => ({ ...state.settings }));
    state.vault = { configured: true, locked: false, migrationRequired: false, savedProviders: ['deepseek'] };
    state.vaultStatus.mockImplementation(async () => ({ ...state.vault }));
    state.createVault.mockImplementation(async () => { state.vault = { ...state.vault, configured: true, locked: false, migrationRequired: false }; return state.vault; });
    state.unlockVault.mockImplementation(async () => { state.vault = { ...state.vault, locked: false }; return state.vault; });
    state.lockVault.mockImplementation(async () => { state.vault = { ...state.vault, locked: true }; state.settings.apiKey = ''; return state.vault; });
    state.changeVault.mockImplementation(async () => ({ ...state.vault }));
    state.connectionSettings.mockImplementation(async () => ({ profiles: {}, vault: { ...state.vault } }));
    state.broadcastPublic.mockResolvedValue(undefined);
    state.saveSettings.mockImplementation(async (settings: Partial<StoredSettings>) => {
      state.settings = { ...state.settings, translationEngine: settings.translationEngine ?? state.settings.translationEngine,
        connectionRevision: state.settings.connectionRevision + 1 };
    });
    state.contains.mockImplementation(async (query: { origins?: string[] }) => Boolean(query.origins));
    state.updateSessionRules.mockResolvedValue(undefined);
    state.deeplTranslate.mockImplementation(result);
    state.prepareNetwork.mockResolvedValue(undefined);
    state.serviceStatus.mockResolvedValue({ cooldownUntil: 0 });
    state.broadcastStatus.mockResolvedValue(undefined); state.persistCooldown.mockResolvedValue(undefined);
    state.loadCooldown.mockResolvedValue(0); state.reservePreparation.mockResolvedValue(true);
    state.enableFree.mockImplementation(async () => {
      state.settings = { ...state.settings, enabled: true, translationEngine: 'deepl-web', connectionRevision: state.settings.connectionRevision + 1 };
    });
    state.modelTranslate.mockImplementation(result);
    VaultError = (await import('../../src/platform/key-vault')).KeyVaultError;
    const background = await import('../../src/entrypoints/background');
    background.default.main();
    await vi.waitFor(() => expect(state.contains).toHaveBeenCalledWith({ origins: [DEEPL_WEB_ORIGIN] }));
  });

  it('keeps an idle worker free of status polling and does not accept page-supplied broadcasts', async () => {
    const reply = vi.fn();
    expect(state.onMessage({ type: 'translation-status-changed', status: { engine: 'deepl-web', cooldownUntil: 99_999 } },
      { id: 'test-extension', url: 'https://example.com/', tab: { id: 4 } }, reply)).toBe(false);
    vi.useFakeTimers();
    try { await vi.advanceTimersByTimeAsync(60_000); }
    finally { vi.useRealTimers(); }
    expect(state.serviceStatus).not.toHaveBeenCalled(); expect(state.broadcastStatus).not.toHaveBeenCalled();
    expect(state.deeplTranslate).not.toHaveBeenCalled(); expect(reply).not.toHaveBeenCalled();
  });

  it('publishes a saved cooldown before slow rate-limit body diagnostics finish', async () => {
    const diagnosticBody = deferred<void>(), deadline = Date.now() + 60_000;
    const { TranslationFailure } = await import('../../src/core/errors');
    state.serviceStatus.mockResolvedValue({ cooldownUntil: deadline });
    state.deeplTranslate.mockImplementation(async function* () {
      await providerOptions().persistCooldownUntil(deadline);
      await diagnosticBody.promise;
      throw new TranslationFailure('RATE_LIMIT', 'DeepL 请求受限', true, deadline);
    });
    const port = connect(); port.start({ kind: 'text', text: 'Private page text is never broadcast.' });
    try {
      await vi.waitFor(() => expect(state.broadcastStatus).toHaveBeenCalledOnce());
      expect(state.persistCooldown).toHaveBeenCalledExactlyOnceWith(deadline);
      expect(state.broadcastStatus).toHaveBeenCalledWith({ engine: 'deepl-web', cooldownUntil: deadline, checkedAt: expect.any(Number) });
      expect(port.messages.some(message => message.type === 'error')).toBe(false);
      expect(JSON.stringify(state.broadcastStatus.mock.calls)).not.toContain('Private page text');
      expect(JSON.stringify(state.broadcastStatus.mock.calls)).not.toContain('kept-model-secret');
    } finally { diagnosticBody.resolve(); }
    await completed(port); expect(port.messages.at(-1)).toMatchObject({ type: 'error', error: { code: 'RATE_LIMIT', retryAt: deadline } });
  });

  it('publishes JSON rate-limit errors even when no HTTP diagnostic callback was emitted', async () => {
    const deadline = Date.now() + 90_000; const { TranslationFailure } = await import('../../src/core/errors');
    state.serviceStatus.mockResolvedValue({ cooldownUntil: deadline });
    state.deeplTranslate.mockImplementation(async function* () { throw new TranslationFailure('RATE_LIMIT', 'DeepL 请求受限', true, deadline); });
    const port = connect(); port.start({ kind: 'text', text: 'A sentence.' }); await completed(port);
    await vi.waitFor(() => expect(state.broadcastStatus).toHaveBeenCalledExactlyOnceWith({ engine: 'deepl-web', cooldownUntil: deadline, checkedAt: expect.any(Number) }));
    expect(port.messages.at(-1)).toMatchObject({ type: 'error', error: { code: 'RATE_LIMIT', retryAt: deadline } });
  });

  it('coalesces concurrent diagnostics but publishes a later deadline that arrives during a frozen receiver', async () => {
    const firstSend = deferred<void>(), firstDeadline = Date.now() + 60_000, laterDeadline = firstDeadline + 60_000;
    state.serviceStatus.mockResolvedValue({ cooldownUntil: firstDeadline });
    state.broadcastStatus.mockReturnValueOnce(firstSend.promise);
    const options = providerOptions();
    for (let index = 0; index < 8; index++) options.onDiagnostic(rateDiagnostic());
    await vi.waitFor(() => expect(state.broadcastStatus).toHaveBeenCalledTimes(1));
    state.serviceStatus.mockResolvedValue({ cooldownUntil: laterDeadline });
    options.onDiagnostic(rateDiagnostic()); expect(state.broadcastStatus).toHaveBeenCalledTimes(1);
    firstSend.resolve();
    await vi.waitFor(() => expect(state.broadcastStatus).toHaveBeenCalledTimes(2));
    expect(state.broadcastStatus.mock.calls.map(([status]) => status.cooldownUntil)).toEqual([firstDeadline, laterDeadline]);
    const previousReads = state.serviceStatus.mock.calls.length; options.onDiagnostic(rateDiagnostic());
    await vi.waitFor(() => expect(state.serviceStatus.mock.calls.length).toBeGreaterThan(previousReads));
    expect(state.broadcastStatus).toHaveBeenCalledTimes(2);
  });

  it.each(['rejection', 'synchronous throw'] as const)('keeps translation errors intact after notification %s and can publish a later change', async failure => {
    const deadline = Date.now() + 60_000; const { TranslationFailure } = await import('../../src/core/errors');
    state.serviceStatus.mockResolvedValue({ cooldownUntil: deadline });
    state.broadcastStatus.mockImplementationOnce(() => {
      if (failure === 'synchronous throw') throw new Error('Notification unavailable');
      return Promise.reject(new Error('Notification unavailable'));
    });
    state.deeplTranslate.mockImplementation(async function* () { throw new TranslationFailure('RATE_LIMIT', 'DeepL 请求受限', true, deadline); });
    const port = connect(); port.start({ kind: 'text', text: 'A sentence.' }); await completed(port);
    expect(port.messages.at(-1)).toMatchObject({ type: 'error', error: { code: 'RATE_LIMIT', retryAt: deadline } });
    await vi.waitFor(() => expect(state.broadcastStatus).toHaveBeenCalledOnce());
    state.serviceStatus.mockResolvedValue({ cooldownUntil: deadline + 60_000 }); providerOptions().onDiagnostic(rateDiagnostic());
    await vi.waitFor(() => expect(state.broadcastStatus).toHaveBeenCalledTimes(2));
    expect(state.broadcastStatus.mock.calls[1]![0].cooldownUntil).toBe(deadline + 60_000);
  });

  it('notifies other pages after a rate-limited public sample without delaying its response', async () => {
    const deadline = Date.now() + 60_000; const { TranslationFailure } = await import('../../src/core/errors');
    state.serviceStatus.mockResolvedValue({ cooldownUntil: deadline });
    state.deeplTranslate.mockImplementation(async function* () { throw new TranslationFailure('RATE_LIMIT', 'DeepL 请求受限', true, deadline); });
    const pendingNotification = deferred<void>(); state.broadcastStatus.mockReturnValue(pendingNotification.promise);
    const reply = vi.fn();
    state.onMessage({ type: 'test-free-translation' }, { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' }, reply);
    try {
      await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: false, error: expect.objectContaining({ code: 'RATE_LIMIT', retryAt: deadline }) }));
      await vi.waitFor(() => expect(state.broadcastStatus).toHaveBeenCalledOnce());
    } finally { pendingNotification.resolve(); }
  });

  it('keeps optional preparation failures non-fatal while publishing the latest safe state', async () => {
    state.prepareNetwork.mockRejectedValueOnce(new Error('Metadata preparation failed'));
    state.serviceStatus.mockResolvedValue({ cooldownUntil: 65_000 });
    const reply = vi.fn();
    state.onMessage({ type: 'prepare-translation-network', requestId: 'prepare-failure' },
      { id: 'test-extension', url: 'https://example.com/article', frameId: 0, tab: { id: 7, active: true } }, reply);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: true }));
    await vi.waitFor(() => expect(state.broadcastStatus).toHaveBeenCalledExactlyOnceWith({ engine: 'deepl-web', cooldownUntil: 65_000, checkedAt: expect.any(Number) }));
    expect(state.deeplTranslate).not.toHaveBeenCalled();
  });

  it('shares one DeepL provider across ports without forwarding model credentials or context', async () => {
    state.settings.apiKey = '';
    const one = connect(); const two = connect();
    one.start({ kind: 'text', text: 'First sentence.', context: 'Private page context.' });
    two.start({ kind: 'text', text: 'Second sentence.' });
    await Promise.all([completed(one), completed(two)]);
    expect(state.deeplConstructed).toHaveBeenCalledTimes(1);
    expect(state.deeplTranslate).toHaveBeenCalledTimes(2);
    expect(state.deeplTranslate.mock.calls[0]?.[0]).toEqual({ kind: 'text', text: 'First sentence.', sourceLanguage: 'auto', targetLanguage: 'zh-Hans' });
    expect(state.modelConstructed).not.toHaveBeenCalled();
    expect(state.contains).toHaveBeenCalledWith({ origins: [DEEPL_WEB_ORIGIN] });
    expect(state.updateSessionRules).not.toHaveBeenCalled();
    expect(one.messages.at(-1)?.type).toBe('result');
  });

  it('projects saved language settings into every request and downgrades unsupported dictionary directions', async () => {
    state.settings.sourceLanguage = 'en'; state.settings.targetLanguage = 'ja';
    const port = connect(); port.start({ kind: 'word', text: 'library' }); await completed(port);
    expect(state.deeplTranslate.mock.calls[0]![0]).toEqual({ kind: 'text', text: 'library', sourceLanguage: 'en', targetLanguage: 'ja' });
  });

  it('restricts free activation and public sentence tests to trusted extension pages', async () => {
    for (const type of ['enable-free-translation', 'test-free-translation']) {
      const reply = vi.fn();
      expect(state.onMessage({ type }, { id: 'test-extension', url: 'https://example.com/', tab: { id: 1 } }, reply)).toBe(false);
      state.onMessage({ type }, { id: 'other-extension', url: 'chrome-extension://test-extension/options.html' }, reply);
      expect(reply).not.toHaveBeenCalled();
    }
    await Promise.resolve();
    expect(state.enableFree).not.toHaveBeenCalled(); expect(state.deeplTranslate).not.toHaveBeenCalled();
  });

  it('requires combined grants before activating free translation and never accepts replacement credentials', async () => {
    const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };
    state.contains.mockResolvedValue(false);
    const denied = vi.fn(); state.onMessage({ type: 'enable-free-translation' }, sender, denied);
    await vi.waitFor(() => expect(denied).toHaveBeenCalledWith(expect.objectContaining({ ok: false })));
    expect(state.enableFree).not.toHaveBeenCalled();
    state.contains.mockResolvedValue(true);
    const granted = vi.fn();
    state.onMessage({ type: 'enable-free-translation', settings: { apiKey: 'injected', targetLanguage: 'ja' } }, sender, granted);
    await vi.waitFor(() => expect(granted).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    expect(state.enableFree).toHaveBeenCalledExactlyOnceWith();
    expect(state.settings.apiKey).toBe('kept-model-secret'); expect(state.settings.targetLanguage).toBeUndefined();
    expect(state.contains).toHaveBeenCalledWith({ origins: ['http://*/*', 'https://*/*', DEEPL_WEB_ORIGIN] });
    expect(state.deeplTranslate).not.toHaveBeenCalled();
  });

  it('runs only the fixed public sample after an explicit trusted test and reads cooldown without translation', async () => {
    const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };
    const reply = vi.fn();
    state.onMessage({ type: 'test-free-translation', text: 'private supplied content', targetLanguage: 'ru' }, sender, reply);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    expect(state.deeplTranslate.mock.calls[0]![0]).toEqual({ kind: 'text', text: 'The library opens at nine in the morning.',
      sourceLanguage: 'en', targetLanguage: 'zh-Hans' });
    state.serviceStatus.mockResolvedValue({ cooldownUntil: Date.now() + 60_000 });
    const status = vi.fn();
    state.onMessage({ type: 'get-translation-status' }, { id: 'test-extension', url: 'https://example.com/', tab: { id: 1 } }, status);
    await vi.waitFor(() => expect(status).toHaveBeenCalledWith(expect.objectContaining({ ok: true, status: expect.objectContaining({ engine: 'deepl-web' }) })));
    expect(state.deeplTranslate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(status.mock.calls)).not.toContain('kept-model-secret');
  });

  it('cancels an in-flight public test when service permission is revoked', async () => {
    state.deeplTranslate.mockImplementation(waiting);
    const reply = vi.fn();
    state.onMessage({ type: 'test-free-translation' }, { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' }, reply);
    await vi.waitFor(() => expect(state.deeplTranslate).toHaveBeenCalledTimes(1));
    const signal = state.deeplTranslate.mock.calls[0]![1] as AbortSignal;
    state.onRemoved();
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: false, error: expect.objectContaining({ code: 'DISCONNECTED' }) }));
    expect(signal.aborted).toBe(true);
  });

  const preparingPage = () => ({ id: 'test-extension', url: 'https://example.com/article', frameId: 0,
    documentId: 'first-document', tab: { id: 7, active: true } });

  it('dispatches metadata preparation through the shared provider only after every capability check', async () => {
    const reply = vi.fn();
    state.onMessage({ type: 'prepare-translation-network', requestId: 'prepare-1', url: 'https://untrusted.invalid', text: 'ignored' }, preparingPage(), reply);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: true }));
    expect(state.prepareNetwork).toHaveBeenCalledExactlyOnceWith();
    expect(state.deeplTranslate).not.toHaveBeenCalled();
    expect(state.contains).toHaveBeenCalledWith({ origins: ['http://*/*', 'https://*/*', DEEPL_WEB_ORIGIN],
      permissions: ['declarativeNetRequestWithHostAccess'] });
  });

  it.each([{ frameId: 1 }, { url: 'chrome-extension://test-extension/options.html' },
    { id: 'other-extension' }, { tab: { id: 7, active: false } }])('rejects preparation from an ineligible sender: %j', async change => {
    state.onMessage({ type: 'prepare-translation-network', requestId: 'prepare-1' }, { ...preparingPage(), ...change }, vi.fn());
    await Promise.resolve();
    expect(state.prepareNetwork).not.toHaveBeenCalled();
  });

  it('cancels only the initiating document and request, while coalescing other pages', async () => {
    let finish!: () => void;
    state.prepareNetwork.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    const owner = preparingPage();
    state.onMessage({ type: 'prepare-translation-network', requestId: 'prepare-1' }, owner, vi.fn());
    await vi.waitFor(() => expect(state.prepareNetwork).toHaveBeenCalledOnce());
    state.onMessage({ type: 'prepare-translation-network', requestId: 'prepare-2' }, { ...owner, tab: { id: 8, active: true } }, vi.fn());
    state.onMessage({ type: 'cancel-network-preparation', requestId: 'prepare-1' }, { ...owner, documentId: 'old-document' }, vi.fn());
    expect(state.prepareNetwork).toHaveBeenCalledOnce();
    expect(state.cancelPreparation).not.toHaveBeenCalled();
    state.onMessage({ type: 'cancel-network-preparation', requestId: 'prepare-1' }, owner, vi.fn());
    expect(state.cancelPreparation).toHaveBeenCalledOnce();
    finish();
  });

  it('does not prepare when permission is missing, and ordinary translation remains available', async () => {
    state.contains.mockImplementation(async (query: { permissions?: string[] }) => !query.permissions?.length);
    const reply = vi.fn();
    state.onMessage({ type: 'prepare-translation-network', requestId: 'prepare-1' }, preparingPage(), reply);
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(state.prepareNetwork).not.toHaveBeenCalled();
    const port = connect(); port.start({ kind: 'text', text: 'A normal translation.' });
    await completed(port);
    expect(state.deeplTranslate).toHaveBeenCalledOnce();
  });

  it('retains the existing model constructor and API-key check in model mode', async () => {
    state.settings.translationEngine = 'model';
    const allowed = connect(); allowed.start({ kind: 'text', text: 'Model sentence.' });
    await completed(allowed);
    expect(state.modelConstructed).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'kept-model-secret', baseUrl: 'https://api.deepseek.com' }));
    state.settings.apiKey = '';
    const denied = connect(); denied.start({ kind: 'text', text: 'Missing key.' });
    await completed(denied);
    expect(denied.messages.at(-1)).toMatchObject({ type: 'error', error: { code: 'CONFIG' } });
    expect(state.modelConstructed).toHaveBeenCalledTimes(1);
  });

  it('rejects sentence analysis before calling the plain-text provider', async () => {
    const port = connect();
    port.start({ kind: 'text', text: 'This is a sufficiently long sentence for analysis.', task: 'sentence-analysis' });
    await completed(port);
    expect(port.messages.at(-1)).toMatchObject({ type: 'error', error: { code: 'CONFIG' } });
    expect(state.deeplTranslate).not.toHaveBeenCalled();
  });

  it('rejects missing network or webpage permission before dispatching a request', async () => {
    state.contains.mockResolvedValue(false);
    const port = connect(false); port.start({ kind: 'text', text: 'Sentence.' });
    await completed(port);
    expect(port.messages.at(-1)).toMatchObject({ type: 'error', error: { code: 'CONFIG' } });
    expect(state.deeplTranslate).not.toHaveBeenCalled();
  });

  it('returns CONFIG when the new DeepL host is not granted without dispatching either provider', async () => {
    const respond = vi.fn();
    state.onMessage({ type: 'save-settings', settings: { translationEngine: 'model' } },
      { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    state.settings.translationEngine = 'deepl-web';
    state.contains.mockImplementation(async (query: { origins?: string[] }) => !query.origins?.includes(DEEPL_WEB_ORIGIN));
    const port = connect(); port.start({ kind: 'text', text: 'Sentence.' });
    await completed(port);
    expect(port.messages.at(-1)).toMatchObject({ type: 'error', error: { code: 'CONFIG' } });
    expect(state.deeplTranslate).not.toHaveBeenCalled();
    expect(state.modelTranslate).not.toHaveBeenCalled();
  });

  it('cancels a queued or running request when its network permission is revoked', async () => {
    state.deeplTranslate.mockImplementation(waiting);
    const port = connect(); port.start({ kind: 'text', text: 'Waiting sentence.' });
    await vi.waitFor(() => expect(state.deeplTranslate).toHaveBeenCalled());
    const signal = state.deeplTranslate.mock.calls[0]?.[1] as AbortSignal;
    state.contains.mockResolvedValue(false);
    state.onRemoved();
    await completed(port);
    expect(signal.aborted).toBe(true);
    expect(port.messages.at(-1)).toMatchObject({ type: 'error', error: { code: 'CONFIG' } });
  });

  it('cancels in-flight work after switching to model without requiring or modifying DNR', async () => {
    state.deeplTranslate.mockImplementation(waiting);
    const port = connect(); port.start({ kind: 'text', text: 'Waiting sentence.' });
    await vi.waitFor(() => expect(state.deeplTranslate).toHaveBeenCalled());
    const signal = state.deeplTranslate.mock.calls[0]?.[1] as AbortSignal;
    const respond = vi.fn();
    state.onMessage({ type: 'save-settings', settings: { translationEngine: 'model' } },
      { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    expect(signal.aborted).toBe(true);
    expect(state.updateSessionRules).not.toHaveBeenCalled();
    expect(port.messages.at(-1)).toMatchObject({ type: 'error', error: { code: 'CONFIG' } });
  });

  it.each(['create-key-vault', 'unlock-key-vault', 'lock-key-vault', 'change-key-vault-passphrase'])(
    'limits %s to the actual options page of this extension', async type => {
      for (const sender of [
        { id: 'test-extension', url: 'https://example.com/options.html' },
        { id: 'test-extension', url: 'chrome-extension://test-extension/reader.html' },
        { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' },
        { id: 'test-extension', url: 'chrome-extension://test-extension/options.html.fake' },
        { id: 'other-extension', url: 'chrome-extension://test-extension/options.html' },
      ]) {
        const reply = vi.fn();
        expect(state.onMessage({ type, passphrase: 'test-only-long-passphrase' }, sender, reply)).toBe(false);
        expect(reply).not.toHaveBeenCalled();
      }
      await Promise.resolve();
      for (const operation of [state.createVault, state.unlockVault, state.lockVault, state.changeVault]) expect(operation).not.toHaveBeenCalled();
    },
  );

  it('projects only non-secret vault status to trusted pages and rejects content scripts', async () => {
    state.vaultStatus.mockResolvedValue({ ...state.vault, passphrase: 'never-return-this', ciphertext: 'secret-ciphertext', savedProviders: ['deepseek', 'invalid'] });
    const blocked = vi.fn();
    expect(state.onMessage({ type: 'get-key-vault-status' }, { id: 'test-extension', url: 'https://example.com/' }, blocked)).toBe(false);
    expect(blocked).not.toHaveBeenCalled();
    const reply = vi.fn();
    state.onMessage({ type: 'get-key-vault-status' }, { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' }, reply);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: true, status: state.vault }));
    expect(JSON.stringify(reply.mock.calls)).not.toMatch(/never-return-this|secret-ciphertext|kept-model-secret/);
  });

  it.each(['create-key-vault', 'unlock-key-vault'])(
    'preserves significant spaces in %s and returns no passphrase', async type => {
      const passphrase = '  test-only-long-passphrase  ';
      const reply = vi.fn();
      state.onMessage({ type, passphrase }, { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' }, reply);
      await vi.waitFor(() => expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ok: true, status: state.vault })));
      expect(type === 'create-key-vault' ? state.createVault : state.unlockVault).toHaveBeenCalledExactlyOnceWith(passphrase);
      expect(JSON.stringify(reply.mock.calls)).not.toContain(passphrase);
    },
  );

  it('creates a local vault without any host grants even when the real DeepL synchronization rejects', async () => {
    state.contains.mockResolvedValue(false);
    state.vault = { configured: false, locked: false, migrationRequired: false, savedProviders: [] };
    state.connectionSettings.mockImplementation(async () => ({ translationEngine: 'deepl-web', enabled: true,
      webAccess: false, apiAccess: false, hasApiKey: false, requiresApiKey: false, keyVaultLocked: false,
      profiles: {}, vault: { ...state.vault } }));
    const before = state.broadcastPublic.mock.calls.length;
    const reply = vi.fn();
    state.onMessage({ type: 'create-key-vault', passphrase: 'fresh-install-test-only-passphrase' },
      { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' }, reply);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: true,
      status: { configured: true, locked: false, migrationRequired: false, savedProviders: [] },
      settings: expect.objectContaining({ translationEngine: 'deepl-web', webAccess: false, apiAccess: false, requiresApiKey: false,
        vault: expect.objectContaining({ configured: true, locked: false }) }) }));
    // deepl-web-transport is intentionally not mocked: synchronize(true) observes
    // this false host grant and throws the production DeepLWebTransportError.
    expect(state.contains).toHaveBeenCalledWith({ origins: [DEEPL_WEB_ORIGIN] });
    expect(state.broadcastPublic.mock.calls.length).toBeGreaterThan(before);
    expect(state.modelConstructed).not.toHaveBeenCalled(); expect(state.deeplTranslate).not.toHaveBeenCalled();
    expect(JSON.stringify(reply.mock.calls)).not.toContain('fresh-install-test-only-passphrase');
    const denied = connect(); denied.start({ kind: 'text', text: 'Translation still needs explicit permission.' });
    await completed(denied);
    expect(denied.messages.at(-1)).toMatchObject({ type: 'error', error: { code: 'CONFIG' } });
    expect(state.deeplTranslate).not.toHaveBeenCalled();
  });

  it('routes passphrase changes without exposing either value or swallowing a safe failure', async () => {
    const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };
    const reply = vi.fn();
    state.onMessage({ type: 'change-key-vault-passphrase', currentPassphrase: 'current-test-only-passphrase', newPassphrase: 'new-test-only-passphrase' }, sender, reply);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    expect(state.changeVault).toHaveBeenCalledExactlyOnceWith('current-test-only-passphrase', 'new-test-only-passphrase');
    expect(JSON.stringify(reply.mock.calls)).not.toMatch(/current-test-only|new-test-only/);
    state.unlockVault.mockRejectedValueOnce(new VaultError('口令不正确，请重试。'));
    const denied = vi.fn();
    state.onMessage({ type: 'unlock-key-vault', passphrase: 'wrong-test-only-passphrase' }, sender, denied);
    await vi.waitFor(() => expect(denied).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: '口令不正确，请重试。' })));
  });

  it('rejects non-string vault credentials without calling the vault', async () => {
    const reply = vi.fn();
    state.onMessage({ type: 'create-key-vault', passphrase: { invalid: true } }, { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' }, reply);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: '请输入密钥库口令。' })));
    expect(state.createVault).not.toHaveBeenCalled();
  });

  it.each([
    { locked: true, migrationRequired: false, message: '密钥库已锁定' },
    { locked: true, migrationRequired: true, message: '加密迁移' },
  ])('explains protected model credentials without treating them as missing: %j', async change => {
    state.settings.translationEngine = 'model'; state.settings.apiKey = '';
    state.vault = { ...state.vault, ...change };
    const port = connect(); port.start({ kind: 'text', text: 'A model translation.' });
    await completed(port);
    expect(port.messages.at(-1)).toMatchObject({ type: 'error', error: { message: expect.stringContaining(change.message) } });
    expect(state.modelConstructed).not.toHaveBeenCalled();
  });

  it('cancels model work on vault lock while leaving a running DeepL request alone', async () => {
    state.modelTranslate.mockImplementation(waiting); state.deeplTranslate.mockImplementation(waiting);
    state.settings.translationEngine = 'model';
    const model = connect(); model.start({ kind: 'text', text: 'Waiting for model.' });
    await vi.waitFor(() => expect(state.modelTranslate).toHaveBeenCalledOnce());
    const modelSignal = state.modelTranslate.mock.calls[0]![1] as AbortSignal;
    state.settings.translationEngine = 'deepl-web';
    const free = connect(); free.start({ kind: 'text', text: 'Waiting for free translation.' });
    await vi.waitFor(() => expect(state.deeplTranslate).toHaveBeenCalledOnce());
    const freeSignal = state.deeplTranslate.mock.calls[0]![1] as AbortSignal;
    const reply = vi.fn();
    state.onMessage({ type: 'lock-key-vault' }, { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' }, reply);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    expect(modelSignal.aborted).toBe(true); expect(freeSignal.aborted).toBe(false);
    free.disconnect();
  });

  it('does not silently drop protected authentication for an optional-key model service', async () => {
    state.settings = { ...state.settings, translationEngine: 'model', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', keyVaultLocked: true };
    state.vault = { ...state.vault, locked: true, savedProviders: ['ollama'] };
    const port = connect(); port.start({ kind: 'text', text: 'Protected local service.' });
    await completed(port);
    expect(port.messages.at(-1)).toMatchObject({ type: 'error', error: { message: expect.stringContaining('密钥库已锁定') } });
    expect(state.modelConstructed).not.toHaveBeenCalled();
  });

  it.each(['lock-key-vault', 'change-key-vault-passphrase'] as const)(
    'cancels model work before %s and refreshes state after a committed operation reports failure', async type => {
      state.modelTranslate.mockImplementation(waiting); state.deeplTranslate.mockImplementation(waiting);
      state.settings.translationEngine = 'model';
      const model = connect(); model.start({ kind: 'text', text: 'Model before vault commit.' });
      await vi.waitFor(() => expect(state.modelTranslate).toHaveBeenCalledOnce());
      const modelSignal = state.modelTranslate.mock.calls[0]![1] as AbortSignal;
      state.settings.translationEngine = 'deepl-web';
      const free = connect(); free.start({ kind: 'text', text: 'Free translation is independent.' });
      await vi.waitFor(() => expect(state.deeplTranslate).toHaveBeenCalledOnce());
      const freeSignal = state.deeplTranslate.mock.calls[0]![1] as AbortSignal;
      const error = type === 'lock-key-vault' ? '密钥库操作失败，已有数据未被主动删除。请重试。' : '新口令已生效，但当前会话尚未解锁。请用新口令重新解锁。';
      const operation = type === 'lock-key-vault' ? state.lockVault : state.changeVault;
      operation.mockImplementationOnce(async () => {
        expect(modelSignal.aborted).toBe(true); expect(freeSignal.aborted).toBe(false);
        state.vault = { ...state.vault, locked: true }; state.settings.apiKey = '';
        throw new VaultError(error);
      });
      const before = state.broadcastPublic.mock.calls.length;
      const reply = vi.fn();
      state.onMessage({ type, currentPassphrase: 'current-test-only-passphrase', newPassphrase: 'new-test-only-passphrase' },
        { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' }, reply);
      await vi.waitFor(() => expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error,
        status: expect.objectContaining({ locked: true }), settings: expect.objectContaining({ vault: expect.objectContaining({ locked: true }) }) })));
      expect(state.broadcastPublic.mock.calls.length).toBeGreaterThan(before);
      expect(modelSignal.aborted).toBe(true); expect(freeSignal.aborted).toBe(false);
      expect(JSON.stringify(reply.mock.calls)).not.toMatch(/current-test-only|new-test-only|kept-model-secret/);
      free.disconnect();
    },
  );

  it('never echoes arbitrary storage errors and preserves a safe core error if refresh also fails', async () => {
    const unsafe = 'test-only-storage-exception-with-private-values';
    state.lockVault.mockRejectedValueOnce(new Error(unsafe));
    state.broadcastPublic.mockRejectedValue(new Error(unsafe)); state.connectionSettings.mockRejectedValue(new Error(unsafe));
    state.vaultStatus.mockRejectedValue(new Error(unsafe)); state.readSettings.mockRejectedValue(new Error(unsafe));
    const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };
    const reply = vi.fn(); state.onMessage({ type: 'lock-key-vault' }, sender, reply);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: false, error: '密钥库操作失败，请重试。' }));
    expect(JSON.stringify(reply.mock.calls)).not.toContain(unsafe);
    state.lockVault.mockRejectedValueOnce(new VaultError('新口令已生效，请用新口令重新解锁。'));
    const safe = vi.fn(); state.onMessage({ type: 'lock-key-vault' }, sender, safe);
    await vi.waitFor(() => expect(safe).toHaveBeenCalledWith({ ok: false, error: '新口令已生效，请用新口令重新解锁。' }));
  });

  it('rejects a model request that read credentials before a concurrent vault transition', async () => {
    state.settings.translationEngine = 'model';
    const oldSettings = { ...state.settings };
    const pending = deferred<StoredSettings>();
    state.readSettings.mockImplementationOnce(() => pending.promise);
    const model = connect(); model.start({ kind: 'text', text: 'Stale credential snapshot.' });
    const reply = vi.fn();
    state.onMessage({ type: 'lock-key-vault' }, { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' }, reply);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    pending.resolve(oldSettings);
    await completed(model);
    expect(model.messages.at(-1)).toMatchObject({ type: 'error', error: { message: expect.stringContaining('密钥库状态已更改') } });
    expect(state.modelConstructed).not.toHaveBeenCalled();
  });
});
