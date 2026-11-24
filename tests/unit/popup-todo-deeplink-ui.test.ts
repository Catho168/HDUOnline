/**
 * popup 增强渲染测试（第 254 轮，popup 域 / 入口效率视角；jsdom + react-dom 客户端
 * 渲染，无 JSX 直接 createElement，chrome 桩照 stats-period-summary-ui.test.ts 模式）。
 *
 * popup 盘点结论（对照表见 docs/巡检日志.md 第 254 轮）：popup 已有今日统计 / 今日
 * 待办三计数 / 本周摘要 / 本节状态 / 最近学习等区块；两处低风险高价值增强——
 *  1. 待办完成度（候选 A）：此前恒传 doneKeys: []，学习中心勾选完成的条目在 popup
 *     无完成度反馈 → 接入 todo.today.get，与 TodayTodoCard 同口径（已完成 X / 共 Y）；
 *  2. 站内行直达（候选 B）：「最近学习」站内课程行此前不可点（仅 B 站行可点）→
 *     复用 lessonHash 深链机制（dashboard 同款 prefer:'play-center'）。
 */

// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { App as PopupApp } from '@/entrypoints/popup/App';
import type { CourseBundle, DashboardReport, FavoriteEntity } from '@/core/shared/types';
import type { ReviewJobEntity } from '@/core/shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

/** 最小 stats.report 桩（days 空 → 无站外提示行；今日/连续为 0） */
const REPORT: DashboardReport = {
  totalSec: 0,
  weekSec: 0,
  todaySec: 0,
  externalSeconds: 0,
  streakDays: 0,
  days: [],
  weeks: [],
  courses: [],
  sessions: [],
  goal: { weeklyTargetSec: 18000, weekSec: 0, hitDaysThisWeek: 0 },
  generatedAt: 0,
};

/** 复习作业固件：job-1 今日到期（favorite 快照给标题） */
function makeJob(id: string): ReviewJobEntity & { favorite: FavoriteEntity | null } {
  return {
    id,
    favoriteId: `fav-${id}`,
    dueDate: '2026-11-21',
    round: 1,
    template: 'regular',
    status: 'pending',
    createdAt: 0,
    updatedAt: 0,
    favorite: { id: `fav-${id}`, type: 'time', snapshot: { title: `收藏 ${id}`, content: '' }, tags: [], pinned: false, favoritedAt: 0, updatedAt: 0 },
  };
}

/** 待学视频收藏固件：B 站视频，进度 10%（未看完 → 进待办） */
function makeVideoFav(bvid: string): FavoriteEntity {
  return {
    id: `fav-${bvid}`,
    type: 'video',
    refId: bvid,
    snapshot: { title: `网课 ${bvid}`, content: '' },
    tags: [],
    pinned: false,
    favoritedAt: 0,
    updatedAt: 0,
    metadata: { bvid, url: `https://www.bilibili.com/video/${bvid}`, watchedRatio: 0.1 },
  };
}

/** 站内课程 bundle 固件：sessions[0] 已看完、sessions[1] 在看中（深链应落在 watching） */
function makeBundle(teclId: number, sessions: Array<{ courId: number; watchState: string }>, lastActivityAt: number): CourseBundle {
  return {
    course: { teclId, subjName: `课程 ${teclId}`, teacherNames: [], teclCode: `T${teclId}`, updatedAt: 0 },
    sessions: sessions as never[],
    sessionCount: sessions.length,
    watchedSec: 1800,
    finishedCount: 1,
    transcriptCount: 0,
    topicCount: 0,
    lastActivityAt,
  };
}

function installChromeStub(): void {
  (globalThis as unknown as { chrome?: unknown }).chrome = {
    tabs: {
      query: vi.fn(async () => [{ id: 7 }]),
      sendMessage: vi.fn(async () => {
        throw new Error('no content script');
      }),
      create: vi.fn(),
    },
    runtime: {
      openOptionsPage: vi.fn(),
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
  };
}

let host: HTMLElement;
let root: Root;

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
  // 多级异步链（loadSettings / tabs.query / callOp → setState）完全落定
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {});
  }
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  callOpMock.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

function stubPopupOps(overrides: Record<string, unknown> = {}): void {
  callOpMock.mockImplementation(async (op: string) => {
    if (op in overrides) {
      const v = overrides[op];
      if (v instanceof Error) throw v;
      return v;
    }
    switch (op) {
      case 'stats.report':
        return REPORT;
      case 'course.bundles':
        return [];
      case 'stats.period':
        return null;
      case 'review.due':
        return [];
      case 'schedule.missed':
        return [];
      case 'fav.list':
        return [];
      case 'todo.today.get':
        return [];
      case 'stats.bili.overview':
        return { top: [], recent: [], streakDays: 0 };
      default:
        throw new Error(`unexpected op: ${op}`);
    }
  });
}

describe('popup 今日待办完成度（候选 A，第 254 轮）', () => {
  it('接入 todo.today.get：已完成 X / 共 Y 与 jade 进度条渲染（与 TodayTodoCard 同口径）', async () => {
    installChromeStub();
    stubPopupOps({
      'review.due': [makeJob('job-1'), makeJob('job-2')],
      'todo.today.get': ['review:job-1'],
      'fav.list': [makeVideoFav('BV1test001')],
    });
    await renderElement(createElement(PopupApp));

    expect(host.textContent).toContain('今日待办');
    expect(host.textContent).toContain('已完成 1 / 3');
    // 分区计数仍在（含已勾选项，与看板灰显一致）
    expect(host.textContent).toContain('到期复习 2');
    expect(host.textContent).toContain('待学视频 1');
    // 待办卡内进度条在场
    const todoCard = [...host.querySelectorAll('.hdu-card')].find((el) => el.textContent?.includes('今日待办'));
    expect(todoCard?.querySelector('[role="progressbar"]')).toBeDefined();
    // 勾选态取数确实发生（todo.today.get 被调用且带今天日期）
    const todoCalls = callOpMock.mock.calls.filter((args) => args[0] === 'todo.today.get');
    expect(todoCalls).toHaveLength(1);
    const todoArgs = todoCalls[0]?.[1] as { date?: string } | undefined;
    expect(typeof todoArgs?.date).toBe('string');
  });

  it('todo.today.get 失败按空勾选处理：完成度 0 / N，卡片照常渲染（不拖垮 popup）', async () => {
    installChromeStub();
    stubPopupOps({
      'review.due': [makeJob('job-1')],
      'todo.today.get': new Error('rpc down'),
    });
    await renderElement(createElement(PopupApp));
    expect(host.textContent).toContain('已完成 0 / 1');
    expect(host.textContent).toContain('到期复习 1');
  });
});

describe('popup 站内最近学习行直达（候选 B，第 254 轮）', () => {
  it('bundle 有课次 → 站内行渲染为 lessonHash 深链（watching 课次优先，play-center 形态）', async () => {
    installChromeStub();
    stubPopupOps({
      'course.bundles': [makeBundle(11, [{ courId: 900, watchState: 'finished' }, { courId: 901, watchState: 'watching' }], 50)],
    });
    await renderElement(createElement(PopupApp));

    const link = host.querySelector<HTMLAnchorElement>('a.hdu-list-row[href*="course.hdu.edu.cn"]');
    expect(link).toBeDefined();
    // 深链落点：watching 课次（901）而非首节（900）；hash 形态与 dashboard 同款
    expect(link!.getAttribute('href')).toBe('https://course.hdu.edu.cn/#/play-center?teclId=11&courseId=901&target=video');
    expect(link!.getAttribute('target')).toBe('_blank');
    expect(link!.getAttribute('rel')).toContain('noopener');
    expect(link!.textContent).toContain('课程 11');
  });

  it('bundle 无课次 → 保持非链接行（不产出无效深链）；B 站行不受影响', async () => {
    installChromeStub();
    stubPopupOps({
      'course.bundles': [makeBundle(12, [], 40)],
      'stats.bili.overview': {
        top: [],
        recent: [{ bvid: 'BV1recent01', title: '站外网课', url: 'https://www.bilibili.com/video/BV1recent01', totalSec: 600, lastDay: '2026-11-20', lastPositionSec: 120 }],
        streakDays: 1,
      },
    });
    await renderElement(createElement(PopupApp));

    expect(host.textContent).toContain('课程 12');
    const siteLinks = host.querySelectorAll<HTMLAnchorElement>('a.hdu-list-row[href*="course.hdu.edu.cn"]');
    expect(siteLinks).toHaveLength(0);
    // B 站行仍带断点深链（既有行为）
    const biliLink = host.querySelector<HTMLAnchorElement>('a.hdu-list-row[href*="bilibili.com"]');
    expect(biliLink).toBeDefined();
    expect(biliLink!.getAttribute('href')).toContain('BV1recent01');
  });
});
