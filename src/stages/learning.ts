import { z } from 'zod';

import { type CapturedElement, ELEMENT_KEYS, ElementLedger } from '../tools/ElementLedger.js';
import { logger } from '../tools/utils.js';

import type { AppProfile } from '@/config/apps.js';
import type { DeviceManager } from '@/core/DeviceManager.js';
import { interactWithScreen } from '@/tools/interaction.js';

/** The throwaway comment the learning stage posts to prove the send flow works. */
const TEST_COMMENT = 'nice video';
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

    1. **FIRST**: ${app.displayName} has ALREADY been launched for you and should be on screen — take ONE screenshot to confirm. Only if it is genuinely NOT open, launch it with launch_app_activity(package_name="${app.appPackage}"). NEVER guess the package name — use exactly "${app.appPackage}". Do NOT call launch repeatedly.
    ${app.feedNavigationHint ? `1b. **REACH THE FEED**: ${app.feedNavigationHint}\n` : ''}
    2. **THEN**: Take screenshots to analyze the ${app.displayName} ${app.feedName} interface
    3. **How to TAP — this is critical.** ALWAYS use the **tap_element** tool to tap anything (comment button, input field, AND the send button). tap_element finds the element AND taps it in ONE step. NEVER just read coordinates with take_and_analyze_screenshot and then expect a separate tap to happen — that is exactly what makes you loop forever without ever pressing the button. For the LIKE button, use the dedicated **test_like_button** tool, which taps the heart to prove the coordinate works and then un-likes it so no random video stays liked.

    4. **COORDINATES ARE RECORDED FOR YOU — do not copy any numbers.** On every tap_element call, pass the matching \`elementKey\` ("commentButton", "commentInputField", or "commentSendButton"); the like button is recorded by test_like_button. The system stores the exact coordinate it tapped under that key automatically. You NEVER read, remember, or type pixel coordinates yourself, and you do NOT put coordinates in finish_task. Your only job is to perform the flow correctly and confirm the like and comment worked.

    **YOUR REAL GOAL:** PROVE both interactions work. (a) Test the LIKE button with test_like_button until it returns verified=true. (b) Post a short test comment "${TEST_COMMENT}" and confirm it with the **verify_comment_posted** tool (which objectively reads the screen). A like or send tap that was never confirmed is worthless — the working stage relies on these.

    **IMPORTANT RULES:**
    - ${app.displayName} is already open. If it somehow is not, launch it with launch_app_activity(package_name="${app.appPackage}") — never guess the package name${app.feedNavigationHint ? ', then reach the video feed as described above' : ''}.
    - Wait for the UI to load between actions; use ONE query per screenshot call.
    - To tap the SEND button, use tap_element(elementKey="commentSendButton"). Then you MUST call verify_comment_posted.
    - **RECOVERY — very important:** The comment bar has icons (emoji, @, GIF, sticker, camera, photo/gallery) next to the text box; tapping one by mistake opens a PHOTO GALLERY / image picker or some other wrong screen. If you EVER find yourself on a gallery/picker or any screen that is NOT the comment panel, you tapped the wrong thing — pressKey(keycode="back") once or twice to return to the comment panel, then retry. NEVER keep searching for the send button on a gallery screen.
    - If a tap_element call reports the element was found OUTSIDE the screen bounds, it was a misdetection and was NOT tapped — take a fresh screenshot and retry with a more specific description.
    - Never run out of steps without calling finish_task.

    ## Exact step-by-step (follow in this order, one tool call per step):
    1. test_like_button(query="the like button, heart icon on the right side of the video") → taps the heart to like, confirms the like registered, and un-likes it. If it returns verified=false, take a screenshot and call it again with a more specific description (at most twice). Then move on even if still unverified.
    2. tap_element(elementKey="commentButton", query="the comment button, speech bubble icon on the right side") → opens the comment panel.
    3. wait_for_ui(seconds=1), then take_and_analyze_screenshot(action="answer_question", query="Is the comment panel open with a text input box at the bottom?").
    4. tap_element(elementKey="commentInputField", query="the comment text entry box on the LEFT of the bottom comment bar — the area with greyed placeholder text like 'Add comment' / 'Yorum ekle'. Tap the LEFT text area ONLY, NOT the emoji, @, GIF, sticker, camera or photo/gallery icons on the RIGHT of the bar").
       After this the on-screen keyboard should appear. If instead a PHOTO GALLERY / image picker opens, you hit a photo icon: pressKey(keycode="back") to return to the comment panel, then repeat this step aiming further LEFT (smaller x).
    5. inputText(text="${TEST_COMMENT}") → type the short test comment. (Only once the text field is focused and the keyboard is up — NOT on a gallery screen.)
    6. **PRE-SEND CHECK:** take_and_analyze_screenshot(action="answer_question", query="Is the exact text '${TEST_COMMENT}' now visible inside the comment input box? Answer strictly yes or no."). If the answer is NOT yes, the text did not land — tap_element(elementKey="commentInputField", ...) again and re-run inputText, then re-check. Do this at most twice. Do NOT tap send until the text is in the box.
    7. tap_element(elementKey="commentSendButton", query="the send or post button at the right end of the comment input row (an arrow or 'Post' button), NOT the keyboard enter key") → this TAPS send. (If it could not find the send button, take a screenshot and retry with a more specific description.)
    8. wait_for_ui(seconds=2) for the comment to post.
    9. verify_comment_posted() → objective confirmation. If it returns posted=false, the send tap missed: tap_element(elementKey="commentSendButton", ...) again, wait, then call verify_comment_posted again. Do this at most twice.
    10. pressKey(keycode="back") once or twice to close the keyboard and comment panel.
    11. finish_task.

    ## How to finish the learning stage
    Run 'finish_task'. If the comment panel is still open, press back to close it first.

    **finish_task fields (coordinates are NOT needed — they are recorded automatically):**
    - appLaunched = true if you reached the ${app.feedName}.
    - For each element you successfully interacted with (via test_like_button / tap_element), set uiElementsFound.<key>.found = true. You may omit coordinates entirely.
    - commentPosted = true only if verify_comment_posted returned posted=true. (The system independently re-computes this, so be honest.)
    - success = true if you tested the like button and found comment, input and send buttons and the comment was confirmed posted.

    Use take_and_analyze_screenshot with ONE query per call.
    Start by taking ONE screenshot to confirm ${app.displayName} is open (it was already launched), then begin at step 1.`

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
   * Execute learning stage with AI agent.
   *
   * The model drives the on-device flow, but the AUTHORITATIVE result is built
   * here in code from the ElementLedger (coordinates captured at tap time) and
   * the objective verify_comment_posted signal — never from numbers or success
   * flags the model self-reports. This is what makes "thought it learned the
   * coordinates / thought it sent the comment" impossible to fake.
   */
  async execute(): Promise<z.infer<typeof LearningResultSchema>> {
    console.log(`🧠 [Learning] Starting learning stage for device: ${this.deviceId} (${this.app.displayName})`);

    // The orchestration model occasionally emits a malformed tool call (MiniMax
    // M3 sometimes garbles the JSON args), which makes the AI SDK throw and would
    // otherwise abort the whole learn even after useful coordinates were already
    // captured. Retry the run a couple of times; between attempts the glitch
    // usually clears. The ledger of the LAST attempt is salvaged at the end.
    const maxAttempts = Number(process.env.LEARNING_MAX_ATTEMPTS) || 2;
    let lastError: unknown;
    let lastLedger = new ElementLedger();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const ledger = new ElementLedger();
      lastLedger = ledger;
      try {
        // The model's finish_task payload is only advisory; we keep it for
        // appLaunched / message and recompute everything that matters from the
        // ledger.
        const modelResult = await interactWithScreen<z.infer<typeof LearningResultSchema>>(
          buildLearningPrompt(this.app),
          this.deviceId,
          this.deviceManager,
          {},
          LearningResultSchema,
          { ledger, verifyComment: { expectedText: TEST_COMMENT }, testLike: true },
        );
        return this.buildResultFromLedger(ledger, modelResult);
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`⚠️ [Learning] Attempt ${attempt}/${maxAttempts} failed (${message})${attempt < maxAttempts ? ' — retrying' : ''}`);
      }
    }

    // Every attempt threw. Salvage whatever the last attempt captured: if all the
    // required coordinates landed in the ledger before the crash, the learn still
    // succeeded enough to proceed to the working stage.
    const salvaged = this.buildResultFromLedger(lastLedger, this.emptyModelResult());
    if (salvaged.success) {
      logger.info(`✅ [Learning] Recovered the required coordinates from the ledger despite a tool-call error.`);
    } else {
      logger.error(`❌ [Learning] Failed after ${maxAttempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    }
    return salvaged;
  }

  /** Minimal placeholder result used when the model loop threw before finishing. */
  private emptyModelResult(): z.infer<typeof LearningResultSchema> {
    return {
      success: false,
      appLaunched: false,
      commentPosted: false,
      uiElementsFound: {
        likeButton: { found: false },
        commentButton: { found: false },
        commentInputField: { found: false },
        commentSendButton: { found: false },
        commentCloseButton: { found: false },
      },
      nextStage: 'learning',
      message: '',
      stepsUsed: 0,
    };
  }

  /**
   * Turn the captured ledger + objective verification into the LearningResult
   * the Worker consumes. Coordinates come straight from the recorded taps;
   * success/commentPosted are computed, not trusted.
   */
  private buildResultFromLedger(
    ledger: ElementLedger,
    modelResult: z.infer<typeof LearningResultSchema>,
  ): z.infer<typeof LearningResultSchema> {
    const input = ledger.getBest('commentInputField');

    // Choose the send button as the most recent in-bounds tap that genuinely sits
    // in the input row — to the RIGHT of the input field and at roughly its
    // height. This prevents a stray tap elsewhere (e.g. on the right-side like
    // rail) from ever being saved as the send button, even if it got locked.
    const sendPlausible = (e: CapturedElement): boolean => {
      if (!input) return true;
      const rowBand = 0.18 * (e.imgHeight || input.imgHeight || 2000);
      return e.x >= input.x && Math.abs(e.y - input.y) <= rowBand;
    };
    const sendEntry = ledger.selectBest('commentSendButton', sendPlausible);
    const sendIsPlausible = !!sendEntry && sendPlausible(sendEntry);

    const uiElementsFound = {
      likeButton: this.entryToUiElement(ledger.getBest('likeButton')),
      commentButton: this.entryToUiElement(ledger.getBest('commentButton')),
      commentInputField: this.entryToUiElement(input),
      commentSendButton: this.entryToUiElement(sendEntry),
      commentCloseButton: this.entryToUiElement(ledger.getBest('commentCloseButton')),
    };
    const send = uiElementsFound.commentSendButton;
    if (send.found && !sendIsPlausible) {
      logger.warn(`⚠️ [Learning] Send button coordinate is not in the input row (likely a stray detection); marking it low-confidence so the working stage uses its visual fallback.`);
      send.confidence = Math.min(send.confidence ?? 0.6, 0.4);
    }

    const requiredFound =
      uiElementsFound.likeButton.found &&
      uiElementsFound.commentButton.found &&
      uiElementsFound.commentInputField.found &&
      uiElementsFound.commentSendButton.found;

    const appLaunched = Boolean(modelResult.appLaunched) || ELEMENT_KEYS.some((k) => ledger.has(k));

    // likeVerified / commentPosted are OBJECTIVE signals (the tap was proven to
    // toggle the like / the comment was confirmed posted), not the model's claim.
    // When true the coordinate was locked to the exact tap that worked, so bump
    // its confidence; the working stage trusts high-confidence coords first.
    const likeVerified = ledger.likeVerified;
    if (likeVerified && uiElementsFound.likeButton.found) uiElementsFound.likeButton.confidence = 0.99;

    const commentPosted = ledger.commentVerified;
    if (commentPosted && send.found && sendIsPlausible) send.confidence = 0.99;

    // success gates only whether the working stage can start (all four coords
    // captured). It intentionally does NOT require the like/comment to be verified:
    // an unverified run still saves real, in-bounds coordinates and the working
    // stage's visual fallbacks cover them — far better than refusing to learn.
    const success = appLaunched && requiredFound;

    const commentNote = commentPosted ? ` (verified via ${ledger.verifiedBy})` : '';
    const foundSummary = `like=${uiElementsFound.likeButton.found} comment=${uiElementsFound.commentButton.found} input=${uiElementsFound.commentInputField.found} send=${uiElementsFound.commentSendButton.found}`;
    logger.info(`🧠 [Learning] Result computed from ledger — success=${success}, likeVerified=${likeVerified}, commentPosted=${commentPosted}${commentNote}, found: ${foundSummary}`);

    return {
      success,
      appLaunched,
      commentPosted,
      uiElementsFound,
      nextStage: success ? 'working' : 'learning',
      message: modelResult.message || (success ? 'Learning complete (coordinates captured from real taps).' : 'Learning incomplete — not all required elements were captured.'),
      stepsUsed: modelResult.stepsUsed ?? 0,
    };
  }

  /** Build one uiElementsFound entry from a captured ledger entry. */
  private entryToUiElement(best: CapturedElement | undefined): z.infer<typeof uiElementSchema> {
    if (!best) return { found: false };
    return {
      found: true,
      coordinates: { x: best.x, y: best.y },
      boundingBox: best.boundingBox,
      confidence: best.confidence,
      label: best.label,
    };
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