/**
 * B 站学习中心「今日待办」精简卡（BiliHubTodayCard.tsx，第 35 轮巡检）单测。
 *
 * 覆盖：
 *  1. 纯函数 buildHubTodayItems：review.due 返回 → 条目视图模型——
 *     - B 站视频收藏：url 直跳（metadata.url 优先），类型标签「视频」；
 *     - B 站时间点收藏：anchorTime > 0 拼 ?t= 锚点；
 *     - HDU 站内收藏（courId）：url=null（仅展示），类型标签保留；
 *     - 收藏已删除（favorite=null）：「（收藏已删除）」占位、无类型、无跳转；
 *     - dueLabel 口径（复用 buildTodayPlan 聚合器）：今日到期 / 已到期 N 天 /
 *       未来 MM-DD 到期 / 到期日未知；
 *     - 排序：到期日升序、同日轮次升序。
 *  2. 组件（jsdom + react-dom 客户端渲染，无 JSX、直接 createElement，照
 *     bili-hub-panel.test.ts 模式；callOp 整体 mock）：
 *     - 渲染 review.due 条目（标题/类型/到期标签/去复习链接）；
 *     - 空态「今日无到期复习」；失败态「加载失败」可重试；
 *     - 「完成」→ review.complete({ jobId, status: 'done' }) → 重拉列表 → toast。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { BiliHubTodayCard, buildHubTodayItems, type HubTodayReviewItem } from '@/entrypoints/content/ui/BiliHubTodayCard';
import { ToastHost } from '@/entrypoints/content/ui/components';
import type { FavoriteEntity, ReviewJobEntity } from '@/core/shared/types';
import { addDaysKey, localDayKey } from '@/core/shared/utils';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

const BVID = 'BV1TodayCar1';
const TODAY = '2026-05-06';

function makeFavorite(overrides: Partial<FavoriteEntity> = {}): FavoriteEntity {
  return {
    id: 'fav-1',
    type: 'video',
    refId: BVID,
    snapshot: { title: '线性代数公开课：矩阵乘法', content: '' },
    folderId: null,
    tags: [],
    pinned: false,
    favoritedAt: 1000,
    updatedAt: 1000,
    metadata: { platform: 'bilibili', bvid: BVID, url: `https://www.bilibili.com/video/${BVID}` },
    ...overrides,
  };
}

function makeJob(
  overrides: Partial<ReviewJobEntity> & { favorite?: FavoriteEntity | null } = {},
): ReviewJobEntity & { favorite: FavoriteEntity | null } {
  const { favorite, ...jobOverrides } = overrides;
  return {
    id: 'job-1',
    favoriteId: favorite?.id ?? 'fav-1',
    dueDate: TODAY,
    round: 1,
    template: 'regular',
    status: 'pending',
    createdAt: 1000,
    updatedAt: 1000,
    ...jobOverrides,
    favorite: favorite === undefined ? makeFavorite() : favorite,
  };
}

describe('buildHubTodayItems 纯函数（第 35 轮）', () => {
  it('B 站视频收藏：标题/类型标签/今日到期，url 直跳视频页', () => {
    const items = buildHubTodayItems([makeJob()], TODAY);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      jobId: 'job-1',
      title: '线性代数公开课：矩阵乘法',
      typeLabel: '视频',
      dueLabel: '今日到期',
      url: `https://www.bilibili.com/video/${BVID}`,
    });
  });

  it('B 站时间点收藏：anchorTime 拼 ?t= 锚点直跳复习时间点', () => {
    const fav = makeFavorite({
      id: 'fav-time',
      type: 'time',
      anchorTime: 180,
      metadata: { platform: 'bilibili', bvid: BVID, url: `https://www.bilibili.com/video/${BVID}` },
    });
    const items = buildHubTodayItems([makeJob({ id: 'job-time', favorite: fav })], TODAY);
    expect(items[0]!.typeLabel).toBe('时间点');
    expect(items[0]!.url).toBe(`https://www.bilibili.com/video/${BVID}?t=180`);
  });

  it('HDU 站内收藏（courId）：url=null 仅展示，类型标签保留', () => {
    const fav = makeFavorite({
      id: 'fav-hdu',
      courId: 12,
      teclId: 34,
      metadata: undefined,
      refId: undefined,
    });
    const items = buildHubTodayItems([makeJob({ id: 'job-hdu', favorite: fav })], TODAY);
    expect(items[0]!.url).toBeNull();
    expect(items[0]!.typeLabel).toBe('视频');
    expect(items[0]!.title).toBe('线性代数公开课：矩阵乘法');
  });

  it('收藏已删除（favorite=null）：占位标题、无类型、无跳转', () => {
    const items = buildHubTodayItems([makeJob({ favorite: null })], TODAY);
    expect(items[0]).toMatchObject({ jobId: 'job-1', title: '（收藏已删除）', typeLabel: null, url: null });
  });

  it('dueLabel 口径：过期/今日/未来/缺到期日', () => {
    const items = buildHubTodayItems(
      [
        makeJob({ id: 'job-past', dueDate: '2026-05-04' }),
        makeJob({ id: 'job-today', dueDate: TODAY }),
        makeJob({ id: 'job-future', dueDate: '2026-05-09' }),
        makeJob({ id: 'job-nodue', dueDate: '' }),
      ],
      TODAY,
    );
    const byId = new Map(items.map((item) => [item.jobId, item]));
    expect(byId.get('job-past')?.dueLabel).toBe('已到期 2 天');
    expect(byId.get('job-today')?.dueLabel).toBe('今日到期');
    expect(byId.get('job-future')?.dueLabel).toBe('05-09 到期');
    expect(byId.get('job-nodue')?.dueLabel).toBe('到期日未知');
  });

  it('排序：到期日升序、同日轮次升序', () => {
    const items = buildHubTodayItems(
      [
        makeJob({ id: 'job-today-r2', dueDate: TODAY, round: 2 }),
        makeJob({ id: 'job-tomorrow', dueDate: '2026-05-07', round: 1 }),
        makeJob({ id: 'job-today-r1', dueDate: TODAY, round: 1 }),
        makeJob({ id: 'job-yesterday', dueDate: '2026-05-05', round: 1 }),
      ],
      TODAY,
    );
    expect(items.map((item) => item.jobId)).toEqual([
      'job-yesterday',
      'job-today-r1',
      'job-today-r2',
      'job-tomorrow',
    ]);
  });

  it('空列表 / 脏数据安全', () => {
    expect(buildHubTodayItems([], TODAY)).toEqual([]);
    expect(buildHubTodayItems([null as unknown as ReviewJobEntity & { favorite: null }], TODAY)).toEqual([]);
  });
});

// ───────────────────────── 组件 ─────────────────────────

let calls: Array<{ op: string; args: unknown }> = [];

function stubOps(table: Record<string, unknown> = {}): void {
  calls = [];
  const defaults: Record<string, unknown> = {
    'review.due': [],
    'review.complete': undefined,
    ...table,
  };
  callOpMock.mockImplementation(async (op: string, args?: unknown) => {
    calls.push({ op, args });
    if (!(op in defaults)) throw new Error(`unexpected op: ${op}`);
    return defaults[op];
  });
}

let host: HTMLElement;
let root: Root;

/** 卡片 + ToastHost 同树渲染（pushToast 通道在 ToastHost 内展示） */
async function renderCard(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        'div',
        null,
        createElement(BiliHubTodayCard),
        createElement(ToastHost),
      ),
    );
  });
  await act(async () => {});
}

async function clickAsync(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await act(async () => {});
}

function text(selector: string): string {
  return document.querySelector(selector)?.textContent ?? '';
}

function queryAll(selector: string): Element[] {
  return Array.from(document.querySelectorAll(selector));
}

function buttonWithText(text_: string): HTMLButtonElement {
  const el = queryAll('button').find((b) => b.textContent === text_);
  if (!el) throw new Error(`button not found: ${text_}`);
  return el as HTMLButtonElement;
}

/** 最新一条 toast（pushToast 追加在栈尾；toast TTL 3.6s，跨用例可能残留旧条目，
 *  断言一律看最新一条，避免读到上一用例的 toast） */
function lastToast(): string {
  return queryAll('.hdu-toast').at(-1)?.textContent ?? '';
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  stubOps();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = '';
});

describe('BiliHubTodayCard 组件', () => {
  it('挂载即拉 review.due 并渲染条目（标题/类型/到期标签/去复习链接）', async () => {
    // 组件内 today 取真实本地日键，预置作业的到期日须用 localDayKey() 才是「今日到期」
    stubOps({ 'review.due': [makeJob({ dueDate: localDayKey() })] });
    await renderCard();
    expect(calls.some((c) => c.op === 'review.due')).toBe(true);
    expect(text('.hdu-section-title')).toBe('今日待办');
    // 完成度徽标（第 79 轮巡检，对齐 HDU 今日待办）：0 / 1 已完成
    expect(text('.hdu-chip')).toContain('0 / 1 已完成');
    expect(text('.hdu-list-title')).toBe('线性代数公开课：矩阵乘法');
    expect(text('.hdu-list-sub')).toContain('视频');
    expect(text('.hdu-list-sub')).toContain('今日到期');
    const link = document.querySelector<HTMLAnchorElement>('.hdu-todo-row a');
    expect(link?.href).toBe(`https://www.bilibili.com/video/${BVID}`);
    expect(link?.textContent).toContain('去复习');
    // 站内项无链接，但「完成」按钮始终存在
    expect(buttonWithText('完成')).toBeDefined();
  });

  it('无到期项显示空态文案', async () => {
    await renderCard();
    expect(text('.hdu-empty-title')).toBe('今日无到期复习');
    expect(text('.hdu-empty-text')).toContain('HDU 学习中心');
  });

  it('加载失败显示失败态，重试成功后恢复列表', async () => {
    callOpMock.mockImplementation(async (op: string) => {
      calls.push({ op, args: undefined });
      if (op === 'review.due' && calls.filter((c) => c.op === 'review.due').length === 1) {
        throw new Error('db down');
      }
      if (op === 'review.due') return [makeJob()];
      return undefined;
    });
    await renderCard();
    expect(text('.hdu-empty-title')).toBe('加载失败');
    await clickAsync(buttonWithText('重试'));
    expect(text('.hdu-list-title')).toBe('线性代数公开课：矩阵乘法');
  });

  it('「完成」→ review.complete({ status: done }) → 重拉列表 → toast', async () => {
    // 首次 review.due 返回 1 条（到期日=今天），完成后重拉返回空 → 空态
    let dueCalls = 0;
    callOpMock.mockImplementation(async (op: string, args?: unknown) => {
      calls.push({ op, args });
      if (op === 'review.due') {
        dueCalls += 1;
        return dueCalls === 1 ? [makeJob({ dueDate: localDayKey() })] : [];
      }
      return undefined;
    });
    await renderCard();
    await clickAsync(buttonWithText('完成'));
    const completeCall = calls.find((c) => c.op === 'review.complete');
    expect(completeCall).toBeDefined();
    expect(completeCall!.args).toEqual({ jobId: 'job-1', status: 'done' });
    // 完成后重拉：review.due 第 3/4 次调用（load#2 的今日+明日两路）返回空 → 空态
    // （第 229 轮起每次 load 并行拉今日+明日两路 review.due，故计数 ×2）
    expect(dueCalls).toBe(4);
    expect(text('.hdu-empty-title')).toBe('今日无到期复习');
    expect(lastToast()).toContain('完成一轮复习');
  });

  it('「完成」失败仅提示错误，列表不误清', async () => {
    callOpMock.mockImplementation(async (op: string, args?: unknown) => {
      calls.push({ op, args });
      if (op === 'review.complete') throw new Error('busy');
      if (op === 'review.due') return [makeJob({ dueDate: localDayKey() })];
      return undefined;
    });
    await renderCard();
    await clickAsync(buttonWithText('完成'));
    // errorTextOf 第 222 轮起对普通 Error 回退语境化兜底文案；此处断言错误 toast 已弹出（错误分支生效）
    expect(lastToast()).toContain('完成复习失败，请重试');
    expect(text('.hdu-list-title')).toBe('线性代数公开课：矩阵乘法');
  });

  it('load 迟到响应守卫（第 38 轮巡检）：慢的旧 review.due 响应不覆盖新数据', async () => {
    let resolveSlow!: (value: unknown) => void;
    const slowDue = new Promise((resolve) => {
      resolveSlow = resolve;
    });
    let dueCalls = 0;
    callOpMock.mockImplementation(async (op: string) => {
      calls.push({ op, args: undefined });
      if (op === 'review.due') {
        dueCalls += 1;
        return dueCalls === 1 ? slowDue : [makeJob({ dueDate: localDayKey() })]; // 请求 A 慢、请求 B 快
      }
      return undefined;
    });
    await renderCard();
    // 第 229 轮起每次 load 并行拉今日+明日两路 review.due，计数 ×2
    expect(dueCalls).toBe(2);
    // 卸载旧卡再重新挂载（页签切换/面板重开的等价场景，重试同走 load 序号机制）：load#2 快响应先回
    await act(async () => {
      root.unmount();
    });
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await renderCard();
    expect(dueCalls).toBe(4);
    expect(text('.hdu-list-title')).toBe('线性代数公开课：矩阵乘法');
    // 旧请求 A 迟到返回：不得改写当前展示（最终状态为 B 的数据）
    await act(async () => {
      resolveSlow([
        makeJob({
          id: 'job-slow',
          favorite: makeFavorite({ id: 'fav-slow', snapshot: { title: '慢数据收藏', content: '' } }),
        }),
      ]);
    });
    await act(async () => {});
    expect(text('.hdu-list-title')).toBe('线性代数公开课：矩阵乘法');
    expect(text('.hdu-hub-today')).not.toContain('慢数据收藏');
  });
});

/** 类型面：HubTodayReviewItem 导出可用（编译期契约，防误删导出） */
describe('HubTodayReviewItem 类型导出', () => {
  it('字段齐全', () => {
    const item: HubTodayReviewItem = {
      jobId: 'j',
      title: 't',
      typeLabel: null,
      dueLabel: '今日到期',
      url: null,
    };
    expect(item.subtitle).toBeUndefined();
  });
});

/** 第 78 轮巡检：待学视频分区（未完看 B 站视频收藏 + 每周计划今日批次排前 + todo.today 勾选） */
describe('BiliHubTodayCard 待学视频分区（第 78 轮）', () => {
  function stubVideoOps(overrides: Record<string, unknown> = {}): void {
    stubOps({
      'fav.list': [makeFavorite()],
      'plan.weekly.get': { plans: [] },
      'todo.today.get': [],
      'todo.today.set': undefined,
      ...overrides,
    });
  }

  it('无到期复习但有未完看视频：复习空态 + 待学视频分区（标题/副标题/剩余时长/续看链接）', async () => {
    stubVideoOps();
    await renderCard();
    expect(text('.hdu-empty-title')).toBe('今日无到期复习');
    expect(text('.hdu-hub-today')).toContain('待学视频见下方分区');
    expect(text('.hdu-hub-today')).toContain('待学视频');
    expect(queryAll('.hdu-todo-row')).toHaveLength(1);
    expect(text('.hdu-list-title')).toBe('线性代数公开课：矩阵乘法');
    expect(text('.hdu-list-sub')).toContain('未开始');
    const link = document.querySelector<HTMLAnchorElement>('.hdu-todo-row a');
    expect(link?.href).toBe(`https://www.bilibili.com/video/${BVID}`);
    expect(link?.textContent).toContain('续看');
    // 拉取了视频收藏 / 每周计划 / 今日勾选三路新数据面
    expect(calls.some((c) => c.op === 'fav.list')).toBe(true);
    expect(calls.some((c) => c.op === 'plan.weekly.get')).toBe(true);
    expect(calls.some((c) => c.op === 'todo.today.get')).toBe(true);
  });

  it('每周计划今日批次命中：条目排前并加「今日计划 ·」前缀', async () => {
    stubVideoOps({
      'plan.weekly.get': {
        plans: [
          {
            id: 'plan-1',
            perDay: 2,
            bvids: [BVID],
            startDate: localDayKey(),
            createdAt: 1000,
            updatedAt: 1000,
          },
        ],
      },
    });
    await renderCard();
    expect(text('.hdu-list-sub')).toContain('今日计划 · ');
    expect(text('.hdu-list-sub')).toContain('未开始');
  });

  it('勾选待学视频：本地灰显 + todo.today.set 持久化 video:<bvid> 键', async () => {
    stubVideoOps();
    await renderCard();
    const check = document.querySelector<HTMLInputElement>('.hdu-todo-row input[type="checkbox"]');
    expect(check).not.toBeNull();
    await act(async () => {
      check!.click();
    });
    await act(async () => {});
    expect(check!.checked).toBe(true);
    const setCall = calls.find((c) => c.op === 'todo.today.set');
    expect(setCall).toBeDefined();
    expect((setCall!.args as { keys: string[] }).keys).toEqual([`video:${BVID}`]);
  });

  it('已勾选（todo.today.get 命中）渲染为完成态', async () => {
    stubVideoOps({ 'todo.today.get': [`video:${BVID}`] });
    await renderCard();
    const check = document.querySelector<HTMLInputElement>('.hdu-todo-row input[type="checkbox"]');
    expect(check?.checked).toBe(true);
    expect(check!.closest('.hdu-todo-row')?.className).toContain('is-done');
  });
});

describe('BiliHubTodayCard 顺延到指定日（第 248 轮，B 站对齐收官）', () => {
  it('逾期行「改期」展开行内顺延浮层：aria-expanded 声明 + 快捷 chips 点选即 review.reschedule', async () => {
    // makeJob 默认 dueDate=2026-05-06 早于真实本地今日 → 已到期行
    stubOps({ 'review.due': [makeJob()], 'review.reschedule': undefined });
    await renderCard();

    const reschedBtn = buttonWithText('改期');
    expect(reschedBtn.getAttribute('aria-expanded')).toBe('false');
    // 逾期行同时保留一键「顺延」（推一天）与「改期」（指定日）两个入口
    expect(buttonWithText('顺延')).toBeDefined();
    await clickAsync(reschedBtn);
    expect(reschedBtn.getAttribute('aria-expanded')).toBe('true');

    // 行内浮层与 HDU 复习计划第 244 轮同结构：标题 + 快捷 chips + 口径 hint
    expect(text('.hdu-resched-pop-title')).toBe('顺延到指定日');
    const chips = Array.from(document.querySelectorAll('.hdu-resched-chip'));
    expect(chips.length).toBeGreaterThanOrEqual(7); // 一整周 7 档（含下周同一日跳档）
    expect(chips[0]?.querySelector('.hdu-resched-chip-label')?.textContent).toBe('明天');

    // 点「明天」chip：review.reschedule 带明日日键，成功 toast + 浮层收起
    const tomorrow = addDaysKey(localDayKey(), 1);
    await clickAsync(chips[0]!);
    const reschedCall = calls.find((c) => c.op === 'review.reschedule');
    expect(reschedCall).toBeDefined();
    expect(reschedCall!.args).toEqual({ jobId: 'job-1', dueDate: tomorrow });
    expect(lastToast()).toContain('已改期到明天');
    expect(document.querySelector('.hdu-resched-pop')).toBeNull();
    expect(reschedBtn.getAttribute('aria-expanded')).toBe('false');
  });

  it('「今日到期」行不出现顺延/改期入口（与 HDU 侧逾期限定同口径：今日到期以完成为主）', async () => {
    stubOps({ 'review.due': [makeJob({ dueDate: localDayKey() })], 'review.reschedule': undefined });
    await renderCard();
    expect(buttonWithText('完成')).toBeDefined();
    // queryAll 非抛错寻址：入口不存在才是不渲染
    expect(queryAll('button').some((b) => b.textContent === '改期')).toBe(false);
    expect(queryAll('button').some((b) => b.textContent === '顺延')).toBe(false);
  });

  it('「收起」关闭浮层', async () => {
    stubOps({ 'review.due': [makeJob()], 'review.reschedule': undefined });
    await renderCard();
    await clickAsync(buttonWithText('改期'));
    expect(document.querySelector('.hdu-resched-pop')).not.toBeNull();
    await clickAsync(document.querySelector<HTMLButtonElement>('.hdu-resched-pop-close')!);
    expect(document.querySelector('.hdu-resched-pop')).toBeNull();
  });
});
