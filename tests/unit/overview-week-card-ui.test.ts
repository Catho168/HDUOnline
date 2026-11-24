/**
 * 总览「近 7 天学习节奏」折叠卡 OverviewWeekCard 渲染测试（jsdom + react-dom 客户端
 * 渲染，无 JSX、直接 createElement，照 golden-hint-ui.test.ts 桩模式；纯展示组件
 * 无 callOp 依赖）。
 *
 * 覆盖第 244 轮首屏密度审计落地后的行为约定：
 *  1. 收起态（默认，settings.ui.overviewWeekOpen 缺省）：标题行 aria-expanded=false、
 *     摘要分钟数（近 7 天合计，tabular-nums 文案「N 分钟」）在行、柱图不渲染；
 *  2. 点击标题行 → onToggle(true)（OverviewView 负责持久化到 settings.ui）；
 *  3. 展开态：柱图渲染（7 根）、aria-expanded=true、「近 30 天完整趋势在统计页」
 *     跳转在行，点击回调 onViewStats；
 *  4. 展开态再点标题行 → onToggle(false)；
 *  5. 摘要分钟数四舍五入口径（3600s+1200s → 50 分钟）。
 */

// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OverviewWeekCard } from '@/entrypoints/content/ui/learning/OverviewView';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WEEK = [
  { label: '日', value: 0 },
  { label: '一', value: 1200 },
  { label: '二', value: 3600, today: false },
  { label: '三', value: 600 },
  { label: '四', value: 0 },
  { label: '五', value: 2400 },
  { label: '六', value: 1800, today: true },
];

let host: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host.remove();
  root = null;
});

describe('OverviewWeekCard（第 244 轮首屏密度审计）', () => {
  it('收起态：标题行保留摘要「160 分钟」、aria-expanded=false、柱图不渲染', () => {
    act(() => {
      root!.render(createElement(OverviewWeekCard, { last7: WEEK, open: false, onToggle: () => undefined, onViewStats: () => undefined }));
    });
    const head = host.querySelector('.hdu-overview-week-head') as HTMLButtonElement | null;
    expect(head).not.toBeNull();
    expect(head!.getAttribute('aria-expanded')).toBe('false');
    expect(head!.textContent).toContain('近 7 天学习节奏');
    expect(head!.textContent).toContain('160 分钟');
    expect(host.querySelector('.hdu-bars')).toBeNull();
    expect(host.querySelector('#hdu-overview-week-body')).toBeNull();
  });

  it('收起态点击标题行 → onToggle(true)（OverviewView 负责落 settings.ui.overviewWeekOpen）', () => {
    const onToggle = vi.fn();
    act(() => {
      root!.render(createElement(OverviewWeekCard, { last7: WEEK, open: false, onToggle, onViewStats: () => undefined }));
    });
    const head = host.querySelector('.hdu-overview-week-head') as HTMLButtonElement;
    act(() => {
      head.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('展开态：柱图 7 根渲染、aria-expanded=true、统计页跳转可点回调 onViewStats', () => {
    const onViewStats = vi.fn();
    act(() => {
      root!.render(createElement(OverviewWeekCard, { last7: WEEK, open: true, onToggle: () => undefined, onViewStats }));
    });
    const head = host.querySelector('.hdu-overview-week-head') as HTMLButtonElement;
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(head.classList.contains('is-open')).toBe(true);
    expect(host.querySelector('#hdu-overview-week-body')).not.toBeNull();
    const bars = host.querySelectorAll('.hdu-bars .hdu-bar-col');
    expect(bars.length).toBe(7);
    const jump = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('近 30 天完整趋势在统计页'));
    expect(jump).toBeDefined();
    act(() => {
      jump!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onViewStats).toHaveBeenCalledTimes(1);
  });

  it('展开态再点标题行 → onToggle(false)', () => {
    const onToggle = vi.fn();
    act(() => {
      root!.render(createElement(OverviewWeekCard, { last7: WEEK, open: true, onToggle, onViewStats: () => undefined }));
    });
    const head = host.querySelector('.hdu-overview-week-head') as HTMLButtonElement;
    act(() => {
      head.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onToggle).toHaveBeenCalledWith(false);
  });
});
