import { GM_STORAGE_PREFIX, requireSafeUserscriptNetwork, type GMResponse } from './gm';

export type UserscriptDistribution = 'github' | 'greasyfork';
const DAY = 24 * 60 * 60 * 1000;
const MAX_METADATA_BYTES = 64 * 1024;
const REQUEST_TIMEOUT = 5000;
const GREASYFORK_SCRIPT = 'https://update.greasyfork.org/scripts/601973/%E8%BF%91%E8%AF%91%20%C2%B7%20%E7%BD%91%E9%A1%B5%E9%98%85%E8%AF%BB%E4%B8%8E%E7%BF%BB%E8%AF%91';
export const UPDATE_CHANNELS = Object.freeze({
  github: Object.freeze({ metadata: 'https://fkstack.github.io/near-translate/userscript/near-translate.meta.js',
    install: 'https://fkstack.github.io/near-translate/userscript/near-translate.user.js' }),
  greasyfork: Object.freeze({ metadata: `${GREASYFORK_SCRIPT}.meta.js`, install: `${GREASYFORK_SCRIPT}.user.js` }),
});

interface Version { numbers: number[]; prerelease: string[] }
function version(value: string): Version | undefined {
  if (value.length > 150) return;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return;
  const numbers = match.slice(1, 4).map(Number);
  if (!numbers.every(Number.isSafeInteger)) return;
  return { numbers, prerelease: match[4]?.split('.') ?? [] };
}

export function isNewerVersion(candidate: string, installed: string): boolean {
  const latest = version(candidate), current = version(installed);
  if (!latest || !current) return false;
  for (let index = 0; index < 3; index++) {
    if (latest.numbers[index] !== current.numbers[index]) return latest.numbers[index]! > current.numbers[index]!;
  }
  if (!latest.prerelease.length || !current.prerelease.length) return !latest.prerelease.length && !!current.prerelease.length;
  for (let index = 0; index < Math.max(latest.prerelease.length, current.prerelease.length); index++) {
    const left = latest.prerelease[index], right = current.prerelease[index];
    if (left === right) continue;
    if (left === undefined || right === undefined) return right === undefined;
    const leftNumeric = /^\d+$/.test(left), rightNumeric = /^\d+$/.test(right);
    if (leftNumeric !== rightNumeric) return !leftNumeric;
    if (leftNumeric) return left.length !== right.length ? left.length > right.length : left > right;
    return left > right;
  }
  return false;
}

function metadataFits(value: string): boolean {
  return value.length <= MAX_METADATA_BYTES && new TextEncoder().encode(value).byteLength <= MAX_METADATA_BYTES;
}

/** Read a bounded metadata block only; remote code and URL directives are never used. */
export function metadataVersion(text: string): string | undefined {
  if (!metadataFits(text)) return;
  const block = /^\s*\/\/ ==UserScript==\r?\n([\s\S]*?)\r?\n\/\/ ==\/UserScript==\s*$/.exec(text);
  if (!block || block[1]!.split(/\r?\n/).some(line => !/^\/\//.test(line))) return;
  const versions = [...block[1]!.matchAll(/^\/\/\s+@version\s+(\S+)\s*$/gm)];
  return versions.length === 1 && version(versions[0]![1]!) ? versions[0]![1] : undefined;
}

/** Only the two compile-time channels are reachable, independent of metadata/page input. */
export function requestUpdateMetadata(distribution: UserscriptDistribution): Promise<string> {
  const url = UPDATE_CHANNELS[distribution].metadata;
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: { abort(): void } | undefined;
    let abortWhenAssigned = false;
    const fail = () => {
      if (settled) return;
      settled = true; clearTimeout(deadline);
      reject(new Error('更新检查暂时不可用。'));
      if (request) request.abort(); else abortWhenAssigned = true;
    };
    const deadline = setTimeout(fail, REQUEST_TIMEOUT);
    const inspect = (response: GMResponse) => {
      const length = /(?:^|\r?\n)content-length:\s*(\d+)/i.exec(response.responseHeaders ?? '');
      if ((length && Number(length[1]) > MAX_METADATA_BYTES) || (response.loaded ?? 0) > MAX_METADATA_BYTES
        || (response.responseText !== undefined && !metadataFits(response.responseText))) fail();
    };
    try {
      requireSafeUserscriptNetwork();
      request = GM_xmlhttpRequest({ method: 'GET', url, headers: { Accept: 'text/plain' }, responseType: 'text',
        anonymous: true, redirect: 'error', timeout: REQUEST_TIMEOUT, nocache: true,
        onloadstart: inspect, onreadystatechange: inspect, onprogress: inspect,
        onload(response) {
          inspect(response);
          if (settled) return;
          if (response.status !== 200 || response.finalUrl !== url || typeof response.responseText !== 'string') { fail(); return; }
          settled = true; clearTimeout(deadline); resolve(response.responseText);
        }, onerror: fail, ontimeout: fail, onabort: fail });
      if (abortWhenAssigned) request.abort();
    } catch { fail(); }
  });
}

interface UpdateCache { checkedAt: number; version?: string }
export interface UpdateDependencies {
  currentVersion: string;
  now(): number;
  read(key: string): unknown;
  write(key: string, value: UpdateCache): void;
  metadata(distribution: UserscriptDistribution): Promise<string>;
  confirm(message: string): boolean;
  open(url: string): void;
}

function readCache(value: unknown): UpdateCache | undefined {
  if (!value || typeof value !== 'object') return;
  const cache = value as Partial<UpdateCache>;
  if (typeof cache.checkedAt !== 'number' || !Number.isFinite(cache.checkedAt) || cache.checkedAt < 0) return;
  return { checkedAt: cache.checkedAt, ...(typeof cache.version === 'string' && version(cache.version) ? { version: cache.version } : {}) };
}

export function createUserscriptUpdater(distribution: UserscriptDistribution, overrides: Partial<UpdateDependencies> = {}): { beforeUse(): Promise<boolean> } {
  const dependencies: UpdateDependencies = {
    currentVersion: typeof GM_info === 'object' && GM_info !== null ? GM_info.script?.version ?? '' : '', now: Date.now,
    read: key => GM_getValue(key), write: (key, value) => GM_setValue(key, value), metadata: requestUpdateMetadata,
    confirm: message => globalThis.confirm(message),
    open: url => { GM_openInTab(url, { active: true, insert: true, setParent: true }); }, ...overrides,
  };
  const key = `${GM_STORAGE_PREFIX}update-check:${distribution}:v1`;
  let checking: Promise<boolean> | undefined;
  async function check(): Promise<boolean> {
    try {
      if (!version(dependencies.currentVersion)) return true;
      const now = dependencies.now();
      let cache = readCache(dependencies.read(key));
      // Reserve before sending, including failures: refreshes and other tabs share the 24-hour limit.
      if (!cache || now - cache.checkedAt >= DAY || cache.checkedAt - now >= DAY) {
        cache = { checkedAt: now, ...(cache?.version ? { version: cache.version } : {}) };
        dependencies.write(key, cache);
        try {
          const latest = metadataVersion(await dependencies.metadata(distribution));
          if (latest) { cache.version = latest; dependencies.write(key, cache); }
        } catch { /* Keep the daily reservation and any previously verified version. */ }
      }
      if (!cache.version || !isNewerVersion(cache.version, dependencies.currentVersion)) return true;
      const accepted = dependencies.confirm(`近译有新版本 ${cache.version}（当前 ${dependencies.currentVersion}）。\n\n确定：打开安装页，在篡改猴中确认更新；更新后刷新当前页。\n取消：继续使用当前版本，下次使用近译时再次提醒。`);
      if (!accepted) return true;
      dependencies.open(UPDATE_CHANNELS[distribution].install);
      return false;
    } catch { return true; }
  }
  return { beforeUse() { return checking ??= check().finally(() => { checking = undefined; }); } };
}
