/**
 * Automation presets and configuration
 */

import { type AppProfile, getAppProfile } from './apps.js';

export interface AutomationPresets {
  /** Which social app this run drives (package, feed name, navigation hints). */
  app: AppProfile;
  video: {
    watchDuration: [number, number]; // [min, max] seconds for normal viewing
    quickSkipChance: number;         // 0-1 probability to skip after 1 second
    quickSkipDuration: number;       // seconds to watch before quick skip
    scrollDelay: [number, number];   // [min, max] seconds
  };
  
  interactions: {
    likeChance: number;     // 0-1 probability
    commentChance: number;  // 0-1 probability
    dailyLimit: number;     // max actions per day
  };
  
  comments: {
    language: string;       // language to write comments in (e.g. "English", "Turkish")
    templates: string[];
    useAI: boolean;
    maxLength: number;
  };
  
  // Control settings for health checks, errors, and ban detection
  control: {
    healthCheckInterval: number;   // number of videos between health checks
    maxHealthFailures: number;     // max consecutive health check failures
    shadowBanInterval: number;     // number of videos between shadow ban checks
    maxConsecutiveErrors: number;  // max consecutive processing errors before stop
  };
}

/**
 * Comment language — set with the COMMENT_LANGUAGE env var (default English).
 * The AI generator writes comments in this language; templates below are the
 * offline fallback for the same language.
 */
const COMMENT_LANGUAGE = process.env.COMMENT_LANGUAGE?.trim() || 'English';

/**
 * Read a 0..1 probability from an env var, falling back to a default. Used to
 * tune (or, while testing the like/comment flow, temporarily crank up) how often
 * the bot likes/comments without editing code. e.g. LIKE_CHANCE=1 COMMENT_CHANCE=1
 * makes it like and comment on every video.
 */
const parseChance = (envName: string, fallback: number): number => {
  const raw = process.env[envName]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
};

/**
 * Offline fallback templates per language (used when AI generation is off or
 * fails). Kept ASCII / diacritic-free so they type cleanly over adb.
 */
const COMMENT_TEMPLATES: Record<string, string[]> = {
  English: [
    'amazing', 'love this content', 'so cool', 'great video', 'nice',
    'this is fire', 'cant stop watching', 'so good', 'perfect', 'love it',
    'this hits different', 'absolutely love this', 'so talented', 'incredible',
    'this is everything',
  ],
  Turkish: [
    'harika 🔥', 'bayıldım 😍', 'çok güzel', 'muhteşem video 👏', 'eline sağlık',
    'süpersin', 'bu çok iyi', 'mükemmel 👌', 'kesinlikle takip', 'efsane 🔥',
    'çok başarılı', 'helal', 'izlemeye doyamadım', 'valla güzelmiş', 'çok tatlı 🥰',
  ],
};

/**
 * Default automation settings
 */
export const AUTOMATION_PRESETS: AutomationPresets = {
  // Default app; overridden per-run from the --app flag in index.ts.
  app: getAppProfile('tiktok'),
  video: {
    watchDuration: [5, 10],   // Watch 5-10 seconds normally
    quickSkipChance: 0.2,     // Skip quickly on 20% of videos (1 in 5)
    quickSkipDuration: 1,     // Watch only 1 second before skipping
    scrollDelay: [1, 3],      // Wait 1-3 seconds between videos
  },
  
  interactions: {
    // Defaults stay conservative (human-like, lower shadowban risk). Override with
    // LIKE_CHANCE / COMMENT_CHANCE env vars — e.g. set both to 1 to exercise the
    // like/comment flow on every video while verifying the learned coordinates.
    likeChance: parseChance('LIKE_CHANCE', 0.0167),     // ~1 in 60 videos by default
    commentChance: parseChance('COMMENT_CHANCE', 0.005), // ~1 in 200 videos by default
    dailyLimit: 500,          // Max 500 actions per day
  },
  
  comments: {
    language: COMMENT_LANGUAGE,
    templates: COMMENT_TEMPLATES[COMMENT_LANGUAGE] ?? COMMENT_TEMPLATES.English,
    useAI: true,
    maxLength: 50,
  },
  
  control: {
    healthCheckInterval: 100, // Every 100 videos check screen if it is healthy and looks like the app's video feed
    maxHealthFailures: 3, // Max 3 health check failures before retraining UI coordinates
    shadowBanInterval: 200, // Every 200 videos check if the account is shadow banned
    maxConsecutiveErrors: 5, // Max 5 consecutive errors before stopping
  },
}; 