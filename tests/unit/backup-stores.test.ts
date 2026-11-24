/** 全量备份 store 覆盖矩阵与导入兼容性测试（exporters / importer）。 */

import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/core/db';
import {
  BACKUP_APP_ID,
  BACKUP_EXCLUDED_STORES,
  BACKUP_FORMAT_VERSION,
  BACKUP_STORES,
  exportBackup,
} from '@/core/export/exporters';
import { runImport, stageImportJob } from '@/core/export/importer';
import { putFavorite } from '@/core/db/repo/library';
import { putVideoProgress } from '@/core/db/repo/video';
import { addExternalWatch } from '@/core/db/repo/external';
import { putCurriculum } from '@/core/db/repo/misc';
import { upsertWeeklyPlan } from '@/core/db/repo/weekly';
import { getTranscript } from '@/core/db/repo/content';
import { biliMediaKey, hduMediaKey } from '@/core/shared/mediaRef';
import { DB_VERSION } from '@/core/shared/constants';
import { localDayKey } from '@/core/shared/utils';
import type { BackupPayload } from '@/core/export/exporters';
import type { ExternalWatchEntity, VideoProgressEntity } from '@/core/shared/types';

beforeAll(async () => {
  await getDb();
});

/** schema 全集（与 db.test.ts 的表清单一致；新增 store 时两处同步更新） */
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
];

/** 规格要求的"必须备份"清单（用户学习资产） */
const REQUIRED_BACKUP = [
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
  'weeklyPlans',
];

describe('备份 store 覆盖矩阵', () => {
  it('BACKUP_STORES 包含全部必须备份清单成员', () => {
    for (const store of REQUIRED_BACKUP) {
      expect(BACKUP_STORES, `缺少必须备份的 store：${store}`).toContain(store);
    }
  });

  it('BACKUP_STORES 不含任何"不备份"清单成员', () => {
    for (const store of BACKUP_EXCLUDED_STORES) {
      expect(BACKUP_STORES, `瞬态 store 不应进入备份清单：${store}`).not.toContain(store);
    }
  });

  it('备份 + 排除两条清单互补覆盖 schema 全集（无遗漏、无重叠）', () => {
    const backup = new Set<string>(BACKUP_STORES);
    const excluded = new Set<string>(BACKUP_EXCLUDED_STORES);
    for (const store of SCHEMA_STORES) {
      const inBackup = backup.has(store);
      const inExcluded = excluded.has(store);
      expect(inBackup !== inExcluded, `store ${store} 必须恰好归入两条清单之一`).toBe(true);
    }
  });
});

describe('备份导出 → 清库 → 导入恢复（端到端）', () => {
  const NOW = Date.now();
  const FAV_ID = 'bk-fav-video-1';
  const BVID = 'BVBK000001';
  const metadata = {
    platform: 'bilibili',
    bvid: BVID,
    coverUrl: 'https://i0.hdslb.com/bk.jpg',
    uploader: '备份测试 UP 主',
    durationSec: 600,
    lastPositionSec: 120,
    url: `https://www.bilibili.com/video/${BVID}`,
  };
  const progress: VideoProgressEntity = {
    id: `bilibili:${BVID}`,
    platform: 'bilibili',
    videoId: BVID,
    title: '备份样例视频',
    durationSec: 600,
    lastPositionSec: 120,
    updatedAt: NOW,
  };

  it('导出包含新 store 段；清库导入后数据与 metadata 完整一致', async () => {
    await putFavorite({
      id: FAV_ID,
      type: 'video',
      refId: BVID,
      snapshot: { title: 'B 站备份样例', content: 'https://www.bilibili.com/video/BVBK000001' },
      folderId: null,
      tags: ['备份', '样例'],
      note: '端到端恢复校验备注',
      pinned: true,
      favoritedAt: NOW,
      metadata,
    });
    await putVideoProgress(progress);
    await addExternalWatch({ date: localDayKey(NOW), bvid: BVID, title: '备份样例视频', seconds: 120.4 });
    await putCurriculum([
      {
        courId: 882001,
        teclId: 99001,
        subjName: '备份样例课程',
        beginTime: NOW,
        endTime: NOW + 3600_000,
      },
    ]);
    await upsertWeeklyPlan({
      id: 'bk-weekly-1',
      label: '备份样例收藏夹',
      perDay: 3,
      bvids: [BVID],
      startDate: localDayKey(NOW),
      createdAt: NOW,
      updatedAt: NOW,
    });

    const exportResult = await exportBackup(false);
    const record = await (await getDb()).get('exportJobs', exportResult.jobId);
    expect(record?.data).toBeTypeOf('string');
    const payload = JSON.parse(record?.data as string) as BackupPayload;
    // 备份文件格式不升版本：应用标识与版本号保持兼容
    expect(payload.app).toBe(BACKUP_APP_ID);
    expect(payload.version).toBe(BACKUP_FORMAT_VERSION);
    // 新 store 段全部存在
    expect(payload.videoProgress).toHaveLength(1);
    expect(payload.externalWatch).toHaveLength(1);
    expect(payload.curriculum).toHaveLength(1);
    expect(payload.weeklyPlans).toHaveLength(1);
    const exportedFav = payload.favorites.find((row) => (row as { id?: string }).id === FAV_ID) as
      | (Record<string, unknown> & { metadata?: Record<string, unknown> })
      | undefined;
    expect(exportedFav).toBeTruthy();
    expect(exportedFav?.metadata).toEqual(metadata);

    // 清库（模拟换机恢复）
    const db = await getDb();
    await db.clear('favorites');
    await db.clear('videoProgress');
    await db.clear('externalWatch');
    await db.clear('curriculum');
    await db.clear('weeklyPlans');

    const importJobId = await stageImportJob('backup.json', record?.data as string);
    const result = await runImport(importJobId, 'merge');
    expect(result.imported.favorites).toBeGreaterThanOrEqual(1);
    expect(result.imported.videoProgress).toBe(1);
    expect(result.imported.externalWatch).toBe(1);
    expect(result.imported.curriculum).toBe(1);
    expect(result.imported.weeklyPlans).toBe(1);
    expect(result.skipped).toEqual({});

    // 收藏含 metadata 字段完整
    const restoredFav = await db.get('favorites', FAV_ID);
    expect(restoredFav).toBeTruthy();
    expect(restoredFav?.snapshot.title).toBe('B 站备份样例');
    expect(restoredFav?.tags).toEqual(['备份', '样例']);
    expect(restoredFav?.note).toBe('端到端恢复校验备注');
    expect(restoredFav?.pinned).toBe(true);
    expect(restoredFav?.metadata).toEqual(metadata);

    const restoredProgress = await db.get('videoProgress', `bilibili:${BVID}`);
    expect(restoredProgress).toEqual(progress);
    const restoredExternal = (await db.get('externalWatch', `${localDayKey(NOW)}:${BVID}`)) as
      | ExternalWatchEntity
      | undefined;
    expect(restoredExternal?.seconds).toBe(120);
    expect(restoredExternal?.bvid).toBe(BVID);
    const restoredCurriculum = await db.get('curriculum', 882001);
    expect(restoredCurriculum?.subjName).toBe('备份样例课程');

    const restoredPlan = await db.get('weeklyPlans', 'bk-weekly-1');
    expect(restoredPlan?.bvids).toEqual([BVID]);
    expect(restoredPlan?.perDay).toBe(3);
    expect(restoredPlan?.label).toBe('备份样例收藏夹');
    expect(restoredPlan?.startDate).toBe(localDayKey(NOW));
  });
});

describe('旧格式 / 未知段 / 坏条目兼容', () => {
  /** 旧版备份骨架：无 videoProgress / externalWatch / curriculum 段 */
  function legacyPayload(favorites: unknown[]): Record<string, unknown> {
    return {
      version: BACKUP_FORMAT_VERSION,
      dbVersion: DB_VERSION,
      exportedAt: new Date().toISOString(),
      app: BACKUP_APP_ID,
      includesScreenshots: false,
      courses: [],
      sessions: [],
      transcripts: [],
      aiResults: [],
      chats: [],
      favorites,
      folders: [],
      tags: [],
      notes: [],
      watchRecords: [],
      screenshotsMeta: [],
      reviewJobs: [],
    };
  }

  const legacyFav = {
    id: 'bk-legacy-fav',
    type: 'time',
    snapshot: { title: '旧格式收藏', content: '旧格式内容' },
    tags: [],
    pinned: false,
    favoritedAt: Date.now(),
  };

  it('旧格式备份（缺新 store 段）导入不报错，缺段视为空', async () => {
    const jobId = await stageImportJob('legacy.json', JSON.stringify(legacyPayload([legacyFav])));
    const result = await runImport(jobId, 'merge');
    expect(result.imported.favorites).toBe(1);
    expect(result.imported.videoProgress).toBe(0);
    expect(result.imported.externalWatch).toBe(0);
    expect(result.imported.curriculum).toBe(0);
    expect(result.imported.weeklyPlans).toBe(0);
    expect(result.skipped).toEqual({});
    expect(await (await getDb()).get('favorites', 'bk-legacy-fav')).toBeTruthy();
  });

  it('带未知段的备份导入不崩溃（未知段忽略）', async () => {
    const futuristic = {
      ...legacyPayload([legacyFav]),
      // 新版扩展才认识的段：当前版本导入时应整体忽略
      futureStores: [{ kind: 'mystery', rows: [1, 2, 3] }],
      anotherUnknown: 'whatever',
    };
    const jobId = await stageImportJob('future.json', JSON.stringify(futuristic));
    const result = await runImport(jobId, 'merge');
    expect(result.imported.favorites).toBe(1);
    expect(result.imported['futureStores']).toBeUndefined();
    expect(result.imported['anotherUnknown']).toBeUndefined();
  });

  it('新 store 段坏条目跳过并计数，好条目正常写入', async () => {
    const payload = {
      ...legacyPayload([]),
      videoProgress: [
        {
          id: 'bilibili:BVBKGOOD0001',
          platform: 'bilibili',
          videoId: 'BVBKGOOD0001',
          durationSec: 100,
          lastPositionSec: 40,
          updatedAt: Date.now(),
        },
        // 坏条目：缺 id
        { videoId: 'BVBKBAD00002', lastPositionSec: 10 },
        // 坏条目：lastPositionSec 非数值
        { id: 'bilibili:BVBKBAD0003', videoId: 'BVBKBAD0003', lastPositionSec: 'NaN' },
      ],
      externalWatch: [
        { id: `${localDayKey()}:BVBKGOOD0001`, date: localDayKey(), bvid: 'BVBKGOOD0001', seconds: 30 },
        // 坏条目：seconds 非数值
        { id: `${localDayKey()}:BVBKBAD0002`, date: localDayKey(), bvid: 'BVBKBAD0002', seconds: '60' },
      ],
      curriculum: [
        { courId: 882101, teclId: 99011, subjName: '好课次', beginTime: Date.now(), endTime: Date.now() + 600_000 },
        // 坏条目：缺 subjName
        { courId: 882102, teclId: 99011, beginTime: Date.now(), endTime: Date.now() + 600_000 },
      ],
      weeklyPlans: [
        { id: 'bk-weekly-good', perDay: 2, bvids: ['BVBKGOOD0001'], startDate: localDayKey(), createdAt: 1, updatedAt: 1 },
        // 坏条目：缺 id
        { perDay: 2, bvids: ['BVX'], startDate: localDayKey() },
        // 坏条目：bvids 不是数组
        { id: 'bk-weekly-bad-bvids', perDay: 2, bvids: 'BVX', startDate: localDayKey() },
        // 未知字段（如将来新增的 note）：原样写回，不拒绝
        { id: 'bk-weekly-extra', perDay: 1, bvids: [], startDate: localDayKey(), futureNote: 'whatever' },
      ],
    };
    const jobId = await stageImportJob('lenient.json', JSON.stringify(payload));
    const result = await runImport(jobId, 'merge');
    expect(result.imported.videoProgress).toBe(1);
    expect(result.imported.externalWatch).toBe(1);
    expect(result.imported.curriculum).toBe(1);
    expect(result.imported.weeklyPlans).toBe(2);
    expect(result.skipped.videoProgress).toBe(2);
    expect(result.skipped.externalWatch).toBe(1);
    expect(result.skipped.curriculum).toBe(1);
    expect(result.skipped.weeklyPlans).toBe(2);
    const db = await getDb();
    expect(await db.get('videoProgress', 'bilibili:BVBKGOOD0001')).toBeTruthy();
    expect(await db.get('curriculum', 882101)).toBeTruthy();
    const restoredWeekly = (await db.get('weeklyPlans', 'bk-weekly-extra')) as unknown as
      | Record<string, unknown>
      | undefined;
    expect(restoredWeekly?.futureNote).toBe('whatever');
  });
});

describe('转写链路备份双向兼容（courId / mediaKey 双形态）', () => {
  /** 旧版（DB v4）导出的转写链路记录：只有 courId，无 mediaKey */
  const legacyTranscript = {
    courId: 4101,
    segments: [{ s: 0, e: 5, text: '旧版备份的转写' }],
    model: 'fast',
    lang: 'zh',
    glossaryVersion: 1,
    createdAt: Date.now(),
    source: 'local-asr',
  };
  const legacyAi = {
    courId: 4101,
    promptVersion: 1,
    model: 'test-model',
    topics: [],
    outline: [],
    createdAt: Date.now(),
  };
  const legacyChat = {
    id: 'bk-legacy-chat',
    courId: 4101,
    groupId: 'bk-g1',
    role: 'user',
    content: '旧版备份的提问',
    status: 'done',
    createdAt: Date.now(),
  };
  /** 新版（DB v5）导出的记录：mediaKey + courId 并存 */
  const newTranscript = {
    mediaKey: hduMediaKey(4102),
    courId: 4102,
    segments: [{ s: 0, e: 3, text: '新版备份的转写' }],
    model: 'fast',
    lang: 'zh',
    glossaryVersion: 1,
    createdAt: Date.now(),
    source: 'local-asr',
  };

  function payloadWith(rows: Record<string, unknown>): string {
    return JSON.stringify({
      version: BACKUP_FORMAT_VERSION,
      dbVersion: DB_VERSION,
      exportedAt: new Date().toISOString(),
      app: BACKUP_APP_ID,
      includesScreenshots: false,
      courses: [],
      sessions: [],
      transcripts: [rows.transcript],
      aiResults: [rows.ai].filter(Boolean),
      chats: [rows.chat].filter(Boolean),
      favorites: [],
      folders: [],
      tags: [],
      notes: [],
      watchRecords: [],
      screenshotsMeta: [],
      reviewJobs: [],
    });
  }

  it('旧版备份（无 mediaKey）导入：自动补 hdu:<courId>，courId 字段保留，新主键可读', async () => {
    const jobId = await stageImportJob(
      'legacy-transcript.json',
      payloadWith({ transcript: legacyTranscript, ai: legacyAi, chat: legacyChat }),
    );
    const result = await runImport(jobId, 'merge');
    expect(result.imported.transcripts).toBe(1);
    expect(result.imported.aiResults).toBe(1);
    expect(result.imported.chats).toBe(1);

    const transcript = await getTranscript(hduMediaKey(4101));
    expect(transcript).toBeTruthy();
    expect(transcript?.courId).toBe(4101); // 双向兼容：courId 字段保留
    expect(transcript?.segments.at(0)?.text).toBe('旧版备份的转写');
    const db = await getDb();
    const chat = (await db.get('chats', 'bk-legacy-chat')) as { mediaKey?: string; courId?: number } | undefined;
    expect(chat?.mediaKey).toBe(hduMediaKey(4101));
    expect(chat?.courId).toBe(4101);
  });

  it('新版备份（含 mediaKey）导入：mediaKey 原样保留不被改写', async () => {
    const jobId = await stageImportJob('new-transcript.json', payloadWith({ transcript: newTranscript }));
    const result = await runImport(jobId, 'merge');
    expect(result.imported.transcripts).toBe(1);
    const transcript = await getTranscript(hduMediaKey(4102));
    expect(transcript).toBeTruthy();
    expect(transcript?.mediaKey).toBe(hduMediaKey(4102));
    expect(transcript?.courId).toBe(4102);
    expect(transcript?.segments.at(0)?.text).toBe('新版备份的转写');
  });

  it('新版导出的转写链路记录同时携带 mediaKey 与 courId（旧版扩展可按 courId 导入）', async () => {
    const exportResult = await exportBackup(false);
    const record = await (await getDb()).get('exportJobs', exportResult.jobId);
    const payload = JSON.parse(record?.data as string) as BackupPayload;
    const exported = payload.transcripts.filter(
      (row) => (row as { courId?: unknown }).courId === 4101 || (row as { courId?: unknown }).courId === 4102,
    );
    expect(exported.length).toBe(2);
    for (const row of exported as Array<{ mediaKey?: string; courId?: number }>) {
      // 记录体保留 courId（旧版本扩展导入新版备份的兼容依据）
      expect(typeof row.courId).toBe('number');
      expect(row.mediaKey).toBe(hduMediaKey(row.courId as number));
    }
  });

  it('B 站分 P 键（bili:<bvid>:p<N>）导入→读回→再导出无损（第 16 轮多 P 键进备份链路）', async () => {
    const biliP2 = {
      mediaKey: biliMediaKey('BV1bkTest001', 2),
      segments: [{ s: 12, e: 16, text: '分 P 字幕' }],
      model: 'bili-official-subtitle',
      lang: 'zh-CN',
      glossaryVersion: 0,
      createdAt: Date.now(),
      source: 'bili-official-subtitle',
      aiSubtitle: false,
    };
    const jobId = await stageImportJob('bili-p2-transcript.json', payloadWith({ transcript: biliP2 }));
    const result = await runImport(jobId, 'merge');
    expect(result.imported.transcripts).toBe(1);

    // 读回：分 P 键精确可读；B 站记录无课次（courId 缺省）
    const transcript = await getTranscript(biliMediaKey('BV1bkTest001', 2));
    expect(transcript?.mediaKey).toBe('bili:BV1bkTest001:p2');
    expect(transcript?.courId).toBeUndefined();
    expect(transcript?.segments.at(0)?.text).toBe('分 P 字幕');

    // 再导出：键原样进备份 JSON（导出/导入对 mediaKey 不做任何键形改写）
    const exportResult = await exportBackup(false);
    const record = await (await getDb()).get('exportJobs', exportResult.jobId);
    const payload = JSON.parse(record?.data as string) as BackupPayload;
    const exported = payload.transcripts.find((row) => (row as { mediaKey?: string }).mediaKey === 'bili:BV1bkTest001:p2');
    expect(exported).toBeTruthy();
  });
});

describe('笔记双形态导入（第 26 轮 B 站笔记）', () => {
  /** 站内笔记（旧形态）：courId+teclId 归属 */
  const hduNote = {
    id: 'bk-note-hdu',
    courId: 4101,
    teclId: 99001,
    anchorTime: 12,
    text: '站内时间点笔记',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  /** B 站笔记（新形态）：仅 mediaKey 归属，无 courId */
  const biliNote = {
    id: 'bk-note-bili',
    mediaKey: biliMediaKey('BV1noteTest1'),
    anchorTime: 30,
    text: 'B站时间点笔记',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  function notesPayload(notes: unknown[]): string {
    return JSON.stringify({
      version: BACKUP_FORMAT_VERSION,
      dbVersion: DB_VERSION,
      exportedAt: new Date().toISOString(),
      app: BACKUP_APP_ID,
      includesScreenshots: false,
      courses: [],
      sessions: [],
      transcripts: [],
      aiResults: [],
      chats: [],
      favorites: [],
      folders: [],
      tags: [],
      notes,
      watchRecords: [],
      screenshotsMeta: [],
      reviewJobs: [],
    });
  }

  it('含 B 站笔记（mediaKey 形态）的备份导入成功，与站内笔记并存', async () => {
    const jobId = await stageImportJob('notes-mixed.json', notesPayload([hduNote, biliNote]));
    const result = await runImport(jobId, 'merge');
    expect(result.imported.notes).toBe(2);
    const db = await getDb();
    const restoredBili = (await db.get('notes', 'bk-note-bili')) as { mediaKey?: string; courId?: number } | undefined;
    expect(restoredBili?.mediaKey).toBe('bili:BV1noteTest1');
    expect(restoredBili?.courId).toBeUndefined();
    expect((await db.get('notes', 'bk-note-hdu'))).toBeTruthy();
  });

  it('笔记行既无 courId 也无 mediaKey → 备份整体被拒（结构损坏）', async () => {
    const orphan = { id: 'bk-note-orphan', anchorTime: 1, text: '无归属笔记', createdAt: Date.now(), updatedAt: Date.now() };
    const jobId = await stageImportJob('notes-orphan.json', notesPayload([orphan]));
    await expect(runImport(jobId, 'merge')).rejects.toThrow(/courId\/mediaKey/);
  });
});
