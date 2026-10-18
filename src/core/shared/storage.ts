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

export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
      return await navigator.storage.persist();
    }
  } catch {
    /* 忽略 */
  }
  return false;
}
