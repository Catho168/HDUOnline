/**
 * 复习跳转解析测试（第 26 轮任务 B）：
 *  - reviewJumpTargetOf：收藏 → 复习跳转目标的纯函数矩阵
 *    （B 站 video/time 收藏 → 站外 url（?p= 分 P + ?t= 锚点）；
 *     HDU 收藏（有 courId）→ dashboard 维持既有行为；脏数据/解析失败 → dashboard 兜底）；
 *  - buildTodayPlan 集成：复习分区的条目 action 按收藏类型分流。
 */

import { describe, expect, it } from 'vitest';
import { buildTodayPlan, reviewJumpTargetOf, REVIEW_JUMP_LABEL } from '@/core/plan/today';
import type { FavoriteEntity, ReviewJobEntity } from '@/core/shared/types';

const TODAY = '2026-11-14';

function fav(overrides: Partial<FavoriteEntity> = {}): FavoriteEntity {
  return {
    id: 'fav-1',
    type: 'time',
    snapshot: { title: '时间点收藏', content: '' },
    tags: [],
    pinned: false,
    favoritedAt: 0,
    updatedAt: 0,
    ...overrides,
  } as FavoriteEntity;
}

function job(favorite: FavoriteEntity | null, id = 'j1'): ReviewJobEntity & { favorite: FavoriteEntity | null } {
  return {
    id,
    favoriteId: favorite?.id ?? 'missing',
    dueDate: TODAY,
    round: 1,
    template: 'regular',
    status: 'pending',
    createdAt: 0,
    updatedAt: 0,
    favorite,
  };
}

describe('reviewJumpTargetOf（B 站收藏 → 站外 url）', () => {
  it('时间点收藏：metadata.url 优先，anchorTime → ?t=（向下取整、非负）', () => {
    expect(
      reviewJumpTargetOf(
        fav({ anchorTime: 95.7, metadata: { platform: 'bilibili', bvid: 'BV1abc', url: 'https://www.bilibili.com/video/BV1abc' } }),
      ),
    ).toEqual({ type: 'url', url: 'https://www.bilibili.com/video/BV1abc?t=95', label: '去复习' });
    expect(
      reviewJumpTargetOf(
        fav({ anchorTime: 0.2, metadata: { platform: 'bilibili', bvid: 'BV1abc', url: 'https://www.bilibili.com/video/BV1abc' } }),
      ),
    ).toEqual({ type: 'url', url: 'https://www.bilibili.com/video/BV1abc?t=0', label: '去复习' });
  });

  it('多 P：metadata.p ≥2 且 URL 未带分 P 时补 ?p=N；URL 已带 ?p= 时不重复追加', () => {
    expect(
      reviewJumpTargetOf(
        fav({ anchorTime: 30, metadata: { platform: 'bilibili', bvid: 'BV1abc', p: 3, url: 'https://www.bilibili.com/video/BV1abc' } }),
      ),
    ).toEqual({ type: 'url', url: 'https://www.bilibili.com/video/BV1abc?p=3&t=30', label: '去复习' });
    expect(
      reviewJumpTargetOf(
        fav({ anchorTime: 30, metadata: { platform: 'bilibili', bvid: 'BV1abc', p: 3, url: 'https://www.bilibili.com/video/BV1abc?p=3' } }),
      ),
    ).toEqual({ type: 'url', url: 'https://www.bilibili.com/video/BV1abc?p=3&t=30', label: '去复习' });
  });

  it('视频收藏（无 anchorTime）不带 ?t=；metadata.url 缺失时按 bvid/refId 还原', () => {
    const videoMeta = { platform: 'bilibili', bvid: 'BV1abc', url: 'https://www.bilibili.com/video/BV1abc' };
    expect(reviewJumpTargetOf(fav({ type: 'video', refId: 'BV1abc', metadata: videoMeta }))).toEqual({
      type: 'url',
      url: 'https://www.bilibili.com/video/BV1abc',
      label: '去复习',
    });
    expect(reviewJumpTargetOf(fav({ type: 'video', refId: 'BV2abc12345', metadata: {} }))).toEqual({
      type: 'url',
      url: 'https://www.bilibili.com/video/BV2abc12345',
      label: '去复习',
    });
    expect(reviewJumpTargetOf(fav({ type: 'video', refId: 'BV3abc12345' }))).toEqual({
      type: 'url',
      url: 'https://www.bilibili.com/video/BV3abc12345',
      label: '去复习',
    });
  });

  it('脏 bvid 回退不产生跳转链接（第 38 轮巡检）：带 path/查询串/非 BV 前缀/过短 → dashboard 兜底', () => {
    // metadata.url 缺失/非法时才走 bvid 回退；脏 bvid 一律不生成 URL（仅展示）
    expect(reviewJumpTargetOf(fav({ type: 'video', refId: 'BV1abc123/../../evil' }))).toEqual({ type: 'dashboard' });
    expect(reviewJumpTargetOf(fav({ type: 'video', refId: 'BV1abc123?x=1' }))).toEqual({ type: 'dashboard' });
    expect(reviewJumpTargetOf(fav({ type: 'video', refId: 'av123456789' }))).toEqual({ type: 'dashboard' });
    // 过短 BV（后缀不足 8 位）与 metadata.bvid 脏值同样不通过校验
    expect(reviewJumpTargetOf(fav({ type: 'video', refId: 'BV1abc123' }))).toEqual({ type: 'dashboard' });
    expect(
      reviewJumpTargetOf(fav({ type: 'video', refId: 'BV1abc12345', metadata: { bvid: 'javascript:alert(1)' } })),
    ).toEqual({ type: 'dashboard' });
    // 合法 BV（BV + ≥8 位字母数字）仍产生官方链接
    expect(reviewJumpTargetOf(fav({ type: 'video', refId: 'BV1abc12345' }))).toEqual({
      type: 'url',
      url: 'https://www.bilibili.com/video/BV1abc12345',
      label: '去复习',
    });
  });

  it('anchorTime 为 0 / 缺失 / 负数 / 脏类型时不带 ?t=，不抛错', () => {
    const meta = { platform: 'bilibili', bvid: 'BV1abc', url: 'https://www.bilibili.com/video/BV1abc' };
    const plain = { type: 'url', url: 'https://www.bilibili.com/video/BV1abc', label: '去复习' };
    expect(reviewJumpTargetOf(fav({ anchorTime: 0, metadata: meta }))).toEqual(plain);
    expect(reviewJumpTargetOf(fav({ metadata: meta }))).toEqual(plain);
    expect(reviewJumpTargetOf(fav({ anchorTime: -5, metadata: meta }))).toEqual(plain);
    expect(reviewJumpTargetOf(fav({ anchorTime: 'x' as never, metadata: meta }))).toEqual(plain);
  });

  it('文案常量与 url 动作的 label 一致（UI 回退「续看」不影响复习条目）', () => {
    expect(REVIEW_JUMP_LABEL).toBe('去复习');
  });
});

describe('reviewJumpTargetOf（HDU 与兜底 → dashboard，零变化）', () => {
  it('HDU 收藏（有 courId）维持 dashboard，即便 metadata 带站外 url 也不外跳', () => {
    expect(
      reviewJumpTargetOf(
        fav({ type: 'time', courId: 77, teclId: 9, anchorTime: 120, metadata: { url: 'https://www.bilibili.com/video/BV1abc' } }),
      ),
    ).toEqual({ type: 'dashboard' });
  });

  it('收藏已删除 / 脏数据 / 解析不出链接 → dashboard 兜底', () => {
    expect(reviewJumpTargetOf(null)).toEqual({ type: 'dashboard' });
    expect(reviewJumpTargetOf(undefined)).toEqual({ type: 'dashboard' });
    expect(reviewJumpTargetOf(42)).toEqual({ type: 'dashboard' });
    expect(reviewJumpTargetOf(fav({ metadata: {} }))).toEqual({ type: 'dashboard' });
    // 非 http(s) 的 metadata.url 被协议白名单丢弃，且无 bvid 可还原 → dashboard
    expect(reviewJumpTargetOf(fav({ metadata: { url: 'javascript:alert(1)' } }))).toEqual({ type: 'dashboard' });
  });
});

describe('buildTodayPlan × reviewJumpTargetOf（复习分区接入）', () => {
  it('B 站收藏的复习条目 action 为 url（去复习），HDU 条目维持 dashboard', () => {
    const plan = buildTodayPlan({
      dueReviews: [
        job(
          fav({ anchorTime: 61, metadata: { platform: 'bilibili', bvid: 'BV1abc', url: 'https://www.bilibili.com/video/BV1abc' } }),
          'j-bili',
        ),
        job(fav({ id: 'fav-2', courId: 5, snapshot: { title: 'HDU 卡', content: '' } }), 'j-hdu'),
      ],
      missedSessions: [],
      videoFavorites: [],
      doneKeys: [],
      today: TODAY,
    });
    const items = plan.sections[0]?.items ?? [];
    expect(items.map((i) => i.action)).toEqual([
      { type: 'url', url: 'https://www.bilibili.com/video/BV1abc?t=61', label: '去复习' },
      { type: 'dashboard' },
    ]);
    // 标题 / 到期语义不受跳转分流影响
    expect(items.map((i) => i.title)).toEqual(['时间点收藏', 'HDU 卡']);
    expect(items[0]?.dueLabel).toBe('今日到期');
  });
});
