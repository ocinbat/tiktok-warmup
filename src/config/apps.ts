/**
 * App profiles — everything that differs between the supported social apps.
 *
 * The automation engine (stages, worker, device control) is app-agnostic: it
 * watches a vertical video feed and likes/comments using coordinates learned by
 * vision. Only a handful of things are app-specific — the package name, how long
 * it takes to load, what the feed is called, and whether the app needs an extra
 * navigation step to reach the feed. Those live here and are selected at startup
 * with the `--app` CLI flag.
 */

import type { UiSelector } from '../tools/uiTree.js';

export type AppId = 'tiktok' | 'instagram';

/**
 * The UI roles the engine may resolve DETERMINISTICALLY from the uiautomator
 * view hierarchy instead of asking a vision model. The first five mirror the
 * learnable ElementLedger keys; the rest cover navigation and the follow flow.
 */
export type UiElementRole =
  | 'likeButton'
  | 'commentButton'
  | 'commentInputField'
  | 'commentSendButton'
  | 'commentCloseButton'
  | 'followButton'
  /** Bottom-bar tab that opens the vertical video feed (IG: Reels tab; TikTok: Home). */
  | 'feedTab'
  /** Element whose PRESENCE proves we're on the video feed right now. */
  | 'feedMarker'
  /**
   * Author/caption text node(s) of the CURRENT post — their combined text is a
   * fingerprint used to verify a "next video" swipe actually advanced the feed
   * (TikTok photo-mode posts silently swallow some swipe gestures).
   */
  | 'postTitle';

export interface AppProfile {
  /** Stable identifier, also used as the persistence key suffix and `--app` value. */
  id: AppId;
  /** Human-readable name, injected into agent prompts (e.g. "TikTok"). */
  displayName: string;
  /** Android package name launched over adb. */
  appPackage: string;
  /** Seconds to wait after launch before interacting. */
  loadTime: number;
  /** What the vertical video feed is called, injected into prompts (e.g. "For You feed", "Reels feed"). */
  feedName: string;
  /**
   * Extra instruction injected into prompts telling the agent how to reach the
   * video feed after launch. Empty for apps that open straight into the feed
   * (TikTok). Non-empty for apps that land elsewhere first (Instagram → Reels).
   */
  feedNavigationHint: string;
  /**
   * How to find & tap the FOLLOW control on a feed video, injected into the
   * niche-follow prompts. Empty string disables the follow feature for this app.
   */
  followButtonHint: string;
  /**
   * How to read, from the screen, whether we ALREADY follow the current creator
   * (so the bot never re-taps an already-followed account).
   */
  followStateHint: string;
  /**
   * Run a lightweight "are we still on the feed?" guard every N videos and
   * recover (navigate back to the feed, else cold-restart) if not. 0 disables
   * the periodic guard (rely on the heavier health check). Apps that drift off
   * the feed easily (Instagram → Home/DMs) want a small value.
   */
  feedCheckInterval: number;
  /**
   * Confirm we're on the feed right BEFORE liking/commenting, recovering first
   * if not — so the bot never blind-taps learned coordinates on the wrong screen
   * (e.g. hitting Instagram's DM/share icons). TikTok stays on the feed, so it
   * leaves this off for speed.
   */
  guardBeforeActions: boolean;
  /**
   * Deterministic uiautomator selectors for this app's controls, captured from
   * real device dumps. When a role resolves here, the engine taps the element's
   * exact bounds-center from the view hierarchy — no vision call, no coordinate
   * guessing. A missing role (or a dump that comes back empty / unmatched) falls
   * back to the existing learned-coordinate / vision path, so these can only
   * improve accuracy, never break the flow.
   *
   * Instagram exposes STABLE resource-ids; TikTok obfuscates ids per build but
   * keeps localized accessibility labels (content-desc), so TikTok matches by
   * desc regex (Turkish + English variants).
   */
  xmlSelectors: Partial<Record<UiElementRole, UiSelector>>;
  /**
   * Case-insensitive regex matched against the like control's content-desc to
   * decide "this video is ALREADY liked" straight from the view hierarchy
   * (e.g. "Beğenmekten Vazgeç" / "Unlike"). Empty disables the XML liked-state
   * read (vision fallback is used instead).
   */
  likedStateDescRegex: string;
  /**
   * True when the follow control DISAPPEARS from the view hierarchy once you
   * already follow the creator (TikTok: the red "+" badge under the avatar is
   * only rendered while NOT following). For such apps, "followButton selector
   * matches nothing" + "we're on a normal feed" = already following — decided
   * deterministically, no vision needed. False for apps whose follow control is
   * always present and merely changes its label (Instagram's follow button).
   */
  followAbsentMeansFollowing: boolean;
}

export const APP_PROFILES: Record<AppId, AppProfile> = {
  tiktok: {
    id: 'tiktok',
    displayName: 'TikTok',
    appPackage: 'com.zhiliaoapp.musically',
    loadTime: 3,
    feedName: 'For You feed',
    // TikTok opens directly into the full-screen vertical feed — no navigation needed.
    feedNavigationHint: '',
    followButtonHint:
      'On TikTok the follow control is the small RED circle with a white PLUS (+) sign attached to the ' +
      'BOTTOM edge of the round profile avatar, in the right-side action column, directly ABOVE the ' +
      'heart/like icon. Tap ONLY that red + badge to follow — do NOT tap the avatar photo itself (that ' +
      'opens the profile page).',
    followStateHint:
      'On TikTok the red + badge under the avatar is shown ONLY when you do NOT follow the creator. ' +
      'If the avatar has a red + under it → NOT following. If the + badge is gone (just the round avatar) → ' +
      'already following.',
    // The guard used to be OFF here (it cost a slow vision call and TikTok
    // rarely drifts) — but with the XML feed check it costs ~1s, and a crashed/
    // backgrounded TikTok otherwise leaves the bot swiping the LAUNCHER forever
    // (observed live). Check every 10 videos and before every like/comment.
    feedCheckInterval: 10,
    guardBeforeActions: true,
    // TikTok obfuscates resource-ids per build (id/fsb, id/eda…), but its
    // accessibility labels are rich and stable — match by content-desc regex
    // (Turkish + English UI variants). Captured from a live Samsung dump.
    xmlSelectors: {
      // The clickable like CONTAINER: desc "Video beğenin. 21,7 B beğeni" /
      // liked state "…beğenmekten vazgeçin…"; EN "Like video…" / "Unlike…".
      likeButton: { contentDesc: '(^Video beğen)|(beğenmekten vazgeç)|(^Like video)|(^Unlike)', clickable: true },
      // "Yorum okuyun veya ekleyin. 77 yorum" / "Read or add comments…".
      commentButton: { contentDesc: '(^Yorum (okuyun|ekleyin))|(^Read or add comment)', clickable: true },
      // The collapsed composer at the panel bottom, hint "Yorum ekleyin..." /
      // "Add comment...". (Once focused the hint is replaced by typed text, but
      // the working stage only needs the FIRST tap to focus it.)
      commentInputField: { className: 'EditText', text: '(Yorum ekle|Add comment)' },
      // commentSendButton: NOT resolvable — TikTok's send control only exposes an
      // unresolved resource reference (desc "@2131823209", obfuscated id) that
      // changes per build. The learned coordinate + vision fallback handle it,
      // and verify_comment_posted already confirms the outcome objectively.
      // "PoolDaily Takip Edin" (creator-name prefix) / EN "Follow …".
      followButton: { contentDesc: '(Takip Edin)|(^Follow\\b)', clickable: true },
      // Bottom nav "Ana sayfa" / "Home" opens the For You feed.
      feedTab: { contentDesc: '^(Ana sayfa|Home)$', clickable: true },
      // The For You tab label at the top exists only on the FYP feed.
      feedMarker: { contentDesc: '^(Sizin İçin|For You)$' },
      // Author name + caption share this stable id — combined they fingerprint
      // the current post for swipe verification.
      postTitle: { resourceId: 'com.zhiliaoapp.musically:id/title' },
    },
    likedStateDescRegex: 'vazgeç|unlike',
    // The red "+" badge is only present while NOT following → its absence on a
    // normal feed means already following (no vision needed to confirm).
    followAbsentMeansFollowing: true,
  },
  instagram: {
    id: 'instagram',
    displayName: 'Instagram',
    appPackage: 'com.instagram.android',
    loadTime: 4,
    feedName: 'Reels feed',
    feedNavigationHint:
      'IMPORTANT: Instagram launches into the HOME timeline (photo/post feed), NOT the video feed. ' +
      'Before doing anything else, open REELS: tap the Reels tab in the bottom navigation bar — the ' +
      'clapperboard / play-triangle icon (usually the middle item of the bottom bar). The Reels feed is ' +
      'full-screen vertical videos with the like (heart), comment (speech bubble) and share icons stacked ' +
      'on the RIGHT side, and you swipe UP to move to the next video — it behaves just like the TikTok feed. ' +
      'Make sure you are on Reels before locating buttons, liking, or commenting.',
    followButtonHint:
      'On Instagram Reels the follow control is the small button next to the creator username (bottom-left, ' +
      'near the caption — usually an outlined pill). To FOLLOW, tap the button that reads "Takip Et" (Turkish) ' +
      'or "Follow" (English). NEVER tap a button reading "Takip", "Takip Ediliyor" or "Following" — that means ' +
      'you ALREADY follow and tapping it would UNFOLLOW. Do NOT tap the username or the avatar photo (that ' +
      'opens the profile page).',
    followStateHint:
      'On Instagram the follow BUTTON text tells you the state — read the WHOLE button text carefully: ' +
      '"Takip Et" (TR) or "Follow" (EN) means you do NOT follow yet; ' +
      'the bare word "Takip", or "Takip Ediliyor" (TR), or "Following" (EN) means you ALREADY follow. ' +
      'TRAP: "Takip Et" CONTAINS the word "Takip", so do NOT read "Takip Et" as "Takip". The deciding signal ' +
      'is the extra word "Et": WITH "Et" ("Takip Et") = NOT following; the bare "Takip" (no "Et") = already following.',
    // Instagram drifts off Reels easily (Home timeline, DMs, profiles), so guard
    // before every like/comment AND check periodically to recover fast.
    feedCheckInterval: 12,
    guardBeforeActions: true,
    // Instagram ships STABLE, meaningful resource-ids — the strongest possible
    // selectors. Captured from a live Samsung dump (Reels player + comment panel).
    xmlSelectors: {
      likeButton: { resourceId: 'com.instagram.android:id/like_button' },
      commentButton: { resourceId: 'com.instagram.android:id/comment_button' },
      commentInputField: { resourceId: 'com.instagram.android:id/layout_comment_thread_edittext_multiline' },
      // Appears (with desc "Paylaş"/"Post") once text is in the composer.
      commentSendButton: { resourceId: 'com.instagram.android:id/layout_comment_thread_post_button_icon' },
      // The inline pill next to the creator name; its TEXT carries the state
      // ("Takip Et" = not following) for interpretFollowState.
      followButton: { resourceId: 'com.instagram.android:id/inline_follow_button' },
      // Bottom nav bar Reels tab — THE deterministic fix for "can't reach Reels".
      feedTab: { resourceId: 'com.instagram.android:id/clips_tab' },
      // Present only while the full-screen Reels player is showing.
      feedMarker: { resourceId: 'com.instagram.android:id/clips_video_container' },
      // The creator's username — fingerprints the current reel for swipe verification.
      postTitle: { resourceId: 'com.instagram.android:id/clips_author_username' },
    },
    likedStateDescRegex: 'vazgeç|unlike',
    // Instagram's inline follow button is ALWAYS present; its label carries the
    // state ("Takip Et" vs "Takip"/"Following"), so absence never means following.
    followAbsentMeansFollowing: false,
  },
};

export const DEFAULT_APP_ID: AppId = 'tiktok';

/** Type guard for an untrusted string (e.g. a CLI argument). */
export function isAppId(value: string | undefined): value is AppId {
  return value === 'tiktok' || value === 'instagram';
}

/** Resolve an app id to its profile. Falls back to the default app. */
export function getAppProfile(id: string | undefined = DEFAULT_APP_ID): AppProfile {
  return isAppId(id) ? APP_PROFILES[id] : APP_PROFILES[DEFAULT_APP_ID];
}
