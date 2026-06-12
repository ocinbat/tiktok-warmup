import { createAnthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { type LanguageModel } from 'ai';

import { logger } from '../tools/utils.js';

/**
 * Multi-provider AI configuration.
 *
 * The whole bot talks to a single `LanguageModel` (see `src/tools/llm.ts`).
 * This module is the only place that knows which provider/model backs it.
 *
 * Pick a provider with the `AI_PROVIDER` env var. If it is unset, the bot
 * behaves exactly as before (Google Gemini), so existing setups keep working
 * with no changes.
 *
 *   AI_PROVIDER=google             -> @ai-sdk/google (default)
 *   AI_PROVIDER=minimax            -> MiniMax (Coding/Token Plan or pay-as-you-go)
 *   AI_PROVIDER=anthropic          -> real Anthropic Claude
 *   AI_PROVIDER=openai-compatible  -> any OpenAI-compatible endpoint
 */
export type ProviderName = 'google' | 'minimax' | 'anthropic' | 'openai-compatible';

const DEFAULTS = {
  googleModel: 'gemini-2.5-pro-preview-05-06',
  /**
   * MiniMax-M3 is the only current MiniMax model that accepts image input.
   * The bot is vision-driven (it sends device screenshots), so a non-vision
   * model such as MiniMax-M2 / M2.1 will NOT work here.
   */
  minimaxModel: 'MiniMax-M3',
  // International host. China mainland: https://api.minimaxi.com/anthropic/v1
  minimaxAnthropicBaseURL: 'https://api.minimax.io/anthropic/v1',
  // International host. China mainland: https://api.minimaxi.com/v1
  minimaxOpenAIBaseURL: 'https://api.minimax.io/v1',
} as const;

export const ACTIVE_PROVIDER: ProviderName =
  (process.env.AI_PROVIDER?.trim().toLowerCase() as ProviderName) || 'google';

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `[providers] AI_PROVIDER="${ACTIVE_PROVIDER}" requires the "${name}" environment variable, but it is missing or empty.`,
    );
  }
  return value;
};

/** Build the active language model from environment configuration. */
const buildModel = (): { model: LanguageModel; modelId: string } => {
  switch (ACTIVE_PROVIDER) {
    case 'google': {
      // Auth comes from GOOGLE_GENERATIVE_AI_API_KEY (read by @ai-sdk/google).
      const modelId = process.env.GOOGLE_MODEL?.trim() || DEFAULTS.googleModel;
      return { model: google(modelId), modelId };
    }

    case 'minimax': {
      const apiKey = requireEnv('MINIMAX_API_KEY');
      const modelId = process.env.MINIMAX_MODEL?.trim() || DEFAULTS.minimaxModel;
      const style = (process.env.MINIMAX_API_STYLE?.trim().toLowerCase() || 'anthropic') as
        | 'anthropic'
        | 'openai';

      if (style === 'openai') {
        // OpenAI-compatible endpoint (needs a pay-as-you-go platform key).
        const provider = createOpenAICompatible({
          name: 'minimax',
          baseURL: process.env.MINIMAX_BASE_URL?.trim() || DEFAULTS.minimaxOpenAIBaseURL,
          apiKey,
        });
        return { model: provider(modelId), modelId };
      }

      // Default: Anthropic-compatible endpoint. This is the path documented for
      // the MiniMax Coding/Token Plan subscription key.
      const provider = createAnthropic({
        baseURL: process.env.MINIMAX_BASE_URL?.trim() || DEFAULTS.minimaxAnthropicBaseURL,
        apiKey,
      });
      return { model: provider(modelId), modelId };
    }

    case 'anthropic': {
      const apiKey = requireEnv('ANTHROPIC_API_KEY');
      const modelId = requireEnv('ANTHROPIC_MODEL');
      const baseURL = process.env.ANTHROPIC_BASE_URL?.trim();
      const provider = createAnthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
      return { model: provider(modelId), modelId };
    }

    case 'openai-compatible': {
      const modelId = requireEnv('OPENAI_COMPATIBLE_MODEL');
      const provider = createOpenAICompatible({
        name: process.env.OPENAI_COMPATIBLE_NAME?.trim() || 'openai-compatible',
        baseURL: requireEnv('OPENAI_COMPATIBLE_BASE_URL'),
        apiKey: requireEnv('OPENAI_COMPATIBLE_API_KEY'),
      });
      return { model: provider(modelId), modelId };
    }

    default:
      throw new Error(
        `[providers] Unknown AI_PROVIDER: "${ACTIVE_PROVIDER}". ` +
          `Use one of: google, minimax, anthropic, openai-compatible.`,
      );
  }
};

const built = buildModel();

/** The single language model the whole bot uses. */
export const llm: LanguageModel = built.model;

logger.info(`🤖 AI provider: ${ACTIVE_PROVIDER} (model: ${built.modelId})`);

/**
 * Provider-specific options for the agentic `generateText` loop.
 *
 * Today this only disables Gemini's "thinking" budget to keep the tool-calling
 * loop fast and cheap. Other providers get no special options (returns
 * `undefined`), which is the safe default — sending Google-specific options to
 * MiniMax/Anthropic would be ignored or rejected.
 */
export const getThinkingProviderOptions = (): { thinkingConfig: { thinkingBudget: number } } | undefined => {
  if (ACTIVE_PROVIDER === 'google') {
    return { thinkingConfig: { thinkingBudget: 0 } };
  }
  return undefined;
};
