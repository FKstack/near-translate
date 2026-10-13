export type TranslationKind = 'word' | 'text';
export interface TranslationInput {
  text: string;
  context?: string;
  kind: TranslationKind;
}
export interface WordResult {
  kind: 'word';
  translation: string;
  partOfSpeech: string;
  explanation: string;
}
export interface TextResult {
  kind: 'text';
  translation: string;
}
export type TranslationResult = WordResult | TextResult;
export type TranslationEvent =
  | { type: 'delta'; text: string }
  | { type: 'result'; result: TranslationResult };
export interface TranslationProvider {
  translate(input: TranslationInput, signal: AbortSignal): AsyncIterable<TranslationEvent>;
}
export interface EditableSettings {
  enabled: boolean;
  includeContext: boolean;
  model: string;
  apiKey: string;
}
export interface StoredSettings extends EditableSettings { schemaVersion: 1 }
export interface PublicSettings {
  enabled: boolean;
  includeContext: boolean;
  model: string;
  hasApiKey: boolean;
  webAccess: boolean;
}
export type ErrorCode = 'CONFIG' | 'AUTH' | 'BALANCE' | 'RATE_LIMIT' | 'NETWORK' | 'TIMEOUT' | 'INVALID_RESPONSE' | 'INVALID_INPUT' | 'DISCONNECTED' | 'SERVER';
export interface TranslationError { code: ErrorCode; message: string; retryable: boolean }
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
export const REQUEST_TIMEOUT_MS = 90_000;
export const CLIENT_TIMEOUT_MS = 95_000;
export const HEARTBEAT_MS = 15_000;
