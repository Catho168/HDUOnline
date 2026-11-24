/**
 * 回收站批量结果反馈防回归（第 221 轮巡检）。
 *
 * 背景：showBatchResult 的「附操作时间」包装（第 218 轮）曾被误写成递归调用自身，
 * 运行时 RangeError 导致所有成功反馈损坏、后续 loadTrash 不执行（回收站 e2e 失败根因）。
 * 该写法 TypeScript 编译期合法（const 函数值内引用自身类型正确），只能靠测试锁死。
 * 这里以源码静态断言：定义体内必须调用 setBatchResult，不得递归调用 showBatchResult 自身。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../../src/entrypoints/content/ui/learning/LibraryView.tsx', import.meta.url),
  'utf8',
);

describe('showBatchResult 防回归（第 221 轮）', () => {
  it('定义体内调用 setBatchResult，不递归调用自身', () => {
    const start = source.indexOf('const showBatchResult = useCallback(');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('}, []);', start);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    expect(body).toContain('setBatchResult(');
    expect(body).not.toContain('showBatchResult(');
  });

  it('showBatchResult 存在真实调用点（结果反馈链路仍在使用）', () => {
    const matches = source.match(/showBatchResult\(/g) ?? [];
    // 定义行 + 若干调用点（还原/清空/批量成功等反馈），至少 3 处
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });
});
