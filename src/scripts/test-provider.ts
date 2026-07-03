import 'dotenv/config';

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateText } from 'ai';
import { z } from 'zod';

import { FIND_OBJECT_CALL, generateStructured, VISION_BOX_XY_FIRST } from '../tools/interaction.js';
import { ACTIVE_PROVIDER, llm, VISION_PROVIDER } from '../tools/llm.js';

/**
 * Smoke test + vision calibration for the ACTIVE provider in .env.
 * No device needed — it only talks to the LLM API.
 *
 *   pnpm test-provider
 *
 * Runs three checks against whatever AI_PROVIDER / VISION_PROVIDER select:
 *   1. TEXT      — orchestration model generates a short comment (the same kind
 *                  of text the bot types under videos).
 *   2. VISION    — vision model describes assets/vision-probe.png through the
 *                  REAL generateStructured() path used by analyzeScreenshot.
 *   3. BOX ORDER — the probe image has a red square at a KNOWN asymmetric spot
 *                  (normalized center x=150, y=775 on a 0-1000 scale). We ask
 *                  for its bounding box with the exact production request
 *                  (FIND_OBJECT_CALL, imported from interaction.ts), run 3
 *                  trials, and infer whether the model answers y-first
 *                  (Gemini-style, VISION_BOX_ORDER unset) or x-first
 *                  (Qwen-style, VISION_BOX_ORDER=xyxy). A wrong setting swaps
 *                  X/Y and every tap lands in the wrong place.
 *
 * The probe also contains a blue circle distractor at normalized (850, 375) —
 * deliberately placed so that boxing the WRONG shape matches neither axis
 * orientation of the red square's truth and reads as inconclusive, never as
 * a confident wrong verdict. If you regenerate the PNG, keep both TRUTH and
 * the distractor position in sync with this file.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PROBE_PATH = resolve(here, '../../assets/vision-probe.png');

/** Ground truth of the red square in vision-probe.png, normalized 0-1000. */
const TRUTH = { xCenter: 150, yCenter: 775 };
/**
 * Order is decided by NEAREST assignment of the two box midpoints to the truth
 * (tolerant of the moderate localization bias some models show — MiniMax-M3
 * places boxes ~10% low on tall images), gated so a wrong/garbage box stays
 * inconclusive instead of flipping the verdict: the winning orientation must
 * have a small total error AND beat the other orientation by 2x.
 */
const MAX_TOTAL_ERROR = 250;

const section = (title: string): void => {
  console.log(`\n${'═'.repeat(64)}\n  ${title}\n${'═'.repeat(64)}`);
};

type BoxVerdict = 'yxyx' | 'xyxy' | 'inconclusive';

interface BoxTrial {
  verdict: BoxVerdict;
  note: string;
  /** Signed normalized center error (model - truth) under the winning orientation. */
  xError?: number;
  yError?: number;
}

const classifyBox = (box: readonly number[], label: string): BoxTrial => {
  if (box.length !== 4) return { verdict: 'inconclusive', note: `expected 4 numbers, got ${box.length}` };
  // Guard against boxing the blue distractor (or anything that isn't the red
  // square): a wrong-shape detection must never influence the order verdict.
  if (label && !/red|square|kırmızı|kare/i.test(label)) {
    return { verdict: 'inconclusive', note: `boxed the wrong object ("${label}")` };
  }
  const [a, b, c, d] = box;
  if (box.some((v) => v > 1000)) {
    return { verdict: 'inconclusive', note: `values exceed 1000 (${box.join(', ')}) — model answered in PIXELS, not 0-1000` };
  }
  const mid1 = (a + c) / 2; // y-center if y-first, x-center if x-first
  const mid2 = (b + d) / 2;
  const dYFirst = Math.abs(mid1 - TRUTH.yCenter) + Math.abs(mid2 - TRUTH.xCenter);
  const dXFirst = Math.abs(mid1 - TRUTH.xCenter) + Math.abs(mid2 - TRUTH.yCenter);
  const yFirstWins = dYFirst <= dXFirst;
  const [dWin, dLose] = yFirstWins ? [dYFirst, dXFirst] : [dXFirst, dYFirst];
  if (dWin > MAX_TOTAL_ERROR || dWin * 2 > dLose) {
    return { verdict: 'inconclusive', note: `centers (${mid1.toFixed(0)}, ${mid2.toFixed(0)}) too far from truth in both orientations (y=${TRUTH.yCenter}, x=${TRUTH.xCenter})` };
  }
  return yFirstWins
    ? { verdict: 'yxyx', note: `y-first (Gemini-style), total |error| ${dWin.toFixed(0)}`, yError: mid1 - TRUTH.yCenter, xError: mid2 - TRUTH.xCenter }
    : { verdict: 'xyxy', note: `x-first (Qwen-style), total |error| ${dWin.toFixed(0)}`, yError: mid2 - TRUTH.yCenter, xError: mid1 - TRUTH.xCenter };
};

const main = async (): Promise<void> => {
  console.log(`AI_PROVIDER=${ACTIVE_PROVIDER}  VISION_PROVIDER=${VISION_PROVIDER}`);
  console.log(`VISION_BOX_ORDER=${process.env.VISION_BOX_ORDER ?? '(unset → yxyx / y-first)'}`);
  let failed = false;

  // ── 1. TEXT: orchestration model writes a comment ──────────────────
  section('1/3 TEXT — orchestration model (llm)');
  try {
    const language = process.env.COMMENT_LANGUAGE ?? 'English';
    // Same cap the production agent loop uses on this provider — thinking
    // tokens count against max_tokens on Anthropic-style APIs, so a tight
    // budget here would test something production never does.
    const { text, finishReason } = await generateText({
      model: llm,
      maxOutputTokens: 8192,
      prompt:
        `Write ONE casual, natural ${language} comment (max 8 words) for a skincare video. ` +
        `Reply with only the comment text, nothing else.`,
    });
    if (text.trim()) {
      console.log(`✅ comment: "${text.trim()}"`);
    } else {
      failed = true;
      console.error(`❌ model returned EMPTY text (finishReason: ${finishReason})`);
    }
  } catch (error) {
    failed = true;
    console.error(`❌ text generation failed:`, error instanceof Error ? error.message : error);
  }

  // ── 2. VISION: image understanding through generateStructured ──────
  const probeBase64 = readFileSync(PROBE_PATH).toString('base64');
  section('2/3 VISION — image understanding (visionLlm)');
  try {
    const analysis = await generateStructured({
      messages: [
        { role: 'system', content: 'You are a visual LLM for object detection and spatial understanding.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What shapes do you see in this image, and roughly where are they?' },
            { type: 'image', image: `data:image/png;base64,${probeBase64}` },
          ],
        },
      ],
      schema: z.object({ result: z.string().describe('Short description of the shapes and their locations') }),
      schemaName: 'analysis_screenshot',
    });
    const mentionsBoth = /red|kırmızı/i.test(analysis.result) && /blue|mavi/i.test(analysis.result);
    console.log(`${mentionsBoth ? '✅' : '⚠️ '} model sees: ${analysis.result}`);
    if (!mentionsBoth) console.log('   (expected it to mention both the red square and the blue circle)');
  } catch (error) {
    failed = true;
    console.error(`❌ vision call failed:`, error instanceof Error ? error.message : error);
    console.error('   If this is MiniMax: image input requires MiniMax-M3 — M2.x models are text-only.');
  }

  // ── 3. BOX ORDER: calibrate coordinate ordering ─────────────────────
  section('3/3 BOX ORDER — bounding-box calibration (visionLlm)');
  const verdicts: BoxVerdict[] = [];
  const trials: BoxTrial[] = [];
  for (let trial = 1; trial <= 3; trial++) {
    try {
      const detection = await generateStructured({
        messages: [
          { role: 'system', content: FIND_OBJECT_CALL.systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Find the red square.' },
              { type: 'image', image: `data:image/png;base64,${probeBase64}` },
            ],
          },
        ],
        schema: FIND_OBJECT_CALL.schema,
        schemaName: FIND_OBJECT_CALL.schemaName,
        schemaDescription: FIND_OBJECT_CALL.schemaDescription,
      });
      if (!detection.found || detection.box_2d.length !== 4) {
        verdicts.push('inconclusive');
        console.log(`   trial ${trial}: ❓ not found (${detection.another_response ?? 'no box returned'})`);
        continue;
      }
      const trialResult = classifyBox(detection.box_2d, detection.label);
      verdicts.push(trialResult.verdict);
      trials.push(trialResult);
      console.log(`   trial ${trial}: [${detection.box_2d.join(', ')}] → ${trialResult.verdict} (${trialResult.note})`);
    } catch (error) {
      verdicts.push('inconclusive');
      console.error(`   trial ${trial}: ❌`, error instanceof Error ? error.message : error);
    }
  }

  const count = (v: BoxVerdict): number => verdicts.filter((x) => x === v).length;
  section('RESULT');

  // Localization quality (independent of ordering): how far off are the
  // returned centers? A mean error above ~8% of the screen means real taps
  // can land on the WRONG control — the hybrid setup (VISION_PROVIDER=google)
  // is the escape hatch if on-device taps miss.
  const measured = trials.filter((t) => t.xError !== undefined && t.yError !== undefined);
  if (measured.length > 0) {
    const mean = (values: number[]): number => values.reduce((s, v) => s + v, 0) / values.length;
    const meanX = mean(measured.map((t) => t.xError ?? 0));
    const meanY = mean(measured.map((t) => t.yError ?? 0));
    const quality = Math.max(Math.abs(meanX), Math.abs(meanY)) <= 80 ? '✅' : '⚠️ ';
    console.log(`${quality} localization bias (normalized 0-1000, signed): x ${meanX.toFixed(0)}, y ${meanY.toFixed(0)}`);
    if (quality !== '✅') {
      console.log('   Boxes are noticeably offset — taps may land off-target on a real device.');
      console.log('   If taps miss in practice, run vision on Gemini: VISION_PROVIDER=google (hybrid).');
    }
  }

  if (count('yxyx') >= 2) {
    console.log('📐 Model answers Y-FIRST ([y1,x1,y2,x2], Gemini-style).');
    console.log(VISION_BOX_XY_FIRST
      ? '❌ .env has VISION_BOX_ORDER=xyxy — REMOVE it or taps will swap X/Y!'
      : '✅ VISION_BOX_ORDER is correct (unset / yxyx).');
    if (VISION_BOX_XY_FIRST) failed = true;
  } else if (count('xyxy') >= 2) {
    console.log('📐 Model answers X-FIRST ([x1,y1,x2,y2], Qwen-style).');
    console.log(VISION_BOX_XY_FIRST
      ? '✅ VISION_BOX_ORDER=xyxy is correct.'
      : '❌ Set VISION_BOX_ORDER=xyxy in .env or taps will swap X/Y!');
    if (!VISION_BOX_XY_FIRST) failed = true;
  } else {
    failed = true;
    console.log('❓ Calibration inconclusive — the model did not localize the red square consistently.');
    console.log('   Do NOT trust coordinate detection on this provider until this passes.');
  }

  process.exit(failed ? 1 : 0);
};

main().catch((error) => {
  console.error('Fatal:', error);
  process.exit(1);
});
