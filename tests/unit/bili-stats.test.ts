/**
 * B 站视频学习统计聚合测试（第 25 轮任务 B）。
 *
 * fake-indexeddb 全链路：repo 三函数（biliTopWatched / biliRecentWatched /
 * biliStreakDays）+ op handler（stats.bili.overview，经 dispatchOp）。
 *
 * 隔离约定：
 *  - 各 describe 用独立 bvid 前缀（BVT / BVR / BVO / BVS），断言前按前缀过滤，
 *    避免同库累计数据互相干扰；
 *  - biliTopWatched 用固定历史区间（2026-01-05 周一 ~ 2026-01-11 周日），与
 *    「今天」无关；streak / op 用相对 NOW 的日键（与 stats-period-op 同套路）；
 *  - biliStreakDays 扫全库日期集合，放最后一个 describe，并在每个用例前
 *    clearExternalWatch 保证从零开始。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/core/db';
import { addExternalWatch, clearExternalWatch } from '@/core/db/repo/external';
import { putVideoProgress } from '@/core/db/repo/video';
import { putFavorite } from '@/core/db/repo/library';
import { biliRecentWatched, biliStreakDays, biliTopWatched } from '@/core/db/repo/bili';
import { dispatchOp } from '@/entrypoints/background/ops';
import { dayKeyToTs, localDayKey, startOfLocalWeek } from '@/core/shared/utils';
import type { BiliRecentWatchedRow, BiliTopWatchedRow } from '@/core/shared/types';

const NOW = Date.now();
const DAY_MS = 86_400_000;

/** 相对 NOW 往前数 k 个自然日的日键 */
function daysAgoKey(k: number): string {
  return localDayKey(NOW - k * DAY_MS);
}

async function seedWatch(date: string, bvid: string, seconds: number, title?: string): Promise<void> {
  const result = await addExternalWatch({ date, bvid, seconds, ...(title ? { title } : {}) });
  if (!result) throw new Error(`seedWatch 失败：${date} ${bvid}`);
}

function progressEntity(bvid: string, opts: { lastPositionSec?: number; durationSec?: number | null; title?: string }) {
  return {
    id: `bilibili:${bvid}`,
    platform: 'bilibili' as const,
    videoId: bvid,
    ...(opts.title ? { title: opts.title } : {}),
    durationSec: opts.durationSec ?? null,
    lastPositionSec: opts.lastPositionSec ?? 0,
    updatedAt: NOW,
  };
}

function favoriteEntity(id: string, bvid: string, title: string, metadata?: Record<string, unknown>) {
  return {
    id,
    type: 'video' as const,
    refId: bvid,
    snapshot: { title, content: '' },
    tags: [] as string[],
    pinned: false,
    favoritedAt: NOW,
    ...(metadata ? { metadata } : {}),
  };
}

function filterTop(rows: BiliTopWatchedRow[], prefix: string): BiliTopWatchedRow[] {
  return rows.filter((row) => row.bvid.startsWith(prefix));
}

function filterRecent(rows: BiliRecentWatchedRow[], prefix: string): BiliRecentWatchedRow[] {
  return rows.filter((row) => row.bvid.startsWith(prefix));
}

beforeAll(async () => {
  await getDb();
});

// ───────────────────────── biliTopWatched ─────────────────────────

describe('biliTopWatched（区间 × bvid 聚合 TopN）', () => {
  beforeAll(async () => {
    // 固定历史周：2026-01-05（周一）~ 2026-01-11（周日）
    await seedWatch('2026-01-05', 'BVT1', 100, '上报标题一');
    await seedWatch('2026-01-07', 'BVT1', 50); // 跨日同视频累加 → 150
    await seedWatch('2026-01-06', 'BVT2', 150, '上报标题二'); // 与 BVT1 并列 150
    await seedWatch('2026-01-08', 'BVT3', 200, '上报标题三'); // 三重标题源，progress 优先
    await seedWatch('2026-01-10', 'BVT4', 10); // 无任何标题源 → 占位
    await seedWatch('2026-01-11', 'BVT5', 40);
    await seedWatch('2026-01-12', 'BVT6', 999); // 区间右端点之后 → 排除
    await seedWatch('2025-12-31', 'BVT7', 999); // 区间左端点之前 → 排除

    await putVideoProgress(progressEntity('BVT3', { lastPositionSec: 30, title: '进度标题' }));
    await putFavorite(favoriteEntity('fav-bvt2', 'BVT2', '收藏标题'));
    await putFavorite(favoriteEntity('fav-bvt3', 'BVT3', '收藏标题三'));
  });

  it('典型：区间内按 bvid 聚合降序，Top5 含占比；区间外记录排除', async () => {
    const rows = filterTop(
      await biliTopWatched({ fromDay: '2026-01-05', toDay: '2026-01-11' }),
      'BVT',
    );
    expect(rows.map((r) => r.bvid)).toEqual(['BVT3', 'BVT1', 'BVT2', 'BVT5', 'BVT4']);
    expect(rows.map((r) => r.totalSec)).toEqual([200, 150, 150, 40, 10]);
    // 区间总秒数 = 100+50+150+200+10+40 = 550
    expect(rows[0]?.share).toBeCloseTo(200 / 550, 5);
    expect(rows[1]?.share).toBeCloseTo(150 / 550, 5);
  });

  it('边界：跨日同视频合并为一条；并列时长按 bvid 字典序稳定输出', async () => {
    const rows = filterTop(
      await biliTopWatched({ fromDay: '2026-01-05', toDay: '2026-01-11' }),
      'BVT',
    );
    const bvt1 = rows.find((r) => r.bvid === 'BVT1');
    expect(bvt1?.totalSec).toBe(150); // 100 + 50
    // BVT1 与 BVT2 并列 150：BVT1 在前（字典序）
    expect(rows.findIndex((r) => r.bvid === 'BVT1')).toBeLessThan(rows.findIndex((r) => r.bvid === 'BVT2'));
  });

  it('标题降级：videoProgress > 收藏 > 上报标题 > 「B 站视频 <bvid>」', async () => {
    const rows = filterTop(
      await biliTopWatched({ fromDay: '2026-01-05', toDay: '2026-01-11' }),
      'BVT',
    );
    const byBvid = new Map(rows.map((r) => [r.bvid, r] as const));
    expect(byBvid.get('BVT3')?.title).toBe('进度标题'); // progress > 收藏 > 上报
    expect(byBvid.get('BVT2')?.title).toBe('收藏标题'); // 收藏 > 上报
    expect(byBvid.get('BVT1')?.title).toBe('上报标题一'); // 仅上报标题
    expect(byBvid.get('BVT4')?.title).toBe('B 站视频 BVT4'); // 全缺 → 占位
  });

  it('边界：limit 生效（N=2 只取前二）', async () => {
    const rows = filterTop(
      await biliTopWatched({ fromDay: '2026-01-05', toDay: '2026-01-11' }, 2),
      'BVT',
    );
    expect(rows.map((r) => r.bvid)).toEqual(['BVT3', 'BVT1']);
  });

  it('边界：区间无记录返回空数组', async () => {
    const rows = await biliTopWatched({ fromDay: '2030-01-01', toDay: '2030-01-07' });
    expect(rows).toEqual([]);
  });
});

// ───────────────────────── biliRecentWatched ─────────────────────────

describe('biliRecentWatched（最近观看，全历史口径）', () => {
  beforeAll(async () => {
    await seedWatch('2026-02-01', 'BVR1', 100);
    await seedWatch('2026-02-05', 'BVR1', 200); // 最近日 02-05，累计 300
    await seedWatch('2026-02-03', 'BVR2', 500); // 无 progress → 位置 0 / 时长 null
    await seedWatch('2026-02-04', 'BVR3', 10, '上报标题三'); // 收藏标题优先于上报标题
    await seedWatch('2026-02-02', 'BVR4', 10); // progress 位置 0 / 无时长

    await putVideoProgress(progressEntity('BVR1', { lastPositionSec: 75, durationSec: 300, title: '最近标题一' }));
    await putVideoProgress(progressEntity('BVR4', { lastPositionSec: 0, durationSec: null }));
    await putFavorite(favoriteEntity('fav-bvr3', 'BVR3', '收藏标题三', { url: 'https://www.bilibili.com/video/BVR3?p=3' }));
  });

  it('典型：按最后观看日降序；累计秒 / 最后位置 / 时长来自 videoProgress', async () => {
    const rows = filterRecent(await biliRecentWatched(), 'BVR');
    expect(rows.map((r) => r.bvid)).toEqual(['BVR1', 'BVR3', 'BVR2', 'BVR4']);

    const bvr1 = rows[0] as BiliRecentWatchedRow;
    expect(bvr1.totalSec).toBe(300);
    expect(bvr1.lastDay).toBe('2026-02-05');
    expect(bvr1.lastWatchedAt).toBe(dayKeyToTs('2026-02-05'));
    expect(bvr1.lastPositionSec).toBe(75);
    expect(bvr1.durationSec).toBe(300);
    expect(bvr1.title).toBe('最近标题一');

    const bvr2 = rows.find((r) => r.bvid === 'BVR2') as BiliRecentWatchedRow;
    expect(bvr2.lastPositionSec).toBe(0); // progress 缺失 → 0
    expect(bvr2.durationSec).toBeNull();
    expect(bvr2.title).toBe('B 站视频 BVR2'); // 无任何标题源 → 占位
    expect(bvr2.url).toBe('https://www.bilibili.com/video/BVR2'); // 无收藏 → bvid 还原官方链接
  });

  it('标题 / 链接：收藏标题优先于上报标题；多 P 收藏 url 保留 ?p=', async () => {
    const rows = filterRecent(await biliRecentWatched(), 'BVR');
    const bvr3 = rows.find((r) => r.bvid === 'BVR3') as BiliRecentWatchedRow;
    expect(bvr3.title).toBe('收藏标题三');
    expect(bvr3.url).toBe('https://www.bilibili.com/video/BVR3?p=3');
  });

  it('边界：progress 位置为 0 / 无时长时不误报', async () => {
    const rows = filterRecent(await biliRecentWatched(), 'BVR');
    const bvr4 = rows.find((r) => r.bvid === 'BVR4') as BiliRecentWatchedRow;
    expect(bvr4.lastPositionSec).toBe(0);
    expect(bvr4.durationSec).toBeNull();
  });

  it('边界：limit 生效（取最近 2 条）', async () => {
    const rows = filterRecent(await biliRecentWatched(2), 'BVR');
    expect(rows.map((r) => r.bvid)).toEqual(['BVR1', 'BVR3']);
  });
});

// ───────────────────────── stats.bili.overview op ─────────────────────────

describe('stats.bili.overview op（合法入参 → 聚合结果）', () => {
  beforeAll(async () => {
    // 今天必落在当前周与当前月窗口内（其余测试的固定历史日期均在窗口外）
    await seedWatch(localDayKey(NOW), 'BVO1', 120);
    await seedWatch(localDayKey(NOW), 'BVO2', 60);
    await putVideoProgress(progressEntity('BVO1', { lastPositionSec: 42, durationSec: 600, title: '总览标题' }));
  });

  it('周口径：range 边界与 stats.period 一致，top/recent/streak 齐备', async () => {
    const result = await dispatchOp('stats.bili.overview', { kind: 'week' });
    const ws = new Date(startOfLocalWeek(NOW));
    const we = new Date(ws);
    we.setDate(we.getDate() + 6);
    expect(result.range).toEqual({
      kind: 'week',
      startDay: localDayKey(ws),
      endDay: localDayKey(we),
    });
    const top = filterTop(result.top, 'BVO');
    expect(top.map((r) => r.bvid)).toEqual(['BVO1', 'BVO2']);
    expect(top[0]?.totalSec).toBe(120);
    expect(top[0]?.title).toBe('总览标题');
    // 当前周窗口内只有 BVO 两条 → 占比 120/180、60/180
    expect(top[0]?.share).toBeCloseTo(120 / 180, 5);
    expect(top[1]?.share).toBeCloseTo(60 / 180, 5);
    // 最近观看：今天 > 一切历史固定日期；同日按累计秒降序 → BVO1 在前
    expect(result.recent[0]?.bvid).toBe('BVO1');
    expect(result.recent[0]?.lastPositionSec).toBe(42);
    expect(result.streakDays).toBeGreaterThanOrEqual(1);
  });

  it('月口径：range 为当前自然月；TopN 随 kind 重算', async () => {
    const result = await dispatchOp('stats.bili.overview', { kind: 'month' });
    const now = new Date(NOW);
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    expect(result.range).toEqual({
      kind: 'month',
      startDay: localDayKey(first),
      endDay: localDayKey(last),
    });
    expect(filterTop(result.top, 'BVO').map((r) => r.bvid)).toEqual(['BVO1', 'BVO2']);
  });

  it('limit 透传：limit=1 时 TopN 只含 1 条', async () => {
    const result = await dispatchOp('stats.bili.overview', { kind: 'week', limit: 1 });
    expect(filterTop(result.top, 'BVO')).toHaveLength(1);
    expect(result.top).toHaveLength(1); // 当前周窗口内本就只有 BVO 数据
  });
});

// ───────────────────────── biliStreakDays ─────────────────────────

describe('biliStreakDays（连续学习天数，放最后：每例前清库）', () => {
  it('空库：0 天', async () => {
    await clearExternalWatch();
    expect(await biliStreakDays(NOW)).toBe(0);
  });

  it('单日（今天有记录）：1 天', async () => {
    await clearExternalWatch();
    await seedWatch(daysAgoKey(0), 'BVS1', 60);
    expect(await biliStreakDays(NOW)).toBe(1);
  });

  it('今天还没学不立即断链：从昨天往回数「昨天及以前连续」', async () => {
    await clearExternalWatch();
    await seedWatch(daysAgoKey(1), 'BVS1', 60); // 昨天
    await seedWatch(daysAgoKey(2), 'BVS1', 60); // 前天
    expect(await biliStreakDays(NOW)).toBe(2);
  });

  it('连续多日（含今天）：逐日累加', async () => {
    await clearExternalWatch();
    await seedWatch(daysAgoKey(0), 'BVS1', 60);
    await seedWatch(daysAgoKey(1), 'BVS1', 60);
    await seedWatch(daysAgoKey(2), 'BVS1', 60);
    expect(await biliStreakDays(NOW)).toBe(3);
  });

  it('中间断一天：只数到断点为止', async () => {
    await clearExternalWatch();
    await seedWatch(daysAgoKey(0), 'BVS1', 60);
    await seedWatch(daysAgoKey(1), 'BVS1', 60);
    // daysAgoKey(2) 缺失 → 断链
    await seedWatch(daysAgoKey(3), 'BVS1', 60);
    expect(await biliStreakDays(NOW)).toBe(2);
  });
});

// ───────────────────────── 空库收尾 ─────────────────────────

describe('空库边界（清库后三函数均返回空/零）', () => {
  it('clearExternalWatch 后：top=[]、recent=[]、streak=0', async () => {
    await clearExternalWatch();
    expect(await biliTopWatched({ fromDay: '2026-01-05', toDay: '2026-01-11' })).toEqual([]);
    expect(await biliRecentWatched()).toEqual([]);
    expect(await biliStreakDays(NOW)).toBe(0);
  });
});
