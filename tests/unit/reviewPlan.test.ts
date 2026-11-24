/**
 * 复习计划整页导出单测（第 124 轮巡检）：buildReviewPlanMarkdown——三分区排序、
 * 筛选说明、模板标注、脏数据防御与空分区。
 */
import { describe, expect, it } from 'vitest';
import { buildReviewPlanMarkdown } from '@/core/export/reviewPlan';

describe('buildReviewPlanMarkdown（复习计划整页导出，第 124 轮）', () => {
  it('三分区齐全：待完成按到期日升序、已完成按完成时间降序、已跳过按到期日升序', () => {
    const md = buildReviewPlanMarkdown({
      pending: [
        { title: 'B', round: 1, dueDate: '2026-11-21', template: 'exam' },
        { title: 'A', round: 1, dueDate: '2026-11-20', template: 'regular', tags: ['e2e', '复习'] },
      ],
      done: [
        { title: 'D1', round: 2, dueDate: '2026-11-18', updatedAt: 1000 },
        { title: 'D2', round: 2, dueDate: '2026-11-17', updatedAt: 2000 },
      ],
      skipped: [{ title: 'S1', round: 1, dueDate: '2026-11-19' }],
      title: '复习计划',
      filtersNote: '类型=全部 · 关键词=无',
    });
    expect(md).toContain('# 复习计划 · 复习计划');
    expect(md).toContain('- 待完成 2 · 已完成 2 · 已跳过 1');
    expect(md).toContain('- 完成率：40%（2/5）');
    expect(md).toContain('- 筛选：类型=全部 · 关键词=无');
    const pendingIdx = md.indexOf('## 待完成');
    expect(pendingIdx).toBeGreaterThan(-1);
    expect(md.indexOf('- A（')).toBeGreaterThan(pendingIdx);
    expect(md.indexOf('- B（')).toBeGreaterThan(md.indexOf('- A（'));
    expect(md.indexOf('- D2（')).toBeLessThan(md.indexOf('- D1（'));
    expect(md).toContain('考试');
    expect(md).toContain('常规');
    expect(md).toContain('标签：e2e、复习');
    expect(md).toContain('完成于');
    expect(md.indexOf('## 已完成')).toBeGreaterThan(md.indexOf('- B（'));
    expect(md.indexOf('## 已跳过')).toBeGreaterThan(md.indexOf('## 已完成'));
  });

  it('脏数据防御与空分区「（无）」占位', () => {
    const md = buildReviewPlanMarkdown({
      pending: [null as never, { title: 42, round: 'x', dueDate: 7 }],
      done: null,
      skipped: undefined,
    });
    expect(md).toContain('- 待完成 1 · 已完成 0 · 已跳过 0');
    expect(md).toContain('- 完成率：0%（0/1）');
    expect(md).toContain('（收藏已删除）');
    expect(md).toContain('## 已完成（0，按完成时间降序）');
    expect(md).toContain('（无）');
  });

  it('null / undefined 输入不抛错，标题缺省「复习计划」', () => {
    expect(() => buildReviewPlanMarkdown(null)).not.toThrow();
    expect(buildReviewPlanMarkdown(undefined)).toContain('# 复习计划 · 复习计划');
  });
});

describe('buildReviewPlanMarkdown 按课程分组（第 137 轮）', () => {
  it('任一行带课程名时分组呈现，未分课程殿后；组内保持到期日升序', () => {
    const md = buildReviewPlanMarkdown({
      pending: [
        { title: 'B', round: 1, dueDate: '2026-11-21', course: '线性代数' },
        { title: 'A', round: 1, dueDate: '2026-11-20' },
        { title: 'C', round: 1, dueDate: '2026-11-19', course: '高等数学' },
      ],
    });
    expect(md).toContain('### 高等数学（1）');
    expect(md).toContain('### 线性代数（1）');
    expect(md).toContain('### 未分课程（1）');
    expect(md.indexOf('### 高等数学')).toBeLessThan(md.indexOf('### 线性代数'));
    expect(md.indexOf('### 线性代数')).toBeLessThan(md.indexOf('### 未分课程'));
    expect(md).toContain('- C（第 1 轮 · 到期 2026-11-19）');
  });

  it('全部行无课程名时保持平铺（不出现分组标题）', () => {
    const md = buildReviewPlanMarkdown({ pending: [{ title: 'A', round: 1, dueDate: '2026-11-20' }] });
    expect(md).not.toContain('### ');
    expect(md).toContain('- A（第 1 轮 · 到期 2026-11-20）');
  });
});
