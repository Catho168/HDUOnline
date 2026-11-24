/**
 * 今日摘要三方口径一致性（第 255 轮，一致性域 / 双面呈现视角；jsdom + react-dom 客户端
 * 渲染，无 JSX 直接 createElement，照 stats-period-summary-ui.test.ts（第 248 轮三方口径
 * 核对先例）模式；callOp 整体 mock，同一份固件表驱动三个界面）。
 *
 * 三方 = popup（弹窗今日卡）/ dashboard（学习看板概览指标行）/ 学习中心（总览
 * OverviewView 内含 TodayTodoCard 与统计卡）。同一输入（同一组 op 返回固件）构造三产物，
 * 断言关键数字相等（第 255 轮三方口径对照表的可执行版，对照表见 docs/巡检日志.md）：
 *  - 今日待办完成度：todo.today.get + review.due + schedule.missed + fav.list(video)
 *    → 同一 buildTodayPlan 纯函数 → doneCount/totalCount 三处同值；
 *  - 今日学习时长：stats.report.todaySec → 三处同为 Math.round(sec/60) 分钟展示
 *    （popup ≥1h 切「小时」为既有展示面差异，口径字段同源）；
 *  - 连续天数：stats.report.streakDays → 三处同值。
 */

// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { App as PopupApp } from '@/entrypoints/popup/App';
import { Overview } from '@/entrypoints/dashboard/App';
import { OverviewView } from '@/entrypoints/content/ui/learning/OverviewView';
import type { BundleData } from '@/entrypoints/content/ui/learning/shared';
import type { CourseBundle, DashboardReport, FavoriteEntity, ReviewJobEntity } from '@/core/shared/types';
import { buildActivityHeatmap, buildMonthlyHeatmap } from '@/core/stats/heatmap';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

/** 三方共用 stats.report 固件：今日 1500s = 25 分钟、连续 4 天；days 空避开图表分支 */
const REPORT: DashboardReport = {
  totalSec: 7200,
  weekSec: 1800,
  todaySec: 1500,
  externalSeconds: 600,
  streakDays: 4,
  days: [],
  weeks: [],
  courses: [],
  sessions: [],
  goal: { weeklyTargetSec: 18000, weekSec: 1800, hitDaysThisWeek: 2 },
  generatedAt: 0,
};

/** 复习作业固件：今日到期 pending；doneKey 命中 job-1（勾选完成） */
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

/** 待学视频收藏固件：进度 10%（<0.95 不完看 → 进待学分区） */
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

/** 待补看课次固件（未标记到课 → 进待补看分区） */
function makeMissed(courId: number) {
  return {
    courId,
    teclId: 33,
    courseName: '高等数学',
    courLabel: '第 3 讲',
    beginTime: dayTs('2026-11-20') + 10 * 3600_000,
    watchedSec: 0,
    watchRatio: 0,
    excluded: false,
  };
}

function dayTs(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1).getTime();
}

/**
 * 三方共用的今日待办四路信号固件（同一输入的字面载体）：
 * 2 复习 + 1 补看 + 1 待学 = 共 4 项；doneKeys 勾选 1 项 → 已完成 1 / 4。
 */
const TODO_FIXTURES = (): Record<string, unknown> => ({
  'review.due': [makeJob('job-1'), makeJob('job-2')],
  'schedule.missed': [makeMissed(901)],
  'fav.list': [makeVideoFav('BV1Consist01')],
  'todo.today.get': ['review:job-1'],
});

/** 学习中心总览（OverviewView）的 BundleData 固件：report 共用，bundles 空（hero 走文案分支） */
function makeCenterData(): BundleData {
  return {
    bundles: [] as CourseBundle[],
    report: REPORT,
    missed: [],
    favorites: [],
    folders: [],
    notes: [],
    schedule: [],
    reviewPending: 0,
    loading: false,
    error: null,
  } as unknown as BundleData;
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
      sendMessage: vi.fn(async () => undefined),
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
  };
}

/** 统一 stub：三方各自要取的 op 全部落表（含挂载期旁路请求），未知 op 显式报错。
 *  热力图固件用真实聚合函数构造（空流水 → 全零周列），结构合法免崩。 */
function stubTable(): Record<string, unknown> {
  return {
    'stats.report': REPORT,
    'stats.period': { buckets: [] },
    'course.bundles': [],
    'stats.bili.overview': { top: [], recent: [], streakDays: 0 },
    'stats.heatmap': buildActivityHeatmap({ now: Date.now(), weeks: 13 }),
    'stats.heatmapMonthly': buildMonthlyHeatmap({ now: Date.now(), months: 6 }),
    'review.list': [],
    'note.listAll': [],
    'plan.weekly.get': { plans: [] },
    ...TODO_FIXTURES(),
  };
}

function stubAll(): void {
  const table = stubTable();
  callOpMock.mockImplementation(async (op: string) => {
    if (op in table) return table[op];
    throw new Error(`unexpected op: ${op}`);
  });
}

let host: HTMLElement;
let root: Root;

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
  // 多级异步链（loadSettings / tabs.query / callOp → setState）完全落定
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {});
  }
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  callOpMock.mockReset();
  stubAll();
});

afterEach(() => {
  act(() => root.unmount());
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe('今日摘要三方口径一致性（第 255 轮）', () => {
  it('popup：同一输入下完成度 1 / 4、今日 25 分钟、连续 4 天', async () => {
    installChromeStub();
    await renderElement(createElement(PopupApp));

    expect(host.textContent).toContain('已完成 1 / 4');
    expect(host.textContent).toContain('到期复习 2');
    expect(host.textContent).toContain('待补看 1');
    expect(host.textContent).toContain('待学视频 1');
    // 今日学习时长：todaySec 1500 → Math.round(1500/60) = 25 分钟
    expect(host.textContent).toContain('25');
    expect(host.textContent).toContain('分钟');
    // 连续天数
    expect(host.textContent).toContain('4');
    expect(host.textContent).toContain('天');
    // 取数参数口径（与学习中心 / 看板同参）
    const todoCalls = callOpMock.mock.calls.filter((args) => args[0] === 'todo.today.get');
    expect(todoCalls).toHaveLength(1);
    expect(typeof (todoCalls[0]?.[1] as { date?: string } | undefined)?.date).toBe('string');
    const dueCalls = callOpMock.mock.calls.filter((args) => args[0] === 'review.due');
    expect(dueCalls).toHaveLength(1);
    expect(dueCalls[0]?.[1]).toEqual({});
  });

  it('dashboard：新增「今日待办」指标卡同值（1/4 项 + 完成度 25%），今日目标/连续卡同源', async () => {
    await renderElement(createElement(Overview, { notify: vi.fn() }));

    // 今日待办卡（第 255 轮补齐的第三面）：value 1 + / 4 项
    expect(host.textContent).toContain('今日待办');
    expect(host.textContent).toContain('1/ 4 项');
    expect(host.textContent).toContain('完成度 25%');
    // 待办卡内 jade 进度条在场
    const todoCard = Array.from(host.querySelectorAll('.hdu-metric')).find((el) => el.textContent?.includes('今日待办'));
    expect(todoCard?.querySelector('[role="progressbar"]')).toBeDefined();
    // 今日学习时长（今日目标卡 = report.todaySec 同字段）：25 / 30 分钟（settings 缺省 clamp 30）
    expect(host.textContent).toContain('25/30 分钟');
    // 连续天数同字段
    expect(host.textContent).toContain('4');
    // 取数参数口径：四路信号与 popup / 学习中心同参
    const todoCalls = callOpMock.mock.calls.filter((args) => args[0] === 'todo.today.get');
    expect(todoCalls).toHaveLength(1);
    const dueCalls = callOpMock.mock.calls.filter((args) => args[0] === 'review.due');
    expect(dueCalls).toHaveLength(1);
    expect(dueCalls[0]?.[1]).toEqual({});
    // fav.list 第 256 轮起两路：今日待办 video 口径（不变）+ 知识库存在性探测
    // （filter { limit: 1 }，引导卡「沉淀知识」步）——口径对齐义务仍锁定在 video 路
    const favCalls = callOpMock.mock.calls.filter((args) => args[0] === 'fav.list');
    expect(favCalls).toHaveLength(2);
    const videoCall = favCalls.find((args) => (args[1] as { filter?: { type?: string } })?.filter?.type === 'video');
    const probeCall = favCalls.find((args) => (args[1] as { filter?: { limit?: number } })?.filter?.limit === 1);
    expect(videoCall?.[1]).toEqual({ filter: { type: 'video', limit: 500 } });
    expect(probeCall?.[1]).toEqual({ filter: { limit: 1 } });
  });

  it('学习中心：TodayTodoCard 与统计卡同值（1 / 4 已完成、今日学习 25 分钟、连续 4 天）', async () => {
    await renderElement(createElement(OverviewView, { data: makeCenterData(), todoReloadKey: 0 }));

    // TodayTodoCard 完成度 chip（同一 buildTodayPlan 产物）
    expect(host.textContent).toContain('1 / 4 已完成');
    // 分区计数：doneKeys 勾掉 1 项复习 → 复习分区头「待办 1」（含已勾选计数口径）
    expect(host.textContent).toContain('到期复习');
    expect(host.textContent).toContain('待补看课次');
    // 统计卡：今日学习 25 分钟 / 连续 4 天（同 report 字段）
    expect(host.textContent).toContain('25分钟');
    expect(host.textContent).toContain('4天');
  });

  it('todo.today.get 失败时三方一致降级：完成度同落 0 / 4（勾选态缺失不改变计数口径）', async () => {
    installChromeStub();
    const table = stubTable();
    callOpMock.mockImplementation(async (op: string) => {
      if (op === 'todo.today.get') throw new Error('rpc down');
      if (op in table) return table[op];
      throw new Error(`unexpected op: ${op}`);
    });

    // popup 侧：勾选态丢失 → 0 / 4
    await renderElement(createElement(PopupApp));
    expect(host.textContent).toContain('已完成 0 / 4');
    act(() => root.unmount());
    document.body.innerHTML = '';

    // dashboard 侧：同样降级 0 / 4（重开新 root，与 popup 用例隔离）
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await renderElement(createElement(Overview, { notify: vi.fn() }));
    expect(host.textContent).toContain('0/ 4 项');
  });
});
