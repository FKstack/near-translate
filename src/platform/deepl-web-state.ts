import { browser } from 'wxt/browser';

const COOLDOWN_KEY = 'deepl-web:cooldown-until:v1';
const PREPARATION_KEY = 'deepl-web:prepare-at:v1';
const PREPARATION_INTERVAL_MS = 30_000;

/** Browser-session state survives service-worker suspension; it contains only a timestamp. */
export function createDeepLWebCooldownState() {
  let trustedAccess: Promise<void> | undefined;
  let writes = Promise.resolve();
  const restrict = () => trustedAccess ??= browser.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const read = async () => {
    await restrict();
    const value = (await browser.storage.session.get(COOLDOWN_KEY))[COOLDOWN_KEY] as unknown;
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  };
  return {
    async loadCooldownUntil(): Promise<number> {
      await writes;
      return read();
    },
    persistCooldownUntil(until: number): Promise<void> {
      if (!Number.isSafeInteger(until) || until < 0) return Promise.reject(new Error('Invalid cooldown timestamp.'));
      const operation = writes.catch(() => undefined).then(async () => {
        const previous = await read();
        await browser.storage.session.set({ [COOLDOWN_KEY]: Math.max(previous, until) });
      });
      writes = operation;
      return operation;
    },
  };
}

/** A local preparation admission limit, independent of service cooldown or credentials. */
export function createDeepLWebPreparationState(clock: () => number = () => Date.now()) {
  let trustedAccess: Promise<void> | undefined;
  let reservations = Promise.resolve();
  const restrict = () => trustedAccess ??= browser.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  return {
    reservePreparation(): Promise<boolean> {
      const operation = reservations.catch(() => undefined).then(async () => {
        await restrict();
        const previous = (await browser.storage.session.get(PREPARATION_KEY))[PREPARATION_KEY] as unknown;
        const now = clock();
        if (!Number.isSafeInteger(now) || now < 0 || (previous !== undefined
          && (typeof previous !== 'number' || !Number.isSafeInteger(previous) || previous < 0))) {
          throw new Error('Invalid preparation timestamp.');
        }
        // Future timestamps keep admission closed after a backward clock change.
        if (typeof previous === 'number' && now - previous < PREPARATION_INTERVAL_MS) return false;
        // Reserve before queue admission; cancellation or failure never refunds it.
        await browser.storage.session.set({ [PREPARATION_KEY]: now });
        return true;
      });
      reservations = operation.then(() => undefined, () => undefined);
      return operation;
    },
  };
}
