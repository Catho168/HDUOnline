/**
 * 导入（技术文档 §7 B4 / §9.4）。
 *
 * 校验口径：版本号与结构必须匹配；损坏文件拒绝导入且**不破坏现有数据**
 * （先在内存中完成全部结构与关键字段校验，再在单个 IndexedDB 事务内写入；
 * 任一写入失败都会回滚，包括 replace 模式的清空操作）。
 *
 * 兼容性约定：
 *  - 旧格式备份缺新 store 段（videoProgress / externalWatch / curriculum / weeklyPlans）视为空段；
 *  - 新格式备份带未知段时**忽略未知段**（normalizeTables 只读取已知字段），
 *    不崩溃、不报错——旧版扩展导入新版备份同样靠这条约定兜底；
 *  - 后补的 store 采用防御式逐行校验：坏条目跳过并计数，不整体拒绝导入。
 */

import { strFromU8, unzipSync } from 'fflate';
import { getDb } from '../db';
import type { ExportJobRecord } from '../db/schema';
import { DB_VERSION } from '../shared/constants';
import { AppError, toAppError } from '../shared/errors';
import { createLogger } from '../shared/logger';
import { hduMediaKey } from '../shared/mediaRef';
import { uuid } from '../shared/utils';
import { BACKUP_APP_ID, BACKUP_FORMAT_VERSION, type BackupPayload } from './exporters';

const log = createLogger('import');

const IMPORT_JOB_TTL_MS = 30 * 60 * 1000;

const IMPORT_STORES = [
  'courses',
  'sessions',
  'transcripts',
  'aiResults',
  'chats',
  'favorites',
  'folders',
  'tags',
  'notes',
  'watchRecords',
  'screenshots',
  'reviewJobs',
  'videoProgress',
  'externalWatch',
  'curriculum',
  'weeklyPlans',
] as const;

const TABLE_FIELDS = [
  'courses',
  'sessions',
  'transcripts',
  'aiResults',
  'chats',
  'favorites',
  'folders',
  'tags',
  'notes',
  'watchRecords',
  'screenshotsMeta',
  'reviewJobs',
  'videoProgress',
  'externalWatch',
  'curriculum',
  'weeklyPlans',
] as const;

type TableField = (typeof TABLE_FIELDS)[number];
type Row = Record<string, unknown>;
type BackupTables = Record<TableField, Row[]>;

export interface ImportResult {
  imported: Record<string, number>;
  /** 防御式校验跳过的坏条目计数（按 store 分组） */
  skipped: Record<string, number>;
}

function invalid(message: string, detail?: string): AppError {
  return new AppError('INVALID_INPUT', { userMessage: `备份文件结构损坏：${message}`, detail });
}

function asRows(value: unknown, field: string): Row[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(`${field} 不是数组`);
  return value.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw invalid(`${field}[${index}] 不是对象`);
    }
    return row as Row;
  });
}

function assertKey(rows: Row[], table: string, key: string, kind: 'string' | 'number'): void {
  rows.forEach((row, index) => {
    const value = row[key];
    const ok =
      kind === 'string'
        ? typeof value === 'string' && value.length > 0
        : typeof value === 'number' && Number.isFinite(value);
    if (!ok) throw invalid(`${table}[${index}] 缺少有效的 ${key}`);
  });
}

function assertArrayField(rows: Row[], table: string, key: string): void {
  rows.forEach((row, index) => {
    if (!Array.isArray(row[key])) throw invalid(`${table}[${index}] 的 ${key} 不是数组`);
  });
}

function assertStringField(rows: Row[], table: string, key: string, allowEmpty = false): void {
  rows.forEach((row, index) => {
    const value = row[key];
    if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
      throw invalid(`${table}[${index}] 缺少有效的 ${key}`);
    }
  });
}

/**
 * 转写链路表（transcripts / aiResults / chats）的媒体主键双形态归一（B 站转写专项 §3）：
 *  - 旧备份（DB v4）：记录只有 courId → 导入时补 `mediaKey = hdu:<courId>`（原 courId 保留）；
 *  - 新备份（DB v5）：记录已带 mediaKey → 原样导入（courId 字段同样保留在记录体内）。
 * 两种形态都缺失视为结构损坏，拒绝导入（写库前校验，现有数据不受影响）。
 */
function fillMediaKeyRows(rows: Row[], table: string): void {
  rows.forEach((row, index) => {
    const mediaKey = row.mediaKey;
    if (typeof mediaKey === 'string' && mediaKey.length > 0) return;
    const courId = row.courId;
    if (typeof courId === 'number' && Number.isFinite(courId)) {
      row.mediaKey = hduMediaKey(courId);
      return;
    }
    throw invalid(`${table}[${index}] 缺少有效的 courId/mediaKey`);
  });
}

/**
 * 后补 store 的防御式逐行校验：坏条目直接跳过并计数，不整体拒绝导入。
 * 只校验"主键有效 + 消费方依赖的关键字段类型"，其余字段原样写回。
 */
const LENIENT_ROW_CHECKS: Record<'videoProgress' | 'externalWatch' | 'curriculum' | 'weeklyPlans', (row: Row) => boolean> = {
  // 站外视频进度：主键 `${platform}:${videoId}`，位置秒数必须是有限数值
  videoProgress: (row) =>
    typeof row.id === 'string' &&
    row.id.length > 0 &&
    typeof row.videoId === 'string' &&
    (typeof row.platform === 'string' || row.platform === undefined) &&
    (row.durationSec === undefined || row.durationSec === null || typeof row.durationSec === 'number') &&
    typeof row.lastPositionSec === 'number' &&
    Number.isFinite(row.lastPositionSec),
  // 站外学习时长流水：主键 `${date}:${bvid}`，seconds 为非负有限数值
  externalWatch: (row) =>
    typeof row.id === 'string' &&
    row.id.length > 0 &&
    typeof row.date === 'string' &&
    row.date.length > 0 &&
    typeof row.bvid === 'string' &&
    typeof row.seconds === 'number' &&
    Number.isFinite(row.seconds) &&
    row.seconds >= 0,
  // 课表快照：courId 主键 + 课次时间可被周视图过滤
  curriculum: (row) =>
    typeof row.courId === 'number' &&
    Number.isFinite(row.courId) &&
    typeof row.teclId === 'number' &&
    Number.isFinite(row.teclId) &&
    typeof row.subjName === 'string' &&
    row.subjName.length > 0 &&
    typeof row.beginTime === 'number' &&
    Number.isFinite(row.beginTime) &&
    typeof row.endTime === 'number' &&
    Number.isFinite(row.endTime),
  // 每周回看学习计划：主键 id，切片依赖 perDay（数值）与 startDate / bvids（数组）；label 等附加字段容忍
  weeklyPlans: (row) =>
    typeof row.id === 'string' &&
    row.id.length > 0 &&
    typeof row.perDay === 'number' &&
    Number.isFinite(row.perDay) &&
    Array.isArray(row.bvids) &&
    typeof row.startDate === 'string' &&
    row.startDate.length > 0,
};

type LenientField = keyof typeof LENIENT_ROW_CHECKS;

const LENIENT_FIELDS: LenientField[] = ['videoProgress', 'externalWatch', 'curriculum', 'weeklyPlans'];

interface NormalizeOutcome {
  tables: BackupTables;
  /** 防御式校验跳过的坏条目（按 store 分组，仅在有跳过时记录） */
  skipped: Partial<Record<LenientField, number>>;
}

/** 校验备份载荷的所有表，返回行数组与坏条目计数（不触碰数据库）。 */
function normalizeTables(payload: BackupPayload): NormalizeOutcome {
  const raw = payload as unknown as Record<string, unknown>;
  // 未知段（比当前插件更新的备份格式）在这里被自然忽略：只读取 TABLE_FIELDS 中的已知字段
  const tables = {} as BackupTables;
  const skipped: Partial<Record<LenientField, number>> = {};
  for (const field of TABLE_FIELDS) tables[field] = asRows(raw[field], field);

  assertKey(tables.courses, 'courses', 'teclId', 'number');
  assertStringField(tables.courses, 'courses', 'subjName');

  assertKey(tables.sessions, 'sessions', 'courId', 'number');
  assertKey(tables.sessions, 'sessions', 'teclId', 'number');

  // 转写链路：旧备份带 courId、新备份带 mediaKey，导入时统一补齐 mediaKey
  fillMediaKeyRows(tables.transcripts, 'transcripts');
  assertArrayField(tables.transcripts, 'transcripts', 'segments');

  fillMediaKeyRows(tables.aiResults, 'aiResults');
  assertArrayField(tables.aiResults, 'aiResults', 'topics');
  assertArrayField(tables.aiResults, 'aiResults', 'outline');

  assertKey(tables.chats, 'chats', 'id', 'string');
  fillMediaKeyRows(tables.chats, 'chats');

  assertKey(tables.favorites, 'favorites', 'id', 'string');
  tables.favorites.forEach((row, index) => {
    const snapshot = row.snapshot;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw invalid(`favorites[${index}] 缺少 snapshot`);
    }
    const snap = snapshot as Record<string, unknown>;
    if (typeof snap.title !== 'string' || typeof snap.content !== 'string') {
      throw invalid(`favorites[${index}] 的 snapshot 缺少 title/content`);
    }
    if (!Array.isArray(row.tags)) throw invalid(`favorites[${index}] 的 tags 不是数组`);
  });

  assertKey(tables.folders, 'folders', 'id', 'string');
  assertStringField(tables.folders, 'folders', 'name', true);

  assertKey(tables.tags, 'tags', 'id', 'string');
  assertStringField(tables.tags, 'tags', 'name');

  assertKey(tables.notes, 'notes', 'id', 'string');
  // 笔记双形态（第 26 轮起）：站内笔记带数值 courId；B 站等站外笔记仅带 mediaKey（无 courId）。
  // 旧备份（全站内笔记）不受影响；含站外笔记的备份不再被整体拒绝。
  tables.notes.forEach((row, index) => {
    const courId = row.courId;
    const mediaKey = row.mediaKey;
    const hasCourId = typeof courId === 'number' && Number.isFinite(courId);
    const hasMediaKey = typeof mediaKey === 'string' && mediaKey.length > 0;
    if (!hasCourId && !hasMediaKey) throw invalid(`notes[${index}] 缺少有效的 courId/mediaKey`);
  });
  assertStringField(tables.notes, 'notes', 'text', true);

  assertKey(tables.watchRecords, 'watchRecords', 'courId', 'number');
  assertStringField(tables.watchRecords, 'watchRecords', 'date');

  assertKey(tables.screenshotsMeta, 'screenshotsMeta', 'id', 'string');
  tables.screenshotsMeta.forEach((row, index) => {
    if (!row.meta || typeof row.meta !== 'object' || Array.isArray(row.meta)) {
      throw invalid(`screenshotsMeta[${index}] 缺少 meta`);
    }
  });

  assertKey(tables.reviewJobs, 'reviewJobs', 'id', 'string');
  assertStringField(tables.reviewJobs, 'reviewJobs', 'dueDate');

  // 后补 store：防御式逐行过滤，坏条目跳过并计数（缺段 = 旧格式备份，asRows 已返回空数组）
  for (const field of LENIENT_FIELDS) {
    const rows = tables[field];
    const valid = rows.filter((row) => LENIENT_ROW_CHECKS[field](row));
    tables[field] = valid;
    const dropped = rows.length - valid.length;
    if (dropped > 0) skipped[field] = dropped;
  }

  return { tables, skipped };
}

/** 解析并校验备份 JSON 文本；任何结构问题都在写库之前抛出。 */
export function parseBackupPayload(text: string): BackupPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new AppError('INVALID_INPUT', {
      userMessage: '备份文件不是合法 JSON，已拒绝导入（现有数据未受影响）',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('INVALID_INPUT', { userMessage: '备份文件结构不正确，已拒绝导入' });
  }
  const payload = parsed as Record<string, unknown>;
  if (payload.app !== BACKUP_APP_ID) {
    throw new AppError('INVALID_INPUT', { userMessage: '这不是本插件的备份文件，已拒绝导入' });
  }
  const version = payload.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new AppError('INVALID_INPUT', { userMessage: '备份文件缺少版本号，已拒绝导入' });
  }
  if (version > BACKUP_FORMAT_VERSION) {
    throw new AppError('INVALID_INPUT', {
      userMessage: `备份文件版本（v${version}）高于当前插件支持的版本，请升级插件后再导入`,
    });
  }
  const dbVersion = payload.dbVersion;
  if (typeof dbVersion === 'number' && dbVersion > DB_VERSION) {
    throw new AppError('INVALID_INPUT', {
      userMessage: `备份来自更高版本的数据结构（db v${dbVersion} > v${DB_VERSION}），已拒绝导入`,
    });
  }
  const backup = payload as unknown as BackupPayload;
  // 结构预校验（写库之前完成）
  normalizeTables(backup);
  return backup;
}

function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * 读取导入作业的数据体（来自 IndexedDB 的 exportJobs 记录）：
 * 支持 .json 与 .zip（zip 内含 data.json 与 screenshots/）。
 */
export async function readImportPayload(
  jobId: string,
): Promise<{ payload: BackupPayload; screenshots: Map<string, Uint8Array> }> {
  const db = await getDb();
  const job = await db.get('exportJobs', jobId);
  if (!job) throw new AppError('INVALID_INPUT', { userMessage: '导入作业已过期，请重新选择文件' });
  if (job.kind !== 'import') {
    throw new AppError('INVALID_INPUT', { detail: `作业类型不是 import：${job.kind}` });
  }
  if (typeof job.expiresAt === 'number' && job.expiresAt < Date.now()) {
    throw new AppError('INVALID_INPUT', { userMessage: '导入作业已过期，请重新选择文件' });
  }

  const screenshots = new Map<string, Uint8Array>();
  if (typeof job.data === 'string') {
    return { payload: parseBackupPayload(job.data), screenshots };
  }
  if (!(job.data instanceof Uint8Array)) {
    throw new AppError('INVALID_INPUT', { userMessage: '导入作业的数据格式不受支持' });
  }

  // 用户也可能把 .json 以字节数组传入：按 ZIP 魔术字区分。
  if (!looksLikeZip(job.data)) {
    return { payload: parseBackupPayload(strFromU8(job.data)), screenshots };
  }

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(job.data);
  } catch (err) {
    throw new AppError('INVALID_INPUT', {
      userMessage: 'ZIP 备份包已损坏，已拒绝导入（现有数据未受影响）',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  const dataFile = files['data.json'];
  if (!dataFile) {
    throw new AppError('INVALID_INPUT', { userMessage: 'ZIP 备份包缺少 data.json，已拒绝导入' });
  }
  for (const [name, bytes] of Object.entries(files)) {
    if (name.startsWith('screenshots/') && name.endsWith('.png') && !name.includes('..')) {
      screenshots.set(name.slice('screenshots/'.length, -4), bytes);
    }
  }
  return { payload: parseBackupPayload(strFromU8(dataFile)), screenshots };
}

/**
 * 执行导入。
 * merge：按主键合并（同 ID 覆盖）；replace：先清空相关表再写入。
 * 所有清空与写入都在**同一事务**内，失败自动回滚。
 */
export async function runImport(jobId: string, mode: 'merge' | 'replace'): Promise<ImportResult> {
  if (mode !== 'merge' && mode !== 'replace') {
    throw new AppError('INVALID_INPUT', { detail: `未知的导入模式：${String(mode)}` });
  }
  const { payload, screenshots } = await readImportPayload(jobId);
  const { tables, skipped } = normalizeTables(payload);
  const db = await getDb();
  const counts: Record<string, number> = {};

  const tx = db.transaction([...IMPORT_STORES], 'readwrite');
  try {
    if (mode === 'replace') {
      for (const store of IMPORT_STORES) {
        await tx.objectStore(store).clear();
        counts[`${store}:cleared`] = 1;
      }
    }

    const writeRows = async (store: (typeof IMPORT_STORES)[number], rows: Row[]) => {
      const objectStore = tx.objectStore(store);
      for (const row of rows) {
        await objectStore.put(row as never);
      }
      counts[store] = rows.length;
    };

    await writeRows('courses', tables.courses);
    await writeRows('sessions', tables.sessions);
    await writeRows('transcripts', tables.transcripts);
    await writeRows('aiResults', tables.aiResults);
    await writeRows('chats', tables.chats);
    await writeRows('favorites', tables.favorites);
    await writeRows('folders', tables.folders);
    await writeRows('tags', tables.tags);
    await writeRows('notes', tables.notes);
    await writeRows('watchRecords', tables.watchRecords);
    await writeRows('reviewJobs', tables.reviewJobs);
    // 后补 store（旧格式备份缺段时为空数组，直接跳过写入）
    await writeRows('videoProgress', tables.videoProgress);
    await writeRows('externalWatch', tables.externalWatch);
    await writeRows('curriculum', tables.curriculum);
    await writeRows('weeklyPlans', tables.weeklyPlans);

    // 截图：元数据 + 可选二进制（Blob 只在这里构造，不进入消息通道）
    const shotStore = tx.objectStore('screenshots');
    for (const meta of tables.screenshotsMeta) {
      const id = meta.id as string;
      const bytes = screenshots.get(id);
      let blob: Blob;
      if (bytes) {
        blob = new Blob([bytes as unknown as BlobPart], { type: 'image/png' });
      } else if (mode === 'merge') {
        const existing = (await shotStore.get(id)) as { blob?: Blob } | undefined;
        blob = existing?.blob ?? new Blob([], { type: 'image/png' });
      } else {
        blob = new Blob([], { type: 'image/png' });
      }
      await shotStore.put({ ...meta, blob, deletedAt: null } as never);
      counts.screenshots = (counts.screenshots ?? 0) + 1;
    }

    await tx.done;
  } catch (err) {
    try {
      tx.abort();
    } catch {
      /* 事务可能已自动中止 */
    }
    if (err instanceof AppError) throw err;
    const detail = `${toAppError(err, 'DB_FAILED').detail ?? ''}`.toLowerCase();
    if (detail.includes('quota') || detail.includes('exceeded')) {
      throw new AppError('STORAGE_QUOTA', {
        userMessage: '本机存储空间不足，导入已回滚（现有数据未受影响）',
        detail,
      });
    }
    throw new AppError('DB_FAILED', { userMessage: '导入失败，现有数据未受影响', detail });
  }

  log.info('导入完成', { ...counts, ...(Object.keys(skipped).length > 0 ? { skipped } : {}) });
  return { imported: counts, skipped };
}

/**
 * 由页面写入导入作业（大对象走 IDB，消息只传 key）。
 * Blob 不进入消息通道；调用方应先读取为文本或字节数组。
 */
export async function stageImportJob(filename: string, data: string | Uint8Array): Promise<string> {
  if (typeof data !== 'string' && !(data instanceof Uint8Array)) {
    throw new AppError('INVALID_INPUT', { userMessage: '导入数据格式不受支持（需要文本或字节数组）' });
  }
  const db = await getDb();
  const id = `import-${uuid()}`;
  const size = typeof data === 'string' ? new TextEncoder().encode(data).length : data.byteLength;
  const lower = filename.toLowerCase();
  const isZip = typeof data !== 'string' && (lower.endsWith('.zip') || looksLikeZip(data));
  const record: ExportJobRecord = {
    id,
    kind: 'import',
    filename: filename || `import-${id}`,
    mime: isZip ? 'application/zip' : 'application/json;charset=utf-8',
    data,
    size,
    createdAt: Date.now(),
    expiresAt: Date.now() + IMPORT_JOB_TTL_MS,
  };
  await db.put('exportJobs', record);
  return id;
}
