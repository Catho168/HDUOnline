/** duration 工具测试：parseDurationSec 解析规则与 formatSeconds 各分支。 */

import { describe, expect, it } from 'vitest';
import { formatSeconds, parseDurationSec } from '@/core/shared/duration';

describe('parseDurationSec', () => {
  it('解析纯秒数（"ss"）', () => {
    expect(parseDurationSec('65')).toBe(65);
    expect(parseDurationSec('0')).toBe(0);
    expect(parseDurationSec('3600')).toBe(3600);
  });

  it('解析 "mm:ss" 与 "hh:mm:ss"', () => {
    expect(parseDurationSec('12:34')).toBe(754);
    expect(parseDurationSec('1:02:34')).toBe(3754);
    expect(parseDurationSec('00:00')).toBe(0);
  });

  it('容忍全角冒号、全角数字与空白', () => {
    expect(parseDurationSec('１２：３４')).toBe(754);
    expect(parseDurationSec('12：34')).toBe(754);
    expect(parseDurationSec('１：０２：３４')).toBe(3754);
    expect(parseDurationSec(' 12 : 34 ')).toBe(754);
  });

  it('非法输入返回 null', () => {
    expect(parseDurationSec('')).toBeNull();
    expect(parseDurationSec('   ')).toBeNull();
    expect(parseDurationSec('abc')).toBeNull();
    expect(parseDurationSec('12:3a')).toBeNull();
    expect(parseDurationSec('1:2:3:4')).toBeNull();
    expect(parseDurationSec('12.5')).toBeNull();
    expect(parseDurationSec('1:2:')).toBeNull();
  });

  it('负值返回 null', () => {
    expect(parseDurationSec('-5')).toBeNull();
    expect(parseDurationSec('-1:00')).toBeNull();
  });

  it('低位字段 ≥60 超界返回 null', () => {
    expect(parseDurationSec('12:75')).toBeNull();
    expect(parseDurationSec('1:75:34')).toBeNull();
    expect(parseDurationSec('1:02:75')).toBeNull();
  });

  it('最高位允许超过 60（如 75 分钟）', () => {
    expect(parseDurationSec('75:20')).toBe(75 * 60 + 20);
    expect(parseDurationSec('120:00:00')).toBe(120 * 3600);
  });
});

describe('formatSeconds', () => {
  it('秒 → "mm:ss"', () => {
    expect(formatSeconds(0)).toBe('00:00');
    expect(formatSeconds(65)).toBe('01:05');
    expect(formatSeconds(754)).toBe('12:34');
    expect(formatSeconds(3599)).toBe('59:59');
  });

  it('≥1 小时 → "h:mm:ss"', () => {
    expect(formatSeconds(3600)).toBe('1:00:00');
    expect(formatSeconds(3754)).toBe('1:02:34');
    expect(formatSeconds(9786)).toBe('2:43:06');
  });

  it('小数向下取整', () => {
    expect(formatSeconds(65.9)).toBe('01:05');
    expect(formatSeconds(59.2)).toBe('00:59');
  });

  it('无效输入返回空串', () => {
    expect(formatSeconds(null)).toBe('');
    expect(formatSeconds(undefined)).toBe('');
    expect(formatSeconds(Number.NaN)).toBe('');
    expect(formatSeconds(Number.POSITIVE_INFINITY)).toBe('');
    expect(formatSeconds(-1)).toBe('');
  });
});
