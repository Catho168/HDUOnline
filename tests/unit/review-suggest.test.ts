/**
 * 「下次复习日期」建议纯函数测试（第 245 轮巡检，复习策略域 / 反馈视角）。
 *
 * 覆盖 core/plan/reviewSuggest.ts 的行为约定：
 *  1. nextSuggestIntervalDays：倍增序列 [3,7,14,30] 的推进与封顶（上一段间隔
 *     1→3、3→7、7→14、14→30、≥30 封顶）；缺失/非法入参回退首档 3；
 *  2. suggestNextReviewDate：dateKey = 完成日 + intervalDays；三种入参形态
 *     （毫秒时间戳 / Date / 'YYYY-MM-DD' 日键）与非法入参返回 null；
 *  3. lastIntervalForRound：模板间隔 steps[round-1] 反推；越界/脏数据 undefined；
 *  4. monthDayLabelOf：'M月D日' 短标签与非法键原样返回。
 */

import { describe, expect, it } from 'vitest';
import {
  REVIEW_SUGGEST_INTERVALS,
  lastIntervalForRound,
  monthDayLabelOf,
  nextSuggestIntervalDays,
  suggestNextReviewDate,
} from '@/core/plan/reviewSuggest';
import { addDaysKey, localDayKey } from '@/core/shared/utils';

describe('nextSuggestIntervalDays（倍增序列推进与封顶）', () => {
  it('倍增序列按上一段间隔 +1 档推进：1→3、3→7、7→14、14→30', () => {
    expect(nextSuggestIntervalDays(1)).toBe(3);
    expect(nextSuggestIntervalDays(3)).toBe(7);
    expect(nextSuggestIntervalDays(7)).toBe(14);
    expect(nextSuggestIntervalDays(14)).toBe(30);
  });

  it('≥30 封顶：30 与更大间隔都停在 30；序列外的中间值取第一个大于它的档', () => {
    expect(nextSuggestIntervalDays(30)).toBe(30);
    expect(nextSuggestIntervalDays(60)).toBe(30);
    expect(nextSuggestIntervalDays(2)).toBe(3);
    expect(nextSuggestIntervalDays(16)).toBe(30); // 默认 regular 模板末段 16 → 封顶
  });

  it('缺失/非法入参回退首档 3：undefined、null、0、负数、NaN、非数值', () => {
    expect(nextSuggestIntervalDays(undefined)).toBe(3);
    expect(nextSuggestIntervalDays(null)).toBe(3);
    expect(nextSuggestIntervalDays(0)).toBe(3);
    expect(nextSuggestIntervalDays(-3)).toBe(3);
    expect(nextSuggestIntervalDays(Number.NaN)).toBe(3);
    expect(nextSuggestIntervalDays('7' as unknown as number)).toBe(3);
  });

  it('REVIEW_SUGGEST_INTERVALS 序列常量即 [3,7,14,30]', () => {
    expect([...REVIEW_SUGGEST_INTERVALS]).toEqual([3, 7, 14, 30]);
  });
});

describe('suggestNextReviewDate（完成日 + 建议间隔 → 日键）', () => {
  it('日键入参：完成日 + 3 天（首次完成后建议 3 天再看）', () => {
    const today = localDayKey();
    expect(suggestNextReviewDate(today)).toEqual({ dateKey: addDaysKey(today, 3)!, intervalDays: 3 });
  });

  it('上一段间隔 3 → 建议 7 天：dateKey = 完成日 + 7', () => {
    expect(suggestNextReviewDate('2026-11-21', 3)).toEqual({ dateKey: '2026-11-28', intervalDays: 7 });
  });

  it('毫秒时间戳与 Date 入参等价于同日日键入参', () => {
    const ts = new Date(2026, 10, 21, 15, 30).getTime();
    expect(suggestNextReviewDate(ts, 3)).toEqual(suggestNextReviewDate('2026-11-21', 3));
    expect(suggestNextReviewDate(new Date(2026, 10, 21, 8, 0), 7)).toEqual({
      dateKey: '2026-12-05',
      intervalDays: 14,
    });
  });

  it('跨月/跨年按日历日推进', () => {
    expect(suggestNextReviewDate('2026-11-30')).toEqual({ dateKey: '2026-12-03', intervalDays: 3 });
    expect(suggestNextReviewDate('2026-12-30', 3)).toEqual({ dateKey: '2027-01-06', intervalDays: 7 });
  });

  it('非法入参返回 null：NaN 时间戳、Invalid Date、非法/溢出日键、非字符串', () => {
    expect(suggestNextReviewDate(Number.NaN)).toBeNull();
    expect(suggestNextReviewDate(new Date('not-a-date'))).toBeNull();
    expect(suggestNextReviewDate('2026-13-40')).toBeNull();
    expect(suggestNextReviewDate('20261121')).toBeNull();
    expect(suggestNextReviewDate(undefined as unknown as string)).toBeNull();
    expect(suggestNextReviewDate(123 as unknown as string, undefined)).not.toBeNull(); // 数字入参合法
    expect(suggestNextReviewDate({} as unknown as string)).toBeNull();
  });
});

describe('lastIntervalForRound（模板间隔反推上一段间隔）', () => {
  const intervals = { regular: [1, 3, 7, 16], exam: [1, 2, 3, 5, 7], custom: [1, 3, 7] };

  it('regular 模板：round 1/2/3 → 上一段间隔 1/3/7', () => {
    expect(lastIntervalForRound('regular', 1, intervals)).toBe(1);
    expect(lastIntervalForRound('regular', 2, intervals)).toBe(3);
    expect(lastIntervalForRound('regular', 3, intervals)).toBe(7);
  });

  it('exam / custom 模板同口径', () => {
    expect(lastIntervalForRound('exam', 4, intervals)).toBe(5);
    expect(lastIntervalForRound('custom', 2, intervals)).toBe(3);
  });

  it('模板未收录 / round 越界 / 脏入参 → undefined（调用方回退首档）', () => {
    expect(lastIntervalForRound('unknown', 1, intervals)).toBeUndefined();
    expect(lastIntervalForRound('regular', 5, intervals)).toBeUndefined(); // regular 只有 4 段
    expect(lastIntervalForRound('regular', 0, intervals)).toBeUndefined();
    expect(lastIntervalForRound('regular', '2', intervals)).toBeUndefined();
    expect(lastIntervalForRound('regular', 2, undefined)).toBeUndefined();
    expect(lastIntervalForRound(undefined, 2, intervals)).toBeUndefined();
  });

  it('与 suggestNextReviewDate 端到端衔接：regular round 1 完成 → 建议 +3 天', () => {
    const suggestion = suggestNextReviewDate('2026-11-21', lastIntervalForRound('regular', 1, intervals));
    expect(suggestion).toEqual({ dateKey: '2026-11-24', intervalDays: 3 });
  });
});

describe('monthDayLabelOf（日键 → M月D日）', () => {
  it('常规日键去前导零', () => {
    expect(monthDayLabelOf('2026-11-21')).toBe('11月21日');
    expect(monthDayLabelOf('2026-03-05')).toBe('3月5日');
  });

  it('非法键原样返回', () => {
    expect(monthDayLabelOf('bad-key')).toBe('bad-key');
    expect(monthDayLabelOf('2026-13-01')).toBe('2026-13-01');
  });
});
