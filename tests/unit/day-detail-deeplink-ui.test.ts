/**
 * DayDetailModal 课程行深链核对测试（第 249 轮巡检，深链域 / 导航可靠性视角）：
 *  1. 数据窗口锁定：stats.dayDetail 仅按 { date } 取数（第 236 轮共享化后三入口
 *     —— 热力图 ActivityHeatmap / 打卡月历 CheckinMonthCard / 里程碑墙 MilestoneWall
 *     —— 共用同一 Modal 与同一取数路径，无各入口的窗口差异参数）；
 *  2. onOpenCourse 透传：站内行「回看」点击 → onOpenCourse(courId, teclId) 原样回传
 *     （B 站宿主 openHduSession / dashboard 新标签深链覆写都走这条通道）；
 *  3. 缺省链路：未传 onOpenCourse 时走 uiStore.actions.openSessionInSite（HDU 学习
 *     中心站内语义：hash 切 play-center 路由）；站外行走 <a target="_blank">；
 *  4. 三入口接线静态锁：三个入口文件对 DayDetailModal 的 props 仅有
 *     date/onClose(/onOpenCourse)，dashboard 以 onOpenCourse 覆写为新标签深链
 *     （第 249 轮修：看板无内容脚本 uiStore 实现，缺省 openSessionInSite 为 noop）。
 *
 * jsdom + react-dom 客户端渲染，无 JSX、直接 createElement（照 milestone-wall-ui.test.ts 模式）。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { DayDetailModal } from '@/entrypoints/content/ui/learning/DayDetailModal';
import { uiStore } from '@/entrypoints/content/ui/store';
import type { DayDetailReport } from '@/core/stats/heatmap';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

const SRC_ROOT = 'src/entrypoints';
const readSrc = (rel: string): string => readFileSync(`${SRC_ROOT}/${rel}`, 'utf8');

/** 单日明细桩：站内一行（courId=42, teclId=7）+ 站外一行（url） */
function stubReport(): DayDetailReport {
  return {
    date: '2026-11-20',
    internal: [{ label: '高等数学 · 第 3 讲', sub: '课次 3', seconds: 1200, valid: true, courId: 42, teclId: 7 }],
    external: [{ label: '站外视频 A', sub: 'B 站', seconds: 600, valid: true, url: 'https://www.bilibili.com/video/BV1xx' }],
    internalSec: 1200,
    externalSec: 600,
  };
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
});

describe('DayDetailModal 深链链路（第 249 轮核对回归）', () => {
  it('数据窗口锁定：stats.dayDetail 仅按 { date } 取数，无各入口差异参数', async () => {
    callOpMock.mockResolvedValue(stubReport());
    await renderElement(
      createElement(DayDetailModal, { date: '2026-11-20', onClose: () => undefined, onOpenCourse: () => undefined }),
    );
    expect(callOpMock).toHaveBeenCalledTimes(1);
    const [op, args] = callOpMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(op).toBe('stats.dayDetail');
    expect(args).toEqual({ date: '2026-11-20' });
    expect(Object.keys(args)).toEqual(['date']);
    // 明细行渲染（站内 + 站外两桶）
    expect(host.textContent).toContain('高等数学 · 第 3 讲');
    expect(host.textContent).toContain('站外视频 A');
  });

  it('站内行「回看」点击 → onOpenCourse(courId, teclId) 原样透传（覆写通道）', async () => {
    callOpMock.mockResolvedValue(stubReport());
    const onOpenCourse = vi.fn();
    await renderElement(
      createElement(DayDetailModal, { date: '2026-11-20', onClose: () => undefined, onOpenCourse }),
    );
    const play = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('回看'));
    expect(play).toBeTruthy();
    await act(async () => {
      play!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await act(async () => {});
    expect(onOpenCourse).toHaveBeenCalledTimes(1);
    expect(onOpenCourse).toHaveBeenCalledWith(42, 7);
  });

  it('缺省链路：未传 onOpenCourse 时走 uiStore.actions.openSessionInSite（HDU 站内语义）', async () => {
    callOpMock.mockResolvedValue(stubReport());
    const spy = vi.fn();
    const original = uiStore.actions.openSessionInSite;
    uiStore.actions.openSessionInSite = spy;
    try {
      await renderElement(createElement(DayDetailModal, { date: '2026-11-20', onClose: () => undefined }));
      const play = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('回看'));
      expect(play).toBeTruthy();
      await act(async () => {
        play!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      await act(async () => {});
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(42, 7);
    } finally {
      uiStore.actions.openSessionInSite = original;
    }
  });

  it('站外行不给「回看」，渲染新标签 <a> 深链（href 原样、noopener）', async () => {
    callOpMock.mockResolvedValue(stubReport());
    await renderElement(
      createElement(DayDetailModal, { date: '2026-11-20', onClose: () => undefined, onOpenCourse: () => undefined }),
    );
    const link = document.querySelector('.hdu-modal a.hdu-btn');
    expect(link).toBeTruthy();
    expect(link!.getAttribute('href')).toBe('https://www.bilibili.com/video/BV1xx');
    expect(link!.getAttribute('target')).toBe('_blank');
    expect(link!.getAttribute('rel')).toContain('noopener');
  });
});

describe('三入口接线静态锁（第 249 轮深链核对）', () => {
  it('三入口对 DayDetailModal 的 props 只有 date/onClose(/onOpenCourse)——共享化后未漂移', () => {
    const heatmap = readSrc('content/ui/learning/ActivityHeatmap.tsx');
    const checkin = readSrc('content/ui/learning/CheckinMonthCard.tsx');
    const milestone = readSrc('content/ui/learning/MilestoneWall.tsx');
    // 热力图：透传自身 onOpenCourse prop（HDU 宿主缺省 / B 站宿主覆写）
    expect(heatmap).toContain('<DayDetailModal date={detailDate} onClose={() => setDetailDate(null)} onOpenCourse={onOpenCourse} />');
    // 打卡月历 / 里程碑墙：缺省链路（HDU 学习中心专属，uiStore 站内跳转）
    expect(checkin).toContain('<DayDetailModal date={detailDate} onClose={() => setDetailDate(null)} />');
    expect(milestone).toContain('<DayDetailModal date={detailDate} onClose={() => setDetailDate(null)} />');
    // 三处取数窗口都收在 DayDetailModal 内（入口不再自调 stats.dayDetail）
    expect(checkin.includes("callOp('stats.dayDetail'")).toBe(false);
    expect(milestone.includes("callOp('stats.dayDetail'")).toBe(false);
  });

  it('dashboard 以 onOpenCourse 覆写为新标签深链（第 249 轮修断链：缺省 noop 无响应）', () => {
    const dashboard = readSrc('dashboard/App.tsx');
    expect(dashboard).toContain('onOpenCourse=');
    expect(dashboard).toContain('lessonHash({ courId, teclId, prefer:');
    expect(dashboard).toContain('window.open(');
  });
});
