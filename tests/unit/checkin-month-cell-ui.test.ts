/**
 * 打卡月历可点击格 + 共享当日明细弹层渲染测试（jsdom + react-dom 客户端渲染，
 * 无 JSX、直接 createElement，照 milestone-wall-ui.test.ts 桩模式；callOp 整体 mock）。
 *
 * 覆盖第 236 轮新增的行为约定：
 *  1. 有学习的格子（is-hit / is-partial）渲染为 button.is-clickable：aria-label
 *     「N 月 N 日学习 X 分钟，已打卡 / 未达标」、title 提效在位；
 *  2. 补位格（is-out）/ 未来格（is-future）/ 无学习格不可点（disabled，无 aria-label）；
 *  3. 点击 is-hit 格 → 复用共享 DayDetailModal：stats.dayDetail 按该日取数，
 *     弹层标题「MM-DD 学习明细」，明细行渲染（热力图同款数据流，第 236 轮共享化）；
 *  4. 关闭弹层 → 再次点击 is-partial 格 → 换日取数（弹层数据流随格子复用）。
 *
 * 注：组件以 localDayKey() 现取「今天」，桩数据按真实当天动态构造（当日 7200s ≥
 * 打卡线 → is-hit），任意日期运行均稳定。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { CheckinMonthCard } from '@/entrypoints/content/ui/learning/CheckinMonthCard';
import { localDayKey } from '@/core/shared/utils';
import type { DayDetailReport } from '@/core/stats/heatmap';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

const TODAY = localDayKey();
/** 上月 1 日（today 为当月 1 日的边界下，当月无 is-partial，导航上月后必有） */
const PREV_MONTH_FIRST = localDayKey((() => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return d;
})());
/** 桩：今天 2h（≥ 打卡线 → is-hit）、昨天 5 分钟与上月 1 日 5 分钟（>0 且 < 打卡线 → is-partial） */
const STUB_DAYS = [
  { date: TODAY, validSec: 7200 },
  { date: localDayKey(new Date(new Date().getTime() - 86_400_000)), validSec: 300 },
  { date: PREV_MONTH_FIRST, validSec: 300 },
];

/** dayDetail 桩：按日返回站内一行（带回看字段）+ 站外空——今天 2h，其余（is-partial 日）5 分钟 */
function stubCallOp(): void {
  callOpMock.mockImplementation((op: string, args: { date?: string }) => {
    if (op === 'stats.report') return Promise.resolve({ days: STUB_DAYS });
    if (op === 'stats.dayDetail') {
      const date = args?.date ?? TODAY;
      const seconds = date === TODAY ? 7200 : 300;
      return Promise.resolve<DayDetailReport>({
        date,
        internal: [{ label: '高等数学（E2E）', sub: '第1讲', seconds, valid: true, courId: 1, teclId: 11 }],
        external: [],
        internalSec: seconds,
        externalSec: 0,
      });
    }
    return Promise.reject(new Error(`unexpected op: ${op}`));
  });
}

let host: HTMLElement;
let root: Root;

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
  // 放行 useEffect 内的 callOp promise
  await act(async () => {});
}

/** 从月历中取指定状态的格子（querySelector 单数语义，供可读断言） */
function cellOf(state: string): HTMLButtonElement | null {
  return host.querySelector(`.hdu-checkin-cell.${state}`) as HTMLButtonElement | null;
}

/** 拿到一个可点的 is-partial 格：当月没有（如今天是 1 日）则导航上一月——
 *  上月 1 日恒为「非未来 + 有学习未达标」，保证任意日期运行都稳定 */
async function ensurePartialCell(): Promise<HTMLButtonElement | null> {
  let partial = cellOf('is-partial');
  if (partial) return partial;
  await act(async () => {
    (host.querySelector('[aria-label="上一月"]') as HTMLButtonElement | null)?.click();
  });
  await act(async () => {});
  return cellOf('is-partial');
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  callOpMock.mockReset();
  stubCallOp();
});

afterEach(() => {
  act(() => root.unmount());
});

describe('打卡月历可点击格（第 236 轮巡检）', () => {
  it('有学习的格子为 button.is-clickable：aria-label 含分钟数与打卡态', async () => {
    await renderElement(createElement(CheckinMonthCard, null));

    const hit = cellOf('is-hit');
    expect(hit).toBeTruthy();
    expect(hit!.tagName).toBe('BUTTON');
    expect(hit!.className).toContain('is-clickable');
    // aria-label：「N 月 N 日学习 X 分钟，已打卡」（7200s → 120 分钟）
    const month = Number(TODAY.slice(5, 7));
    const day = Number(TODAY.slice(8, 10));
    expect(hit!.getAttribute('aria-label')).toBe(`${month} 月 ${day} 日学习 120 分钟，已打卡`);
    expect(hit!.getAttribute('title')).toContain('2 小时');

    // 昨天（或上月 1 日）5 分钟：is-partial 同样可点，aria-label 为「未达标」
    const partial = await ensurePartialCell();
    expect(partial).toBeTruthy();
    expect(partial!.tagName).toBe('BUTTON');
    expect(partial!.getAttribute('aria-label')).toContain('学习 5 分钟，未达标');
  });

  it('不可点格：is-out 补位 / is-future / 无学习格 disabled 且无 aria-label', async () => {
    await renderElement(createElement(CheckinMonthCard, null));

    const disabled = [...host.querySelectorAll('button.hdu-checkin-cell:disabled')];
    // 补位格（前后月）在多数月份存在；断言其全部 disabled、无 aria-label
    for (const out of host.querySelectorAll('button.hdu-checkin-cell.is-out')) {
      expect((out as HTMLButtonElement).disabled).toBe(true);
      expect(out.getAttribute('aria-label')).toBeNull();
    }
    // 未来格（本月剩余日）同样 disabled；今天之后的月份才无未来日，断言宽松为「存在即 disabled」
    for (const future of host.querySelectorAll('button.hdu-checkin-cell.is-future')) {
      expect((future as HTMLButtonElement).disabled).toBe(true);
    }
    // disabled 集至少覆盖全部 is-out；其余 disabled 格为未来/无学习日
    expect(disabled.length).toBeGreaterThanOrEqual(host.querySelectorAll('button.hdu-checkin-cell.is-out').length);
  });

  it('点击 is-hit 格 → 共享 DayDetailModal：stats.dayDetail 按日取数、标题与明细行渲染', async () => {
    await renderElement(createElement(CheckinMonthCard, null));
    const hit = cellOf('is-hit');
    expect(hit).toBeTruthy();

    await act(async () => {
      hit!.click();
    });
    await act(async () => {});

    // 取数路径与热力图同款：stats.dayDetail + 该日日键
    expect(callOpMock).toHaveBeenCalledWith('stats.dayDetail', { date: TODAY });
    const title = host.querySelector('.hdu-modal-title');
    expect(title?.textContent).toContain(`${TODAY.slice(5, 7)}-${TODAY.slice(8, 10)}`);
    expect(title?.textContent).toContain('学习明细');
    const body = host.querySelector('.hdu-modal-body');
    expect(body?.textContent).toContain('高等数学（E2E）');
    expect(body?.textContent).toContain('回看');

    // 关闭弹层后弹层卸载
    await act(async () => {
      (host.querySelector('[aria-label="关闭"]') as HTMLButtonElement | null)?.click();
    });
    expect(host.querySelector('.hdu-modal-title')).toBeNull();
  });

  it('关闭后点 is-partial 格 → 换日取数（弹层数据流随格子复用）', async () => {
    await renderElement(createElement(CheckinMonthCard, null));
    const partial = await ensurePartialCell();
    expect(partial).toBeTruthy();

    await act(async () => {
      partial!.click();
    });
    await act(async () => {});

    // 取数为该格日键（合法日键即可——今天=1 日边界下会导航上月，日期动态）
    expect(callOpMock).toHaveBeenLastCalledWith('stats.dayDetail', {
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(host.querySelector('.hdu-modal-title')?.textContent).toContain('学习明细');
    // 站内行 300s（5 分钟）渲染；站外桶为空不渲染「站外视频」分组头
    expect(host.querySelector('.hdu-modal-body')?.textContent).toContain('5 分钟');
  });
});
