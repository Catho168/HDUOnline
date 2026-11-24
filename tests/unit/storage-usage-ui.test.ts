/**
 * 设置页「存储用量」行渲染测试（第 254 轮，存储健康域 / 透明度视角；jsdom + react-dom
 * 客户端渲染，无 JSX 直接 createElement，callOp 整体 mock，照 data-export-ui.test.ts 桩模式）。
 *
 * 覆盖：
 *  1. 三段式排版：当前用量 / 浏览器配额 / 预估月增长（按近 30 天流水日均粗估）渲染与
 *     formatBytes 口径（MB 一位小数 / GB 两位小数）；
 *  2. 4px 细进度条：用量/配额占比渲染，超 80% 加 .warn（gold 预警档）；
 *  3. storage.estimate 返回 null（浏览器限制）→ 如实显示「无法获取（浏览器限制）」，
 *     不误读为 0 字节；
 *  4. 刷新按钮重取数据（挂载一次 + 行内刷新按钮的取数节奏）。
 */

// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { DataSection } from '@/entrypoints/options/App';
import { DEFAULT_SETTINGS } from '@/core/shared/constants';
import type { AppSettings, WatchRecordEntity } from '@/core/shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

/** 近 30 天流水固件：45 条（日均 1.5 → 月增量 45 条 · 45×200=9000B ≈ 8.8 KB） */
function makeRecords(count: number): WatchRecordEntity[] {
  return Array.from({ length: count }, (_, i) => ({
    courId: 1,
    teclId: 1,
    date: '2026-11-20',
    startTs: i,
    endTs: i + 1,
    durationSec: 30,
    playMode: 'vod' as const,
    speed: 1,
    firstWatch: false,
    valid: true,
  }));
}

let host: HTMLElement;
let root: Root;

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
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

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = '';
});

function stubOps(estimate: unknown, records: WatchRecordEntity[]): void {
  callOpMock.mockImplementation(async (op: string) => {
    switch (op) {
      case 'storage.usage':
        return { indexedDbBytes: 1, opfsBytes: 0, quotaBytes: 1, screenshotCount: 0, transcriptCount: 0, modelCached: false };
      case 'storage.estimate':
        if (estimate instanceof Error) throw estimate;
        return estimate;
      case 'stats.records':
        return records;
      default:
        return [];
    }
  });
}

describe('设置页存储用量行（第 254 轮）', () => {
  const settings = { ...DEFAULT_SETTINGS } as AppSettings;

  it('三段式渲染：当前用量 MB / 配额 GB / 预估月增长（条数 · 粗估体积）', async () => {
    stubOps({ usage: 612_000_000, quota: 120_000_000_000 }, makeRecords(45));
    await renderElement(
      createElement(DataSection, { settings, patchSettings: vi.fn(async () => undefined), notify: vi.fn() }),
    );
    expect(host.textContent).toContain('存储用量');
    expect(host.textContent).toContain('583.6 MB'); // 612000000 B → 583.648… MB 一位小数
    expect(host.textContent).toContain('111.76 GB'); // 120000000000 B → GB 两位小数
    expect(host.textContent).toContain('45 条 · 约 8.8 KB'); // 日均 1.5 × 30 × 200B
    expect(host.textContent).toContain('粗估');
    // 三段标签在场
    expect(host.textContent).toContain('当前用量');
    expect(host.textContent).toContain('浏览器配额');
    expect(host.textContent).toContain('预估月增长');
  });

  it('用量/配额 > 80% → 进度条转 gold 预警档（.warn）', async () => {
    stubOps({ usage: 100_000_000_000, quota: 120_000_000_000 }, []);
    await renderElement(
      createElement(DataSection, { settings, patchSettings: vi.fn(async () => undefined), notify: vi.fn() }),
    );
    const meter = host.querySelector<HTMLElement>('.hdu-storage-meter');
    expect(meter).toBeDefined();
    expect(meter!.className).toContain('warn');
  });

  it('用量/配额 ≤ 80% → 正常 accent 档（无 warn）', async () => {
    stubOps({ usage: 612_000_000, quota: 120_000_000_000 }, []);
    await renderElement(
      createElement(DataSection, { settings, patchSettings: vi.fn(async () => undefined), notify: vi.fn() }),
    );
    const meter = host.querySelector<HTMLElement>('.hdu-storage-meter');
    expect(meter).toBeDefined();
    expect(meter!.className).not.toContain('warn');
  });

  it('storage.estimate 返回 null（浏览器限制）→ 显示「无法获取（浏览器限制）」，不渲染三段式', async () => {
    stubOps(null, makeRecords(10));
    await renderElement(
      createElement(DataSection, { settings, patchSettings: vi.fn(async () => undefined), notify: vi.fn() }),
    );
    expect(host.textContent).toContain('无法获取（浏览器限制）');
    expect(host.querySelector('.hdu-storage-segments')).toBeNull();
  });

  it('刷新按钮重取数据：stats.records / storage.estimate 各再调用一次', async () => {
    stubOps({ usage: 612_000_000, quota: 120_000_000_000 }, makeRecords(45));
    await renderElement(
      createElement(DataSection, { settings, patchSettings: vi.fn(async () => undefined), notify: vi.fn() }),
    );
    const before = callOpMock.mock.calls.filter((args) => args[0] === 'stats.records').length;
    const btn = [...host.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('刷新'));
    expect(btn).toBeDefined();
    await act(async () => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await act(async () => {});
    const after = callOpMock.mock.calls.filter((args) => args[0] === 'stats.records').length;
    expect(after).toBe(before + 1);
  });
});
