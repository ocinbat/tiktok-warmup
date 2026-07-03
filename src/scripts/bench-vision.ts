import 'dotenv/config';

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findObject } from '../tools/interaction.js';
import { VISION_PROVIDER } from '../tools/llm.js';

/**
 * Coordinate-accuracy benchmark for the PRODUCTION findObject path (including
 * crop-zoom refinement when VISION_ZOOM_REFINE is on). No device needed.
 *
 *   pnpm tsx src/scripts/bench-vision.ts                          # as configured
 *   VISION_ZOOM_REFINE=false pnpm tsx src/scripts/bench-vision.ts # baseline
 *
 * Uses assets/ui-probe.png — a synthetic Reels-style UI (1080x2400) with
 * elements at KNOWN pixel positions. Metric: HIT = returned tap point falls
 * inside the element's true bounds.
 *
 * History (MiniMax-M3, 2026-07-03): single full-screen calls showed a
 * consistent ~+8-10% downward y-bias — 1/18 hits. Median-of-3 ensembling did
 * NOT help (0/60: it is bias, not noise). Hint-refinement did not help (0/9).
 * Crop-zoom (stage 2 on a crop around stage 1's answer) collapsed mean |y
 * error| 76 → 5 normalized and hit 6/9 — which is why findObject now does it.
 */

interface Target {
  key: string;
  query: string;
  /** True element bounds in PIXELS on the 1080x2400 probe. */
  bounds: { x1: number; y1: number; x2: number; y2: number };
}

const TARGETS: Target[] = [
  {
    key: 'heart',
    query: 'Find the white heart-shaped like icon on the right side rail',
    bounds: { x1: 938, y1: 1285, x2: 1042, y2: 1382 },
  },
  {
    key: 'comment',
    query: 'Find the white speech-bubble comment icon on the right side rail',
    bounds: { x1: 938, y1: 1468, x2: 1042, y2: 1562 },
  },
  {
    key: 'follow',
    query: 'Find the red Follow button next to the username',
    bounds: { x1: 300, y1: 1945, x2: 470, y2: 2015 },
  },
];

const TRIALS = 4;

const here = dirname(fileURLToPath(import.meta.url));
const shot = {
  base64Data: readFileSync(resolve(here, '../../assets/ui-probe.png')).toString('base64'),
  width: 1080,
  height: 2400,
};

const center = (b: Target['bounds']): { x: number; y: number } => ({ x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 });

const main = async (): Promise<void> => {
  console.log(`provider: ${VISION_PROVIDER}  VISION_ZOOM_REFINE=${process.env.VISION_ZOOM_REFINE ?? '(default)'}`);
  let hits = 0;
  let total = 0;
  const dys: number[] = [];

  for (const target of TARGETS) {
    const truth = center(target.bounds);
    console.log(`\n── ${target.key} (truth px ${truth.x}, ${truth.y}) ──`);
    const results = await Promise.all(
      Array.from({ length: TRIALS }, async () => findObject(`bench-${target.key}`, shot, target.query)),
    );
    for (const r of results) {
      if (!r.found || !r.coordinates) {
        console.log('  not found');
        continue;
      }
      const { x, y } = r.coordinates;
      const hit = x >= target.bounds.x1 && x <= target.bounds.x2 && y >= target.bounds.y1 && y <= target.bounds.y2;
      hits += hit ? 1 : 0;
      total += 1;
      dys.push(y - truth.y);
      console.log(`  (${x}, ${y}) ${hit ? 'HIT' : `miss (dx ${(x - truth.x).toFixed(0)}, dy ${(y - truth.y).toFixed(0)})`}`);
    }
  }

  const meanAbsDy = dys.length ? dys.reduce((s, v) => s + Math.abs(v), 0) / dys.length : NaN;
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`hit rate ${hits}/${total} (${total ? ((hits / total) * 100).toFixed(0) : 0}%)  mean |dy| ${meanAbsDy.toFixed(0)}px`);
};

main().catch((error) => {
  console.error('Fatal:', error);
  process.exit(1);
});
