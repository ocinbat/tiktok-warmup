/**
 * Objective comment-post verification from a uiautomator view-hierarchy dump.
 *
 * This is the ground-truth signal that replaces "ask the vision LLM if it looks
 * posted" (which hallucinates "yes"). It is best-effort: TikTok/Instagram can
 * mark surfaces FLAG_SECURE (blank dump), obfuscate class names, or virtualize
 * the comment list (a just-posted comment may not be in the tree yet). Whenever
 * the dump is unusable we report `usable: false` and the caller falls back to
 * vision — so this can only ever HELP, never regress.
 *
 * Note: uiautomator's `text` attribute reflects the rendered, human-visible text
 * even in obfuscated apps, so matching on comment text is reliable; it's the
 * class names / resource-ids that are obfuscated, and we don't depend on those.
 */

export interface UiNode {
  text: string;
  className: string;
  resourceId: string;
  isEditText: boolean;
}

export interface CommentVerifyResult {
  /** False when the dump was empty/secure/unparseable → caller uses vision. */
  usable: boolean;
  /** The expected text was found as a POSTED comment (non-input node). */
  posted: boolean;
  /** The expected text is still sitting in an input box (NOT posted). */
  stuckInInput: boolean;
  /** No input box still holds the expected text (corroborates a successful send). */
  inputCleared: boolean;
}

/** Decode the handful of XML entities uiautomator emits in attribute values. */
const unescapeXml = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#10;/g, ' ')
    .replace(/&#13;/g, ' ')
    .replace(/&amp;/g, '&');

/**
 * Normalize text for tolerant comparison: lowercase, drop everything that isn't
 * a letter, digit or space (so emoji/punctuation differences don't matter),
 * collapse whitespace. "Nice video 🔥!" and "nice  video" both become
 * "nice video".
 */
export const normalizeForMatch = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Parse the <node .../> elements out of a uiautomator dump. Attribute values are
 * always double-quoted and XML-escaped by uiautomator, so a key="value" scan is
 * safe even when the visible text contains quotes, emoji or newlines.
 */
export const parseNodes = (xml: string): UiNode[] => {
  if (!xml) return [];
  const nodes: UiNode[] = [];
  const nodeRe = /<node\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml)) !== null) {
    const [, attrs] = m;
    const attr = (name: string): string => {
      const a = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
      return a ? unescapeXml(a[1]) : '';
    };
    const className = attr('class');
    nodes.push({
      text: attr('text'),
      className,
      resourceId: attr('resource-id'),
      isEditText: /edit\s*text/i.test(className),
    });
  }
  return nodes;
};

/**
 * Decide whether `expectedText` is posted as a comment, by checking that the
 * text appears in a NON-input node (the comments list) and, as corroboration,
 * that no input box still holds it.
 */
export const verifyCommentPosted = (xml: string, expectedText: string): CommentVerifyResult => {
  const nodes = parseNodes(xml);
  if (nodes.length === 0) {
    return { usable: false, posted: false, stuckInInput: false, inputCleared: false };
  }
  const needle = normalizeForMatch(expectedText);
  if (!needle) {
    return { usable: false, posted: false, stuckInInput: false, inputCleared: false };
  }

  let postedInList = false;
  let stuckInInput = false;
  for (const node of nodes) {
    if (!node.text) continue;
    if (!normalizeForMatch(node.text).includes(needle)) continue;
    if (node.isEditText) stuckInInput = true;
    else postedInList = true;
  }

  return {
    usable: true,
    posted: postedInList,
    stuckInInput,
    inputCleared: !stuckInInput,
  };
};
