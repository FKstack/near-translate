import { DEFAULT_MODEL, type ProviderId } from './contracts';

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  baseUrl: string;
  model: string;
  jsonMode: boolean;
  requiresApiKey: boolean;
  docsUrl: string;
}

/** Presets are editable connection defaults, not a promise of account/model access. */
export const PROVIDERS: readonly ProviderPreset[] = [
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: DEFAULT_MODEL, jsonMode: true, requiresApiKey: true, docsUrl: 'https://api-docs.deepseek.com/' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: '', jsonMode: true, requiresApiKey: true, docsUrl: 'https://developers.openai.com/api/docs/models' },
  { id: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash', jsonMode: true, requiresApiKey: true, docsUrl: 'https://ai.google.dev/gemini-api/docs/openai' },
  { id: 'qwen', label: '通义千问（百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', jsonMode: false, requiresApiKey: true, docsUrl: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope' },
  { id: 'moonshot', label: 'Kimi / Moonshot', baseUrl: 'https://api.moonshot.ai/v1', model: '', jsonMode: false, requiresApiKey: true, docsUrl: 'https://platform.kimi.ai/docs/overview' },
  { id: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V4-Flash', jsonMode: false, requiresApiKey: true, docsUrl: 'https://docs.siliconflow.cn/docs/api/chat-completions-post' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: '', jsonMode: false, requiresApiKey: true, docsUrl: 'https://openrouter.ai/docs/quickstart' },
  { id: 'ollama', label: 'Ollama（本地）', baseUrl: 'http://localhost:11434/v1', model: '', jsonMode: false, requiresApiKey: false, docsUrl: 'https://docs.ollama.com/api/openai-compatibility' },
  { id: 'custom', label: '自定义 OpenAI 兼容接口', baseUrl: '', model: '', jsonMode: false, requiresApiKey: false, docsUrl: '' },
];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && PROVIDERS.some(preset => preset.id === value);
}

export function getProvider(id: ProviderId): ProviderPreset {
  const preset = PROVIDERS.find(item => item.id === id);
  if (!preset) throw new Error('请选择有效的 API 服务商。');
  return preset;
}

export function normalizeBaseUrl(value: string): string {
  if (!value.trim() || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value) || /[\s\\]/.test(value.trim())) {
    throw new Error('请填写有效的 API Base URL。');
  }
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error('请填写完整的 API Base URL（包含 https://）。'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('API 地址须使用 HTTPS；本机 localhost / 127.0.0.1 / [::1] 可使用 HTTP。');
  }
  if (url.username || url.password || url.search || url.hash || value.includes('?') || value.includes('#')) {
    throw new Error('API 地址不能包含用户名、密码、查询参数或片段；请在 API Key 栏填写凭证。');
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  return url.href.replace(/\/+$/, '');
}

export function completionEndpoint(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
}

/** Chrome match patterns do not accept ports. The request URL still retains its port. */
export function apiOriginPattern(baseUrl: string): string {
  const url = new URL(normalizeBaseUrl(baseUrl));
  return `${url.protocol}//${url.hostname}/*`;
}
