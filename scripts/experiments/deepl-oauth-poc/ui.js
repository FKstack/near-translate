// Enable only after the real tools/list schema and smoke request are reviewed.
const SMOKE_ENABLED = false;
const elements = Object.fromEntries([
  'phase', 'notice', 'connect', 'refresh', 'disconnect', 'error', 'connected',
  'refresh-token', 'registered', 'redirect-uri', 'protocol', 'tools-empty',
  'tools', 'smoke', 'smoke-note', 'results',
].map(id => [id, document.getElementById(id)]));
const phaseLabels = {
  disconnected: '尚未连接', idle: '尚未连接', authorizing: '等待在 DeepL 官方窗口完成登录与授权',
  registering: '正在准备官方授权客户端', connecting: '正在连接 DeepL',
  discovering: '正在读取官方工具', verifying: '正在核验连接',
  ready: '官方工具已发现，可继续验证翻译', translating: '正在验证公开短文本翻译',
  error: '连接遇到问题', disconnecting: '正在断开连接',
};
let lastStatus;
let actionBusy = false;
let pollBusy = false;
let stopped = false;
let previousTools = '';
let previousResults = '';

function safeText(value, maximum = 2000) {
  return typeof value === 'string' ? value.slice(0, maximum) : '';
}
function updateButtons() {
  const authorizing = lastStatus?.phase === 'authorizing';
  elements.connect.disabled = actionBusy || authorizing || lastStatus?.connected === true;
  elements.refresh.disabled = actionBusy;
  elements.disconnect.disabled = actionBusy || !(lastStatus?.connected || lastStatus?.registered || authorizing);
  elements.smoke.disabled = !SMOKE_ENABLED || actionBusy || lastStatus?.phase !== 'ready';
  if (SMOKE_ENABLED) {
    elements.smoke.textContent = '运行公开短文本翻译测试';
    elements['smoke-note'].textContent = '仅发送预设公开短文本。完成前请保持此测试页面打开。';
  }
}
function renderTools(tools) {
  const values = Array.isArray(tools) ? tools.slice(0, 50) : [];
  const serialized = JSON.stringify(values);
  if (serialized === previousTools) return;
  previousTools = serialized;
  elements.tools.replaceChildren();
  elements['tools-empty'].hidden = values.length > 0;
  for (const tool of values) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = safeText(tool?.name, 200) || '未命名工具';
    const schema = document.createElement('pre');
    // Tool schemas are definitions, not authorization responses or stored tokens.
    schema.textContent = JSON.stringify(tool?.inputSchema ?? {}, null, 2).slice(0, 24_000);
    details.append(summary, schema);
    elements.tools.append(details);
  }
}
function renderResults(results) {
  const values = Array.isArray(results) ? results.slice(0, 20) : [];
  const serialized = JSON.stringify(values);
  if (serialized === previousResults) return;
  previousResults = serialized;
  elements.results.replaceChildren();
  // Deliberately avoid dumping unknown objects that could contain OAuth fields.
  const labels = {
    name: '工具', milliseconds: '耗时（毫秒）', label: '样例', sourceText: '原文',
    translatedText: '译文', translation: '译文', targetLanguage: '目标语言',
    durationMs: '耗时（毫秒）', ok: '通过', error: '错误',
  };
  for (const value of values) {
    const item = document.createElement('div');
    item.className = 'result';
    if (typeof value === 'string') item.textContent = safeText(value, 6000);
    else if (value && typeof value === 'object') {
      for (const [key, label] of Object.entries(labels)) {
        const field = value[key];
        if (!['string', 'number', 'boolean'].includes(typeof field)) continue;
        const line = document.createElement('p');
        line.textContent = `${label}：${typeof field === 'string' ? safeText(field, 6000) : field}`;
        item.append(line);
      }
      if (value.result && typeof value.result === 'object') {
        const output = document.createElement('pre');
        // The worker returns only filtered public test results. Defense in depth:
        // never render credential-shaped keys even if a future result adds them.
        output.textContent = JSON.stringify(value.result, (key, field) =>
          /token|secret|authorization|cookie|password|verifier|challenge|^(?:code|state)$/i.test(key)
            ? undefined : field, 2).slice(0, 24_000);
        item.append(output);
      }
    }
    if (!item.childNodes.length) item.textContent = '结果已返回；等待核验结果展示字段。';
    elements.results.append(item);
  }
}
function renderStatus(status) {
  if (!status || typeof status !== 'object') throw new Error('invalid-public-status');
  lastStatus = status;
  elements.phase.textContent = phaseLabels[status.phase] || '正在更新连接状态';
  elements.notice.textContent = safeText(status.notice);
  elements.connected.textContent = status.connected ? '已建立账号连接' : '尚未建立账号连接';
  elements['refresh-token'].textContent = status.hasRefreshToken ? '已取得（不显示内容）' : '尚未取得';
  elements.registered.textContent = status.registered ? '已注册' : '尚未注册';
  elements['redirect-uri'].textContent = safeText(status.redirectUri, 300) || '尚未取得';
  elements.protocol.textContent = safeText(status.protocolVersion, 100) || '尚未协商';
  renderTools(status.tools);
  renderResults(status.results);
  updateButtons();
}
async function send(type) {
  const reply = await chrome.runtime.sendMessage({ type });
  if (!reply?.ok) {
    elements.error.textContent = safeText(reply?.error) || '操作失败，请刷新状态后重试。';
    return false;
  }
  renderStatus(reply.status);
  elements.error.textContent = '';
  return true;
}
async function refresh() {
  if (stopped || pollBusy || actionBusy) return;
  pollBusy = true;
  try { await send('poc-status'); }
  catch { elements.error.textContent = '无法读取测试扩展状态；扩展更新后请刷新本页。'; }
  finally { pollBusy = false; }
}
async function act(type) {
  if (actionBusy || stopped) return;
  actionBusy = true;
  elements.error.textContent = '';
  updateButtons();
  try { await send(type); }
  catch { elements.error.textContent = '测试扩展暂时无法响应，请刷新状态后重试。'; }
  finally { actionBusy = false; updateButtons(); }
}
elements.connect.addEventListener('click', () => void act('poc-connect'));
elements.disconnect.addEventListener('click', () => void act('poc-disconnect'));
elements.refresh.addEventListener('click', () => void refresh());
elements.smoke.addEventListener('click', () => {
  if (SMOKE_ENABLED && lastStatus?.phase === 'ready') void act('poc-smoke');
});
const polling = setInterval(() => void refresh(), 1500);
window.addEventListener('pagehide', () => { stopped = true; clearInterval(polling); }, { once: true });
void refresh();
