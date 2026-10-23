import { browser } from 'wxt/browser';
import { normalizeReadingPreferences, type ReadingPreferences } from '../shared/reading';
import { restrictStorageAccess } from './settings';

const KEY = 'reading-preferences:v1';
let writes = Promise.resolve();

export async function readReadingPreferences(): Promise<ReadingPreferences> {
  await restrictStorageAccess();
  await writes;
  const stored = await browser.storage.local.get(KEY);
  return normalizeReadingPreferences(stored[KEY]);
}

export function saveReadingPreferences(input: unknown): Promise<ReadingPreferences> {
  const preferences = normalizeReadingPreferences(input);
  const task = writes.catch(() => {}).then(async () => {
    await restrictStorageAccess();
    await browser.storage.local.set({ [KEY]: preferences });
  });
  writes = task.catch(() => {});
  return task.then(() => preferences);
}
