/**
 * 学习里程碑时间线墙渲染测试（jsdom + react-dom 客户端渲染，无 JSX、直接 createElement，
 * 照 today-celebrate.test.ts 桩模式；callOp 整体 mock）。
 *
 * 覆盖第 235 轮新增的行为约定：
 *  1. stats.report 返回 days[] → .hdu-milestone-row 时间轴行按回放结果渲染
 *     （data-kind 标注、标题/说明文案、「共 X 个里程碑」foot）；
 *  2. days 为空数组 → 空态「继续学习，第一个里程碑就在前方」；
 *  3. 取数失败 → 失败态「里程碑暂不可用」+ 重试按钮，点击重试重新拉取（attempt 递增）。
 *
 * 第 236 轮追加：foot「复制里程碑」按钮（成功进剪贴板 / 剪贴板拒绝回可用态）。
 * 第 237 轮追加：里程碑行 button 语义（aria-label 带日期）+ 行点击下钻共享
 * DayDetailModal（stats.dayDetail 按里程碑日取数、弹层可关闭、时间轴不受影响）。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const copyTextMock = copyTextToClipboard as unknown as Mock;

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));
vi.mock('@/entrypoints/content/ui/clipboard', () => ({ copyTextToClipboard: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { copyTextToClipboard } from '@/entrypoints/content/ui/clipboard';
import { MilestoneWall } from '@/entrypoints/content/ui/learning/MilestoneWall';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

/** 两天学习：11-01 打卡（恰达 10 分钟线）、11-02 跨累计 1h + 单日新高 */
const STUB_DAYS = [
  { date: '2026-11-01', validSec: 600 },
  { date: '2026-11-02', validSec: 7200 },
];

let host: HTMLElement;
let root: Root;

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
  // 放行 useEffect 内的 callOp promise
  await act(async () => {});
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
});

describe('学习里程碑时间线墙渲染（第 235 轮巡检）', () => {
  it('按回放结果渲染时间轴行：data-kind、标题说明与里程碑总数 foot', async () => {
    callOpMock.mockResolvedValue({ days: STUB_DAYS });
    await renderElement(createElement(MilestoneWall, null));

    const rows = host.querySelectorAll('.hdu-milestone-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.getAttribute('data-kind')).toBe('checkin');
    expect(rows[0]!.textContent).toContain('首次打卡');
    expect(rows[1]!.getAttribute('data-kind')).toBe('cumulative');
    expect(rows[1]!.textContent).toContain('累计学习 1 小时');
    expect(rows[2]!.getAttribute('data-kind')).toBe('daily');
    expect(rows[2]!.textContent).toContain('单日学习新高');
    // 节点圆点 + 时间轴布局骨架存在
    expect(host.querySelectorAll('.hdu-milestone-dot').length).toBe(3);
    expect(host.querySelector('.hdu-milestone-date')?.textContent).toBe('11/01');
    expect(host.textContent).toContain('共 3 个里程碑');
    // 取数路径与打卡月历卡一致：stats.report + 400 天窗口
    expect(callOpMock).toHaveBeenCalledWith('stats.report', { days: 400 });
  });

  it('空数据渲染空态「继续学习，第一个里程碑就在前方」', async () => {
    callOpMock.mockResolvedValue({ days: [] });
    await renderElement(createElement(MilestoneWall, null));
    expect(host.querySelectorAll('.hdu-milestone-row')).toHaveLength(0);
    expect(host.textContent).toContain('继续学习，第一个里程碑就在前方');
  });

  it('取数失败渲染失败态与重试按钮，点击重试重新拉取', async () => {
    callOpMock.mockRejectedValue(new Error('boom'));
    await renderElement(createElement(MilestoneWall, null));
    expect(host.textContent).toContain('里程碑暂不可用');

    // 切换为成功桩，点击「重试」→ attempt 递增 → 同一 effect 重新拉取
    callOpMock.mockResolvedValue({ days: STUB_DAYS });
    const retry = [...host.querySelectorAll('button')].find((b) => b.textContent === '重试');
    expect(retry).toBeTruthy();
    await act(async () => {
      retry!.click();
    });
    await act(async () => {});

    expect(callOpMock).toHaveBeenCalledTimes(2);
    expect(host.querySelectorAll('.hdu-milestone-row')).toHaveLength(3);
  });

  it('foot 渲染「复制里程碑」按钮：点击 → buildMilestoneShareText 文案进剪贴板（第 236 轮）', async () => {
    copyTextMock.mockResolvedValue(true);
    callOpMock.mockResolvedValue({ days: STUB_DAYS });
    await renderElement(createElement(MilestoneWall, null));

    // foot 行：左计数 hint + 右 ghost 复制按钮
    const foot = host.querySelector('.hdu-milestone-foot');
    expect(foot?.textContent).toContain('共 3 个里程碑');
    const copyBtn = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('复制里程碑'));
    expect(copyBtn).toBeTruthy();

    await act(async () => {
      copyBtn!.click();
    });
    await act(async () => {});

    // 分享文案（第 238 轮排版）：标题行 🏆（未截断不附「展示最近」）+ 空行分组 +
    // 逐行「日期 标题 · detail」（行集与第 236 轮一致）
    expect(copyTextMock).toHaveBeenCalledTimes(1);
    const text = String(copyTextMock.mock.calls[0]![0]);
    expect(text.split('\n')).toEqual([
      '🏆 学习里程碑（共 3 个）',
      '',
      '2026-11-01 首次打卡 · 当日有效 10 分钟',
      '2026-11-02 累计学习 1 小时 · 当日累计 2 小时 10 分',
      '2026-11-02 单日学习新高 · 单日 2 小时',
    ]);
  });

  it('复制失败（剪贴板拒绝）按钮回到可用态，不抛错（第 236 轮）', async () => {
    copyTextMock.mockResolvedValue(false);
    callOpMock.mockResolvedValue({ days: STUB_DAYS });
    await renderElement(createElement(MilestoneWall, null));
    const copyBtn = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('复制里程碑'));

    await act(async () => {
      copyBtn!.click();
    });
    await act(async () => {});

    expect(copyTextMock).toHaveBeenCalledTimes(1);
    // loading 态已复位（按钮未被 disabled 卡死），时间轴不受影响
    expect((copyBtn as HTMLButtonElement).disabled).toBe(false);
    expect(host.querySelectorAll('.hdu-milestone-row')).toHaveLength(3);
  });
});

describe('里程碑行点击下钻（第 237 轮巡检）', () => {
  it('里程碑行为 button 语义：aria-label 带日期（打开 N 月 N 日学习明细）', async () => {
    callOpMock.mockResolvedValue({ days: STUB_DAYS });
    await renderElement(createElement(MilestoneWall, null));

    const btns = [...host.querySelectorAll('.hdu-milestone-btn')] as HTMLButtonElement[];
    expect(btns).toHaveLength(3);
    expect(btns[0]!.tagName).toBe('BUTTON');
    expect(btns[0]!.getAttribute('aria-label')).toBe('打开 11 月 1 日学习明细');
    expect(btns[1]!.getAttribute('aria-label')).toBe('打开 11 月 2 日学习明细');
    // 可点暗示指示符（muted「›」）与行内右侧箭头列存在
    expect(host.querySelector('.hdu-milestone-arrow')?.textContent).toBe('›');
  });

  it('点击里程碑行 → 共享 DayDetailModal：stats.dayDetail 按该里程碑日取数、弹层可关闭', async () => {
    callOpMock.mockImplementation((op: string, args?: { date?: string }) => {
      if (op === 'stats.report') return Promise.resolve({ days: STUB_DAYS });
      if (op === 'stats.dayDetail') {
        const date = args?.date ?? '2026-11-01';
        return Promise.resolve({
          date,
          internal: [{ label: '高等数学（E2E）', sub: '第1讲', seconds: 600, valid: true, courId: 1, teclId: 11 }],
          external: [],
          internalSec: 600,
          externalSec: 0,
        });
      }
      return Promise.reject(new Error(`unexpected op: ${op}`));
    });
    await renderElement(createElement(MilestoneWall, null));

    // 点击首行（2026-11-01 首次打卡）→ 热力图 / 打卡月历同款共享弹层
    const btn = host.querySelector('.hdu-milestone-btn') as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    await act(async () => {});

    expect(callOpMock).toHaveBeenCalledWith('stats.dayDetail', { date: '2026-11-01' });
    const title = host.querySelector('.hdu-modal-title');
    expect(title?.textContent).toContain('11-01');
    expect(title?.textContent).toContain('学习明细');
    expect(host.querySelector('.hdu-modal-body')?.textContent).toContain('高等数学（E2E）');

    // 关闭弹层 → 卸载；时间轴行不受弹层开合影响（骨架 / 重试态互不冲突）
    await act(async () => {
      (host.querySelector('[aria-label="关闭"]') as HTMLButtonElement | null)?.click();
    });
    await act(async () => {});
    expect(host.querySelector('.hdu-modal-title')).toBeNull();
    expect(host.querySelectorAll('.hdu-milestone-btn')).toHaveLength(3);
  });
});
