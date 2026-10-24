/** Optional userscript gate; extension callers keep their synchronous actions. */
export type BeforeUse = () => Promise<boolean>;

export function beforeUserAction(beforeUse: BeforeUse | undefined, action: () => void): void {
  if (!beforeUse) { action(); return; }
  // Update availability must never prevent reading or translation on a failed check.
  try { void beforeUse().then(continueUse => { if (continueUse) action(); }, action); }
  catch { action(); }
}
