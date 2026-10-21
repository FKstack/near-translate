import { DEFAULT_MODEL } from '../shared/contracts';
import { OpenAICompatibleProvider } from './openai-compatible';

export { HEADER_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS } from './openai-compatible';
export interface DeepSeekConfiguration { apiKey: string; model?: string }

/** Keeps the original DeepSeek construction API while sharing the compatible transport. */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(configuration: DeepSeekConfiguration, fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
    super({ ...configuration, model: configuration.model ?? DEFAULT_MODEL, baseUrl: 'https://api.deepseek.com', provider: 'deepseek', jsonMode: true }, fetcher);
  }
}
