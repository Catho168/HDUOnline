/**
 * 里程碑分享文案 buildMilestoneShareText（core/stats/milestones.ts，第 236 轮巡检；
 * 第 238 轮排版美化：标题 🏆 + 标题/明细空行分组）单测。
 *
 * 覆盖：
 *  1. 正常列表：标题行「🏆 学习里程碑（共 X 个）」+ 空行分组 + 逐行「YYYY-MM-DD 标题 · detail」；
 *  2. 空列表 / 全无效行 → 空串（UI 据此不显示复制按钮）；
 *  3. total 与 limit 的文案：截断时「共 X 个，展示最近 N 个」，未截断时不附尾巴；
 *  4. 长 detail / 换行脏数据：换行折为空格，保持「一行一条」排版；
 *  5. 脏数据防御：非对象行 / 非法日键 / 空 title 跳过；total 非有限或 < 行数按行数兜底；
 *  6. 第 238 轮排版快照：整段字符串断言（标题 emoji 仅标题行 + 段间空行 + 行集不变）。
 */
import { describe, expect, it } from 'vitest';

import { buildMilestoneShareText, deriveMilestones, type StudyMilestone } from '@/core/stats/milestones';

/** 手工构造里程碑行（绕过回放，直测序列化口径） */
const M = (date: string, title: string, detail: string): StudyMilestone => ({ date, kind: 'cumulative', title, detail });

describe('buildMilestoneShareText 正常列表（第 236 轮；第 238 轮段落化）', () => {
  it('标题行 + 空行分组 + 逐行「日期 标题 · detail」，行序与输入一致', () => {
    const text = buildMilestoneShareText([
      M('2026-11-02', '首次打卡', '当日有效 10 分钟'),
      M('2026-11-09', '累计学习 1 小时', '当日累计 1 小时 1 分'),
    ]);
    const lines = text.split('\n');
    expect(lines).toEqual([
      '🏆 学习里程碑（共 2 个）',
      '',
      '2026-11-02 首次打卡 · 当日有效 10 分钟',
      '2026-11-09 累计学习 1 小时 · 当日累计 1 小时 1 分',
    ]);
    // 第 238 轮排版：恰好两段（标题 / 明细），段间一个空行
    expect(text.split('\n\n')).toHaveLength(2);
  });

  it('detail 为空省略「 · detail」尾巴', () => {
    const text = buildMilestoneShareText([M('2026-11-02', '首次打卡', '')]);
    expect(text.split('\n')).toEqual(['🏆 学习里程碑（共 1 个）', '', '2026-11-02 首次打卡']);
  });

  it('与 deriveMilestones 输出直连：回放结果可整包序列化', () => {
    const { items, total } = deriveMilestones(
      [
        { date: '2026-11-01', validSec: 7200 },
        { date: '2026-11-02', validSec: 7200 },
        { date: '2026-11-03', validSec: 7200 },
      ],
      { checkinMinSec: 24 * 3600 },
    );
    const text = buildMilestoneShareText(items, total);
    // 11-01 累计 1h + 单日新高；11-03 累计 5h + 连续 3 天新高 → 4 条
    expect(total).toBe(4);
    expect(text).toContain('🏆 学习里程碑（共 4 个）');
    expect(text).toContain('2026-11-01 累计学习 1 小时 · 当日累计 2 小时');
    expect(text).toContain('2026-11-01 单日学习新高 · 单日 2 小时');
    expect(text).toContain('2026-11-03 累计学习 5 小时 · 当日累计 6 小时');
    expect(text).toContain('2026-11-03 连续学习新高 · 连续 3 天');
  });
});

describe('buildMilestoneShareText 空与截断文案（第 236 轮）', () => {
  it('空列表 / 全无效行返回空串', () => {
    expect(buildMilestoneShareText([])).toBe('');
    expect(buildMilestoneShareText([] as unknown as StudyMilestone[], 0)).toBe('');
    expect(buildMilestoneShareText(null as unknown as StudyMilestone[])).toBe('');
    expect(buildMilestoneShareText([M('2026-11-02', '  ', 'x')])).toBe('');
  });

  it('截断时标题附「展示最近 N 个」；未截断不附', () => {
    const rows = [M('2026-11-01', 'A', ''), M('2026-11-02', 'B', ''), M('2026-11-03', 'C', '')];
    // total > items.length：展示截断尾巴
    expect(buildMilestoneShareText(rows, 9).split('\n')[0]).toBe('🏆 学习里程碑（共 9 个，展示最近 3 个）');
    // total === items.length：不附尾巴（与 MilestoneWall foot 两态文案同规则）
    expect(buildMilestoneShareText(rows, 3).split('\n')[0]).toBe('🏆 学习里程碑（共 3 个）');
  });

  it('total 缺省 / 非有限 / 小于行数时按行数兜底（不显示荒谬数）', () => {
    const rows = [M('2026-11-01', 'A', ''), M('2026-11-02', 'B', '')];
    expect(buildMilestoneShareText(rows).split('\n')[0]).toBe('🏆 学习里程碑（共 2 个）');
    expect(buildMilestoneShareText(rows, Number.NaN).split('\n')[0]).toBe('🏆 学习里程碑（共 2 个）');
    expect(buildMilestoneShareText(rows, 1).split('\n')[0]).toBe('🏆 学习里程碑（共 2 个）');
    // 小数 total 取整
    expect(buildMilestoneShareText(rows, 5.7).split('\n')[0]).toBe('🏆 学习里程碑（共 6 个，展示最近 2 个）');
  });
});

describe('buildMilestoneShareText 长 detail 与脏数据防御（第 236 轮）', () => {
  it('长 detail 单行保留；换行折为空格（一行一条不被破坏）', () => {
    const long = '这是一段很长的说明'.repeat(20);
    expect(buildMilestoneShareText([M('2026-11-02', '首次打卡', long)]).split('\n')).toHaveLength(3); // 标题 + 空行 + 行
    const multiline = buildMilestoneShareText([M('2026-11-02', '首次打卡', '连续 5 天\n（含周末）')]);
    expect(multiline.split('\n')).toEqual(['🏆 学习里程碑（共 1 个）', '', '2026-11-02 首次打卡 · 连续 5 天 （含周末）']);
  });

  it('脏行逐条跳过：非对象 / 非法日键（含 2026-02-30 形似键）/ 空 title', () => {
    const text = buildMilestoneShareText([
      null as unknown as StudyMilestone,
      { date: '20261105', title: 'x', detail: '' } as unknown as StudyMilestone,
      { date: '2026-02-30', title: '形似日键', detail: '' } as unknown as StudyMilestone,
      M('2026-11-05', '', 'detail 不救空 title'),
      M('2026-11-05', '累计学习 1 小时', '当日累计 1 小时'),
    ]);
    expect(text.split('\n')).toEqual(['🏆 学习里程碑（共 1 个）', '', '2026-11-05 累计学习 1 小时 · 当日累计 1 小时']);
  });
});

// ───────────────────────── 第 238 轮排版快照 ─────────────────────────

describe('buildMilestoneShareText 第 238 轮排版快照（整段字符串断言）', () => {
  it('快照：标题 🏆 仅标题行 + 空行分组 + 明细行集不变', () => {
    const text = buildMilestoneShareText(
      [
        M('2026-11-01', '首次打卡', '当日有效 10 分钟'),
        M('2026-11-03', '累计学习 5 小时', '当日累计 5 小时'),
        M('2026-11-03', '连续学习新高', '连续 3 天'),
      ],
      9,
    );
    expect(text).toBe(
      '🏆 学习里程碑（共 9 个，展示最近 3 个）\n' +
        '\n' +
        '2026-11-01 首次打卡 · 当日有效 10 分钟\n' +
        '2026-11-03 累计学习 5 小时 · 当日累计 5 小时\n' +
        '2026-11-03 连续学习新高 · 连续 3 天',
    );
  });
});
