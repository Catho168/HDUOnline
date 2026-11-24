/** UiStore 单测（第 204 轮巡检）：markInteraction/patch/subscribe 基础行为。 */
import { describe, expect, it } from 'vitest';
import { UiStore } from '@/entrypoints/content/ui/store';

describe('UiStore（第 204 轮）', () => {
  it('markInteraction 更新 lastInteractionAt 且不触发订阅', () => {
    const store = new UiStore();
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    expect(store.lastInteractionAt).toBe(0);
    store.markInteraction();
    expect(store.lastInteractionAt).toBeGreaterThan(0);
    expect(notified).toBe(0);
  });
  it('连续 markInteraction 时间戳单调不减（第 206 轮）', () => {
    const store = new UiStore();
    const stamps: number[] = [];
    for (let i = 0; i < 5; i++) {
      store.markInteraction();
      stamps.push(store.lastInteractionAt);
    }
    for (let i = 1; i < stamps.length; i++) {
      const prev = stamps[i - 1] ?? 0;
      expect(stamps[i]).toBeGreaterThanOrEqual(prev);
    }
  });
  it('patch 更新 state 并通知订阅者', () => {
    const store = new UiStore();
    const seen: number[] = [];
    store.subscribe(() => seen.push(store.getState().toastVersion));
    store.patch({ toastVersion: 1 });
    store.patch({ toastVersion: 2 });
    expect(seen).toEqual([1, 2]);
  });
  it('subscribe 返回退订函数', () => {
    const store = new UiStore();
    let notified = 0;
    const unsub = store.subscribe(() => {
      notified += 1;
    });
    store.patch({ toastVersion: 1 });
    unsub();
    store.patch({ toastVersion: 2 });
    expect(notified).toBe(1);
  });
  it('update 按函数计算补丁', () => {
    const store = new UiStore();
    store.update((state) => ({ toastVersion: state.toastVersion + 5 }));
    expect(store.getState().toastVersion).toBe(5);
  });
  it('bindActions 覆盖默认 noop', async () => {
    const store = new UiStore();
    let called = 0;
    store.bindActions({ showToast: () => {
      called += 1;
    } });
    store.actions.showToast('x', 'info');
    await Promise.resolve();
    expect(called).toBe(1);
  });
});
