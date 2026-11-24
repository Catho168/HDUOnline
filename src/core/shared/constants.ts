import { DEFAULT_DAILY_GOAL_MIN } from '../plan/dailyGoal';
import type { AppSettings, CaptionStyle, ContextWindowPreset, LlmKind, SecretsStore, ShortcutMap } from './types';

// ───────────────────────── 站点常量 ─────────────────────────

export const SITE_ORIGINS = {
  campus: 'https://course.hdu.edu.cn',
  webvpn: 'https://https-course-hdu-edu-cn-443.webvpn.hdu.edu.cn',
} as const;

export const API_PREFIX = '/jy-application-resourcemanage';

// ───────────────────────── DOM 选择器 ─────────────────────────

export const SELECTORS = {
  playRoot: '.play-video',
  playMainContainer: '.play-video-main-container',
  primaryVideo: '.play-video .left-module-wrapper .player-wrapper video',
  primaryWrapper: '.left-module-wrapper .player-wrapper',
  secondaryVideo: '.second-player-container video',
  secondaryContainer: '.second-player-container',
  siteCaptionLayer: '.player-caption',
  progressBar: '.jy-control-progress',
  tabNavContent: '.tab-nav-content > .content-item',
  sessionItem: '.right-body .body-content .body-item',
  sessionItemTime: '.body-container-time',
  teacherNoteList: '.teacher-note-list',
  listCard: '.lesson-card.card-item',
  listCardTitle: '.course-title',
  playHeader: '.play-header',
  /** 播放页右栏容器（PlayPanel 停靠对位用，两代播放页通用） */
  rightRail: '.right-body',
} as const;

export const HOST_ELEMENT_ID = 'hdu-assistant-host';

// ───────────────────────── 注入式 UI 第二阶段：锚点探针 ─────────────────────────

/** anchorProbe 注入 host 自标识（重挂去重与 teardown 清理识别都靠它） */
export const ANCHOR_PROBE_HOST_MARKER = 'data-hdu-anchor-entry';

/**
 * 锚点探针候选选择器（第 24 轮「框架先行」：全部只是候选猜测，未经验证）。
 *
 * 实站勘察 JSON（scripts/hdu-dom-recon.snippet.js 采集）回填时，把对应数组
 * 换成实测选择器即可（数组顺序 = 同类内的尝试优先级；探针每轮全量重评）。
 * 证据线索来源：hdu-dom-recon.snippet.js 的 controlBar / aiCaptionWrapper / globalNav 采集分支。
 */
export const ANCHOR_PROBE_SELECTORS = {
  /** 播放器控制条（优先级最高；KMedia SDK 动态重建，需实站确认结构） */
  controlBar: [
    '.jy-control-bar',
    '.control-bar',
    '.player-controls',
    '.video-controls',
    '[class*="control-bar"]',
    '[class*="controls"]',
  ],
  /** 站点 AI 字幕模块位（语义最契合；当前可能不存在） */
  aiCaptionWrapper: ['.ai-caption-wrapper', '[class*="ai-caption"]', '[class*="aiCaption"]'],
  /** 全局导航（兜底锚点） */
  globalNav: ['header', '.header', '.nav', '[class*="navbar"]', '[class*="top-bar"]'],
} as const;

// ───────────────────────── 注入式 UI 第三阶段：B 站工具栏探针 ─────────────────────────

/** biliToolbarProbe 注入 host 自标识（重挂去重与 teardown 清理识别都靠它） */
export const BILI_TOOLBAR_PROBE_HOST_MARKER = 'data-hdu-bili-toolbar-entry';

/**
 * B 站视频页工具栏探针候选选择器（第 33 轮「框架先行」：全部只是候选猜测，未经验证）。
 *
 * 真机勘察（B 站视频页点赞/投币/收藏按钮所在的原生工具栏）回填时，把数组换成实测
 * 选择器即可（数组顺序 = 尝试优先级；探针每轮全量重评，不短路）。全部候选不命中时
 * 探针保持未挂载，B 站侧继续走现有浮层 FAB 降级，零回归。
 * 待真机勘察回填。
 */
export const BILI_TOOLBAR_PROBE_SELECTORS = {
  /** B 站视频页原生工具栏（点赞/投币/收藏按钮区域；优先级从高到低） */
  toolbar: [
    '.video-toolbar-left-main',
    '.video-toolbar-left',
    '.toolbar-left-main',
    '.video-toolbar',
    '[class*="video-toolbar"]',
  ],
} as const;

// ───────────────────────── 存储键 ─────────────────────────

export const STORAGE_KEYS = {
  settings: 'settings.v1',
  secrets: 'secrets.v1',
  logs: 'logs.v1',
  onboardingSeen: 'onboarding.v1',
} as const;

export const DB_NAME = 'hdu-assistant';
/** 演示模式并行库（第 319 轮）：演示数据写入独立数据库，真实库零接触，退出即删 */
export const DB_NAME_DEMO = 'hdu-assistant-demo';
/** v5：转写链路主键 courId → mediaKey（B 站转写专项设计 §3） */
export const DB_VERSION = 5;

export const TRASH_RETENTION_DAYS = 30;

// ───────────────────────── 默认设置 ─────────────────────────

export const DEFAULT_SHORTCUTS: ShortcutMap = {
  ask: 'q',
  favorite: 'b',
  note: 'n',
  prevTopic: '[',
  nextTopic: ']',
};

/** 站点已占用的按键：一律不抢占（站点优先） */
export const RESERVED_KEYS = new Set([
  ' ',
  'space',
  'arrowleft',
  'arrowright',
  'arrowup',
  'arrowdown',
  'f',
  'escape',
  'esc',
  'enter',
  'm',
  'c',
  'j',
  'l',
  'k',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
]);

/**
 * B 站播放器已占用的按键（第 44 轮）：B 站原生快捷键与 HDU 站点不同——
 * 空格暂停、←→ 快进退、↑↓ 音量/清晰度、f 宽屏、d 弹幕开关、m 静音、s 截图、
 * c 清晰度等。助手快捷键（q/b/n/[/]）不与其冲突，但统一走避让表兜底
 * （站点优先原则与 HDU 侧 RESERVED_KEYS 同构）。
 */
export const BILI_RESERVED_KEYS = new Set([
  ' ',
  'space',
  'arrowleft',
  'arrowright',
  'arrowup',
  'arrowdown',
  'f',
  'd',
  'm',
  's',
  'c',
  'enter',
  'escape',
  'esc',
  'tab',
]);

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  enabled: true,
  fontSize: 20,
  color: '#ffffff',
  background: 'rgba(10,14,22,0.76)',
  bottomOffset: 96,
};

export const DEFAULT_SETTINGS: AppSettings = {
  modules: { a: true, b: true, c: true, d: true, incentive: true },
  contextWindow: 'medium',
  idleThresholdMin: 15,
  finishThreshold: 0.9,
  missDelayHours: 24,
  weeklyGoalHours: 5,
  // 每日目标分钟数（第 234 轮巡检）：默认 30，clamp 规则见 core/plan/dailyGoal
  dailyGoalMin: DEFAULT_DAILY_GOAL_MIN,
  achievementGoalScale: 1,
  review: {
    template: 'regular',
    intervals: {
      regular: [1, 3, 7, 16],
      exam: [1, 2, 3, 5, 7],
      custom: [1, 3, 7],
    },
  },
  // 明日到期提醒默认关（第 243 轮巡检决策）：主动提醒默认不打扰，用户显式开启才发；
  // 触发时刻 = 每日待办提醒时刻 +30 分钟（见 alarms.ts syncDueTomorrowAlarm）
  todo: { dailyNotify: true, weeklyRecap: true, dailyNotifyHour: 20, dueTomorrowNotify: false },
  shortcuts: { ...DEFAULT_SHORTCUTS },
  theme: 'system',
  screenshotWatermark: true,
  captionStyle: { ...DEFAULT_CAPTION_STYLE },
  asr: {
    modelTier: 'standard',
    autoWarmup: true,
    autoTranscribeOnOpen: false,
    lang: 'zh',
    // 片段流式转写为默认：只转当前进度前后 windowMinutes 分钟
    windowMode: 'around',
    windowMinutes: 10,
    streamFollow: true,
  },
  llm: {
    temperature: 0.2,
    timeoutConnectMs: 15_000,
    timeoutFirstByteMs: 60_000,
    timeoutTotalMs: 300_000,
    maxRetries: 2,
  },
  ui: {
    panelCollapsed: false,
    followPlayback: true,
    showTimelineMarkers: true,
    learningCenter: true,
    centerOnPlayPage: false,
    nativeAnchor: true,
    reviewFilters: { type: 'all', template: 'all', urgency: 'all', sort: 'due', viewMode: 'list', viewRange: 7 },
  },
  debug: { logEnabled: true },
  // 演示模式（第 319 轮）：enabled = 读写切到并行演示库 hdu-assistant-demo；
  // enteredAt = 进入时刻（UI 展示用）。真实库数据不参与演示，退出即删演示库。
  demo: { enabled: false, enteredAt: 0 },
};

export const DEFAULT_SECRETS: SecretsStore = {
  providers: [],
  activeProviderId: null,
  allowLocalEndpoints: false,
  modelSource: { remoteHost: 'https://hf-mirror.com' },
  userGlossary: {},
};

// ───────────────────────── ASR 模型档位 ─────────────────────────

export type AsrModelTier = 'fast' | 'standard' | 'high';

export interface AsrModelSpec {
  tier: AsrModelTier;
  label: string;
  modelId: string;
  approxMb: number;
  webgpuDtype: 'fp16' | 'q4' | 'q8';
  wasmDtype: 'q8' | 'fp32';
  description: string;
  files: string[];
}

export const ASR_MODELS: Record<AsrModelTier, AsrModelSpec> = {
  fast: {
    tier: 'fast',
    label: '快速（base）',
    modelId: 'onnx-community/whisper-base',
    approxMb: 140,
    // WebGPU 档一律用 q4：ORT 的 WebGPU EP 在 fp16 权重上会因 LayerNorm 的
    // fp16 中间值溢出而输出空文本/循环文本（实测 whisper-base/small 均复现），
    // 且升级到 1.30 的 LayerNorm 融合后仍未覆盖这两份导出图。
    webgpuDtype: 'q4',
    wasmDtype: 'q8',
    description: '弱机器 / 只能跑 WASM 时的默认档，速度最快、准确率一般',
    files: ['onnx/encoder_model_q4.onnx', 'onnx/decoder_model_merged_q4.onnx', 'tokenizer.json', 'config.json', 'generation_config.json'],
  },
  standard: {
    tier: 'standard',
    label: '标准（small，默认）',
    modelId: 'onnx-community/whisper-small',
    approxMb: 300,
    webgpuDtype: 'q4',
    wasmDtype: 'q8',
    description: '中文课堂语音质量与速度的平衡点，WebGPU 环境推荐',
    files: [
      'onnx/encoder_model_q4.onnx',
      'onnx/decoder_model_merged_q4.onnx',
      'tokenizer.json',
      'config.json',
      'generation_config.json',
      'preprocessor_config.json',
    ],
  },
  high: {
    tier: 'high',
    label: '高精度（large-v3-turbo）',
    modelId: 'onnx-community/whisper-large-v3-turbo',
    approxMb: 1600,
    webgpuDtype: 'q4',
    wasmDtype: 'q8',
    description: '需要强劲独显与充足内存；准确率最高',
    files: [
      'onnx/encoder_model_q4.onnx',
      'onnx/decoder_model_merged_q4.onnx',
      'tokenizer.json',
      'config.json',
      'generation_config.json',
      'preprocessor_config.json',
    ],
  },
};

// ───────────────────────── 转写管线参数 ─────────────────────────

/**
 * 转写结果版本：后处理规则（时间戳兜底、静音跳过、幻觉过滤）发生变化时递增。
 * 旧版本写入的 asrChunks 会被视为不可复用，从而自动重新转写，避免旧字幕继续污染时间轴。
 */
export const ASR_PIPELINE_VERSION = 2;

export const ASR_PARAMS = {
  sampleRate: 16_000,
  headProbeBytes: 262_144,
  tailProbeBytes: 2_097_152,
  audioBatchBytes: 3_000_000,
  /** 落库分片长度：10 分钟（断点续跑与缓存复用单位） */
  chunkSec: 600,
  /** 单次 Whisper 推理切片：60 秒。时间戳异常最多影响一分钟，暂停最长等一分钟生效 */
  inferSliceSec: 60,
  /** 低于该 RMS 且峰值也很低的切片直接跳过推理（数字静音/无音轨） */
  silenceRms: 0.0012,
  silencePeak: 0.01,
  decodeFlushSec: 20,
  fullDownloadGuardBytes: 400 * 1024 * 1024,
  windowMinutesDefault: 10,
  windowMinutesMin: 2,
  windowMinutesMax: 30,
  followMinIntervalMs: 20_000,
  followBackoffBaseMs: 45_000,
  followBackoffMaxMs: 600_000,
  followMaxAttempts: 4,
  followSeekResetSec: 300,
  followCancelCooldownMs: 10 * 60_000,
  glossaryPromptLimit: 200,
} as const;

// ───────────────────────── LLM ─────────────────────────

export const PROMPT_VERSION = 1;

export const CONTEXT_WINDOW_PRESETS = {
  small: { before: 120, after: 45 },
  medium: { before: 180, after: 60 },
  large: { before: 300, after: 120 },
} as const;

/**
 * 上下文窗口档位解析（第 28 轮单份化）：per-request 显式档位优先，缺省回落全局设置。
 * qa.ask（锚点窗口）与 ai.generate（标注提示词分块档位）共用本函数，避免
 * `args.windowPreset ?? settings.contextWindow` 口径在 SW 侧出现多份实现。
 * 入参合法性由消息边界（validateOpArgs 的 windowPreset 枚举校验）与 TS 类型保证。
 */
export function resolveContextWindowPreset(
  preset: ContextWindowPreset | undefined,
  fallback: ContextWindowPreset,
): ContextWindowPreset {
  return preset ?? fallback;
}

export const LLM_TIMEOUTS = {
  connectMs: 15_000,
  firstByteMs: 60_000,
  totalMs: 300_000,
} as const;

export const PROVIDER_PRESETS: Array<{
  label: string;
  kind: LlmKind;
  baseUrl: string;
  model: string;
}> = [
  {
    label: 'Anthropic（Claude）',
    kind: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
  },
  {
    label: 'OpenAI（Chat Completions）',
    kind: 'openai-chat',
    baseUrl: 'https://api.openai.com',
    model: 'gpt-4o-mini',
  },
  {
    label: 'OpenAI（Responses API）',
    kind: 'openai-responses',
    baseUrl: 'https://api.openai.com',
    model: 'gpt-4o-mini',
  },
  {
    label: 'DeepSeek（OpenAI 兼容）',
    kind: 'openai-chat',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
  },
  {
    label: '月之暗面 Kimi',
    kind: 'openai-chat',
    baseUrl: 'https://api.moonshot.cn',
    model: 'moonshot-v1-8k',
  },
  {
    label: '硅基流动 SiliconFlow',
    kind: 'openai-chat',
    baseUrl: 'https://api.siliconflow.cn',
    model: 'Qwen/Qwen2.5-7B-Instruct',
  },
  {
    label: '本地 Ollama',
    kind: 'openai-chat',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:7b',
  },
];

export const MAX_LOG_ENTRIES = 200;

export const STATS_LIMITS = {
  dailyCapSec: 16 * 3600,
  heartbeatMs: 500,
  positionPersistSec: 5,
} as const;

// ───────────────────────── 学习中心 ─────────────────────────

export const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
