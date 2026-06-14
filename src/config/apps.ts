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

export type AppId = 'tiktok' | 'instagram';

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
