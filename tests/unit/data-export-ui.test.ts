/**
 * 设置页「导出全部数据」行为测试（第 250 轮巡检，数据自主权域 / 备份视角）。
 *
 * 覆盖（照 two-step-confirm.test.ts 的 DataSection 桩模式，downloadTextFile 整体 mock
 * 以隔离 jsdom 的导航实现）：
 *  1. 渲染：导出行（标题「导出全部数据」+ 按钮「导出 JSON」+ 防呆副文案「不用于导入恢复」）；
 *  2. 点击 → callOp('data.exportAll') → downloadTextFile 以 (filename, json,
 *     application/json) 调用 + 成功 toast 带文件名 + 摘要行出现（条目数 muted 小字）；
 *  3. op 失败 → notify(error, true) 错误 toast，按钮态恢复（不残留 loading）；
 *  4. loading 态：请求悬挂期间按钮 disabled 且文案「导出中…」。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));
vi.mock('@/entrypoints/content/ui/download', () => ({ downloadTextFile: vi.fn(), DOWNLOAD_REVOKE_DELAY_MS: 10_000 }));

import { callOp } from '@/core/shared/client';
import { downloadTextFile } from '@/entrypoints/content/ui/download';
import { DataSection } from '@/entrypoints/options/App';
import { DEFAULT_SETTINGS } from '@/core/shared/constants';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;
const downloadMock = downloadTextFile as unknown as Mock;

const EXPORT_RESULT = {
  filename: 'HDUOnline_全量备份_2026-11-21.json',
  json: '{"version":1,"app":"hduonline-data-export","kind":"data-export"}',
  counts: { favorites: 3, notes: 2, reviewJobs: 5, weeklyPlans: 1, courses: 2, sessions: 8, folders: 1, tags: 2, videoProgress: 4, curriculum: 0, settings: 17 },
  size: 64,
};

let host: HTMLElement;
let root: Root;

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
  // 放行挂载期的 storage.usage / readLogs 异步链
  await act(async () => {});
}

async function clickAsync(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await act(async () => {});
}

function exportButton(): HTMLButtonElement {
  const btn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '导出 JSON' || b.textContent === '导出中…');
  if (!btn) throw new Error('export button not found');
  return btn;
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  callOpMock.mockReset();
  downloadMock.mockReset();
  callOpMock.mockImplementation(async (op: string) => {
    if (op === 'storage.usage') return null;
    throw new Error(`unexpected op: ${op}`);
  });
});

afterEach(() => {
  act(() => root.unmount());
});

describe('设置页「导出全部数据」（第 250 轮巡检）', () => {
  it('渲染导出行：标题 + 按钮 + 「不用于导入恢复」防呆副文案', async () => {
    await renderElement(createElement(DataSection, { settings: DEFAULT_SETTINGS, patchSettings: vi.fn(async () => {}), notify: vi.fn() }));
    expect(host.textContent).toContain('导出全部数据');
    expect(exportButton().textContent).toBe('导出 JSON');
    expect(host.textContent).toContain('不用于导入恢复');
  });

  it('点击导出 → data.exportAll → downloadTextFile 调用 + 成功 toast + 条目数摘要行', async () => {
    const notify = vi.fn();
    callOpMock.mockImplementation(async (op: string) => {
      if (op === 'storage.usage') return null;
      if (op === 'data.exportAll') return EXPORT_RESULT;
      throw new Error(`unexpected op: ${op}`);
    });
    await renderElement(createElement(DataSection, { settings: DEFAULT_SETTINGS, patchSettings: vi.fn(async () => {}), notify }));

    await clickAsync(exportButton());
    expect(callOpMock).toHaveBeenCalledWith('data.exportAll', {});
    expect(downloadMock).toHaveBeenCalledTimes(1);
    expect(downloadMock).toHaveBeenCalledWith(EXPORT_RESULT.filename, EXPORT_RESULT.json, 'application/json;charset=utf-8');
    expect(notify).toHaveBeenCalledWith(`已导出 ${EXPORT_RESULT.filename}`);
    const summary = host.querySelector('.hdu-export-summary');
    expect(summary).toBeTruthy();
    expect(summary?.textContent).toContain('共 45 条');
    expect(summary?.textContent).toContain('收藏 3');
    expect(summary?.textContent).toContain('笔记 2');
    // 按钮态恢复（不再 loading）
    expect(exportButton().textContent).toBe('导出 JSON');
    expect(exportButton().disabled).toBe(false);
  });

  it('op 失败 → 错误 toast，按钮态恢复，不触发下载', async () => {
    const notify = vi.fn();
    callOpMock.mockImplementation(async (op: string) => {
      if (op === 'storage.usage') return null;
      if (op === 'data.exportAll') throw new Error('DB_FAILED');
      throw new Error(`unexpected op: ${op}`);
    });
    await renderElement(createElement(DataSection, { settings: DEFAULT_SETTINGS, patchSettings: vi.fn(async () => {}), notify }));

    await clickAsync(exportButton());
    expect(downloadMock).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('导出失败'), true);
    expect(host.querySelector('.hdu-export-summary')).toBeNull();
    expect(exportButton().disabled).toBe(false);
  });

  it('loading 态：请求悬挂期间按钮 disabled + 「导出中…」', async () => {
    let resolveExport: (value: unknown) => void = () => undefined;
    callOpMock.mockImplementation(async (op: string) => {
      if (op === 'storage.usage') return null;
      if (op === 'data.exportAll') {
        return new Promise((resolve) => {
          resolveExport = resolve;
        });
      }
      throw new Error(`unexpected op: ${op}`);
    });
    await renderElement(createElement(DataSection, { settings: DEFAULT_SETTINGS, patchSettings: vi.fn(async () => {}), notify: vi.fn() }));

    await act(async () => {
      exportButton().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    // 请求未落定：按钮进入 loading 态
    expect(exportButton().textContent).toBe('导出中…');
    expect(exportButton().disabled).toBe(true);

    await act(async () => {
      resolveExport(EXPORT_RESULT);
    });
    expect(exportButton().textContent).toBe('导出 JSON');
  });
});
