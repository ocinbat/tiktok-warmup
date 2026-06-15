import { z } from 'zod';

import type { AutomationPresets } from '../config/presets.js';
import type { LearnedUIElements } from '../core/Worker.js';
import { interactWithScreen } from '../tools/interaction.js';
import { verifyCommentPosted } from '../tools/uiVerify.js';
import { logger } from '../tools/utils.js';

import type { DeviceManager } from '@/core/DeviceManager.js';

/**
 * Working Stage Result Schema
 */
export const WorkingResultSchema = z.object({
  success: z.boolean(),
  videosWatched: z.number(),
  likesGiven: z.number(),
  commentsPosted: z.number(),
  shouldContinue: z.boolean(),
  message: z.string(),
});

/**
 * Working Stage Action Schema
 */
export const ActionDecisionSchema = z.object({
  action: z.enum(['like', 'comment', 'next_video']),
  reason: z.string(),
  commentText: z.string().optional(),
});

/**
 * Comment Generation Schema
 */
export const CommentGenerationSchema = z.object({
  screenLooksLikeNormalFeed: z.boolean().describe('Whether the screen looks like a normal video feed? Not a shop, popup, profile page, etc.'),
  commentText: z.string().describe('The generated comment text, natural and engaging'),
  confidence: z.string().describe('Confidence level: high/medium/low'),
  reasoning: z.string().describe('Why this comment fits the video content'),
});

/**
 * Sanitize text for ADB input - remove emojis and problematic characters
 */
function sanitizeTextForADB(text: string): string {
  const original = text;
  
  const sanitized = text
    // Drop control characters but KEEP Unicode letters & emoji (e.g. Turkish
    // ç ş ı ö ü ğ and 🔥👏). ADBKeyboard types them as-is; the adb fallback path
    // strips non-ASCII in sanitizeForAdbInput, so it never crashes on emoji.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    // Clean up extra spaces
    .replace(/\s+/g, ' ')
    .trim()
    // Convert to lowercase
    .toLowerCase();
    
  logger.debug(`🧹 [Working] Text sanitization: "${original}" -> "${sanitized}"`);
  return sanitized;
}

/**
 * Working Stage Implementation
 * Main automation loop that follows presets for viewing, liking, commenting
 */
export class WorkingStage {
  private deviceId: string;
  private deviceManager: DeviceManager;
  private presets: AutomationPresets;
  private learnedUI: LearnedUIElements;
  
  private stats = {
    videosWatched: 0,
    likesGiven: 0,
    commentsPosted: 0,
    errors: 0,
    sessionStartTime: Date.now(),
    lastActivityTime: Date.now(),
  };
  private healthFailures = 0;
  private healthFailureExceeded = false;

  constructor(
    deviceId: string, 
    deviceManager: DeviceManager,
    presets: AutomationPresets,
    learnedUI: LearnedUIElements
  ) {
    this.deviceId = deviceId;
    this.deviceManager = deviceManager;
    this.presets = presets;
    this.learnedUI = learnedUI;
  }

  /**
   * AI-powered screenshot analysis with proper LLM integration
   */
  async takeAndAnalyzeScreenshot(query: string): Promise<string> {
    logger.debug(`📸 [Working] Taking screenshot for analysis: ${query}`);
    
    const prompt = `You are a visual analysis assistant for ${this.presets.app.displayName} automation. Analyze the screenshot and answer the specific question.

**CRITICAL: YOU MUST CALL finish_task AS YOUR FINAL STEP!**

**Your mission:**
1. Take screenshot using take_and_analyze_screenshot
2. Analyze what you see based on the query: "${query}"
3. Provide a clear, concise answer
4. Call finish_task with your analysis result


**STOP RULE: Call finish_task immediately after getting screenshot analysis!**`;

    const AnalysisSchema = z.object({
      result: z.string().describe('The analysis result - answer to the query'),
      confidence: z.string().describe('Confidence level: high/medium/low'),
      details: z.string().describe('Additional details about what was observed'),
    });

    try {
      const result = await interactWithScreen<z.infer<typeof AnalysisSchema>>(
        prompt, 
        this.deviceId, 
        this.deviceManager, 
        {}, 
        AnalysisSchema
      );
      
      logger.debug(`🔍 [Working] Analysis result: ${result.result} (confidence: ${result.confidence})`);
      return JSON.stringify(result.result);
    } catch (error) {
      logger.error(`❌ [Working] Screenshot analysis failed:`, error);
      return "ERROR: Failed to analyze screenshot";
    }
  }

  /**
   * Wait for specified duration
   */
  private async wait(seconds: number, reason: string): Promise<void> {
    logger.debug(`⏳ [Working] Waiting ${seconds.toFixed(1)}s: ${reason}`);
    await new Promise(resolve => setTimeout(resolve, seconds * 1000));
  }

  /**
   * Decide what action(s) to take based on presets and AI analysis
   */
  async decideAction(): Promise<Array<z.infer<typeof ActionDecisionSchema>>> {
    // Roll dice for actions based on presets
    const likeRoll = Math.random();
    const commentRoll = Math.random();
    const decisions: Array<z.infer<typeof ActionDecisionSchema>> = [];

    // Like decision
    if (likeRoll < this.presets.interactions.likeChance) {
      decisions.push({
        action: 'like',
        reason: `Random like roll: ${likeRoll.toFixed(3)} < ${this.presets.interactions.likeChance}`,
      });
    }

    // Comment decision
    if (commentRoll < this.presets.interactions.commentChance) {
      let commentText: string;
      if (this.presets.comments.useAI) {
        try {
          const { language, maxLength } = this.presets.comments;
          const appName = this.presets.app.displayName;
          const prompt = `You are an advanced ${appName} comment generator. Create natural, engaging comments that match the video's tone and content.

**LANGUAGE: Write the comment in ${language}. Use casual, native-sounding ${language} the way real ${language} speakers comment on ${appName}. Do NOT use any other language.**

**CRITICAL: YOU MUST CALL finish_task AS YOUR FINAL STEP!**

**Your workflow:**
1. take_and_analyze_screenshot(query="Analyze this ${appName} video content: What's the main subject, mood/tone, and what type of engagement would be most appropriate?", action="answer_question")
2. Based on the analysis, generate a contextually perfect comment in ${language}
3. finish_task with the comment, confidence, and reasoning

**ADVANCED COMMENT STRATEGY:**
- Match the video's energy: upbeat video = enthusiastic comment, calm video = thoughtful comment
- Tailor it to the content type: tutorial/tip, funny, beautiful/aesthetic, dance/music, food, etc.
- Keep it short and authentic, like a real fan reacting

**STRICT TECHNICAL RULES:**
- Keep under ${maxLength} characters
- Lowercase; no hashtags or @mentions
- Add 1-2 fitting emojis where they feel natural — keep it subtle, never spammy
- Use natural, correct spelling with proper ${language} accents/diacritics (e.g. ç, ş, ı, ö, ü, ğ for Turkish)

**STOP RULE: Always call finish_task with your contextual comment in ${language}!**`;
          const result = await interactWithScreen<z.infer<typeof CommentGenerationSchema>>(
            prompt,
            this.deviceId,
            this.deviceManager,
            {},
            CommentGenerationSchema
          );
          if(!result.screenLooksLikeNormalFeed) {
            logger.warn(`⚠️ [Working] AI generated comment is not for a normal ${this.presets.app.feedName}, skipping`);
            return [{
              action: 'next_video',
              reason: `AI generated comment is not for a normal ${this.presets.app.feedName}, skipping`,
            }];
          }
          const sanitizedComment = sanitizeTextForADB(result.commentText);
          // Slice by code points so a trailing emoji (surrogate pair) is never cut in half.
          commentText = [...sanitizedComment].slice(0, this.presets.comments.maxLength).join('');
          logger.info(`🤖 [Working] AI generated comment: "${commentText}" (confidence: ${result.confidence})`);
        } catch (error) {
          const { templates } = this.presets.comments;
          const templateComment = templates[Math.floor(Math.random() * templates.length)];
          commentText = sanitizeTextForADB(templateComment);
          logger.warn(`⚠️ [Working] AI comment generation failed, using template: ${commentText}`, error);
        }
      } else {
        const { templates } = this.presets.comments;
        commentText = templates[Math.floor(Math.random() * templates.length)];
      }
      decisions.push({
        action: 'comment',
        reason: `Random comment roll: ${commentRoll.toFixed(3)} < ${this.presets.interactions.commentChance}`,
        commentText,
      });
    }

    // If no actions, skip
    if (decisions.length === 0) {
      decisions.push({
        action: 'next_video',
        reason: `No action triggered. Like: ${likeRoll.toFixed(3)}, Comment: ${commentRoll.toFixed(3)}`,
      });
    }

    return decisions;
  }

  /**
   * Execute like action
   */
  async executeLike(): Promise<boolean> {
    try {
      if (!this.learnedUI.likeButton) {
        logger.error(`❌ [Working] Like button coordinates not learned`);
        return false;
      }

      const { x, y } = this.learnedUI.likeButton;
      logger.info(`❤️ [Working] Liking video at (${x}, ${y})`);

      // Tap the like coordinate (this one was proven to toggle the like during
      // the learning stage's test_like_button check).
      await this.deviceManager.tapScreen(this.deviceId, x, y);
      await this.wait(1, 'After like tap');
      this.stats.likesGiven++;

      // Verify for visibility/logging ONLY. We deliberately do NOT re-tap on a
      // negative reading: the like button is a TOGGLE, so a retap driven by a
      // flaky/hallucinated "not liked" answer would UNDO a like that actually
      // registered. Correctness comes from the learning-stage verification of
      // this coordinate, not from re-tapping here.
      try {
        const liked = (await this.takeAndAnalyzeScreenshot(
          `Look at the like button (the heart icon on the right side of the video). Is it now in the LIKED state — filled/solid and red/colored — rather than an empty outline? Answer YES or NO.`
        )).toUpperCase().includes('YES');
        if (liked) {
          logger.info(`❤️ [Working] Like confirmed registered`);
        } else {
          logger.warn(`⚠️ [Working] Like tap done but could not confirm it registered — if this persists, delete data/learned-ui-data.json and re-learn.`);
        }
      } catch (error) {
        logger.debug(`[Working] Like verification skipped (non-fatal):`, error);
      }

      return true;
    } catch (error) {
      logger.error(`❌ [Working] Like action failed:`, error);
      this.stats.errors++;
      return false;
    }
  }

  /**
   * Execute comment action
   */
  async executeComment(commentText: string): Promise<boolean> {
    try {
      // commentCloseButton is no longer required — we close with the back button.
      if (!this.learnedUI.commentButton || !this.learnedUI.commentInputField || !this.learnedUI.commentSendButton) {
        logger.error(`❌ [Working] Comment UI coordinates not fully learned`);
        return false;
      }

      // Slow phones lag through the comment flow, so wait between every action
      // to let the UI settle. Tune with COMMENT_STEP_WAIT_S (seconds).
      const stepWait = Number(process.env.COMMENT_STEP_WAIT_S) || 3;

      logger.info(`💬 [Working] Commenting: "${commentText}" (${stepWait}s between steps)`);

      // Step 1: Click comment button
      const { x: commentX, y: commentY } = this.learnedUI.commentButton;
      await this.deviceManager.tapScreen(this.deviceId, commentX, commentY);
      await this.wait(stepWait, 'After comment button tap');

      // Step 1b: Make sure the comment panel actually opened. Some videos have
      // comments turned off (the comment button is disabled and does nothing),
      // which would otherwise send the agent looking for an input/send button
      // that isn't there and loop until the step limit.
      const panelState = (await this.takeAndAnalyzeScreenshot(
        `Did the comment section open? If a comment panel/sheet with a text input box to write a comment is now visible, answer exactly OPEN. If comments are turned off/disabled for this video (e.g. a message like "Comments are turned off", or no comment input is available), answer exactly DISABLED.`
      )).toUpperCase();
      if (!panelState.includes('OPEN')) {
        logger.warn(`⚠️ [Working] Comment panel did not open (comments likely disabled); skipping comment for this video`);
        await this.deviceManager.pressKey(this.deviceId, 'back');
        await this.wait(stepWait, 'After dismissing closed comment panel');
        return false;
      }

      // Step 2: Click input field
      const { x: inputX, y: inputY } = this.learnedUI.commentInputField;
      await this.deviceManager.tapScreen(this.deviceId, inputX, inputY);
      await this.wait(stepWait, 'After input field tap (let keyboard settle)');

      // Step 3: Type comment text
      await this.deviceManager.inputText(this.deviceId, commentText);
      await this.wait(stepWait, 'After typing comment');

      // Confirm the comment actually shows up as a POSTED comment (not just text
      // sitting in the input box). Objective view-hierarchy check first; vision
      // yes/no only when uiautomator is unavailable (FLAG_SECURE / obfuscated /
      // virtualized list) — same signal the learning stage now uses.
      const verifyPosted = async (): Promise<boolean> => {
        await this.wait(stepWait, 'Waiting for comment to post');
        const xml = await this.deviceManager.dumpViewHierarchy(this.deviceId);
        const objective = verifyCommentPosted(xml, commentText);
        if (objective.usable) {
          logger.info(`🔎 [Working] Post verification via uiautomator: posted=${objective.posted}`);
          return objective.posted;
        }
        const v = await this.takeAndAnalyzeScreenshot(
          `Did the comment get POSTED? Look at the posted comments list, NOT the input box. Is "${commentText}" shown as a posted comment in the list? Answer YES only if it appears as a posted comment, otherwise NO.`
        );
        return v.toUpperCase().includes('YES');
      };

      // Step 5a: Submit using the learned send-button coordinate.
      const { x: sendX, y: sendY } = this.learnedUI.commentSendButton;
      await this.deviceManager.tapScreen(this.deviceId, sendX, sendY);
      let posted = await verifyPosted();

      // Step 5b: The send button moves depending on the active keyboard, so if
      // the saved coordinate missed, locate and tap it visually instead.
      if (!posted) {
        logger.warn(`⚠️ [Working] Send via saved coordinate missed; locating the send button visually...`);
        try {
          await interactWithScreen(
            `A comment has already been typed into the ${this.presets.app.displayName} comment input box. Find the SEND / submit button for the comment (usually an arrow or "Post" button at the right end of the comment input row) and tap it with tapScreen to post the comment. Do NOT retype the comment. Then call finish_task.`,
            this.deviceId,
            this.deviceManager,
            {},
            z.object({ tapped: z.boolean().describe('whether the send button was found and tapped') }),
          );
          posted = await verifyPosted();
        } catch (error) {
          logger.warn(`⚠️ [Working] Visual send fallback failed:`, error);
        }
      }

      // Step 6: Close the comment panel with the Android back button — more
      // reliable than tapping the X, whose position shifts with the keyboard.
      // Two presses cover the "keyboard up, then panel" case; the long wait
      // between them means TikTok's double-back-to-exit can never trigger.
      await this.deviceManager.pressKey(this.deviceId, 'back');
      await this.wait(stepWait, 'After back (close keyboard/panel)');
      await this.deviceManager.pressKey(this.deviceId, 'back');
      await this.wait(stepWait, 'After back (close comment panel)');

      if (posted) {
        this.stats.commentsPosted++;
        logger.info(`✅ [Working] Comment posted: "${commentText}"`);
        return true;
      }

      logger.error(`❌ [Working] Comment could NOT be confirmed as posted: "${commentText}"`);
      await this.performHealthCheck();
      return false;
      
    } catch (error) {
      logger.error(`❌ [Working] Comment action failed:`, error);
      this.stats.errors++;
      return false;
    }
  }

  /**
   * Scroll to next video
   */
  async scrollToNextVideo(): Promise<boolean> {
    try {
      logger.debug(`📱 [Working] Scrolling to next video`);
      
      // Get actual screen size for more precise scrolling
      const screenSize = await this.deviceManager.getScreenSize(this.deviceId);
      const centerX = Math.floor(screenSize.width / 2);
      const startY = Math.floor(screenSize.height * 0.7); // Start from 70% down
      const endY = Math.floor(screenSize.height * 0.3);   // End at 30% down
      
      await this.deviceManager.swipeScreen(this.deviceId, centerX, startY, centerX, endY, 300);
      
      const scrollDelay = this.getAdaptiveDelay(this.presets.video.scrollDelay);
      await this.wait(scrollDelay, 'Scroll delay between videos');
      
      return true;
    } catch (error) {
      logger.error(`❌ [Working] Scroll action failed:`, error);
      this.stats.errors++;
      return false;
    }
  }

  /**
   * Watch current video for configured duration
   */
  async watchVideo(): Promise<void> {
    // Roll dice for quick skip (1 in 5 videos)
    const skipRoll = Math.random();
    
    if (skipRoll < this.presets.video.quickSkipChance) {
      // Quick skip - watch for just 1 second
      logger.debug(`⚡ [Working] Quick skip - watching for ${this.presets.video.quickSkipDuration}s`);
      await this.wait(this.presets.video.quickSkipDuration, 'Quick skip viewing');
    } else {
      // Normal watch duration
      const watchDuration = this.getAdaptiveDelay(this.presets.video.watchDuration);
      logger.debug(`👀 [Working] Normal viewing - watching for ${watchDuration.toFixed(1)}s`);
      await this.wait(watchDuration, 'Normal video viewing');
    }
  }

  /**
   * Execute single video automation cycle
   */
  async processVideo(): Promise<boolean> {
    try {
      logger.info(`🎬 [Working] Processing video #${this.stats.videosWatched + 1}`);
      
      // Step 1: Watch video (skip waiting on first video)
      if (this.stats.videosWatched === 0) {
        logger.info(`⚡ [Working] First video - starting immediately without watching delay`);
      } else {
        await this.watchVideo();
      }
      
      // Step 2: Health check
      const { healthCheckInterval, maxHealthFailures, shadowBanInterval } = this.presets.control;
      if (this.stats.videosWatched > 0 && this.stats.videosWatched % healthCheckInterval === 0) {
        logger.info(`🩺 [Working] Performing health check on video #${this.stats.videosWatched + 1}`);
        const healthOk = await this.performHealthCheck();
        if (!healthOk) {
          this.healthFailures++;
          logger.warn(`⚠️ [Working] Health check failed (${this.healthFailures}/${maxHealthFailures})`);
          if (this.healthFailures >= maxHealthFailures) {
            logger.error(`❌ [Working] Health check failed ${maxHealthFailures} times, need to retrain UI coordinates`);
            this.healthFailureExceeded = true;
            return false;
          }
        } else {
          this.healthFailures = 0;
        }
      }
      // Shadow ban detection
      if (this.stats.videosWatched > 0 && this.stats.videosWatched % shadowBanInterval === 0) {
        logger.info(`🕵️ [Working] Checking for shadow ban on video #${this.stats.videosWatched + 1}`);
        const shadowBanned = await this.detectShadowBan();
        if (shadowBanned) {
          logger.warn(`🚫 [Working] Shadow ban detected! Reducing activity and adding longer delays`);
          await this.wait(300, 'Shadow ban recovery delay');
        }
      }
      
      // Step 3 + 4: Decide actions and scroll to next video
      const decisions = await this.decideAction();
      logger.info(`🎯 [Working] Decided to do ${decisions.length} actions: ${decisions.map(d => d.action).join(', ')}`);
      for (const decision of decisions) {
        logger.info(`🎯 [Working] Action decision: ${decision.action} - ${decision.reason}`);
        switch (decision.action) {
          case 'like':
            await this.executeLike();
            break;
          case 'comment':
            if (decision.commentText) {
              await this.executeComment(decision.commentText);
            } else {
              logger.warn(`⚠️ [Working] Comment text is empty, skipping`);
            }
            break;
          case 'next_video':
            logger.debug(`⏭️ [Working] Moving to next video (later)`);
            break;
          default:
            logger.error(`❌ [Working] Unknown action: ${decision.action}`);
            break;
        }
      }

      // Step 4: Scroll to next video
      await this.scrollToNextVideo();
      
      // Step 5: Increment video counter AFTER processing is complete
      this.stats.videosWatched++;
      
      // Check daily limits
      const totalActions = this.stats.likesGiven + this.stats.commentsPosted;
      if (totalActions >= this.presets.interactions.dailyLimit) {
        logger.info(`🛑 [Working] Daily limit reached: ${totalActions}/${this.presets.interactions.dailyLimit}`);
        return false; // Stop automation
      }
      
      return true; // Continue automation
      
    } catch (error) {
      logger.error(`❌ [Working] Video processing failed:`, error);
      this.stats.errors++;
      return true; // Continue despite errors
    }
  }

  /**
   * Perform a periodic health check to ensure we're still on the normal video feed
   */
  async performHealthCheck(): Promise<boolean> {
    logger.info(`🩺 [Working] Running health check...`);

    const { app } = this.presets;
    const prompt = `You are a ${app.displayName} automation health checker. Your mission is to verify we're still on the normal ${app.displayName} ${app.feedName} and fix any issues.

**CRITICAL: YOU MUST CALL finish_task AS YOUR FINAL STEP (max 6 steps total)!**

**STEP-BY-STEP FLOW:**
1. take_and_analyze_screenshot(query="Check if this is the normal ${app.displayName} ${app.feedName} (full-screen vertical video) with like/comment buttons visible", action="answer_question")
2. IF normal ${app.feedName} -> finish_task(success=true, currentState="Normal ${app.feedName}", problemsDetected=[], actionsPerformed=[], message="All good")
3. IF problems detected -> try to fix them using available tools
4. After attempting fixes -> take another screenshot to verify
5. finish_task with final result

**Common problems to fix:**
- Login screens → use interact_with_screen to close or go back
- Ad overlays → find X button and tap it
- Update prompts → dismiss with "Later" or X
- Wrong screen / not on the video feed → navigate back to the ${app.feedName}${app.feedNavigationHint ? ` (${app.feedNavigationHint})` : ''}
- Popups → find close button
- App crashed → launch_app_activity(package_name="${app.appPackage}")

If you see a profile page, a shop, "Find related content", or any other UI that is not the normal ${app.feedName} - it means you are stuck. Navigate back to the feed or restart the app.

If something goes wrong, a good solution is to terminate and launch the app again.

Before finishing the task, make sure to take a screenshot of the screen and analyze it to confirm that the problems are fixed/solved.

**STOP RULE: ALWAYS call finish_task after max 10 steps!**`;

    const HealthCheckSchema = z.object({
      success: z.boolean(),
      problemWasFixed: z.boolean().describe('Whether the problems were fixed'),
      currentState: z.string().describe('Description of what was found on screen'),
      problemsDetected: z.array(z.string()).describe('List of issues found'),
      actionsPerformed: z.array(z.string()).describe('List of actions taken to fix issues'),
    });

    try {
      const result = await interactWithScreen<z.infer<typeof HealthCheckSchema>>(
        prompt, 
        this.deviceId, 
        this.deviceManager, 
        {}, 
        HealthCheckSchema
      );
      
      if (result.success) {
        logger.info(`✅ [Working] Health check passed`);
        if (result.actionsPerformed.length > 0) {
          logger.info(`🔧 [Working] Fixed issues: ${result.actionsPerformed.join(', ')}`);
        }
      } else {
        logger.error(`❌ [Working] Health check failed`);
        logger.error(`🚨 [Working] Problems detected: ${result.problemsDetected.join(', ')}`);
        if (result.actionsPerformed.length > 0) {
          logger.info(`🔧 [Working] Attempted fixes: ${result.actionsPerformed.join(', ')}`);
        }
      }

      if (!result.success) {
        this.healthFailures++;
        logger.warn(`⚠️ [Working] Health check failed (${this.healthFailures}/3)`);
        if (this.healthFailures >= 3) {
          logger.error(`❌ [Working] Health check failed 3 times, need to retrain UI coordinates`);
          this.healthFailureExceeded = true;
        }
      } else {
        this.healthFailures = 0;
      }
      
      return result.success;
    } catch (error) {
      logger.error(`❌ [Working] Health check error:`, error);
      return false;
    }
  }

  /**
   * Ensure the app's video feed is ready using the same pattern as learning stage
   */
  async ensureAppReady(): Promise<boolean> {
    const { app } = this.presets;
    logger.info(`🔍 [Working] Ensuring ${app.displayName} is ready...`);

    const prompt = `You are a ${app.displayName} automation agent ensuring the app's ${app.feedName} is ready before starting work.

**CRITICAL: YOU MUST CALL finish_task AS YOUR FINAL STEP!**

**Your mission (maximum 3-4 steps):**
1. Take screenshot to check current state
2. If the ${app.displayName} ${app.feedName} is already visible -> call finish_task immediately with success:true
3. If ${app.displayName} is not running -> launch it, wait, verify, then finish_task
${app.feedNavigationHint ? `4. ${app.feedNavigationHint}\n` : ''}If something is wrong, try to fix it, if you can't, call finish_task with success:false
You can tap, swipe, scroll, etc.

**STEP-BY-STEP FLOW:**
1. take_and_analyze_screenshot(query="Is the ${app.displayName} app open and is the ${app.feedName} (full-screen vertical video) visible?", action="answer_question")
2. IF result shows the ${app.feedName} ready -> finish_task(success=true, message="${app.displayName} is already running")
3. IF not ready -> launch_app_activity(package_name="${app.appPackage}")
4. wait_for_ui(seconds=5, reason="Wait for ${app.displayName} to load after launching")
5. ${app.feedNavigationHint ? 'Navigate to the video feed as described above, then ' : ''}take_and_analyze_screenshot to verify
6. finish_task with final result

**STOP RULE: Call finish_task when the ${app.feedName} is confirmed ready or if after 10 attempts you can't fix it!**`;

    const ResultSchema = z.object({
      success: z.boolean(),
      message: z.string(),
    });

    try {
      const result = await interactWithScreen<z.infer<typeof ResultSchema>>(
        prompt,
        this.deviceId,
        this.deviceManager,
        {},
        ResultSchema
      );

      if (result.success) {
        logger.info(`✅ [Working] ${app.displayName} is ready: ${result.message}`);
      } else {
        logger.error(`❌ [Working] ${app.displayName} not ready: ${result.message}`);
      }

      return result.success;
    } catch (error) {
      logger.error(`❌ [Working] Error ensuring ${app.displayName} ready:`, error);
      return false;
    }
  }

  /**
   * Check for potential shadow ban by analyzing engagement patterns
   */
  async detectShadowBan(): Promise<boolean> {
    // Simple heuristic: if we've liked 20+ videos but haven't seen any likes register
    if (this.stats.likesGiven >= 20) {
      const prompt = `You are a shadow ban detector. Check if our recent likes are registering properly.

**CRITICAL: YOU MUST CALL finish_task AS YOUR FINAL STEP!**

**Your mission:**
1. take_and_analyze_screenshot(query="Look at the like button - is it highlighted/red showing our like registered?", action="answer_question")  
2. finish_task with analysis

Check if the like button appears active/highlighted (usually red heart) which would indicate our likes are registering.

**STOP RULE: Call finish_task immediately after screenshot analysis!**`;

      const ShadowBanSchema = z.object({
        shadowBanned: z.boolean(),
        reason: z.string(),
        confidence: z.string(),
      });

      try {
        const result = await interactWithScreen<z.infer<typeof ShadowBanSchema>>(
          prompt, 
          this.deviceId, 
          this.deviceManager, 
          {}, 
          ShadowBanSchema
        );
        
        if (result.shadowBanned) {
          logger.warn(`🚫 [Working] Potential shadow ban detected: ${result.reason}`);
          return true;
        }
        
        logger.debug(`✅ [Working] No shadow ban detected: ${result.reason}`);
        return false;
      } catch (error) {
        logger.error(`❌ [Working] Shadow ban detection failed:`, error);
        return false;
      }
    }
    
    return false;
  }

  /**
   * Adaptive delays based on time of day and activity
   */
  private getAdaptiveDelay(baseRange: [number, number]): number {
    const hour = new Date().getHours();
    const [min, max] = baseRange;
    
    // Slower during peak hours (12-18) to seem more human
    const peakMultiplier = (hour >= 12 && hour <= 18) ? 1.5 : 1.0;
    
    // Add some randomness based on current stats to avoid patterns
    const activityMultiplier = 1 + (this.stats.likesGiven * 0.01); // Slower as we do more
    
    const adjustedMin = min * peakMultiplier * activityMultiplier;
    const adjustedMax = max * peakMultiplier * activityMultiplier;
    
    return Math.random() * (adjustedMax - adjustedMin) + adjustedMin;
  }

  /**
   * Execute working stage with automation loop
   */
  async execute(): Promise<z.infer<typeof WorkingResultSchema>> {
    logger.info(`🚀 [Working] Starting automation loop for device: ${this.deviceId}`);
    
    // Step 0: Ensure the app's video feed is ready before automation
    const appReady = await this.ensureAppReady();
    if (!appReady) {
      return {
        success: false,
        videosWatched: 0,
        likesGiven: 0,
        commentsPosted: 0,
        shouldContinue: false,
        message: `Failed to ensure ${this.presets.app.displayName} is ready for automation`,
      };
    }
    
    let shouldContinue = true;
    let consecutiveErrors = 0;
    const {maxConsecutiveErrors} = this.presets.control;
    
    try {
      while (shouldContinue) {
        const success = await this.processVideo();
        
        if (!success) {
          shouldContinue = false;
          break;
        }
        
        // Error handling
        if (this.stats.errors > 0) {
          consecutiveErrors++;
          if (consecutiveErrors >= maxConsecutiveErrors) {
            logger.error(`❌ [Working] Too many consecutive errors (${consecutiveErrors}), stopping`);
            shouldContinue = false;
            break;
          }
        } else {
          consecutiveErrors = 0; // Reset on success
        }
        
        // Log progress every 10 videos with engagement metrics
        if (this.stats.videosWatched % 10 === 0 && this.stats.videosWatched > 0) {
          const sessionDuration = (Date.now() - this.stats.sessionStartTime) / 1000 / 60; // minutes
          const videosPerMinute = (this.stats.videosWatched / sessionDuration).toFixed(1);
          const engagementRate = ((this.stats.likesGiven + this.stats.commentsPosted) / this.stats.videosWatched * 100).toFixed(1);
          
          logger.info(`📊 [Working] Progress: ${this.stats.videosWatched} videos, ${this.stats.likesGiven} likes, ${this.stats.commentsPosted} comments`);
          logger.info(`📈 [Working] Metrics: ${videosPerMinute} videos/min, ${engagementRate}% engagement rate, ${sessionDuration.toFixed(1)}m session`);
        }
      }
      
      // If health check failed too often, prompt retraining
      if (this.healthFailureExceeded) {
        return {
          success: false,
          videosWatched: this.stats.videosWatched,
          likesGiven: this.stats.likesGiven,
          commentsPosted: this.stats.commentsPosted,
          shouldContinue: false,
          message: 'Health check failed 3 times. Delete data/learned-ui-data.json and rerun learning stage.',
        };
      }
      
      return {
        success: true,
        videosWatched: this.stats.videosWatched,
        likesGiven: this.stats.likesGiven,
        commentsPosted: this.stats.commentsPosted,
        shouldContinue,
        message: `Automation completed. Videos: ${this.stats.videosWatched}, Likes: ${this.stats.likesGiven}, Comments: ${this.stats.commentsPosted}`,
      };
      
    } catch (error) {
      logger.error(`❌ [Working] Automation loop failed:`, error);
      return {
        success: false,
        videosWatched: this.stats.videosWatched,
        likesGiven: this.stats.likesGiven,
        commentsPosted: this.stats.commentsPosted,
        shouldContinue: false,
        message: `Automation failed: ${error}`,
      };
    }
  }

  /**
   * Cleanup and disconnect
   */
  async cleanup() {
    try {
      logger.info(`🧹 [Working] Cleaning up automation session`);
      // Could add cleanup logic here if needed
    } catch (error) {
      logger.warn(`⚠️ [Working] Cleanup warning:`, error);
    }
  }
}

/**
 * Direct Working Stage Execution
 */
export async function runWorkingStage(
  deviceId: string, 
  deviceManager: DeviceManager,
  presets: AutomationPresets,
  learnedUI: LearnedUIElements
): Promise<z.infer<typeof WorkingResultSchema>> {
  const stage = new WorkingStage(deviceId, deviceManager, presets, learnedUI);
  
  try {
    return await stage.execute();
  } finally {
    await stage.cleanup();
  }
} 