// Isolated OAuth/MCP qualification extension. Not a production provider.
const ORIGIN = 'https://mcp.deepl.com';
const RESOURCE = `${ORIGIN}/v1/mcp`;
const ISSUER = `${ORIGIN}/`;
const VERSION = '2025-11-25';
const SESSION_KEY = 'near-deepl-poc-session:v1';
const CLIENT_KEY = 'near-deepl-poc-client:v1';
const PENDING_KEY = 'near-deepl-poc-pending:v1';
const STATUS_KEY = 'near-deepl-poc-status:v1';
const supportedVersions = new Set([VERSION, '2025-06-18', '2025-03-26']);
let revision = 0;
let busy = false;
let metadata;
let client;
let credentials;
let mcpSession;
let protocolVersion;
let requestSequence = 0;
let refreshPromise;
let activeController;
let status = { phase: 'idle', notice: '点击连接后，在 DeepL 官方窗口登录并确认授权。', connected: false,
  registered: false, hasRefreshToken: false, tools: [], results: [] };

class SafeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const safeFailure = error => error instanceof SafeError ? error.message
  : error?.name === 'AbortError' ? '操作已取消。' : '连接失败，请检查网络后重试；诊断不包含账户凭证。';
async function setStatus(update) {
  status = { ...status, ...update };
  await chrome.storage.session.set({ [STATUS_KEY]: status });
}
const initialized = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const [local, session] = await Promise.all([
    chrome.storage.local.get(CLIENT_KEY), chrome.storage.session.get([SESSION_KEY, STATUS_KEY]),
  ]);
  client = local[CLIENT_KEY];
  credentials = session[SESSION_KEY];
  if (session[STATUS_KEY]) status = { ...status, ...session[STATUS_KEY] };
  status = { ...status, redirectUri: chrome.identity.getRedirectURL('deepl'),
    connected: !!credentials?.accessToken, registered: !!client?.clientId,
    hasRefreshToken: !!credentials?.refreshToken };
  if (status.phase === 'authorizing') {
    status = { ...status, phase: 'idle', notice: '授权过程被中断，请重新点击连接。' };
    await chrome.storage.session.remove(PENDING_KEY);
  }
})();

function officialUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new SafeError('METADATA', '授权元数据包含无效地址。'); }
  if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash)
    throw new SafeError('METADATA', '授权元数据指向未允许的地址，已停止连接。');
  return url.href;
}
async function publicJson(url, init = {}) {
  const response = await fetch(officialUrl(url), { ...init, credentials: 'omit', redirect: 'error',
    signal: AbortSignal.timeout(30000), headers: { Accept: 'application/json', ...init.headers } });
  if (!response.ok) {
    // Do not return arbitrary remote text, which can contain sensitive request details.
    throw new SafeError('HTTP', `官方授权服务返回 HTTP ${response.status}。`);
  }
  return response.json();
}
async function discover() {
  const resource = await publicJson(`${ORIGIN}/.well-known/oauth-protected-resource`);
  if (resource.resource !== RESOURCE || !resource.authorization_servers?.includes(ISSUER))
    throw new SafeError('METADATA', 'MCP 资源与授权服务器不匹配。');
  const document = await publicJson(`${ORIGIN}/.well-known/oauth-authorization-server`);
  if (document.issuer !== ISSUER || !document.code_challenge_methods_supported?.includes('S256')
    || !document.token_endpoint_auth_methods_supported?.includes('none'))
    throw new SafeError('METADATA', '服务未提供预期的公开客户端 PKCE 授权能力。');
  metadata = {
    authorization: officialUrl(document.authorization_endpoint), token: officialUrl(document.token_endpoint),
    registration: officialUrl(document.registration_endpoint),
    revocation: document.revocation_endpoint ? officialUrl(document.revocation_endpoint) : undefined,
    offlineAccess: document.scopes_supported?.includes('offline_access') === true,
  };
}
async function register() {
  const redirectUri = chrome.identity.getRedirectURL('deepl');
  if (client?.clientId && client.redirectUri === redirectUri) return;
  const result = await publicJson(metadata.registration, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: '近译 DeepL OAuth POC', application_type: 'web',
      redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      ...(metadata.offlineAccess ? { scope: 'offline_access' } : {}) }),
  });
  if (typeof result.client_id !== 'string' || !result.client_id || result.client_secret
    || (result.token_endpoint_auth_method && result.token_endpoint_auth_method !== 'none')
    || !result.redirect_uris?.includes(redirectUri))
    throw new SafeError('REGISTRATION', '服务未接受预期的公开客户端或扩展回调。');
  client = { clientId: result.client_id, redirectUri };
  await chrome.storage.local.set({ [CLIENT_KEY]: client });
  await setStatus({ registered: true, redirectUri });
}
function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function randomString() { return base64url(crypto.getRandomValues(new Uint8Array(32))); }
function checkRevision(expected) {
  if (revision !== expected) throw new SafeError('CANCELLED', '连接已更改，旧操作已停止。');
}
async function exchange(body, expected) {
  const response = await fetch(metadata.token, { method: 'POST', credentials: 'omit', redirect: 'error',
    signal: AbortSignal.timeout(30000), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ ...body, client_id: client.clientId, resource: RESOURCE }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.access_token !== 'string' || !result.access_token
    || String(result.token_type).toLowerCase() !== 'bearer')
    throw new SafeError('TOKEN', `令牌兑换失败（HTTP ${response.status}），请重新授权。`);
  checkRevision(expected);
  const next = { accessToken: result.access_token,
    refreshToken: typeof result.refresh_token === 'string' ? result.refresh_token : credentials?.refreshToken,
    expiresAt: Number.isFinite(result.expires_in) ? Date.now() + result.expires_in * 1000 : undefined };
  credentials = next;
  await chrome.storage.session.set({ [SESSION_KEY]: next });
  checkRevision(expected);
  await setStatus({ connected: true, hasRefreshToken: !!next.refreshToken });
}
async function authorize(expected) {
  const verifier = randomString();
  const state = randomString();
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  await chrome.storage.session.set({ [PENDING_KEY]: { state, verifier, redirectUri: client.redirectUri } });
  const url = new URL(metadata.authorization);
  url.search = new URLSearchParams({ response_type: 'code', client_id: client.clientId,
    redirect_uri: client.redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256',
    resource: RESOURCE, ...(metadata.offlineAccess ? { scope: 'offline_access' } : {}) }).toString();
  await setStatus({ phase: 'authorizing', notice: '请在 DeepL 官方窗口中登录并确认授权；不要在聊天中提供密码。' });
  let callback;
  try { callback = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true }); }
  catch { throw new SafeError('AUTH_WINDOW', '官方授权窗口未完成：可能已关闭、取消，或回调未被服务接受。'); }
  finally { await chrome.storage.session.remove(PENDING_KEY); }
  checkRevision(expected);
  const actual = new URL(callback);
  const target = new URL(client.redirectUri);
  if (actual.origin !== target.origin || actual.pathname !== target.pathname || actual.hash
    || actual.searchParams.get('state') !== state
    || (actual.searchParams.has('iss') && actual.searchParams.get('iss') !== ISSUER))
    throw new SafeError('CALLBACK', '授权回调验证失败，未保存访问权限。');
  if (actual.searchParams.has('error')) throw new SafeError('DECLINED', '授权未获同意。');
  const code = actual.searchParams.get('code');
  if (!code) throw new SafeError('CALLBACK', '授权回调未返回授权码。');
  await setStatus({ phase: 'exchanging', notice: '正在完成官方授权。' });
  await exchange({ grant_type: 'authorization_code', code, redirect_uri: client.redirectUri, code_verifier: verifier }, expected);
}
async function refresh(expected) {
  if (!credentials?.refreshToken) throw new SafeError('AUTH', '连接已过期，需要重新授权。');
  if (!refreshPromise) refreshPromise = exchange({ grant_type: 'refresh_token', refresh_token: credentials.refreshToken }, expected)
    .finally(() => { refreshPromise = undefined; });
  await refreshPromise;
}
function parseRpc(value, id) {
  if (!value || value.jsonrpc !== '2.0' || value.id !== id) return undefined;
  if (value.error) throw new SafeError('MCP_ERROR', `MCP 返回错误（${Number(value.error.code) || '未知代码'}）。`);
  if (!('result' in value)) throw new SafeError('MCP_RESULT', 'MCP 响应缺少结果。');
  return { value: value.result };
}
async function parseResponse(response, id) {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const value = parseRpc(await response.json(), id);
    if (!value) throw new SafeError('MCP_RESULT', 'MCP 响应标识不匹配。');
    return value.value;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      buffer += decoder.decode(next.value, { stream: !next.done });
      total += next.value?.byteLength ?? 0;
      if (total > 2_000_000) throw new SafeError('MCP_SIZE', 'MCP 响应超过测试大小上限。');
      if (next.done) buffer += '\n\n';
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        else if (!line && data.length) {
          const text = data.join('\n'); data = [];
          if (!text.trim()) continue;
          const payload = JSON.parse(text);
          const result = parseRpc(payload, id);
          if (result) return result.value;
        }
      }
      if (next.done) break;
    }
    throw new SafeError('MCP_TRUNCATED', 'MCP 流在完整结果前结束。');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function rpc(method, params, expected, notification = false) {
  checkRevision(expected);
  if (!credentials?.accessToken) throw new SafeError('AUTH', '尚未连接 DeepL。');
  if (credentials.expiresAt && credentials.expiresAt < Date.now() + 30000) await refresh(expected);
  const id = ++requestSequence;
  const message = { jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params ? { params } : {}) };
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController(); activeController = controller;
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(RESOURCE, { method: 'POST', credentials: 'omit', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${credentials.accessToken}`, 'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}),
          ...(mcpSession ? { 'Mcp-Session-Id': mcpSession } : {}) }, body: JSON.stringify(message) });
      if (response.status === 401 && attempt === 0 && credentials.refreshToken) {
        await response.body?.cancel().catch(() => {}); await refresh(expected); continue;
      }
      if (!response.ok) throw new SafeError('MCP_HTTP', `MCP 请求失败（HTTP ${response.status}）；没有自动切换服务或付费。`);
      const session = response.headers.get('mcp-session-id');
      if (session) mcpSession = session;
      if (notification) { await response.body?.cancel().catch(() => {}); return; }
      const result = await parseResponse(response, id);
      checkRevision(expected);
      return result;
    } finally { clearTimeout(timer); if (activeController === controller) activeController = undefined; }
  }
}
async function probeCapabilities(expected) {
  mcpSession = undefined; protocolVersion = undefined;
  await setStatus({ phase: 'probing', notice: '授权完成，正在核验 MCP 协议和可用翻译工具。' });
  const result = await rpc('initialize', { protocolVersion: VERSION, capabilities: {},
    clientInfo: { name: 'near-translate-oauth-poc', version: '0.0.1' } }, expected);
  if (!supportedVersions.has(result.protocolVersion) || !result.capabilities?.tools)
    throw new SafeError('MCP_VERSION', '服务未返回本次测试支持的协议版本或工具能力。');
  protocolVersion = result.protocolVersion;
  await rpc('notifications/initialized', undefined, expected, true);
  let cursor;
  const tools = [];
  for (let page = 0; page < 10; page++) {
    const listed = await rpc('tools/list', cursor ? { cursor } : {}, expected);
    if (!Array.isArray(listed.tools)) throw new SafeError('TOOLS', '工具列表格式不正确。');
    tools.push(...listed.tools.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema })));
    cursor = listed.nextCursor;
    if (!cursor) break;
  }
  if (cursor || !tools.some(tool => tool.name === 'translate-text'))
    throw new SafeError('TOOLS', '当前账号未提供可确认的文本翻译工具。');
  await setStatus({ phase: 'ready', notice: '已完成官方授权和工具发现；等待核对参数后运行公开短文本测试。',
    connected: true, protocolVersion, tools });
}
async function connect() {
  if (busy) return;
  busy = true;
  const expected = ++revision;
  try {
    await setStatus({ phase: 'discovering', notice: '正在发现官方授权服务。', tools: [], results: [] });
    await discover(); checkRevision(expected);
    await register(); checkRevision(expected);
    if (!credentials?.accessToken) await authorize(expected);
    await probeCapabilities(expected);
  } catch (error) {
    if (revision === expected) await setStatus({ phase: 'error', notice: safeFailure(error), connected: !!credentials?.accessToken });
  } finally { busy = false; }
}
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/token|authorization|cookie|secret|session/i.test(key)).map(([key, item]) => [key, redact(item)]));
  return value;
}
async function smoke(plan) {
  if (busy || status.phase !== 'ready') throw new SafeError('NOT_READY', '请先完成连接和工具发现。');
  if (!Array.isArray(plan) || plan.length < 1 || plan.length > 5)
    throw new SafeError('SMOKE_PLAN', '需先核对真实工具参数，再提交少量公开测试文本。');
  if (JSON.stringify(plan).length > 5000) throw new SafeError('SMOKE_PLAN', '测试输入超出小样本限制。');
  busy = true; const expected = revision;
  try {
    await setStatus({ phase: 'testing', notice: '正在翻译已选定的公开短文本。' });
    const results = [];
    for (const item of plan) {
      const started = performance.now();
      const result = await rpc('tools/call', { name: 'translate-text', arguments: item.arguments }, expected);
      if (result.isError) throw new SafeError('TRANSLATION', '翻译工具返回失败；未把错误文本当作译文。');
      results.push({ name: String(item.name).slice(0, 100), milliseconds: Math.round(performance.now() - started),
        result: redact({ structuredContent: result.structuredContent, content: result.content }) });
    }
    await setStatus({ phase: 'tested', notice: '公开文本翻译请求已完成，等待核对译文数量、顺序和内容。', results });
  } catch (error) {
    await setStatus({ phase: 'error', notice: safeFailure(error) });
    throw error;
  } finally { busy = false; }
}
async function disconnect() {
  revision++; activeController?.abort();
  const token = credentials?.refreshToken ?? credentials?.accessToken;
  credentials = undefined; mcpSession = undefined; protocolVersion = undefined;
  await chrome.storage.session.remove([SESSION_KEY, PENDING_KEY]);
  await setStatus({ phase: 'idle', connected: false, hasRefreshToken: false, tools: [], results: [], notice: '已清除本测试扩展的本地连接。' });
  if (token && metadata?.revocation && client?.clientId) {
    try {
      const response = await fetch(metadata.revocation, { method: 'POST', credentials: 'omit', redirect: 'error',
        signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, client_id: client.clientId }) });
      if (!response.ok) throw new Error();
      await setStatus({ notice: '本测试扩展已断开，官方撤销端点已确认。' });
    } catch { await setStatus({ notice: '本地已断开；远端撤销尚未确认，可在 DeepL 账户中检查授权。' }); }
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')) || !message?.type?.startsWith('poc-')) return false;
  void initialized.then(async () => {
    if (message.type === 'poc-status') return;
    if (message.type === 'poc-connect') { void connect(); return; }
    if (message.type === 'poc-disconnect') { await disconnect(); return; }
    if (message.type === 'poc-smoke') { await smoke(message.plan); return; }
    throw new SafeError('MESSAGE', '不支持的测试操作。');
  }).then(() => respond({ ok: true, status })).catch(error => respond({ ok: false, error: safeFailure(error), status }));
  return true;
});
