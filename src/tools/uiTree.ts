/**
 * Deterministic UI element lookup from a uiautomator view-hierarchy dump.
 *
 * This is the coordinate source that REPLACES vision guessing wherever the app
 * exposes its UI through the accessibility tree: parse the XML `adb shell
 * uiautomator dump` produces, match an element by resource-id (Instagram ships
 * stable ids like `com.instagram.android:id/clips_tab`) or by content-desc /
 * text regex (TikTok obfuscates ids per build but keeps rich localized
 * accessibility labels like "Video beğenin. 21,7 B beğeni"), and tap the exact
 * center of its bounds. Bounds are in real screen pixels — the same space
 * `adb shell input tap` consumes — so a hit is pixel-perfect, instant and free,
 * where a vision model is a paid guess with measurable bias.
 *
 * Best-effort by design, mirroring uiVerify: when the dump is empty
 * (FLAG_SECURE, mid-animation) or the selector doesn't match (app update,
 * different locale), callers fall back to the existing vision path — this
 * module can only ever HELP, never regress.
 */

import { unescapeXml } from './uiVerify.js';

/** Pixel-space rectangle as uiautomator reports it: "[x1,y1][x2,y2]". */
export interface UiBounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** One parsed <node> with everything coordinate lookup needs. */
export interface UiTreeNode {
  text: string;
  contentDesc: string;
  resourceId: string;
  className: string;
  clickable: boolean;
  /**
   * Android's selected/activated state. Toggle controls flip this instead of
   * (or in addition to) their label — e.g. Instagram's like button stays
   * "Beğen" but goes selected="true" once liked.
   */
  selected: boolean;
  /** null when the node has no (or malformed) bounds. */
  bounds: UiBounds | null;
  /** Tap target: center of bounds. null when bounds are unusable. */
  center: { x: number; y: number } | null;
}

/**
 * Declarative element matcher. All given conditions must hold (AND). Regexes
 * are case-insensitive and Unicode-aware so Turkish labels ("Beğen", "Takip
 * Edin") match regardless of case.
 */
export interface UiSelector {
  /** Exact resource-id match, e.g. "com.instagram.android:id/like_button". */
  resourceId?: string;
  /** Regex source tested against content-desc, e.g. "^(Video beğen|Like video)". */
  contentDesc?: string;
  /** Regex source tested against the visible text, e.g. "(Yorum ekle|Add comment)". */
  text?: string;
  /** Substring match on the class name, e.g. "EditText". */
  className?: string;
  /** When true, only clickable="true" nodes match (still PREFERRED even when unset). */
  clickable?: boolean;
}

/** Parse uiautomator's bounds attribute "[x1,y1][x2,y2]" (null when malformed). */
export const parseBounds = (raw: string): UiBounds | null => {
  const m = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(raw.trim());
  if (!m) return null;
  const [, x1, y1, x2, y2] = m.map(Number) as unknown as [unknown, number, number, number, number];
  if (x2 <= x1 || y2 <= y1) return null; // zero/negative area is not tappable
  return { x1, y1, x2, y2 };
};

/**
 * Parse the <node .../> elements out of a uiautomator dump with everything the
 * element finder needs. Same tolerant attribute-scan approach as
 * uiVerify.parseNodes (uiautomator always double-quotes and XML-escapes
 * attribute values, so a key="value" scan is safe).
 */
export const parseUiTree = (xml: string): UiTreeNode[] => {
  if (!xml) return [];
  const nodes: UiTreeNode[] = [];
  const nodeRe = /<node\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml)) !== null) {
    const [, attrs] = m;
    const attr = (name: string): string => {
      const a = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
      return a ? unescapeXml(a[1]) : '';
    };
    const bounds = parseBounds(attr('bounds'));
    nodes.push({
      text: attr('text'),
      contentDesc: attr('content-desc'),
      resourceId: attr('resource-id'),
      className: attr('class'),
      clickable: attr('clickable') === 'true',
      selected: attr('selected') === 'true',
      bounds,
      center: bounds
        ? { x: Math.round((bounds.x1 + bounds.x2) / 2), y: Math.round((bounds.y1 + bounds.y2) / 2) }
        : null,
    });
  }
  return nodes;
};

/** True when the node satisfies EVERY condition the selector declares. */
export const matchesSelector = (node: UiTreeNode, selector: UiSelector): boolean => {
  if (selector.resourceId !== undefined && node.resourceId !== selector.resourceId) return false;
  if (selector.contentDesc !== undefined && !new RegExp(selector.contentDesc, 'iu').test(node.contentDesc)) return false;
  if (selector.text !== undefined && !new RegExp(selector.text, 'iu').test(node.text)) return false;
  if (selector.className !== undefined && !node.className.includes(selector.className)) return false;
  if (selector.clickable !== undefined && node.clickable !== selector.clickable) return false;
  return true;
};

/**
 * Find the best tappable node for a selector, or null when nothing matches
 * (callers then fall back to vision). "Best" among matches with usable bounds:
 * clickable nodes win over non-clickable ones (tapping a non-clickable label
 * inside a button works on Android, but the clickable container is the real
 * control), then the SMALLEST area wins (the most specific node, not a
 * full-screen wrapper that happens to match).
 */
export const findUiElement = (xml: string, selector: UiSelector): UiTreeNode | null => {
  const candidates = parseUiTree(xml).filter(
    // Off-screen nodes (negative center) are not tappable — `input tap` rejects
    // negative coordinates. Mirrors the vision path's out-of-bounds rejection.
    (n) => n.center !== null && n.center.x >= 0 && n.center.y >= 0 && matchesSelector(n, selector),
  );
  if (candidates.length === 0) return null;
  const area = (n: UiTreeNode): number =>
    n.bounds ? (n.bounds.x2 - n.bounds.x1) * (n.bounds.y2 - n.bounds.y1) : Number.MAX_SAFE_INTEGER;
  candidates.sort((a, b) => {
    if (a.clickable !== b.clickable) return a.clickable ? -1 : 1;
    return area(a) - area(b);
  });
  return candidates[0];
};

/**
 * Infer the screen size from the dump itself (max x2/y2 across all bounds —
 * the root containers span the full display). Matches the real render
 * resolution even under a display-size override, where `wm size` can lie.
 * Null for an empty/boundless dump.
 */
export const screenSizeFromUiTree = (xml: string): { width: number; height: number } | null => {
  let width = 0;
  let height = 0;
  for (const node of parseUiTree(xml)) {
    if (!node.bounds) continue;
    if (node.bounds.x2 > width) width = node.bounds.x2;
    if (node.bounds.y2 > height) height = node.bounds.y2;
  }
  return width > 0 && height > 0 ? { width, height } : null;
};
