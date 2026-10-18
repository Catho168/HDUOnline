/** 统计流水仓储：watchRecords。 */

import { getDb, mapDbError } from '../index';
import type { WatchRecordEntity } from '../../shared/types';
import { localDayKey } from '../../shared/utils';

function wrap<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err) => {
    throw mapDbError(err);
  });
}

export async function addWatchRecord(record: WatchRecordEntity): Promise<number> {
  return wrap(async () => {
    const db = await getDb();
    return (await db.add('watchRecords', record)) as number;
  });
}

/** 按自然日区间取流水（含端点） */
export async function listWatchRecords(fromDay: string, toDay: string): Promise<WatchRecordEntity[]> {
  return wrap(async () => {
    const db = await getDb();
    const tx = db.transaction('watchRecords');
    const range = IDBKeyRange.bound(fromDay, toDay);
    const list = await tx.store.index('date').getAll(range);
    await tx.done;
    return list.sort((a, b) => a.startTs - b.startTs);
  });
}

export async function listRecordsBySession(courId: number): Promise<WatchRecordEntity[]> {
  return wrap(async () => {
    const db = await getDb();
    const list = await db.getAllFromIndex('watchRecords', 'courId', courId);
    return list.sort((a, b) => a.startTs - b.startTs);
  });
}

/** 某课次的有效累计秒数 */
export async function sumValidSecBySession(courId: number): Promise<number> {
  const records = await listRecordsBySession(courId);
  return Math.round(records.reduce((acc, r) => acc + (r.valid ? r.durationSec : 0), 0));
}

/** 某日（本地）有效累计秒数——用于引擎封顶的初始化 */
export async function sumValidSecByDay(date = localDayKey()): Promise<number> {
  return wrap(async () => {
    const db = await getDb();
    const list = await db.getAllFromIndex('watchRecords', 'date', date);
    return Math.round(list.reduce((acc, r) => acc + (r.valid ? r.durationSec : 0), 0));
  });
}

/** 清除全部学习流水（E 模块"数据管理"） */
export async function clearWatchRecords(): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    await db.clear('watchRecords');
  });
}
