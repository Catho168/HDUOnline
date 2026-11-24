/**
 * 导出（技术文档 §7 B4）。
 *
 * 产物通过 IndexedDB 的 `exportJobs` 传递（大对象不进消息通道，§2.2），
 * 由 Dashboard / Options 页面读取后触发浏览器下载。
 *
 * 边界（§7 B4）：导出仅含**用户自产内容与可见元信息**，不含视频/音频；
 * 转写文本属于插件本地派生物，可导出但需在导出说明中标注来源。
 *
 * ── store 覆盖策略 ──
 * 全量备份按 schema 全集逐 store 决定纳入与否，清单见 BACKUP_STORES /
 * BACKUP_EXCLUDED_STORES（两条清单互补，共同覆盖 schema 的全部 store，由单元测试
 * 守护）：
 *  1) 用户学习资产（课程、收藏、笔记、转写、进度等）必须备份；screenshots 较特殊，
 *     JSON 段只放元数据（screenshotsMeta），PNG 二进制单独放 ZIP 的 screenshots/ 目录，
 *     避免把 Blob 塞进 JSON；
 *  2) 可再生 / 瞬态数据不备份（asrJobs、asrChunks、kv、trash、exportJobs），
 *     理由逐项写在 BACKUP_EXCLUDED_STORES 的注释里；
 *  3) 新增 store 时应先归入两条清单之一，再扩展 BackupPayload 与导入校验，
 *     保持"备份清单 vs schema 全集"矩阵无遗漏。
 */

import { strToU8, zipSync } from 'fflate';
import { getDb } from '../db';
import { listCourses, listSessionsByCourse } from '../db/repo/content';
import { listFavorites, listScreenshots } from '../db/repo/library';
import { listWatchRecords } from '../db/repo/stats';
import type { ExportJobRecord } from '../db/schema';
import { DB_VERSION } from '../shared/constants';
import { AppError } from '../shared/errors';
import { createLogger } from '../shared/logger';
import type { MediaKey } from '../shared/mediaRef';
import { hduCourIdOf } from '../shared/mediaRef';
import type { FavoriteFilter } from '../shared/ops';
import type { AiResultEntity, FavoriteEntity, ScreenshotEntity, SessionEntity } from '../shared/types';
import { formatClock, localDayKey, uuid } from '../shared/utils';

const log = createLogger('export');

const EXPORT_TTL_MS = 30 * 60 * 1000; // 导出包在 IDB 中保留 30 分钟

/** 备份文件格式版本（导入侧据此拒绝更高版本）。 */
export const BACKUP_FORMAT_VERSION = 1;

/** 备份文件的应用标识（导入侧据此拒绝其它来源的文件）。 */
export const BACKUP_APP_ID = 'hdu-smart-classroom-assistant';

/**
 * 必须备份的 store 清单（用户学习资产）。
 *  - screenshots：JSON 里只放元数据段（screenshotsMeta），PNG 二进制放 ZIP 的
 *    screenshots/ 目录；无二进制的 JSON 备份恢复截图时得到空占位 Blob。
 */
export const BACKUP_STORES = [
  'courses',
  'sessions',
  'transcripts',
  'aiResults',
  'chats',
  'favorites',
  'folders',
  'tags',
  'notes',
  'screenshots',
  'reviewJobs',
  'curriculum',
  'watchRecords',
  'videoProgress',
  'externalWatch',
  /** 每周回看学习计划：用户资产（学习安排），不在可再生清单里 */
  'weeklyPlans',
] as const;

/**
 * 不备份的 store 清单（可再生 / 瞬态；与 BACKUP_STORES 互补覆盖 schema 全集）。
 * 理由逐项标注，新增排除项时同样先给理由。
 */
export const BACKUP_EXCLUDED_STORES = [
  /** 转写作业状态：可随时重新发起，恢复历史作业状态反而会误导 UI */
  'asrJobs',
  /** 音频分片转写中间产物：体积大且可重转，备份收益远低于 ZIP 膨胀代价 */
  'asrChunks',
  /** 节流时间戳、面板状态、补看排除项等轻量状态键：丢失无影响，使用中自动重建 */
  'kv',
  /** 回收站：30 天瞬态数据，跨机恢复"已删除"项违背清理语义 */
  'trash',
  /** 导出/导入作业通道：30 分钟 TTL 的纯瞬态大对象，不具恢复价值 */
  'exportJobs',
] as const;

export interface ExportBuildResult {
  jobId: string;
  filename: string;
  mime: string;
  size: number;
}

async function saveJob(job: Omit<ExportJobRecord, 'createdAt' | 'expiresAt'>): Promise<ExportBuildResult> {
  const db = await getDb();
  const record: ExportJobRecord = { ...job, createdAt: Date.now(), expiresAt: Date.now() + EXPORT_TTL_MS };
  await db.put('exportJobs', record);
  return { jobId: record.id, filename: record.filename, mime: record.mime, size: record.size };
}

// ───────────────────────── 复习卡片（Markdown / 纯文本） ─────────────────────────

function favoriteTypeLabel(type: string): string {
  switch (type) {
    case 'time':
      return '时间点';
    case 'ai':
      return 'AI 回答';
    case 'outline':
      return '大纲节点';
    case 'screenshot':
      return '截图';
    case 'note':
      return '笔记';
    default:
      return '收藏';
  }
}

function buildCardsContent(favorites: FavoriteEntity[], format: 'md' | 'txt'): string {
  const lines: string[] = [];
  const exportedAt = new Date().toLocaleString('zh-CN');
  if (format === 'md') {
    lines.push('# 复习卡片\n');
    lines.push(`> 导出时间：${exportedAt}；共 ${favorites.length} 条。`);
    lines.push('> 来源：杭电智慧课堂学习助手（本地数据）。\n');
  } else {
    lines.push(`复习卡片（导出时间 ${exportedAt}，共 ${favorites.length} 条）\n`);
  }
  for (const fav of favorites) {
    const time = fav.anchorTime !== undefined ? formatClock(fav.anchorTime) : '';
    if (format === 'md') {
      lines.push(`## ${fav.snapshot.title}`);
      lines.push(`- 类型：${favoriteTypeLabel(fav.type)}${time ? ` ｜ 时间点：${time}` : ''}`);
      if (fav.tags.length > 0) lines.push(`- 标签：${fav.tags.join('、')}`);
      if (fav.note) lines.push(`- 备注：${fav.note}`);
      lines.push('');
      lines.push(fav.snapshot.content);
      lines.push('\n---\n');
    } else {
      lines.push(`【${fav.snapshot.title}】${favoriteTypeLabel(fav.type)}${time ? ` @${time}` : ''}`);
      lines.push(fav.snapshot.content);
      if (fav.note) lines.push(`备注：${fav.note}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

export async function exportCardsMarkdown(filter: FavoriteFilter = {}, format: 'md' | 'txt' = 'md'): Promise<ExportBuildResult> {
  const favorites = await listFavorites({ ...filter, pinnedFirst: true });
  const content = buildCardsContent(favorites, format);
  return saveJob({
    id: uuid(),
    kind: 'cards',
    filename: `复习卡片-${localDayKey()}.${format}`,
    mime: format === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8',
    data: content,
    size: new TextEncoder().encode(content).length,
  });
}

// ───────────────────────── 清单（CSV） ─────────────────────────

function csvCell(value: unknown): string {
  const str = value === undefined || value === null ? '' : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export async function exportListCsv(filter: FavoriteFilter = {}): Promise<ExportBuildResult> {
  const favorites = await listFavorites(filter);
  const header = ['类型', '标题', '内容摘要', '课程ID', '课次ID', '时间点(秒)', '标签', '备注', '收藏时间'];
  const rows = favorites.map((f) => [
    favoriteTypeLabel(f.type),
    f.snapshot.title,
    f.snapshot.content.replace(/\s+/g, ' ').slice(0, 200),
    f.teclId ?? '',
    f.courId ?? '',
    f.anchorTime !== undefined ? Math.floor(f.anchorTime) : '',
    f.tags.join('|'),
    f.note ?? '',
    new Date(f.favoritedAt).toLocaleString('zh-CN'),
  ]);
  // BOM 让 Excel 正确识别 UTF-8
  const csv = `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
  return saveJob({
    id: uuid(),
    kind: 'list',
    filename: `收藏清单-${localDayKey()}.csv`,
    mime: 'text/csv;charset=utf-8',
    data: csv,
    size: new TextEncoder().encode(csv).length,
  });
}

// ───────────────────────── 大纲（Markdown） ─────────────────────────

function buildOutlineContent(ai: AiResultEntity, session: SessionEntity | null): string {
  const lines: string[] = [];
  lines.push(`# ${session?.courseName ?? '课程'} — ${session?.courLabel ?? `课次 ${ai.courId ?? ai.mediaKey}`} 大纲\n`);
  lines.push(`> 导出时间：${new Date().toLocaleString('zh-CN')}；内容由 AI 生成，仅依据本节转写文本。\n`);
  ai.outline.forEach((node) => {
    const indent = node.level === 2 ? '  ' : '';
    lines.push(`${indent}- **${node.title}** \`${formatClock(node.start)}–${formatClock(node.end)}\``);
  });
  lines.push('\n## 知识点\n');
  for (const topic of ai.topics) {
    const intervals = topic.intervals.map(([s, e]) => `${formatClock(s)}–${formatClock(e)}`).join('、');
    lines.push(`### ${topic.name}（${topic.confidence}）`);
    lines.push(`- 时间：${intervals}`);
    lines.push(`- 摘要：${topic.summary}`);
    lines.push('');
  }
  return lines.join('\n');
}

export async function exportOutlineMarkdown(mediaKey: MediaKey): Promise<ExportBuildResult> {
  const db = await getDb();
  const ai = (await db.get('aiResults', mediaKey)) as AiResultEntity | undefined;
  if (!ai) {
    throw new AppError('INVALID_INPUT', { userMessage: '该课次尚未生成大纲' });
  }
  const courId = hduCourIdOf(mediaKey);
  const session = courId !== undefined ? ((await db.get('sessions', courId)) as SessionEntity | undefined) ?? null : null;
  const content = buildOutlineContent(ai, session);
  return saveJob({
    id: uuid(),
    kind: 'outline',
    filename: `大纲-${courId ?? mediaKey}-${localDayKey()}.md`,
    mime: 'text/markdown;charset=utf-8',
    data: content,
    size: new TextEncoder().encode(content).length,
  });
}

// ───────────────────────── 全量备份（JSON + 截图 ZIP） ─────────────────────────

export interface BackupPayload {
  version: number;
  dbVersion: number;
  exportedAt: string;
  app: string;
  includesScreenshots: boolean;
  courses: unknown[];
  sessions: unknown[];
  transcripts: unknown[];
  aiResults: unknown[];
  chats: unknown[];
  favorites: unknown[];
  folders: unknown[];
  tags: unknown[];
  notes: unknown[];
  watchRecords: unknown[];
  screenshotsMeta: Array<Omit<ScreenshotEntity, 'blob'>>;
  reviewJobs: unknown[];
  /** 站外视频进度（v1 格式后补段：旧版备份缺段视为空） */
  videoProgress: unknown[];
  /** 站外视频学习时长流水（v1 格式后补段：旧版备份缺段视为空） */
  externalWatch: unknown[];
  /** 课表快照（v1 格式后补段：旧版备份缺段视为空） */
  curriculum: unknown[];
  /** 每周回看学习计划（用户资产；v1 格式后补段：旧版备份缺段视为空） */
  weeklyPlans: unknown[];
}

function toScreenshotMeta(shot: ScreenshotEntity): Omit<ScreenshotEntity, 'blob'> {
  const { blob, ...meta } = shot;
  void blob;
  return meta;
}

async function collectBackup(includeScreenshots: boolean): Promise<{ payload: BackupPayload; screenshots: ScreenshotEntity[] }> {
  const db = await getDb();
  const courses = await listCourses();
  const sessionRows: SessionEntity[] = [];
  for (const course of courses) {
    sessionRows.push(...(await listSessionsByCourse(course.teclId)));
  }
  const transcripts = (await db.getAll('transcripts')) as unknown[];
  const aiResults = (await db.getAll('aiResults')) as unknown[];
  const chats = (await db.getAll('chats')) as unknown[];
  const favorites = await listFavorites({ includeDeleted: true });
  const folders = (await db.getAll('folders')) as unknown[];
  const tags = (await db.getAll('tags')) as unknown[];
  const notes = (await db.getAll('notes')) as unknown[];
  const watchRecords = await listWatchRecords('1970-01-01', '2999-12-31');
  const reviewJobs = (await db.getAll('reviewJobs')) as unknown[];
  const videoProgress = (await db.getAll('videoProgress')) as unknown[];
  const externalWatch = (await db.getAll('externalWatch')) as unknown[];
  const curriculum = (await db.getAll('curriculum')) as unknown[];
  const weeklyPlans = (await db.getAll('weeklyPlans')) as unknown[];
  const screenshots = await listScreenshots();

  const payload: BackupPayload = {
    version: BACKUP_FORMAT_VERSION,
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    app: BACKUP_APP_ID,
    includesScreenshots: includeScreenshots,
    courses,
    sessions: sessionRows,
    transcripts,
    aiResults,
    chats,
    favorites,
    folders,
    tags,
    notes,
    watchRecords,
    screenshotsMeta: screenshots.map(toScreenshotMeta),
    reviewJobs,
    videoProgress,
    externalWatch,
    curriculum,
    weeklyPlans,
  };
  return { payload, screenshots };
}

export async function exportBackup(includeScreenshots: boolean): Promise<ExportBuildResult> {
  const { payload, screenshots } = await collectBackup(includeScreenshots);
  const jsonText = JSON.stringify(payload, null, 2);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  if (!includeScreenshots) {
    return saveJob({
      id: uuid(),
      kind: 'backup',
      filename: `智慧课堂助手备份-${stamp}.json`,
      mime: 'application/json;charset=utf-8',
      data: jsonText,
      size: new TextEncoder().encode(jsonText).length,
    });
  }

  // ZIP：data.json + README.txt + screenshots/<id>.png
  const files: Record<string, Uint8Array> = {
    'data.json': strToU8(jsonText),
    'README.txt': strToU8(
      [
        '杭电智慧课堂学习助手 — 全量备份',
        `导出时间：${payload.exportedAt}`,
        '',
        '内容说明：',
        '- data.json：课程、课次、转写文本（插件本地转写派生物）、AI 结果、问答、收藏、笔记、学习流水等本地数据；',
        '- screenshots/：用户主动截取的板书图片（原始 PNG）。',
        '',
        '隐私说明：备份不含视频/音频文件，也不含站点账号信息与 AI API Key。',
      ].join('\n'),
    ),
  };
  for (const shot of screenshots) {
    try {
      const buf = new Uint8Array(await shot.blob.arrayBuffer());
      files[`screenshots/${shot.id}.png`] = buf;
    } catch (err) {
      log.warn(`截图打包失败：${shot.id}`, err);
    }
  }
  const zipped = zipSync(files, { level: 6 });
  return saveJob({
    id: uuid(),
    kind: 'backup',
    filename: `智慧课堂助手备份-${stamp}.zip`,
    mime: 'application/zip',
    data: zipped,
    size: zipped.byteLength,
  });
}
