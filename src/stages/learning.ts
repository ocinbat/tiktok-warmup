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
  // True only if the agent actually posted the test comment by tapping SEND and
  // then visually confirmed it appeared in the comment list. This is the proof
  // that the learned send-button coordinate really works.
  commentPosted: z.boolean().default(false),
  uiElementsFound: z.object({
    likeButton: uiElementSchema.default({ found: false }),
    commentButton: uiElementSchema.default({ found: false }),
    commentInputField: uiElementSchema.default({ found: false }),
    commentSendButton: uiElementSchema.default({ found: false }),
    commentCloseButton: uiElementSchema.default({ found: false }),
  }).default({}),
  // Kept for schema completeness but NO LONGER load-bearing: Worker decides the
  // transition from hasLearnedUI(), not this field. Default avoids a hard
  // validation failure if the model omits it.
  nextStage: z.enum(['learning', 'working']).default('working'),
  message: z.string().default(''),
  stepsUsed: z.number().default(0),
});

const buildLearningPrompt = (app: AppProfile): string => `You are a ${app.displayName} automation agent in the LEARNING stage. Your mission:

    1. **FIRST**: Check device connection and launch the ${app.displayName} app
    If not - find the app and launch it
    ${app.feedNavigationHint ? `1b. **REACH THE FEED**: ${app.feedNavigationHint}\n` : ''}
    2. **THEN**: Take screenshots to analyze the ${app.displayName} ${app.feedName} interface
    3. **How to TAP — this is critical.** ALWAYS use the **tap_element** tool to tap anything (comment button, input field, AND the send button). tap_element finds the element AND taps it in ONE step and returns the coordinates it tapped. NEVER just read coordinates with take_and_analyze_screenshot and then expect a separate tap to happen — that is exactly what makes you loop forever without ever pressing the button. Use take_and_analyze_screenshot(action="find_object") ONLY for the LIKE button, which you must read but NOT tap (tapping it would like a random video).

    **YOUR REAL GOAL:** Do not just collect coordinates. You must PROVE the comment flow works by actually posting a short test comment and then VERIFYING it appears in the comment list. A send-button coordinate that was never tapped and confirmed is worthless — the working stage relies on it.

    **IMPORTANT RULES:**
    - If ${app.displayName} is not open, launch it first with launch_app_activity${app.feedNavigationHint ? ', then reach the video feed as described above' : ''}.
    - Wait for the UI to load between actions; use ONE query per screenshot call.
    - To tap the SEND button, use tap_element (it presses it for you). Then you MUST verify the comment actually posted.
    - **RECOVERY — very important:** The comment bar has icons (emoji, @, GIF, sticker, camera, photo/gallery) next to the text box; tapping one by mistake opens a PHOTO GALLERY / image picker or some other wrong screen. If you EVER find yourself on a gallery/picker or any screen that is NOT the comment panel, you tapped the wrong thing — pressKey(keycode="back") once or twice to return to the comment panel, then retry. NEVER keep searching for the send button on a gallery screen.
    - **REQUIRED for success:** coordinates of like, comment, input field and send button, AND a verified posted test comment. The close/X button is OPTIONAL — the bot closes the panel with the Android back button.
    - Never run out of steps without calling finish_task.

    ## Exact step-by-step (follow in this order, one tool call per step):
    1. take_and_analyze_screenshot(action="find_object", query="the like button, heart icon on the right side") → record LIKE coordinates. Do NOT tap it.
    2. tap_element(query="the comment button, speech bubble icon on the right side") → opens the comment panel and returns the COMMENT button coordinates. Record them.
    3. wait_for_ui(seconds=1), then take_and_analyze_screenshot to see the open comment panel.
    4. tap_element(query="the comment text entry box on the LEFT of the bottom comment bar — the area with greyed placeholder text like 'Add comment' / 'Yorum ekle'. Tap the LEFT text area ONLY, NOT the emoji, @, GIF, sticker, camera or photo/gallery icons on the RIGHT of the bar") → focuses the text field and returns the INPUT FIELD coordinates. Record them.
       After this the on-screen keyboard should appear. If instead a PHOTO GALLERY / image picker opens, you hit a photo icon: pressKey(keycode="back") to return to the comment panel, then repeat this step aiming further LEFT (smaller x).
    5. inputText(text="nice video") → type the short test comment. (Only do this once the text field is focused and the keyboard is up — NOT on a gallery screen.)
    6. tap_element(query="the send or post button at the right end of the comment input row (an arrow or 'Post' button), NOT the keyboard enter key") → this TAPS send and POSTS the comment, and returns the SEND button coordinates. Record them. (If tap_element reports it could not find the send button, take a screenshot, then try tap_element again with a more specific description.)
    7. wait_for_ui(seconds=2) for the comment to be posted.
    8. take_and_analyze_screenshot(action="answer_question", query="Did the test comment 'nice video' get posted — is it now visible in the list of comments? Answer clearly yes or no.") → this is the VERIFICATION. If it is NOT visible, the send tap missed: go back to step 6 and tap the send button again, then re-verify. (Do this at most twice.)
    9. pressKey(keycode="back") once or twice to close the keyboard and comment panel.
    10. finish_task.

    ## How to finish the learning stage
    Run 'finish_task'. If the comment panel is still open, press back to close it first.

    **Set the result fields like this:**
    - commentPosted = true ONLY if step 8 confirmed the test comment is visible in the comment list; otherwise false.
    - success = true ONLY if you found all four buttons AND commentPosted is true. If the comment never posted, return success=false (the send coordinate is not trustworthy).
    - uiElementsFound: include EVERY element with found:true and its exact pixel {x, y} from the tap_element / find_object results. Do NOT put coordinates only in "message" — they must be inside uiElementsFound or they are lost. Example: "commentButton": { "found": true, "coordinates": { "x": 1334, "y": 1705 } }. commentCloseButton may be { "found": false }.

    Use take_and_analyze_screenshot with ONE query per call.
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