/**
 * Active language model for the bot.
 *
 * The provider/model selection lives in `src/config/providers.ts` and is driven
 * by the `AI_PROVIDER` env var. This file stays as the stable import surface
 * (`./llm.js`) so the rest of the codebase does not need to change.
 */
export { ACTIVE_PROVIDER, getThinkingProviderOptions, llm } from '../config/providers.js';
export type { ProviderName } from '../config/providers.js';
