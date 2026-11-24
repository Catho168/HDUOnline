/** 站外视频学习时长：externalWatch 仓储的 upsert 累加 + 报表聚合纯函数。 */

import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/core/db';
import {
  addExternalWatch,
  externalWatchId,
  getExternalByDateRange,
  getExternalWatchByDate,
} from '@/core/db/repo/external';
import { buildReport, externalSecondsByDay, sumExternalSeconds } from '@/core/stats/aggregate';
import { DB_VERSION } from '@/core/shared/constants';
import { localDayKey } from '@/core/shared/utils';
import type { ExternalWatchEntity } from '@/core/shared/types';

beforeAll(async () => {
  await getDb();
});

const DAY = '2026-11-14';
const OTHER_DAY = '2026-11-13';

function record(partial: Partial<ExternalWatchEntity>): ExternalWatchEntity {
  return {
    id: `${partial.date ?? DAY}:${partial.bvid ?? 'BV1'}`,
    date: partial.date ?? DAY,
    bvid: partial.bvid ?? 'BV1',
    seconds: 30,
    ...partial,
  } as ExternalWatchEntity;
}

describe('addExternalWatch（upsert 累加）', () => {
  it('首写：新日期新视频生成一条累计记录', async () => {
    const first = await addExternalWatch({ date: DAY, bvid: 'BV1xx001', title: '高数第 1 讲', seconds: 30 });
    expect(first).not.toBeNull();
    expect(first?.id).toBe(externalWatchId(DAY, 'BV1xx001'));
    expect(first?.seconds).toBe(30);
    expect(first?.title).toBe('高数第 1 讲');
    const byDate = await getExternalWatchByDate(DAY);
    expect(byDate).toHaveLength(1);
  });

  it('重复累加：同日同视频 seconds 累加，不产生第二条记录', async () => {
    await addExternalWatch({ date: DAY, bvid: 'BV1xx002', seconds: 30 });
    const second = await addExternalWatch({ date: DAY, bvid: 'BV1xx002', seconds: 45 });
    expect(second?.seconds).toBe(75);
    const byDate = await getExternalWatchByDate(DAY);
    expect(byDate.filter((r) => r.bvid === 'BV1xx002')).toHaveLength(1);
  });

  it('seconds 无效（非有限 / 0 / 负数）忽略：返回 null 且不清零已有累计', async () => {
    await addExternalWatch({ date: DAY, bvid: 'BV1xx003', seconds: 60 });
    for (const bad of [Number.NaN, Infinity, -Infinity, 0, -10]) {
      expect(await addExternalWatch({ date: DAY, bvid: 'BV1xx003', seconds: bad })).toBeNull();
    }
    expect((await getExternalWatchByDate(DAY)).find((r) => r.bvid === 'BV1xx003')?.seconds).toBe(60);
  });

  it('bvid / date 缺失同样忽略', async () => {
    expect(await addExternalWatch({ date: '', bvid: 'BV1', seconds: 30 })).toBeNull();
    expect(await addExternalWatch({ date: DAY, bvid: '', seconds: 30 })).toBeNull();
  });

  it('title 补充不覆盖已有值：先有标题保持，缺失时再补', async () => {
    await addExternalWatch({ date: DAY, bvid: 'BV1xx004', title: '原标题', seconds: 30 });
    // 新上报不带 title：旧值保留
    await addExternalWatch({ date: DAY, bvid: 'BV1xx004', seconds: 30 });
    expect((await getExternalWatchByDate(DAY)).find((r) => r.bvid === 'BV1xx004')?.title).toBe('原标题');
    // 新上报带新 title：同样不覆盖（补充语义，旧值优先）
    await addExternalWatch({ date: DAY, bvid: 'BV1xx004', title: '新标题', seconds: 30 });
    expect((await getExternalWatchByDate(DAY)).find((r) => r.bvid === 'BV1xx004')?.title).toBe('原标题');

    // 先无标题：后续上报带 title 时补充
    await addExternalWatch({ date: DAY, bvid: 'BV1xx005', seconds: 30 });
    await addExternalWatch({ date: DAY, bvid: 'BV1xx005', title: '后来补的标题', seconds: 30 });
    expect((await getExternalWatchByDate(DAY)).find((r) => r.bvid === 'BV1xx005')?.title).toBe('后来补的标题');
  });

  it('区间读取：getExternalByDateRange 含端点', async () => {
    // 用独立的日期对，避免与本文件其他用例写入的 DAY 记录互相干扰
    const from = '2026-11-20';
    const to = '2026-11-21';
    await addExternalWatch({ date: from, bvid: 'BV1xx006', seconds: 20 });
    await addExternalWatch({ date: to, bvid: 'BV1xx007', seconds: 40 });
    await addExternalWatch({ date: '2026-11-22', bvid: 'BV1xx008', seconds: 10 });
    const range = await getExternalByDateRange(from, to);
    expect(range.map((r) => r.id).sort()).toEqual(
      [externalWatchId(from, 'BV1xx006'), externalWatchId(to, 'BV1xx007')].sort(),
    );
  });
});

describe('站外时长聚合纯函数', () => {
  it('externalSecondsByDay：同日多条合并', () => {
    const map = externalSecondsByDay([
      record({ date: DAY, bvid: 'BV1', seconds: 60 }),
      record({ date: DAY, bvid: 'BV2', seconds: 30 }),
      record({ date: OTHER_DAY, bvid: 'BV1', seconds: 10 }),
    ]);
    expect(map.get(DAY)).toBe(90);
    expect(map.get(OTHER_DAY)).toBe(10);
    expect(map.size).toBe(2);
  });

  it('sumExternalSeconds：空数据为 0', () => {
    expect(sumExternalSeconds([])).toBe(0);
    expect(externalSecondsByDay([]).size).toBe(0);
  });

  it('脏数据防御：非对象、缺字段、seconds 非有限正数逐条跳过', () => {
    const dirty = [
      null,
      undefined,
      'string',
      42,
      {},
      { date: DAY, bvid: 'BV1', seconds: Number.NaN },
      { date: DAY, bvid: 'BV1', seconds: -5 },
      { date: DAY, bvid: 'BV1', seconds: 0 },
      { date: '', bvid: 'BV1', seconds: 30 },
      { date: DAY, seconds: 30 },
      { date: DAY, bvid: 'BV1', seconds: '30' },
    ] as unknown as ExternalWatchEntity[];
    expect(sumExternalSeconds(dirty)).toBe(0);
    expect(externalSecondsByDay(dirty).size).toBe(0);
    // 非数组输入同样返回空
    expect(sumExternalSeconds(undefined as unknown as ExternalWatchEntity[])).toBe(0);
  });

  it('buildReport：externalSeconds 进日报表且独立于站内口径', () => {
    const now = new Date('2026-11-14T21:00:00').getTime();
    const records = [
      record({ date: localDayKey(now), bvid: 'BV1', seconds: 600 }),
      record({ date: localDayKey(now), bvid: 'BV2', seconds: 300 }),
      record({ date: '2026-10-01', bvid: 'BV3', seconds: 1200 }),
    ];
    const report = buildReport({
      records: [],
      sessions: [],
      courses: [],
      externalRecords: records,
      windowDays: 7,
      weeklyTargetSec: 5 * 3600,
      checkinMinSec: 600,
      now,
    });
    // 窗口内（近 7 天）只含 11-14 一条：合计 900；10-01 在窗口外不计
    expect(report.externalSeconds).toBe(900);
    const today = report.days.find((d) => d.date === localDayKey(now));
    expect(today?.externalSeconds).toBe(900);
    // 站外不并入站内累计
    expect(report.totalSec).toBe(0);
    expect(report.todaySec).toBe(0);
    expect(report.days.every((d) => d.totalSec === 0 && d.validSec === 0)).toBe(true);
  });

  it('buildReport：无站外输入时 externalSeconds 为 0（可选字段兼容旧调用方）', () => {
    const now = new Date('2026-11-14T21:00:00').getTime();
    const report = buildReport({
      records: [],
      sessions: [],
      courses: [],
      windowDays: 3,
      weeklyTargetSec: 5 * 3600,
      checkinMinSec: 600,
      now,
    });
    expect(report.externalSeconds).toBe(0);
    expect(report.days.every((d) => d.externalSeconds === 0)).toBe(true);
  });

  // 第 252 轮徽章口径核对：external-10「双线学习」徽章此前喂报表展示窗口内合计
  // （externalSeconds），而站内累计徽章喂 totalSec（流水取数窗口累计）——同一
  // 「累计」语义两个窗口。修齐：buildReport 新增 externalTotalSec（全部入参流水
  // 累计，与 totalSec 同窗），徽章消费方切换到该字段；本用例锁定两字段窗口差。
  it('buildReport：externalTotalSec 为流水累计口径（窗口外也计），externalSeconds 保持展示窗口口径', () => {
    const now = new Date('2026-11-14T21:00:00').getTime();
    const records = [
      record({ date: localDayKey(now), bvid: 'BV1', seconds: 600 }),
      record({ date: '2026-10-01', bvid: 'BV3', seconds: 1200 }),
      // 脏行照旧防御跳过，不进累计
      record({ date: localDayKey(now), bvid: 'BV4', seconds: Number.NaN }),
    ];
    const report = buildReport({
      records: [],
      sessions: [],
      courses: [],
      externalRecords: records,
      windowDays: 7,
      weeklyTargetSec: 5 * 3600,
      checkinMinSec: 600,
      now,
    });
    // 展示窗口（近 7 天）：只有 11-14 一条
    expect(report.externalSeconds).toBe(600);
    // 累计口径（与 totalSec 同窗）：600 + 1200，窗口外的 10-01 也计
    expect(report.externalTotalSec).toBe(1800);
  });
});

describe('externalWatch store（DB v3）', () => {
  it('数据库以 v3 打开且含 externalWatch 表与 date 索引', async () => {
    const db = await getDb();
    expect(db.version).toBe(DB_VERSION);
    expect([...db.objectStoreNames]).toContain('externalWatch');
    const store = db.transaction('externalWatch').store;
    expect(Array.from(store.indexNames)).toContain('date');
  });
});
