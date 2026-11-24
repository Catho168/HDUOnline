/**
 * 每周回看学习计划仓储（weeklyPlans store，DB v4 新增）。
 *
 * 计划是用户资产（学习安排数据），必须进入全量备份（BACKUP_STORES 已收录，
 * 导入侧按防御式逐条校验处理）。切片 / 进度 / 活跃判定等口径见 core/plan/weekly
 * 纯函数，本文件只做存取与防御式兜底：库中的旧/脏数据在读取时跳过，不抛错。
 */

import { getDb, mapDbError } from '../index';
import type { WeeklyPlan } from '../../plan/weekly';

function wrap<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err) => {
    throw mapDbError(err);
  });
}

/** 防御式解析单条计划：形状不符（缺主键 / 字段类型不对）返回 null，由调用方跳过 */
function asWeeklyPlan(value: unknown): WeeklyPlan | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || row.id.length === 0) return null;
  if (typeof row.perDay !== 'number' || !Number.isFinite(row.perDay)) return null;
  if (!Array.isArray(row.bvids)) return null;
  if (typeof row.startDate !== 'string' || row.startDate.length === 0) return null;
  const bvids = row.bvids.filter((b): b is string => typeof b === 'string' && b.length > 0);
  return {
    id: row.id,
    ...(typeof row.label === 'string' && row.label.length > 0 ? { label: row.label } : {}),
    perDay: row.perDay,
    bvids,
    startDate: row.startDate,
    createdAt: typeof row.createdAt === 'number' && Number.isFinite(row.createdAt) ? row.createdAt : 0,
    updatedAt: typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
  };
}

/** 全量读取（按 createdAt 升序 = 创建顺序，UI 的「主计划」取首个）；坏数据跳过不抛错 */
export async function getWeeklyPlans(): Promise<WeeklyPlan[]> {
  return wrap(async () => {
    const db = await getDb();
    const rows = (await db.getAll('weeklyPlans')) as unknown[];
    return rows
      .map(asWeeklyPlan)
      .filter((plan): plan is WeeklyPlan => plan !== null)
      .sort((a, b) => a.createdAt - b.createdAt);
  });
}

/** 写入 / 覆盖（主键 id） */
export async function upsertWeeklyPlan(plan: WeeklyPlan): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    await db.put('weeklyPlans', plan);
  });
}

/** 删除（取消计划的通道；删除不存在的主键视为成功，幂等） */
export async function deleteWeeklyPlan(id: string): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    await db.delete('weeklyPlans', id);
  });
}
