/**
 * 导入文件体积前置校验测试（第 251 轮巡检，数据自主权域 / 导入可行性评估的最小防呆）。
 *
 * 评估结论（docs/数据导入可行性评估.md §5）：结构校验与事务回滚已在 import.run 侧
 * 闭环，唯「读文件」发生在 UI 侧（file.text() / arrayBuffer() 整文件进内存）——
 * 超大文件会在 JSON.parse 前卡死页面。本测试锁定 UI 前置 guard 的纯函数口径：
 *  1. 未超限（≤512MB）→ null（放行，后续走 staging + import.run 既有校验链）；
 *  2. 超限 → 用户可见 toast 文案（与「文件不匹配 / 格式损坏」错误 toast 家族同句式）；
 *  3. 脏入参（非数值 / 负数 / NaN）→ null（不拦正常流，防御性放行）。
 */

import { describe, expect, it } from 'vitest';
import { importFileSizeGuardText, MAX_IMPORT_FILE_BYTES } from '@/entrypoints/dashboard/App';

describe('导入文件体积前置校验（第 251 轮巡检）', () => {
  it('未超限（含恰好 512MB）→ null 放行', () => {
    expect(importFileSizeGuardText(0)).toBeNull();
    expect(importFileSizeGuardText(1024)).toBeNull();
    expect(importFileSizeGuardText(MAX_IMPORT_FILE_BYTES)).toBeNull();
    expect(importFileSizeGuardText(100 * 1024 * 1024)).toBeNull();
  });

  it('超限 → 明确拒绝文案（含 512MB 口径与「现有数据未受影响」）', () => {
    const text = importFileSizeGuardText(MAX_IMPORT_FILE_BYTES + 1);
    expect(text).toBe('文件超过 512MB，已拒绝导入（现有数据未受影响）');
    expect(importFileSizeGuardText(1024 * 1024 * 1024)).toBe(text);
  });

  it('脏入参放行（不拦正常流）：非数值 / 负数 / NaN', () => {
    expect(importFileSizeGuardText(undefined)).toBeNull();
    expect(importFileSizeGuardText(Number.NaN)).toBeNull();
    expect(importFileSizeGuardText(-1)).toBeNull();
    expect(importFileSizeGuardText('1024' as unknown as number)).toBeNull();
  });

  it('常量口径：512MB（只拦误选文件不拦合法备份）', () => {
    expect(MAX_IMPORT_FILE_BYTES).toBe(512 * 1024 * 1024);
  });
});
