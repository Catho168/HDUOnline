/**
 * bootSeekSecondsOf 单测（第 104 轮巡检）：统一搜索秒级直达的 ?t= 深链解析——
 * 只认纯数字秒数（≥0），缺失/脏参一律 null（内容脚本启动钩子据此跳过 seek）。
 */
import { describe, expect, it } from 'vitest';
import { bootSeekSecondsOf } from '@/core/shared/utils';

describe('bootSeekSecondsOf（?t= 深链秒级锚点解析，第 104 轮）', () => {
  it('合法秒数解析（含 0 与多参数共存）', () => {
    expect(bootSeekSecondsOf('?t=95')).toBe(95);
    expect(bootSeekSecondsOf('?t=0')).toBe(0);
    expect(bootSeekSecondsOf('?courseId=5&t=301')).toBe(301);
    expect(bootSeekSecondsOf('?t=007')).toBe(7);
  });

  it('缺失/脏参返回 null（不抛错）', () => {
    expect(bootSeekSecondsOf('')).toBeNull();
    expect(bootSeekSecondsOf('?courseId=5')).toBeNull();
    expect(bootSeekSecondsOf('?t=')).toBeNull();
    expect(bootSeekSecondsOf('?t=abc')).toBeNull();
    expect(bootSeekSecondsOf('?t=-5')).toBeNull();
    expect(bootSeekSecondsOf('?t=1e3')).toBeNull();
    expect(bootSeekSecondsOf('?t=12.9')).toBeNull();
  });
});
