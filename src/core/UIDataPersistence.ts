import fs from 'fs/promises';
import path from 'path';

import { logger } from '../tools/utils.js';

import type { LearnedUIElements } from './Worker.js';

/**
 * Stored UI Data with timestamp
 */
interface StoredUIData {
  deviceId: string;
  deviceName: string;
  appId: string;
  learnedUI: LearnedUIElements;
  timestamp: number;
  version: string;
}

/**
 * UI Data Storage Structure
 */
type UIDataStorage = Record<string, StoredUIData>;

/**
 * UI Data Persistence Manager
 */
export class UIDataPersistence {
  private static readonly DATA_FILE = 'learned-ui-data.json';
  private static readonly DATA_DIR = 'data';
  private static readonly MAX_AGE_DAYS = 30;
  // Bump this whenever the LEARNING LOGIC changes how coordinates are captured or
  // verified. Saved data from an older version is then auto-rejected on load so
  // the device re-learns with the improved flow — no manual JSON deletion needed.
  //   1.0.0  legacy (LLM-transcribed coords, vision-only "did it post?")
  //   2.0.0  ledger-captured coords, objective verify, like test, send plausibility
  private static readonly CURRENT_VERSION = '2.0.0';

  /**
   * Get full path to data file
   */
  private static getDataPath(): string {
    return path.join(process.cwd(), this.DATA_DIR, this.DATA_FILE);
  }

  /**
   * Ensure data directory exists
   */
  private static async ensureDataDir(): Promise<void> {
    const dataDir = path.join(process.cwd(), this.DATA_DIR);
    try {
      await fs.access(dataDir);
    } catch {
      await fs.mkdir(dataDir, { recursive: true });
      logger.debug(`📁 Created data directory: ${dataDir}`);
    }
  }

  /**
   * Load all stored UI data
   */
  private static async loadStorageData(): Promise<UIDataStorage> {
    try {
      const dataPath = this.getDataPath();
      const data = await fs.readFile(dataPath, 'utf-8');
      return JSON.parse(data) as UIDataStorage;
    } catch (error) {
      logger.debug(`Failed to load UI data:`, error);
      return {};
    }
  }

  /**
   * Save all storage data
   */
  private static async saveStorageData(data: UIDataStorage): Promise<void> {
    await this.ensureDataDir();
    const dataPath = this.getDataPath();
    await fs.writeFile(dataPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Check if stored data is still valid (not older than MAX_AGE_DAYS)
   */
  private static isDataValid(storedData: StoredUIData): boolean {
    const now = Date.now();
    const ageInDays = (now - storedData.timestamp) / (1000 * 60 * 60 * 24);
    return ageInDays <= this.MAX_AGE_DAYS;
  }

  /**
   * Storage key — scoped per device AND per app, because each app's UI layout
   * (button coordinates) is different. Sharing a key across apps would reuse the
   * wrong coordinates after switching --app on the same device.
   */
  private static storageKey(deviceId: string, appId: string): string {
    return `${deviceId}::${appId}`;
  }

  /**
   * Load learned UI data for a specific device + app
   */
  static async loadDeviceUIData(deviceId: string, appId: string): Promise<LearnedUIElements | null> {
    try {
      const storage = await this.loadStorageData();
      const key = this.storageKey(deviceId, appId);
      let storedData = storage[key];

      // Back-compat: data written before per-app keys existed was stored under the
      // bare deviceId and is always TikTok. Adopt and migrate it under the new key
      // so upgrading users don't get forced through an unnecessary re-learn (and so
      // the deterministic initialize() -> 'working' auto-resume keeps working).
      if (!storedData && appId === 'tiktok' && storage[deviceId]) {
        storedData = { ...storage[deviceId], appId };
        storage[key] = storedData;
        delete storage[deviceId];
        await this.saveStorageData(storage);
        logger.info(`🔁 Migrated legacy UI data for device ${deviceId} to key ${key}`);
      }

      if (!storedData) {
        logger.debug(`📱 No UI data found for device: ${deviceId} (${appId})`);
        return null;
      }

      // Reject data learned by an older learning algorithm so improvements to the
      // learning stage take effect automatically (e.g. like-tap testing, send
      // plausibility) instead of being skipped because stale coordinates exist.
      if (storedData.version !== this.CURRENT_VERSION) {
        logger.info(`♻️ UI data for device ${deviceId} (${appId}) was learned by an older version (${storedData.version ?? 'unknown'} ≠ ${this.CURRENT_VERSION}); re-learning with the current flow.`);
        delete storage[key];
        await this.saveStorageData(storage);
        return null;
      }

      if (!this.isDataValid(storedData)) {
        logger.info(`⏰ UI data for device ${deviceId} (${appId}) is older than ${this.MAX_AGE_DAYS} days, will re-learn`);
        // Clean up old data
        delete storage[key];
        await this.saveStorageData(storage);
        return null;
      }

      const ageInDays = Math.floor((Date.now() - storedData.timestamp) / (1000 * 60 * 60 * 24));
      logger.info(`✅ Loaded UI data for device ${deviceId} (${appId}, ${ageInDays} days old)`);

      return storedData.learnedUI;
    } catch (error) {
      logger.error(`❌ Failed to load UI data for device ${deviceId}:`, error);
      return null;
    }
  }

  /**
   * Save learned UI data for a specific device + app
   */
  static async saveDeviceUIData(
    deviceId: string,
    deviceName: string,
    appId: string,
    learnedUI: LearnedUIElements
  ): Promise<void> {
    try {
      const storage = await this.loadStorageData();

      storage[this.storageKey(deviceId, appId)] = {
        deviceId,
        deviceName,
        appId,
        learnedUI,
        timestamp: Date.now(),
        version: this.CURRENT_VERSION,
      };

      await this.saveStorageData(storage);
      logger.info(`💾 Saved UI data for device: ${deviceName} (${deviceId}, ${appId})`);

    } catch (error) {
      logger.error(`❌ Failed to save UI data for device ${deviceId}:`, error);
      throw error;
    }
  }

  /**
   * Clean up expired data for all devices
   */
  static async cleanupExpiredData(): Promise<void> {
    try {
      const storage = await this.loadStorageData();
      const deviceIds = Object.keys(storage);
      let cleanedCount = 0;

      for (const deviceId of deviceIds) {
        const storedData = storage[deviceId];
        if (!this.isDataValid(storedData)) {
          delete storage[deviceId];
          cleanedCount++;
          logger.debug(`🗑️ Cleaned up expired UI data for device: ${deviceId}`);
        }
      }

      if (cleanedCount > 0) {
        await this.saveStorageData(storage);
        logger.info(`🧹 Cleaned up ${cleanedCount} expired UI data entries`);
      }
      
    } catch (error) {
      logger.warn(`⚠️ Failed to cleanup expired UI data:`, error);
    }
  }

  /**
   * Get storage statistics
   */
  static async getStorageStats(): Promise<{
    totalDevices: number;
    validDevices: number;
    expiredDevices: number;
  }> {
    try {
      const storage = await this.loadStorageData();
      const deviceIds = Object.keys(storage);
      
      let validCount = 0;
      let expiredCount = 0;

      for (const deviceId of deviceIds) {
        const storedData = storage[deviceId];
        if (this.isDataValid(storedData)) {
          validCount++;
        } else {
          expiredCount++;
        }
      }

      return {
        totalDevices: deviceIds.length,
        validDevices: validCount,
        expiredDevices: expiredCount,
      };
      
    } catch (error) {
      logger.warn(`⚠️ Failed to get storage stats:`, error);
      return { totalDevices: 0, validDevices: 0, expiredDevices: 0 };
    }
  }
} 