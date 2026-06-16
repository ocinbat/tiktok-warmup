/* eslint-disable no-duplicate-imports */
import type { ModelMessage, ToolSet } from "ai";
import { generateObject, generateText, hasToolCall, stepCountIs } from "ai";
import { z } from "zod";

import type { ElementKey, ElementLedger } from "./ElementLedger.js";
import { getThinkingProviderOptions, llm, visionLlm } from "./llm.js";
import { verifyCommentPosted } from "./uiVerify.js";
import { logger, uuidv4 } from "./utils.js";

import type { DeviceManager } from "@/core/DeviceManager.js";

/**
 * Optional extras for a single interaction run.
 * - `ledger`: when present, tap_element/find_object record the EXACT detected
 *   coordinate here (keyed by elementKey), so learned coordinates come from real
 *   taps, never from numbers the LLM hand-copies into finish_task.
 * - `verifyComment`: enables the objective `verify_comment_posted` tool, which
 *   checks the view hierarchy (vision fallback) and locks the verified send
 *   coordinate in the ledger.
 */
export interface InteractionOptions {
  ledger?: ElementLedger;
  verifyComment?: { expectedText: string };
  /** Enables the test_like_button tool (taps like, proves it toggled, un-likes). */
  testLike?: boolean;
}

/** A screenshot plus the pixel dimensions it was captured at (= tap space). */
interface Screenshot {
  base64Data: string;
  width: number;
  height: number;
}


/**
 * Max tool-use steps for one interactWithScreen run before we stop the agent.
 * Slower / more exploratory models (e.g. MiniMax M3) need more headroom than
 * the original 20. Override with AGENT_MAX_STEPS.
 */
const AGENT_MAX_STEPS = Number(process.env.AGENT_MAX_STEPS) || 40;

/**
 * Optional hard cap on tokens generated per agent step. Unset = no cap (the
 * default for cloud models like Gemini). Set AGENT_MAX_OUTPUT_TOKENS (e.g. 4096)
 * to rein in a verbose local reasoning model that burns 15-20k reasoning tokens
 * per call. WARNING: setting it too low can cut a reasoning model off before it
 * emits its tool call — keep it generous (>= 2048).
 */
const AGENT_MAX_OUTPUT_TOKENS = Number(process.env.AGENT_MAX_OUTPUT_TOKENS) || undefined;

/**
 * Order of the 4 numbers a vision model returns for a bounding box.
 * - Gemini returns [y1, x1, y2, x2] (y-first) — the default.
 * - Qwen-VL and most OpenAI-style vision models return [x1, y1, x2, y2] (x-first).
 * Set VISION_BOX_ORDER=xyxy for those. A wrong order swaps X and Y, so taps land
 * in the wrong place (e.g. opening the camera instead of liking).
 */
const VISION_BOX_XY_FIRST = process.env.VISION_BOX_ORDER?.trim().toLowerCase() === 'xyxy';

/** True for the AI SDK error thrown when the model returns no parseable object. */
const isNoObjectGenerated = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AI_NoObjectGeneratedError';

/**
 * True for an OpenAI-compatible server that rejected the structured-output
 * response_format we sent (e.g. LM Studio's HTTP 400 "'response_format.type'
 * must be 'json_schema' or 'text'"). The text fallback below sends no
 * response_format, so it succeeds where the structured request was refused.
 */
const isUnsupportedResponseFormat = (error: unknown): boolean => {
  if (!(error instanceof Error) || error.name !== 'AI_APICallError') return false;
  const status = (error as { statusCode?: number }).statusCode;
  const haystack = `${String((error as { responseBody?: unknown }).responseBody ?? '')} ${error.message}`;
  return status === 400 && /response_format|json_schema|json_object/.test(haystack);
};

/** Best-effort shape hint for a Zod object schema, used in the JSON fallback prompt. */
const describeSchemaShape = (schema: z.ZodTypeAny): string => {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const fields = Object.entries(shape).map(([key, value]) => {
      const description = value.description ? ` // ${value.description}` : '';
      return `  "${key}": ...${description}`;
    });
    return `{\n${fields.join('\n')}\n}`;
  }
  return 'a single JSON object';
};

/** Pull the first complete JSON object out of a possibly-noisy text response. */
const extractJsonObject = (text: string): string => {
  let candidate = text.trim();
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidate = fenced[1].trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start !== -1 && end > start) return candidate.slice(start, end + 1);
  return candidate;
};

/**
 * Generate a schema-validated object from the model.
 *
 * Primary path is the AI SDK's generateObject. Some providers (notably MiniMax
 * M3 over the Anthropic-compatible endpoint) intermittently return prose /
 * reasoning instead of the structured object, surfacing as
 * NoObjectGeneratedError. In that case we fall back to a plain text completion
 * instructed to emit only JSON, then parse and validate it against the same
 * schema. Providers that already return clean objects (e.g. Gemini) never reach
 * the fallback, so their behavior is unchanged.
 */
async function generateStructured<T>(params: {
  messages: ModelMessage[];
  // Input decoupled from output so schemas using .default() infer T as the output type.
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  schemaName?: string;
  schemaDescription?: string;
}): Promise<T> {
  const { messages, schema, schemaName, schemaDescription } = params;
  try {
    // Cast to a concrete schema type so generateObject's output-mode overload
    // resolves (it can't infer "object" vs "enum" from a generic T).
    const result = await generateObject({
      model: visionLlm,
      messages,
      schema: schema as z.ZodType<unknown>,
      schemaName,
      schemaDescription,
    });
    return result.object as T;
  } catch (error) {
    if (!isNoObjectGenerated(error) && !isUnsupportedResponseFormat(error)) throw error;

    logger.warn(`⚠️ Structured output failed (${isUnsupportedResponseFormat(error) ? 'response_format rejected' : 'no object'}); falling back to text+JSON parse (${schemaName ?? 'object'})`);
    const jsonInstruction =
      `Respond with ONLY a single valid JSON object and nothing else — no prose, no explanation, ` +
      `no markdown code fences. The JSON must match this shape:\n${describeSchemaShape(schema)}`;

    // Merge all system content (plus the JSON instruction) into a single leading
    // system message. Anthropic / MiniMax reject a system message that appears
    // after a user/assistant turn, so we cannot just append one at the end.
    const systemParts: string[] = [];
    const otherMessages: ModelMessage[] = [];
    for (const message of messages) {
      if (message.role === 'system') systemParts.push(message.content);
      else otherMessages.push(message);
    }
    systemParts.push(jsonInstruction);
    const fallbackMessages: ModelMessage[] = [
      { role: 'system', content: systemParts.join('\n\n') },
      ...otherMessages,
    ];
    const { text } = await generateText({ model: visionLlm, messages: fallbackMessages });
    const parsed: unknown = JSON.parse(extractJsonObject(text));
    return schema.parse(parsed);
  }
}


/**
 * Convert a vision model's 0-1000 normalized box into pixel coordinates.
 *
 * The denominator is the SCREENSHOT's own width/height — not `wm size`. The
 * model normalized its box over the image it was shown, and `adb shell input
 * tap` consumes coordinates in that very same space (both `screencap` and `input
 * tap` use the current display resolution). Using the image dimensions is
 * therefore exact and, unlike `wm size`, stays correct under a display-size
 * override. `outOfBounds` flags a detection whose center falls outside the image
 * (a sign of a misdetection we must not blindly tap).
 */
const convertToPixelCoordinates = (
  normalizedCoords: { y1: number, x1: number, y2: number, x2: number },
  imgWidth: number,
  imgHeight: number,
) => {
  const { y1, x1, y2, x2 } = normalizedCoords;

  const centerX = Math.round(((x1 + x2) / 2 / 1000) * imgWidth);
  const centerY = Math.round(((y1 + y2) / 2 / 1000) * imgHeight);

  return {
    y1: Math.round((y1 / 1000) * imgHeight),
    x1: Math.round((x1 / 1000) * imgWidth),
    y2: Math.round((y2 / 1000) * imgHeight),
    x2: Math.round((x2 / 1000) * imgWidth),
    centerX,
    centerY,
    outOfBounds: centerX < 0 || centerY < 0 || centerX >= imgWidth || centerY >= imgHeight,
  };
}

/**
 * Confidence derived IN CODE (so the persisted value is never an LLM-transcribed
 * number). High for an in-bounds detection with a sane bounding box; the send
 * button gets bumped to ~1.0 separately once a post is objectively verified.
 */
const deriveConfidence = (boundingBox: { y1: number, x1: number, y2: number, x2: number }, imgWidth: number, imgHeight: number): number => {
  const w = Math.abs(boundingBox.x2 - boundingBox.x1);
  const h = Math.abs(boundingBox.y2 - boundingBox.y1);
  const areaFraction = (w * h) / (imgWidth * imgHeight);
  // A plausible UI control is neither a dot nor half the screen.
  if (areaFraction > 0 && areaFraction < 0.25) return 0.9;
  return 0.6;
}

const analyzeScreenshot = async (taskId: string, screenshot: string, query: string) => {
  logger.info(`🔍 [Interacting#${taskId}] Analyzing screenshot: ${query}`);
  const analysisResult = await generateStructured({
    messages: [
      {
        role: 'system',
        content: `You are a visual LLM for object detection and spatial understanding.
        You are analyzing a social media app screenshot (TikTok or Instagram Reels) to find UI elements and answer any question from the orchestration LLM agent who will ask you to analyze the screenshot.
        `,
      },
      {
        role: 'user',
        content: [{
          type: 'text',
          text: query,
        },{
          type: 'image',
          image: `data:image/png;base64,${screenshot}`,
        }],
      },
    ],
    schema: z.object({
      result: z.string().describe('The result of the analysis, like "confirmed, object present" or "not found"'),
    }),
    schemaName: 'analysis_screenshot',
    schemaDescription: 'Analysis screenshot result',
  });

  logger.info(`🔍 [Interacting#${taskId}] Analysis result:`, analysisResult);
  return analysisResult;
};

const findObject = async (taskId: string, shot: Screenshot, query: string) => {
    logger.info(`🔍 [Interacting#${taskId}] Finding object: ${query}`);

    // The screenshot's own dimensions ARE the tap coordinate space.
    const { base64Data, width: imgWidth, height: imgHeight } = shot;

    const detection = await generateStructured({
      messages: [
        {
          role: 'system',
          content: `
          You are a visual LLM for object detection and spatial understanding.
          Return bounding box coordinates in format [y1, x1, y2, x2] normalized to 0-1000.
          Where y1,y2 are top/bottom coordinates and x1,x2 are left/right coordinates.

          You are analyzing a social media app screenshot (TikTok or Instagram Reels) to find UI elements.
          If object is found, return box_2d coordinates and descriptive label.
          If object is NOT found, set found=false and explain why in another_response field.
          `,
        },
        {
          role: 'user',
          content: [{
            type: 'text',
            text: query,
          },{
            type: 'image',
            image: `data:image/png;base64,${base64Data}`,
          }],
        },
      ],
      schema: z.object({
        found: z.boolean().describe('Whether the requested object was found'),
        box_2d: z.array(z.number()).default([]).describe('Bounding box coordinates [y1, x1, y2, x2] normalized to 0-1000, required if found=true, omit/empty if not found'),
        label: z.string().default('').describe('Descriptive label of the found object, empty if not found'),
        another_response: z.string().optional().describe('Explanation if object not found or additional context'),
      }),
      schemaName: 'detection_result',
      schemaDescription: 'Object detection result with normalized coordinates',
    });

    logger.info(`🔍 [Interacting#${taskId}] Detection result:`, detection);

    // Process and return structured result
    if (detection.found && detection.box_2d.length === 4) {
      const [a, b, c, d] = detection.box_2d;
      // Map the 4 numbers to named edges according to the model's convention.
      const { y1, x1, y2, x2 } = VISION_BOX_XY_FIRST
        ? { x1: a, y1: b, x2: c, y2: d }
        : { y1: a, x1: b, y2: c, x2: d };

      // Convert normalized coordinates to pixel coordinates (image == tap space)
      const pixelCoords = convertToPixelCoordinates({ y1, x1, y2, x2 }, imgWidth, imgHeight);
      const boundingBox = { y1: pixelCoords.y1, x1: pixelCoords.x1, y2: pixelCoords.y2, x2: pixelCoords.x2 };

      // Reject a detection that landed outside the screenshot — that is a
      // misdetection, and tapping it would hit a random edge control. The caller
      // treats this like "not found" and the agent retries.
      if (pixelCoords.outOfBounds) {
        logger.warn(`🔍 [Interacting#${taskId}] Detection out of bounds (${pixelCoords.centerX}, ${pixelCoords.centerY}) for ${imgWidth}x${imgHeight}; rejecting: ${query}`);
        return {
          found: false,
          outOfBounds: true,
          message: `Detected "${detection.label}" at (${pixelCoords.centerX}, ${pixelCoords.centerY}) which is OUTSIDE the ${imgWidth}x${imgHeight} screen — almost certainly a misdetection. Take a fresh screenshot and try a more specific description.`,
          suggestion: 'Take another screenshot and retry with a more specific description.',
          coordinates: null,
          boundingBox: null,
        };
      }

      return {
        found: true,
        outOfBounds: false,
        coordinates: {
          // Real pixel coordinates for clicking
          x: pixelCoords.centerX,
          y: pixelCoords.centerY
        },
        boundingBox, // Pixel coordinates
        label: detection.label,
        confidence: deriveConfidence(boundingBox, imgWidth, imgHeight),
        imgWidth,
        imgHeight,
        message: `Found ${detection.label} at pixel coordinates (${pixelCoords.centerX}, ${pixelCoords.centerY})`
      };
    } else {
      logger.info(`🔍 [Interacting#${taskId}] Object not found: ${query}`);
      return {
        found: false,
        outOfBounds: false,
        message: detection.another_response ?? `Object not found: ${query}`,
        suggestion: "Try taking another screenshot or look for similar UI elements",
        coordinates: null,
        boundingBox: null
      };
    }
  }

export async function interactWithScreen<T>(
  prompt: string,
  deviceId: string,
  deviceManager: DeviceManager,
  additionalTools: ToolSet,
  finalResultSchema: z.ZodSchema,
  options: InteractionOptions = {}
): Promise<T> {
    const interactionTaskId = uuidv4();
    const { ledger, verifyComment, testLike } = options;
    let capturedResult: T | undefined;
    let finished = false;

    /**
     * Record a real detection/tap into the ledger (when one is active), keyed by
     * the role the agent passed. This is the ONLY place learned coordinates come
     * from — the model never types them back. Out-of-bounds detections are not
     * reachable here because findObject rejects them before this runs.
     */
    const recordToLedger = (
      elementKey: ElementKey | undefined,
      findResult: { coordinates: { x: number, y: number } | null, boundingBox?: { y1: number, x1: number, y2: number, x2: number } | null, label?: string, confidence?: number, imgWidth?: number, imgHeight?: number },
      tapped: boolean,
    ) => {
      if (!ledger || !elementKey || !findResult.coordinates) return;
      ledger.record(elementKey, {
        x: findResult.coordinates.x,
        y: findResult.coordinates.y,
        boundingBox: findResult.boundingBox ?? undefined,
        label: findResult.label ?? elementKey,
        confidence: findResult.confidence ?? 0.9,
        tapped,
        outOfBounds: false,
        imgWidth: findResult.imgWidth ?? 0,
        imgHeight: findResult.imgHeight ?? 0,
      });
    };

    /** elementKey param shared by tap_element / find_object when a ledger is active. */
    const elementKeyParam = z
      .enum(['likeButton', 'commentButton', 'commentInputField', 'commentSendButton', 'commentCloseButton'])
      .optional()
      .describe('Which learned UI element this call corresponds to, so the system can record the real coordinate. Pass it on EVERY tap_element/find_object for a tracked button.');

    await generateText({
        model: llm,
        prompt,
        providerOptions: getThinkingProviderOptions(),
        maxOutputTokens: AGENT_MAX_OUTPUT_TOKENS,
        stopWhen: [hasToolCall('finish_task'), stepCountIs(AGENT_MAX_STEPS)],
        
        tools: {
          ...deviceManager.getAsAiTools(deviceId),

          take_and_analyze_screenshot: {
            description: 'Take a screenshot and ask Visual LLM to analyze it, like return coordinates of the UI element or something else. one task per screenshot. One object to find = one request',
            // Defaults guard against a model emitting malformed/partial args.
            parameters: z.object({
              query: z.string().default('').describe('The query to the LLM, like "find the like button" or "analyze the screenshot"'),
              action: z.enum(['answer_question', 'find_object']).default('answer_question'),
              elementKey: elementKeyParam,
            }),
            execute: async ({ query, action, elementKey }: { query: string, action: 'answer_question' | 'find_object', elementKey?: ElementKey }) => {
              try {
                if (!query.trim()) {
                  return { error: true, found: false, message: 'No query provided. Call again with a clear query describing what to find/answer.' };
                }
                if(action === 'answer_question') {
                  const screenshot = await deviceManager.takeScreenshot(deviceId);
                  const analysisResult = await analyzeScreenshot(interactionTaskId, screenshot, query);
                  return analysisResult;
                } else if(action === 'find_object') {
                  const shot = await deviceManager.takeScreenshotWithDims(deviceId);
                  const findResult = await findObject(interactionTaskId, shot, query);
                  // find_object is a READ (no tap), so record tapped:false.
                  if (findResult.found) recordToLedger(elementKey, findResult, false);
                  return findResult;
                } else {
                  return { error: true, message: `Invalid action: ${action}. Use 'answer_question' or 'find_object'.` };
                }
              } catch (error) {
                // Don't let a single flaky vision call kill the whole stage — let
                // the agent retry within its step budget instead.
                const message = error instanceof Error ? error.message : String(error);
                logger.warn(`[Interacting#${interactionTaskId}] Screenshot analysis failed, agent can retry: ${message}`);
                return { error: true, found: false, message: `Analysis failed: ${message}. Take a fresh screenshot and try again.` };
              }
            },
          },

          tap_element: {
            description: 'Find a UI element by description AND tap it in ONE step, returning the coordinates that were tapped. ALWAYS use this to tap something — never read coordinates with take_and_analyze_screenshot and then expect a separate tap. One element per call.',
            parameters: z.object({
              query: z.string().default('').describe('Description of the element to find and tap, e.g. "the comment button (speech bubble icon on the right side)"'),
              elementKey: elementKeyParam,
            }),
            execute: async ({ query, elementKey }: { query: string, elementKey?: ElementKey }) => {
              try {
                if (!query.trim()) {
                  return { tapped: false, found: false, message: 'No element description provided. Call tap_element again with a clear query.' };
                }
                const shot = await deviceManager.takeScreenshotWithDims(deviceId);
                const findResult = await findObject(interactionTaskId, shot, query);
                const { coordinates } = findResult;
                if (!findResult.found || !coordinates) {
                  // outOfBounds detections also land here (findObject rejected them),
                  // so we never tap a misdetected coordinate.
                  return { tapped: false, found: false, message: findResult.message ?? `Could not find: ${query}`, suggestion: 'Take a screenshot to see the current state, then try again.' };
                }
                await deviceManager.tapScreen(deviceId, coordinates.x, coordinates.y);
                logger.info(`👆 [Interacting#${interactionTaskId}] Found and tapped "${query}" at (${coordinates.x}, ${coordinates.y})`);
                // Record the coordinate we ACTUALLY tapped (tapped:true).
                recordToLedger(elementKey, findResult, true);
                return { tapped: true, found: true, coordinates, boundingBox: findResult.boundingBox, message: `Found and tapped ${query} at (${coordinates.x}, ${coordinates.y})` };
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger.warn(`[Interacting#${interactionTaskId}] tap_element failed (agent can retry): ${message}`);
                return { tapped: false, found: false, error: true, message: `tap_element failed: ${message}. Take a fresh screenshot and try again.` };
              }
            },
          },

          wait_for_ui: {
            description: 'Wait for UI elements to load completely',
            // Defaults make this resilient to a model that emits a malformed
            // tool call (e.g. MiniMax occasionally garbles the JSON args): a
            // missing/garbled field falls back to a sane value instead of
            // throwing AI_InvalidToolArgumentsError and killing the whole stage.
            parameters: z.object({
              seconds: z.number().min(1).max(10).default(2),
              reason: z.string().default('waiting for UI to settle'),
            }),
            execute: async ({ seconds, reason }: { seconds: number, reason: string }) => {
              logger.info(`⏳ [Learning#${interactionTaskId}] Waiting ${seconds}s for: ${reason}`);
              await new Promise(r => setTimeout(r, seconds * 1000));
              return { waited: true, seconds, reason };
            },
          },

          // Composite, in-code like test (learning only). Instead of merely
          // READING the like coordinate (which is never proven to work), it TAPS
          // the heart and proves the tap toggled the like state, then taps again
          // to restore (un-like) so no random video is left liked. The verified
          // coordinate is recorded and locked. The before→after→restore cycle is
          // robust against a constantly-"yes" vision model: a real toggle must
          // read unliked→liked→unliked, which a constant answer can never satisfy.
          ...(testLike ? {
            test_like_button: {
              description: 'Find the like (heart) button, TAP it to test, confirm the like registered, then un-like it to leave no trace — all in one call. Use this ONCE for the like step instead of find_object. If it returns verified=false, take a screenshot and call it again with a more specific heart description (at most twice).',
              parameters: z.object({
                query: z.string().default('the like button, heart icon on the right side of the video').describe('Description of the like/heart icon to find and tap'),
              }),
              execute: async ({ query }: { query: string }) => {
                const readLiked = async (): Promise<boolean> => {
                  const screenshot = await deviceManager.takeScreenshot(deviceId);
                  const vis = await analyzeScreenshot(
                    interactionTaskId,
                    screenshot,
                    `Look at the like button (the heart icon on the right side of the video). Is it currently in the LIKED state — filled/solid and red/colored — as opposed to an empty/outline heart? Answer strictly "yes" (liked) or "no" (not liked).`,
                  );
                  return /\byes\b/i.test(vis.result);
                };
                const wait = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
                try {
                  const shot = await deviceManager.takeScreenshotWithDims(deviceId);
                  const findResult = await findObject(interactionTaskId, shot, query);
                  const { coordinates } = findResult;
                  if (!findResult.found || !coordinates) {
                    return { verified: false, found: false, message: findResult.message ?? `Could not find the like button: ${query}`, suggestion: 'Take a screenshot and try again with a more specific description.' };
                  }

                  // Record the real, in-bounds heart coordinate as a candidate.
                  recordToLedger('likeButton', findResult, true);

                  const before = await readLiked();
                  await deviceManager.tapScreen(deviceId, coordinates.x, coordinates.y);
                  await wait(1.5);
                  const afterTap = await readLiked();

                  // Restore the original state by tapping the SAME coordinate again.
                  await deviceManager.tapScreen(deviceId, coordinates.x, coordinates.y);
                  await wait(1.5);
                  const afterRestore = await readLiked();

                  const toggled = afterTap !== before;
                  const restored = afterRestore === before;
                  const verified = toggled && restored;
                  if (verified && ledger) {
                    ledger.likeVerified = true;
                    ledger.lockVerified('likeButton');
                  }
                  logger.info(`❤️ [Interacting#${interactionTaskId}] test_like_button: before=${before} afterTap=${afterTap} afterRestore=${afterRestore} → verified=${verified}`);
                  return {
                    verified,
                    found: true,
                    coordinates,
                    message: verified
                      ? 'The like button works (tapping it toggled the like, then un-liked it). Coordinate recorded.'
                      : `Could not confirm the like toggled (before=${before}, afterTap=${afterTap}, afterRestore=${afterRestore}). The tap may have missed the heart — take a screenshot and call test_like_button again with a more specific description.`,
                  };
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  logger.warn(`[Interacting#${interactionTaskId}] test_like_button failed (agent can retry): ${message}`);
                  return { verified: false, found: false, error: true, message: `test_like_button failed: ${message}. Take a fresh screenshot and try again.` };
                }
              },
            },
          } : {}),

          // Objective post-verification tool, only present when the caller asked
          // for it (the learning stage). It checks the view hierarchy first
          // (ground truth) and falls back to a vision yes/no, then — on a
          // confirmed post — LOCKS the send-button coordinate that produced it.
          ...(verifyComment ? {
            verify_comment_posted: {
              description: 'Objectively check whether the test comment actually posted (reads the on-screen UI, not a guess). Call this AFTER tapping the send button. If it returns posted=false, the send tap missed — tap the send button again, then call this again. Only finish once this returns posted=true (or you have retried send twice).',
              parameters: z.object({}),
              execute: async () => {
                const expectedText = verifyComment?.expectedText ?? '';
                let posted = false;
                let method: 'uiautomator' | 'vision' = 'uiautomator';
                let usable = false;
                try {
                  const xml = await deviceManager.dumpViewHierarchy(deviceId);
                  const objective = verifyCommentPosted(xml, expectedText);
                  ({ usable } = objective);
                  if (objective.usable) {
                    ({ posted } = objective);
                    method = 'uiautomator';
                  } else {
                    const screenshot = await deviceManager.takeScreenshot(deviceId);
                    const vis = await analyzeScreenshot(
                      interactionTaskId,
                      screenshot,
                      `Look ONLY at the list of posted comments (NOT the text input box). Is a comment whose text is "${expectedText}" visible as an already-posted comment in that list? Answer strictly "yes" or "no".`,
                    );
                    posted = /\byes\b/i.test(vis.result);
                    method = 'vision';
                  }
                } catch (error) {
                  logger.warn(`[Interacting#${interactionTaskId}] verify_comment_posted failed: ${error instanceof Error ? error.message : String(error)}`);
                  return { posted: false, method, usable, message: 'Verification call failed; take a screenshot and try tapping send again.' };
                }
                if (posted && ledger) {
                  ledger.commentVerified = true;
                  ledger.verifiedBy = method;
                  ledger.lockVerified('commentSendButton');
                }
                logger.info(`🔎 [Interacting#${interactionTaskId}] verify_comment_posted: posted=${posted} via ${method} (uiautomator usable=${usable})`);
                return {
                  posted,
                  method,
                  usable,
                  message: posted
                    ? `Confirmed: the test comment is posted (verified via ${method}). You can finish now.`
                    : `NOT confirmed as posted (via ${method}). The send tap likely missed — tap the send button again with tap_element(elementKey="commentSendButton"), then call verify_comment_posted again.`,
                };
              },
            },
          } : {}),

          finish_task: {
            description: 'Finish task, this should be the last step ALWAYS if you are sure that you have completed the task. Stop execution after this, do not continue. Do not take any steps after this.',
            parameters: finalResultSchema,
            execute: async (finalResult: z.infer<typeof finalResultSchema>) => {
              logger.info(`🏁 [Interacting#${interactionTaskId}] Finished: ${JSON.stringify(finalResult)}`);
              finished = true;
              capturedResult = finalResult as unknown as T;
              return 'Ok. We done here. Stop execution, do not continue. Do not take any steps after this.'
            },
          },

          ...additionalTools,
        },
        onStepFinish: (result) => {
          logger.info(`🏁 [Interacting#${interactionTaskId}] Step finished`);
          const [firstCall] = result.toolCalls;
          const [firstResult] = result.toolResults;
          if (firstCall) {
            logger.info(`[Interacting#${interactionTaskId}] Called tool: ${firstCall.toolName} -> ${JSON.stringify(firstResult?.result)}`);
          }
        },
      });

    // generateText resolves when stopWhen is met. If the agent ran out of steps
    // without calling finish_task, the result was never captured — fail loudly
    // instead of leaving the caller's promise unsettled (which silently exits
    // the process with code 13).
    if (!finished) {
      throw new Error(
        `[Interacting#${interactionTaskId}] Agent stopped after ${AGENT_MAX_STEPS} steps without calling finish_task. ` +
        `Raise AGENT_MAX_STEPS if the task legitimately needs more steps.`,
      );
    }
    return capturedResult as T;
  }