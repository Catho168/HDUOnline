/**
 * 全量数据导出（第 250 轮巡检，数据自主权域 / 备份视角）——轻量 JSON 资产导出。
 *
 * 与既有「全量备份 ZIP」（exporters.exportBackup，dashboard 数据管理页，导入通道）
 * 的分工（探查结论记巡检日志第 250 轮）：
 *  - 全量备份 ZIP：IndexedDB 全 store 逐段（含 watchRecords / transcripts 明细），
 *    服务「换机 / 重装恢复」，配套 import.run 校验写回；
 *  - 本导出（data.exportAll）：**白名单式字段收集**的用户资产快照——收藏 / 笔记 /
 *    复习 / 周计划 / 偏好设置等小体积自产内容，供用户查阅、留档与自主持有；
 *    **不用于导入恢复**（app 标识与备份不同 → import.parseBackupPayload 按
 *    `app !== BACKUP_APP_ID` 直接拒绝，防止 replace 模式误清转写等派生库）。
 *
 * 排除清单（每项理由，见 EXPORT_DATA_EXCLUDED 注释）：trash（30 天瞬态）、
 * watchRecords / externalWatch（逐条流水体积大，周报/月报已有聚合出口）、
 * transcripts / aiResults / chats / screenshots（大体积派生物，全量备份 ZIP 已覆盖）、
 * asrJobs / asrChunks / kv / exportJobs（可再生 / 瞬态）。
 *
 * 纯函数约定：本模块不触库、不取 Date.now()——「导出时刻」由调用方经 now 传入；
 * 数据段由调用方（background op 直调各 repo）收集后传入组装。
 */

/** 导出文件的应用标识（**与备份 BACKUP_APP_ID 不同**：导入通道据此拒绝本文件） */
export const DATA_EXPORT_APP_ID = 'hduonline-data-export';

/** 导出文件格式版本（结构变化时递增；当前首版） */
export const DATA_EXPORT_VERSION = 1;

/**
 * 导出文件名：`HDUOnline_全量备份_YYYY-MM-DD.json`（now 非有限 → 契约违约抛错，
 * 与 period.periodBuckets 同约定）。
 */
export function buildExportFilename(now: number): string {
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new Error('buildExportFilename: now 必须是有限毫秒时间戳（由调用方注入）');
  }
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `HDUOnline_全量备份_${y}-${m}-${day}.json`;
}

/** 导出数据的段名白名单（= DataExportPayload.data 的键全集，单元测试守护） */
export const EXPORT_DATA_SEGMENTS = [
  'favorites',
  'folders',
  'tags',
  'notes',
  'reviewJobs',
  'weeklyPlans',
  'courses',
  'sessions',
  'videoProgress',
  'curriculum',
] as const satisfies ReadonlyArray<string>;

export type ExportDataSegment = (typeof EXPORT_DATA_SEGMENTS)[number];

/** 偏好设置快照的顶层键白名单（AppSettings 全键显式枚举；未来新增敏感键不会自动泄出） */
export const EXPORT_SETTINGS_KEYS = [
  'modules',
  'contextWindow',
  'idleThresholdMin',
  'finishThreshold',
  'missDelayHours',
  'weeklyGoalHours',
  'dailyGoalMin',
  'achievementGoalScale',
  'review',
  'todo',
  'shortcuts',
  'theme',
  'screenshotWatermark',
  'captionStyle',
  'asr',
  'llm',
  'ui',
] as const satisfies ReadonlyArray<string>;

export interface DataExportPayload {
  /** 导出文件格式版本 */
  version: number;
  /** 应用标识（data-export 专用值，导入通道按 app 不匹配拒绝） */
  app: string;
  /** 导出类型标记（人类可读；机器判定以 app 为准） */
  kind: 'data-export';
  /** 导出时刻 ISO 字符串 */
  exportedAt: string;
  /** 各数据段条目数（UI toast 摘要与按钮副文案用） */
  counts: Record<string, number>;
  /** 白名单数据段 */
  data: Record<ExportDataSegment, unknown[]> & { settings: Record<string, unknown> };
}

/** 输入段（调用方从各 repo 收集的原始数组；非数组 / 脏元素在组装时防御处理） */
export interface AssembleExportInput {
  favorites?: unknown[];
  folders?: unknown[];
  tags?: unknown[];
  notes?: unknown[];
  reviewJobs?: unknown[];
  weeklyPlans?: unknown[];
  courses?: unknown[];
  sessions?: unknown[];
  videoProgress?: unknown[];
  curriculum?: unknown[];
  /** 偏好设置对象（顶层键按 EXPORT_SETTINGS_KEYS 白名单挑选；null / 非对象 → 空对象） */
  settings?: unknown;
  /** 导出时刻毫秒时间戳（必填：纯函数约定） */
  now: number;
}

/** 非数组 → []；数组内保留对象元素（非对象 / null / 数组元素丢弃——实体段必为对象行） */
function sanitizeSegment(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row) => typeof row === 'object' && row !== null && !Array.isArray(row));
}

/** 偏好设置白名单挑选（顶层浅拷贝；值原样保留——AppSettings 本身不含 Key 等秘密，
 *  秘密存 chrome.storage.local 的 SecretsStore，从不进入本导出） */
function pickSettings(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  const source = value as Record<string, unknown>;
  for (const key of EXPORT_SETTINGS_KEYS) {
    if (key in source) out[key] = source[key];
  }
  return out;
}

/**
 * 组装导出 payload（纯函数）：各段清洗（非数组 → []、非对象行丢弃）→ settings 白名单
 * 挑选 → counts 汇总。now 非有限抛错。
 */
export function assembleExportPayload(input: AssembleExportInput): DataExportPayload {
  if (typeof input?.now !== 'number' || !Number.isFinite(input.now)) {
    throw new Error('assembleExportPayload: now 必须是有限毫秒时间戳（由调用方注入）');
  }
  const data: DataExportPayload['data'] = {
    favorites: sanitizeSegment(input.favorites),
    folders: sanitizeSegment(input.folders),
    tags: sanitizeSegment(input.tags),
    notes: sanitizeSegment(input.notes),
    reviewJobs: sanitizeSegment(input.reviewJobs),
    weeklyPlans: sanitizeSegment(input.weeklyPlans),
    courses: sanitizeSegment(input.courses),
    sessions: sanitizeSegment(input.sessions),
    videoProgress: sanitizeSegment(input.videoProgress),
    curriculum: sanitizeSegment(input.curriculum),
    settings: pickSettings(input.settings),
  };
  const counts: Record<string, number> = {};
  for (const segment of EXPORT_DATA_SEGMENTS) {
    counts[segment] = data[segment].length;
  }
  counts.settings = Object.keys(data.settings).length;
  return {
    version: DATA_EXPORT_VERSION,
    app: DATA_EXPORT_APP_ID,
    kind: 'data-export',
    exportedAt: new Date(input.now).toISOString(),
    counts,
    data,
  };
}
