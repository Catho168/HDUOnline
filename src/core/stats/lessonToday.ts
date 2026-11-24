/**
 * 本课学习小条的今日聚合（第 241 轮巡检，纯函数无 IO）：
 * 看课页「本课学习小条」的「本课今日已学」数字来源——对 stats.records
 * 返回的当日 watchRecords 按 courId 过滤并合计有效时长。
 * 口径与报表一致：只计 valid=true 的流水（挂机/异常流水保留审计但不进报表，
 * 见 core/stats/aggregate.ts buildReport）；durationSec 非法/负数按 0 计。
 */

import type { WatchRecordEntity } from '../shared/types';

/** 合计指定课次的当日有效观看秒数（records 非数组 / 脏行防御式跳过） */
export function sumLessonValidSec(
  records: unknown,
  courId: number,
): number {
  if (!Array.isArray(records) || !Number.isFinite(courId)) return 0;
  let total = 0;
  for (const record of records as WatchRecordEntity[]) {
    if (!record || typeof record !== 'object') continue;
    if (record.valid !== true) continue;
    if (record.courId !== courId) continue;
    const sec = record.durationSec;
    if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) continue;
    total += sec;
  }
  return Math.round(total);
}
