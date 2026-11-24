/**
 * 笔记统计聚合纯函数单测（第 240 轮巡检，buildNoteStats）：
 * 口径锁定——
 *  - 总数 = 实时存活笔记（deletedAt 为空，与成就徽章「笔记勤耕」同源 note.listAll）；
 *  - 近 7 天新增 = createdAt ∈ (now - 7 天, now]（含 now 端点、不含 7 天前端点、
 *    未来时间戳防时钟漂移不计入）；「新增」按创建时间而非 updatedAt；
 *  - 课程 Top3 = 站内课程笔记按条数降序、并列按课程名 zh-Hans-CN 字典序取序，
 *    B 站外部笔记（无 courId）计入总数/新增但不进课程行。
 */
import { describe, expect, it } from 'vitest';
import { buildNoteStats, NOTE_RECENT_WINDOW_MS } from '@/core/stats/noteStats';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

function note(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'n1',
    createdAt: NOW,
    text: '随手记',
    ...overrides,
  };
}

describe('buildNoteStats（第 240 轮，笔记统计小卡口径）', () => {
  it('空数据 / 非数组入参：全零且 Top3 为空', () => {
    expect(buildNoteStats([], { now: NOW })).toEqual({ total: 0, recent7: 0, topCourses: [] });
    expect(buildNoteStats(undefined, { now: NOW })).toEqual({ total: 0, recent7: 0, topCourses: [] });
    expect(buildNoteStats('notes' as unknown as unknown[], { now: NOW })).toEqual({ total: 0, recent7: 0, topCourses: [] });
  });

  it('总数含 B 站外部笔记（无 courId），deletedAt 非空不计入', () => {
    const stats = buildNoteStats(
      [
        note({ id: 'a', courId: 1 }),
        note({ id: 'b', mediaKey: 'bili:BV1', createdAt: NOW }), // 外部：总数计入
        note({ id: 'c', deletedAt: NOW - 100 }), // 已删除：不计
        note({ id: 'd', deletedAt: null }),
      ],
      { now: NOW },
    );
    expect(stats.total).toBe(3);
    expect(stats.topCourses).toHaveLength(1);
    expect(stats.topCourses[0]).toMatchObject({ key: '1', count: 1 });
  });

  it('近 7 天窗口边界：恰 7 天前不含、7 天前 +1ms 含、恰 now 含、未来时间戳不含', () => {
    const stats = buildNoteStats(
      [
        note({ id: 'edge-out', createdAt: NOW - NOTE_RECENT_WINDOW_MS }), // 端点：不含
        note({ id: 'edge-in', createdAt: NOW - NOTE_RECENT_WINDOW_MS + 1 }), // 端点 +1ms：含
        note({ id: 'now-in', createdAt: NOW }), // 恰 now：含
        note({ id: 'future', createdAt: NOW + 1 }), // 未来：防时钟漂移不含
        note({ id: 'old', createdAt: NOW - 30 * DAY }), // 30 天前：不含
        note({ id: 'bad-ts', createdAt: 'not-a-number' }), // 脏数据：不计窗口
      ],
      { now: NOW },
    );
    expect(stats.recent7).toBe(2);
    expect(stats.total).toBe(6);
  });

  it('课程 Top3：按条数降序，超出取前 3', () => {
    const stats = buildNoteStats(
      [
        note({ id: 'x1', courId: 1 }),
        note({ id: 'x2', courId: 1 }),
        note({ id: 'x3', courId: 1 }),
        note({ id: 'y1', courId: 2 }),
        note({ id: 'y2', courId: 2 }),
        note({ id: 'z1', courId: 3 }),
        note({ id: 'w1', courId: 4 }),
      ],
      { now: NOW },
    );
    expect(stats.topCourses.map((row) => row.key)).toEqual(['1', '2', '3']);
    expect(stats.topCourses[0]).toMatchObject({ count: 3 });
  });

  it('课程 Top3 并列取序：条数相同按课程名 zh-Hans-CN 字典序（courseNames 缺失回退「课程 #id」）', () => {
    const stats = buildNoteStats(
      [
        note({ id: 'a1', courId: 30 }),
        note({ id: 'a2', courId: 30 }),
        note({ id: 'b1', courId: 10 }),
        note({ id: 'b2', courId: 10 }),
        note({ id: 'c1', courId: 20 }),
        note({ id: 'c2', courId: 20 }),
      ],
      { now: NOW },
    );
    // 无课程名映射：id 字典序 '课程 #10' < '课程 #20' < '课程 #30'
    expect(stats.topCourses.map((row) => row.key)).toEqual(['10', '20', '30']);
    const named = buildNoteStats(
      [
        note({ id: 'a1', courId: 30 }),
        note({ id: 'a2', courId: 30 }),
        note({ id: 'b1', courId: 10 }),
        note({ id: 'b2', courId: 10 }),
        note({ id: 'c1', courId: 20 }),
        note({ id: 'c2', courId: 20 }),
      ],
      { now: NOW, courseNames: { 30: '数据结构', 10: '高等数学', 20: '大学英语' } },
    );
    // 有课程名：条数并列时按名称字典序（大学英语 → 高等数学 → 数据结构）
    expect(named.topCourses.map((row) => row.label)).toEqual(['大学英语', '高等数学', '数据结构']);
  });

  it('非法 now：recent7 按窗口失效为 0，总数不受影响', () => {
    const stats = buildNoteStats([note({ courId: 1 })], { now: Number.NaN });
    expect(stats.total).toBe(1);
    expect(stats.recent7).toBe(0);
  });
});
