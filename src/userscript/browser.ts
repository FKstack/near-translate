import { GM_STORAGE_PREFIX, requireUserscriptStorage } from './gm';

type StorageQuery = string | string[] | Record<string, unknown> | null;
type Sender = { id: string; url: string };
type MessageListener = (message: unknown, sender: Sender, respond: (response: unknown) => void) => unknown;
type RequestHandler = (message: unknown) => Promise<unknown>;
type StorageListener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, remote: boolean) => void;

function createEvent<T extends (...args: never[]) => unknown>() {
  const listeners = new Set<T>();
  return {
    addListener(listener: T) { listeners.add(listener); },
    removeListener(listener: T) { listeners.delete(listener); },
    emit(...args: Parameters<T>) { for (const listener of [...listeners]) listener(...args); },
    clear() { listeners.clear(); },
  };
}

/** Duplex ports are private module objects, with no DOM or window message bridge. */
export interface UserscriptPort {
  name: string;
  onMessage: ReturnType<typeof createEvent<(message: unknown) => void>>;
  onDisconnect: ReturnType<typeof createEvent<() => void>>;
  postMessage(message: unknown): void;
  disconnect(): void;
}

const runtimeId = 'near-translate-userscript';
const runtimeRoot = 'near-translate-userscript://runtime/';
const session = new Map<string, unknown>();
const messageEvent = createEvent<MessageListener>();
const storageListeners = new Set<StorageListener>();
const watches = new Map<string, { id: number; references: number }>();
let requestHandler: RequestHandler | undefined;
let connectionHandler: ((port: UserscriptPort) => void) | undefined;
const disconnectors = new Set<() => void>();
const copy = <T>(value: T): T => value === undefined ? value : structuredClone(value);

function keys(query: StorageQuery, all: () => string[]): string[] {
  return query === null ? all() : typeof query === 'string' ? [query] : Array.isArray(query) ? query : Object.keys(query);
}

function area(persistent: boolean) {
  return {
    async get(query: StorageQuery = null): Promise<Record<string, unknown>> {
      if (persistent) requireUserscriptStorage();
      const names = keys(query, () => persistent
        ? GM_listValues().filter(key => key.startsWith(GM_STORAGE_PREFIX)).map(key => key.slice(GM_STORAGE_PREFIX.length))
        : [...session.keys()]);
      const result: [string, unknown][] = [];
      for (const key of names) {
        const value = persistent ? GM_getValue(GM_STORAGE_PREFIX + key) : session.get(key);
        if (value !== undefined) result.push([key, copy(value)]);
        else if (query && !Array.isArray(query) && typeof query === 'object' && Object.hasOwn(query, key)) result.push([key, copy(query[key])]);
      }
      return Object.fromEntries(result);
    },
    async set(values: Record<string, unknown>): Promise<void> {
      if (persistent) requireUserscriptStorage();
      for (const [key, value] of Object.entries(values)) {
        if (persistent) GM_setValue(GM_STORAGE_PREFIX + key, copy(value));
        else session.set(key, copy(value));
      }
    },
    async remove(value: string | string[]): Promise<void> {
      if (persistent) requireUserscriptStorage();
      for (const key of Array.isArray(value) ? value : [value]) {
        if (persistent) GM_deleteValue(GM_STORAGE_PREFIX + key);
        else session.delete(key);
      }
    },
    async clear(): Promise<void> {
      if (persistent) {
        requireUserscriptStorage();
        for (const name of GM_listValues()) if (name.startsWith(GM_STORAGE_PREFIX)) GM_deleteValue(name);
      } else session.clear();
    },
    async setAccessLevel(_value: { accessLevel: string }): Promise<void> { /* GM storage is already sandbox-owned. */ },
  };
}

export function observeLocalStorage(names: string[], listener: StorageListener): () => void {
  requireUserscriptStorage();
  storageListeners.add(listener);
  for (const name of names) {
    const watch = watches.get(name);
    if (watch) { watch.references++; continue; }
    const id = GM_addValueChangeListener(GM_STORAGE_PREFIX + name, (_key, oldValue, newValue, remote) => {
      const changes = { [name]: { oldValue: copy(oldValue), newValue: copy(newValue) } };
      for (const callback of [...storageListeners]) callback(changes, remote);
    });
    watches.set(name, { id, references: 1 });
  }
  let removed = false;
  return () => {
    if (removed) return; removed = true;
    storageListeners.delete(listener);
    for (const name of names) {
      const watch = watches.get(name);
      if (watch && --watch.references === 0) { GM_removeValueChangeListener(watch.id); watches.delete(name); }
    }
  };
}

export function emitRuntimeMessage(message: unknown): void {
  messageEvent.emit(copy(message), { id: runtimeId, url: runtimeRoot }, () => {});
}

export function registerRuntimeHandlers(handlers: { request: RequestHandler; connect: (port: UserscriptPort) => void }): () => void {
  if (requestHandler) throw new Error('近译运行环境已安装。');
  requestHandler = handlers.request;
  connectionHandler = handlers.connect;
  return () => {
    if (requestHandler !== handlers.request) return;
    requestHandler = undefined; connectionHandler = undefined;
    for (const disconnect of [...disconnectors]) disconnect();
    session.clear();
  };
}

export const browser = {
  storage: { local: area(true), session: area(false) },
  permissions: {
    async contains(value: { origins?: string[]; permissions?: string[] }): Promise<boolean> {
      // GM @connect prompts own service access. Extension-only DNR preparation is unavailable.
      return !value.permissions?.length;
    },
  },
  runtime: {
    id: runtimeId,
    getURL(path: string) { return runtimeRoot + path.replace(/^\//, ''); },
    onMessage: messageEvent,
    async sendMessage<T = unknown>(message: unknown): Promise<T> {
      if (!requestHandler) throw new Error('近译运行环境尚未安装。');
      return copy(await requestHandler(copy(message))) as T;
    },
    connect(options: { name: string }): UserscriptPort {
      const accept = connectionHandler;
      if (!accept) throw new Error('近译运行环境尚未安装。');
      let closed = false;
      const clientMessage = createEvent<(message: unknown) => void>();
      const serverMessage = createEvent<(message: unknown) => void>();
      const clientDisconnect = createEvent<() => void>();
      const serverDisconnect = createEvent<() => void>();
      const disconnect = () => {
        if (closed) return; closed = true; disconnectors.delete(disconnect);
        clientDisconnect.emit(); serverDisconnect.emit();
        clientMessage.clear(); serverMessage.clear(); clientDisconnect.clear(); serverDisconnect.clear();
      };
      const post = (event: typeof clientMessage, message: unknown) => {
        if (closed) throw new Error('Port disconnected.');
        const snapshot = copy(message);
        queueMicrotask(() => { if (!closed) event.emit(snapshot); });
      };
      const client = { name: options.name, onMessage: clientMessage, onDisconnect: clientDisconnect,
        postMessage: (message: unknown) => post(serverMessage, message), disconnect };
      const server = { name: options.name, onMessage: serverMessage, onDisconnect: serverDisconnect,
        postMessage: (message: unknown) => post(clientMessage, message), disconnect };
      disconnectors.add(disconnect); accept(server);
      return client;
    },
  },
};
