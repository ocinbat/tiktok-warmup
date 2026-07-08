import { z } from 'zod';

import type { AutomationPresets } from '../config/presets.js';
import type { LearnedUIElements } from '../core/Worker.js';
import { interactWithScreen } from '../tools/interaction.js';
import { findUiElement, type UiTreeNode } from '../tools/uiTree.js';
import { verifyCommentPosted } from '../tools/uiVerify.js';
import { logger } from '../tools/utils.js';

import type { UiElementRole } from '@/config/apps.js';
import type { DeviceManager } from '@/core/DeviceManager.js';

/**
 * Working Stage Result Schema
 */
export const WorkingResultSchema = z.object({
  success: z.boolean(),
  videosWatched: z.number(),
  likesGiven: z.number(),
  commentsPosted: z.number(),
  followsGiven: z.number(),
  shouldContinue: z.boolean(),
  message: z.string(),
});

/**
 * Niche-follow analysis — read-only judgement of the CURRENT creator. The bot
 * follows only creators that match BOTH the target niche and language and that
 * we do not already follow.
 */
export const NicheFollowAnalysisSchema = z.object({
  screenLooksLikeNormalFeed: z.boolean().describe('true if this is a normal full-screen feed video (NOT a shop, profile page, ad, popup, DM, search, etc.)'),
  matchesNiche: z.boolean().describe('true ONLY if the video/creator is clearly about the target niche'),
  isTargetLanguage: z.boolean().describe('true ONLY if the creator/content is primarily in the target language'),
  followButtonText: z.string().describe('The EXACT text shown on the follow button/control, copied verbatim (e.g. "Takip Et", "Takip", "Follow", "Following"). Use "" only if there is genuinely no follow button or you cannot read it.'),
  alreadyFollowing: z.boolean().describe('true if we ALREADY follow this creator. Decide from followButtonText: "Takip Et"/"Follow" = NOT following; bare "Takip"/"Takip Ediliyor"/"Following" = already following.'),
  creatorNote: z.string().describe('short note: creator handle/username and what the video is about'),
  confidence: z.string().describe('Confidence level: high/medium/low'),
});

/**
 * Decide follow state from the EXACT follow-button text. Handles the Turkish
 * trap where "Takip Et" (NOT following) contains "Takip" (already following), so
 * a naive substring check would get it backwards. Returns true = already
 * following, false = not following, undefined = couldn't tell (trust the model).
 */
export function interpretFollowState(buttonText: string | undefined): boolean | undefined {
  const t = (buttonText ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  // "Already following" forms first, so "Following" isn't caught by the "follow" check.
  if (t.includes('following') || t.includes('ediliyor')) return true;
  // "Not following" forms — check "takip et"/"takip edin" BEFORE the bare "takip"
  // below. "Takip Edin" is TikTok's follow-control label (accessibility desc like
  // "PoolDaily Takip Edin"), the plural-imperative of "Takip Et" — both mean NOT
  // following, and "takip et" as a substring does NOT cover "takip edin"
  // (et ≠ ed…), so it needs its own check.
  if (t.includes('takip et') || t.includes('takip edin') || /\bfollow\b/.test(t)) return false;
  // The bare word "takip" (no "et") is Instagram's compact "already following" label.
  if (t.includes('takip')) return true;
  return undefined;
}

/** Result of a follow attempt. */
export const FollowActionSchema = z.object({
  followed: z.boolean().describe('true ONLY if the follow was confirmed (control changed to the followed state)'),
  note: z.string().optional().describe('short note about what happened'),
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
  videoLanguage: z.string().describe("Primary language of the video's speech / caption / on-screen text (e.g. Turkish, English, Spanish), or 'none' if it has no language-specific content (purely visual/music)."),
  videoLanguageMatchesTarget: z.boolean().describe('true if the video is primarily in the TARGET comment language, OR has no language-specific content (purely visual/music); false if it is primarily in a DIFFERENT language.'),
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
    followsGiven: 0,
    errors: 0,
    sessionStartTime: Date.now(),
    lastActivityTime: Date.now(),
  };
  private healthFailures = 0;
  private healthFailureExceeded = false;
  /** Logged once when the per-session follow cap is hit, to avoid spamming. */
  private followLimitLogged = false;

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
   * Resolve one of the app's declared UI roles from the LIVE view hierarchy.
   * Pixel-perfect and free where vision is a paid, biased guess. Null on any
   * miss (no selector, dump unusable, element not on screen) — callers fall
   * back to the learned coordinate / vision path, so this only ever helps.
   */
  private async findXmlElement(role: UiElementRole): Promise<UiTreeNode | null> {
    const selector = this.presets.app.xmlSelectors[role];
    if (!selector) return null;
    try {
      const xml = await this.deviceManager.dumpViewHierarchy(this.deviceId);
      if (!xml) return null;
      return findUiElement(xml, selector);
    } catch (error) {
      logger.debug(`[Working] XML lookup for "${role}" failed (non-fatal):`, error);
      return null;
    }
  }

  /**
   * Resolve where to tap for a role: the live view hierarchy first (exact,
   * current), then the coordinate learned during the learning stage. Null when
   * neither source has it.
   */
  private async resolveTapTarget(
    role: UiElementRole,
    learned: { x: number; y: number } | undefined,
  ): Promise<{ x: number; y: number; source: 'uiautomator' | 'learned' } | null> {
    const element = await this.findXmlElement(role);
    if (element?.center) {
      return { x: element.center.x, y: element.center.y, source: 'uiautomator' };
    }
    if (learned) {
      return { x: learned.x, y: learned.y, source: 'learned' };
    }
    return null;
  }

  /**
   * Build the action(s) for this video. The like/comment dice are rolled by the
   * caller (processVideo) so it can run the feed guard BEFORE we generate a
   * comment — otherwise a recovery mid-cycle could post a comment written for the
   * previous video onto a new one.
   */
  async decideAction(doLike: boolean, doComment: boolean): Promise<Array<z.infer<typeof ActionDecisionSchema>>> {
    const decisions: Array<z.infer<typeof ActionDecisionSchema>> = [];

    // Like decision
    if (doLike) {
      decisions.push({
        action: 'like',
        reason: `Like roll passed (chance ${this.presets.interactions.likeChance})`,
      });
    }

    // Comment decision
    if (doComment) {
      let commentText: string;
      if (this.presets.comments.useAI) {
        try {
          const { language, maxLength } = this.presets.comments;
          const appName = this.presets.app.displayName;
          const prompt = `You are an advanced ${appName} comment generator. Create natural, engaging comments that match the video's tone and content.

**LANGUAGE: Write the comment in ${language}. Use casual, native-sounding ${language} the way real ${language} speakers comment on ${appName}. Do NOT use any other language.**

**LANGUAGE MATCH (IMPORTANT): We ONLY comment on videos that are in ${language} (or have no spoken/written language at all, e.g. pure music/visuals). First detect the video's primary language from its speech, caption and on-screen text. If the video is primarily in a DIFFERENT language than ${language}, set videoLanguageMatchesTarget=false — the comment will be SKIPPED, so do not worry about its quality in that case. Set videoLanguageMatchesTarget=true only when the video is in ${language} or is language-neutral.**

**CRITICAL: YOU MUST CALL finish_task AS YOUR FINAL STEP!**

**Your workflow:**
1. take_and_analyze_screenshot(query="Analyze this ${appName} video: (a) the PRIMARY language of its speech/caption/on-screen text (or 'none' if purely visual/music), and (b) the main subject, mood/tone, and what engagement fits.", action="answer_question")
2. Set videoLanguage and videoLanguageMatchesTarget (target language is ${language}). If it matches, generate a contextually perfect comment in ${language}; if not, you may leave a short placeholder (it will be skipped).
3. finish_task with videoLanguage, videoLanguageMatchesTarget, the comment, confidence, and reasoning

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
          // Don't comment on videos whose language doesn't match our comment
          // language (e.g. writing Turkish on unrelated foreign content). Skip
          // the comment and move on; a separately-rolled like (if any) still stands.
          if (this.presets.comments.requireLanguageMatch && !result.videoLanguageMatchesTarget) {
            logger.info(`⏭️ [Working] Skipping comment — video language "${result.videoLanguage}" ≠ comment language "${language}"`);
            return decisions.length > 0
              ? decisions
              : [{ action: 'next_video', reason: `Video language "${result.videoLanguage}" does not match comment language "${language}"` }];
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
        reason: `Comment roll passed (chance ${this.presets.interactions.commentChance})`,
        commentText,
      });
    }

    // If no actions, skip
    if (decisions.length === 0) {
      decisions.push({
        action: 'next_video',
        reason: 'No like/comment rolled for this video',
      });
    }

    return decisions;
  }

  /**
   * Execute like action
   */
  async executeLike(): Promise<boolean> {
    try {
      // The live view hierarchy first (the heart's exact bounds on THIS video),
      // then the coordinate the learning stage PROVED toggles the like.
      const target = await this.resolveTapTarget('likeButton', this.learnedUI.likeButton);
      if (!target) {
        logger.error(`❌ [Working] Like button not found (no XML match, no learned coordinate)`);
        return false;
      }

      logger.info(`❤️ [Working] Liking video at (${target.x}, ${target.y}) [${target.source}]`);
      await this.deviceManager.tapScreen(this.deviceId, target.x, target.y);
      await this.wait(1, 'After like tap');
      this.stats.likesGiven++;

      // Verify for visibility/logging ONLY. We do NOT re-tap on a negative
      // reading: the like is a TOGGLE, so a retap driven by a flaky reading would
      // UNDO a like that actually registered. Ground truth first: the like
      // control's accessibility label flips to "…vazgeç"/"Unlike" when liked —
      // read it from the view hierarchy for free; vision only when XML can't say.
      try {
        const { likedStateDescRegex } = this.presets.app;
        const likeNode = likedStateDescRegex ? await this.findXmlElement('likeButton') : null;
        let liked: boolean;
        let via: string;
        if (likeNode && likedStateDescRegex) {
          // Liked state shows either in the label ("…vazgeç"/"Unlike" — TikTok)
          // or in Android's selected flag (Instagram keeps the label "Beğen" and
          // flips selected="true").
          liked = likeNode.selected || new RegExp(likedStateDescRegex, 'iu').test(likeNode.contentDesc || likeNode.text);
          via = 'uiautomator';
          // Raw evidence for debugging like-verification false negatives.
          logger.info(`🔬 [Working] Like node after tap: selected=${likeNode.selected} desc="${likeNode.contentDesc}" text="${likeNode.text}" → liked=${liked}`);
        } else {
          liked = (await this.takeAndAnalyzeScreenshot(
            `Look at the like button (the heart icon on the right side of the video). Is it now in the LIKED state — filled/solid and red/colored — rather than an empty outline? Answer YES or NO.`
          )).toUpperCase().includes('YES');
          via = 'vision';
        }
        if (liked) {
          logger.info(`❤️ [Working] Like confirmed registered (via ${via})`);
        } else {
          logger.warn(`⚠️ [Working] Like tap done but could not confirm it registered (via ${via}) — if this persists, delete data/learned-ui-data.json and re-learn.`);
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
      // Each role needs SOME coordinate source: a live XML selector or the
      // coordinate learned during the learning stage (resolved per-tap below).
      const canResolve = (role: UiElementRole, learned?: { x: number; y: number }): boolean =>
        Boolean(learned || this.presets.app.xmlSelectors[role]);
      if (
        !canResolve('commentButton', this.learnedUI.commentButton) ||
        !canResolve('commentInputField', this.learnedUI.commentInputField) ||
        !canResolve('commentSendButton', this.learnedUI.commentSendButton)
      ) {
        logger.error(`❌ [Working] Comment UI coordinates not fully learned (and no XML selectors to fall back on)`);
        return false;
      }

      // Split the wait budget: the long "settle" wait is only needed where the UI
      // genuinely lags (panel/keyboard appearing, text registering, post landing);
      // navigation taps and back-presses settle much faster. This cuts the comment
      // flow roughly in half without truncating on a slow phone. settleWait is
      // tuned per-device via COMMENT_STEP_WAIT_S; navWait is derived from it.
      const settleWait = Number(process.env.COMMENT_STEP_WAIT_S) || 4;
      const navWait = Math.max(1.5, settleWait * 0.5);

      logger.info(`💬 [Working] Commenting: "${commentText}" (settle ${settleWait}s / nav ${navWait}s)`);

      // Step 1: Click comment button (live XML bounds first, learned coordinate second)
      const commentBtn = await this.resolveTapTarget('commentButton', this.learnedUI.commentButton);
      if (!commentBtn) {
        logger.error(`❌ [Working] Comment button not found on this screen`);
        return false;
      }
      logger.info(`💬 [Working] Tapping comment button at (${commentBtn.x}, ${commentBtn.y}) [${commentBtn.source}]`);
      await this.deviceManager.tapScreen(this.deviceId, commentBtn.x, commentBtn.y);
      await this.wait(settleWait, 'After comment button tap (panel opening)');

      // Step 1b: Make sure the comment panel actually opened. Some videos have
      // comments turned off (the comment button is disabled and does nothing),
      // which would otherwise send the agent looking for an input/send button
      // that isn't there and loop until the step limit. Ground truth first: the
      // composer input showing up in the view hierarchy IS the panel being open;
      // ask vision only when XML can't see it.
      let panelOpen = Boolean(await this.findXmlElement('commentInputField'));
      if (!panelOpen) {
        const panelState = (await this.takeAndAnalyzeScreenshot(
          `Did the comment section open? If a comment panel/sheet with a text input box to write a comment is now visible, answer exactly OPEN. If comments are turned off/disabled for this video (e.g. a message like "Comments are turned off", or no comment input is available), answer exactly DISABLED.`
        )).toUpperCase();
        panelOpen = panelState.includes('OPEN');
      }
      if (!panelOpen) {
        logger.warn(`⚠️ [Working] Comment panel did not open (comments likely disabled); skipping comment for this video`);
        await this.deviceManager.pressKey(this.deviceId, 'back');
        await this.wait(navWait, 'After dismissing closed comment panel');
        return false;
      }

      // Step 2: Click input field (live XML bounds track the panel's actual
      // position — the learned coordinate can drift with keyboard/panel layout)
      const input = await this.resolveTapTarget('commentInputField', this.learnedUI.commentInputField);
      if (!input) {
        logger.warn(`⚠️ [Working] Comment input field not found; closing panel`);
        await this.deviceManager.pressKey(this.deviceId, 'back');
        await this.wait(navWait, 'After dismissing comment panel');
        return false;
      }
      logger.info(`💬 [Working] Tapping comment input at (${input.x}, ${input.y}) [${input.source}]`);
      await this.deviceManager.tapScreen(this.deviceId, input.x, input.y);
      await this.wait(settleWait, 'After input field tap (let keyboard settle)');

      // Step 3: Type comment text
      await this.deviceManager.inputText(this.deviceId, commentText);
      await this.wait(settleWait, 'After typing comment');

      // Confirm the comment actually shows up as a POSTED comment (not just text
      // sitting in the input box). Objective view-hierarchy check first; vision
      // yes/no only when uiautomator is unavailable (FLAG_SECURE / obfuscated /
      // virtualized list) — same signal the learning stage now uses.
      const verifyPosted = async (): Promise<boolean> => {
        await this.wait(settleWait, 'Waiting for comment to post');
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

      // Step 5a: Submit. The send control only appears once text is in the box,
      // so resolve it NOW: live XML bounds (Instagram exposes a stable id; on
      // TikTok it's obfuscated so this resolves to the learned coordinate).
      const send = await this.resolveTapTarget('commentSendButton', this.learnedUI.commentSendButton);
      let posted = false;
      if (send) {
        logger.info(`💬 [Working] Tapping send at (${send.x}, ${send.y}) [${send.source}]`);
        await this.deviceManager.tapScreen(this.deviceId, send.x, send.y);
        posted = await verifyPosted();
      } else {
        logger.warn(`⚠️ [Working] Send button not resolvable from XML or learned data; going straight to the visual fallback`);
      }

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
      await this.wait(navWait, 'After back (close keyboard/panel)');
      await this.deviceManager.pressKey(this.deviceId, 'back');
      await this.wait(navWait, 'After back (close comment panel)');

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
   * Niche-follow scan — independent of like/comment. On a FOLLOW_CHANCE roll,
   * analyze the CURRENT creator and, if it's a target-niche + target-language
   * channel we don't already follow, follow it. Kept conservative with a
   * per-session cap because following many accounts quickly is a strong ban
   * signal. Runs on the clean feed BEFORE like/comment (which open/close panels).
   */
  async maybeFollowCreator(): Promise<void> {
    const { follow, app } = this.presets;
    // Disabled, or this app has no follow control configured. (The decision of
    // WHEN to scan — per-video chance or on-like — is made by the caller.)
    if (!follow.enabled || !app.followButtonHint) return;

    // Safety cap for the session.
    if (this.stats.followsGiven >= follow.dailyLimit) {
      if (!this.followLimitLogged) {
        logger.info(`🛑 [Working] Follow cap reached (${follow.dailyLimit}); no more follows this session`);
        this.followLimitLogged = true;
      }
      return;
    }

    try {
      logger.info(`🔎 [Working] Niche-follow scan (niche="${follow.niche}", language=${follow.language})`);
      const analysis = await this.analyzeForNicheFollow();
      // Follow state, most reliable source first:
      // 1. The follow control's OWN text/label read from the view hierarchy
      //    (ground truth — Instagram's button text, TikTok's badge desc).
      // 2. The exact button text the vision model transcribed.
      // 3. The model's boolean (it keeps misreading "Takip Et" as "Takip").
      const xmlFollowNode = await this.findXmlElement('followButton');
      const xmlButtonText = xmlFollowNode ? (xmlFollowNode.text || xmlFollowNode.contentDesc) : undefined;
      const interpreted = interpretFollowState(xmlButtonText) ?? interpretFollowState(analysis.followButtonText);
      const alreadyFollowing = interpreted ?? analysis.alreadyFollowing;
      const stateSource = interpretFollowState(xmlButtonText) !== undefined
        ? 'uiautomator'
        : interpreted !== undefined ? 'button text' : 'model';
      logger.info(
        `🔎 [Working] Follow scan: niche=${analysis.matchesNiche} lang=${analysis.isTargetLanguage} ` +
          `button="${xmlButtonText ?? analysis.followButtonText}" alreadyFollowing=${alreadyFollowing} (${stateSource}) ` +
          `normalFeed=${analysis.screenLooksLikeNormalFeed} (${analysis.confidence}) — ${analysis.creatorNote}`,
      );

      if (!analysis.screenLooksLikeNormalFeed) return;
      if (!analysis.matchesNiche || !analysis.isTargetLanguage) return;
      if (alreadyFollowing) {
        logger.info(`➡️ [Working] Already following this ${follow.language} ${follow.niche.split(' ')[0]} creator (button="${analysis.followButtonText}"); skipping`);
        return;
      }

      const followed = await this.executeFollow();
      if (followed) {
        this.stats.followsGiven++;
        logger.info(`➕ [Working] Followed creator (${this.stats.followsGiven}/${follow.dailyLimit} this session): ${analysis.creatorNote}`);
      } else {
        logger.warn(`⚠️ [Working] Follow attempt not confirmed; leaving as-is`);
      }
    } catch (error) {
      // A follow scan must never break the main loop.
      logger.warn(`⚠️ [Working] Niche-follow scan failed (non-fatal):`, error);
    }
  }

  /**
   * Read-only analysis of the current creator for the niche-follow decision.
   */
  private async analyzeForNicheFollow(): Promise<z.infer<typeof NicheFollowAnalysisSchema>> {
    const { follow, app } = this.presets;
    const prompt = `You are a ${app.displayName} audience-growth analyst. Decide whether we should FOLLOW the creator of the CURRENT video.

We follow a creator ONLY when BOTH are true:
  • the video/creator is about this niche: ${follow.niche}
  • the content is primarily in this language: ${follow.language}
…and we do NOT already follow them.

**CRITICAL: YOU MUST CALL finish_task AS YOUR FINAL STEP!**

**Workflow (use take_and_analyze_screenshot with ONE query per call; do NOT tap anything — this is analysis only):**
1. take_and_analyze_screenshot(query="Describe this ${app.displayName} video: its main topic/niche, the language of the caption / on-screen text / speech, and the creator's username/handle.", action="answer_question")
2. take_and_analyze_screenshot(query="Find the follow button/control for this creator and read its text. Report the EXACT text on it, copied letter-for-letter (for example: Takip Et, Takip, Follow, or Following).", action="answer_question")
3. finish_task with all fields filled in.

**RULES:**
- matchesNiche = true ONLY if the video is clearly about: ${follow.niche}.
- isTargetLanguage = true ONLY if the caption / speech / handle are primarily ${follow.language}.
- followButtonText = the exact text you read on the follow button in step 2, copied verbatim.
- alreadyFollowing: ${app.followStateHint}
- When unsure, set matchesNiche / isTargetLanguage to FALSE — do NOT follow when in doubt.

**STOP RULE: Call finish_task once you have looked at the video content and the follow button text.**`;

    return interactWithScreen<z.infer<typeof NicheFollowAnalysisSchema>>(
      prompt,
      this.deviceId,
      this.deviceManager,
      {},
      NicheFollowAnalysisSchema,
    );
  }

  /**
   * Tap the follow control for the current creator and confirm the state changed.
   * Deterministic path first: the follow control's live bounds + state from the
   * view hierarchy (tap center, re-read to confirm). Falls back to the vision
   * agent when the hierarchy can't resolve it.
   */
  private async executeFollow(): Promise<boolean> {
    const xmlResult = await this.executeFollowViaXml();
    if (xmlResult !== undefined) return xmlResult;
    return this.executeFollowViaAgent();
  }

  /**
   * XML-deterministic follow. Returns:
   * - true/false → handled here (tapped and confirmed / tapped but unconfirmed)
   * - undefined  → hierarchy can't resolve the control; use the vision agent.
   * Confirmation after the tap: Instagram's button text flips to the followed
   * form ("Takip"/"Following"); TikTok's red + badge node DISAPPEARS entirely.
   */
  private async executeFollowViaXml(): Promise<boolean | undefined> {
    const before = await this.findXmlElement('followButton');
    if (!before?.center) return undefined;

    const beforeState = interpretFollowState(before.text || before.contentDesc);
    if (beforeState === true) {
      // Already following — do NOT tap (it would unfollow).
      logger.info(`➡️ [Working] Follow control already in followed state (via uiautomator); not tapping`);
      return true;
    }

    logger.info(`➕ [Working] Tapping follow at (${before.center.x}, ${before.center.y}) [uiautomator, "${before.text || before.contentDesc}"]`);
    await this.deviceManager.tapScreen(this.deviceId, before.center.x, before.center.y);
    await this.wait(2, 'After follow tap');

    try {
      const xml = await this.deviceManager.dumpViewHierarchy(this.deviceId);
      if (!xml) {
        // Dump went unusable right after a deterministic tap on a control we had
        // POSITIVELY read as not-followed — count it as done rather than risking
        // an agent retap that would unfollow.
        logger.info(`➕ [Working] Follow tapped; post-tap hierarchy unavailable, assuming it registered`);
        return true;
      }

      // MUST end on the feed (the agent flow guaranteed this too). If the feed
      // marker vanished, the tap most likely opened the creator's PROFILE page
      // (on TikTok the + badge hugs the avatar's bottom edge) — the follow did
      // NOT happen; press back to the feed and report failure.
      const markerSelector = this.presets.app.xmlSelectors.feedMarker;
      if (markerSelector && !findUiElement(xml, markerSelector)) {
        logger.warn(`⚠️ [Working] Left the ${this.presets.app.feedName} after the follow tap (profile page likely opened); pressing back`);
        await this.deviceManager.pressKey(this.deviceId, 'back');
        await this.wait(1.5, 'After back (recover from profile page)');
        return false;
      }

      const selector = this.presets.app.xmlSelectors.followButton;
      const after = selector ? findUiElement(xml, selector) : null;
      if (!after) return true; // TikTok: the + badge is gone → followed
      const afterState = interpretFollowState(after.text || after.contentDesc);
      if (afterState === true) return true; // Instagram: text flipped → followed
      logger.warn(`⚠️ [Working] Follow control still reads "${after.text || after.contentDesc}" after the tap`);
      return false;
    } catch (error) {
      logger.debug(`[Working] Post-follow verification failed (non-fatal):`, error);
      return true;
    }
  }

  /** Vision-agent follow — the fallback when the view hierarchy can't resolve the control. */
  private async executeFollowViaAgent(): Promise<boolean> {
    const { app } = this.presets;
    const prompt = `You are a ${app.displayName} automation agent. FOLLOW the creator of the CURRENT video, then confirm it.

${app.followButtonHint}

**CRITICAL: YOU MUST CALL finish_task AS YOUR FINAL STEP!**

**Steps:**
1. First READ the follow control's text. ${app.followStateHint}
   - If it already shows the ALREADY-FOLLOWING state, do NOT tap it (tapping would UNFOLLOW). Skip to step 4 with followed=true.
   - Only if it shows the NOT-FOLLOWING state, tap_element(query="the follow button that reads the NOT-following text — ${app.followButtonHint}") ONCE. Do NOT tap the avatar photo / username (that opens the profile page).
2. take_and_analyze_screenshot(query="Read the follow button text again now. ${app.followStateHint} Also: are we still on the normal full-screen video feed (not a profile page)?", action="answer_question")
3. **RECOVERY — REQUIRED:** if you are NOT on the normal video feed anymore (e.g. a profile page opened, or any other screen), pressKey(keycode="back") — repeat up to twice — until you are back on the full-screen video feed. You MUST end on the feed.
4. finish_task with followed=true ONLY if the button now shows the already-following state (it changed after your tap, OR it already was following before); otherwise followed=false.

**STOP RULE: Always finish on the video feed, then call finish_task with the followed boolean.**`;

    const result = await interactWithScreen<z.infer<typeof FollowActionSchema>>(
      prompt,
      this.deviceId,
      this.deviceManager,
      {},
      FollowActionSchema,
    );
    return result.followed;
  }

  /**
   * Scroll to next video
   */
  async scrollToNextVideo(): Promise<boolean> {
    try {
      // Get actual screen size for more precise scrolling
      const screenSize = await this.deviceManager.getScreenSize(this.deviceId);
      const centerX = Math.floor(screenSize.width / 2);
      const { startYFraction, endYFraction, durationMs } = this.presets.swipe;
      const startY = Math.floor(screenSize.height * startYFraction);
      const endY = Math.floor(screenSize.height * endYFraction);
      const travelPct = Math.round((startYFraction - endYFraction) * 100);

      logger.info(`📱 [Working] Sonraki videoya geçiliyor — swipe ${travelPct}% mesafe, ${durationMs}ms`);
      await this.deviceManager.swipeScreen(this.deviceId, centerX, startY, centerX, endY, durationMs);

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
   * Watch current video for the configured duration. Returns how long it watched
   * and which mode was used, so the caller can log a per-video summary. Logs the
   * duration at INFO (before the wait) so it's visible in a normal run, not just
   * with --debug.
   */
  async watchVideo(): Promise<{ seconds: number; mode: 'quick-skip' | 'normal' }> {
    const videoNo = this.stats.videosWatched + 1;
    // Roll dice for quick skip (1 in 5 videos)
    const skipRoll = Math.random();

    if (skipRoll < this.presets.video.quickSkipChance) {
      // Quick skip - watch for just 1 second
      const seconds = this.presets.video.quickSkipDuration;
      logger.info(`👀 [Working] Video #${videoNo}: hızlı geçiş — ${seconds}s izleniyor`);
      await this.wait(seconds, 'Quick skip viewing');
      return { seconds, mode: 'quick-skip' };
    }

    // Normal watch duration
    const seconds = this.getAdaptiveDelay(this.presets.video.watchDuration);
    logger.info(`👀 [Working] Video #${videoNo}: normal — ${seconds.toFixed(1)}s izleniyor`);
    await this.wait(seconds, 'Normal video viewing');
    return { seconds, mode: 'normal' };
  }

  /**
   * Execute single video automation cycle
   */
  async processVideo(): Promise<boolean> {
    try {
      const videoNo = this.stats.videosWatched + 1;
      logger.info(`🎬 [Working] Processing video #${videoNo}`);

      // Step 1: Watch video (skip waiting on first video). Track how long we
      // watched and in which mode so we can print a per-video summary at the end.
      let watchSeconds = 0;
      let watchMode: 'first' | 'quick-skip' | 'normal' = 'first';
      if (this.stats.videosWatched === 0) {
        logger.info(`⚡ [Working] First video - starting immediately without watching delay`);
      } else {
        const watched = await this.watchVideo();
        watchSeconds = watched.seconds;
        watchMode = watched.mode;
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
      
      // Step 2.4: Periodic lightweight feed guard (app-tuned; e.g. Instagram
      // every 12 videos, TikTok off). Catches drift off the feed between the
      // rare full health checks and recovers back to the feed.
      const { feedCheckInterval } = this.presets.app;
      if (feedCheckInterval > 0 && this.stats.videosWatched > 0 && this.stats.videosWatched % feedCheckInterval === 0) {
        await this.ensureOnFeedOrRecover('periodic check');
        if (this.healthFailureExceeded) return false;
      }

      // Step 3: Roll the like/comment dice first (cheap). We need doLike BEFORE the
      // follow decision so we can also follow-scan every video we LIKE.
      let doLike = Math.random() < this.presets.interactions.likeChance;
      let doComment = Math.random() < this.presets.interactions.commentChance;

      // Step 3b: For apps that drift (Instagram), confirm we're on the feed BEFORE
      // comment generation, tapping, or a follow scan — so we never blind-tap the
      // wrong screen and never post a comment meant for a different video. If
      // recovery fails, skip acting this round.
      if (this.presets.app.guardBeforeActions && (doLike || doComment)) {
        const onFeed = await this.ensureOnFeedOrRecover('pre-action');
        if (!onFeed) {
          doLike = false;
          doComment = false;
          if (this.healthFailureExceeded) return false;
        }
      }

      // Step 3c: Niche-follow scan on the clean feed (BEFORE like/comment, which
      // open/close panels and move the avatar). Triggered by the independent
      // per-video probability OR — when enabled — on every video we LIKE, so an
      // engaged video always gets a follow check.
      const { follow } = this.presets;
      if (follow.enabled && (Math.random() < follow.chance || (doLike && follow.scanOnLike))) {
        await this.maybeFollowCreator();
      }

      // Step 4: Decide actions and scroll to next video
      const decisions = await this.decideAction(doLike, doComment);
      logger.info(`🎯 [Working] Decided to do ${decisions.length} actions: ${decisions.map(d => d.action).join(', ')}`);
      const executed: string[] = []; // human-readable list of actions actually taken, for the summary
      for (const decision of decisions) {
        logger.info(`🎯 [Working] Action decision: ${decision.action} - ${decision.reason}`);
        switch (decision.action) {
          case 'like': {
            const ok = await this.executeLike();
            executed.push(ok ? 'like✓' : 'like✗');
            break;
          }
          case 'comment':
            if (decision.commentText) {
              const ok = await this.executeComment(decision.commentText);
              executed.push(ok ? `comment✓("${decision.commentText}")` : 'comment✗');
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

      // Per-video summary: how long we watched and what we actually did. INFO so
      // it shows in a normal run (a quick, at-a-glance line per video).
      const actionSummary = executed.length > 0 ? executed.join(', ') : 'yok (sadece izleme)';
      const watchLabel = watchMode === 'first' ? 'ilk video (bekleme yok)' : `${watchSeconds.toFixed(1)}s (${watchMode})`;
      logger.info(`🧾 [Working] Video #${videoNo} özeti — izleme: ${watchLabel}, aksiyon: ${actionSummary}`);

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

      // NOTE: the healthFailures counter is owned by the CALLER (processVideo /
      // ensureOnFeedOrRecover). Don't increment it here too — doing both used to
      // double-count a single failure and trip the re-learn limit early.
      return result.success;
    } catch (error) {
      logger.error(`❌ [Working] Health check error:`, error);
      return false;
    }
  }

  /**
   * Decide "are we on the video feed?" from ONE view-hierarchy dump.
   * true/false = certain; undefined = the hierarchy can't tell (ask vision).
   * SPONSORED reels swap the player container id, so the feed marker alone
   * misses ads — the like/comment action rail (whose selectors only match the
   * video feed, not e.g. Instagram Home's row_feed_* buttons) also counts as
   * proof. Without this, every periodic check landing on an ad stalls ~30s in
   * the vision fallback.
   */
  private isFeedXml(xml: string): boolean | undefined {
    const selectors = this.presets.app.xmlSelectors;
    if (!xml || !selectors.feedMarker) return undefined;
    if (findUiElement(xml, selectors.feedMarker)) {
      logger.info(`🔬 [Working] Feed check: ON feed (marker)`);
      return true;
    }
    if (selectors.likeButton && findUiElement(xml, selectors.likeButton)) {
      logger.info(`🔬 [Working] Feed check: ON feed (action rail — sponsored/variant layout, no marker)`);
      return true;
    }
    if (selectors.commentButton && findUiElement(xml, selectors.commentButton)) {
      logger.info(`🔬 [Working] Feed check: ON feed (comment rail — sponsored/variant layout, no marker)`);
      return true;
    }
    // No player, no action rail — but the app's own nav bar is visible: we're
    // inside the app on some other screen (Home, DMs, profile) → off the feed.
    if (selectors.feedTab && findUiElement(xml, selectors.feedTab)) {
      logger.info(`🔬 [Working] Feed check: OFF feed (nav bar visible, no player/rail)`);
      return false;
    }
    logger.info(`🔬 [Working] Feed check: UNKNOWN from XML → vision decides`);
    return undefined;
  }

  /**
   * isFeedXml over a fresh dump. undefined when the dump is unusable. A video
   * feed is constant animation, so uiautomator's "could not get idle state"
   * empty dump is a routine transient — retry once before giving up, otherwise
   * every transient failure cascades into a ~30s vision check / agent recovery.
   */
  private async isOnFeedViaXml(): Promise<boolean | undefined> {
    try {
      let xml = await this.deviceManager.dumpViewHierarchy(this.deviceId);
      if (!xml) {
        await this.wait(1, 'Retry view-hierarchy dump (transient idle-state failure)');
        xml = await this.deviceManager.dumpViewHierarchy(this.deviceId);
      }
      return this.isFeedXml(xml);
    } catch (error) {
      logger.debug(`[Working] isOnFeedViaXml failed (non-fatal):`, error);
      return undefined;
    }
  }

  /**
   * Fast check: are we on the normal video feed right now? Ground truth first —
   * the view hierarchy (feed marker OR the like/comment action rail; see
   * isFeedXml) — then vision only when the hierarchy can't decide. Much
   * cheaper than performHealthCheck.
   */
  private async isOnFeed(): Promise<boolean> {
    const xmlAnswer = await this.isOnFeedViaXml();
    if (xmlAnswer === true) {
      logger.debug(`[Working] On the ${this.presets.app.feedName} (via uiautomator)`);
      return true;
    }
    if (xmlAnswer === false) {
      logger.info(`🌳 [Working] Off the ${this.presets.app.feedName}: app nav bar visible but no feed marker/action rail (via uiautomator)`);
      return false;
    }

    const { app } = this.presets;
    const answer = (await this.takeAndAnalyzeScreenshot(
      `Are we on the normal ${app.displayName} ${app.feedName} RIGHT NOW — a FULL-SCREEN vertical video with like/comment icons stacked on the right side? Answer exactly "YES". ` +
        `If instead this is the home timeline (a scrollable list/grid of photo posts), a DM/inbox/chat screen, a profile page, search, a shop, an ad, a popup, or any other screen, answer exactly "NO".`,
    )).toUpperCase();
    return answer.includes('YES') && !answer.includes('NO');
  }

  /**
   * Deterministic feed navigation: if the feed marker is already in the view
   * hierarchy we're done; else find the app's feed TAB (IG: Reels tab by
   * resource-id; TikTok: Home by label), tap its exact center, and confirm the
   * marker appeared. This is THE fix for "the agent can't hit the Reels tab":
   * no vision, no guessing, no y-bias. False → the caller runs its heavier
   * (agent-driven) recovery.
   */
  private async tryNavigateToFeedViaXml(context: string): Promise<boolean> {
    // Full feed detection (marker OR action rail — ads lack the marker), not
    // just the marker, both before and after the tab tap.
    if (await this.isOnFeedViaXml() === true) return true;
    const tab = await this.findXmlElement('feedTab');
    if (!tab?.center) return false;

    logger.info(`🌳 [Working] Tapping the ${this.presets.app.feedName} tab at (${tab.center.x}, ${tab.center.y}) [uiautomator, ${context}]`);
    await this.deviceManager.tapScreen(this.deviceId, tab.center.x, tab.center.y);
    await this.wait(2.5, 'After feed tab tap');

    if (await this.isOnFeedViaXml() === true) {
      logger.info(`✅ [Working] Reached the ${this.presets.app.feedName} deterministically (${context})`);
      return true;
    }
    return false;
  }

  /**
   * Get back to the video feed: close whatever wrong screen we're on (DM, profile,
   * popup, home timeline…), navigate to the feed via the app's nav hint, and fall
   * back to a cold restart if needed. Returns true only if it ends on the feed.
   */
  private async recoverToFeed(): Promise<boolean> {
    // Deterministic first: the common drift case is "sitting on another tab of
    // the app" — one exact tap on the feed tab fixes it without any LLM.
    if (await this.tryNavigateToFeedViaXml('recovery')) return true;

    const { app } = this.presets;
    const prompt = `You are a ${app.displayName} automation agent. Get BACK to the normal ${app.feedName} (full-screen vertical video feed) as quickly as possible.

**CRITICAL: YOU MUST CALL finish_task AS YOUR FINAL STEP (max 8 steps)!**

**Flow:**
1. take_and_analyze_screenshot(query="What screen is this? Is it the normal ${app.feedName} (full-screen vertical video with like/comment on the right)? Or the home timeline, a DM/inbox/chat, a profile page, search, a shop, an ad, or a popup?", action="answer_question")
2. If it IS the ${app.feedName} → finish_task(recovered=true).
3. If a DM/inbox/chat/profile/post/search/popup/ad is open → CLOSE it: pressKey(keycode="back") (or tap an X/close button), then take another screenshot.
4. ${app.feedNavigationHint ? `Reach the feed: ${app.feedNavigationHint}` : 'Make sure the full-screen video feed is showing.'}
5. If still not on the feed after a couple of tries → terminateApp(packageName="${app.appPackage}"), then launchApp(packageName="${app.appPackage}"), wait, then ${app.feedNavigationHint ? 'navigate to the feed as above' : 'the feed should show'}.
6. Verify with a screenshot, then finish_task.

**HARD RULES:**
- NEVER tap random/guessed coordinates to "explore" — only use back, the navigation described above, or an app restart. Random taps open other apps and make it worse.
- recovered=true ONLY if the FINAL screenshot clearly shows the normal ${app.feedName}.

**STOP RULE: Call finish_task with recovered (true/false) after at most 8 steps.**`;

    const RecoverSchema = z.object({
      recovered: z.boolean().describe('true only if we ended on the normal video feed'),
      note: z.string().optional().describe('short note on what was wrong / what was done'),
    });

    try {
      const result = await interactWithScreen<z.infer<typeof RecoverSchema>>(
        prompt,
        this.deviceId,
        this.deviceManager,
        {},
        RecoverSchema,
      );
      return result.recovered;
    } catch (error) {
      logger.warn(`⚠️ [Working] recoverToFeed failed:`, error);
      return false;
    }
  }

  /**
   * Guard: confirm we're on the feed and recover if not. Feeds the shared
   * healthFailures counter so repeated failures eventually stop the stage (and
   * trigger a re-learn), exactly like the periodic health check.
   */
  private async ensureOnFeedOrRecover(context: string): Promise<boolean> {
    // On the happy path don't touch healthFailures: this guard runs often, and
    // zeroing here would erase failures the sparse performHealthCheck accumulated,
    // so the re-learn threshold could never be reached. Only an EARNED recovery
    // (we were genuinely lost and got back) clears the counter; performHealthCheck's
    // own success path is the other reset owner.
    if (await this.isOnFeed()) {
      return true;
    }

    logger.warn(`⚠️ [Working] Off the ${this.presets.app.feedName} (${context}); recovering…`);
    const recovered = await this.recoverToFeed();
    if (recovered) {
      logger.info(`✅ [Working] Recovered back to the ${this.presets.app.feedName}`);
      this.healthFailures = 0;
      return true;
    }

    this.healthFailures++;
    const { maxHealthFailures } = this.presets.control;
    logger.warn(`⚠️ [Working] Feed recovery failed (${this.healthFailures}/${maxHealthFailures})`);
    if (this.healthFailures >= maxHealthFailures) {
      logger.error(`❌ [Working] Could not get back to the ${this.presets.app.feedName} after ${maxHealthFailures} tries — stopping for a re-learn/restart`);
      this.healthFailureExceeded = true;
    }
    return false;
  }

  /**
   * Ensure the app's video feed is ready using the same pattern as learning stage
   */
  async ensureAppReady(): Promise<boolean> {
    const { app } = this.presets;
    logger.info(`🔍 [Working] Ensuring ${app.displayName} is ready...`);

    // Deterministic first: when the app is already up, one exact XML-guided tap
    // reaches the feed (e.g. Instagram Home → Reels) with zero LLM calls. Any
    // miss (app not running, login screen, popup) falls through to the agent.
    if (await this.tryNavigateToFeedViaXml('startup')) {
      logger.info(`✅ [Working] ${app.displayName} is ready (feed reached deterministically)`);
      return true;
    }

    const prompt = `You are a ${app.displayName} automation agent ensuring the app's ${app.feedName} is ready before starting work.

**CRITICAL: YOU MUST CALL finish_task AS YOUR FINAL STEP!**

**Your mission (maximum 3-4 steps):**
1. Take screenshot to check current state
2. If the ${app.displayName} ${app.feedName} is already visible -> call finish_task immediately with success:true
3. If ${app.displayName} is NOT on the ${app.feedName} (wrong screen, an ad, a login/popup, a DIFFERENT app, the home screen, etc.) -> COLD-RESTART it: terminateApp(packageName="${app.appPackage}"), then launchApp(packageName="${app.appPackage}"), then wait, then verify.
${app.feedNavigationHint ? `4. ${app.feedNavigationHint}\n` : ''}

**HARD RULES — do NOT break these:**
- The ONLY way you may recover is terminateApp + launchApp (cold restart). Do this if you are not on the feed.
- NEVER press the home/back/recents keys and NEVER tap or swipe at guessed coordinates to "find" the app — that opens OTHER apps (e.g. a weather app) and makes things worse. Tapping/swiping is only allowed once you have CONFIRMED you are already on the ${app.feedName}.
- If after 3 cold-restart attempts the ${app.feedName} still isn't visible, call finish_task with success:false (the app may need a manual login).

**STEP-BY-STEP FLOW:**
1. take_and_analyze_screenshot(query="Is the ${app.displayName} app open and is the ${app.feedName} (full-screen vertical video with like/comment icons on the right) visible? If you see a login screen, an ad, a popup, the home screen, or a different app, answer that it is NOT the feed.", action="answer_question")
2. IF the ${app.feedName} is ready -> finish_task(success=true, message="${app.displayName} feed is ready")
3. IF not ready -> terminateApp(packageName="${app.appPackage}"), then launchApp(packageName="${app.appPackage}")
4. wait_for_ui(seconds=5, reason="Wait for ${app.displayName} to cold-start")
5. ${app.feedNavigationHint ? 'Navigate to the video feed as described above, then ' : ''}take_and_analyze_screenshot to verify
6. finish_task with final result

**STOP RULE: Call finish_task when the ${app.feedName} is confirmed ready, or with success:false after 3 cold-restart attempts.**`;

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
        followsGiven: 0,
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

          logger.info(`📊 [Working] Progress: ${this.stats.videosWatched} videos, ${this.stats.likesGiven} likes, ${this.stats.commentsPosted} comments, ${this.stats.followsGiven} follows`);
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
          followsGiven: this.stats.followsGiven,
          shouldContinue: false,
          message: 'Health check failed 3 times. Delete data/learned-ui-data.json and rerun learning stage.',
        };
      }
      
      return {
        success: true,
        videosWatched: this.stats.videosWatched,
        likesGiven: this.stats.likesGiven,
        commentsPosted: this.stats.commentsPosted,
        followsGiven: this.stats.followsGiven,
        shouldContinue,
        message: `Automation completed. Videos: ${this.stats.videosWatched}, Likes: ${this.stats.likesGiven}, Comments: ${this.stats.commentsPosted}, Follows: ${this.stats.followsGiven}`,
      };
      
    } catch (error) {
      logger.error(`❌ [Working] Automation loop failed:`, error);
      return {
        success: false,
        videosWatched: this.stats.videosWatched,
        likesGiven: this.stats.likesGiven,
        commentsPosted: this.stats.commentsPosted,
        followsGiven: this.stats.followsGiven,
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