/**
 * IndexedDB 打开与迁移（§4.3：`db.version` 递增 + 迁移函数表；禁止破坏性重建）。
 *
 * 并发注意：
 *  - 扩展的 SW / 页面 / Offscreen 同源共享同一数据库；
 *  - 用 `navigator.locks` 串行化打开流程，避免多上下文同时触发升级；
 *  - 监听 `blocked` / `blocking` / `terminated`，必要时释放连接让升级继续进行。
 */

import { openDB, unwrap, type IDBPDatabase } from 'idb';
import { DB_NAME, DB_NAME_DEMO, DB_VERSION } from '../shared/constants';
import { AppError, toAppError } from '../shared/errors';
import { createLogger } from '../shared/logger';
import { loadSettings } from '../shared/settings';
import { hduMediaKey } from '../shared/mediaRef';
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
 *
 * 供 db-migration 单测使用（v4 建库播种 → 升 v5 断言），导出仅为测试入口。
 */
export const MIGRATIONS: Migration[] = [
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

  // v2：站外视频学习进度（B 站网课续看）
  (db, _tx) => {
    const videoProgress = db.createObjectStore('videoProgress', { keyPath: 'id' });
    videoProgress.createIndex('updatedAt', 'updatedAt');
  },

  // v3：站外视频学习时长（B 站网课入统计，独立于站内 watchRecords 的口径）
  (db, _tx) => {
    const externalWatch = db.createObjectStore('externalWatch', { keyPath: 'id' });
    externalWatch.createIndex('date', 'date');
  },

  // v4：每周回看学习计划（B 站批量导入的按日学习安排；用户资产，进全量备份）
  (db, _tx) => {
    db.createObjectStore('weeklyPlans', { keyPath: 'id' });
  },

  // v5：转写链路主键 courId → mediaKey（B 站转写专项设计 §3，方案 b）。
  //  ① transcripts / aiResults / asrJobs：keyPath courId→mediaKey（改 keyPath 必须重建 store），
  //     1:1 确定性映射 `hdu:<courId>`，记录体内 courId 保留（备份双向兼容）；
  //  ② asrChunks：keyPath 仍 'key'，但 key 改为 `<mediaKey>:<viewNum>:<chunkIndex>`；
  //     全量重建（排除清单已定为可再生，partial 进度丢失可接受，重跑即可）；
  //  ③ chats：保留原 store 与 courId 索引，逐条补 mediaKey 字段 + createIndex('mediaKey')。
  //  原则：versionchange 事务内出错即整体 abort、库停在 v4、数据无损；不重写站内专属 store。
  //
  //  实现说明：upgrade 回调返回后 versionchange 事务随时可能提交，**不能 await**。
  //  全部读写通过原生 IDBRequest 的回调串行完成（getAll 的 onsuccess 里同步完成
  //  delete→create→put），put 失败/非法记录走事务 abort，openDB 随之 reject，
  //  getDb() 映射为 DB_FAILED（可重试，库保持 v4 原样）。
  (db, tx) => {
    // idb 的 upgrade 回调拿到的是包装后的 db/tx 代理；重建 store 的 getAll/put 需要
    // 原生请求对象（idb 官方导出的 unwrap），避免代理把请求 promisify 掉。
    const rawDb = unwrap(db) as IDBDatabase;
    const rawTx = unwrap(tx) as IDBTransaction;
    const toKey = (courId: number) => hduMediaKey(courId);
    // idb 在包装事务时缓存了 done-promise（tx.done）：无论 put 失败自动 abort 还是下面的
    // 显式 abortUpgrade，该 promise 都会 reject。升级失败已经通过 openDB 的主 promise 传递
    //（getDb 映射 DB_FAILED），这里统一挂上 handler 避免多余的 unhandled rejection。
    tx.done.catch(() => undefined);

    /** 原生 fire-and-forget 写入：请求失败由事务自动 abort（openDB 随之 reject） */
    const putRaw = (store: IDBObjectStore, value: unknown): void => {
      store.put(value).onerror = () => undefined;
    };

    /** 非法旧记录：显式中止升级事务（库保持 v4 原样，下次打开重试） */
    const abortUpgrade = (): void => {
      try {
        rawTx.abort();
      } catch {
        /* 事务可能已在中止流程中 */
      }
    };

    /**
     * ① 按 courId 主键重建为 mediaKey 主键的 store（索引按 v1 定义重建）。
     *    getAll → deleteObjectStore → createObjectStore → 逐条 put({...rec, mediaKey})，
     *    全部在 getAll 的 onsuccess 回调里同步完成（同一事件任务内，事务不会中途提交）。
     */
    const rekeyByCourId = (
      name: 'transcripts' | 'aiResults' | 'asrJobs',
      defineIndexes: (store: IDBObjectStore) => void,
    ): void => {
      const request = rawTx.objectStore(name).getAll();
      request.onsuccess = () => {
        try {
          const records = request.result as Array<Record<string, unknown>>;
          rawDb.deleteObjectStore(name);
          const store = rawDb.createObjectStore(name, { keyPath: 'mediaKey' });
          defineIndexes(store);
          for (const record of records) {
            const courId = record.courId;
            // 旧库 keyPath=courId 保证记录必有合法数值键；防御非法记录：中止升级，
            // 而不是写入 `hdu:undefined` 一类的坏键。
            if (typeof courId !== 'number' || !Number.isFinite(courId)) {
              abortUpgrade();
              return;
            }
            putRaw(store, { ...record, mediaKey: toKey(courId) });
          }
        } catch {
          // 同步异常（如结构化克隆失败）不会自动中止 versionchange 事务，必须显式 abort
          abortUpgrade();
        }
      };
      request.onerror = () => undefined;
    };

    // ① transcripts（索引：createdAt）
    rekeyByCourId('transcripts', (store) => {
      store.createIndex('createdAt', 'createdAt');
    });
    // ① aiResults（索引：createdAt）
    rekeyByCourId('aiResults', (store) => {
      store.createIndex('createdAt', 'createdAt');
    });
    // ① asrJobs（索引：status / updatedAt）
    rekeyByCourId('asrJobs', (store) => {
      store.createIndex('status', 'status');
      store.createIndex('updatedAt', 'updatedAt');
    });

    // ② asrChunks：keyPath 仍 'key'，键改 `<mediaKey>:<viewNum>:<chunkIndex>`，全量重建
    {
      const request = rawTx.objectStore('asrChunks').getAll();
      request.onsuccess = () => {
        try {
          const records = request.result as Array<{
            courId?: unknown;
            mediaKey?: unknown;
            viewNum?: unknown;
            chunkIndex?: unknown;
          }>;
          rawDb.deleteObjectStore('asrChunks');
          const store = rawDb.createObjectStore('asrChunks', { keyPath: 'key' });
          store.createIndex('courId', 'courId');
          for (const chunk of records) {
            const { courId, mediaKey } = chunk;
            // 旧分片记录必有数值 courId（旧 key `${courId}:...` 的组成部分）；mediaKey 允许
            // 双形态兜底。非法记录显式中止（可再生数据，损失可接受，重跑即可）。
            const resolvedKey =
              typeof mediaKey === 'string' && mediaKey.length > 0
                ? mediaKey
                : typeof courId === 'number' && Number.isFinite(courId)
                  ? toKey(courId)
                  : null;
            if (
              resolvedKey === null ||
              typeof chunk.viewNum !== 'number' ||
              !Number.isFinite(chunk.viewNum) ||
              typeof chunk.chunkIndex !== 'number' ||
              !Number.isFinite(chunk.chunkIndex)
            ) {
              abortUpgrade();
              return;
            }
            putRaw(store, {
              ...chunk,
              mediaKey: resolvedKey,
              key: `${resolvedKey}:${chunk.viewNum}:${chunk.chunkIndex}`,
            });
          }
        } catch {
          abortUpgrade();
        }
      };
      request.onerror = () => undefined;
    }

    // ③ chats：保留原 store 与 courId 索引，逐条补 mediaKey 字段 + mediaKey 索引
    {
      const store = rawTx.objectStore('chats');
      store.createIndex('mediaKey', 'mediaKey');
      const request = store.getAll();
      request.onsuccess = () => {
        try {
          const records = request.result as Array<Record<string, unknown>>;
          for (const message of records) {
            const { mediaKey, courId } = message;
            if (typeof mediaKey === 'string' && mediaKey.length > 0) continue;
            if (typeof courId !== 'number' || !Number.isFinite(courId)) {
              abortUpgrade();
              return;
            }
            putRaw(store, { ...message, mediaKey: toKey(courId) });
          }
        } catch {
          abortUpgrade();
        }
      };
      request.onerror = () => undefined;
    }
  },
];

let dbPromise: Promise<HduDB> | null = null;
/** 当前缓存连接对应的数据库名（演示模式切换的依据；null = 尚未打开） */
let activeDbName: string | null = null;

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as { navigator?: { locks?: { request: <R>(name: string, cb: () => Promise<R>) => Promise<R> } } };
  const locks = g.navigator?.locks;
  if (locks?.request) {
    return locks.request('hdu-assistant-db-open', fn);
  }
  return fn();
}

/**
 * 解析当前应使用的数据库名（第 319 轮演示模式）：设置旗标 demo.enabled 开启时
 * 使用并行演示库，真实库完全不被读写。设置读取失败按真实库处理（宁可少演示，不可误伤）。
 */
async function resolveDbName(): Promise<string> {
  try {
    const settings = await loadSettings();
    if (settings.demo?.enabled) return DB_NAME_DEMO;
  } catch {
    /* 旗标读不到 → 真实库 */
  }
  return DB_NAME;
}

function open(name: string): Promise<HduDB> {
  return openDB<HduAssistantDB>(name, DB_VERSION, {
    upgrade(db, oldVersion, newVersion, tx) {
      log.info('数据库升级', { from: oldVersion, to: newVersion, name });
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

/** 获取数据库连接（单例；失败时抛出可展示的 AppError；库名随演示模式旗标动态解析） */
export function getDb(): Promise<HduDB> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const name = await resolveDbName();
      const db = await withLock(() => open(name));
      activeDbName = name;
      return db;
    })().catch((err) => {
      dbPromise = null;
      throw new AppError('DB_FAILED', { detail: toAppError(err).detail, cause: err, retryable: true });
    });
  }
  return dbPromise;
}

/**
 * 库目标切换（第 319 轮演示模式，demo.enter/exit 后调用）：解析后的目标库名与
 * 当前缓存连接一致则不动；不一致则关闭旧连接，下次 getDb 按新旗标重开。
 */
export async function switchDbTarget(): Promise<void> {
  const target = await resolveDbName();
  if (dbPromise && activeDbName === target) return;
  await closeDb();
}

/** 关闭连接（SW 卸载前或测试清理用） */
export async function closeDb(): Promise<void> {
  if (!dbPromise) {
    activeDbName = null;
    return;
  }
  const p = dbPromise;
  dbPromise = null;
  activeDbName = null;
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
