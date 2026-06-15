import { logger } from './utils.js';

/**
 * The UI element roles the learning stage captures. Mirrors the keys of
 * LearnedUIElements in Worker.ts (minus close, which the bot no longer needs).
 */
export type ElementKey =
  | 'likeButton'
  | 'commentButton'
  | 'commentInputField'
  | 'commentSendButton'
  | 'commentCloseButton';

export const ELEMENT_KEYS: ElementKey[] = [
  'likeButton',
  'commentButton',
  'commentInputField',
  'commentSendButton',
  'commentCloseButton',
];

/** One programmatically-captured detection/tap of a UI element. */
export interface CapturedElement {
  /** Pixel coordinate in the screenshot/tap space (they are identical). */
  x: number;
  y: number;
  boundingBox?: { y1: number; x1: number; y2: number; x2: number };
  label: string;
  /** Confidence derived IN CODE (never transcribed by the LLM). */
  confidence: number;
  /** True if this capture was an actual tap (tap_element) vs a read (find_object). */
  tapped: boolean;
  /** True if the raw detection fell outside the screenshot bounds (untrustworthy). */
  outOfBounds: boolean;
  /** Dimensions of the screenshot this coordinate lives in (= tap space). */
  imgWidth: number;
  imgHeight: number;
  /** Monotonic capture order, so "most recent" is well defined without a clock. */
  seq: number;
}

/**
 * ElementLedger — the source of truth for learned coordinates.
 *
 * The whole point: the orchestration LLM NEVER types coordinates back to us. The
 * interaction layer records the exact coordinate it detected/tapped here, keyed
 * by element role, as the tap happens. The learning stage then builds the saved
 * UI map from this ledger instead of from numbers the model hand-copied into
 * finish_task (which it could mistype, swap, or hallucinate).
 *
 * We keep the FULL HISTORY per key rather than last-write-wins, because the
 * agent is told to retry (e.g. "if a gallery opened, press back and tap again",
 * "tap send again if it didn't post"). Last-write-wins would happily record an
 * errant second tap as the learned coordinate. Instead:
 *  - The send button is LOCKED to the precise tap that immediately preceded an
 *    objectively-verified post (see lockVerified), so the saved send coordinate
 *    is provably the one that worked.
 *  - For the other elements, selection (getBest) prefers in-bounds captures and
 *    lets the caller apply role-specific plausibility on the history.
 */
export class ElementLedger {
  private history = new Map<ElementKey, CapturedElement[]>();
  private locked = new Map<ElementKey, CapturedElement>();
  private seqCounter = 0;
  /** Set true once a post was objectively (or vision-fallback) verified. */
  public commentVerified = false;
  /** How the comment was verified, for logging/confidence. */
  public verifiedBy: 'uiautomator' | 'vision' | null = null;
  /** Set true once a real like tap was proven to toggle the like state. */
  public likeVerified = false;

  /** Record a fresh detection/tap. Returns the stored entry. */
  record(key: ElementKey, entry: Omit<CapturedElement, 'seq'>): CapturedElement {
    const stored: CapturedElement = { ...entry, seq: ++this.seqCounter };
    const list = this.history.get(key) ?? [];
    list.push(stored);
    this.history.set(key, list);
    logger.debug(
      `📒 [Ledger] recorded ${key} @ (${stored.x}, ${stored.y}) tapped=${stored.tapped} oob=${stored.outOfBounds} conf=${stored.confidence}`,
    );
    return stored;
  }

  /** Every capture of a key, oldest first. */
  historyOf(key: ElementKey): CapturedElement[] {
    return this.history.get(key) ?? [];
  }

  /** Most recent capture of a key, if any. */
  latest(key: ElementKey): CapturedElement | undefined {
    const list = this.history.get(key);
    return list?.length ? list[list.length - 1] : undefined;
  }

  /**
   * Pin the most-recent capture of a key as the proven one. Called when an
   * objective post verification succeeds, so the learned send coordinate is the
   * exact tap that actually posted the comment — immune to any later stray tap.
   */
  lockVerified(key: ElementKey): CapturedElement | undefined {
    const latest = this.latest(key);
    if (latest) {
      this.locked.set(key, latest);
      logger.info(`🔒 [Ledger] locked verified ${key} @ (${latest.x}, ${latest.y})`);
    }
    return latest;
  }

  /**
   * Best coordinate for a key:
   *  1. the locked/verified capture if one exists,
   *  2. else the most recent IN-BOUNDS capture,
   *  3. else the most recent capture (still better than an LLM transcription).
   * Returns undefined if the key was never captured.
   */
  getBest(key: ElementKey): CapturedElement | undefined {
    const lockedEntry = this.locked.get(key);
    if (lockedEntry) return lockedEntry;
    const list = this.history.get(key);
    if (!list || list.length === 0) return undefined;
    for (let i = list.length - 1; i >= 0; i--) {
      if (!list[i].outOfBounds) return list[i];
    }
    return list[list.length - 1];
  }

  /**
   * Like getBest, but constrained by a plausibility predicate. This is how we
   * avoid trusting a stray tap that happened to get locked: if the locked entry
   * fails the predicate (e.g. a "send" tap that landed nowhere near the input
   * row), we ignore it and fall back to the most recent IN-BOUNDS capture that
   * does pass. Only if nothing passes do we return getBest (best effort).
   */
  selectBest(key: ElementKey, predicate: (e: CapturedElement) => boolean): CapturedElement | undefined {
    const lockedEntry = this.locked.get(key);
    if (lockedEntry && predicate(lockedEntry)) return lockedEntry;
    const list = this.history.get(key);
    if (list) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (!list[i].outOfBounds && predicate(list[i])) return list[i];
      }
    }
    return this.getBest(key);
  }

  /** Whether a key was ever captured at all. */
  has(key: ElementKey): boolean {
    return !!this.getBest(key);
  }
}
