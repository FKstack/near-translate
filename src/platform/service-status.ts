import { browser } from 'wxt/browser';
import type { TranslationServiceStatus, TranslationStatusSource } from '../shared/contracts';

function validStatus(value: unknown): value is TranslationServiceStatus {
  if (!value || typeof value !== 'object') return false;
  const status = value as TranslationServiceStatus;
  return ['model', 'deepl-web'].includes(status.engine)
    && Number.isSafeInteger(status.cooldownUntil) && status.cooldownUntil >= 0
    && Number.isSafeInteger(status.checkedAt) && status.checkedAt >= 0;
}

/** One document-owned observer shares status events without keeping the idle background awake. */
export class TranslationServiceStatusClient implements TranslationStatusSource {
  private readonly listeners = new Set<(status: TranslationServiceStatus) => void>();
  private status?: TranslationServiceStatus;
  private listening = false;
  private pending = false;
  private disposed = false;
  private generation = 0;

  subscribe(listener: (status: TranslationServiceStatus) => void): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    if (this.status) listener(this.status);
    if (!this.listening) {
      this.listening = true;
      document.addEventListener('visibilitychange', this.refresh);
      browser.runtime.onMessage.addListener(this.onMessage);
      this.refresh();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.stop();
    };
  }

  refresh = (): void => {
    if (this.disposed || !this.listeners.size || this.pending || document.visibilityState === 'hidden') return;
    const generation = this.generation;
    this.pending = true;
    void browser.runtime.sendMessage({ type: 'get-translation-status' }).then((value: { ok?: boolean; status?: TranslationServiceStatus }) => {
      const status = value?.status;
      if (this.disposed || generation !== this.generation || !value?.ok || !validStatus(status)) return;
      this.update(status);
    }).catch(() => { /* An unavailable status must not start a translation or replace an existing failure. */ })
      .finally(() => { if (generation === this.generation) this.pending = false; });
  };

  private onMessage = (message: unknown, sender: { id?: string; url?: string; tab?: unknown }): void => {
    // Browser-provided sender identity distinguishes background/extension pages
    // from a webpage's content script; the message never supplies its own trust.
    if (this.disposed || !this.listeners.size || sender.id !== browser.runtime.id || sender.tab !== undefined
      || (sender.url !== undefined && !sender.url.startsWith(browser.runtime.getURL('')))
      || !message || typeof message !== 'object') return;
    const update = message as { type?: unknown; status?: unknown };
    if (update.type !== 'translation-status-changed' || !validStatus(update.status)) return;
    // A status fetched before the broadcast must not undo its newer cooldown.
    this.generation++; this.pending = false;
    this.update(update.status);
  };

  private update(status: TranslationServiceStatus): void {
    const changed = !this.status || this.status.engine !== status.engine || this.status.cooldownUntil !== status.cooldownUntil;
    // Copy only the public status fields; do not retain arbitrary message data.
    this.status = { engine: status.engine, cooldownUntil: status.cooldownUntil, checkedAt: status.checkedAt };
    if (changed) for (const listener of this.listeners) listener(this.status);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.listeners.clear(); this.stop(); this.status = undefined;
  }
  private stop(): void {
    if (this.listening) browser.runtime.onMessage.removeListener(this.onMessage);
    this.listening = false;
    document.removeEventListener('visibilitychange', this.refresh);
    this.generation++; this.pending = false;
  }
}
