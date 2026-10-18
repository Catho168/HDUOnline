/**
 * 导入（技术文档 §7 B4 / §9.4）。
 *
 * 校验口径：版本号与结构必须匹配；损坏文件拒绝导入且**不破坏现有数据**
 * （先在内存中完成全部结构与关键字段校验，再在单个 IndexedDB 事务内写入；
 * 任一写入失败都会回滚，包括 replace 模式的清空操作）。
 */

import { strFromU8, unzipSync } from 'fflate';
import { getDb } from '../db';
import type { ExportJobRecord } from '../db/schema';
import { DB_VERSION } from '../shared/constants';
import { AppError, toAppError } from '../shared/errors';
import { createLogger } from '../shared/logger';
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
] as const;

type TableField = (typeof TABLE_FIELDS)[number];
type Row = Record<string, unknown>;
type BackupTables = Record<TableField, Row[]>;

export interface ImportResult {
  imported: Record<string, number>;
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

/** 校验备份载荷的所有表，返回行数组（不触碰数据库）。 */
function normalizeTables(payload: BackupPayload): BackupTables {
  const raw = payload as unknown as Record<string, unknown>;
  const tables = {} as BackupTables;
  for (const field of TABLE_FIELDS) tables[field] = asRows(raw[field], field);

  assertKey(tables.courses, 'courses', 'teclId', 'number');
  assertStringField(tables.courses, 'courses', 'subjName');

  assertKey(tables.sessions, 'sessions', 'courId', 'number');
  assertKey(tables.sessions, 'sessions', 'teclId', 'number');

  assertKey(tables.transcripts, 'transcripts', 'courId', 'number');
  assertArrayField(tables.transcripts, 'transcripts', 'segments');

  assertKey(tables.aiResults, 'aiResults', 'courId', 'number');
  assertArrayField(tables.aiResults, 'aiResults', 'topics');
  assertArrayField(tables.aiResults, 'aiResults', 'outline');

  assertKey(tables.chats, 'chats', 'id', 'string');
  assertKey(tables.chats, 'chats', 'courId', 'number');

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
  assertKey(tables.notes, 'notes', 'courId', 'number');
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

  return tables;
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
  const tables = normalizeTables(payload);
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

  log.info('导入完成', counts);
  return { imported: counts };
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
