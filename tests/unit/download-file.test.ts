/**
 * 文本文件下载工具 downloadTextFile（src/entrypoints/content/ui/download.ts，
 * 第 239 轮巡检）单测：jsdom 环境 + mock URL.createObjectURL / revokeObjectURL。
 *
 * 覆盖：
 *  1. Blob 构造：type text/markdown;charset=utf-8、内容与入参一致（blob.text() 解出）；
 *  2. a[download]：download = 文件名、href = objectURL、rel = noopener，点击后
 *     临时锚点从 DOM 移除（finally 清理）；
 *  3. objectURL 回收：延迟 DOWNLOAD_REVOKE_DELAY_MS 后 revokeObjectURL(url) 恰一次；
 *  4. 异常路径：appendChild 被拦（抛错）→ 错误透传给调用方（toast 决策），且
 *     objectURL 仍被回收（finally 必达清理）。
 */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DOWNLOAD_REVOKE_DELAY_MS, downloadTextFile } from '@/entrypoints/content/ui/download';

const createObjectURLMock = vi.fn((..._args: unknown[]) => 'blob:mock-url');
const revokeObjectURLMock = vi.fn((..._args: unknown[]) => undefined);

function stubUrl(): void {
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

beforeEach(() => {
  createObjectURLMock.mockClear();
  revokeObjectURLMock.mockClear();
  document.body.innerHTML = '';
  stubUrl();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('downloadTextFile 文本文件下载（第 239 轮巡检）', () => {
  it('Blob type text/markdown;charset=utf-8，内容与入参一致', async () => {
    const content = '# HDUOnline 周报\n\n- 站内学习 2.5 小时\n';
    downloadTextFile('HDUOnline周报_2026-11-16_11-22.md', content);
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
    const blob = createObjectURLMock.mock.calls[0]![0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('text/markdown;charset=utf-8');
    await expect(blobText(blob)).resolves.toBe(content);
  });

  it('a[download] 带文件名与 objectURL，点击后临时锚点移出 DOM；延迟后 revoke 恰一次', async () => {
    // 本用例断言 revoke 的延迟时机：fake timers 定点推进（FileReader 类断言见上一用例，
    // 那里须用真实计时器——fake timers 会挂起 jsdom FileReader 的事件派发）
    vi.useFakeTimers();
    const created: HTMLAnchorElement[] = [];
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = origCreate(tag);
      if (tag === 'a') created.push(el as HTMLAnchorElement);
      return el;
    }) as typeof document.createElement);

    downloadTextFile('HDUOnline月报_2026-11_11-30.md', '正文');

    const anchor = created[0]!;
    expect(anchor).toBeTruthy();
    expect(anchor.download).toBe('HDUOnline月报_2026-11_11-30.md');
    expect(anchor.href).toBe('blob:mock-url');
    expect(anchor.rel).toBe('noopener');
    // finally 清理：点击完成后临时锚点已不在 DOM（对入参零残留）
    expect(anchor.parentNode).toBeNull();
    expect(document.querySelector('a')).toBeNull();

    // 回收延迟：未到 DOWNLOAD_REVOKE_DELAY_MS 不回收，到点恰一次
    expect(revokeObjectURLMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DOWNLOAD_REVOKE_DELAY_MS);
    expect(revokeObjectURLMock).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:mock-url');
  });

  it('异常路径：appendChild 被拦抛错 → 错误透传，objectURL 仍在 finally 中被回收', async () => {
    vi.useFakeTimers();
    vi.spyOn(document.body, 'appendChild').mockImplementation(() => {
      throw new Error('append blocked');
    });
    expect(() => downloadTextFile('x.md', '正文')).toThrow('append blocked');
    // finally 必达：异常路径同样调度 objectURL 回收
    await vi.advanceTimersByTimeAsync(DOWNLOAD_REVOKE_DELAY_MS);
    expect(revokeObjectURLMock).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:mock-url');
  });

  it('自定义 mime 透传（收藏清单 CSV 等调用点复用同一实现）', () => {
    downloadTextFile('收藏清单.csv', 'a,b', 'text/csv;charset=utf-8');
    const blob = createObjectURLMock.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe('text/csv;charset=utf-8');
  });
});
