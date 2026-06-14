import type { AutomationPresets } from '../config/presets.js';
import { runLearningStage } from '../stages/learning.js';
import { runWorkingStage } from '../stages/working.js';
import { logger } from '../tools/utils.js';


import type { DeviceManager } from './DeviceManager.js';
import { UIDataPersistence } from './UIDataPersistence.js';

/**
 * Worker configuration
 */
export interface WorkerConfig {
  deviceId: string;
  deviceName: string;
  presets: AutomationPresets;
  deviceManager: DeviceManager;
}

/**
 * Worker health status
 */
export interface HealthStatus {
  isHealthy: boolean;
  reason?: string;
  needsRestart?: boolean;
}

/**
 * Worker statistics
 */
export interface WorkerStats {
  videosWatched: number;
  likesGiven: number;
  commentsPosted: number;
  uptime: number;
  startTime: number;
}

/**
 * Learning Results - UI coordinates learned by the agent
 */
export interface LearnedUIElements {
  likeButton?: { x: number; y: number; confidence: number; boundingBox?: { y1: number; x1: number; y2: number; x2: number } };
  commentButton?: { x: number; y: number; confidence: number; boundingBox?: { y1: number; x1: number; y2: number; x2: number } };
  commentInputField?: { x: number; y: number; confidence: number; boundingBox?: { y1: number; x1: number; y2: number; x2: number } };
  commentSendButton?: { x: number; y: number; confidence: number; boundingBox?: { y1: number; x1: number; y2: number; x2: number } };
  commentCloseButton?: { x: number; y: number; confidence: number; boundingBox?: { y1: number; x1: number; y2: number; x2: number } };
}

/**
 * Worker Stage
 */
export type WorkerStage = 'initiating' | 'learning' | 'working' | 'stopped' | 'error';

/**
 * Worker - handles automation for a single device
 * 
 * MVP Version: Basic structure without full implementation
 */
export class Worker {
  public readonly deviceId: string;
  public readonly deviceName: string;
  private readonly presets: AutomationPresets;
  
  private stats: WorkerStats;
  private isInitialized = false;
  private startTime = 0;
  private currentStage: WorkerStage = 'initiating';
  private learnedUI: LearnedUIElements = {};
  private deviceManager: DeviceManager;

  constructor(config: WorkerConfig) {
    this.deviceId = config.deviceId;
    this.deviceName = config.deviceName;
    this.presets = config.presets;
    this.deviceManager = config.deviceManager;
    this.stats = {
      videosWatched: 0,
      likesGiven: 0,
      commentsPosted: 0,
      uptime: 0,
      startTime: Date.now(),
    };

    logger.debug(`Worker created for device: ${this.deviceName} (${this.deviceId})`);
  }

  /**
   * Initialize worker
   */
  async initialize(): Promise<void> {
    logger.info(`🔧 Initializing worker for ${this.deviceName}...`);
    
    try {
      this.currentStage = 'initiating';
      
      // Load saved UI data if available
      logger.info(`📄 Loading saved UI data for ${this.deviceId}...`);
      const savedUIData = await UIDataPersistence.loadDeviceUIData(this.deviceId, this.presets.app.id);
      if (savedUIData) {
        this.learnedUI = savedUIData;
        logger.info(`✅ Loaded saved UI data for ${this.deviceName}:`, savedUIData);
        // Set stage to working since we have valid UI data
        this.currentStage = 'working';
      }
      
      this.startTime = Date.now();
      this.isInitialized = true;
      
      logger.info(`✅ Worker initialized for ${this.deviceName}`);
      
    } catch (error) {
      this.currentStage = 'error';
      logger.error(`❌ Failed to initialize worker for ${this.deviceName}:`, error);
      throw error;
    }
  }

  /**
   * Run Learning Stage - Let AI learn TikTok UI
   */
  async runLearningStage(): Promise<boolean> {

    logger.info(`🧠 Starting learning stage for ${this.deviceName}...`);
    this.currentStage = 'learning';

    try {
      const result = await runLearningStage(this.deviceId, this.deviceManager, this.presets.app);

      if (result.success && result.appLaunched) {
        // Store learned UI coordinates
        const { uiElementsFound } = result;
        
        if (uiElementsFound.likeButton.found && uiElementsFound.likeButton.coordinates) {
          this.learnedUI.likeButton = {
            ...uiElementsFound.likeButton.coordinates,
            confidence: uiElementsFound.likeButton.confidence ?? 0,
            boundingBox: uiElementsFound.likeButton.boundingBox,
          };
        }
        
        if (uiElementsFound.commentButton.found && uiElementsFound.commentButton.coordinates) {
          this.learnedUI.commentButton = {
            ...uiElementsFound.commentButton.coordinates,
            confidence: uiElementsFound.commentButton.confidence ?? 0,
            boundingBox: uiElementsFound.commentButton.boundingBox,
          };
        }
        
        if (uiElementsFound.commentInputField.found && uiElementsFound.commentInputField.coordinates) {
          this.learnedUI.commentInputField = {
            ...uiElementsFound.commentInputField.coordinates,
            confidence: uiElementsFound.commentInputField.confidence ?? 0,
            boundingBox: uiElementsFound.commentInputField.boundingBox,
          };
        }
        
        if (uiElementsFound.commentSendButton.found && uiElementsFound.commentSendButton.coordinates) {
          this.learnedUI.commentSendButton = {
            ...uiElementsFound.commentSendButton.coordinates,
            confidence: uiElementsFound.commentSendButton.confidence ?? 0,
            boundingBox: uiElementsFound.commentSendButton.boundingBox,
          };
        }
        
        if (uiElementsFound.commentCloseButton.found && uiElementsFound.commentCloseButton.coordinates) {
          this.learnedUI.commentCloseButton = {
            ...uiElementsFound.commentCloseButton.coordinates,
            confidence: uiElementsFound.commentCloseButton.confidence ?? 0,
            boundingBox: uiElementsFound.commentCloseButton.boundingBox,
          };
        }
        


        logger.info(`✅ Learning completed for ${this.deviceName}. UI elements found:`, {
          likeButton: !!this.learnedUI.likeButton,
          commentButton: !!this.learnedUI.commentButton,
          commentInputField: !!this.learnedUI.commentInputField,
          commentSendButton: !!this.learnedUI.commentSendButton,
          commentCloseButton: !!this.learnedUI.commentCloseButton,
        });

        // Save learned UI data for future use
        try {
          await UIDataPersistence.saveDeviceUIData(this.deviceId, this.deviceName, this.presets.app.id, this.learnedUI);
        } catch (error) {
          logger.warn(`⚠️ Failed to save UI data for ${this.deviceName}:`, error);
        }

        this.currentStage = result.nextStage === 'working' ? 'working' : 'learning';
        return true;
        
      } else {
        logger.warn(`⚠️ Learning stage failed for ${this.deviceName}: ${result.message}`);
        return false;
      }
      
    } catch (error) {
      this.currentStage = 'error';
      logger.error(`❌ Learning stage error for ${this.deviceName}:`, error);
      return false;
    }
  }

  /**
   * Get worker health status (MVP: basic implementation)
   */
  getHealthStatus(): HealthStatus {
    if (!this.isInitialized) {
      return {
        isHealthy: false,
        reason: 'Worker not initialized',
        needsRestart: true,
      };
    }

    // TODO: Add real health checks:
    // - Device connection
    // - TikTok app status
    // - Memory usage
    // - Error rates

    return {
      isHealthy: true,
    };
  }

  /**
   * Get worker statistics
   */
  getStats(): WorkerStats {
    return {
      ...this.stats,
      uptime: Date.now() - this.startTime,
    };
  }

  /**
   * Update statistics (for future use)
   */
  updateStats(update: Partial<Omit<WorkerStats, 'uptime' | 'startTime'>>) {
    Object.assign(this.stats, update);
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    logger.info(`🛑 Shutting down worker for ${this.deviceName}...`);
    
    try {
      // TODO: Add cleanup:
      // - Stop any running automation
      // - Save state
      // - Release device resources
      
      this.isInitialized = false;
      logger.info(`✅ Worker shutdown completed for ${this.deviceName}`);
      
    } catch (error) {
      logger.error(`❌ Error during worker shutdown for ${this.deviceName}:`, error);
      throw error;
    }
  }

  /**
   * Get device configuration
   */
  getConfig(): WorkerConfig {
    return {
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      presets: this.presets,
      deviceManager: this.deviceManager,
    };
  }

  /**
   * Check if worker is ready for automation
   */
  isReady(): boolean {
    return this.isInitialized && this.currentStage !== 'error';
  }

  /**
   * Get current worker stage
   */
  getStage(): WorkerStage {
    return this.currentStage;
  }

  /**
   * Get learned UI coordinates
   */
  getLearnedUI(): LearnedUIElements {
    return { ...this.learnedUI };
  }

  /**
   * Check if worker has completed learning stage
   */
  hasLearnedUI(): boolean {
    // commentCloseButton is intentionally NOT required: the working stage closes
    // the comment panel with the Android back button, and many apps' comment
    // panels have no visible X button to learn. Requiring it forced needless
    // re-learning and made the learning agent loop hunting for a button that
    // does not exist.
    return !!(
      this.learnedUI.likeButton &&
      this.learnedUI.commentButton &&
      this.learnedUI.commentInputField &&
      this.learnedUI.commentSendButton
    );
  }

  /**
   * Run working stage
   */
  async runWorkingStage(): Promise<boolean> {
    try {
      logger.info(`🚀 [Worker] Starting working stage for ${this.deviceName}...`);
      
      const result = await runWorkingStage(
        this.deviceId,
        this.deviceManager,
        this.presets,
        this.learnedUI,
      );
      
      if (result.success) {
        logger.info(`✅ [Worker] Working stage completed for ${this.deviceName}: ${result.message}`);
        
        // Update stats
        this.stats.videosWatched += result.videosWatched;
        this.stats.likesGiven += result.likesGiven;
        this.stats.commentsPosted += result.commentsPosted;
        
        return true;
      } else {
        logger.error(`❌ [Worker] Working stage failed for ${this.deviceName}: ${result.message}`);
        this.currentStage = 'error';
        return false;
      }
      
    } catch (error) {
      logger.error(`❌ [Worker] Working stage error for ${this.deviceName}:`, error);
      this.currentStage = 'error';
      return false;
    }
  }

  /**
   * Run Initiating Stage - Launch TikTok and ensure readiness
   */
  async runInitiatingStage(): Promise<boolean> {
    const { app } = this.presets;
    this.currentStage = 'initiating';
    logger.info(`🚀 [Worker] Initiating stage: launching ${app.displayName} on ${this.deviceName}`);
    try {
      await this.deviceManager.launchApp(this.deviceId, app.appPackage);
      logger.info(`⏳ [Worker] Waiting ${app.loadTime}s for ${app.displayName} to load`);
      await new Promise(res => setTimeout(res, app.loadTime * 1000));
      logger.info(`✅ [Worker] Initiating complete for ${this.deviceName}`);
      return true;
    } catch (error) {
      logger.error(`❌ [Worker] Failed to launch ${app.displayName} on ${this.deviceName}:`, error);
      return false;
    }
  }

  /**
   * Start full automation pipeline: Initialize → Learn → Work
   */
  async startAutomation(): Promise<void> {
    logger.info(`🚀 Starting automation pipeline for ${this.deviceName}...`);

    try {
      // Step 1: Initialize (load UI data and tools)
      if (!this.isInitialized) {
        await this.initialize();
      }
      // Step 2: Initiating stage (launch the app)
      logger.info(`🚀 Starting initiating stage for ${this.deviceName}...`);
      const initSuccess = await this.runInitiatingStage();
      if (!initSuccess) {
        const appName = this.presets.app.displayName;
        throw new Error(`Initiating stage failed: unable to launch ${appName} or wait for it to load. Ensure USB debugging is authorized and ${appName} is installed.`);
      }

      // Step 2: Learning Stage (skip if we have valid saved data)
      if (!this.hasLearnedUI()) {
        logger.info(`🧠 UI data not found or incomplete, starting learning stage for ${this.deviceName}...`);
        const learningSuccess = await this.runLearningStage();
        
        if (!learningSuccess) {
          throw new Error('Learning stage failed');
        }
      } else {
        logger.info(`⚡ Skipping learning stage for ${this.deviceName} - using saved UI data`);
        this.currentStage = 'working';
      }

      // Step 3: Working Stage 
      if (this.currentStage === 'working') {
        logger.info(`📱 ${this.deviceName} ready for automation with learned UI:`, this.learnedUI);
        await this.runWorkingStage();
      }

    } catch (error) {
      this.currentStage = 'error';
      logger.error(`❌ Automation pipeline failed for ${this.deviceName}:`, error);
      throw error;
    }
  }
} 