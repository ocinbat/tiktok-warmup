/* eslint-disable no-duplicate-imports */
import type { ModelMessage, ToolSet } from "ai";
import { generateObject, generateText, hasToolCall, stepCountIs } from "ai";
import { z } from "zod";

import { getThinkingProviderOptions, llm, visionLlm } from "./llm.js";
import { logger, uuidv4 } from "./utils.js";

import type { DeviceManager } from "@/core/DeviceManager.js";


/**
 * Max tool-use steps for one interactWithScreen run before we stop the agent.
 * Slower / more exploratory models (e.g. MiniMax M3) need more headroom than
 * the original 20. Override with AGENT_MAX_STEPS.
 */
const AGENT_MAX_STEPS = Number(process.env.AGENT_MAX_STEPS) || 40;

/** True for the AI SDK error thrown when the model returns no parseable object. */
const isNoObjectGenerated = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AI_NoObjectGeneratedError';

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
    if (!isNoObjectGenerated(error)) throw error;

    logger.warn(`⚠️ Structured output missing; falling back to text+JSON parse (${schemaName ?? 'object'})`);
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
  * Convert normalized coordinates (0-1000) to pixel coordinates
  */
const convertToPixelCoordinates = (normalizedCoords: { y1: number, x1: number, y2: number, x2: number }, screenWidth: number, screenHeight: number) => {
  const { y1, x1, y2, x2 } = normalizedCoords;
  
  return {
    y1: Math.round((y1 / 1000) * screenHeight),
    x1: Math.round((x1 / 1000) * screenWidth),
    y2: Math.round((y2 / 1000) * screenHeight),
    x2: Math.round((x2 / 1000) * screenWidth),
    centerX: Math.round(((x1 + x2) / 2 / 1000) * screenWidth),
    centerY: Math.round(((y1 + y2) / 2 / 1000) * screenHeight)
  };
}

const analyzeScreenshot = async (taskId: string, screenshot: string, query: string) => {
  logger.info(`🔍 [Interacting#${taskId}] Analyzing screenshot: ${query}`);
  const analysisResult = await generateStructured({
    messages: [
      {
        role: 'system',
        content: `You are a visual LLM for object detection and spatial understanding.
        You are analyzing a TikTok app screenshot to find UI elements and answer any question from orechstation LLM agent who will ask you to analyze the screenshot.
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

const findObject = async (taskId: string, deviceId: string, deviceManager: DeviceManager, screenshot: string, query: string) => {
    logger.info(`🔍 [Interacting#${taskId}] Finding object: ${query}`);
    
    // Get screen dimensions for coordinate conversion
    const capabilities = await deviceManager.getDeviceCapabilities(deviceId);
    const { width: screenWidth, height: screenHeight } = capabilities.screenResolution;
    
    const detection = await generateStructured({
      messages: [
        {
          role: 'system',
          content: `
          You are a visual LLM for object detection and spatial understanding.
          Return bounding box coordinates in format [y1, x1, y2, x2] normalized to 0-1000.
          Where y1,y2 are top/bottom coordinates and x1,x2 are left/right coordinates.

          You are analyzing a TikTok app screenshot to find UI elements.
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
            image: `data:image/png;base64,${screenshot}`,
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
      const [y1, x1, y2, x2] = detection.box_2d;
      
      // Convert normalized coordinates to pixel coordinates
      const pixelCoords = convertToPixelCoordinates({ y1, x1, y2, x2 }, screenWidth, screenHeight);
      
      return {
        found: true,
        coordinates: {
          // Real pixel coordinates for clicking
          x: pixelCoords.centerX,
          y: pixelCoords.centerY
        },
        boundingBox: { 
          y1: pixelCoords.y1, 
          x1: pixelCoords.x1, 
          y2: pixelCoords.y2, 
          x2: pixelCoords.x2 
        }, // Pixel coordinates
        label: detection.label,
        message: `Found ${detection.label} at pixel coordinates (${pixelCoords.centerX}, ${pixelCoords.centerY})`
      };
    } else {
      logger.info(`🔍 [Interacting#${taskId}] Object not found: ${query}`);
      return {
        found: false,
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
  finalResultSchema: z.ZodSchema
): Promise<T> {
    const interactionTaskId = uuidv4();
    let capturedResult: T | undefined;
    let finished = false;

    await generateText({
        model: llm,
        prompt,
        providerOptions: getThinkingProviderOptions(),
        stopWhen: [hasToolCall('finish_task'), stepCountIs(AGENT_MAX_STEPS)],
        
        tools: {
          ...deviceManager.getAsAiTools(deviceId),

          take_and_analyze_screenshot: {
            description: 'Take a screenshot and ask Visual LLM to analyze it, like return coordinates of the UI element or something else. one task per screenshot. One object to find = one request',
            parameters: z.object({
              query: z.string().describe('The query to the LLM, like "find the like button" or "analyze the screenshot"'),
              action: z.enum(['answer_question', 'find_object']),
            }),
            execute: async ({ query, action }: { query: string, action: 'answer_question' | 'find_object' }) => {
              try {
                // Adb take screenshot by device id
                const screenshot = await deviceManager.takeScreenshot(deviceId);
                if(action === 'answer_question') {
                  const analysisResult = await analyzeScreenshot(interactionTaskId, screenshot, query);
                  return analysisResult;
                } else if(action === 'find_object') {
                  const findResult = await findObject(interactionTaskId, deviceId, deviceManager, screenshot, query);
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
          
          wait_for_ui: {
            description: 'Wait for UI elements to load completely',
            parameters: z.object({
              seconds: z.number().min(1).max(10),
              reason: z.string(),
            }),
            execute: async ({ seconds, reason }: { seconds: number, reason: string }) => {
              logger.info(`⏳ [Learning#${interactionTaskId}] Waiting ${seconds}s for: ${reason}`);
              await new Promise(r => setTimeout(r, seconds * 1000));
              return { waited: true, seconds, reason };
            },
          },

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
          if(result.toolCalls.length > 0) {
            logger.info(`[Interacting#${interactionTaskId}] Called tool: ${result.toolCalls[0].toolName} -> ${JSON.stringify(result.toolResults[0].result)}`);
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