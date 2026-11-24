/**
 * 空态模板统一测试（第 249 轮巡检，弹性域 / 文案一致性视角）：
 *  1. EmptyState action 渲染契约：传 action 时包一层 .hdu-empty-action（样式表统一
 *     text 与 CTA 的垂直节奏 + small ghost 兜底排布），不传不渲染包裹层；
 *  2. 修齐渲染断言（每处至少 1 条）：
 *     - NoteStatsCard 空态：text 去掉与 title 重复的「还没有笔记」开头、CTA「查看笔记」
 *       收进 action（引导型：一句现状 + 一个行动入口）；
 *     - SearchTab 空态文案随状态切换：已有关键词 →「换个关键词试试」，未输入 →「输入关键词」；
 *     - TodayTodoCard 空态：title 不再夹 emoji（「今日无待办 🎉」→「今日无待办」，
 *       EmptyState title/text 不夹 emoji 的模板规则）；
 *  3. 模板化静态核查（源码级回归锁，照 library-batch-result.test.ts 的 readFileSync 模式）：
 *     OverviewView 与 ScheduleView 的待补看空态同句、CoursesView 筛选空态补 CTA、
 *     dashboard 知识库空态 title 与 LibraryView 同句 + 「查看全部」CTA、重试 CTA 全仓
 *     small ghost + refresh 图标。
 *
 * jsdom + react-dom 客户端渲染，无 JSX、直接 createElement（照 time-of-day-card-ui.test.ts 模式）。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { EmptyState } from '@/entrypoints/content/ui/components';
import { NoteStatsCard } from '@/entrypoints/content/ui/learning/NoteStatsCard';
import { SearchTab } from '@/entrypoints/content/ui/panel/SearchTab';
import { TodayTodoCard } from '@/entrypoints/content/ui/learning/TodayTodoCard';
import { uiStore } from '@/entrypoints/content/ui/store';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

const SRC_ROOT = 'src/entrypoints';
const readSrc = (rel: string): string => readFileSync(`${SRC_ROOT}/${rel}`, 'utf8');

let host: HTMLElement;
let root: Root;

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
  // 放行 useEffect / 异步取数
  await act(async () => {});
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  callOpMock.mockReset();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = '';
  // 复位被本文件 patch 过的 store 状态
  uiStore.patch({ transcriptSearch: { query: '', results: [], loading: false } });
});

describe('EmptyState action 渲染契约（第 249 轮组件级）', () => {
  it('传 action 时渲染 .hdu-empty-action 包裹层，CTA 在其中', () => {
    const el = createElement(EmptyState, {
      icon: 'star',
      title: '还没有收藏',
      text: '一句话现状。',
      action: createElement('button', { className: 'hdu-btn small ghost', type: 'button' }, '去处理'),
    });
    act(() => {
      root.render(el);
    });
    const action = document.querySelector('.hdu-empty .hdu-empty-action');
    expect(action).toBeTruthy();
    expect(action!.querySelector('button')?.textContent).toBe('去处理');
    // title/text 在包裹层之外（节奏由样式表 .hdu-empty gap + .hdu-empty-action margin-top 控制）
    expect(document.querySelector('.hdu-empty-title')?.textContent).toBe('还没有收藏');
    expect(document.querySelector('.hdu-empty-text')?.textContent).toBe('一句话现状。');
  });

  it('不传 action 时不渲染 .hdu-empty-action（告知型无 CTA）', () => {
    const el = createElement(EmptyState, { icon: 'check', title: '今日无待办', text: '今天可以从容安排。' });
    act(() => {
      root.render(el);
    });
    expect(document.querySelector('.hdu-empty-action')).toBeNull();
  });
});

describe('修齐空态渲染断言（第 249 轮）', () => {
  it('NoteStatsCard 空态：text 去重 + CTA「查看笔记」收进 .hdu-empty-action', async () => {
    await renderElement(
      createElement(NoteStatsCard, { notes: [], courseNames: {} }),
    );
    expect(document.querySelector('.hdu-empty-title')?.textContent).toBe('还没有笔记');
    const text = document.querySelector('.hdu-empty-text')?.textContent ?? '';
    // 旧文案以「还没有笔记，」开头与 title 重复——修齐后不再重复
    expect(text.startsWith('还没有笔记')).toBe(false);
    expect(text).toContain('随手记一条');
    const action = document.querySelector('.hdu-empty-action');
    expect(action?.textContent).toBe('查看笔记');
  });

  it('SearchTab 空态文案随状态切换：有关键词 →「换个关键词试试」；无关键词 →「输入关键词」', async () => {
    uiStore.patch({ transcriptSearch: { query: '召回', results: [], loading: false } });
    await renderElement(
      createElement(SearchTab, { searchText: '召回', setSearchText: () => undefined, onSubmit: () => undefined }),
    );
    expect(document.querySelector('.hdu-empty-title')?.textContent).toBe('没有命中');
    expect(document.querySelector('.hdu-empty-text')?.textContent).toContain('换个关键词试试');

    // 卸载后复位为无关键词态再渲染
    await act(async () => {
      root.unmount();
    });
    document.body.innerHTML = '';
    uiStore.patch({ transcriptSearch: { query: '', results: [], loading: false } });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await renderElement(
      createElement(SearchTab, { searchText: '', setSearchText: () => undefined, onSubmit: () => undefined }),
    );
    expect(document.querySelector('.hdu-empty-title')?.textContent).toBe('在字幕中定位');
    expect(document.querySelector('.hdu-empty-text')?.textContent).toContain('输入关键词');
  });

  it('TodayTodoCard 空态：title「今日无待办」不带 emoji（告知型模板规则）', async () => {
    // 六路取数全部失败 → 各自 catch 兜底为空 → plan.totalCount = 0 → 空态分支
    callOpMock.mockRejectedValue(new Error('取数失败'));
    await renderElement(createElement(TodayTodoCard, { reloadKey: 0 }));
    expect(document.querySelector('.hdu-empty-title')?.textContent).toBe('今日无待办');
    const cardText = host.textContent ?? '';
    expect(cardText).not.toContain('🎉');
    expect(cardText).toContain('今天可以从容安排');
  });
});

describe('模板化静态核查（源码级回归锁，第 249 轮）', () => {
  it('OverviewView 与 ScheduleView 待补看空态同句（同域同状态同文案）', () => {
    const overview = readSrc('content/ui/learning/OverviewView.tsx');
    const schedule = readSrc('content/ui/learning/ScheduleView.tsx');
    for (const source of [overview, schedule]) {
      expect(source).toContain('title="没有待补看的课次"');
      expect(source).toContain('已结束的课次都有有效观看记录，或已标记为到课。');
    }
    // 旧文案不再出现
    expect(overview).not.toContain('补看清单是空的');
  });

  it('CoursesView 筛选无匹配空态补「清空搜索与筛选」CTA（引导型缺入口修齐）', () => {
    const courses = readSrc('content/ui/learning/CoursesView.tsx');
    expect(courses).toContain('清空搜索与筛选');
    // 一键复位四个筛选维度
    expect(courses).toContain("setCourseQuery('')");
    expect(courses).toContain("setStatusFilter('all')");
    expect(courses).toContain("setSemesterFilter('all')");
    expect(courses).toContain('setTeacherFilter(null)');
  });

  it('dashboard 知识库空态 title 与 LibraryView 同句 + 筛选态附「查看全部」CTA', () => {
    const dashboard = readSrc('dashboard/App.tsx');
    expect(dashboard).toContain('知识库还是空的');
    expect(dashboard).toContain('没有匹配的条目');
    expect(dashboard).toContain('查看全部');
    expect(dashboard).not.toContain('title="没有条目"');
  });

  it('EmptyState title/text 不夹 emoji（模板规则；庆祝视觉走专门元素）', () => {
    const todo = readSrc('content/ui/learning/TodayTodoCard.tsx');
    expect(todo).not.toContain('title="今日无待办 🎉"');
  });

  it('失败态重试 CTA 全仓统一 small ghost + refresh 图标（学习卡家族）', () => {
    const cases: Array<[string, string]> = [
      ['content/ui/learning/ActivityHeatmap.tsx', '<Button size="small" variant="ghost" icon="refresh" onClick={retry}>重试</Button>'],
      ['content/ui/learning/CheckinMonthCard.tsx', '<Button size="small" variant="ghost" icon="refresh" onClick={retry}>重试</Button>'],
      ['content/ui/learning/MilestoneWall.tsx', '<Button size="small" variant="ghost" icon="refresh" onClick={retry}>重试</Button>'],
      ['content/ui/learning/ReviewView.tsx', '<Button size="small" variant="ghost" icon="refresh" onClick={() => void load()}>重试</Button>'],
      ['content/ui/BiliHubTodayCard.tsx', '<Button size="small" variant="ghost" icon="refresh" onClick={() => void load()}>重试</Button>'],
      ['content/ui/learning/TimeOfDayCard.tsx', 'icon="refresh"'],
    ];
    for (const [rel, needle] of cases) {
      expect(readSrc(rel)).toContain(needle);
    }
    // 旧的默认尺寸重试钮（无 size/variant）在五处修齐点不再出现
    expect(readSrc('content/ui/learning/ActivityHeatmap.tsx')).not.toContain('action={<Button onClick={retry}>重试</Button>}');
  });
});
