import 'dotenv/config';

import { z } from 'zod';

import { getAppProfile, isAppId } from '../config/apps.js';
import { DeviceManager } from '../core/DeviceManager.js';
import { interpretFollowState } from '../stages/working.js';
import { interactWithScreen } from '../tools/interaction.js';
import { logger } from '../tools/utils.js';

/**
 * One-off harness to iterate on the niche-FOLLOW flow in isolation.
 *
 * It runs against WHATEVER is on screen right now, so:
 *   1. Open the app and land on a Reels/For You video of a creator you do NOT
 *      follow yet.
 *   2. Run this script. It will: read the follow button → FOLLOW → verify →
 *      UNFOLLOW (to leave no trace) → verify restored.
 *
 * It deliberately reuses the SAME app hints (apps.ts) and interpretFollowState()
 * as the real bot, but spells the step prompts out HERE so we can tweak them
 * quickly and then port the winners back into src/stages/working.ts.
 *
 * Usage:
 *   pnpm test-follow                 # instagram, first device, self-restores
 *   pnpm test-follow --app tiktok    # test TikTok follow instead
 *   pnpm test-follow --device R5..    # target a specific device id
 *   pnpm test-follow --no-unfollow   # follow and STOP (leave it followed)
 *   pnpm test-follow --force         # run even if already following (will unfollow→refollow)
 */

interface Args {
  app: string;
  device?: string;
  unfollow: boolean;
  force: boolean;
}

const parseArgs = (): Args => {
  const argv = process.argv.slice(2);
  const args: Args = { app: 'instagram', unfollow: true, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--app') args.app = argv[++i] ?? args.app;
    else if (a === '--device') args.device = argv[++i];
    else if (a === '--no-unfollow') args.unfollow = false;
    else if (a === '--force') args.force = true;
  }
  return args;
};

const section = (title: string): void => {
  console.log(`\n${'═'.repeat(64)}\n  ${title}\n${'═'.repeat(64)}`);
};

/** Read-only: find the follow control and report its EXACT text. */
const ReadSchema = z.object({
  followButtonText: z.string().describe('EXACT text on the follow button/control, copied verbatim (e.g. "Takip Et", "Takip", "Follow", "Following"). "" if none/unreadable.'),
  onFeed: z.boolean().describe('true if we are on the normal full-screen video feed (not a profile page / other screen)'),
  note: z.string().describe('short note on what you see'),
});

/** Tap result. */
const TapSchema = z.object({
  tapped: z.boolean().describe('true if you tapped the follow control'),
  buttonTextAfter: z.string().describe('the follow button text AFTER the tap, verbatim'),
  note: z.string().describe('short note on what happened (popups, profile opened, etc.)'),
});

async function main(): Promise<void> {
  const args = parseArgs();
  if (!isAppId(args.app)) {
    console.error(`❌ Invalid --app "${args.app}". Use: tiktok or instagram.`);
    process.exit(1);
  }
  const app = getAppProfile(args.app);
  const dm = new DeviceManager();

  const devices = await dm.getConnectedDevices(true);
  if (devices.length === 0) {
    console.error('❌ No devices. Connect a phone with USB debugging and open the app on a creator video.');
    process.exit(1);
  }
  const device = args.device ? devices.find((d) => d.id === args.device) : devices[0];
  if (!device) {
    console.error(`❌ Device "${args.device}" not found. Connected: ${devices.map((d) => d.id).join(', ')}`);
    process.exit(1);
  }
  const deviceId = device.id;

  console.log(`\n📱 Device: ${device.name} (${deviceId})`);
  console.log(`🎯 App: ${app.displayName}   | self-restore (unfollow after): ${args.unfollow}`);
  console.log(`\nℹ️  followStateHint:\n   ${app.followStateHint}`);
  console.log(`\nℹ️  followButtonHint:\n   ${app.followButtonHint}`);

  // ── helper: read current follow state ──────────────────────────────────────
  const readState = async (label: string): Promise<{ text: string; following: boolean | undefined; onFeed: boolean }> => {
    section(`READ STATE — ${label}`);
    const prompt = `You are inspecting an ${app.displayName} screen. Find the FOLLOW button/control for the creator of the CURRENT video and read its text.

**Steps (do NOT tap anything — read only):**
1. take_and_analyze_screenshot(query="Find the follow button/control for this creator and read the EXACT text on it, copied letter-for-letter (e.g. Takip Et, Takip, Follow, Following). Also: are we on the normal full-screen video feed?", action="answer_question")
2. finish_task with followButtonText (verbatim), onFeed, and a note.

${app.followStateHint}

**CRITICAL: call finish_task as the final step.**`;
    const r = await interactWithScreen<z.infer<typeof ReadSchema>>(prompt, deviceId, dm, {}, ReadSchema);
    const following = interpretFollowState(r.followButtonText);
    console.log(`   → buttonText : "${r.followButtonText}"`);
    console.log(`   → interpreted: ${following === undefined ? 'UNKNOWN (model said alreadyFollowing=?)' : following ? 'ALREADY FOLLOWING' : 'NOT following'}`);
    console.log(`   → onFeed     : ${r.onFeed}   | note: ${r.note}`);
    return { text: r.followButtonText, following, onFeed: r.onFeed };
  };

  // ── helper: tap the follow control to toggle (follow or unfollow) ──────────
  const tapToggle = async (intent: 'follow' | 'unfollow'): Promise<z.infer<typeof TapSchema>> => {
    section(`ACTION — ${intent.toUpperCase()}`);
    const want =
      intent === 'follow'
        ? 'We want to FOLLOW this creator. Tap the control that currently reads the NOT-following text ("Takip Et" / "Follow").'
        : 'We want to UNFOLLOW this creator (revert the test). Tap the control that currently reads the ALREADY-following text ("Takip" / "Following"). If a confirmation popup appears (e.g. "Takibi Bırak" / "Unfollow"), tap it to confirm.';
    const prompt = `You are an ${app.displayName} automation agent. ${want}

${app.followButtonHint}

**Steps:**
1. tap_element(query="the follow control for this creator, as described above") — tap it ONCE. Do NOT tap the avatar photo / username (that opens the profile).
2. If a confirmation dialog appears, tap the confirming option.
3. take_and_analyze_screenshot(query="Read the follow button text now, verbatim. Are we still on the normal video feed?", action="answer_question")
4. RECOVERY: if a profile page or other screen opened, pressKey(keycode="back") (up to twice) to return to the video feed.
5. finish_task with tapped, buttonTextAfter (verbatim), and a note.

**CRITICAL: end on the video feed, then call finish_task.**`;
    const r = await interactWithScreen<z.infer<typeof TapSchema>>(prompt, deviceId, dm, {}, TapSchema);
    console.log(`   → tapped: ${r.tapped} | buttonTextAfter: "${r.buttonTextAfter}" | note: ${r.note}`);
    return r;
  };

  // ── flow ───────────────────────────────────────────────────────────────────
  const start = await readState('initial');

  if (start.following === true && !args.force) {
    console.log('\n⚠️  Already following this creator. Skipping so we do not unfollow a real follow.');
    console.log('   (Open a creator you do NOT follow, or pass --force to run the unfollow→refollow cycle.)');
    return;
  }

  // FOLLOW
  await tapToggle('follow');
  const afterFollow = await readState('after FOLLOW');
  const followWorked = afterFollow.following === true;
  console.log(`\n${followWorked ? '✅' : '❌'} FOLLOW ${followWorked ? 'confirmed' : 'NOT confirmed'} (button now "${afterFollow.text}")`);

  if (!args.unfollow) {
    console.log('\n🛑 --no-unfollow set: leaving the account FOLLOWED. Done.');
    return;
  }

  // UNFOLLOW (restore)
  await tapToggle('unfollow');
  const afterUnfollow = await readState('after UNFOLLOW (restore)');
  const restored = afterUnfollow.following === false;
  console.log(`\n${restored ? '✅' : '❌'} UNFOLLOW ${restored ? 'confirmed (back to original state)' : 'NOT confirmed'} (button now "${afterUnfollow.text}")`);

  section('SUMMARY');
  console.log(`  initial      : "${start.text}" (${start.following === false ? 'not following' : start.following})`);
  console.log(`  after follow : "${afterFollow.text}" → ${followWorked ? 'FOLLOWED ✅' : 'FAILED ❌'}`);
  console.log(`  after restore: "${afterUnfollow.text}" → ${restored ? 'RESTORED ✅' : 'FAILED ❌'}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error('test-follow failed:', err);
    process.exit(1);
  });
