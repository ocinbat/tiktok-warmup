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
  googleModel: 'gemini-2.5-pro',
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

/**
 * Provider for vision sub-calls (screenshot analysis & coordinate detection).
 * Defaults to AI_PROVIDER, so single-provider setups are unchanged. Set
 * VISION_PROVIDER=google to run precise coordinate work on Gemini while keeping
 * orchestration on another provider (e.g. MiniMax) — Gemini is much stronger at
 * the 0-1000 bounding-box grounding this bot relies on.
 */
export const VISION_PROVIDER: ProviderName =
  (process.env.VISION_PROVIDER?.trim().toLowerCase() as ProviderName) || ACTIVE_PROVIDER;

const requireEnv = (name: string, context: string): string => {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `[providers] ${context} requires the "${name}" environment variable, but it is missing or empty.`,
    );
  }
  return value;
};

/**
 * Build a language model for a specific provider.
 * @param modelOverride optional model id (used by the vision role via VISION_MODEL)
 * @param context human-readable source of this config, for error messages
 */
const buildModelFor = (
  provider: ProviderName,
  modelOverride: string | undefined,
  context: string,
): { model: LanguageModel; modelId: string } => {
  switch (provider) {
    case 'google': {
      // Auth comes from GOOGLE_GENERATIVE_AI_API_KEY (read by @ai-sdk/google).
      const modelId = modelOverride || process.env.GOOGLE_MODEL?.trim() || DEFAULTS.googleModel;
      return { model: google(modelId), modelId };
    }

    case 'minimax': {
      const apiKey = requireEnv('MINIMAX_API_KEY', context);
      const modelId = modelOverride || process.env.MINIMAX_MODEL?.trim() || DEFAULTS.minimaxModel;
      const style = (process.env.MINIMAX_API_STYLE?.trim().toLowerCase() || 'anthropic') as
        | 'anthropic'
        | 'openai';

      if (style === 'openai') {
        // OpenAI-compatible endpoint (needs a pay-as-you-go platform key).
        const provider2 = createOpenAICompatible({
          name: 'minimax',
          baseURL: process.env.MINIMAX_BASE_URL?.trim() || DEFAULTS.minimaxOpenAIBaseURL,
          apiKey,
        });
        return { model: provider2(modelId), modelId };
      }

      // Default: Anthropic-compatible endpoint. This is the path documented for
      // the MiniMax Coding/Token Plan subscription key.
      const provider2 = createAnthropic({
        baseURL: process.env.MINIMAX_BASE_URL?.trim() || DEFAULTS.minimaxAnthropicBaseURL,
        apiKey,
      });
      return { model: provider2(modelId), modelId };
    }

    case 'anthropic': {
      const apiKey = requireEnv('ANTHROPIC_API_KEY', context);
      const modelId = modelOverride || requireEnv('ANTHROPIC_MODEL', context);
      const baseURL = process.env.ANTHROPIC_BASE_URL?.trim();
      const provider2 = createAnthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
      return { model: provider2(modelId), modelId };
    }

    case 'openai-compatible': {
      const modelId = modelOverride || requireEnv('OPENAI_COMPATIBLE_MODEL', context);
      const provider2 = createOpenAICompatible({
        name: process.env.OPENAI_COMPATIBLE_NAME?.trim() || 'openai-compatible',
        baseURL: requireEnv('OPENAI_COMPATIBLE_BASE_URL', context),
        apiKey: requireEnv('OPENAI_COMPATIBLE_API_KEY', context),
      });
      return { model: provider2(modelId), modelId };
    }

    default:
      throw new Error(
        `[providers] Unknown provider: "${provider}". ` +
          `Use one of: google, minimax, anthropic, openai-compatible.`,
      );
  }
};

/**
 * Wrap a model builder in a transparent lazy proxy.
 *
 * Initialization is deferred until the model is actually accessed. ESM imports
 * are hoisted and run before the entry point's body, so building eagerly at the
 * top level could read `process.env` before `dotenv/config` has populated it —
 * leading to "missing key" errors or wrong defaults. The real model is created
 * on first property access and then reused. Methods are read/bound against the
 * real model (not the proxy) so providers that rely on private fields keep
 * working. (`LanguageModel` is `string | LanguageModelV2`; here it is always the
 * object form, so the proxy treats the resolved model as a plain object.)
 */
const lazyModel = (
  build: () => { model: LanguageModel; modelId: string },
  announce: (modelId: string) => void,
): LanguageModel => {
  let cached: LanguageModel | undefined;
  const resolve = (): object => {
    if (!cached) {
      const built = build();
      cached = built.model;
      announce(built.modelId);
    }
    return cached as unknown as object;
  };

  return new Proxy(
    {},
    {
      get(_target, prop) {
        const model = resolve();
        const value = Reflect.get(model, prop, model);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(model) : value;
      },
      has(_target, prop) {
        return Reflect.has(resolve(), prop);
      },
      ownKeys() {
        return Reflect.ownKeys(resolve());
      },
      getOwnPropertyDescriptor(_target, prop) {
        const descriptor = Reflect.getOwnPropertyDescriptor(resolve(), prop);
        if (descriptor) {
          // The proxy target is an empty object, so any reported own property
          // must be configurable to satisfy the Proxy invariant.
          descriptor.configurable = true;
        }
        return descriptor;
      },
    },
  ) as unknown as LanguageModel;
};

/** Orchestration model — drives the agent tool-use loop. */
export const llm: LanguageModel = lazyModel(
  () => buildModelFor(ACTIVE_PROVIDER, undefined, `AI_PROVIDER="${ACTIVE_PROVIDER}"`),
  (modelId) => logger.info(`🤖 AI provider: ${ACTIVE_PROVIDER} (model: ${modelId})`),
);

/**
 * Vision model — screenshot analysis & coordinate detection. Same as `llm`
 * unless VISION_PROVIDER (and optionally VISION_MODEL) is set.
 */
export const visionLlm: LanguageModel = lazyModel(
  () => buildModelFor(VISION_PROVIDER, process.env.VISION_MODEL?.trim() || undefined, `VISION_PROVIDER="${VISION_PROVIDER}"`),
  (modelId) => logger.info(`👁️  Vision provider: ${VISION_PROVIDER} (model: ${modelId})`),
);

/**
 * Provider-specific options for the agentic `generateText` loop.
 *
 * For Gemini we set the "thinking" budget. NOTE: gemini-2.5-pro REQUIRES thinking
 * — a budget of 0 is rejected with "This model only works in thinking mode", so
 * we default to -1 (dynamic: the model decides how much to think), which is valid
 * for pro, flash and flash-lite. Override with GOOGLE_THINKING_BUDGET, e.g. set it
 * to 0 on gemini-2.5-flash to turn thinking off for lower cost/latency.
 *
 * Other providers get no special options (returns `undefined`) — sending
 * Google-specific options to MiniMax/Anthropic would be ignored or rejected.
 */
export const getThinkingProviderOptions = (): { google: { thinkingConfig: { thinkingBudget: number } } } | undefined => {
  if (ACTIVE_PROVIDER === 'google') {
    const raw = process.env.GOOGLE_THINKING_BUDGET?.trim();
    const parsed = raw ? Number(raw) : NaN;
    const thinkingBudget = Number.isFinite(parsed) ? parsed : -1; // -1 = dynamic thinking
    return { google: { thinkingConfig: { thinkingBudget } } };
  }
  return undefined;
};
