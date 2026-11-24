/** 数据层测试（§9.1：迁移、转写合并、软删除、回收站、收藏与课程包）。 */

import { beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/core/db';
import {
  ensureDefaultFolder,
  listFavorites,
  putFavorite,
  restoreFavorites,
  softDeleteFavorites,
  softDeleteFolder,
  updateFavorite,
} from '@/core/db/repo/library';
import { listTrash, purgeExpiredTrash, purgeTrashEntries } from '@/core/db/repo/trash';
import { clearTranscript, getTranscript, searchTranscripts } from '@/core/db/repo/content';
import {
  assembleTranscript,
  chunkKey,
  clearAsrChunks,
  coveredAudioSec,
  coveredRanges,
  putAsrChunk,
} from '@/core/db/repo/asr';
import { addWatchRecord, listWatchRecords, sumValidSecByDay } from '@/core/db/repo/stats';
import {
  kvGet,
  kvSet,
  listCurriculum,
  listMissedExcluded,
  putCurriculum,
  setMissedExcluded,
} from '@/core/db/repo/misc';
import { buildCourseBundles } from '@/core/stats/aggregate';
import { localDayKey } from '@/core/shared/utils';
import { ASR_PIPELINE_VERSION, DB_VERSION } from '@/core/shared/constants';
import { hduMediaKey, type MediaKey } from '@/core/shared/mediaRef';
import type {
  AiResultEntity,
  AsrChunkEntity,
  CourseEntity,
  SessionEntity,
  TranscriptEntity,
  WatchRecordEntity,
} from '@/core/shared/types';

beforeAll(async () => {
  await getDb();
});

/** 测试里实体形状已 mediaKey 化：courId 数值 → hdu:<id>（纯形状适配，断言语义不变） */
const mk = (courId: number): MediaKey => hduMediaKey(courId);

describe('IndexedDB 迁移与事务', () => {
  it('数据库以当前版本打开且包含全部表', async () => {
    const db = await getDb();
    expect(db.version).toBe(DB_VERSION);
    const stores = [...db.objectStoreNames];
    for (const name of [
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
    ]) {
      expect(stores).toContain(name);
    }
  });

  it('关键索引齐全（查询路径依赖）', async () => {
    const db = await getDb();
    const favorites = db.transaction('favorites').store;
    expect(Array.from(favorites.indexNames)).toEqual(
      expect.arrayContaining(['courId', 'teclId', 'folderId', 'tags', 'favoritedAt', 'type']),
    );
    const records = db.transaction('watchRecords').store;
    expect(Array.from(records.indexNames)).toEqual(expect.arrayContaining(['date', 'courId', 'daySession']));
    const chunks = db.transaction('asrChunks').store;
    expect(Array.from(chunks.indexNames)).toContain('courId');
    const progress = db.transaction('videoProgress').store;
    expect(Array.from(progress.indexNames)).toContain('updatedAt');
    const external = db.transaction('externalWatch').store;
    expect(Array.from(external.indexNames)).toContain('date');
  });

  it('重复打开返回同一连接（单例），关闭后可重新打开', async () => {
    const a = await getDb();
    const b = await getDb();
    expect(a).toBe(b);
    await closeDb();
    const c = await getDb();
    expect(c).toBeTruthy();
    expect(c.version).toBe(DB_VERSION);
  });
});

describe('收藏与回收站', () => {
  it('收藏去重：同一 refId 同类不重复写入', async () => {
    const first = await putFavorite({
      id: 'fav-1',
      type: 'ai',
      refId: 'chat-1',
      snapshot: { title: 'AI 回答', content: '内容' },
      teclId: 9001,
      courId: 1227038,
      tags: [],
      pinned: false,
      favoritedAt: Date.now(),
    });
    const second = await putFavorite({
      id: 'fav-2',
      type: 'ai',
      refId: 'chat-1',
      snapshot: { title: 'AI 回答（重复）', content: '内容' },
      teclId: 9001,
      courId: 1227038,
      tags: [],
      pinned: false,
      favoritedAt: Date.now(),
    });
    expect(second.id).toBe(first.id);
    const list = await listFavorites({ courId: 1227038 });
    expect(list).toHaveLength(1);
  });

  it('软删除后不出现在列表，但进入回收站且可还原', async () => {
    await softDeleteFavorites(['fav-1']);
    const list = await listFavorites({ courId: 1227038 });
    expect(list).toHaveLength(0);
    // includeDeleted 仍能取到实体（就地软删除）
    const withDeleted = await listFavorites({ courId: 1227038, includeDeleted: true });
    expect(withDeleted).toHaveLength(1);
    expect(withDeleted[0]?.deletedAt).toBeTypeOf('number');

    const trash = await listTrash();
    expect(trash.some((entry) => entry.key === 'favorite:fav-1')).toBe(true);

    await restoreFavorites(['fav-1']);
    const restored = await listFavorites({ courId: 1227038 });
    expect(restored).toHaveLength(1);
    expect((await listTrash()).some((entry) => entry.key === 'favorite:fav-1')).toBe(false);
  });

  it('回收站可永久删除', async () => {
    await updateFavorite('fav-1', { snapshot: { title: '待删除', content: 'x' } });
    await softDeleteFavorites(['fav-1']);
    const removed = await purgeTrashEntries(['favorite:fav-1']);
    expect(removed).toBe(1);
    const db = await getDb();
    expect(await db.get('favorites', 'fav-1')).toBeUndefined();
    expect((await listTrash()).some((entry) => entry.key === 'favorite:fav-1')).toBe(false);
  });

  it('回收站到期清理只删除过期项', async () => {
    await putFavorite({
      id: 'fav-expired',
      type: 'time',
      snapshot: { title: '过期项', content: 'x' },
      teclId: 9001,
      tags: [],
      pinned: false,
      favoritedAt: Date.now(),
    });
    await softDeleteFavorites(['fav-expired']);
    const db = await getDb();
    const entry = await db.get('trash', 'favorite:fav-expired');
    expect(entry).toBeTruthy();
    // 手动把到期时间挪到过去
    await db.put('trash', { ...(entry as NonNullable<typeof entry>), expiresAt: Date.now() - 1000 });
    const purged = await purgeExpiredTrash();
    expect(purged).toBeGreaterThanOrEqual(1);
    expect((await listTrash()).some((item) => item.key === 'favorite:fav-expired')).toBe(false);
    expect(await db.get('favorites', 'fav-expired')).toBeUndefined();
  });

  it('文件夹：首次收藏自动创建，删除文件夹后条目转未分组', async () => {
    const folder = await ensureDefaultFolder(9001, '线性代数（2026-2027-1）');
    expect(folder.id).toBeTruthy();
    const again = await ensureDefaultFolder(9001, '重复调用应返回同一文件夹');
    expect(again.id).toBe(folder.id);

    const fav = await putFavorite({
      id: 'fav-folder',
      type: 'time',
      snapshot: { title: '时间点', content: 'x' },
      teclId: 9001,
      courId: 1227038,
      folderId: folder.id,
      tags: ['重点', '考点'],
      pinned: true,
      favoritedAt: Date.now(),
    });
    expect(fav.folderId).toBe(folder.id);

    const byTag = await listFavorites({ tags: ['重点'] });
    expect(byTag.some((item) => item.id === 'fav-folder')).toBe(true);
    const byBothTags = await listFavorites({ tags: ['重点', '考点'] });
    expect(byBothTags.some((item) => item.id === 'fav-folder')).toBe(true);
    const byMissingTag = await listFavorites({ tags: ['重点', '不存在'] });
    expect(byMissingTag).toHaveLength(0);

    await softDeleteFolder(folder.id);
    const afterDelete = await listFavorites({ courId: 1227038 });
    expect(afterDelete.find((item) => item.id === 'fav-folder')?.folderId).toBeNull();
    expect((await listTrash()).some((item) => item.key === `folder:${folder.id}`)).toBe(true);
  });

  it('词表更新后可重新应用纠错并更新版本号', async () => {
    const { applyGlossary } = await import('@/core/db/repo/content');
    const transcript: TranscriptEntity = {
      mediaKey: mk(1227040),
      courId: 1227040,
      segments: [{ s: 0, e: 5, text: '航列式' }],
      model: 'fast',
      lang: 'zh',
      glossaryVersion: 0,
      createdAt: Date.now(),
      source: 'local-asr',
    };
    const { putTranscript } = await import('@/core/db/repo/content');
    await putTranscript(transcript);
    const updated = await applyGlossary(mk(1227040));
    expect(updated?.segments[0]?.text).toBe('行列式');
    expect(updated?.glossaryVersion).not.toBe(0);
  });
});

describe('转写仓储', () => {
  it('增量分片可组装为完整转写，并应用词表纠错', async () => {
    await putAsrChunk({
      key: chunkKey(mk(1227038), 1, 0),
      mediaKey: mk(1227038),
      courId: 1227038,
      viewNum: 1,
      chunkIndex: 0,
      startSec: 0,
      endSec: 600,
      segments: [
        { s: 5, e: 10, text: '今天我们讲科拉莫法则' },
        { s: 20, e: 25, text: '以及行列势的定义' },
      ],
      createdAt: Date.now(),
    });
    await putAsrChunk({
      key: chunkKey(mk(1227038), 1, 1),
      mediaKey: mk(1227038),
      courId: 1227038,
      viewNum: 1,
      chunkIndex: 1,
      startSec: 600,
      endSec: 1200,
      segments: [{ s: 700, e: 710, text: '继续看例子' }],
      createdAt: Date.now(),
    });

    const transcript = await assembleTranscript(mk(1227038), { model: 'fast', lang: 'zh', durationSec: 2820 });
    expect(transcript.segments).toHaveLength(3);
    // 内置词表已把误听纠正
    expect(transcript.segments[0]?.text).toContain('克拉默法则');
    expect(transcript.segments[1]?.text).toContain('行列式');
    expect(transcript.coveredSec).toBe(1200);
    expect(transcript.partial).toBe(false);

    // 分片已被清理（保留 transcripts）
    const db = await getDb();
    expect(await db.count('asrChunks')).toBe(0);
  });

  it('关键词检索返回带时间戳的命中', async () => {
    const hits = await searchTranscripts('克拉默', [mk(1227038)]);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.mediaKey).toBe(mk(1227038));
    expect(hits[0]?.courId).toBe(1227038);
    expect(hits[0]?.start).toBe(5);
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it('清除转写同时清理分片', async () => {
    await putAsrChunk({
      key: chunkKey(mk(1227038), 1, 5),
      mediaKey: mk(1227038),
      courId: 1227038,
      viewNum: 1,
      chunkIndex: 5,
      startSec: 3000,
      endSec: 3600,
      segments: [{ s: 3000, e: 3010, text: 'x' }],
      createdAt: Date.now(),
    });
    await clearTranscript(mk(1227038));
    expect(await getTranscript(mk(1227038))).toBeNull();
    const db = await getDb();
    expect(await db.count('asrChunks')).toBe(0);
  });

  it('空分片不会覆盖已有字幕（避免转写跑完反而提示没有字幕）', async () => {
    const courId = 1227050;
    await putAsrChunk({
      key: chunkKey(mk(courId), 1, 0),
      mediaKey: mk(courId),
      courId,
      viewNum: 1,
      chunkIndex: 0,
      startSec: 0,
      endSec: 600,
      segments: [{ s: 5, e: 10, text: '已有字幕' }],
      createdAt: Date.now(),
    });
    const first = await assembleTranscript(mk(courId), { model: 'fast', lang: 'zh', durationSec: 600 });
    expect(first.segments).toHaveLength(1);

    // 新一轮只有静音分片：组装结果为空，必须保留原字幕
    await putAsrChunk({
      key: chunkKey(mk(courId), 1, 1),
      mediaKey: mk(courId),
      courId,
      viewNum: 1,
      chunkIndex: 1,
      startSec: 600,
      endSec: 1200,
      segments: [],
      createdAt: Date.now(),
    });
    const second = await assembleTranscript(mk(courId), { model: 'fast', lang: 'zh', durationSec: 1200 });
    expect(second.segments.map((s) => s.text)).toEqual(['已有字幕']);
    expect((await getTranscript(mk(courId)))?.segments).toHaveLength(1);
  });

  it('从未产出文字时仍落库空转写（供 UI 区分「未转写」与「转写无文字」）', async () => {
    const courId = 1227051;
    await putAsrChunk({
      key: chunkKey(mk(courId), 1, 0),
      mediaKey: mk(courId),
      courId,
      viewNum: 1,
      chunkIndex: 0,
      startSec: 0,
      endSec: 600,
      segments: [],
      createdAt: Date.now(),
    });
    const transcript = await assembleTranscript(mk(courId), { model: 'fast', lang: 'zh', durationSec: 600 });
    expect(transcript.segments).toHaveLength(0);
    expect((await getTranscript(mk(courId)))?.segments).toHaveLength(0);
  });

  it('覆盖秒数按分片区间并集计算（不吃窗口空档、不重复计跨机位分片）', () => {
    expect(
      coveredAudioSec([
        { startSec: 0, endSec: 600 },
        { startSec: 600, endSec: 1200 },
      ]),
    ).toBe(1200);
    // 窗口之间有空档：0–10 分钟 + 30–40 分钟 = 真实 1200s（而非最大 endSec 的 2400s）
    expect(
      coveredAudioSec(
        [
          { startSec: 0, endSec: 600 },
          { startSec: 1800, endSec: 2400 },
        ],
        2820,
      ),
    ).toBe(1200);
    // 跨机位同名分片重叠：只算一次
    expect(
      coveredAudioSec(
        [
          { startSec: 600, endSec: 1200 },
          { startSec: 600, endSec: 1200 },
        ],
        2820,
      ),
    ).toBe(600);
    // 不超过总时长
    expect(
      coveredAudioSec(
        [
          { startSec: 0, endSec: 600 },
          { startSec: 600, endSec: 900 },
        ],
        800,
      ),
    ).toBe(800);
    // 乱序与反向区间也按并集处理
    expect(
      coveredAudioSec([
        { startSec: 900, endSec: 600 },
        { startSec: 0, endSec: 600 },
      ]),
    ).toBe(900);
  });

  it('覆盖区间保留窗口之间的空档（问答据此区分“已处理”与“有文字”）', () => {
    expect(
      coveredRanges([
        { startSec: 0, endSec: 600 },
        { startSec: 600, endSec: 1200 },
      ]),
    ).toEqual([{ start: 0, end: 1200 }]);
    expect(
      coveredRanges(
        [
          { startSec: 0, endSec: 600 },
          { startSec: 1800, endSec: 2400 },
        ],
        2820,
      ),
    ).toEqual([
      { start: 0, end: 600 },
      { start: 1800, end: 2400 },
    ]);
    // 超出课次时长的部分被裁剪
    expect(coveredRanges([{ startSec: 0, endSec: 600 }], 300)).toEqual([{ start: 0, end: 300 }]);
  });

  it('旧管线分片不参与组装（升级后自动重新转写）', async () => {
    const courId = 1227052;
    await putAsrChunk({
      key: chunkKey(mk(courId), 1, 0),
      mediaKey: mk(courId),
      courId,
      viewNum: 1,
      chunkIndex: 0,
      startSec: 0,
      endSec: 600,
      segments: [{ s: 5, e: 10, text: '旧版字幕' }],
      createdAt: Date.now(),
      pipelineVersion: ASR_PIPELINE_VERSION - 1,
    });
    // 只有旧分片时视为没有可用转写
    await expect(assembleTranscript(mk(courId), { model: 'fast', lang: 'zh', durationSec: 1200 })).rejects.toThrow();

    await putAsrChunk({
      key: chunkKey(mk(courId), 1, 1),
      mediaKey: mk(courId),
      courId,
      viewNum: 1,
      chunkIndex: 1,
      startSec: 600,
      endSec: 1200,
      segments: [{ s: 605, e: 610, text: '新版字幕' }],
      createdAt: Date.now(),
    });
    const transcript = await assembleTranscript(mk(courId), { model: 'fast', lang: 'zh', durationSec: 1200 });
    expect(transcript.segments.map((segment) => segment.text)).toEqual(['新版字幕']);
    expect(transcript.coverage).toEqual([{ start: 600, end: 1200 }]);
    expect(transcript.pipelineVersion).toBe(ASR_PIPELINE_VERSION);
  });

  it('片段作业保留分片（累积 + 复用）；按区间清理只影响目标分片', async () => {
    const courId = 1227039;
    for (const index of [1, 2, 3] as const) {
      await putAsrChunk({
        key: chunkKey(mk(courId), 1, index),
        mediaKey: mk(courId),
        courId,
        viewNum: 1,
        chunkIndex: index,
        startSec: index * 600,
        endSec: (index + 1) * 600,
        segments: [{ s: index * 600 + 5, e: index * 600 + 10, text: `片段 ${index}` }],
        createdAt: Date.now(),
      });
    }
    // 其他机位的同名分片不应被"重转当前片段"误伤
    await putAsrChunk({
      key: chunkKey(mk(courId), 2, 2),
      mediaKey: mk(courId),
      courId,
      viewNum: 2,
      chunkIndex: 2,
      startSec: 1200,
      endSec: 1800,
      segments: [{ s: 1205, e: 1210, text: '机位2 片段2' }],
      createdAt: Date.now(),
    });

    // 片段作业完成：keepChunks 保留分片，转写覆盖两个窗口的并集
    const transcript = await assembleTranscript(
      mk(courId),
      { model: 'fast', lang: 'zh', durationSec: 2820, window: { start: 600, end: 2400 } },
      { keepChunks: true },
    );
    const db = await getDb();
    expect(await db.count('asrChunks')).toBe(4);
    expect(transcript.window).toEqual({ start: 600, end: 2400 });
    expect(transcript.coveredSec).toBe(1800);

    // 重转当前片段：只清机位 1 的分片 2–2（其余分片保留，复用不受影响）
    await clearAsrChunks(mk(courId), { viewNum: 1, fromChunk: 2, toChunk: 2 });
    const left = await db.getAll('asrChunks', IDBKeyRange.bound(`${mk(courId)}:`, `${mk(courId)}:\uffff`));
    expect(left.map((chunk: AsrChunkEntity) => chunk.key).sort()).toEqual([
      `${mk(courId)}:1:1`,
      `${mk(courId)}:1:3`,
      `${mk(courId)}:2:2`,
    ]);
  });

  it('没有分片时组装报错', async () => {
    await expect(assembleTranscript(mk(1337000), { model: 'fast', lang: 'zh', durationSec: 100 })).rejects.toMatchObject({
      code: 'ASR_PARSE_FAILED',
    });
  });
});

describe('统计流水与课表 KV', () => {
  it('按日聚合只计有效流水', async () => {
    const day = localDayKey();
    await addWatchRecord({
      courId: 1227038,
      teclId: 9001,
      date: day,
      startTs: Date.now() - 60_000,
      endTs: Date.now(),
      durationSec: 60,
      playMode: 'vod',
      speed: 1,
      firstWatch: true,
      valid: true,
    });
    await addWatchRecord({
      courId: 1227038,
      teclId: 9001,
      date: day,
      startTs: Date.now() - 30_000,
      endTs: Date.now(),
      durationSec: 30,
      playMode: 'vod',
      speed: 1,
      firstWatch: false,
      valid: false,
    });
    expect(await sumValidSecByDay(day)).toBe(60);
    const records = await listWatchRecords(day, day);
    expect(records).toHaveLength(2);
  });

  it('KV 读写与课表快照', async () => {
    await kvSet('demo', { a: 1 });
    expect(await kvGet<{ a: number }>('demo')).toEqual({ a: 1 });
    expect(await kvGet('missing')).toBeNull();

    await putCurriculum([
      {
        courId: 1,
        teclId: 9001,
        subjName: '线性代数',
        beginTime: Date.now(),
        endTime: Date.now() + 3600_000,
        letiNumber: 12,
      },
    ]);
    const curriculum = await listCurriculum();
    expect(curriculum).toHaveLength(1);
    expect(curriculum[0]?.subjName).toBe('线性代数');

    await setMissedExcluded(1, true);
    expect(await listMissedExcluded()).toContain(1);
    await setMissedExcluded(1, false);
    expect(await listMissedExcluded()).not.toContain(1);
  });
});

describe('每周学习计划仓储（weeklyPlans，DB v4）', () => {
  it('upsert / get / delete 往返一致；按 createdAt 升序；坏数据跳过不抛错', async () => {
    const { getWeeklyPlans, upsertWeeklyPlan, deleteWeeklyPlan } = await import('@/core/db/repo/weekly');
    const db = await getDb();
    const t1 = new Date('2026-11-09T10:00:00').getTime();
    const t2 = new Date('2026-11-10T10:00:00').getTime();
    // 先写 createdAt 大的、后写小的：读取按创建序（升序）返回
    await upsertWeeklyPlan({
      id: 'weekly-2',
      perDay: 5,
      bvids: ['BV1', 'BV2'],
      startDate: '2026-11-10',
      createdAt: t2,
      updatedAt: t2,
    });
    await upsertWeeklyPlan({
      id: 'weekly-1',
      label: '收藏夹 A',
      perDay: 2,
      bvids: ['BV1', 'BV1', 'BV3'],
      startDate: '2026-11-09',
      createdAt: t1,
      updatedAt: t1,
    });
    // 形状不合法的记录（perDay 非数值）：读取时跳过，不抛错
    await db.put('weeklyPlans', { id: 'weekly-bad', perDay: '垃圾', bvids: null } as never);

    const plans = await getWeeklyPlans();
    expect(plans.map((plan) => plan.id)).toEqual(['weekly-1', 'weekly-2']);
    expect(plans[0]?.label).toBe('收藏夹 A');
    // repo 层不做去重（保序去重是 core/plan/weekly 构造期职责），原样返回入库数据
    expect(plans[0]?.bvids).toEqual(['BV1', 'BV1', 'BV3']);

    // 幂等：删除不存在的主键不抛错
    await expect(deleteWeeklyPlan('missing-id')).resolves.toBeUndefined();
    await deleteWeeklyPlan('weekly-2');
    await db.delete('weeklyPlans', 'weekly-bad');
    expect((await getWeeklyPlans()).map((plan) => plan.id)).toEqual(['weekly-1']);
    await deleteWeeklyPlan('weekly-1');
    expect(await db.count('weeklyPlans')).toBe(0);
  });
});

describe('学习中心课程包', () => {
  it('汇总课次、有效观看秒数、完看数、转写与知识点，并按最近活动排序', async () => {
    const db = await getDb();
    const NOW = Date.now();

    const courseA: CourseEntity = {
      teclId: 9101,
      subjName: '模拟课程 A',
      teacherNames: ['模拟教师'],
      updatedAt: NOW - 10_000,
    };
    const courseB: CourseEntity = {
      teclId: 9102,
      subjName: '模拟课程 B',
      teacherNames: [],
      updatedAt: NOW - 20_000,
    };
    await db.put('courses', courseA);
    await db.put('courses', courseB);

    const sessionsA: SessionEntity[] = [
      {
        courId: 2227038,
        teclId: 9101,
        beginTime: new Date(NOW - 3_600_000).toISOString(),
        endTime: new Date(NOW - 3_000_000).toISOString(),
        durationSec: 2820,
        watchState: 'finished',
        courseName: '模拟课程 A',
        courLabel: '第5周 / 模拟 / 第12节课',
        updatedAt: NOW - 5_000,
      },
      {
        courId: 2227039,
        teclId: 9101,
        beginTime: new Date(NOW - 7 * 24 * 3_600_000).toISOString(),
        endTime: new Date(NOW - 7 * 24 * 3_600_000 + 2_820_000).toISOString(),
        durationSec: 2820,
        watchState: 'watching',
        courseName: '模拟课程 A',
        courLabel: '第4周 / 模拟 / 第11节课',
        updatedAt: NOW - 30_000,
      },
    ];
    const sessionB: SessionEntity = {
      courId: 2227040,
      teclId: 9102,
      beginTime: new Date(NOW - 2 * 3_600_000).toISOString(),
      endTime: new Date(NOW - 3_600_000).toISOString(),
      durationSec: 1800,
      watchState: 'unwatched',
      courseName: '模拟课程 B',
      courLabel: '第5周 / 模拟 / 第10节课',
      updatedAt: NOW - 15_000,
    };
    for (const session of [...sessionsA, sessionB]) await db.put('sessions', session);

    const transcript: TranscriptEntity = {
      mediaKey: mk(2227038),
      courId: 2227038,
      segments: [{ s: 0, e: 10, text: '模拟转写' }],
      model: 'fast',
      lang: 'zh',
      glossaryVersion: 1,
      createdAt: NOW - 3000,
      updatedAt: NOW - 2000,
      source: 'local-asr',
    };
    await db.put('transcripts', transcript);

    const ai: AiResultEntity = {
      mediaKey: mk(2227038),
      courId: 2227038,
      promptVersion: 1,
      model: 'test-model',
      topics: [
        { name: '知识点一', summary: '', confidence: 'high', intervals: [[0, 10]] },
        { name: '知识点二', summary: '', confidence: 'high', intervals: [[10, 20]] },
      ],
      outline: [{ level: 1, title: '主题', start: 0, end: 20 }],
      createdAt: NOW - 1000,
    };
    await db.put('aiResults', ai);

    const records: WatchRecordEntity[] = [
      {
        courId: 2227038,
        teclId: 9101,
        date: localDayKey(NOW),
        startTs: NOW - 400_000,
        endTs: NOW - 500,
        durationSec: 600,
        playMode: 'vod',
        speed: 1,
        firstWatch: true,
        valid: true,
      },
      {
        courId: 2227038,
        teclId: 9101,
        date: localDayKey(NOW),
        startTs: NOW - 300_000,
        endTs: NOW - 200,
        durationSec: 100,
        playMode: 'vod',
        speed: 1,
        firstWatch: false,
        valid: false,
      },
      {
        courId: 2227039,
        teclId: 9101,
        date: localDayKey(NOW - 7 * 24 * 3_600_000),
        startTs: NOW - 7 * 24 * 3_600_000,
        endTs: NOW - 7 * 24 * 3_600_000 + 300_000,
        durationSec: 300,
        playMode: 'vod',
        speed: 1,
        firstWatch: true,
        valid: true,
      },
      {
        courId: 2227040,
        teclId: 9102,
        date: localDayKey(NOW),
        startTs: NOW - 100_000,
        endTs: NOW - 10_000,
        durationSec: 90,
        playMode: 'vod',
        speed: 1,
        firstWatch: true,
        valid: true,
      },
    ];
    for (const record of records) await db.add('watchRecords', record);

    const bundles = await buildCourseBundles();
    const bundleA = bundles.find((bundle) => bundle.course.teclId === 9101);
    const bundleB = bundles.find((bundle) => bundle.course.teclId === 9102);
    expect(bundleA).toBeTruthy();
    expect(bundleB).toBeTruthy();

    expect(bundleA?.sessionCount).toBe(2);
    expect(bundleA?.sessions.map((session) => session.courId)).toEqual([2227038, 2227039]);
    expect(bundleA?.watchedSec).toBe(900);
    expect(bundleA?.finishedCount).toBe(1);
    expect(bundleA?.transcriptCount).toBe(1);
    expect(bundleA?.topicCount).toBe(2);
    expect(bundleA?.lastActivityAt).toBeGreaterThanOrEqual(NOW - 1000);

    expect(bundleB?.sessionCount).toBe(1);
    expect(bundleB?.watchedSec).toBe(90);
    expect(bundleB?.finishedCount).toBe(0);
    expect(bundleB?.transcriptCount).toBe(0);
    expect(bundleB?.topicCount).toBe(0);

    expect(bundles[0]?.course.teclId).toBe(9101);
  });
});
