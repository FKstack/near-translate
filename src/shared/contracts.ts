import type { LanguageOptions } from './languages';
import type { KeyVaultStatus } from './key-vault';

export type TranslationKind = 'word' | 'text';
export type TranslationEngine = 'model' | 'deepl-web';
export interface TranslationInput extends LanguageOptions {
  text: string;
  context?: string;
  kind: TranslationKind;
  /** A bounded set of page passages; never used for dictionary selections. */
  pageSegments?: string[];
  task?: 'sentence-analysis';
}
export interface WordSense {
  partOfSpeech: string;
  meaning: string;
}
export interface WordResult {
  kind: 'word';
  translation: string;
  partOfSpeech: string;
  explanation: string;
  senses: WordSense[];
}
/** Complete string fields from an unfinished dictionary response; never a final result. */
export type WordPreview = Partial<Pick<WordResult, 'translation' | 'partOfSpeech' | 'explanation'>>;
export interface TextResult {
  kind: 'text';
  translation: string;
  segments?: string[];
}
export type TranslationResult = WordResult | TextResult;
export type GrammarCategory = 'subject' | 'predicate' | 'object' | 'clause' | 'modifier' | 'other';
export interface SentenceAnalysis {
  mainClause: { text: string; translation: string; explanation: string };
  chunks: Array<{ text: string; role: string; explanation: string; category?: GrammarCategory }>;
  readingGuide: string;
}
export type TranslationEvent =
  | { type: 'progress' }
  | { type: 'word-preview'; preview: WordPreview }
  | { type: 'delta'; text: string }
  | { type: 'segment'; index: number; text: string }
  | { type: 'analysis'; analysis: SentenceAnalysis }
  | { type: 'result'; result: TranslationResult };
export interface TranslationProvider {
  translate(input: TranslationInput, signal: AbortSignal): AsyncIterable<TranslationEvent>;
}
export interface EditableSettings extends LanguageOptions {
  translationEngine?: TranslationEngine;
  enabled: boolean;
  includeContext: boolean;
  sentenceAnalysisEnabled: boolean;
  model: string;
  apiKey: string;
  provider: ProviderId;
  baseUrl: string;
  jsonMode: boolean;
}
export type ProviderId = 'deepseek' | 'openai' | 'gemini' | 'qwen' | 'moonshot' | 'siliconflow' | 'openrouter' | 'ollama' | 'custom';
export interface ApiProfile { model: string; apiKey: string; baseUrl: string; jsonMode: boolean }
export interface PublicApiProfile { model: string; hasApiKey: boolean; baseUrl: string; jsonMode: boolean }
export interface StoredSettings extends EditableSettings { schemaVersion: 2; translationEngine: TranslationEngine; connectionRevision: number; profiles: Partial<Record<ProviderId, ApiProfile>>; keyVaultLocked?: boolean; apiKeyMigrationRequired?: boolean }
export interface PublicSettings extends LanguageOptions {
  translationEngine?: TranslationEngine;
  enabled: boolean;
  includeContext: boolean;
  sentenceAnalysisEnabled: boolean;
  model: string;
  hasApiKey: boolean;
  /** Capability only; vault details and secrets stay in trusted extension contexts. */
  keyVaultLocked?: boolean;
  /** A saved legacy encrypted key can be imported once or replaced in settings. */
  apiKeyMigrationRequired?: boolean;
  webAccess: boolean;
  provider?: ProviderId;
  requiresApiKey?: boolean;
  apiAccess?: boolean;
  connectionRevision?: number;
}
/** Only returned to trusted extension pages; never contains API keys. */
export interface ConnectionSettings extends PublicSettings {
  vault?: KeyVaultStatus;
  legacyKeyProviders?: ProviderId[];
  legacyKeyMigrationAvailable?: boolean;
  /** Optional browser permission, not a stored model preference. */
  networkPreparationAccess?: boolean;
  provider: ProviderId;
  baseUrl: string;
  jsonMode: boolean;
  profiles: Partial<Record<ProviderId, PublicApiProfile>>;
}
export type ErrorCode = 'CONFIG' | 'AUTH' | 'BALANCE' | 'RATE_LIMIT' | 'NETWORK' | 'TIMEOUT' | 'INVALID_RESPONSE' | 'INVALID_INPUT' | 'DISCONNECTED' | 'SERVER';
export interface TranslationError { code: ErrorCode; message: string; retryable: boolean; retryAt?: number; serviceWide?: true }
/** Whitelisted service metadata only; never contains response text or request identity. */
export interface TranslationRateLimitDiagnostic {
  source: 'http-429' | 'json-too-many-requests';
  httpStatus: number;
  at: number;
  retryAfterMs?: number;
  responseReason?: 'rate-limit' | 'quota' | 'concurrency' | 'payload-limit' | 'authentication';
}
export interface TranslationServiceStatus {
  engine: TranslationEngine;
  cooldownUntil: number;
  checkedAt: number;
  rateLimit?: TranslationRateLimitDiagnostic;
}
export interface TranslationStatusSource {
  subscribe(listener: (status: TranslationServiceStatus) => void): () => void;
  refresh(): void;
}
export type TranslationClientMessage =
  | { type: 'translate'; requestId: string; input: TranslationInput }
  | { type: 'cancel'; requestId: string }
  | { type: 'heartbeat'; requestId: string };
export type TranslationServerMessage =
  | { type: 'started'; requestId: string }
  | (TranslationEvent & { requestId: string })
  | { type: 'error'; requestId: string; error: TranslationError };

export const TRANSLATION_PORT = 'near-translate:v1';
export const DEFAULT_MODEL = 'deepseek-flash';
export const MAX_TEXT_LENGTH = 12_000;
export const MAX_CONTEXT_LENGTH = 600;
export const MAX_PAGE_BATCH_ITEMS = 32;
export const MAX_SENTENCE_ANALYSIS_LENGTH = 2_000;
export const REQUEST_TIMEOUT_MS = 90_000;
export const CLIENT_TIMEOUT_MS = 95_000;
export const HEARTBEAT_MS = 15_000;
