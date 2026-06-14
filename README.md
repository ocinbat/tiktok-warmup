# TikTok Agent Bot - Multi-Device Vision Automation

> **Note:** This is a 3-hours hack project mostly written by an LLMs :-)

Advanced TikTok automation system with AI agents using staged architecture, Vision API, and LLM for intelligent content interaction. Supports multiple Android devices simultaneously.

![Demo](./assets/screenshot.png)

## 🎯 Concept

Agent-based system with three operational stages:
- **Initiating**: Finding and launching TikTok on device
- **Learning**: Interface analysis and button coordinate detection  
- **Working**: Main loop - viewing, liking, commenting

## 🏗️ Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  DeviceManager  │    │  AgentManager   │    │     Worker      │
│                 │    │                 │    │                 │
│ • Device Scan   │◄──►│ • Stage Control │◄──►│ • Device State  │
│ • ADB Detection │    │ • Memory Mgmt   │    │ • Task Execute  │
│ • Worker Create │    │ • Stage Transit │    │ • Status Report │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                    ┌─────────────────┐
                    │    Stages       │
                    │                 │
                    │ • initiating.ts │
                    │ • learning.ts   │
                    │ • working.ts    │
                    └─────────────────┘
                                 │
                    ┌─────────────────┐
                    │     Tools       │
                    │                 │
                    │ • interaction.ts│
                    │ • llm.ts        │
                    │ • utils.ts      │
                    └─────────────────┘
```

## 📂 Project Structure

```
/
├── src/
│   ├── core/
│   │   ├── AgentManager.ts         // manages stages (initiating, learning, working)
│   │   ├── Worker.ts               // worker for specific device
│   │   └── DeviceManager.ts        // scans devices and starts workers
│   │
│   ├── stages/
│   │   ├── initiating.ts           // find TikTok, launch, wait for ready state
│   │   ├── learning.ts             // determine coordinates of like, comment, etc.
│   │   └── working.ts              // main loop - watch, like, occasionally comment
│   │
│   ├── tools/
│   │   ├── interaction.ts          // AI-powered screen interaction wrapper
│   │   ├── utils.ts                // sleep, random, logging, etc.
│   │   ├── llm.ts                  // LLM integration stub
│   │
│   ├── config/
│   │   └── presets.ts              // settings - comment frequency, phrase lists, etc.
│   │
│   └── index.ts                    // startup: scan devices and launch AgentManager
├── package.json
└── tsconfig.json
```

## 🔄 Stage Flow

### 1. **Device Detection & Worker Creation**
```
┌─ DeviceManager.getDevices()
├─ Scan ADB devices
├─ Create Worker for each device
├─ Pass Worker to AgentManager
└─ Start first stage: initiating
```

### 2. **Stage 1: Initiating**
```
┌─ Worker status: 'initiating'
├─ Launch TikTok via adb
├─ Screenshot + UI analysis readiness check
├─ Wait for full interface loading
└─ Transition to stage: learning
```

### 3. **Stage 2: Learning**
```
┌─ Worker status: 'learning'
├─ Series of main screen screenshots
├─ UI analysis button search:
│  ├─ Like button (coordinates x, y)
│  ├─ Comment button (coordinates x, y)
│  ├─ Comment input field (coordinates x, y)
│  ├─ Send button (coordinates x, y)
│  └─ Close button (coordinates x, y)
├─ Save coordinates to WorkerMemory
├─ Test interaction (verify buttons work)
└─ Transition to stage: working
```

### 4. **Stage 3: Working (Main Loop)**
```
For each video in infinite loop:
┌─ Worker status: 'working'
├─ ⏱️ Watch video (5-10 sec normal, 1 sec quick skip 20% chance)
├─ 🎲 Random decision:
│  ├─ 70% chance: Like (uses saved coordinates)
│  └─ 10% chance: Comment
│     ├─ AI comment generation or template
│     ├─ Tap comment input
│     ├─ Enter text
│     └─ Tap send button
├─ 📱 Swipe to next video
├─ 🩺 Health check every 10th video
├─ 🕵️ Shadow ban detection every 20th video
├─ 📊 Update Worker statistics
└─ Repeat cycle
```

## 🛠️ Technology Stack

### **Core Management**
- **AgentManager**: Stage orchestration and transitions
- **Worker**: Individual agent per device
- **DeviceManager**: Android device discovery and management

### **Screen Analysis**
- **Coordinate Detection**: Precise pixel coordinates for interaction using Gemini Vision API
- **UI State Recognition**: Application state determination

### **Language Model**
- **Google Gemini LLM**: Natural comment generation based on video content
- **Template System**: Combination of templates and AI generation
- **Context Awareness**: Video content adaptation

### **Device Control**
- **ADB Integration**: Direct Android device control
- **Screen Automation**: Touch, swipe, type interactions
- **App Management**: Launch, screenshot, state monitoring

## 🚀 Setup & Installation

### Prerequisites
```bash
# 1. Android SDK / ADB tools
# 2. Node.js 18+ / TypeScript
# 3. Android devices with USB debugging
# 4. Google Gemini API key
```

### Installation
```bash
# Clone project
git clone <repository>
cd tiktok-bot
pnpm install

# Setup environment
cp .env.example .env
# Add API key (default provider is Google Gemini):
# GOOGLE_GENERATIVE_AI_API_KEY=your_gemini_api_key_here
```

### AI Providers (multi-provider)

The bot talks to a single language model, selected with the `AI_PROVIDER` env var.
Leave it unset to keep the original Google Gemini behavior. Supported values:

| `AI_PROVIDER` | Backend | Required env | Notes |
|---|---|---|---|
| `google` *(default)* | Google Gemini | `GOOGLE_GENERATIVE_AI_API_KEY` | Original behavior, unchanged |
| `minimax` | MiniMax | `MINIMAX_API_KEY` | See vision note below |
| `anthropic` | Anthropic Claude | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | |
| `openai-compatible` | Any OpenAI-style API | `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_MODEL` | OpenRouter, local servers, etc. |

> ⚠️ **Vision is required.** This bot drives the UI by sending device screenshots
> to the model, so the selected model **must accept image input**. For MiniMax,
> only **`MiniMax-M3`** is multimodal — `MiniMax-M2` / `M2.1` will not work.

**MiniMax (Coding / Token Plan):**
```bash
AI_PROVIDER=minimax
MINIMAX_API_KEY=your_subscription_key   # from the MiniMax Coding/Token Plan
MINIMAX_MODEL=MiniMax-M3                 # only vision-capable MiniMax model
MINIMAX_API_STYLE=anthropic             # subscription key uses the Anthropic-compatible endpoint
# China mainland users: MINIMAX_BASE_URL=https://api.minimaxi.com/anthropic/v1
```
Use `MINIMAX_API_STYLE=openai` instead if you are billing a pay-as-you-go
platform key against `https://api.minimax.io/v1`.

See `.env.example` for every variable. All providers are wired through the AI
SDK in `src/config/providers.ts`.

### Device Setup
```bash
# Enable Developer Options + USB Debugging on Android
# Connect devices and authorize computer
adb devices  # Should list all connected devices

```

## ▶️ Usage

### Choosing the app (TikTok / Instagram)
The same engine drives either app — both are vertical video feeds (TikTok For You,
Instagram Reels). Select one with `--app`; it defaults to `tiktok`.

```bash
pnpm start                       # TikTok (default)
pnpm start --app tiktok          # TikTok, explicit
pnpm start --app instagram       # Instagram Reels
```

| `--app` | App | Package | Notes |
|---|---|---|---|
| `tiktok` *(default)* | TikTok | `com.zhiliaoapp.musically` | Opens straight into the For You feed |
| `instagram` | Instagram | `com.instagram.android` | Agent navigates to the **Reels** tab after launch |

App-specific differences (package, load time, feed name, navigation) live in
[`src/config/apps.ts`](src/config/apps.ts). Learned UI coordinates are cached
per **device + app**, so switching apps re-learns the layout once instead of
reusing the wrong button positions.

> The target app must be **installed and logged in** on the device. For Instagram,
> make sure the account can open Reels.

### Automatic Multi-Device
```bash
# Run on all connected devices (TikTok by default, or add --app instagram)
pnpm start

# System automatically:
# 1. Finds all Android devices
# 2. Creates Worker for each
# 3. Runs parallel agents
# 4. Goes through stages: initiating → learning → working
```

### Manual Single Device
```bash
# Run on specific device
pnpm start --device <device_id>

# Instagram on a specific device
pnpm start --app instagram --device <device_id>

# Debugging with detailed logs
pnpm run dev          # equivalent to: pnpm start --debug
```

## 🔧 Configuration

### Behavioral Presets
```typescript
// src/config/presets.ts
export const AUTOMATION_PRESETS = {
  video: {
    watchDuration: [5, 10],       // Random viewing time (seconds)
    quickSkipChance: 0.2,         // 20% chance quick skip (1 second)
    quickSkipDuration: 1,         // Duration for quick skip
    scrollDelay: [1, 3],          // Delay between videos
  },
  
  interactions: {
    likeChance: 0.7,              // 70% like chance
    commentChance: 0.1,           // 10% comment chance
    dailyLimit: 500,              // Daily action limit
  },
  
  comments: {
    templates: [
      "amazing",
      "love this content", 
      "so cool",
      "great video",
      // ... more templates
    ],
    useAI: true,                  // LLM generation
    maxLength: 50,                // Maximum length
  }
};
```

### Learning Stage Behavior
The learning stage uses UI analysis to:
1. **Launch TikTok** and verify it's ready
2. **Locate UI elements** through screenshot analysis:
   - Like button (heart icon, usually right side)
   - Comment button (speech bubble icon)
3. **Learn comment flow** by practicing the sequence:
   - Click comment → wait → find input field
   - Test typing → find send button → find close button
   - Save all coordinates for working stage

### Working Stage Behavior  
The working stage implements the main automation:
1. **Video watching** with realistic durations and quick skip chances
2. **Action decisions** based on probability (like 70%, comment 10%)
3. **AI comment generation** or template selection
4. **Health checks** every 10 videos to ensure proper TikTok state
5. **Shadow ban detection** every 20 videos
6. **Adaptive delays** based on time of day and activity

## ⚠️ Known Issues

### Android Only
Currently only supports Android devices. iOS support may be added later.

## 🎛️ Advanced Features

### Multi-Account Management
- Automatic account switching
- Session isolation per device
- Rotation strategies

### Content Analysis
- Video content categorization via AI vision
- Engagement prediction
- Trend detection

### Performance Optimization
- Concurrent device management
- Resource usage monitoring
- Battery optimization awareness

## ⚠️ Production Considerations

### Daily Limits
The system implements a simple daily limit check in the working stage:
```typescript
// Check daily limits from presets.ts
const totalActions = this.stats.likesGiven + this.stats.commentsPosted;
if (totalActions >= this.presets.interactions.dailyLimit) {
  logger.info(`🛑 Daily limit reached: ${totalActions}/${this.presets.interactions.dailyLimit}`);
  return false; // Stop automation
}
```

### Error Recovery
- Automatic stage rollback
- Device disconnection handling
- App crash recovery
- Network failure resilience

### Compliance
- TikTok API rate respect
- Human-like behavior patterns
- Privacy considerations
- Terms of service adherence

## 🚦 Current Implementation Status

### ✅ Completed
- [x] **Learning stage**: AI-powered UI element detection and coordinate learning
- [x] **Working stage**: Full automation loop with realistic behavior patterns
- [x] **Configuration system**: Flexible presets for different automation strategies
- [x] **AI integration**: Gemini for UI analysis and LLM for comment generation
- [x] **Health monitoring**: Automatic checks and shadow ban detection
- [x] **Multi-device support**: Direct ADB integration for multiple devices

### 🔧 In Progress
- [ ] **Device manager**: Complete ADB integration and device lifecycle management
- [ ] **Agent manager**: Stage transition orchestration and memory persistence

### 📋 TODO
- [ ] **Error recovery**: Comprehensive error handling and recovery strategies
- [ ] **Statistics dashboard**: Real-time monitoring and analytics
- [ ] **A/B testing**: Multiple preset configurations for optimization