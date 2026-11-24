/**
 * 复习完成记录导出单测（第 110 轮巡检）：buildReviewDoneMarkdown——
 * 按完成时间降序、脏行跳过、缺字段兜底。
 */
import { describe, expect, it } from 'vitest';
import { buildReviewDoneMarkdown } from '@/core/export/reviewDone';

describe('buildReviewDoneMarkdown（复习完成记录导出，第 110 轮）', () => {
  it('按完成时间降序；轮次/到期/完成时间齐全', () => {
    const md = buildReviewDoneMarkdown(
      [
        { title: '特征值复习', round: 2, dueDate: '2026-11-17', updatedAt: 1000 },
        { title: '矩阵乘法复习', round: 1, dueDate: '2026-11-18', updatedAt: 2000 },
      ],
      '复习计划',
    );
    expect(md).toContain('# 复习完成记录 · 复习计划');
    expect(md).toContain('- 完成轮次：2');
    expect(md.indexOf('矩阵乘法复习')).toBeLessThan(md.indexOf('特征值复习'));
    expect(md).toContain('（第 2 轮 · 到期 2026-11-17 · 完成于 ');
  });

  it('脏行兜底：缺标题给占位、缺时间不展示对应片段、null 输入返回骨架', () => {
    const md = buildReviewDoneMarkdown(
      [{ title: '', round: NaN, dueDate: '', updatedAt: NaN }, { title: '有效行', round: 1, dueDate: '2026-11-18', updatedAt: 5 }],
      't',
    );
    expect(md).toContain('- 有效行（第 1 轮 · 到期 2026-11-18 · 完成于 ');
    expect(md).toContain('- （收藏已删除）');
    expect(buildReviewDoneMarkdown(null, 't')).toContain('- 完成轮次：0');
  });
});
