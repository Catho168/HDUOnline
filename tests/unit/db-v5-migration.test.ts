/**
 * DB v5 迁移单测（B 站转写专项设计 §3）。
 *
 * 用 MIGRATIONS 表手工构造 v4 旧库并播种旧格式数据（courId 主键 / `courId:...` 分片键 /
 * 无 mediaKey 的 chats），再以 openDB(..., 5) 触发真实 v5 迁移，断言：
 *  - transcripts / aiResults / asrJobs 主键变 mediaKey、courId 字段保留、总数守恒；
 *  - asrChunks 键重建为 `<mediaKey>:<viewNum>:<chunkIndex>`；
 *  - chats 逐条补 mediaKey 字段 + mediaKey 索引（courId 索引保留）；
 *  - 迁移中途失败（非法记录注入）→ 升级事务 abort → 库保持 v4 原样，修复后重试成功；
 *  - 空库直接建 v5。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { openDB, type IDBPDatabase } from 'idb';
import { MIGRATIONS } from '@/core/db';
import { hduMediaKey } from '@/core/shared/mediaRef';

/** 每个用例独立库名（fake-indexeddb 全局共享 indexedDB 实例） */
const USED_NAMES: string[] = [];
let caseSeq = 0;

afterEach(() => {
  for (const name of USED_NAMES.splice(0)) void indexedDB.deleteDatabase(name);
});

function uniqueName(): string {
  caseSeq += 1;
  const name = `hdu-v5-migration-case-${caseSeq}`;
  USED_NAMES.push(name);
  return name;
}

type AnyDb = IDBPDatabase<Record<string, { key: unknown; value: unknown; indexes?: Record<string, unknown> }>>;

/** 按 MIGRATIONS[0..3] 打开 v4 库（真实迁移链），可选 seed 回调在打开后写入旧数据 */
async function openV4(name: string, seed?: (db: AnyDb) => Promise<void>): Promise<AnyDb> {
  const db = (await openDB(name, 4, {
    upgrade(db, oldVersion, _newVersion, tx) {
      for (let v = oldVersion; v < 4; v += 1) {
        const migrate = MIGRATIONS[v];
        if (migrate) migrate(db as never, tx as never);
      }
    },
  })) as AnyDb;
  if (seed) await seed(db);
  return db;
}

/** 以 v5（完整迁移链）打开；失败时抛出底层错误 */
function openV5(name: string): Promise<AnyDb> {
  return openDB(name, 5, {
    upgrade(db, oldVersion, _newVersion, tx) {
      for (let v = oldVersion; v < 5; v += 1) {
        const migrate = MIGRATIONS[v];
        if (migrate) migrate(db as never, tx as never);
      }
    },
  }) as Promise<AnyDb>;
}

async function seedV4Legacy(db: AnyDb): Promise<void> {
  const now = 1_700_000_000_000;
  await db.put('transcripts', {
    courId: 1001,
    segments: [{ s: 1, e: 4, text: '旧库转写' }],
    model: 'fast',
    lang: 'zh',
    glossaryVersion: 1,
    createdAt: now,
    source: 'local-asr',
    coveredSec: 3,
    coverage: [{ start: 1, end: 4 }],
    durationSec: 600,
    partial: false,
    pipelineVersion: 3,
  });
  await db.put('transcripts', {
    courId: 1002,
    segments: [{ s: 0, e: 2, text: '第二节课' }],
    model: 'fast',
    lang: 'zh',
    glossaryVersion: 1,
    createdAt: now + 1,
    source: 'local-asr',
  });
  await db.put('aiResults', {
    courId: 1001,
    promptVersion: 2,
    model: 'test-model',
    topics: [{ name: '知识点', summary: '', confidence: 'high', intervals: [[1, 4]] }],
    outline: [{ level: 1, title: '主题', start: 1, end: 4 }],
    createdAt: now,
  });
  await db.put('asrJobs', {
    courId: 1001,
    status: 'paused',
    viewNum: 1,
    model: 'fast',
    durationSec: 600,
    progress: 0.5,
    doneChunks: 1,
    totalChunks: 2,
    createdAt: now,
    updatedAt: now + 5,
  });
  await db.put('asrChunks', {
    key: '1001:1:0',
    courId: 1001,
    viewNum: 1,
    chunkIndex: 0,
    startSec: 0,
    endSec: 600,
    segments: [{ s: 0, e: 10, text: '旧分片' }],
    createdAt: now,
    pipelineVersion: 3,
  });
  await db.put('asrChunks', {
    key: '1001:2:1',
    courId: 1001,
    viewNum: 2,
    chunkIndex: 1,
    startSec: 600,
    endSec: 1200,
    segments: [],
    createdAt: now,
    pipelineVersion: 3,
  });
  await db.put('chats', {
    id: 'chat-1',
    courId: 1001,
    groupId: 'g1',
    role: 'user',
    content: '第一问',
    anchorTime: 10,
    status: 'done',
    createdAt: now,
  });
  await db.put('chats', {
    id: 'chat-2',
    courId: 1001,
    groupId: 'g1',
    role: 'ai',
    content: '回答',
    status: 'done',
    createdAt: now + 1,
  });
}

describe('DB v4 → v5 迁移（mediaKey 主键）', () => {
  it('transcripts / aiResults / asrJobs 主键变 mediaKey，courId 字段保留，总数守恒', async () => {
    const name = uniqueName();
    const v4 = await openV4(name, seedV4Legacy);
    v4.close();

    const db = await openV5(name);
    expect(db.version).toBe(5);

    const tx = db.transaction(['transcripts', 'aiResults', 'asrJobs']);
    const transcriptsStore = tx.objectStore('transcripts');
    const aiStore = tx.objectStore('aiResults');
    const jobsStore = tx.objectStore('asrJobs');
    expect(transcriptsStore.keyPath).toBe('mediaKey');
    expect(aiStore.keyPath).toBe('mediaKey');
    expect(jobsStore.keyPath).toBe('mediaKey');

    expect(await db.count('transcripts')).toBe(2);
    expect(await db.count('aiResults')).toBe(1);
    expect(await db.count('asrJobs')).toBe(1);

    const t1 = (await db.get('transcripts', 'hdu:1001')) as { courId?: number; segments: unknown[] } | undefined;
    expect(t1).toBeTruthy();
    expect(t1?.courId).toBe(1001);
    expect((t1?.segments as Array<{ text?: string }>).at(0)?.text).toBe('旧库转写');
    expect(await db.get('transcripts', 1001 as never)).toBeUndefined(); // 旧主键不再存在

    const ai = (await db.get('aiResults', 'hdu:1001')) as { courId?: number; promptVersion: number } | undefined;
    expect(ai?.courId).toBe(1001);
    expect(ai?.promptVersion).toBe(2);

    const job = (await db.get('asrJobs', 'hdu:1001')) as { courId?: number; status: string } | undefined;
    expect(job?.courId).toBe(1001);
    expect(job?.status).toBe('paused');
    // 索引按 v1 定义重建：status 索引可查
    const pausedJobs = await db.getAllFromIndex('asrJobs', 'status', 'paused');
    expect(pausedJobs).toHaveLength(1);
    db.close();
  });

  it('asrChunks 全量重建：键变 `<mediaKey>:<viewNum>:<chunkIndex>`，记录字段保留', async () => {
    const name = uniqueName();
    const v4 = await openV4(name, seedV4Legacy);
    v4.close();

    const db = await openV5(name);
    expect(await db.count('asrChunks')).toBe(2);
    const rebuilt = (await db.get('asrChunks', 'hdu:1001:1:0')) as
      | { courId?: number; mediaKey?: string; viewNum: number; segments: unknown[] }
      | undefined;
    expect(rebuilt).toBeTruthy();
    expect(rebuilt?.mediaKey).toBe(hduMediaKey(1001));
    expect(rebuilt?.courId).toBe(1001);
    expect(rebuilt?.viewNum).toBe(1);
    expect((rebuilt?.segments as Array<{ text?: string }>).at(0)?.text).toBe('旧分片');
    // 旧键格式消失；机位 2 的分片键同样重建
    expect(await db.get('asrChunks', '1001:1:0')).toBeUndefined();
    expect(await db.get('asrChunks', 'hdu:1001:2:1')).toBeTruthy();
    // courId 索引仍按 v1 定义存在
    expect(Array.from(db.transaction('asrChunks').store.indexNames)).toContain('courId');
    db.close();
  });

  it('chats 保留原 store 与 courId 索引，逐条补 mediaKey 字段且 mediaKey 索引可查', async () => {
    const name = uniqueName();
    const v4 = await openV4(name, seedV4Legacy);
    v4.close();

    const db = await openV5(name);
    const chatStore = db.transaction('chats').store;
    expect(chatStore.keyPath).toBe('id');
    const indexNames = Array.from(chatStore.indexNames);
    expect(indexNames).toContain('courId');
    expect(indexNames).toContain('mediaKey');
    expect(indexNames).toContain('groupId');
    expect(indexNames).toContain('createdAt');

    const chats = await db.getAllFromIndex('chats', 'mediaKey', hduMediaKey(1001));
    expect(chats).toHaveLength(2);
    for (const chat of chats as Array<{ courId?: number; mediaKey?: string; id: string }>) {
      expect(chat.mediaKey).toBe(hduMediaKey(1001));
      expect(chat.courId).toBe(1001); // 字段双向兼容：courId 保留
    }
    expect(chats.map((c) => (c as { id: string }).id).sort()).toEqual(['chat-1', 'chat-2']);
    // 站内其余课次的 chats 不受影响
    expect(await db.getAllFromIndex('chats', 'mediaKey', hduMediaKey(9999))).toHaveLength(0);
    db.close();
  });

  it('迁移中途失败（非法 courId 注入）→ 升级事务 abort → 库保持 v4、数据原样', async () => {
    const name = uniqueName();
    const v4 = await openV4(name, async (db) => {
      await seedV4Legacy(db);
      // transcripts keyPath=courId 允许任意合法 IDB 键类型：注入字符串 courId 的非法记录
      await db.put('transcripts', {
        courId: 'bad-string',
        segments: [],
        model: 'fast',
        lang: 'zh',
        glossaryVersion: 1,
        createdAt: 1,
        source: 'local-asr',
      });
    });
    v4.close();

    await expect(openV5(name)).rejects.toThrow();

    // 库保持 v4 原样：版本不变、记录未被重建（mediaKey 字段未写入、旧主键仍在）
    const probe = (await openDB(name, 4)) as AnyDb;
    expect(probe.version).toBe(4);
    expect(await probe.count('transcripts')).toBe(3);
    const legacy = (await probe.get('transcripts', 1001)) as { mediaKey?: string } | undefined;
    expect(legacy).toBeTruthy();
    expect(legacy?.mediaKey).toBeUndefined();
    expect(probe.transaction('transcripts').store.keyPath).toBe('courId');
    // 其他 store 也未被半途改写
    expect(await probe.count('asrChunks')).toBe(2);
    expect(await probe.get('asrChunks', '1001:1:0')).toBeTruthy();
    const chat = (await probe.get('chats', 'chat-1')) as { mediaKey?: string } | undefined;
    expect(chat?.mediaKey).toBeUndefined();
    probe.close();
  });

  it('失败修复后可重试升级成功（删除坏记录再升 v5）', async () => {
    const name = uniqueName();
    const v4 = await openV4(name, async (db) => {
      await seedV4Legacy(db);
      await db.put('transcripts', {
        courId: 'bad-string',
        segments: [],
        model: 'fast',
        lang: 'zh',
        glossaryVersion: 1,
        createdAt: 1,
        source: 'local-asr',
      });
    });
    v4.close();
    await expect(openV5(name)).rejects.toThrow();

    // 用户侧修复（数据清理）后重试：删除非法记录 → 升级成功
    const v4retry = (await openDB(name, 4)) as AnyDb;
    await v4retry.delete('transcripts', 'bad-string');
    v4retry.close();

    const db = await openV5(name);
    expect(db.version).toBe(5);
    expect(await db.count('transcripts')).toBe(2);
    expect(await db.get('transcripts', hduMediaKey(1001))).toBeTruthy();
    expect(await db.get('transcripts', hduMediaKey(1002))).toBeTruthy();
    db.close();
  });

  it('空库直接建 v5：store 与索引齐全、keyPath 正确（全新安装路径）', async () => {
    const name = uniqueName();
    const db = await openV5(name);
    expect(db.version).toBe(5);
    const expectedStores = [
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
      'asrJobs',
      'asrChunks',
      'kv',
      'trash',
      'exportJobs',
      'curriculum',
      'videoProgress',
      'externalWatch',
      'weeklyPlans',
    ];
    for (const store of expectedStores) {
      expect(db.objectStoreNames).toContain(store);
    }
    expect(db.transaction('transcripts').store.keyPath).toBe('mediaKey');
    expect(db.transaction('aiResults').store.keyPath).toBe('mediaKey');
    expect(db.transaction('asrJobs').store.keyPath).toBe('mediaKey');
    expect(Array.from(db.transaction('chats').store.indexNames)).toContain('mediaKey');
    // 空库迁移后可立即按新键读写
    await db.put('transcripts', {
      mediaKey: hduMediaKey(2001),
      courId: 2001,
      segments: [],
      model: 'fast',
      lang: 'zh',
      glossaryVersion: 1,
      createdAt: 1,
      source: 'local-asr',
    });
    expect(await db.get('transcripts', hduMediaKey(2001))).toBeTruthy();
    db.close();
  });

  it('迁移幂等：已是 v5 的库以 v5 重开不再触发迁移（数据不被二次改写）', async () => {
    const name = uniqueName();
    const v4 = await openV4(name, seedV4Legacy);
    v4.close();
    const first = await openV5(name);
    const chatCount = await first.count('chats');
    const transcriptKey = await first.getKey('transcripts', hduMediaKey(1001));
    first.close();

    let upgradeRan = false;
    const reopened = (await openDB(name, 5, {
      upgrade() {
        upgradeRan = true;
      },
    })) as AnyDb;
    expect(upgradeRan).toBe(false);
    expect(await reopened.count('chats')).toBe(chatCount);
    expect(await reopened.getKey('transcripts', hduMediaKey(1001))).toEqual(transcriptKey);
    reopened.close();
  });
});
