/** Tampermonkey APIs stay in the userscript sandbox; never copy them to window. */
export interface GMResponse {
  status: number;
  statusText?: string;
  readyState?: number;
  responseHeaders?: string;
  responseText?: string;
  response?: unknown;
  finalUrl?: string;
  loaded?: number;
}

export interface GMRequest {
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  data: string;
  responseType: 'stream' | 'text';
  anonymous: true;
  redirect: 'error';
  timeout: number;
  nocache: true;
  onloadstart?(response: GMResponse): void;
  onreadystatechange(response: GMResponse): void;
  onprogress?(response: GMResponse): void;
  onload(response: GMResponse): void;
  onerror(): void;
  ontimeout(): void;
  onabort(): void;
}

/** Metadata is the only anonymous GET made by the update notifier. */
export interface GMMetadataRequest extends Omit<GMRequest, 'method' | 'data' | 'responseType'> {
  method: 'GET';
  responseType: 'text';
}

declare global {
  const GM_info: { scriptHandler?: string; version?: string; script?: { version?: string } };
  function GM_getValue<T = unknown>(key: string, fallback?: T): T;
  function GM_setValue(key: string, value: unknown): void;
  function GM_deleteValue(key: string): void;
  function GM_listValues(): string[];
  function GM_addValueChangeListener(key: string, listener: (name: string, oldValue: unknown, newValue: unknown, remote: boolean) => void): number;
  function GM_removeValueChangeListener(id: number): void;
  function GM_xmlhttpRequest(details: GMRequest | GMMetadataRequest): { abort(): void };
  function GM_registerMenuCommand(name: string, callback: () => void): string | number;
  function GM_unregisterMenuCommand(id: string | number): void;
  function GM_openInTab(url: string, options?: { active?: boolean; insert?: boolean; setParent?: boolean }): unknown;
}

export const GM_STORAGE_PREFIX = 'near-translate:userscript:v1:';

/** Known manager identity/version is required before trusting redirect:error with a Key. */
export function requireSafeUserscriptNetwork(): void {
  const supported = typeof GM_info === 'object' && GM_info !== null && GM_info.scriptHandler === 'Tampermonkey'
    && typeof GM_info.version === 'string' && /^\d{1,4}\.\d{1,4}(?:\.\d{1,8}){0,2}$/.test(GM_info.version);
  const version = supported ? GM_info.version!.split('.').map(Number) : [];
  if (!supported || !(version[0]! > 5 || (version[0] === 5 && version[1]! >= 4))) {
    throw new Error('网络翻译需要 Tampermonkey 5.4 或更高版本，以安全阻止请求重定向；请更新篡改猴。本地阅读仍可使用。');
  }
}

export function requireUserscriptStorage(): void {
  if (typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function'
    || typeof GM_deleteValue !== 'function' || typeof GM_listValues !== 'function'
    || typeof GM_addValueChangeListener !== 'function' || typeof GM_removeValueChangeListener !== 'function') {
    throw new Error('请使用支持所需 GM API 的新版篡改猴运行近译。');
  }
}
