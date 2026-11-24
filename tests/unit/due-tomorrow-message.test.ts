/**
 * 明日到期提醒文案纯函数单测（core/plan/notify.ts buildDueTomorrowMessage，第 243 轮巡检）：
 *  - 0 项 → null（不发通知）；
 *  - 1–2 项：明细全列（「课程 · 作业名」或仅作业名）；
 *  - >2 项：前 2 个 + 「等 N 项」收尾；
 *  - 课程名/作业名超长截断（DUE_TOMORROW_LABEL_MAX）；
 *  - 脏数据防御：非数组 / 非对象成员 / 空白字段回退兜底，不抛错；
 *  - dueTomorrowNotificationId：按本地日键去重（同一天覆盖同一条）。
 */

import { describe, expect, it } from 'vitest';
import {
  buildDueTomorrowMessage,
  DUE_TOMORROW_LABEL_MAX,
  dueTomorrowNotificationId,
  type DueTomorrowJobInput,
} from '@/core/plan/notify';

describe('buildDueTomorrowMessage（明日到期提醒文案，第 243 轮）', () => {
  it('0 项（含 null / undefined / 非数组）→ null，不发通知', () => {
    expect(buildDueTomorrowMessage([])).toBeNull();
    expect(buildDueTomorrowMessage(null)).toBeNull();
    expect(buildDueTomorrowMessage(undefined)).toBeNull();
    expect(buildDueTomorrowMessage('nope' as unknown as DueTomorrowJobInput[])).toBeNull();
  });

  it('1 项：主行 + 明细行（仅作业名，无课程段）', () => {
    const out = buildDueTomorrowMessage([{ title: '线性代数 3.1 矩阵乘法' }]);
    expect(out?.title).toBe('明日复习到期');
    expect(out?.message).toBe('明日有 1 项复习到期\n线性代数 3.1 矩阵乘法');
  });

  it('2 项：明细全列，课程名在前（「课程 · 作业名」）', () => {
    const out = buildDueTomorrowMessage([
      { title: '第 3 讲 极限', course: '高等数学' },
      { title: '第 4 讲 导数', course: '高等数学' },
    ]);
    expect(out?.message).toBe('明日有 2 项复习到期\n高等数学 · 第 3 讲 极限、高等数学 · 第 4 讲 导数');
  });

  it('多项（>2）：只点前 2 个，尾部「等 N 项」', () => {
    const out = buildDueTomorrowMessage([
      { title: '作业 A', course: '课程一' },
      { title: '作业 B', course: '课程二' },
      { title: '作业 C', course: '课程三' },
      { title: '作业 D' },
    ]);
    expect(out?.message).toBe('明日有 4 项复习到期\n课程一 · 作业 A、课程二 · 作业 B 等 4 项');
    expect(out?.message).not.toContain('作业 C');
    expect(out?.message).not.toContain('作业 D');
  });

  it('超长截断：单条明细超上限加省略号（含课程段整体计长）', () => {
    const longTitle = '这是一个特别特别长的作业标题远远超过截断上限的例子';
    const out = buildDueTomorrowMessage([{ title: longTitle }]);
    const detail = out?.message.split('\n')[1] ?? '';
    expect(detail.length).toBeLessThanOrEqual(DUE_TOMORROW_LABEL_MAX);
    expect(detail.endsWith('…')).toBe(true);
    // 恰好等于上限不截断；课程段与作业名整体计长
    const exact = buildDueTomorrowMessage([{ title: '一二三四五六七八九十一二三四五六七八' }]);
    expect(exact?.message.split('\n')[1]).toBe('一二三四五六七八九十一二三四五六七八');
    const withCourse = buildDueTomorrowMessage([{ title: '第 3 讲 极限与连续', course: '高等数学' }]);
    expect(withCourse?.message.split('\n')[1]).toBe('高等数学 · 第 3 讲 极限与连续');
  });

  it('脏数据防御：非对象成员跳过；空白标题回退「未命名收藏」；空白课程省略课程段', () => {
    const out = buildDueTomorrowMessage([
      null as unknown as DueTomorrowJobInput,
      { title: '   ', course: '  ' },
    ]);
    // 非对象成员被过滤后剩 1 项 → 计数 1、兜底标题
    expect(out?.message).toBe('明日有 1 项复习到期\n未命名收藏');
    const dirtyCourse = buildDueTomorrowMessage([{ title: '作业 A', course: 42 as unknown as string }]);
    expect(dirtyCourse?.message).toBe('明日有 1 项复习到期\n作业 A');
  });

  it('dueTomorrowNotificationId：本地日键前缀，同一天同 id（覆盖不叠加）', () => {
    expect(dueTomorrowNotificationId('2026-11-22')).toBe('hdu-alarm-due-tomorrow-2026-11-22');
    expect(dueTomorrowNotificationId('2026-11-22')).toBe(dueTomorrowNotificationId('2026-11-22'));
    expect(dueTomorrowNotificationId('2026-11-22')).not.toBe(dueTomorrowNotificationId('2026-11-23'));
  });
});
