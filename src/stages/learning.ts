import { z } from 'zod';

import type { AppProfile } from '@/config/apps.js';
import type { DeviceManager } from '@/core/DeviceManager.js';
import { interactWithScreen } from '@/tools/interaction.js';
/**
 * One learned UI element. Only `found` matters structurally; the rest are
 * optional so a flaky model can't fail validation by omitting them.
 */
const uiElementSchema = z.object({
  found: z.boolean(),
  coordinates: z.object({ x: z.number(), y: z.number() }).optional(),
  boundingBox: z.object({ y1: z.number(), x1: z.number(), y2: z.number(), x2: z.number() }).optional(),
  confidence: z.number().optional(),
  label: z.string().optional(),
});

/**
 * Learning Stage Result Schema
 *
 * Each element defaults to { found: false } so that when the orchestration model
 * (e.g. MiniMax) omits an element from finish_task — putting its coordinates only
 * in the free-text `message` — validation still passes instead of throwing away
 * the whole run. The prompt explicitly asks the model to fill every element.
 */
const LearningResultSchema = z.object({
  success: z.boolean(),
  appLaunched: z.boolean(),
  uiElementsFound: z.object({
    likeButton: uiElementSchema.default({ found: false }),
    commentButton: uiElementSchema.default({ found: false }),
    commentInputField: uiElementSchema.default({ found: false }),
    commentSendButton: uiElementSchema.default({ found: false }),
    commentCloseButton: uiElementSchema.default({ found: false }),
  }).default({}),
  nextStage: z.enum(['learning', 'working']),
  message: z.string(),
  stepsUsed: z.number(),
});

const buildLearningPrompt = (app: AppProfile): string => `You are a ${app.displayName} automation agent in the LEARNING stage. Your mission:

    1. **FIRST**: Check device connection and launch the ${app.displayName} app
    If not - find the app and launch it
    ${app.feedNavigationHint ? `1b. **REACH THE FEED**: ${app.feedNavigationHint}\n` : ''}
    2. **THEN**: Take screenshots to analyze the ${app.displayName} ${app.feedName} interface
    3. **FIND**: Locate key UI elements and their exact coordinates:
      - Like button (heart icon, usually on right side)
      - Comment button (speech bubble icon)
    4. **LEARN COMMENT FLOW**: Practice comment writing sequence:
      - Click comment button
      - Wait 1 second for comment UI to load
      - Take screenshot to analyze comment interface
      - Find comment input field (text input area)
      - Find send button (usually red/colored button)
      - Test the full flow: click input → type test → find send button

    **IMPORTANT RULES:**
    - Use the provided tools to interact with the phone
    - Take screenshots frequently to see current state.
    - If ${app.displayName} is not open, launch it first using launch_app_activity
    - Be patient - wait for UI to load between actions
    - Try different approaches if first attempts fail
    - **MUST LEARN COMMENT FLOW**: Don't finish until you've found comment input and send button
    - **REQUIRED for success:** like button, comment button, comment input field, send button. The close/X button is OPTIONAL — the bot closes the comment panel with the Android back button, so you do NOT need its coordinate.
    - **ALWAYS call finish_task.** The moment you have found the like, comment, input and send buttons and posted the test comment, call finish_task(success=true) immediately. Do NOT keep exploring and never run out of steps without calling finish_task.


    **Error Handling:**
    - If you can't reach the goal. Maybe some coordinates are wrong. Try to find the object again.

    ## Comment Learning Sequence:
    1. Click comment button → wait 1s → screenshot
    2. Find comment input field coordinates
    3. Click input field → wait 1s → type "Nice video 👍" (or any other realistic test comment)
    4. Take screenshot to confirm text entered
    5. Find red/colored send button coordinates
    6. Click send button to actually post the comment (complete the flow, not keyboard button, but the send button in the ${app.displayName} UI)
    7. Wait 2s for comment to be posted
    8. Close the comment panel. Most apps have NO X/close button — press the BACK button (use pressKey with keycode "back") or swipe down to dismiss it. Do NOT keep searching for an X button: take at most ONE screenshot to look for it, and if you don't see one, just press back.
    9. The close/X button coordinate is OPTIONAL. If there is no visible X button, set commentCloseButton.found=false and move on — that is completely fine.
    10. Save all the coordinates you found and call finish_task(success=true)

    ## How to finish the learning stage
    Run final function 'finish_task' with the result.
    Do not close keyboard using other tools. it should be automatically by submitting comment.

    **CRITICAL — fill finish_task.uiElementsFound correctly:**
    - You MUST include EVERY element you located in the uiElementsFound object: likeButton, commentButton, commentInputField, commentSendButton, and commentCloseButton.
    - For each element you found, set found:true and its exact pixel coordinates {x, y} taken from the find_object results. Do NOT put coordinates only in the "message" field — they MUST be inside uiElementsFound or they are lost.
    - Example of a correctly filled element:
        "commentButton": { "found": true, "coordinates": { "x": 1334, "y": 1705 } }
    - commentCloseButton may be { "found": false } when the app has no X button (that is fine).

    - When you have found like, comment, input field and send button, return success:true
    - If any of those four is missing, return success:false


    For screenshot, use take_and_analyze_screenshot tool. But use it only for one query per call. Like one for like button, one for comment button, one for input field, one for send button.
    Start by checking device connection and launching ${app.displayName}!`

/**
 * Learning Stage Implementation
 * Uses AI SDK generateObject with maxSteps to learn TikTok interface
 */
export class LearningStage {
  private deviceId: string;
  private deviceManager: DeviceManager;
  private app: AppProfile;

  constructor(deviceId: string, deviceManager: DeviceManager, app: AppProfile) {
    this.deviceId = deviceId;
    this.deviceManager = deviceManager;
    this.app = app;
  }

  /**
   * Execute learning stage with AI agent
   */
  async execute(): Promise<z.infer<typeof LearningResultSchema>> {
    console.log(`🧠 [Learning] Starting learning stage for device: ${this.deviceId} (${this.app.displayName})`);

    return await interactWithScreen<z.infer<typeof LearningResultSchema>>(buildLearningPrompt(this.app), this.deviceId, this.deviceManager, {}, LearningResultSchema);
  }

  /**
   * Cleanup and disconnect
   */
  async cleanup() {
    try {
      // TODO: Implement cleanup
    } catch (error) {
      console.warn(`⚠️ [Learning] Cleanup warning:`, error);
    }
  }
}

/**
 * Direct Learning Stage Execution
 */
export async function runLearningStage(deviceId: string, deviceManager: DeviceManager, app: AppProfile): Promise<z.infer<typeof LearningResultSchema>> {
  const stage = new LearningStage(deviceId, deviceManager, app);
  
  try {
    return await stage.execute();
  } finally {
    await stage.cleanup();
  }
} 