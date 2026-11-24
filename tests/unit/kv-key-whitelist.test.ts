/**
 * kv.* op 键白名单集成测试（第 24 轮审计 P3 纵深防御）。
 *
 * 覆盖：
 *  1. KV_KEYS 注册的静态键：kv.set → kv.get → kv.del 全链路可写可读可删；
 *  2. 动态键按前缀规则放行：aiHidden:<courId> / missedExcluded:<courId> /
 *     hdu.todo.done.<YYYY-MM-DD>（今日待办勾选状态键，TODAY_KV_PREFIX）；
 *  3. 未注册键（含内部键变体、空前缀尾、非字符串键）一律 INVALID_INPUT，
 *     且不产生任何落库副作用。
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { getDb } from '@/core/db';
import { KV_KEYS, isAllowedKvKey, kvGet } from '@/core/db/repo/misc';
import { TODAY_KV_PREFIX } from '@/core/plan/today';
import { AppError } from '@/core/shared/errors';
import { dispatchOp } from '@/entrypoints/background/ops';

beforeAll(async () => {
  await getDb();
});

const asError = async (p: Promise<unknown>): Promise<AppError> => (await p.catch((e: unknown) => e)) as AppError;

describe('kv.* op 键白名单（第 24 轮 P3）', () => {
  it('静态注册键全链路：kv.set → kv.get → kv.del', async () => {
    await dispatchOp('kv.set', { key: KV_KEYS.goalAdjust, value: { deltaMin: 30 } });
    expect(await dispatchOp('kv.get', { key: KV_KEYS.goalAdjust })).toEqual({ deltaMin: 30 });
    await dispatchOp('kv.del', { key: KV_KEYS.goalAdjust });
    expect(await dispatchOp('kv.get', { key: KV_KEYS.goalAdjust })).toBeNull();
  });

  it('KV_KEYS 全部静态键都在白名单内（防漂移）', () => {
    const staticKeys = Object.values(KV_KEYS).filter((v) => typeof v === 'string') as string[];
    expect(staticKeys.length).toBeGreaterThanOrEqual(6);
    for (const key of staticKeys) expect(isAllowedKvKey(key), key).toBe(true);
  });

  it('动态日期键按前缀规则通过：hdu.todo.done.<YYYY-MM-DD>', async () => {
    const key = `${TODAY_KV_PREFIX}2026-11-17`;
    expect(isAllowedKvKey(key)).toBe(true);
    await dispatchOp('kv.set', { key, value: ['review:job-1', 'video:BVdemo'] });
    expect(await dispatchOp('kv.get', { key })).toEqual(['review:job-1', 'video:BVdemo']);
    await dispatchOp('kv.del', { key });
    expect(await dispatchOp('kv.get', { key })).toBeNull();
  });

  it('courId 动态键按前缀规则通过：aiHidden:<courId> / missedExcluded:<courId>', () => {
    expect(isAllowedKvKey('aiHidden:12345')).toBe(true);
    expect(isAllowedKvKey('missedExcluded:67890')).toBe(true);
  });

  it('未注册键被拒：INVALID_INPUT，且不落库', async () => {
    for (const key of [
      'not-a-registered-key',
      'goal:adjust:evil', // 内部键 goal:adjust 的变体
      'schedule:termYear:v2', // 内部键 schedule:termYear 的变体
      'aiHidden:', // 动态前缀的空前缀尾不放行
      'hdu.todo.done.', // 动态前缀的空前缀尾不放行
    ]) {
      const err = await asError(dispatchOp('kv.set', { key, value: 1 }));
      expect(err, key).toBeInstanceOf(AppError);
      expect(err.code, key).toBe('INVALID_INPUT');
      expect(isAllowedKvKey(key), key).toBe(false);
    }
    // 拒绝发生在写库之前：未注册键没有任何落库副作用
    expect(await kvGet('not-a-registered-key')).toBeNull();
  });

  it('kv.get / kv.del 对未注册键同样被拒', async () => {
    expect((await asError(dispatchOp('kv.get', { key: 'evil:key' }))).code).toBe('INVALID_INPUT');
    expect((await asError(dispatchOp('kv.del', { key: 'evil:key' }))).code).toBe('INVALID_INPUT');
  });

  it('非字符串键被拒（运行时收窄，不依赖 TS 类型）', async () => {
    const err = await asError(dispatchOp('kv.get', { key: 123 as unknown as string }));
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('INVALID_INPUT');
  });
});
