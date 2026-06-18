import { describe, expect, it } from 'vitest';

import { interpretFollowState } from '../stages/working.js';

import { ElementLedger } from './ElementLedger.js';
import { normalizeForMatch, parseNodes, verifyCommentPosted } from './uiVerify.js';
import { readPngDimensions } from './utils.js';

/** Build a 24-byte buffer that is a valid PNG header with the given dimensions. */
const makePngHeader = (width: number, height: number): Buffer => {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(0x89504e47, 0); // signature start
  buf.writeUInt32BE(0x0d0a1a0a, 4); // signature end
  buf.writeUInt32BE(0x0000000d, 8); // IHDR length
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
};

describe('readPngDimensions', () => {
  it('reads width/height from a valid PNG header', () => {
    expect(readPngDimensions(makePngHeader(1440, 2560))).toEqual({ width: 1440, height: 2560 });
    expect(readPngDimensions(makePngHeader(1080, 1920))).toEqual({ width: 1080, height: 1920 });
  });

  it('returns null for non-PNG data', () => {
    expect(readPngDimensions(Buffer.from('not a png at all here padding'))).toBeNull();
  });

  it('returns null for a truncated buffer', () => {
    expect(readPngDimensions(Buffer.alloc(10))).toBeNull();
  });

  it('returns null when dimensions are zero', () => {
    expect(readPngDimensions(makePngHeader(0, 0))).toBeNull();
  });
});

describe('normalizeForMatch', () => {
  it('lowercases, strips emoji/punctuation and collapses whitespace', () => {
    expect(normalizeForMatch('Nice  Video! 🔥')).toBe('nice video');
    expect(normalizeForMatch('nice video')).toBe('nice video');
  });
});

describe('parseNodes', () => {
  it('extracts text/class and unescapes entities', () => {
    const xml =
      '<hierarchy>' +
      '<node text="hello &amp; bye" class="android.widget.TextView" resource-id="x"/>' +
      '<node text="" class="android.widget.EditText" resource-id="comment_box"/>' +
      '</hierarchy>';
    const nodes = parseNodes(xml);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].text).toBe('hello & bye');
    expect(nodes[0].isEditText).toBe(false);
    expect(nodes[1].isEditText).toBe(true);
  });

  it('returns [] for empty input', () => {
    expect(parseNodes('')).toEqual([]);
  });
});

describe('verifyCommentPosted', () => {
  it('reports posted when text appears in a non-input node and input is clear', () => {
    const xml =
      '<node text="nice video" class="android.widget.TextView"/>' +
      '<node text="" class="android.widget.EditText"/>';
    const r = verifyCommentPosted(xml, 'nice video');
    expect(r).toMatchObject({ usable: true, posted: true, stuckInInput: false, inputCleared: true });
  });

  it('does NOT report posted when text is still only in the input box', () => {
    const xml =
      '<node text="other comment" class="android.widget.TextView"/>' +
      '<node text="nice video" class="android.widget.EditText"/>';
    const r = verifyCommentPosted(xml, 'nice video');
    expect(r.posted).toBe(false);
    expect(r.stuckInInput).toBe(true);
    expect(r.inputCleared).toBe(false);
  });

  it('tolerates emoji/case/whitespace differences between dump and expected text', () => {
    const xml = '<node text="Nice   Video 🔥" class="android.widget.TextView"/>';
    expect(verifyCommentPosted(xml, 'nice video').posted).toBe(true);
  });

  it('is unusable (→ vision fallback) for an empty/secure dump', () => {
    expect(verifyCommentPosted('', 'nice video')).toMatchObject({ usable: false, posted: false });
  });
});

describe('ElementLedger', () => {
  const entry = (x: number, y: number, outOfBounds = false) => ({
    x,
    y,
    label: 'btn',
    confidence: 0.9,
    tapped: true,
    outOfBounds,
    imgWidth: 1080,
    imgHeight: 1920,
  });

  it('records coordinates and getBest returns the latest in-bounds capture', () => {
    const ledger = new ElementLedger();
    ledger.record('commentSendButton', entry(900, 1800));
    ledger.record('commentSendButton', entry(950, 1810));
    expect(ledger.getBest('commentSendButton')).toMatchObject({ x: 950, y: 1810 });
  });

  it('prefers an in-bounds capture over a later out-of-bounds one', () => {
    const ledger = new ElementLedger();
    ledger.record('likeButton', entry(800, 700));
    ledger.record('likeButton', entry(99999, 99999, true));
    expect(ledger.getBest('likeButton')).toMatchObject({ x: 800, y: 700 });
  });

  it('lockVerified pins the exact tap that produced a verified post', () => {
    const ledger = new ElementLedger();
    ledger.record('commentSendButton', entry(900, 1800)); // the tap that worked
    ledger.lockVerified('commentSendButton');
    ledger.record('commentSendButton', entry(10, 10)); // a later stray tap
    // getBest must still return the locked, verified coordinate, not the stray.
    expect(ledger.getBest('commentSendButton')).toMatchObject({ x: 900, y: 1800 });
  });

  it('has() reflects whether a key was captured', () => {
    const ledger = new ElementLedger();
    expect(ledger.has('commentButton')).toBe(false);
    ledger.record('commentButton', entry(500, 600));
    expect(ledger.has('commentButton')).toBe(true);
  });

  it('selectBest ignores a locked entry that fails the plausibility predicate', () => {
    const ledger = new ElementLedger();
    // A real send tap in the input row (bottom), then a stray tap up on the
    // like rail that wrongly gets locked.
    ledger.record('commentSendButton', entry(960, 1850)); // real send (input row)
    ledger.record('commentSendButton', entry(966, 1245)); // stray, mid-screen
    ledger.lockVerified('commentSendButton'); // locks the stray (latest)
    // Predicate: must be in the bottom portion of a 2340px-tall screen.
    const bottomRow = (e: { y: number }) => e.y > 1600;
    const chosen = ledger.selectBest('commentSendButton', bottomRow);
    expect(chosen).toMatchObject({ x: 960, y: 1850 }); // not the locked stray
  });

  it('selectBest returns the locked entry when it passes the predicate', () => {
    const ledger = new ElementLedger();
    ledger.record('commentSendButton', entry(960, 1850));
    ledger.lockVerified('commentSendButton');
    const chosen = ledger.selectBest('commentSendButton', (e) => e.y > 1600);
    expect(chosen).toMatchObject({ x: 960, y: 1850 });
  });

  it('tracks likeVerified independently of commentVerified', () => {
    const ledger = new ElementLedger();
    expect(ledger.likeVerified).toBe(false);
    ledger.record('likeButton', entry(980, 1260));
    ledger.likeVerified = true;
    ledger.lockVerified('likeButton');
    expect(ledger.likeVerified).toBe(true);
    expect(ledger.commentVerified).toBe(false);
    expect(ledger.getBest('likeButton')).toMatchObject({ x: 980, y: 1260 });
  });
});

describe('interpretFollowState', () => {
  it('treats "Takip Et" / "Follow" as NOT following', () => {
    expect(interpretFollowState('Takip Et')).toBe(false);
    expect(interpretFollowState('takip et')).toBe(false);
    expect(interpretFollowState('  Takip  Et ')).toBe(false);
    expect(interpretFollowState('Follow')).toBe(false);
  });

  it('treats the bare "Takip" / "Following" / "Takip Ediliyor" as already following', () => {
    // The trap: "Takip" is a substring of "Takip Et" — bare "Takip" must read as following.
    expect(interpretFollowState('Takip')).toBe(true);
    expect(interpretFollowState('takip')).toBe(true);
    expect(interpretFollowState('Takip Ediliyor')).toBe(true);
    expect(interpretFollowState('Following')).toBe(true);
  });

  it('returns undefined when the text is empty or unrecognized', () => {
    expect(interpretFollowState('')).toBeUndefined();
    expect(interpretFollowState(undefined)).toBeUndefined();
    expect(interpretFollowState('Mesaj Gönder')).toBeUndefined();
  });
});
