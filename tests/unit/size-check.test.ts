/**
 * 产物体积预算检查纯函数测试（第 246 轮巡检，工程域 / 性能视角）。
 *
 * 覆盖 scripts/size-check.mjs 导出的纯函数（脚本为可独立运行的 .mjs，类型声明
 * scripts/size-check.d.mts 供本测试类型安全导入）：
 *  1. parseChunkRefs：静态 from / 副作用 import 归急加载（eager）、动态 import(…)
 *     归懒加载（dynamic）、去重与无引用防御；
 *  2. compareSizes：增长超阈值（绝对 20KB 或相对 5% 取大者）/ 新入口 / 收缩仅提示 /
 *     非法基线值防御 / 自定义阈值；
 *  3. formatBytes：KB / MB / 非法值。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOL_ABS,
  DEFAULT_TOL_PCT,
  compareSizes,
  formatBytes,
  parseChunkRefs,
} from '../../scripts/size-check.mjs';

describe('parseChunkRefs（产物 import 引用解析）', () => {
  it('静态 from 与副作用 import 归 eager，动态 import(…) 归 dynamic', () => {
    const refs = parseChunkRefs(
      `import"./chunks/a.js";import{b}from"./chunks/b.js";const c=await import("./chunks/c.js");import("./chunks/d.js").then(f)`,
    );
    expect(refs.eager.sort()).toEqual(['./chunks/a.js', './chunks/b.js']);
    expect(refs.dynamic.sort()).toEqual(['./chunks/c.js', './chunks/d.js']);
  });

  it('同一 chunk 重复引用去重；无引用返回空数组不抛错', () => {
    const refs = parseChunkRefs(`import"./chunks/a.js";import"./chunks/a.js"`);
    expect(refs.eager).toEqual(['./chunks/a.js']);
    expect(refs.dynamic).toEqual([]);
    expect(parseChunkRefs('')).toEqual({ eager: [], dynamic: [] });
    expect(parseChunkRefs('plain text without imports')).toEqual({ eager: [], dynamic: [] });
  });

  it('不把裸标识符 import 语句误判为 chunk 引用（require 相对路径 / 非相对目标跳过）', () => {
    const refs = parseChunkRefs(`import{createStore}from"store-lib";import local from"./relative.js"`);
    expect(refs.eager).toEqual(['./relative.js']);
  });
});

describe('compareSizes（基线比较与阈值）', () => {
  it('增长在阈值内不报；超过 max(20KB, 5%) 报 growth', () => {
    // 679KB 入口：5% ≈ 34KB > 20KB → 阈值 34KB
    expect(compareSizes({ 'content.js': 679 * 1024 + 20 * 1024 }, { 'content.js': 679 * 1024 })).toEqual([]);
    const growth = compareSizes({ 'content.js': 679 * 1024 + 40 * 1024 }, { 'content.js': 679 * 1024 });
    expect(growth).toHaveLength(1);
    expect(growth[0]!.kind).toBe('growth');
    expect(growth[0]!.deltaPct).toBeCloseTo((40 / 679) * 100, 5);
  });

  it('小基线用绝对阈值兜底：1KB 基线 +30KB 也报 growth（5% 远小于 20KB）', () => {
    const growth = compareSizes({ 'tiny.js': 1024 + 30 * 1024 }, { 'tiny.js': 1024 });
    expect(growth).toHaveLength(1);
    expect(growth[0]!.kind).toBe('growth');
    expect(growth[0]!.delta).toBe(30 * 1024);
  });

  it('基线缺失且 ≥1KB 报 new；<1KB 忽略', () => {
    expect(compareSizes({ 'new-entry.js': 50 * 1024 }, {})).toHaveLength(1);
    expect(compareSizes({ 'new-entry.js': 50 * 1024 }, {})[0]!.kind).toBe('new');
    expect(compareSizes({ 'tiny.js': 512 }, {})).toEqual([]);
  });

  it('收缩只报 shrink（不计警告）；非法基线值（NaN/字符串）按缺失处理', () => {
    const shrink = compareSizes({ a: 500 * 1024 }, { a: 600 * 1024 });
    expect(shrink).toHaveLength(1);
    expect(shrink[0]!.kind).toBe('shrink');
    expect(shrink[0]!.delta).toBe(-100 * 1024);
    expect(compareSizes({ a: 600 * 1024 }, { a: Number.NaN })).toEqual([{ entry: 'a', kind: 'new', baseline: null, current: 600 * 1024, delta: 600 * 1024, deltaPct: null }]);
    expect(compareSizes({ a: 600 * 1024 }, { a: 'x' as unknown as number })[0]!.kind).toBe('new');
  });

  it('自定义阈值生效（--tol-pct / --tol-abs 传参口径）', () => {
    expect(compareSizes({ a: 100 * 1024 + 10 * 1024 }, { a: 100 * 1024 }, 20, DEFAULT_TOL_ABS)).toEqual([]);
    expect(compareSizes({ a: 100 * 1024 + 10 * 1024 }, { a: 100 * 1024 }, DEFAULT_TOL_PCT, 50 * 1024)).toEqual([]);
    const over = compareSizes({ a: 100 * 1024 + 30 * 1024 }, { a: 100 * 1024 }, DEFAULT_TOL_PCT, 20 * 1024);
    expect(over[0]!.kind).toBe('growth');
  });

  it('默认阈值常量：tolPct=5 / tolAbs=20KB', () => {
    expect(DEFAULT_TOL_PCT).toBe(5);
    expect(DEFAULT_TOL_ABS).toBe(20 * 1024);
  });
});

describe('formatBytes（人类可读体积）', () => {
  it('KB 一位小数；≥1MB 两位小数；非法值问号', () => {
    expect(formatBytes(0)).toBe('0.0 KB');
    expect(formatBytes(679023)).toBe('663.1 KB');
    expect(formatBytes(28312028)).toBe('27.00 MB');
    expect(formatBytes(Number.NaN)).toBe('?');
    expect(formatBytes(-1)).toBe('?');
  });
});
