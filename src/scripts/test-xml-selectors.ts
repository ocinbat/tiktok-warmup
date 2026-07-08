/**
 * Selector smoke-test: verify the app's deterministic uiautomator selectors
 * against the LIVE device — no vision calls, no likes/comments posted.
 *
 *   pnpm test-selectors                     # TikTok on the first device
 *   pnpm test-selectors --app instagram     # Instagram
 *   pnpm test-selectors --app instagram --device <id>
 *
 * What it does: launches the app, deterministically navigates to the video
 * feed via the `feedTab` selector (the only tap it performs), then resolves
 * every role declared in the profile's xmlSelectors and prints hit/miss with
 * exact bounds. Run this after an app update to catch selector drift before
 * the bot mis-taps anything.
 */

import 'dotenv/config';

import { getAppProfile, isAppId, type UiElementRole } from '../config/apps.js';
import { DeviceManager } from '../core/DeviceManager.js';
import { findUiElement, screenSizeFromUiTree } from '../tools/uiTree.js';
import { logger } from '../tools/utils.js';

const argValue = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const appArg = argValue('--app');
const app = getAppProfile(isAppId(appArg) ? appArg : undefined);

const main = async (): Promise<void> => {
  const deviceManager = new DeviceManager();
  const devices = await deviceManager.getConnectedDevices(true);
  const deviceId = argValue('--device') ?? devices[0]?.id;
  if (!deviceId) throw new Error('No connected device found (adb devices is empty).');

  logger.info(`🌳 Selector smoke-test: ${app.displayName} on ${deviceId}`);

  // Launch and reach the feed deterministically (feedTab is the only tap).
  await deviceManager.launchApp(deviceId, app.appPackage);
  await new Promise((r) => setTimeout(r, app.loadTime * 1000));

  let xml = await deviceManager.dumpViewHierarchy(deviceId);
  if (!xml) throw new Error('View hierarchy dump came back empty — is the screen on and unlocked?');

  const markerSel = app.xmlSelectors.feedMarker;
  const tabSel = app.xmlSelectors.feedTab;
  if (markerSel && !findUiElement(xml, markerSel) && tabSel) {
    const tab = findUiElement(xml, tabSel);
    if (tab?.center) {
      logger.info(`🌳 Not on the ${app.feedName} — tapping the feed tab at (${tab.center.x}, ${tab.center.y})`);
      await deviceManager.tapScreen(deviceId, tab.center.x, tab.center.y);
      await new Promise((r) => setTimeout(r, 3000));
      xml = await deviceManager.dumpViewHierarchy(deviceId);
    }
  }

  const screen = screenSizeFromUiTree(xml);
  logger.info(`🌳 Screen (from hierarchy): ${screen ? `${screen.width}x${screen.height}` : 'unknown'}`);

  let misses = 0;
  const roles = Object.keys(app.xmlSelectors) as UiElementRole[];
  for (const role of roles) {
    const selector = app.xmlSelectors[role];
    if (!selector) continue;
    const el = findUiElement(xml, selector);
    if (el?.center && el.bounds) {
      const label = el.contentDesc || el.text || el.resourceId;
      logger.info(`  ✅ ${role.padEnd(18)} → (${el.center.x}, ${el.center.y})  [${el.bounds.x1},${el.bounds.y1}][${el.bounds.x2},${el.bounds.y2}]  "${label}"`);
    } else {
      // Some roles are legitimately absent outside their context (comment panel
      // roles only exist while the panel is open; send only once text is typed).
      const contextual = role === 'commentInputField' || role === 'commentSendButton';
      if (contextual) {
        logger.info(`  ⏭️ ${role.padEnd(18)} → not on this screen (only visible inside the comment panel) — OK`);
      } else {
        misses++;
        logger.warn(`  ❌ ${role.padEnd(18)} → NO MATCH — selector drift? Check with: adb shell uiautomator dump`);
      }
    }
  }

  if (misses === 0) {
    logger.info(`✅ All feed-context selectors resolved for ${app.displayName}.`);
  } else {
    logger.warn(`⚠️ ${misses} selector(s) did not resolve — the bot will fall back to vision for those.`);
    process.exitCode = 1;
  }
};

main().catch((error) => {
  logger.error('Selector smoke-test failed:', error);
  process.exitCode = 1;
});
