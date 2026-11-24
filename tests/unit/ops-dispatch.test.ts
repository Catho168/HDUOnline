/**
 * background/ops.ts 分发表契约测试（第 24 轮审计补盲）：
 *  1. 表完整性：OpMap 的 OpName 全集与 handlers 运行时键集合一致（双向不缺不余），
 *     dispatchOp 按名路由到 handler；
 *  2. 未知 op → NOT_IMPLEMENTED；
 *  3. trash.restore 分类联动：favorite/screenshot 走仓储 restore，note/tag/folder
 *     直改 deletedAt，并删除回收站索引；未知键安全忽略；
 *  4. data.clear 各分类清理的 store 范围（store 清单口径与 backup-stores.test.ts 的
 *     SCHEMA_STORES 一致），未涉及的 store 与 kv / courses 幸存。
 *
 * 仓储层走真实 fake-indexeddb；本文件不触网（不调用会发请求的 op）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { OpName } from '@/core/shared/ops';
import { getDb } from '@/core/db';
import { chunkKey, putAsrChunk, putAsrJob } from '@/core/db/repo/asr';
import { putChat, putTranscript } from '@/core/db/repo/content';
import {
  createTag,
  listScreenshots,
  putFavorite,
  putNote,
  putScreenshot,
  upsertFolder,
} from '@/core/db/repo/library';
import { addExternalWatch } from '@/core/db/repo/external';
import { addWatchRecord } from '@/core/db/repo/stats';
import { moveToTrash } from '@/core/db/repo/trash';
import { upsertWeeklyPlan } from '@/core/db/repo/weekly';
import { KV_KEYS } from '@/core/db/repo/misc';
import { localDayKey } from '@/core/shared/utils';
import { hduMediaKey } from '@/core/shared/mediaRef';
import { dispatchOp, handlers } from '@/entrypoints/background/ops';
import type { ChatMessageEntity, ReviewJobEntity } from '@/core/shared/types';

/** OpMap 全集（与 src/core/shared/ops.ts 的 OpMap 键一一对应；新增 op 时同步补录） */
const ALL_OP_NAMES = [
  // 课程 / 课次
  'course.upsert',
  'course.get',
  'course.list',
  'course.bundles',
  'course.rename',
  'session.upsert',
  'session.get',
  'session.listByCourse',
  'session.patch',
  'session.saveMeta',
  // 转写
  'transcript.get',
  'transcript.put',
  'transcript.clear',
  'transcript.applyGlossary',
  'transcript.search',
  'transcript.keys',
  // 转写作业
  'asr.start',
  'asr.follow',
  'asr.control',
  'asr.status',
  'asr.warmup',
  'asr.model.status',
  'asr.model.download',
  'asr.model.clear',
  // 词表
  'glossary.getUser',
  'glossary.setUser',
  'glossary.getCourse',
  'glossary.setCourse',
  // AI
  'ai.get',
  'ai.generate',
  'ai.abort',
  'ai.hidden.get',
  'ai.hidden.set',
  'ai.clear',
  'ai.testProvider',
  // 问答
  'qa.ask',
  'qa.abort',
  'qa.list',
  'qa.listAll',
  'qa.groups',
  'qa.groupsAll',
  'qa.clear',
  // 收藏 / 文件夹 / 标签 / 笔记
  'fav.put',
  'fav.get',
  'fav.list',
  'fav.update',
  'fav.softDelete',
  'fav.restore',
  'fav.counts',
  'folder.list',
  'folder.upsert',
  'folder.ensureDefault',
  'folder.reorder',
  'folder.merge',
  'folder.rename',
  'folder.archive',
  'folder.softDelete',
  'tag.list',
  'tag.create',
  'tag.rename',
  'tag.merge',
  'tag.softDelete',
  'note.list',
  'note.listAll',
  'note.put',
  'note.update',
  'note.softDelete',
  'note.toFavorite',
  // 搜索 / 站外进度 / B 站
  'search.all',
  'video.progress.get',
  'video.progress.report',
  'bili.nav.get',
  'bili.favlist.folders',
  'bili.favlist.items',
  'bili.subtitle.fetch',
  // 统计
  'stats.tick',
  'stats.external.tick',
  'stats.flush',
  'stats.report',
  'stats.sessionSummary',
  'stats.courseSummary',
  'stats.records',
  'stats.period',
  'stats.heatmap',
  'stats.dayDetail',
  'stats.heatmapMonthly',
  'stats.bili.overview',
  'stats.clear',
  // 截图
  'shot.capture',
  'shot.list',
  'shot.softDelete',
  'shot.restore',
  // 复习
  'review.plan',
  'review.cancel',
  'review.due',
  'review.complete',
  'review.reopen',
  'review.reschedule',
  'review.stats',
  'review.list',
  // 课表 / 待办 / 周计划
  'schedule.put',
  'schedule.list',
  'schedule.missed',
  'schedule.exclude',
  'todo.today.get',
  'todo.today.set',
  'plan.weekly.get',
  'plan.weekly.create',
  'plan.weekly.cancel',
  // 导出 / 数据管理
  'export.build',
  'import.run',
  'data.exportAll',
  'storage.usage',
  'storage.estimate',
  'data.clear',
  // 回收站 / KV / 通知
  'trash.list',
  'trash.restore',
  'trash.purge',
  'trash.extend',
  'kv.get',
  'kv.set',
  'kv.del',
  // 演示模式（第 319 轮）
  'demo.enter',
  'demo.exit',
  'demo.reset',
  'demo.status',
  'notify.show',
] as const satisfies readonly OpName[];

/** schema 全集（与 backup-stores.test.ts 的 SCHEMA_STORES 同一口径） */
const SCHEMA_STORES = [
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
] as const;

const NOW = 1_700_000_000_000;

async function resetDb(): Promise<void> {
  const db = await getDb();
  for (const store of SCHEMA_STORES) await db.clear(store);
}

async function count(store: (typeof SCHEMA_STORES)[number]): Promise<number> {
  const db = await getDb();
  return db.count(store);
}

beforeEach(async () => {
  await resetDb();
});

// ───────────────────────── 分发表完整性 ─────────────────────────

describe('ops 分发表完整性', () => {
  it('handlers 键集合与 OpName 全集一致（不缺不余）', () => {
    const registered = Object.keys(handlers).sort();
    const expected = [...ALL_OP_NAMES].sort();
    expect(registered).toEqual(expected);
  });

  it('每个注册 op 都对应一个可调用 handler', () => {
    for (const op of ALL_OP_NAMES) {
      expect(typeof handlers[op], `handler ${op} 应为函数`).toBe('function');
    }
  });

  it('dispatchOp 按名路由到对应 handler（以 course.list / kv 读写为样例）', async () => {
    // course.list 路由到真实仓储（空库 → 空数组）
    expect(await dispatchOp('course.list', {})).toEqual([]);

    // kv.set → kv.get → kv.del 全链路走 dispatchOp（键须在 kv 白名单内，见 kv-key-whitelist.test.ts）
    await dispatchOp('kv.set', { key: KV_KEYS.goalAdjust, value: { a: 1 } });
    expect(await dispatchOp('kv.get', { key: KV_KEYS.goalAdjust })).toEqual({ a: 1 });
    await dispatchOp('kv.del', { key: KV_KEYS.goalAdjust });
    expect(await dispatchOp('kv.get', { key: KV_KEYS.goalAdjust })).toBeNull();
  });

  it('未知 op 报 NOT_IMPLEMENTED（detail 带出 op 名）', async () => {
    const err = await dispatchOp('no.such.op' as never, {} as never).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'NOT_IMPLEMENTED' });
    expect((err as { detail?: string }).detail).toContain('no.such.op');
  });

  it('todo.today set/get 经 dispatchOp 落 KV（薄封装契约）', async () => {
    await dispatchOp('todo.today.set', { date: '2026-11-17', keys: ['review:x', 'video:BV1', 'review:x'] });
    // set 去重
    expect(await dispatchOp('todo.today.get', { date: '2026-11-17' })).toEqual(['review:x', 'video:BV1']);
    // 未设置日期降级空数组
    expect(await dispatchOp('todo.today.get', { date: '2026-11-16' })).toEqual([]);
  });
});

// ───────────────────────── 回收站还原分类联动 ─────────────────────────

describe('trash.restore 分类联动（restoreTrashEntries）', () => {
  let tagId = 'tag-x';

  beforeEach(async () => {
    await putFavorite({
      id: 'tr-fav',
      type: 'time',
      refId: 'ref-1',
      snapshot: { title: '收藏样例', content: 'c' },
      tags: [],
      pinned: false,
      favoritedAt: NOW,
    });
    await putScreenshot({
      id: 'tr-shot',
      courId: 1,
      view: 1,
      blob: new Blob(['frame']),
      meta: { courseName: '课程', courLabel: '第1周', anchorTime: 12, watermark: false },
      createdAt: NOW,
    });
    await putNote({ id: 'tr-note', courId: 1, teclId: 1, anchorTime: 3, text: '笔记样例', createdAt: NOW, updatedAt: NOW });
    tagId = (await dispatchOp('tag.create', { name: '标签样例' })).id;
    await upsertFolder({ id: 'tr-folder', name: '文件夹样例', orderIndex: 0, archived: false, createdAt: NOW });

    await dispatchOp('fav.softDelete', { ids: ['tr-fav'] });
    await dispatchOp('shot.softDelete', { ids: ['tr-shot'] });
    await dispatchOp('note.softDelete', { id: 'tr-note' });
    await dispatchOp('tag.softDelete', { id: tagId });
    await dispatchOp('folder.softDelete', { id: 'tr-folder' });
  });

  it('软删除后五类条目都进回收站；trash.list 只回传轻量字段', async () => {
    const entries = await dispatchOp('trash.list', {});
    expect(entries.map((e) => e.key).sort()).toEqual(
      ['favorite:tr-fav', 'folder:tr-folder', `tag:${tagId}`, 'note:tr-note', 'screenshot:tr-shot'].sort(),
    );
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(['deletedAt', 'expiresAt', 'id', 'key', 'kind', 'title']);
      expect(entry.expiresAt).toBeGreaterThan(entry.deletedAt);
    }
  });

  it('混合 kinds 一次还原：实体 deletedAt 清空、回收站索引删除', async () => {
    await dispatchOp('trash.restore', {
      keys: ['favorite:tr-fav', 'screenshot:tr-shot', 'note:tr-note', `tag:${tagId}`, 'folder:tr-folder'],
    });

    const db = await getDb();
    const fav = await db.get('favorites', 'tr-fav');
    expect(fav?.deletedAt ?? null).toBeNull();
    const shot = await db.get('screenshots', 'tr-shot');
    expect(shot?.deletedAt ?? null).toBeNull();
    const note = await db.get('notes', 'tr-note');
    expect(note?.deletedAt ?? null).toBeNull();
    const tag = await db.get('tags', tagId);
    expect(tag?.deletedAt ?? null).toBeNull();
    const folder = await db.get('folders', 'tr-folder');
    expect(folder?.deletedAt ?? null).toBeNull();

    // 回收站索引全部删除；活列表可见
    expect(await dispatchOp('trash.list', {})).toEqual([]);
    expect((await listScreenshots()).map((s) => s.id)).toContain('tr-shot');
  });

  it('只还原指定键：未选中的条目保持软删除并留在回收站', async () => {
    await dispatchOp('trash.restore', { keys: ['favorite:tr-fav'] });

    const db = await getDb();
    expect((await db.get('favorites', 'tr-fav'))?.deletedAt ?? null).toBeNull();
    expect((await db.get('notes', 'tr-note'))?.deletedAt).toBeGreaterThan(0);
    const remaining = await dispatchOp('trash.list', {});
    expect(remaining.map((e) => e.key).sort()).toEqual(
      ['folder:tr-folder', `tag:${tagId}`, 'note:tr-note', 'screenshot:tr-shot'].sort(),
    );
  });

  it('未知键安全忽略：不抛错、不影响其余条目', async () => {
    await expect(dispatchOp('trash.restore', { keys: ['favorite:nope', 'note:gone'] })).resolves.toBeUndefined();
    expect((await dispatchOp('trash.list', {})).length).toBe(5);
  });

  it('trash.purge：带键精确清除实体+索引；不带键清空回收站', async () => {
    await dispatchOp('trash.purge', { keys: ['favorite:tr-fav'] });
    const db = await getDb();
    expect(await db.get('favorites', 'tr-fav')).toBeUndefined(); // 实体被彻底删除
    expect((await dispatchOp('trash.list', {})).map((e) => e.key)).not.toContain('favorite:tr-fav');

    await dispatchOp('trash.purge', {});
    expect(await dispatchOp('trash.list', {})).toEqual([]);
    expect(await db.get('notes', 'tr-note')).toBeUndefined();
  });
});

// ───────────────────────── data.exportAll 全量数据导出（第 250 轮巡检） ─────────────────────────

describe('data.exportAll 全量数据导出', () => {
  it('白名单聚合：收藏/笔记/复习/周计划等段计数如实；trash / watchRecords / 转写明细不入产物', async () => {
    await putFavorite({
      id: 'ex-fav',
      type: 'time',
      refId: 'ref-1',
      snapshot: { title: '导出收藏', content: 'c' },
      tags: ['标签'],
      pinned: false,
      favoritedAt: NOW,
    });
    await putNote({ id: 'ex-note', courId: 1, teclId: 9001, anchorTime: 5, text: '导出笔记', createdAt: NOW, updatedAt: NOW });
    await upsertWeeklyPlan({
      id: 'ex-weekly',
      perDay: 1,
      bvids: ['BVex0000001'],
      startDate: localDayKey(NOW),
      createdAt: NOW,
      updatedAt: NOW,
    });
    await addWatchRecord({
      courId: 1,
      teclId: 9001,
      date: localDayKey(NOW),
      startTs: NOW,
      endTs: NOW + 1000,
      durationSec: 10,
      playMode: 'vod',
      speed: 1,
      firstWatch: true,
      valid: true,
    });
    await moveToTrash('note', 'ex-trash-note', '回收站条目');

    const result = await dispatchOp('data.exportAll', {});
    expect(typeof result.filename).toBe('string');
    expect(result.filename).toMatch(/^HDUOnline_全量备份_\d{4}-\d{2}-\d{2}\.json$/);
    expect(result.counts.favorites).toBe(1);
    expect(result.counts.notes).toBe(1);
    expect(result.counts.weeklyPlans).toBe(1);
    // 排除段：计数恒 0 / 不存在（白名单式收集，非整库 dump）
    expect(result.counts.watchRecords).toBeUndefined();
    expect(result.counts.trash).toBeUndefined();

    const payload = JSON.parse(result.json) as { app: string; kind: string; data: Record<string, unknown[]> };
    expect(payload.app).toBe('hduonline-data-export');
    expect(payload.kind).toBe('data-export');
    expect(payload.data.favorites).toHaveLength(1);
    expect(payload.data.notes).toHaveLength(1);
    expect('trash' in payload.data).toBe(false);
    expect('watchRecords' in payload.data).toBe(false);
    expect('transcripts' in payload.data).toBe(false);
    // settings 段存在且为对象（键数随 DEFAULT_SETTINGS 演进，不锁死）
    expect(typeof result.counts.settings).toBe('number');
    expect(result.size).toBe(new TextEncoder().encode(result.json).length);
  });

  it('settings 快照走白名单：theme 等偏好进入产物；空库导出各段为空数组', async () => {
    const result = await dispatchOp('data.exportAll', {});
    const payload = JSON.parse(result.json) as {
      version: number;
      data: Record<string, unknown[]> & { settings: Record<string, unknown> };
    };
    expect(payload.version).toBe(1);
    expect(typeof payload.data.settings).toBe('object');
    expect(payload.data.settings.theme).toBeDefined();
    expect(payload.data.favorites).toEqual([]);
    expect(payload.data.notes).toEqual([]);
  });
});

// ───────────────────────── storage.estimate 配额即时查询（第 254 轮巡检） ─────────────────────────

describe('storage.estimate 配额即时查询', () => {
  it('node 环境无 navigator.storage.estimate → 契约返回 null（UI 据此显示「无法获取」）', async () => {
    const result = await dispatchOp('storage.estimate', {});
    expect(result).toBeNull();
  });
});

// ───────────────────────── data.clear 分类联动 ─────────────────────────

describe('data.clear 分类联动', () => {
  beforeEach(async () => {
    const db = await getDb();
    // 幸存者：课程元数据与低层 KV 不属于任何清理分类
    await db.put('courses', { teclId: 7001, subjName: '幸存课程', teacherNames: [], updatedAt: NOW });
    await db.put('kv', { key: 'survivor', value: 'keep', updatedAt: NOW });

    await putTranscript({
      mediaKey: hduMediaKey(701),
      courId: 701,
      segments: [{ s: 0, e: 2, text: '字幕' }],
      model: 'm',
      lang: 'zh',
      glossaryVersion: 0,
      createdAt: NOW,
      source: 'local-asr',
    });
    await putAsrJob({
      mediaKey: hduMediaKey(701),
      courId: 701,
      status: 'done',
      viewNum: 1,
      model: 'm',
      durationSec: 100,
      progress: 1,
      doneChunks: 0,
      totalChunks: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await putAsrChunk({
      key: chunkKey(hduMediaKey(701), 1, 0),
      mediaKey: hduMediaKey(701),
      courId: 701,
      viewNum: 1,
      chunkIndex: 0,
      startSec: 0,
      endSec: 600,
      segments: [],
      createdAt: NOW,
    });
    await db.put('aiResults', {
      mediaKey: hduMediaKey(701),
      courId: 701,
      promptVersion: 1,
      model: 'm',
      topics: [],
      outline: [],
      createdAt: NOW,
    });
    await db.put('chats', {
      id: 'cl-chat-1',
      mediaKey: hduMediaKey(701),
      courId: 701,
      groupId: 'g1',
      role: 'user',
      content: '问',
      status: 'done',
      createdAt: NOW,
    });
    await addWatchRecord({
      courId: 701,
      teclId: 70,
      date: localDayKey(NOW),
      startTs: NOW,
      endTs: NOW + 1000,
      durationSec: 10,
      playMode: 'vod',
      speed: 1,
      firstWatch: true,
      valid: true,
    });
    await addExternalWatch({ date: localDayKey(NOW), bvid: 'BVclear00001', title: '站外视频', seconds: 30 });
    await putFavorite({
      id: 'cl-fav',
      type: 'time',
      refId: 'ref-1',
      snapshot: { title: '收藏', content: 'c' },
      tags: [],
      pinned: false,
      favoritedAt: NOW,
    });
    await upsertFolder({ id: 'cl-folder', name: '文件夹', orderIndex: 0, archived: false, createdAt: NOW });
    await createTag('cl-tag');
    await putNote({ id: 'cl-note', courId: 701, teclId: 70, anchorTime: 3, text: '笔记', createdAt: NOW, updatedAt: NOW });
    await db.put('reviewJobs', {
      id: 'cl-review',
      favoriteId: 'cl-fav',
      dueDate: localDayKey(NOW),
      round: 1,
      template: 'regular',
      status: 'pending',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await moveToTrash('note', 'cl-trash-note', '回收站样例');
    await upsertWeeklyPlan({
      id: 'cl-weekly',
      perDay: 1,
      bvids: ['BVclear00001'],
      startDate: localDayKey(NOW),
      createdAt: NOW,
      updatedAt: NOW,
    });
    await putScreenshot({
      id: 'cl-shot',
      courId: 701,
      view: 1,
      blob: new Blob(['frame']),
      meta: { courseName: '课程', courLabel: '第1周', anchorTime: 5, watermark: false },
      createdAt: NOW,
    });
  });

  it("kinds: ['ai'] 只清 aiResults + chats", async () => {
    await dispatchOp('data.clear', { kinds: ['ai'] });
    expect(await count('aiResults')).toBe(0);
    expect(await count('chats')).toBe(0);
    // 其余分类不受影响
    expect(await count('transcripts')).toBe(1);
    expect(await count('favorites')).toBe(1);
    expect(await count('watchRecords')).toBe(1);
    expect(await count('kv')).toBe(1);
  });

  it("kinds: ['transcript'] 清 transcripts + asrChunks + asrJobs", async () => {
    await dispatchOp('data.clear', { kinds: ['transcript'] });
    expect(await count('transcripts')).toBe(0);
    expect(await count('asrChunks')).toBe(0);
    expect(await count('asrJobs')).toBe(0);
    expect(await count('aiResults')).toBe(1);
    expect(await count('screenshots')).toBe(1);
  });

  it("kinds: ['stats'] 清 watchRecords + externalWatch", async () => {
    await dispatchOp('data.clear', { kinds: ['stats'] });
    expect(await count('watchRecords')).toBe(0);
    expect(await count('externalWatch')).toBe(0);
    expect(await count('transcripts')).toBe(1);
    expect(await count('favorites')).toBe(1);
  });

  it("kinds: ['library'] 清收藏/文件夹/标签/笔记/复习/回收站/周计划，但不动截图与转写", async () => {
    await dispatchOp('data.clear', { kinds: ['library'] });
    expect(await count('favorites')).toBe(0);
    expect(await count('folders')).toBe(0);
    expect(await count('tags')).toBe(0);
    expect(await count('notes')).toBe(0);
    expect(await count('reviewJobs')).toBe(0);
    expect(await count('trash')).toBe(0);
    expect(await count('weeklyPlans')).toBe(0);
    // library 不连带截图 / 转写 / 统计
    expect(await count('screenshots')).toBe(1);
    expect(await count('transcripts')).toBe(1);
    expect(await count('watchRecords')).toBe(1);
  });

  it("kinds: ['screenshots'] 只清 screenshots", async () => {
    await dispatchOp('data.clear', { kinds: ['screenshots'] });
    expect(await count('screenshots')).toBe(0);
    expect(await count('favorites')).toBe(1);
    expect(await count('transcripts')).toBe(1);
  });

  it('多分类组合：不重叠的 store 各自清理，重叠只清一次', async () => {
    await dispatchOp('data.clear', { kinds: ['ai', 'stats'] });
    expect(await count('aiResults')).toBe(0);
    expect(await count('chats')).toBe(0);
    expect(await count('watchRecords')).toBe(0);
    expect(await count('externalWatch')).toBe(0);
    expect(await count('transcripts')).toBe(1);
  });

  it("kinds: ['all'] 等价于六类全清；kv 与 courses 幸存", async () => {
    await dispatchOp('data.clear', { kinds: ['all'] });
    for (const store of [
      'aiResults',
      'chats',
      'transcripts',
      'asrChunks',
      'asrJobs',
      'watchRecords',
      'externalWatch',
      'favorites',
      'folders',
      'tags',
      'notes',
      'reviewJobs',
      'trash',
      'weeklyPlans',
      'screenshots',
    ] as const) {
      expect(await count(store), `store ${store} 应被 all 清空`).toBe(0);
    }
    const db = await getDb();
    expect(await db.get('kv', 'survivor')).toMatchObject({ value: 'keep' });
    expect(await db.get('courses', 7001)).toMatchObject({ subjName: '幸存课程' });
  });

  it('空 kinds 不清任何 store', async () => {
    await dispatchOp('data.clear', { kinds: [] });
    expect(await count('transcripts')).toBe(1);
    expect(await count('favorites')).toBe(1);
    expect(await count('watchRecords')).toBe(1);
    expect(await count('trash')).toBe(1);
  });
});

// ───────────────────────── qa.groupsAll 跨 P 聚合（第 104 轮巡检） ─────────────────────────

describe('qa.groupsAll 跨 P 聚合', () => {
  it('聚合 bvid 全部分 P 的会话分组并回填 mediaKey/p；其他视频不串', async () => {
    const row = (overrides: Partial<ChatMessageEntity>): ChatMessageEntity =>
      ({ id: 'm', mediaKey: 'bili:BV1xx', groupId: 'g1', role: 'user', content: '问', status: 'done', createdAt: 1, ...overrides });
    await putChat(row({ id: 'c1', mediaKey: 'bili:BV1xx', groupId: 'g1', content: 'P1 的问题', createdAt: 1000 }));
    await putChat(row({ id: 'c2', mediaKey: 'bili:BV1xx:p2', groupId: 'g2', content: 'P2 的问题', createdAt: 2000 }));
    await putChat(row({ id: 'c3', mediaKey: 'bili:BV1yy', groupId: 'g3', content: '别的视频', createdAt: 3000 }));
    const groups = await dispatchOp('qa.groupsAll', { bvid: 'BV1xx' });
    expect(groups.map((g) => g.groupId).sort()).toEqual(['g1', 'g2']);
    const p2 = groups.find((g) => g.groupId === 'g2');
    expect(p2?.p).toBe(2);
    expect(p2?.mediaKey).toBe('bili:BV1xx:p2');
    expect(groups.find((g) => g.groupId === 'g1')?.p).toBe(1);
  });

  it('空 bvid 返回空数组（防御）', async () => {
    expect(await dispatchOp('qa.groupsAll', { bvid: '' })).toEqual([]);
  });

  it('qa.listAll：跨 P 合并全部消息（时间升序，他视频不串，第 105 轮）', async () => {
    const row = (overrides: Partial<ChatMessageEntity>): ChatMessageEntity =>
      ({ id: 'm', mediaKey: 'bili:BV1xx', groupId: 'g1', role: 'user', content: '问', status: 'done', createdAt: 1, ...overrides });
    await putChat(row({ id: 'c1', mediaKey: 'bili:BV1xx', groupId: 'g1', content: 'P1 的问题', createdAt: 2000 }));
    await putChat(row({ id: 'c2', mediaKey: 'bili:BV1xx:p2', groupId: 'g2', content: 'P2 的问题', createdAt: 1000 }));
    await putChat(row({ id: 'c3', mediaKey: 'bili:BV1yy', groupId: 'g3', content: '别的视频', createdAt: 3000 }));
    const list = await dispatchOp('qa.listAll', { bvid: 'BV1xx' });
    expect(list.map((m) => m.id)).toEqual(['c2', 'c1']);
    expect(await dispatchOp('qa.listAll', { bvid: '' })).toEqual([]);
  });
});

// ───────────────────────── review.reschedule 顺延（第 107 轮巡检） ─────────────────────────

describe('review.reschedule 顺延', () => {
  const job = (overrides: Partial<ReviewJobEntity>): ReviewJobEntity => ({
    id: 'rj1',
    favoriteId: 'fav1',
    dueDate: '2026-11-18',
    round: 1,
    template: 'regular',
    status: 'pending',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });

  it('pending 作业改期生效；已完成/已跳过不动；非法日期拒绝', async () => {
    const db = await getDb();
    await db.put('reviewJobs', job({ id: 'rj-pending', status: 'pending' }));
    await db.put('reviewJobs', job({ id: 'rj-done', status: 'done' }));
    await dispatchOp('review.reschedule', { jobId: 'rj-pending', dueDate: '2026-11-20' });
    expect((await db.get('reviewJobs', 'rj-pending'))?.dueDate).toBe('2026-11-20');
    // 改期留痕（第 111 轮）：rescheduleLog 追加 { from, to, at }
    const log = (await db.get('reviewJobs', 'rj-pending'))?.rescheduleLog;
    expect(Array.isArray(log)).toBe(true);
    expect(log).toHaveLength(1);
    expect(log?.[0]).toMatchObject({ from: '2026-11-18', to: '2026-11-20' });
    await dispatchOp('review.reschedule', { jobId: 'rj-done', dueDate: '2026-11-20' });
    expect((await db.get('reviewJobs', 'rj-done'))?.dueDate).toBe('2026-11-18');
    await expect(dispatchOp('review.reschedule', { jobId: 'rj-pending', dueDate: 'bad' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});

// ───────────────────────── note.listAll 全库笔记（第 112 轮巡检） ─────────────────────────

describe('note.listAll 全库笔记', () => {
  it('站内 + B 站外部笔记一并返回；软删除剔除', async () => {
    await putFavorite({
      id: 'fav-hdu',
      type: 'time',
      courId: 1,
      teclId: 9001,
      snapshot: { title: '站内收藏', content: '' },
      folderId: null,
      tags: [],
      pinned: false,
      favoritedAt: 1,
    });
    await putNote({ id: 'n-hdu', courId: 1, teclId: 9001, anchorTime: 10, text: '站内笔记', createdAt: 1, updatedAt: 1 });
    await putNote({ id: 'n-bili', mediaKey: 'bili:BV1test', anchorTime: 20, text: 'B 站笔记', createdAt: 1, updatedAt: 1 });
    await putNote({ id: 'n-del', courId: 1, teclId: 9001, anchorTime: 30, text: '已删除', createdAt: 1, updatedAt: 1 });
    await dispatchOp('note.softDelete', { id: 'n-del' });
    const all = await dispatchOp('note.listAll', {});
    expect(all.map((n) => n.id).sort()).toEqual(['n-bili', 'n-hdu']);
  });
});

// ───────────────────────── review.reopen 撤销完成（第 116 轮巡检） ─────────────────────────

describe('review.reopen 撤销完成', () => {
  it('done/skipped 作业回到 pending；到期日早于今天时拉回今天；pending 不动', async () => {
    const db = await getDb();
    await db.put('reviewJobs', { id: 'rj-done', favoriteId: 'fav1', dueDate: '2026-11-10', round: 1, template: 'regular', status: 'done', createdAt: 1, updatedAt: 1 });
    await db.put('reviewJobs', { id: 'rj-skip', favoriteId: 'fav1', dueDate: '2026-11-25', round: 1, template: 'regular', status: 'skipped', createdAt: 1, updatedAt: 1 });
    await db.put('reviewJobs', { id: 'rj-pending', favoriteId: 'fav1', dueDate: '2026-11-25', round: 1, template: 'regular', status: 'pending', createdAt: 1, updatedAt: 1 });
    await dispatchOp('review.reopen', { jobId: 'rj-done' });
    const reopened = await db.get('reviewJobs', 'rj-done');
    expect(reopened?.status).toBe('pending');
    expect(reopened?.dueDate).toBe(localDayKey());
    await dispatchOp('review.reopen', { jobId: 'rj-skip' });
    const skipped = await db.get('reviewJobs', 'rj-skip');
    expect(skipped?.status).toBe('pending');
    expect(skipped?.dueDate).toBe('2026-11-25');
    await dispatchOp('review.reopen', { jobId: 'rj-pending' });
    expect((await db.get('reviewJobs', 'rj-pending'))?.status).toBe('pending');
  });
});
