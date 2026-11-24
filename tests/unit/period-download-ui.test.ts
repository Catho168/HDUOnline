/**
 * 周报 / 月报卡「下载周报/月报」按钮渲染与行为测试（jsdom + react-dom 客户端渲染，
 * 照 stats-period-ui.test.ts 桩模式；callOp 整体 mock + mock URL.createObjectURL /
 * revokeObjectURL）。
 *
 * 覆盖第 239 轮新增的行为约定：
 *  1. 默认周报视图按钮文案「下载周报」，点击经 download.ts 单点实现触发 Blob 下载：
 *     文件名带数据窗口（HDUOnline周报_<首桶开始日>_<末桶结束日>.md），Markdown 正文
 *     为完整档（标题「# 学习周报（近 1 周）」+ 全部周期桶 + 成就附录）；
 *  2. 成功 toast「已生成 <文件名>」（ToastHost 同挂渲染）；
 *  3. 切「本月」后按钮联动「下载月报」，文件名切月报格式（YYYY-MM _ MM-DD）；
 *  4. createObjectURL 抛错 → 失败 toast「下载失败…」、不崩溃。
 */
// @vitest-environment jsdom

import { createElement, Fragment, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { PeriodReportCard } from '@/entrypoints/content/ui/LearningCenter';
import { ToastHost } from '@/entrypoints/content/ui/components';
import { dayKeyToTs } from '@/core/shared/utils';
import type { PeriodReport } from '@/core/stats/period';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

const WEEK_REPORT: PeriodReport = {
  kind: 'week',
  count: 1,
  todayKey: '2026-11-16',
  buckets: [
    {
      key: '2026-11-16',
      label: '11.16–11.22',
      chartLabel: '11.16',
      kind: 'week',
      startDay: '2026-11-16',
      endDay: '2026-11-22',
      startTs: dayKeyToTs('2026-11-16'),
      endTs: dayKeyToTs('2026-11-23'),
      internalSec: 9000,
      externalSec: 600,
      activeDays: 3,
      flowCount: 12,
      plan: null,
    },
  ],
  totalInternalSec: 9000,
  totalExternalSec: 600,
  generatedAt: dayKeyToTs('2026-11-16') + 20 * 3600_000,
};

const MONTH_REPORT: PeriodReport = {
  kind: 'month',
  count: 1,
  todayKey: '2026-11-21',
  buckets: [
    {
      key: '2026-11',
      label: '2026年11月',
      chartLabel: '11月',
      kind: 'month',
      startDay: '2026-11-01',
      endDay: '2026-11-30',
      startTs: dayKeyToTs('2026-11-01'),
      endTs: dayKeyToTs('2026-12-01'),
      internalSec: 3600,
      externalSec: 900,
      activeDays: 4,
      flowCount: 9,
      review: null,
    },
  ],
  totalInternalSec: 3600,
  totalExternalSec: 900,
  generatedAt: WEEK_REPORT.generatedAt,
};

const createObjectURLMock = vi.fn((..._args: unknown[]) => createImpl());
const revokeObjectURLMock = vi.fn((..._args: unknown[]) => undefined);

/** createObjectURL 的可替换实现（失败用例注入抛错） */
let createImpl: () => string = () => 'blob:mock-url';

function stubUrl(impl?: () => string): void {
  if (impl) createImpl = impl;
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURLMock });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revokeObjectURLMock });
}

/** jsdom Blob 无 .text()，经 FileReader.readAsText 解出内容（内容断言用） */
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsText(blob);
  });
}

let host: HTMLElement;
let root: Root;

/** stats.period 依序返回队列中的报告；其余 op 一律 null（组件内已有 Array.isArray 守卫） */
function wirePeriodQueue(queue: PeriodReport[]): void {
  callOpMock.mockReset();
  callOpMock.mockImplementation((op: string) => {
    if (op === 'stats.period') return Promise.resolve(queue.length > 0 ? queue.shift() : MONTH_REPORT);
    return Promise.resolve(null);
  });
}

async function renderCard(): Promise<void> {
  await act(async () => {
    root.render(createElement(Fragment, null, createElement(PeriodReportCard), createElement(ToastHost)));
  });
  await act(async () => {});
}

function buttonByLabel(label: string): HTMLButtonElement {
  const el = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === label);
  if (!el) throw new Error(`button not found: ${label}`);
  return el;
}

async function clickButton(label: string): Promise<void> {
  await act(async () => {
    buttonByLabel(label).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await act(async () => {});
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  createImpl = () => 'blob:mock-url';
  createObjectURLMock.mockClear();
  revokeObjectURLMock.mockClear();
  stubUrl();
});

afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
});

describe('周报 / 月报卡下载按钮（第 239 轮巡检）', () => {
  it('默认周报视图「下载周报」→ 文件名带数据窗口，Markdown 为完整档，成功 toast「已生成 …」', async () => {
    wirePeriodQueue([WEEK_REPORT]);
    await renderCard();

    const btn = buttonByLabel('下载周报');
    expect(btn.className).toContain('ghost');

    const anchors: HTMLAnchorElement[] = [];
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = origCreate(tag);
      if (tag === 'a') anchors.push(el as HTMLAnchorElement);
      return el;
    }) as typeof document.createElement);

    await clickButton('下载周报');

    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.download).toBe('HDUOnline周报_2026-11-16_11-22.md');
    expect(anchors[0]!.href).toBe('blob:mock-url');
    const blob = createObjectURLMock.mock.calls[0]![0] as Blob;
    const text = await blobText(blob);
    expect(text).toContain('# 学习周报（近 1 周）'); // 完整档标题（全部周期桶 + 成就附录同在）
    expect(text).toContain('11.16–11.22'); // 周期明细行直出
    expect(host.textContent).toContain('已生成 HDUOnline周报_2026-11-16_11-22.md');
  });

  it('切「本月」后按钮联动「下载月报」，文件名切月报格式（YYYY-MM _ MM-DD）', async () => {
    wirePeriodQueue([WEEK_REPORT, MONTH_REPORT]);
    await renderCard();

    const pills = Array.from(host.querySelectorAll<HTMLButtonElement>('.hdu-pill-tab'));
    await act(async () => {
      pills.find((b) => b.textContent === '本月')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await act(async () => {});
    expect(buttonByLabel('下载月报')).toBeTruthy();

    const anchors: HTMLAnchorElement[] = [];
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = origCreate(tag);
      if (tag === 'a') anchors.push(el as HTMLAnchorElement);
      return el;
    }) as typeof document.createElement);

    await clickButton('下载月报');
    expect(anchors[0]!.download).toBe('HDUOnline月报_2026-11_11-30.md');
  });

  it('createObjectURL 抛错 → 失败 toast（下载失败，请重试或改用「复制摘要」）且不崩溃', async () => {
    wirePeriodQueue([WEEK_REPORT]);
    stubUrl(() => {
      throw new Error('quota');
    });
    await renderCard();

    await clickButton('下载周报');
    expect(host.textContent).toContain('下载失败，请重试或改用「复制摘要」');
    // 卡面主体仍在（未因下载失败崩溃）
    expect(host.textContent).toContain('学习周报');
  });
});
