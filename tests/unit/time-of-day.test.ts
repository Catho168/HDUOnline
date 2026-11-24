/**
 * 学习时段分布 buildTimeOfDayDistribution（core/stats/timeOfDay.ts，第 238 轮巡检）
 * 单测。
 *
 * 覆盖：
 *  1. 六桶边界（5 / 8 / 12 / 14 / 18 / 23 点与 23:59）与桶序（清晨→深夜固定序）；
 *  2. 跨零点深夜归桶：0–4 点与 23 点同归「深夜」（按开始时刻归桶）；
 *  3. 只计 valid 口径：valid=false 的流水整条跳过（sec 与 count 同源不计）；
 *  4. 近 N 天窗口过滤（默认 30 天含今天；days 参数覆盖 / 非法回退 / clamp）；
 *  5. count 与 sec 独立正确（多条累计）；
 *  6. 空数据 / 全 invalid / now 非有限 → null（UI 空态）；
 *  7. 脏行防御：非对象 / 非法日键 / startTs 非有限 / durationSec 非正数逐条跳过。
 *
 * 时区无关：startTs 一律用 new Date(y, m, d, h, min) 本地时间构造，getHours() 与
 * 构造时的小时恒一致（分桶断言不依赖测试机的时区设置）。
 */
import { describe, expect, it } from 'vitest';

import { buildTimeOfDayDistribution, timeOfDayHourLabel, TIME_OF_DAY_DEFAULT_DAYS } from '@/core/stats/timeOfDay';
import { localDayKey } from '@/core/shared/utils';
import type { WatchRecordEntity } from '@/core/shared/types';

/** 「今天」：本地 2026-11-21 12:00（窗口断言不依赖时区） */
const NOW = new Date(2026, 10, 21, 12, 0).getTime();

/** 本地时刻 → 时间戳（month 为 0 起索引：10 = 11 月） */
const ts = (monthDay: number, hour: number, min = 0, month = 10): number => new Date(2026, month, monthDay, hour, min).getTime();

/** 流水桩构造器：date 默认按 startTs 的本地日键生成（与统计引擎写入口径一致） */
const rec = (over: Partial<WatchRecordEntity> & { startTs: number }): WatchRecordEntity => {
  const base: WatchRecordEntity = {
    courId: 1,
    teclId: 1,
    date: localDayKey(over.startTs),
    startTs: over.startTs,
    endTs: over.startTs + (over.durationSec ?? 600) * 1000,
    durationSec: 600,
    playMode: 'vod',
    speed: 1,
    firstWatch: true,
    valid: true,
  };
  return { ...base, ...over } as WatchRecordEntity;
};

/** 取某桶（按 key） */
const bucketOf = (result: NonNullable<ReturnType<typeof buildTimeOfDayDistribution>>, key: string) => {
  const found = result.find((b) => b.key === key);
  if (!found) throw new Error(`桶 ${key} 不存在`);
  return found;
};

describe('buildTimeOfDayDistribution 六桶边界与桶序（第 238 轮）', () => {
  it('桶界：5→清晨 / 8→上午 / 12→午后 / 14→傍晚 / 18→晚间 / 23→深夜', () => {
    const records = [
      rec({ startTs: ts(21, 5) }),
      rec({ startTs: ts(21, 8) }),
      rec({ startTs: ts(21, 12) }),
      rec({ startTs: ts(21, 14) }),
      rec({ startTs: ts(21, 18) }),
      rec({ startTs: ts(21, 23) }),
    ];
    const result = buildTimeOfDayDistribution(records, NOW);
    expect(result).not.toBeNull();
    expect(result!.map((b) => b.label)).toEqual(['清晨', '上午', '午后', '傍晚', '晚间', '深夜']); // 固定桶序
    expect(result!.map((b) => b.count)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(result!.map((b) => b.sec)).toEqual([600, 600, 600, 600, 600, 600]);
  });

  it('桶内右开边界：7→清晨 / 11→上午 / 13→午后 / 17→傍晚 / 22→晚间（含 23:59）', () => {
    const records = [
      rec({ startTs: ts(21, 7, 59) }),
      rec({ startTs: ts(21, 11, 59) }),
      rec({ startTs: ts(21, 13, 59) }),
      rec({ startTs: ts(21, 17, 59) }),
      rec({ startTs: ts(21, 22, 59) }),
    ];
    const result = buildTimeOfDayDistribution(records, NOW);
    expect(result!.map((b) => b.count)).toEqual([1, 1, 1, 1, 1, 0]); // 全部落在前五桶、深夜空
    expect(bucketOf(result!, 'evening').count).toBe(1);
  });

  it('跨零点深夜归桶：0–4 点与 23 点同归「深夜」（按开始时刻归桶）', () => {
    const records = [
      rec({ startTs: ts(21, 0) }), // 零点整
      rec({ startTs: ts(21, 4, 59) }), // 凌晨最晚
      rec({ startTs: ts(20, 23, 30) }), // 昨日深夜
    ];
    const result = buildTimeOfDayDistribution(records, NOW);
    const lateNight = bucketOf(result!, 'lateNight');
    expect(lateNight.count).toBe(3);
    expect(lateNight.sec).toBe(1800);
    // 其余五桶全空（跨零点记录不按时长拆分，只归开始时刻所在桶）
    expect(result!.filter((b) => b.key !== 'lateNight').every((b) => b.sec === 0 && b.count === 0)).toBe(true);
  });

  it('timeOfDayHourLabel：六桶时刻范围标注（tooltip 文案），未知 key 空串', () => {
    expect(timeOfDayHourLabel('dawn')).toBe('5–8 点');
    expect(timeOfDayHourLabel('morning')).toBe('8–12 点');
    expect(timeOfDayHourLabel('midday')).toBe('12–14 点');
    expect(timeOfDayHourLabel('dusk')).toBe('14–18 点');
    expect(timeOfDayHourLabel('evening')).toBe('18–23 点');
    expect(timeOfDayHourLabel('lateNight')).toBe('23–5 点');
    expect(timeOfDayHourLabel('nope' as never)).toBe('');
  });
});

describe('buildTimeOfDayDistribution valid 口径与脏数据防御（第 238 轮）', () => {
  it('只计 valid=true：invalid 流水 sec 与 count 同源不计（与报表「有效时长」同线）', () => {
    const records = [
      rec({ startTs: ts(21, 20), durationSec: 900 }), // 晚间有效
      rec({ startTs: ts(21, 21), durationSec: 3600, valid: false }), // 挂机 invalid → 整条跳过
      rec({ startTs: ts(21, 10), durationSec: 0 }), // 0 秒流水跳过
      rec({ startTs: ts(21, 10), durationSec: -5 }), // 负秒跳过
    ];
    const result = buildTimeOfDayDistribution(records, NOW);
    expect(bucketOf(result!, 'evening')).toEqual({ key: 'evening', label: '晚间', sec: 900, count: 1 });
    expect(bucketOf(result!, 'morning')).toEqual({ key: 'morning', label: '上午', sec: 0, count: 0 });
  });

  it('脏行逐条跳过：非对象 / 非法日键 / startTs 非有限 / durationSec 非有限正数', () => {
    const records = [
      null as unknown as WatchRecordEntity,
      { ...rec({ startTs: ts(21, 20) }), date: '20261121' } as unknown as WatchRecordEntity, // 形似日键
      { ...rec({ startTs: ts(21, 20) }), startTs: Number.NaN } as unknown as WatchRecordEntity,
      rec({ startTs: ts(21, 20), durationSec: Number.NaN }),
      rec({ startTs: ts(21, 20) }), // 唯一有效行
    ];
    const result = buildTimeOfDayDistribution(records, NOW);
    expect(bucketOf(result!, 'evening')).toEqual({ key: 'evening', label: '晚间', sec: 600, count: 1 });
  });

  it('空数据 / 全 invalid / 总时长 0 → null（UI 空态）', () => {
    expect(buildTimeOfDayDistribution([], NOW)).toBeNull();
    expect(buildTimeOfDayDistribution(null, NOW)).toBeNull();
    expect(buildTimeOfDayDistribution(undefined, NOW)).toBeNull();
    expect(buildTimeOfDayDistribution([rec({ startTs: ts(21, 20), valid: false })], NOW)).toBeNull();
  });

  it('now 非有限 → null（纯函数约定：「今天」必须由调用方传入）', () => {
    expect(buildTimeOfDayDistribution([rec({ startTs: ts(21, 20) })], Number.NaN)).toBeNull();
    expect(buildTimeOfDayDistribution([rec({ startTs: ts(21, 20) })], undefined)).toBeNull();
    expect(buildTimeOfDayDistribution([rec({ startTs: ts(21, 20) })], 'x' as unknown as number)).toBeNull();
  });
});

describe('buildTimeOfDayDistribution 窗口过滤（第 238 轮）', () => {
  it('默认 30 天窗口（含今天）：2026-10-23 起 2026-11-21 止，界外日期排除', () => {
    const records = [
      rec({ startTs: ts(23, 20, 0, 9) }), // 2026-10-23 窗口首日 → 计入
      rec({ startTs: ts(22, 20, 0, 9) }), // 2026-10-22 界外 → 排除
      rec({ startTs: ts(21, 20) }), // 今天 → 计入
      rec({ startTs: ts(22, 20) }), // 未来日（防御）→ 排除
    ];
    const result = buildTimeOfDayDistribution(records, NOW);
    expect(bucketOf(result!, 'evening')).toEqual({ key: 'evening', label: '晚间', sec: 1200, count: 2 });
    // 默认窗口常量与聚合默认一致（近 30 天）
    expect(TIME_OF_DAY_DEFAULT_DAYS).toBe(30);
  });

  it('days 参数覆盖窗口：days=7 → 仅近 7 天（2026-11-15 起）', () => {
    const records = [
      rec({ startTs: ts(15, 8, 0) }), // 2026-11-15 窗口首日 → 计入
      rec({ startTs: ts(14, 8, 0) }), // 2026-11-14 界外 → 排除
      rec({ startTs: ts(21, 9, 0) }), // 今天 → 计入
    ];
    const result = buildTimeOfDayDistribution(records, NOW, 7);
    expect(bucketOf(result!, 'morning')).toEqual({ key: 'morning', label: '上午', sec: 1200, count: 2 });
  });

  it('days 非法回退默认 30；days clamp 到 [1, 365]（0 → 1 仅今天窗口）', () => {
    const records = [rec({ startTs: ts(25, 20, 0, 9) })]; // 2026-10-25（30 天窗口内、7 天窗口外）
    expect(buildTimeOfDayDistribution(records, NOW, Number.NaN)!.find((b) => b.key === 'evening')!.count).toBe(1); // 回退 30 → 计入
    expect(buildTimeOfDayDistribution(records, NOW, 7)).toBeNull(); // 7 天窗口外全排除 → null
    expect(buildTimeOfDayDistribution(records, NOW, 400)).not.toBeNull(); // clamp 365 → 计入
    expect(buildTimeOfDayDistribution(records, NOW, 1)).toBeNull(); // 仅今天窗口 → 排除
    expect(buildTimeOfDayDistribution(records, NOW, 0)).toBeNull(); // clamp 到 1（仅今天窗口）→ 排除
  });
});

describe('buildTimeOfDayDistribution count 与 sec 独立正确（第 238 轮）', () => {
  it('多行累计：sec 求和、count 计数互不干扰，四舍五入取整', () => {
    const records = [
      rec({ startTs: ts(21, 19), durationSec: 1500.4 }), // 19 点
      rec({ startTs: ts(21, 20, 30), durationSec: 233.6 }), // 20 点（同桶不同条）
      rec({ startTs: ts(21, 6), durationSec: 600 }), // 清晨孤行
    ];
    const result = buildTimeOfDayDistribution(records, NOW);
    expect(bucketOf(result!, 'evening')).toEqual({ key: 'evening', label: '晚间', sec: 1734, count: 2 }); // 1500.4 + 233.6 = 1734
    expect(bucketOf(result!, 'dawn')).toEqual({ key: 'dawn', label: '清晨', sec: 600, count: 1 });
  });
});

// ───────────────────────── 黄金时段建议（第 239 轮巡检） ─────────────────────────

import {
  GOLDEN_SLOT_MIN_SHARE,
  GOLDEN_SLOT_MIN_TOTAL_SEC,
  isInGoldenNow,
  suggestGoldenSlot,
  type TimeOfDayBucket,
} from '@/core/stats/timeOfDay';

/** 分布桶桩构造器：label 传入「脏值」以验证 label 由桶定义而非行内值给出 */
const bucket = (key: TimeOfDayBucket['key'], sec: number, label = '脏label', count = 1): TimeOfDayBucket => ({ key, label, sec, count });

describe('suggestGoldenSlot 黄金时段建议（第 239 轮巡检）', () => {
  it('达门槛（总有效 ≥60 分钟且最高桶占比 ≥25%）→ 返回最高占比桶建议', () => {
    // 晚间 3h + 清晨 1h = 4h 总量，晚间占比 75%
    const dist = [bucket('dawn', 3600), bucket('evening', 10800)];
    expect(suggestGoldenSlot(dist)).toEqual({ key: 'evening', label: '晚间', shareSec: 10800, share: 0.75 });
  });

  it('总有效时长恰为 60 分钟（边界 ≥）→ 有建议；59:59 → null', () => {
    const atBoundary = [bucket('evening', GOLDEN_SLOT_MIN_TOTAL_SEC)]; // 恰 60 分钟、占比 100%
    expect(suggestGoldenSlot(atBoundary)).toEqual({ key: 'evening', label: '晚间', shareSec: GOLDEN_SLOT_MIN_TOTAL_SEC, share: 1 });
    const below = [bucket('evening', GOLDEN_SLOT_MIN_TOTAL_SEC - 1)];
    expect(suggestGoldenSlot(below)).toBeNull();
  });

  it('最高桶占比恰为 25%（边界 ≥）→ 有建议；不足 25% → null', () => {
    // 构造「最高桶恰 25%」：其余桶合计 = 3×最高桶且每桶严格小于最高桶（否则并列改判桶序）
    const atShare = [
      bucket('dawn', 3),
      bucket('morning', 3599),
      bucket('midday', 3599),
      bucket('dusk', 3599),
      bucket('evening', 3600), // 3600 / 14400 = 0.25（恰为阈值，浮点可精确表示）
    ];
    expect(suggestGoldenSlot(atShare)).toEqual({ key: 'evening', label: '晚间', shareSec: 3600, share: GOLDEN_SLOT_MIN_SHARE });
    // 最高桶 3599 / 14399 < 0.25 → null
    const belowShare = [bucket('dawn', 3), bucket('morning', 3599), bucket('midday', 3599), bucket('dusk', 3599), bucket('evening', 3599)];
    expect(suggestGoldenSlot(belowShare)).toBeNull();
  });

  it('并列最高取固定桶序靠前（清晨→深夜序，与时段卡 topKey 同约定）', () => {
    const dist = [bucket('dusk', 7200), bucket('morning', 7200)]; // 输入乱序也不影响桶序裁决
    expect(suggestGoldenSlot(dist)?.key).toBe('morning');
  });

  it('空数据 / 非数组 / 全零桶 → null', () => {
    expect(suggestGoldenSlot(null)).toBeNull();
    expect(suggestGoldenSlot(undefined)).toBeNull();
    expect(suggestGoldenSlot([])).toBeNull();
    expect(suggestGoldenSlot([bucket('dawn', 0), bucket('evening', 0)])).toBeNull();
    expect(suggestGoldenSlot('not-an-array' as unknown as TimeOfDayBucket[])).toBeNull();
  });

  it('脏行防御：未知 key / sec 非有限正数 / 非对象行逐条跳过，不抛错', () => {
    const dirty = [
      { key: 'garbage', sec: 99999 } as unknown as TimeOfDayBucket, // 未知 key
      bucket('evening', Number.NaN), // sec 非有限
      bucket('morning', -5), // 负数
      bucket('dusk', 0),
      null as unknown as TimeOfDayBucket,
      42 as unknown as TimeOfDayBucket,
      bucket('dawn', 7200), // 唯一有效行：1 恰好 60 分钟、100% → 有建议
    ];
    expect(suggestGoldenSlot(dirty)).toEqual({ key: 'dawn', label: '清晨', shareSec: 7200, share: 1 });
  });

  it('label 取桶定义而非行内值（脏 label 不串味）；shareSec 取整', () => {
    const dist = [bucket('evening', 1800.4, '脏label')]; // 30.007 分钟 < 60 → null 先拦截
    expect(suggestGoldenSlot(dist)).toBeNull();
    const dist2 = [bucket('evening', 5400.4, '脏label')]; // 90 分钟、100% → 有建议
    const result = suggestGoldenSlot(dist2)!;
    expect(result.label).toBe('晚间');
    expect(result.shareSec).toBe(5400); // Math.round(5400.4)
  });
});

describe('isInGoldenNow 当前小时判定（第 239 轮巡检）', () => {
  const evening: ReturnType<typeof suggestGoldenSlot> = { key: 'evening', label: '晚间', shareSec: 10800, share: 0.75 };

  it('晚间桶 [18,23)：18–22 点 true，17 / 23 点 false', () => {
    for (const hour of [18, 19, 20, 21, 22]) expect(isInGoldenNow(evening, hour)).toBe(true);
    expect(isInGoldenNow(evening, 17)).toBe(false);
    expect(isInGoldenNow(evening, 23)).toBe(false);
  });

  it('跨零点桶（深夜 [23,24)∪[0,5)）：23 点与 0–4 点同 true，5 点 false', () => {
    const lateNight = { key: 'lateNight' as const, label: '深夜', shareSec: 7200, share: 0.5 };
    expect(isInGoldenNow(lateNight, 23)).toBe(true);
    for (const hour of [0, 1, 2, 3, 4]) expect(isInGoldenNow(lateNight, hour)).toBe(true);
    expect(isInGoldenNow(lateNight, 5)).toBe(false);
  });

  it('golden 为 null / 未知 key / nowHour 非法（小数、越界、非有限）→ false', () => {
    expect(isInGoldenNow(null, 20)).toBe(false);
    expect(isInGoldenNow(undefined, 20)).toBe(false);
    expect(isInGoldenNow({ key: 'garbage' as never, label: 'x', shareSec: 1, share: 1 }, 20)).toBe(false);
    expect(isInGoldenNow(evening, 19.5)).toBe(false);
    expect(isInGoldenNow(evening, -1)).toBe(false);
    expect(isInGoldenNow(evening, 24)).toBe(false);
    expect(isInGoldenNow(evening, Number.NaN)).toBe(false);
  });
});
