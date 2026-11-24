/** 今日待办聚合器测试：分区顺序、排序规则、勾选标志、键规则与防御式解析。 */

import { describe, expect, it } from 'vitest';
import { buildTodayPlan, dueBadgeLabel, todoKeyOf, TODAY_KV_PREFIX, type TodayPlanInput } from '@/core/plan/today';
import type { FavoriteEntity, ReviewJobEntity } from '@/core/shared/types';

const TODAY = '2026-11-14';

function dayKey(offsetDays: number): string {
  const d = new Date(`${TODAY}T00:00:00`);
  d.setDate(d.getDate() + offsetDays);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 本地日键 → 毫秒（与 shared/utils.dayKeyToTs 同口径，避免测试依赖时区） */
function dayKeyToTs(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0).getTime();
}

function makeReviewJob(
  id: string,
  overrides: Partial<ReviewJobEntity> = {},
  // 默认给 HDU 课次收藏（有 courId）：复习分区的主映射断言维持「打开看板」的既有行为；
  // B 站收藏的跳转解析（url + ?t=）见 review-jump.test.ts
  favorite: FavoriteEntity | null = makeFav(`fav-${id}`, {
    type: 'time',
    courId: 77,
    teclId: 9,
    anchorTime: 120,
    snapshot: { title: `复习卡 ${id}`, content: '' },
  }),
): ReviewJobEntity & { favorite: FavoriteEntity | null } {
  return {
    id,
    favoriteId: favorite?.id ?? 'missing',
    dueDate: TODAY,
    round: 1,
    template: 'regular',
    status: 'pending',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
    favorite,
  };
}

function makeFav(id: string, overrides: Partial<FavoriteEntity> = {}): FavoriteEntity {
  return {
    id,
    type: 'video',
    refId: `BV${id}`,
    snapshot: { title: `视频 ${id}`, content: '' },
    tags: [],
    pinned: false,
    favoritedAt: 0,
    updatedAt: 0,
    ...overrides,
  } as FavoriteEntity;
}

function makeMissed(courId: number, overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    courId,
    teclId: 9,
    courseName: `课程 ${courId}`,
    courLabel: `第5周 / 2026-10-12 / 第${courId}节课`,
    beginTime: dayKeyToTs('2026-10-12') + 14 * 3600_000,
    watchedSec: 0,
    watchRatio: 0,
    excluded: false,
    ...overrides,
  };
}

function input(overrides: Partial<TodayPlanInput> = {}): TodayPlanInput {
  return {
    dueReviews: [],
    missedSessions: [],
    videoFavorites: [],
    doneKeys: [],
    today: TODAY,
    ...overrides,
  };
}

describe('todoKeyOf（键规则）', () => {
  it('三类键格式正确且同输入同键', () => {
    expect(todoKeyOf({ kind: 'review', id: 'job-1' })).toBe('review:job-1');
    expect(todoKeyOf({ kind: 'missed', courId: 101, teclId: 9, beginTime: 1_699_920_000_000 })).toBe(
      'missed:101:9:1699920000000',
    );
    expect(todoKeyOf({ kind: 'video', bvid: 'BV1abc' })).toBe('video:BV1abc');
    expect(todoKeyOf({ kind: 'review', id: 'job-1' })).toBe(todoKeyOf({ kind: 'review', id: 'job-1' }));
    expect(todoKeyOf({ kind: 'video', bvid: 'BV1abc' })).not.toBe(todoKeyOf({ kind: 'video', bvid: 'BV2abc' }));
  });

  it('字段缺失时键结构保持稳定（空串占位，不抛错）', () => {
    expect(todoKeyOf({ kind: 'review', id: undefined })).toBe('review:');
    expect(todoKeyOf({ kind: 'missed', courId: undefined, teclId: undefined, beginTime: undefined })).toBe('missed:::');
    expect(todoKeyOf({ kind: 'video', bvid: 42 })).toBe('video:');
  });
});

describe('buildTodayPlan（分区与映射）', () => {
  it('三分区按 review → missed → video 排列，字段映射正确', () => {
    const beginTs = new Date(2026, 10, 12, 14, 0, 0, 0).getTime();
    const plan = buildTodayPlan(
      input({
        dueReviews: [makeReviewJob('j1')],
        missedSessions: [makeMissed(101, { beginTime: beginTs }) as never],
        videoFavorites: [
          makeFav('f1', {
            refId: 'BV1abc',
            metadata: {
              platform: 'bilibili',
              bvid: 'BV1abc',
              url: 'https://www.bilibili.com/video/BV1abc',
              uploader: '某位 UP 主',
              durationSec: 600,
              lastPositionSec: 120,
              watchedRatio: 0.2,
            },
          }),
        ],
      }),
    );
    expect(plan.sections.map((s) => s.kind)).toEqual(['review', 'missed', 'video']);
    expect(plan.sections.map((s) => s.label)).toEqual(['到期复习', '待补看课次', '待学视频']);

    expect(plan.sections[0]?.items[0]).toMatchObject({
      key: 'review:j1',
      kind: 'review',
      title: '复习卡 j1',
      subtitle: `到期 ${TODAY}`,
      action: { type: 'dashboard' },
      dueLabel: '今日到期',
      done: false,
    });
    expect(plan.sections[1]?.items[0]).toMatchObject({
      key: 'missed:101:9:' + beginTs,
      kind: 'missed',
      title: '课程 101',
      subtitle: '第5周 / 2026-10-12 / 第101节课',
      action: { type: 'course', courId: 101, teclId: 9 },
      dueLabel: '14:00 开始',
    });
    expect(plan.sections[2]?.items[0]).toMatchObject({
      key: 'video:BV1abc',
      kind: 'video',
      title: '视频 f1',
      subtitle: '某位 UP 主',
      action: { type: 'url', url: 'https://www.bilibili.com/video/BV1abc?t=120' },
      dueLabel: '剩 08:00',
    });
    expect(plan.totalCount).toBe(3);
    expect(plan.doneCount).toBe(0);
  });

  it('收藏已删除的复习项使用占位标题，跳转兜底为学习看板', () => {
    const plan = buildTodayPlan(input({ dueReviews: [makeReviewJob('j9', {}, null)] }));
    expect(plan.sections[0]?.items[0]).toMatchObject({
      key: 'review:j9',
      title: '（收藏已删除）',
      action: { type: 'dashboard' },
    });
  });

  it('视频 URL 已带查询串（?p= 分 P）时用 & 追加续看时间', () => {
    const plan = buildTodayPlan(
      input({
        videoFavorites: [
          makeFav('f2', {
            metadata: { bvid: 'BV2abc', url: 'https://www.bilibili.com/video/BV2abc?p=2', lastPositionSec: 300, durationSec: 1800 },
          }),
        ],
      }),
    );
    expect(plan.sections[0]?.items[0]?.action).toEqual({
      type: 'url',
      url: 'https://www.bilibili.com/video/BV2abc?p=2&t=300',
    });
  });

  it('未开始的视频不带 t 参数；无 metadata.url 时按 bvid/refId 还原链接', () => {
    const plan = buildTodayPlan(
      input({
        videoFavorites: [
          makeFav('f3', { metadata: { bvid: 'BV3abc12345' } }),
          makeFav('f4', { refId: 'BV4abc12345', metadata: {} }),
        ],
      }),
    );
    const items = plan.sections[0]?.items ?? [];
    expect(items[0]?.action).toEqual({ type: 'url', url: 'https://www.bilibili.com/video/BV3abc12345' });
    expect(items[1]?.action).toEqual({ type: 'url', url: 'https://www.bilibili.com/video/BV4abc12345' });
    expect(items.map((i) => i.dueLabel)).toEqual(['未开始', '未开始']);
  });

  it('脏 bvid 回退不产生链接（第 38 轮巡检）：无合法 url 时该收藏不进待学分区（仅展示口径由调用方定）', () => {
    const plan = buildTodayPlan(
      input({
        videoFavorites: [
          // bvid 带 path / 查询串 / 非 BV 前缀：回退校验不过 → 不生成跳转，条目剔除
          makeFav('dirty-path', { metadata: { bvid: 'BV1abc123/../../evil' } }),
          makeFav('dirty-query', { metadata: { bvid: 'BV1abc123?x=1' } }),
          makeFav('dirty-prefix', { metadata: { bvid: 'av123456789' } }),
          makeFav('dirty-short', { refId: 'BV1abc123', metadata: {} }),
          // 合法 BV 照常进分区
          makeFav('clean', { metadata: { bvid: 'BV1abc12345' } }),
        ],
      }),
    );
    const items = plan.sections[0]?.items ?? [];
    expect(items.map((i) => i.key)).toEqual(['video:BV1abc12345']);
    expect(items[0]?.action).toEqual({ type: 'url', url: 'https://www.bilibili.com/video/BV1abc12345' });
  });
});

describe('buildTodayPlan（排序）', () => {
  it('review 按到期时间升序', () => {
    const plan = buildTodayPlan(
      input({
        dueReviews: [
          makeReviewJob('today', { dueDate: dayKey(0) }),
          makeReviewJob('late', { dueDate: dayKey(-2) }),
          makeReviewJob('future', { dueDate: dayKey(3) }),
        ],
      }),
    );
    expect(plan.sections[0]?.items.map((i) => i.key)).toEqual(['review:late', 'review:today', 'review:future']);
    // 逾期项给出「已到期 N 天」，未来日键给出「MM-DD 到期」
    expect(plan.sections[0]?.items[0]?.dueLabel).toBe('已到期 2 天');
    expect(plan.sections[0]?.items[2]?.dueLabel).toBe(`${dayKey(3).slice(5)} 到期`);
  });

  it('missed 按 beginTime 降序（最近错过的在前）', () => {
    const plan = buildTodayPlan(
      input({
        missedSessions: [
          makeMissed(1, { beginTime: 1_000 }) as never,
          makeMissed(2, { beginTime: 3_000 }) as never,
          makeMissed(3, { beginTime: 2_000 }) as never,
        ],
      }),
    );
    expect(plan.sections[0]?.items.map((i) => i.key)).toEqual(['missed:2:9:3000', 'missed:3:9:2000', 'missed:1:9:1000']);
  });

  it('video 按进度升序（未开始排前），已看完（≥0.95）不出分区', () => {
    const plan = buildTodayPlan(
      input({
        videoFavorites: [
          makeFav('half', { metadata: { bvid: 'BVhalf', url: 'https://www.bilibili.com/video/BVhalf', lastPositionSec: 500, durationSec: 1000 } }),
          makeFav('started', { metadata: { bvid: 'BVstarted', url: 'https://www.bilibili.com/video/BVstarted', watchedRatio: 0.1 } }),
          makeFav('fresh', { metadata: { bvid: 'BVfresh', url: 'https://www.bilibili.com/video/BVfresh' } }),
          makeFav('done', { metadata: { bvid: 'BVdone', url: 'https://www.bilibili.com/video/BVdone', watchedRatio: 0.97 } }),
        ],
      }),
    );
    expect(plan.sections[0]?.items.map((i) => i.key)).toEqual(['video:BVfresh', 'video:BVstarted', 'video:BVhalf']);
    expect(plan.totalCount).toBe(3);
  });
});

describe('buildTodayPlan（勾选与空输入）', () => {
  it('doneKeys 命中的条目不出分区，仅置 done，并计入 doneCount', () => {
    const beginTs = 5_000;
    const plan = buildTodayPlan(
      input({
        dueReviews: [makeReviewJob('j1'), makeReviewJob('j2')],
        missedSessions: [makeMissed(101, { beginTime: beginTs }) as never],
        doneKeys: ['review:j1'],
      }),
    );
    expect(plan.totalCount).toBe(3);
    expect(plan.doneCount).toBe(1);
    const reviewItems = plan.sections[0]?.items ?? [];
    // 同到期日/轮次时按键升序：j1 在前且已勾选
    expect(reviewItems.map((i) => i.done)).toEqual([true, false]);
    expect(reviewItems[0]?.key).toBe('review:j1');
    expect(plan.sections[1]?.items[0]?.done).toBe(false);
  });

  it('空输入返回空 sections 与零计数', () => {
    const plan = buildTodayPlan(input());
    expect(plan.sections).toEqual([]);
    expect(plan.totalCount).toBe(0);
    expect(plan.doneCount).toBe(0);
  });
});

describe('buildTodayPlan（防御式解析）', () => {
  it('字段缺失 / 类型不对 / null 条目不抛错，脏条目被剔除', () => {
    const plan = buildTodayPlan({
      dueReviews: [null, 42, {}, { id: 'ok', dueDate: TODAY, round: 1, favorite: null }] as never,
      missedSessions: [null, 'x', { courId: 'oops' }, { courId: 8, teclId: 3, beginTime: 100, courseName: '课程 8' }] as never,
      videoFavorites: [null, 5, {}, { type: 'note', snapshot: { title: '笔记', content: '' } }] as never,
      doneKeys: [null, 42, '', 'review:ok'] as never,
      today: TODAY,
    } as never);
    // 仅 review:ok 与 missed:8 形状合法；其余脏条目被剔除
    expect(plan.totalCount).toBe(2);
    expect(plan.doneCount).toBe(1);
    expect(plan.sections).toHaveLength(2);
    expect(plan.sections[0]?.items[0]).toMatchObject({ key: 'review:ok', title: '（收藏已删除）', done: true });
    expect(plan.sections[1]?.items[0]?.key).toBe('missed:8:3:100');
  });

  it('excluded（已到课）/ deletedAt（已删除）/ 非 video 类型被剔除', () => {
    const defaultBegin = dayKeyToTs('2026-10-12') + 14 * 3600_000;
    const plan = buildTodayPlan(
      input({
        missedSessions: [makeMissed(1, { excluded: true }) as never, makeMissed(2) as never],
        videoFavorites: [
          makeFav('gone', { metadata: { bvid: 'BVgone', url: 'u' }, deletedAt: 123 }),
          makeFav('notvideo', { type: 'note', metadata: { url: 'u' } }),
          makeFav('nourl', { metadata: {}, refId: undefined }),
          makeFav('ok', { metadata: { bvid: 'BVok', url: 'https://www.bilibili.com/video/BVok' } }),
        ],
      }),
    );
    expect(plan.sections.map((s) => s.kind)).toEqual(['missed', 'video']);
    expect(plan.sections[0]?.items.map((i) => i.key)).toEqual([`missed:2:9:${defaultBegin}`]);
    expect(plan.sections[1]?.items.map((i) => i.key)).toEqual(['video:BVok']);
  });

  it('today 缺省时使用本地日键；来源数组缺失不抛错', () => {
    expect(() => buildTodayPlan(undefined as never)).not.toThrow();
    const plan = buildTodayPlan({} as never);
    expect(plan.sections).toEqual([]);
    expect(TODAY_KV_PREFIX).toBe('hdu.todo.done.');
  });
});

describe('buildTodayPlan（每周计划 weeklyBvids 接入）', () => {
  /** 视频收藏工厂：进度可注入（未传时按 lastPosition/duration 推算或未开始） */
  function videoFav(id: string, meta: Record<string, unknown> = {}): FavoriteEntity {
    return makeFav(id, { refId: id, metadata: { bvid: id, url: `https://www.bilibili.com/video/${id}`, ...meta } });
  }

  it('命中 weeklyBvids 的条目排 video 分区前部（计划内/外各自保持进度升序）', () => {
    const plan = buildTodayPlan(
      input({
        videoFavorites: [
          videoFav('fresh', {}),
          videoFav('half', { lastPositionSec: 500, durationSec: 1000, watchedRatio: 0.5 }),
          videoFav('plannedMid', { watchedRatio: 0.3 }),
          videoFav('plannedFresh', {}),
          videoFav('plannedLate', { watchedRatio: 0.8 }),
        ],
        weeklyBvids: ['plannedFresh', 'plannedMid', 'plannedLate'],
      }),
    );
    const items = plan.sections[0]?.items ?? [];
    // 计划条目全部置前（组内进度升序），计划外条目随后（组内进度升序）
    expect(items.map((i) => i.key)).toEqual([
      'video:plannedFresh',
      'video:plannedMid',
      'video:plannedLate',
      'video:fresh',
      'video:half',
    ]);
    expect(plan.totalCount).toBe(5);
    expect(plan.doneCount).toBe(0);
  });

  it('命中条目 dueLabel 加「今日计划 · 」前缀，条目键仍为 video:<bvid>', () => {
    const plan = buildTodayPlan(
      input({
        videoFavorites: [videoFav('p1', { watchedRatio: 0.2, lastPositionSec: 480, durationSec: 1800 }), videoFav('p2', {})],
        weeklyBvids: ['p1', 'p2'],
      }),
    );
    const items = plan.sections[0]?.items ?? [];
    // 计划内按进度升序：未开始的 p2 在前
    expect(items.map((i) => i.key)).toEqual(['video:p2', 'video:p1']);
    expect(items[0]?.dueLabel).toBe('今日计划 · 未开始');
    expect(items[1]?.dueLabel).toBe('今日计划 · 剩 22:00');
    // 键规则不变：勾选状态按 video:<bvid> 匹配
    const done = buildTodayPlan(
      input({ videoFavorites: [videoFav('p1', { watchedRatio: 0.2 })], weeklyBvids: ['p1'], doneKeys: ['video:p1'] }),
    );
    expect(done.sections[0]?.items[0]).toMatchObject({ key: 'video:p1', done: true });
    expect(done.doneCount).toBe(1);
  });

  it('完看（≥0.95）的计划条目照旧不进分区', () => {
    const plan = buildTodayPlan(
      input({
        videoFavorites: [videoFav('plannedDone', { watchedRatio: 0.97 }), videoFav('plannedTodo', { watchedRatio: 0.4 })],
        weeklyBvids: ['plannedDone', 'plannedTodo'],
      }),
    );
    expect(plan.sections[0]?.items.map((i) => i.key)).toEqual(['video:plannedTodo']);
    expect(plan.totalCount).toBe(1);
  });

  it('不传 weeklyBvids（或传空数组 / 脏输入）行为与旧版完全一致', () => {
    const favorites = [videoFav('a', { watchedRatio: 0.1 }), videoFav('b', {})];
    const baseline = buildTodayPlan(input({ videoFavorites: favorites }));
    const withEmpty = buildTodayPlan(input({ videoFavorites: favorites, weeklyBvids: [] }));
    const withDirty = buildTodayPlan(input({ videoFavorites: favorites, weeklyBvids: [null, 42, ''] as never }));
    const keys = (p: typeof baseline) => (p.sections[0]?.items ?? []).map((i) => `${i.key}|${i.dueLabel}`);
    expect(keys(withEmpty)).toEqual(keys(baseline));
    expect(keys(withDirty)).toEqual(keys(baseline));
    expect(keys(baseline)).toEqual(['video:b|未开始', 'video:a|未开始']);
  });
});

describe('dueBadgeLabel（学习入口今日到期徽标，第 77 轮巡检）', () => {
  it('无到期（0 / 负数 / 缺失 / 非有限）返回 null，不渲染徽标', () => {
    expect(dueBadgeLabel(0)).toBeNull();
    expect(dueBadgeLabel(-1)).toBeNull();
    expect(dueBadgeLabel(null)).toBeNull();
    expect(dueBadgeLabel(undefined)).toBeNull();
    expect(dueBadgeLabel(Number.NaN)).toBeNull();
    expect(dueBadgeLabel(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('正整数原样展示；小数向下取整；>99 封顶 99+', () => {
    expect(dueBadgeLabel(1)).toBe('1');
    expect(dueBadgeLabel(12)).toBe('12');
    expect(dueBadgeLabel(99)).toBe('99');
    expect(dueBadgeLabel(100)).toBe('99+');
    expect(dueBadgeLabel(1234)).toBe('99+');
    expect(dueBadgeLabel(2.9)).toBe('2');
  });
});
