/**
 * chrome.storage 轻封装。非扩展环境（vitest / node）下退化为内存实现。
 * 区域划分由调用方决定：Key 只进 local，纯偏好进 sync。
 */

import { deepMerge } from './utils';

type Area = 'local' | 'sync';

interface StorageAreaLike {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear?(): Promise<void>;
}

const memory: Record<Area, Map<string, unknown>> = {
  local: new Map(),
  sync: new Map(),
};

function cloneSafe<T>(value: T): T {
  if (value === undefined) return value;
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value)) as T;
    } catch {
      return value;
    }
  }
}

function memoryArea(area: Area): StorageAreaLike {
  const map = memory[area];
  return {
    async get(keys) {
      if (keys == null) return Object.fromEntries(map.entries());
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (map.has(k)) out[k] = cloneSafe(map.get(k));
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) map.set(k, cloneSafe(v));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
    },
    async clear() {
      map.clear();
    },
  };
}

function getArea(area: Area): StorageAreaLike {
  const g = globalThis as unknown as { chrome?: { storage?: Record<string, StorageAreaLike | undefined> } };
  const api = g.chrome?.storage?.[area];
  if (api && typeof api.get === 'function') return api;
  return memoryArea(area);
}

export const extStorage = {
  async get<T>(area: Area, key: string, fallback: T): Promise<T> {
    const res = await getArea(area).get(key);
    const value = res[key];
    return value === undefined ? fallback : (value as T);
  },

  async getRaw(area: Area, keys: string[]): Promise<Record<string, unknown>> {
    return getArea(area).get(keys);
  },

  async set(area: Area, key: string, value: unknown): Promise<void> {
    await getArea(area).set({ [key]: cloneSafe(value) });
  },

  async remove(area: Area, key: string): Promise<void> {
    await getArea(area).remove(key);
  },

  async getMerged<T extends object>(area: Area, key: string, defaults: T): Promise<T> {
    const stored = await extStorage.get<Partial<T> | null>(area, key, null);
    if (!stored || typeof stored !== 'object') return cloneSafe(defaults);
    return deepMerge(cloneSafe(defaults), stored);
  },

  __resetMemory(area?: Area): void {
    if (area) memory[area].clear();
    else {
      memory.local.clear();
      memory.sync.clear();
    }
  },
};

export async function estimateStorage(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
    }
  } catch {
    /* 忽略 */
  }
  return null;
}

// ───────────────────────── 流水增长预估（第 254 轮巡检，存储健康域） ─────────────────────────

/**
 * watchRecords 单条体积估算常数（字节，**粗估**）。
 *
 * 估据（WatchRecordEntity，schema 见 core/db/schema.ts）：7 个数值字段
 * （courId / teclId / startTs / endTs / durationSec / speed / 自增 id，JS double ≈ 8B
 * 共 ~56B）+ date 'YYYY-MM-DD' 字符串 + playMode 'vod' 短字符串 + firstWatch / valid
 * 两个布尔 → 序列化后 ~90-110B，叠加 IndexedDB 记录键与 B 树条目开销 ~40-60%，
 * 取中值 200B。真实值随引擎实现浮动，仅用于「月增量体积」量级预估（UI 与日志均
 * 注明粗估），不作精确容量承诺。
 */
export const WATCH_RECORD_BYTES_EST = 200;

export interface StoreGrowthEstimate {
  /** 窗口内流水条数（输入回显） */
  windowCount: number;
  /** 窗口天数（输入回显，防御式归零后） */
  windowDays: number;
  /** 日均条数（一位小数） */
  dailyAvg: number;
  /** 预估 30 天增量条数 = 日均 × 30 */
  monthlyCount: number;
  /** 预估 30 天增量体积（字节）= monthlyCount × WATCH_RECORD_BYTES_EST（粗估） */
  monthlyBytes: number;
  /** 单条平均字节常数回显（UI 提示与测试口径用） */
  recordBytesEst: number;
}

/**
 * 流水增长预估（纯函数）：按「近 N 天日均条数 → 月（30 天）增量条数 / 体积」外推。
 *
 * 输入 records 应为窗口内已取出的流水行（如 `stats.records` op 的近 30 天返回），
 * 天数与取数窗口一致；函数不做日期过滤（窗口语义由调用方保证，保持纯函数无 IO）。
 * 防御式：days 非有限 / ≤0、records 非数组或空 → 全 0（不给无据估计）。
 */
export function estimateStoreGrowth(
  records: ReadonlyArray<unknown> | null | undefined,
  days: number,
): StoreGrowthEstimate {
  const windowDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 0;
  const windowCount = Array.isArray(records) ? records.length : 0;
  const zero: StoreGrowthEstimate = {
    windowCount,
    windowDays,
    dailyAvg: 0,
    monthlyCount: 0,
    monthlyBytes: 0,
    recordBytesEst: WATCH_RECORD_BYTES_EST,
  };
  if (windowDays <= 0 || windowCount === 0) return zero;
  const dailyAvg = Math.round((windowCount / windowDays) * 10) / 10;
  const monthlyCount = Math.round(dailyAvg * 30);
  return {
    windowCount,
    windowDays,
    dailyAvg,
    monthlyCount,
    monthlyBytes: monthlyCount * WATCH_RECORD_BYTES_EST,
    recordBytesEst: WATCH_RECORD_BYTES_EST,
  };
}
