/**
 * eventTargetOf 单测（第 51 轮审计 P2-1 修复的取值逻辑锁定）：
 * shadow DOM 内键盘/指针事件冒泡到 document 时 target 被重定向为 shadow host，
 * 输入态守卫需取 composedPath()[0]（未重定向的原始目标）；无 composedPath 的
 * 环境（旧 jsdom）回落 event.target。
 */

import { describe, expect, it } from 'vitest';
import { eventTargetOf } from '@/core/shared/utils';

describe('eventTargetOf（第 51 轮审计 P2-1）', () => {
  it('有 composedPath 时取 path[0]（shadow 重定向后的真实目标）', () => {
    const host = { tagName: 'DIV' };
    const realInput = { tagName: 'INPUT' };
    const event = {
      target: host,
      composedPath: () => [realInput, host],
    };
    expect(eventTargetOf(event)).toBe(realInput);
  });

  it('composedPath 为空数组时回落 event.target', () => {
    const host = { tagName: 'DIV' };
    const event = { target: host, composedPath: () => [] };
    expect(eventTargetOf(event)).toBe(host);
  });

  it('无 composedPath（旧 jsdom）时回落 event.target', () => {
    const target = { tagName: 'INPUT' };
    expect(eventTargetOf({ target })).toBe(target);
  });

  it('composedPath 抛异常时回落 event.target；target 为 null 返回 null', () => {
    const target = { tagName: 'TEXTAREA' };
    expect(eventTargetOf({ target, composedPath: () => { throw new Error('boom'); } })).toBe(target);
    expect(eventTargetOf({ target: null, composedPath: () => [undefined] })).toBeNull();
  });
});
