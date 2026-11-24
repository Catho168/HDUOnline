/**
 * 收藏卡「复习状态徽标」（core/plan/reviewBadge.ts，第 244 轮巡检）纯函数单测。
 * 选型 B（仅当前状态）：pending 作业按到期日分色（逾期 danger / 今日 jade /
 * 未来 accent），无作业 = 未入计划（default），done/skipped = null（卡片由
 * 既有「上次复习」chip 承接）。覆盖：
 *  - 逾期 / 今日 / 未来三态的 tone、label、title（含逾期天数与剩余天数）；
 *  - 无状态（null / undefined / 非对象）→ 未入计划；
 *  - done / skipped → null；脏 dueDate → null；
 *  - 跨月 / 跨年自然日差（还有 N 天计算）。
 */

import { describe, expect, it } from 'vitest';
import { reviewBadgeForJob } from '@/core/plan/reviewBadge';

const TODAY = '2026-11-21'; // 周六

describe('reviewBadgeForJob：pending 三态分色', () => {
  it('逾期（dueDate < today）→ danger「复习中 · 已逾期」，title 带到期日与逾期天数', () => {
    const badge = reviewBadgeForJob({ status: 'pending', dueDate: '2026-11-18' }, TODAY);
    expect(badge).not.toBeNull();
    expect(badge!.tone).toBe('danger');
    expect(badge!.label).toBe('复习中 · 已逾期');
    expect(badge!.title).toContain('11月18日');
    expect(badge!.title).toContain('已逾期 3 天');
  });

  it('今日到期（dueDate === today）→ jade「复习中 · 今日到期」', () => {
    const badge = reviewBadgeForJob({ status: 'pending', dueDate: TODAY }, TODAY);
    expect(badge!.tone).toBe('jade');
    expect(badge!.label).toBe('复习中 · 今日到期');
  });

  it('未来（dueDate > today）→ accent「复习中 · M月D日到期」，title 带周几与剩余天数', () => {
    const badge = reviewBadgeForJob({ status: 'pending', dueDate: '2026-11-25' }, TODAY);
    expect(badge!.tone).toBe('accent');
    expect(badge!.label).toBe('复习中 · 11月25日到期');
    expect(badge!.title).toContain('11月25日（周');
    expect(badge!.title).toContain('还有 4 天');
  });

  it('跨月 / 跨年自然日差：11-28 → 12-01 还有 3 天；12-31 → 2027-01-02 还有 2 天', () => {
    const crossMonth = reviewBadgeForJob({ status: 'pending', dueDate: '2026-12-01' }, '2026-11-28');
    expect(crossMonth!.title).toContain('还有 3 天');
    const crossYear = reviewBadgeForJob({ status: 'pending', dueDate: '2027-01-02' }, '2026-12-31');
    expect(crossYear!.title).toContain('还有 2 天');
  });
});

describe('reviewBadgeForJob：无状态 / 非待完成', () => {
  it('null / undefined / 非对象 → 未入计划（default 中性）', () => {
    for (const input of [null, undefined, 'pending', 42]) {
      const badge = reviewBadgeForJob(input as never, TODAY);
      expect(badge).toMatchObject({ tone: 'default', label: '未入计划' });
      expect(badge!.title).toContain('加入复习');
    }
  });

  it('done / skipped → null（卡片由「上次复习」chip 承接，不叠加标注）', () => {
    expect(reviewBadgeForJob({ status: 'done', dueDate: '2026-11-20' }, TODAY)).toBeNull();
    expect(reviewBadgeForJob({ status: 'skipped', dueDate: '2026-11-20' }, TODAY)).toBeNull();
  });

  it('脏 dueDate（缺省 / 非法格式）→ null（与预测跳过脏数据同口径）', () => {
    expect(reviewBadgeForJob({ status: 'pending' }, TODAY)).toBeNull();
    expect(reviewBadgeForJob({ status: 'pending', dueDate: '2026/11/25' }, TODAY)).toBeNull();
    expect(reviewBadgeForJob({ status: 'pending', dueDate: 20261125 }, TODAY)).toBeNull();
  });
});
