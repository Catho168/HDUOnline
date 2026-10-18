/**
 * IndexedDB 打开与迁移（§4.3：`db.version` 递增 + 迁移函数表；禁止破坏性重建）。
 *
 * 并发注意：
 *  - 扩展的 SW / 页面 / Offscreen 同源共享同一数据库；
 *  - 用 `navigator.locks` 串行化打开流程，避免多上下文同时触发升级；
 *  - 监听 `blocked` / `blocking` / `terminated`，必要时释放连接让升级继续进行。
 */

import { openDB, type IDBPDatabase } from 'idb';
import { DB_NAME, DB_VERSION } from '../shared/constants';
import { AppError, toAppError } from '../shared/errors';
import { createLogger } from '../shared/logger';
import type { HduAssistantDB } from './schema';

const log = createLogger('db');

export type HduDB = IDBPDatabase<HduAssistantDB>;

/** 迁移事务类型：从 openDB 的 upgrade 回调签名推导（避免手写泛型参数出错） */
type UpgradeFn = NonNullable<NonNullable<Parameters<typeof openDB<HduAssistantDB>>[2]>['upgrade']>;
type MigrationTx = Parameters<UpgradeFn>[3];
type Migration = (db: HduDB, tx: MigrationTx) => void;

/**
 * 迁移函数表：下标 = 目标版本号 - 1。
 * 从 v1 开始，后续版本追加函数即可，**不得**重建已存在的 store。
 */
const MIGRATIONS: Migration[] = [
  // v1：初始结构
  (db, _tx) => {
    const courses = db.createObjectStore('courses', { keyPath: 'teclId' });
    courses.createIndex('updatedAt', 'updatedAt');

    const sessions = db.createObjectStore('sessions', { keyPath: 'courId' });
    sessions.createIndex('teclId', 'teclId');
    sessions.createIndex('beginTime', 'beginTime');
    sessions.createIndex('watchState', 'watchState');

    const transcripts = db.createObjectStore('transcripts', { keyPath: 'courId' });
    transcripts.createIndex('createdAt', 'createdAt');

    const aiResults = db.createObjectStore('aiResults', { keyPath: 'courId' });
    aiResults.createIndex('createdAt', 'createdAt');

    const chats = db.createObjectStore('chats', { keyPath: 'id' });
    chats.createIndex('courId', 'courId');
    chats.createIndex('groupId', 'groupId');
    chats.createIndex('createdAt', 'createdAt');

    const favorites = db.createObjectStore('favorites', { keyPath: 'id' });
    favorites.createIndex('courId', 'courId');
    favorites.createIndex('teclId', 'teclId');
    favorites.createIndex('folderId', 'folderId');
    favorites.createIndex('tags', 'tags', { multiEntry: true });
    favorites.createIndex('favoritedAt', 'favoritedAt');
    favorites.createIndex('type', 'type');

    const folders = db.createObjectStore('folders', { keyPath: 'id' });
    folders.createIndex('teclId', 'teclId');
    folders.createIndex('orderIndex', 'orderIndex');

    const tags = db.createObjectStore('tags', { keyPath: 'id' });
    tags.createIndex('name', 'name');

    const notes = db.createObjectStore('notes', { keyPath: 'id' });
    notes.createIndex('courId', 'courId');
    notes.createIndex('teclId', 'teclId');
    notes.createIndex('anchorTime', 'anchorTime');

    const watchRecords = db.createObjectStore('watchRecords', { keyPath: 'id', autoIncrement: true });
    watchRecords.createIndex('date', 'date');
    watchRecords.createIndex('courId', 'courId');
    watchRecords.createIndex('daySession', ['date', 'courId']);

    const screenshots = db.createObjectStore('screenshots', { keyPath: 'id' });
    screenshots.createIndex('courId', 'courId');
    screenshots.createIndex('createdAt', 'createdAt');

    const reviewJobs = db.createObjectStore('reviewJobs', { keyPath: 'id' });
    reviewJobs.createIndex('favoriteId', 'favoriteId');
    reviewJobs.createIndex('dueDate', 'dueDate');
    reviewJobs.createIndex('status', 'status');

    const asrJobs = db.createObjectStore('asrJobs', { keyPath: 'courId' });
    asrJobs.createIndex('status', 'status');
    asrJobs.createIndex('updatedAt', 'updatedAt');

    const asrChunks = db.createObjectStore('asrChunks', { keyPath: 'key' });
    asrChunks.createIndex('courId', 'courId');

    db.createObjectStore('kv', { keyPath: 'key' });

    const trash = db.createObjectStore('trash', { keyPath: 'key' });
    trash.createIndex('deletedAt', 'deletedAt');
    trash.createIndex('kind', 'kind');

    const exportJobs = db.createObjectStore('exportJobs', { keyPath: 'id' });
    exportJobs.createIndex('createdAt', 'createdAt');

    const curriculum = db.createObjectStore('curriculum', { keyPath: 'courId' });
    curriculum.createIndex('beginTime', 'beginTime');
    curriculum.createIndex('teclId', 'teclId');
  },
];

let dbPromise: Promise<HduDB> | null = null;

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as { navigator?: { locks?: { request: <R>(name: string, cb: () => Promise<R>) => Promise<R> } } };
  const locks = g.navigator?.locks;
  if (locks?.request) {
    return locks.request('hdu-assistant-db-open', fn);
  }
  return fn();
}

function open(): Promise<HduDB> {
  return openDB<HduAssistantDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, newVersion, tx) {
      log.info('数据库升级', { from: oldVersion, to: newVersion });
      for (let v = oldVersion; v < (newVersion ?? DB_VERSION); v += 1) {
        // MIGRATIONS[0] 对应 v0 → v1
        const migrate = MIGRATIONS[v];
        if (migrate) migrate(db as unknown as HduDB, tx as unknown as MigrationTx);
      }
    },
    blocked() {
      // 有更早版本的上下文仍持有连接：释放自身引用，等待其关闭
      log.warn('数据库升级被阻塞（另有扩展页面或后台占用旧版本连接）');
      dbPromise = null;
    },
    blocking() {
      // 别的上下文想要升级：本上下文主动断开，避免长期阻塞
      log.warn('检测到其他上下文需要升级数据库，主动释放连接');
      void dbPromise?.then((db) => db.close()).catch(() => undefined);
      dbPromise = null;
    },
    terminated() {
      log.warn('数据库连接被浏览器强制终止');
      dbPromise = null;
    },
  }) as Promise<HduDB>;
}

/** 获取数据库连接（单例；失败时抛出可展示的 AppError） */
export function getDb(): Promise<HduDB> {
  if (!dbPromise) {
    dbPromise = withLock(open).catch((err) => {
      dbPromise = null;
      throw new AppError('DB_FAILED', { detail: toAppError(err).detail, cause: err, retryable: true });
    });
  }
  return dbPromise;
}

/** 关闭连接（SW 卸载前或测试清理用） */
export async function closeDb(): Promise<void> {
  if (!dbPromise) return;
  const p = dbPromise;
  dbPromise = null;
  try {
    const db = await p;
    db.close();
  } catch {
    /* 忽略 */
  }
}

/**
 * 把底层 IndexedDB 错误映射为面向用户的 AppError。
 * 重点覆盖：配额不足（建议导出并清理）、连接被阻塞/关闭（可重试）。
 */
export function mapDbError(err: unknown): AppError {
  const appErr = toAppError(err, 'DB_FAILED');
  const raw = `${appErr.detail ?? ''}`.toLowerCase();
  if (raw.includes('quota') || raw.includes('exceeded')) {
    return new AppError('STORAGE_QUOTA', {
      userMessage: '本机存储空间不足：请先在设置页导出备份，再清理截图/转写/模型缓存',
      detail: appErr.detail,
      retryable: false,
    });
  }
  if (raw.includes('blocked') || raw.includes('version') || raw.includes('closing') || raw.includes('closed')) {
    return new AppError('DB_FAILED', {
      userMessage: '本地数据库暂时不可用（可能正在升级），请稍后重试；若持续出现请刷新页面',
      detail: appErr.detail,
      retryable: true,
    });
  }
  return appErr;
}

/** 通用事务包装：单事务内的读写（避免跨事务不一致） */
export async function withTx<T>(
  stores: Parameters<HduDB['transaction']>[0],
  mode: IDBTransactionMode,
  fn: (tx: ReturnType<HduDB['transaction']>) => Promise<T> | T,
): Promise<T> {
  const db = await getDb();
  const tx = db.transaction(stores, mode);
  const result = await fn(tx);
  await tx.done;
  return result;
}

/** 清理过期的导出作业（导出包体积大，需及时释放） */
export async function purgeExpiredExportJobs(): Promise<number> {
  const db = await getDb();
  const tx = db.transaction('exportJobs', 'readwrite');
  const now = Date.now();
  let removed = 0;
  let cursor = await tx.store.index('createdAt').openCursor();
  while (cursor) {
    if (cursor.value.expiresAt <= now) {
      await cursor.delete();
      removed += 1;
    }
    cursor = await cursor.continue();
  }
  await tx.done;
  if (removed > 0) log.info(`清理过期导出作业 ${removed} 个`);
  return removed;
}
