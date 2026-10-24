import type { Readability as ReadabilityConstructor } from '@mozilla/readability';

// Supplied by the official Mozilla Readability 0.6.0 standalone @require,
// pinned to its SHA-256 in the Greasy Fork metadata. It runs in the same sandbox.
declare const Readability: typeof ReadabilityConstructor;
const SandboxReadability = Readability;
export { SandboxReadability as Readability };
