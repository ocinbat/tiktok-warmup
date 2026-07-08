import { describe, expect, it } from 'vitest';

import { findUiElement, matchesSelector, parseBounds, parseUiTree, screenSizeFromUiTree } from './uiTree.js';

/**
 * Build one uiautomator <node .../> line. Attribute values and defaults mirror
 * what a real dump emits (all attributes always present, double-quoted).
 */
const node = (attrs: Partial<Record<'text' | 'desc' | 'id' | 'cls' | 'clickable' | 'selected' | 'bounds', string>>): string =>
  `<node index="0" text="${attrs.text ?? ''}" resource-id="${attrs.id ?? ''}" class="${attrs.cls ?? 'android.view.View'}" ` +
  `package="x" content-desc="${attrs.desc ?? ''}" checkable="false" checked="false" clickable="${attrs.clickable ?? 'false'}" ` +
  `enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" ` +
  `selected="${attrs.selected ?? 'false'}" bounds="${attrs.bounds ?? '[0,0][1080,2340]'}" />`;

const wrap = (inner: string): string => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${inner}</hierarchy>`;

/** Nodes lifted from REAL dumps of this project's target apps (Samsung, 1080x2340). */
const IG_REELS_XML = wrap(
  node({ id: 'com.instagram.android:id/clips_video_container', desc: "home_of_enise'dan Reels videosu", bounds: '[0,81][1080,2052]' }) +
  node({ id: 'com.instagram.android:id/like_button', desc: 'Beğen', clickable: 'true', bounds: '[924,1422][1056,1554]' }) +
  node({ id: 'com.instagram.android:id/comment_button', desc: 'Yorum', clickable: 'true', bounds: '[924,1578][1056,1710]' }) +
  // Real dump has the &amp; entity in the creator name.
  node({ id: 'com.instagram.android:id/inline_follow_button', text: 'Takip Et', desc: 'Enise Çınar | Home &amp; Neutral Living&apos;i takip et', clickable: 'true', bounds: '[595,1803][825,1889]' }) +
  node({ id: 'com.instagram.android:id/clips_tab', desc: 'Reels', clickable: 'true', bounds: '[216,2052][432,2196]' }) +
  node({ id: 'com.instagram.android:id/feed_tab', desc: 'Ana Sayfa', clickable: 'true', bounds: '[0,2052][216,2196]' }),
);

const TIKTOK_FYP_XML = wrap(
  // The like CONTAINER (clickable) vs the inner "Beğen" icon (not clickable):
  // the finder must prefer the clickable container.
  node({ id: 'com.zhiliaoapp.musically:id/fsv', desc: 'Video beğenin. 21,7 B beğeni', clickable: 'true', bounds: '[888,1143][1080,1323]' }) +
  node({ id: 'com.zhiliaoapp.musically:id/fsb', desc: 'Beğen', bounds: '[922,1143][1057,1277]' }) +
  node({ id: 'com.zhiliaoapp.musically:id/eda', desc: 'Yorum okuyun veya ekleyin. 77 yorum', clickable: 'true', bounds: '[888,1323][1080,1503]' }) +
  node({ id: 'com.zhiliaoapp.musically:id/id5', desc: 'PoolDaily Takip Edin', clickable: 'true', bounds: '[899,1040][1080,1143]' }) +
  node({ desc: 'Sizin İçin', bounds: '[639,81][909,255]' }) +
  node({ id: 'com.zhiliaoapp.musically:id/nvc', desc: 'Ana sayfa', clickable: 'true', bounds: '[0,2049][216,2196]' }) +
  node({ id: 'com.zhiliaoapp.musically:id/e9u', text: 'Yorum ekleyin...', cls: 'android.widget.EditText', clickable: 'true', bounds: '[216,2040][672,2133]' }),
);

describe('parseBounds', () => {
  it('parses the uiautomator "[x1,y1][x2,y2]" format', () => {
    expect(parseBounds('[216,2052][432,2196]')).toEqual({ x1: 216, y1: 2052, x2: 432, y2: 2196 });
  });

  it('rejects malformed and zero-area bounds', () => {
    expect(parseBounds('')).toBeNull();
    expect(parseBounds('[a,b][c,d]')).toBeNull();
    expect(parseBounds('[100,100][100,200]')).toBeNull(); // zero width
    expect(parseBounds('[100,100][200,100]')).toBeNull(); // zero height
  });
});

describe('parseUiTree', () => {
  it('extracts desc, bounds, clickability and computes the tap center', () => {
    const [reelsTab] = parseUiTree(wrap(node({ id: 'com.instagram.android:id/clips_tab', desc: 'Reels', clickable: 'true', bounds: '[216,2052][432,2196]' })));
    expect(reelsTab).toMatchObject({
      resourceId: 'com.instagram.android:id/clips_tab',
      contentDesc: 'Reels',
      clickable: true,
      bounds: { x1: 216, y1: 2052, x2: 432, y2: 2196 },
      center: { x: 324, y: 2124 },
    });
  });

  it('unescapes XML entities in attribute values', () => {
    const nodes = parseUiTree(IG_REELS_XML);
    const follow = nodes.find((n) => n.resourceId === 'com.instagram.android:id/inline_follow_button');
    expect(follow?.contentDesc).toBe("Enise Çınar | Home & Neutral Living'i takip et");
  });

  it('returns [] for an empty dump (FLAG_SECURE / failed dump)', () => {
    expect(parseUiTree('')).toEqual([]);
  });

  it('reads the selected flag (Instagram flips it on a liked heart, label unchanged)', () => {
    const [liked] = parseUiTree(wrap(node({ id: 'com.instagram.android:id/like_button', desc: 'Beğen', clickable: 'true', selected: 'true', bounds: '[924,1422][1056,1554]' })));
    expect(liked.selected).toBe(true);
    const [unliked] = parseUiTree(wrap(node({ id: 'com.instagram.android:id/like_button', desc: 'Beğen', clickable: 'true', bounds: '[924,1422][1056,1554]' })));
    expect(unliked.selected).toBe(false);
  });
});

describe('matchesSelector', () => {
  const [likeContainer] = parseUiTree(wrap(node({ desc: 'Video beğenin. 21,7 B beğeni', clickable: 'true', bounds: '[888,1143][1080,1323]' })));

  it('matches content-desc regexes case-insensitively incl. Turkish letters', () => {
    expect(matchesSelector(likeContainer, { contentDesc: '^Video beğen' })).toBe(true);
    expect(matchesSelector(likeContainer, { contentDesc: '^video BEĞEN' })).toBe(true);
    expect(matchesSelector(likeContainer, { contentDesc: '^Yorum' })).toBe(false);
  });

  it('ANDs all declared conditions', () => {
    expect(matchesSelector(likeContainer, { contentDesc: '^Video beğen', clickable: true })).toBe(true);
    expect(matchesSelector(likeContainer, { contentDesc: '^Video beğen', clickable: false })).toBe(false);
    expect(matchesSelector(likeContainer, { contentDesc: '^Video beğen', resourceId: 'nope' })).toBe(false);
  });
});

describe('findUiElement', () => {
  it('finds Instagram elements by stable resource-id with exact centers', () => {
    const reelsTab = findUiElement(IG_REELS_XML, { resourceId: 'com.instagram.android:id/clips_tab' });
    expect(reelsTab?.center).toEqual({ x: 324, y: 2124 });

    const like = findUiElement(IG_REELS_XML, { resourceId: 'com.instagram.android:id/like_button' });
    expect(like?.center).toEqual({ x: 990, y: 1488 });
  });

  it('reads the Instagram follow state from the button text', () => {
    const follow = findUiElement(IG_REELS_XML, { resourceId: 'com.instagram.android:id/inline_follow_button' });
    expect(follow?.text).toBe('Takip Et');
  });

  it('finds TikTok elements by content-desc regex despite obfuscated ids', () => {
    const comment = findUiElement(TIKTOK_FYP_XML, { contentDesc: '(^Yorum (okuyun|ekleyin))|(^Read or add comment)', clickable: true });
    expect(comment?.resourceId).toBe('com.zhiliaoapp.musically:id/eda');
    expect(comment?.center).toEqual({ x: 984, y: 1413 });

    const follow = findUiElement(TIKTOK_FYP_XML, { contentDesc: '(Takip Edin)|(^Follow\\b)', clickable: true });
    expect(follow?.contentDesc).toBe('PoolDaily Takip Edin');
  });

  it('prefers the CLICKABLE like container over the non-clickable inner icon', () => {
    const like = findUiElement(TIKTOK_FYP_XML, { contentDesc: 'beğen' });
    expect(like?.clickable).toBe(true);
    expect(like?.resourceId).toBe('com.zhiliaoapp.musically:id/fsv');
  });

  it('prefers the smallest (most specific) match among equally-clickable nodes', () => {
    const xml = wrap(
      node({ desc: 'Reels wrapper', clickable: 'true', bounds: '[0,0][1080,2340]' }) +
      node({ desc: 'Reels', clickable: 'true', bounds: '[216,2052][432,2196]' }),
    );
    const hit = findUiElement(xml, { contentDesc: 'Reels' });
    expect(hit?.contentDesc).toBe('Reels');
    expect(hit?.bounds).toMatchObject({ x1: 216 });
  });

  it('matches the TikTok comment composer by class + hint text', () => {
    const input = findUiElement(TIKTOK_FYP_XML, { className: 'EditText', text: '(Yorum ekle|Add comment)' });
    expect(input?.resourceId).toBe('com.zhiliaoapp.musically:id/e9u');
  });

  it('returns null when nothing matches or the dump is empty', () => {
    expect(findUiElement(IG_REELS_XML, { resourceId: 'com.instagram.android:id/does_not_exist' })).toBeNull();
    expect(findUiElement('', { resourceId: 'anything' })).toBeNull();
  });

  it('skips off-screen nodes (negative center) — input tap rejects negative coordinates', () => {
    const xml = wrap(node({ desc: 'Reels', clickable: 'true', bounds: '[-500,-300][-100,-50]' }));
    expect(findUiElement(xml, { contentDesc: 'Reels' })).toBeNull();
  });
});

describe('screenSizeFromUiTree', () => {
  it('infers the display size from the maximal bounds', () => {
    expect(screenSizeFromUiTree(IG_REELS_XML)).toEqual({ width: 1080, height: 2196 });
  });

  it('returns null for an empty dump', () => {
    expect(screenSizeFromUiTree('')).toBeNull();
  });
});
