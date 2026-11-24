/** mediaRef 单测：两种键格式、解析失败契约与 roundtrip（B 站转写专项设计 §2）。 */

import { describe, expect, it } from 'vitest';
import { biliMediaKey, hduCourIdOf, hduMediaKey, parseMediaKey } from '@/core/shared/mediaRef';

describe('mediaRef 键格式', () => {
  it('hduMediaKey / biliMediaKey 产出约定前缀的字符串键', () => {
    expect(hduMediaKey(1227038)).toBe('hdu:1227038');
    expect(biliMediaKey('BV1xx411c7mD')).toBe('bili:BV1xx411c7mD');
  });

  it('roundtrip：构造出的键可无损解析回原值', () => {
    expect(parseMediaKey(hduMediaKey(1227038))).toEqual({ kind: 'hdu', courId: 1227038 });
    expect(parseMediaKey(biliMediaKey('BV1xx411c7mD'))).toEqual({ kind: 'bili', bvid: 'BV1xx411c7mD' });
    // bvid 含连字符/数字混合也在 bvid 段内原样保留
    expect(parseMediaKey(biliMediaKey('BV1hZ421t7'))).toEqual({ kind: 'bili', bvid: 'BV1hZ421t7' });
  });

  it('解析失败契约：非法输入一律返回 null', () => {
    // 空串 / 未知前缀
    expect(parseMediaKey('')).toBeNull();
    expect(parseMediaKey('unknown:1')).toBeNull();
    expect(parseMediaKey('1227038')).toBeNull();
    // hdu 段缺失或非数值（Number('') === 0 不能误判为合法键）
    expect(parseMediaKey('hdu:')).toBeNull();
    expect(parseMediaKey('hdu:abc')).toBeNull();
    expect(parseMediaKey('hdu:12x')).toBeNull();
    // bili 段为空或再含 ':'（前缀只取第一个 ':'）
    expect(parseMediaKey('bili:')).toBeNull();
    expect(parseMediaKey('bili:a:b')).toBeNull();
    // 非字符串输入（防御）
    expect(parseMediaKey(undefined as unknown as string)).toBeNull();
    expect(parseMediaKey(null as unknown as string)).toBeNull();
    expect(parseMediaKey(1227038 as unknown as string)).toBeNull();
  });

  it('边界数值：courId 0 合法；数字按十进制宽松解析（前导零归一为 1）', () => {
    expect(parseMediaKey('hdu:0')).toEqual({ kind: 'hdu', courId: 0 });
    expect(parseMediaKey('hdu:01')).toEqual({ kind: 'hdu', courId: 1 });
  });

  it('hduCourIdOf：HDU 键反解出 courId；非 HDU 键返回 undefined', () => {
    expect(hduCourIdOf('hdu:1227038')).toBe(1227038);
    expect(hduCourIdOf('bili:BV1xx411c7mD')).toBeUndefined();
    expect(hduCourIdOf('garbage')).toBeUndefined();
  });
});

describe('mediaRef 多 P 键（第 16 轮，P1 裸键向后兼容）', () => {
  it('构造：P1/缺省/非法 p 都是裸键；p≥2 整数才落分 P 键', () => {
    expect(biliMediaKey('BV1xx411c7mD', 1)).toBe('bili:BV1xx411c7mD');
    expect(biliMediaKey('BV1xx411c7mD', undefined)).toBe('bili:BV1xx411c7mD');
    expect(biliMediaKey('BV1xx411c7mD', 2)).toBe('bili:BV1xx411c7mD:p2');
    expect(biliMediaKey('BV1xx411c7mD', 12)).toBe('bili:BV1xx411c7mD:p12');
    // 非法 p（0 / 负数 / 小数 / NaN）一律回退裸键（与 op 层按 1 兜底同口径）
    expect(biliMediaKey('BV1xx411c7mD', 0)).toBe('bili:BV1xx411c7mD');
    expect(biliMediaKey('BV1xx411c7mD', -2)).toBe('bili:BV1xx411c7mD');
    expect(biliMediaKey('BV1xx411c7mD', 1.5)).toBe('bili:BV1xx411c7mD');
    expect(biliMediaKey('BV1xx411c7mD', Number.NaN)).toBe('bili:BV1xx411c7mD');
  });

  it('解析：p≥2 分 P 键反解出 bvid + p；裸键不带 p 字段（旧记录兼容）', () => {
    expect(parseMediaKey('bili:BV1xx411c7mD:p2')).toEqual({ kind: 'bili', bvid: 'BV1xx411c7mD', p: 2 });
    expect(parseMediaKey('bili:BV1xx411c7mD:p12')).toEqual({ kind: 'bili', bvid: 'BV1xx411c7mD', p: 12 });
    // 既有裸键（第 15 轮落库记录）解析结果保持原形状：无 p 字段
    expect(parseMediaKey('bili:BV1xx411c7mD')).toEqual({ kind: 'bili', bvid: 'BV1xx411c7mD' });
    // bvid 本体含 p 字样但无冒号：不是分 P 后缀
    expect(parseMediaKey('bili:BV1p2x')).toEqual({ kind: 'bili', bvid: 'BV1p2x' });
  });

  it('roundtrip：分 P 键构造 → 解析无损还原', () => {
    for (const p of [2, 3, 100]) {
      expect(parseMediaKey(biliMediaKey('BV1hZ421t7', p))).toEqual({ kind: 'bili', bvid: 'BV1hZ421t7', p });
    }
    // P1 roundtrip 仍是裸键形状
    expect(parseMediaKey(biliMediaKey('BV1hZ421t7', 1))).toEqual({ kind: 'bili', bvid: 'BV1hZ421t7' });
  });

  it('非法后缀整体返回 null（不做静默降级）', () => {
    // P1 是裸键，biliMediaKey 永不产出 :p1——显式 :p1 不是合法键
    expect(parseMediaKey('bili:BV1xx411c7mD:p1')).toBeNull();
    expect(parseMediaKey('bili:BV1xx411c7mD:p0')).toBeNull();
    // 非数字后缀 / 空壳后缀
    expect(parseMediaKey('bili:BV1xx411c7mD:px')).toBeNull();
    expect(parseMediaKey('bili::p2')).toBeNull();
    // 多重后缀：反解出的 bvid 本体仍含 ':' → 非法
    expect(parseMediaKey('bili:BV1xx411c7mD:p2:p3')).toBeNull();
    // 旧契约保留：非 :p<N> 形状的冒号段仍是非法键
    expect(parseMediaKey('bili:a:b')).toBeNull();
    expect(parseMediaKey('bili:BV1xx411c7mD:q2')).toBeNull();
  });

  it('前缀边界：裸键是分 P 键的前缀，但相邻 bvid 的键不因前缀误判（前缀匹配须带 :p 边界）', () => {
    // 'bili:BV1abc' 是 'bili:BV1abcd' 的字符串前缀——消费方（徽标匹配）必须以
    // `bili:<bvid>:p` 为前缀边界，这里只验证解析层把两种键都各自还原为正确 bvid
    expect(parseMediaKey('bili:BV1abc:p2')).toEqual({ kind: 'bili', bvid: 'BV1abc', p: 2 });
    expect(parseMediaKey('bili:BV1abcd:p2')).toEqual({ kind: 'bili', bvid: 'BV1abcd', p: 2 });
  });
});
