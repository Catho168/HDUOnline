/**
 * 周报 / 月报导出文件名 buildPeriodReportFilename（core/stats/periodExport.ts，
 * 第 239 轮巡检）单测。
 *
 * 覆盖：
 *  1. 周报 / 月报两种命名（数据窗口而非生成日：开始日全键 _ 结束日月日 / 开始月 _ 结束日月日）；
 *  2. 多桶报告（近 8 周 / 近 6 月）跨窗文件名；
 *  3. 文件名安全字符替换（Windows 保留字符 / 控制符 → '-'）；
 *  4. 非法日期降级（非 'YYYY-MM-DD' 键形原串安全化直出，不猜日期、不抛错）。
 */
import { describe, expect, it } from 'vitest';

import { buildPeriodReportFilename } from '@/core/stats/periodExport';

describe('buildPeriodReportFilename 导出文件名（第 239 轮巡检）', () => {
  it('周报：HDUOnline周报_<开始日全键>_<结束日月日>.md', () => {
    expect(buildPeriodReportFilename('week', '2026-11-16', '2026-11-22')).toBe('HDUOnline周报_2026-11-16_11-22.md');
  });

  it('月报：HDUOnline月报_<开始月 YYYY-MM>_<结束日月日>.md', () => {
    expect(buildPeriodReportFilename('month', '2026-11-01', '2026-11-30')).toBe('HDUOnline月报_2026-11_11-30.md');
  });

  it('多桶报告（近 8 周 / 近 6 月）取首桶开始日 → 末桶结束日跨窗', () => {
    expect(buildPeriodReportFilename('week', '2026-09-28', '2026-11-22')).toBe('HDUOnline周报_2026-09-28_11-22.md');
    expect(buildPeriodReportFilename('month', '2026-06-01', '2026-11-30')).toBe('HDUOnline月报_2026-06_11-30.md');
  });

  it('非法字符替换：路径分隔符 / Windows 保留字符 / 控制符 → "-"，不产生层级跳转或非法文件', () => {
    expect(buildPeriodReportFilename('week', '2026/11/16', '2026-11-22')).toBe('HDUOnline周报_2026-11-16_11-22.md'); // '/' 替换后恰为合法日键形
    expect(buildPeriodReportFilename('week', '2026-11-16', '2026*11?22')).toBe('HDUOnline周报_2026-11-16_11-22.md'); // '*' '?' 替换后恰为合法日键形
    expect(buildPeriodReportFilename('month', 'a<b>c|d', 'x"y:z\\w')).toBe('HDUOnline月报_a-b-c-d_x-y-z-w.md');
    expect(buildPeriodReportFilename('week', '2026-11-16\u0000\u001f', '2026-11-22')).toBe('HDUOnline周报_2026-11-16--_11-22.md');
  });

  it('非 YYYY-MM-DD 键形降级：原串安全化直出（不猜日期、不 slice 出错位），空串也不抛错', () => {
    expect(buildPeriodReportFilename('week', 'bad', 'worse')).toBe('HDUOnline周报_bad_worse.md');
    expect(buildPeriodReportFilename('month', 'bad', '2026-11-30')).toBe('HDUOnline月报_bad_11-30.md');
    expect(buildPeriodReportFilename('week', '', '2026-11-22')).toBe('HDUOnline周报__11-22.md');
  });

  it('kind 非 month 一律按周报（防御）；首尾空白去除', () => {
    expect(buildPeriodReportFilename('year' as never, '2026-11-16', '2026-11-22')).toBe('HDUOnline周报_2026-11-16_11-22.md');
    expect(buildPeriodReportFilename('week', ' 2026-11-16 ', '2026-11-22')).toBe('HDUOnline周报_2026-11-16_11-22.md');
  });
});
