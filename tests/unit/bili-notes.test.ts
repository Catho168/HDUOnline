/**
 * B 站时间点笔记（第 26 轮任务 A）+ 第 25 轮复核 P2 竞态修复回归：
 *  1. 笔记域 mediaKey 化（repo 层，fake-indexeddb 真实仓储）：putNote 归属校验矩阵
 *     （courId+teclId 成组 / 仅 mediaKey / 两者皆缺→拒）、listNotes 按 mediaKey 过滤
 *     （零迁移全表扫描口径，anchorTime 升序、软删除排除）、无过滤列表只含站内笔记
 *     （HDU 聚合视图不串台）、HDU 既有路径回归（记录体形状逐字节不变）；
 *     noteToFavorite 归属守卫（第 29 轮审计#6：两者皆缺拒、站外笔记 mediaKey 落
 *     收藏 metadata、站内笔记不写 metadata）；
 *  2. BiliQaPanel「笔记」页签（jsdom 冒烟，callOp 整体 mock，照 bili-subtitle-panel
 *     测试模式）：列表渲染、点击时间戳 seek、保存（anchorTime 取 <video>.currentTime）
 *     + toast + 就地刷新、两步确认删除、无字幕视频可用、切 P 后按新 mediaKey 重读；
 *  3. P2-1/P2-2 竞态回归：transcript.get / ai.get 的迟到响应按「响应所属 mediaKey ===
 *     当前 mediaKey」复核——快速切页签不卡死加载态、分 P 翻转旧 P 响应不覆盖新 P
 *     （BiliQaPanel 标注区 + BiliTimelineMarkers 两处）。
 */

// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({
  callOp: vi.fn(),
  onBackgroundEvent: vi.fn(() => () => undefined),
}));

import { callOp } from '@/core/shared/client';
import { getDb } from '@/core/db';
import { listNotes, putNote, softDeleteNote, noteToFavorite } from '@/core/db/repo/library';
import { BiliQaPanel } from '@/entrypoints/content/ui/BiliQaPanel';
import { BiliTimelineMarkers } from '@/entrypoints/content/ui/bili/BiliTimelineMarkers';
import type { AiResultEntity, ExternalNoteEntity, NoteEntity } from '@/core/shared/types';

const callOpMock = callOp as unknown as Mock;
const NOW = 1_700_000_000_000;

// ───────────────────────── 1. repo 层：笔记域 mediaKey 化 ─────────────────────────

function hduNote(overrides: Partial<NoteEntity> = {}): NoteEntity {
  return {
    id: 'n-hdu',
    courId: 1,
    teclId: 11,
    anchorTime: 10,
    text: '站内笔记',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function biliNote(overrides: Partial<ExternalNoteEntity> = {}): ExternalNoteEntity {
  return {
    id: 'n-bili',
    mediaKey: 'bili:BV1abc',
    anchorTime: 5,
    text: 'B站笔记',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

async function clearStores(): Promise<void> {
  const db = await getDb();
  await db.clear('notes');
  await db.clear('favorites');
  await db.clear('trash');
}

describe('笔记域 mediaKey 化（repo 层）', () => {
  beforeEach(async () => {
    await clearStores();
  });

  it('putNote 归属校验矩阵：courId+teclId 成组可写、仅 mediaKey 可写、只有 courId（缺 teclId）拒、两者皆缺拒', async () => {
    await expect(putNote(hduNote())).resolves.toBeUndefined();
    await expect(putNote(biliNote())).resolves.toBeUndefined();
    const onlyCourId = { id: 'n-half', courId: 1, anchorTime: 1, text: '缺 teclId', createdAt: NOW, updatedAt: NOW } as unknown as ExternalNoteEntity;
    await expect(putNote(onlyCourId)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const orphan = { id: 'n-orphan', anchorTime: 1, text: '孤儿', createdAt: NOW, updatedAt: NOW } as unknown as ExternalNoteEntity;
    await expect(putNote(orphan)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const db = await getDb();
    expect(await db.count('notes')).toBe(2);
  });

  it('listNotes 按 mediaKey 过滤：只返回该媒体笔记（anchorTime 升序、软删除排除），分 P 键相互隔离', async () => {
    await putNote(biliNote({ id: 'b1', mediaKey: 'bili:BV1abc', anchorTime: 30, text: 'P1 后记' }));
    await putNote(biliNote({ id: 'b2', mediaKey: 'bili:BV1abc', anchorTime: 10, text: 'P1 先记' }));
    await putNote(biliNote({ id: 'b3', mediaKey: 'bili:BV1abc:p2', anchorTime: 10, text: 'P2 笔记' }));
    await putNote(hduNote({ id: 'h1' }));

    expect((await listNotes({ mediaKey: 'bili:BV1abc' })).map((n) => n.id)).toEqual(['b2', 'b1']);
    expect((await listNotes({ mediaKey: 'bili:BV1abc:p2' })).map((n) => n.id)).toEqual(['b3']);

    await softDeleteNote('b1');
    expect((await listNotes({ mediaKey: 'bili:BV1abc' })).map((n) => n.id)).toEqual(['b2']);
  });

  it('listNotes 无过滤（HDU 聚合视图口径）只返回站内笔记；B 站笔记须经 mediaKey 显式查询', async () => {
    await putNote(hduNote({ id: 'h1', anchorTime: 20 }));
    await putNote(biliNote({ id: 'b1' }));
    expect((await listNotes({})).map((n) => n.id)).toEqual(['h1']);
    expect((await listNotes()).map((n) => n.id)).toEqual(['h1']);
  });

  it('HDU 既有路径回归：courId/teclId 过滤行为不变，记录体不新增 mediaKey 字段', async () => {
    await putNote(hduNote({ id: 'h1', courId: 7, teclId: 77 }));
    await putNote(hduNote({ id: 'h2', courId: 8, teclId: 88 }));
    expect((await listNotes({ courId: 7 })).map((n) => n.id)).toEqual(['h1']);
    expect((await listNotes({ teclId: 88 })).map((n) => n.id)).toEqual(['h2']);
    const db = await getDb();
    const row = (await db.get('notes', 'h1')) as Record<string, unknown> | undefined;
    expect(row).toMatchObject({ courId: 7, teclId: 77, anchorTime: 10, text: '站内笔记' });
    expect('mediaKey' in (row ?? {})).toBe(false);
  });

  it('B 站笔记可转收藏（note.toFavorite）：收藏缺省 courId/teclId，mediaKey 落 metadata，笔记回写 convertedFavoriteId', async () => {
    await putNote(biliNote({ id: 'b1', anchorTime: 65, text: '这个公式要记住' }));
    const fav = await noteToFavorite('b1');
    expect(fav.type).toBe('note');
    expect(fav.courId).toBeUndefined();
    expect(fav.teclId).toBeUndefined();
    expect(fav.anchorTime).toBe(65);
    expect(fav.snapshot.title).toContain('@65s');
    // 第 29 轮审计#6：站外笔记的归属信息带进收藏 metadata（buildMomentFavorite 同惯例），
    // 知识库侧可按 mediaKey 检索回跳
    expect(fav.metadata).toEqual({ mediaKey: 'bili:BV1abc' });
    const db = await getDb();
    const row = await db.get('notes', 'b1');
    expect(row?.convertedFavoriteId).toBe(fav.id);
  });

  it('noteToFavorite 归属守卫（第 29 轮审计#6）：两者皆缺/只有 courId 拒绝转藏；站内笔记不写 metadata', async () => {
    const db = await getDb();
    // 历史脏数据（绕过 putNote 校验直接落库）：既无 courId/teclId 也无 mediaKey → 拒绝，
    // 不产生无法归属检索的孤儿收藏
    const orphan = {
      id: 'n-orphan2',
      anchorTime: 1,
      text: '孤儿笔记',
      createdAt: NOW,
      updatedAt: NOW,
    } as unknown as NoteEntity;
    await db.put('notes', orphan);
    await expect(noteToFavorite('n-orphan2')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // 只有 courId（缺 teclId）同样不满足成组归属 → 拒绝（口径同 putNote 矩阵）
    const half = {
      id: 'n-half2',
      courId: 1,
      anchorTime: 2,
      text: '缺 teclId',
      createdAt: NOW,
      updatedAt: NOW,
    } as unknown as NoteEntity;
    await db.put('notes', half);
    await expect(noteToFavorite('n-half2')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await db.count('favorites')).toBe(0);

    // 站内笔记（courId+teclId 成组）：归属走实体字段，不写 metadata（HDU 既有路径行为不变）
    await putNote(hduNote({ id: 'h9', courId: 3, teclId: 33 }));
    const fav = await noteToFavorite('h9');
    expect(fav.courId).toBe(3);
    expect(fav.teclId).toBe(33);
    expect(fav.metadata).toBeUndefined();
  });
});

// ───────────────────────── 2. UI 冒烟：BiliQaPanel「笔记」页签 ─────────────────────────

let calls: Array<{ op: string; args: unknown }> = [];

/** 面板 op 桩：默认无字幕（笔记页签不依赖字幕）+ 空笔记列表，按需覆盖 */
function stubOps(overrides: Record<string, unknown> = {}): void {
  calls = [];
  const table: Record<string, unknown> = {
    'transcript.get': null,
    'note.list': [],
    'note.put': undefined,
    'note.softDelete': undefined,
    'qa.groups': [],
    ...overrides,
  };
  callOpMock.mockImplementation(async (op: string, args?: unknown) => {
    calls.push({ op, args });
    if (!(op in table)) throw new Error(`unexpected op: ${op}`);
    return table[op];
  });
}

function countCalls(op: string): number {
  return calls.filter((c) => c.op === op).length;
}

// note.list 的 mediaKey 查询返回 B 站笔记（记录体无 courId，类型口径见 ops.ts 注释）：
// 桩数据按实际存储形状构造，经 unknown 中转对齐 op 结果类型
const NOTES: NoteEntity[] = [
  { id: 'n1', mediaKey: 'bili:BV1Notes01', anchorTime: 12, text: '第一个想法', createdAt: NOW, updatedAt: NOW } as unknown as NoteEntity,
  { id: 'n2', mediaKey: 'bili:BV1Notes01', anchorTime: 200, text: '第二个想法', createdAt: NOW, updatedAt: NOW } as unknown as NoteEntity,
];

function aiResultOf(names: string[]): AiResultEntity {
  return {
    mediaKey: 'bili:BV1Notes01',
    topics: names.map((name) => ({ name, intervals: [[10, 30]], confidence: 'high' })),
    outline: [],
    generatedAt: NOW,
    model: 'test',
  } as unknown as AiResultEntity;
}

let currentP = 1;
let host: HTMLElement;
let root: Root;

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

/** 点击 + 让点击触发的异步链（callOp → setState → 重渲染）完全落定 */
async function clickAsync(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await act(async () => {});
}

function query<T extends Element>(selector: string): T {
  const el = host.querySelector<T>(selector);
  if (!el) throw new Error(`element not found: ${selector}`);
  return el;
}

function tabButton(label: string): HTMLButtonElement {
  const btn = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-qa-tab')).find((b) => b.textContent === label);
  if (!btn) throw new Error(`tab not found: ${label}`);
  return btn;
}

function panelElement(onToast?: (message: string, kind?: 'info' | 'error') => void) {
  return createElement(BiliQaPanel, {
    bvid: 'BV1Notes01',
    open: true,
    onClose: () => {},
    readPageP: () => currentP,
    onFavoriteMoment: () => {},
    onToast,
  });
}

/** 触发 React 受控 textarea 的 onChange（原生 setter + input 事件） */
function typeText(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  currentP = 1;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe('BiliQaPanel 笔记页签（第 26 轮）', () => {
  it('无字幕视频可用：列表按 mediaKey 读取并渲染时间戳+摘要，点击时间戳 seek 页内 <video>', async () => {
    stubOps({ 'note.list': NOTES });
    const video = document.createElement('video');
    document.body.appendChild(video);
    await renderElement(panelElement());
    await act(async () => {});

    // 无字幕：问答页签给空态，但不拦截笔记页签
    expect(host.textContent).toContain('该视频暂无可用字幕');
    await clickAsync(tabButton('笔记'));
    expect(calls.find((c) => c.op === 'note.list')?.args).toEqual({ mediaKey: 'bili:BV1Notes01' });
    const times = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-note-time'));
    expect(times).toHaveLength(2);
    expect(times[0]?.textContent).toBe('00:12');
    expect(host.textContent).toContain('第一个想法');
    expect(host.textContent).toContain('第二个想法');

    click(times[0]!);
    expect(video.currentTime).toBe(12);
  });

  it('保存：anchorTime 取 <video>.currentTime、mediaKey 按当前分 P；成功后 toast 并就地刷新列表', async () => {
    stubOps({ 'note.list': NOTES });
    const video = document.createElement('video');
    video.currentTime = 33.7;
    document.body.appendChild(video);
    const onToast = vi.fn();
    await renderElement(panelElement(onToast));
    await act(async () => {});
    await clickAsync(tabButton('笔记'));

    typeText(query<HTMLTextAreaElement>('.bili-note-composer textarea'), '  新的笔记  ');
    await clickAsync(query('.bili-note-composer .bili-qa-send'));

    const putCall = calls.find((c) => c.op === 'note.put');
    expect(putCall?.args).toMatchObject({
      note: { mediaKey: 'bili:BV1Notes01', anchorTime: 33, text: '新的笔记' },
    });
    // 保存后就地刷新：note.list 第二次读取
    expect(countCalls('note.list')).toBe(2);
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining('笔记已保存'));
    // 输入框清空
    expect((query<HTMLTextAreaElement>('.bili-note-composer textarea') as HTMLTextAreaElement).value).toBe('');
  });

  it('删除走两步确认：第一次点击仅进入确认态，第二次点击才 note.softDelete 并刷新', async () => {
    stubOps({ 'note.list': NOTES });
    await renderElement(panelElement());
    await act(async () => {});
    await clickAsync(tabButton('笔记'));

    const del = query<HTMLButtonElement>('.bili-note-del');
    await clickAsync(del);
    expect(query<HTMLButtonElement>('.bili-note-del').textContent).toContain('确认删除');
    expect(countCalls('note.softDelete')).toBe(0);

    await clickAsync(query('.bili-note-del'));
    expect(calls.find((c) => c.op === 'note.softDelete')?.args).toEqual({ id: 'n1' });
    expect(countCalls('note.list')).toBe(2);
  });

  it('分 P 跟随：readPageP 变化后按新 mediaKey 重读（P1 裸键 / p≥2 分键口径）', async () => {
    stubOps();
    vi.useFakeTimers();
    await renderElement(panelElement());
    await act(async () => {});
    await clickAsync(tabButton('笔记'));
    expect(calls.at(-1)).toMatchObject({ op: 'note.list', args: { mediaKey: 'bili:BV1Notes01' } });

    currentP = 2;
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect(calls.at(-1)).toMatchObject({ op: 'note.list', args: { mediaKey: 'bili:BV1Notes01:p2' } });
  });
});

// ───────────────────────── 3. P2 竞态修复回归（第 25 轮复核） ─────────────────────────

// React 18 并发渲染下 act() 需要显式声明测试环境（同 bili-subtitle-panel 测试口径）
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('P2 竞态修复回归（迟到响应按 mediaKey 复核）', () => {
  it('P2-1：标注→问答快速切换后，迟到的 transcript.get 响应仍解除加载态（问答页签不永久停在检查字幕）', async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    callOpMock.mockImplementation((op: string) => {
      if (op === 'transcript.get') {
        return new Promise((resolve) => {
          resolvers.push(resolve);
        });
      }
      if (op === 'ai.get') return Promise.resolve({ result: null, stale: false });
      return Promise.resolve([]); // qa.groups / qa.list
    });
    await renderElement(panelElement());
    await act(async () => {});
    expect(resolvers.length).toBe(1);
    expect(host.textContent).toContain('正在检查字幕…');
    await act(async () => {
      resolvers[0]!(null);
    });
    await act(async () => {});
    expect(host.textContent).toContain('无官方字幕');

    // 切标注区（第二次 transcript.get 在途）→ 快速切回问答（标注区 effect cleanup）
    await clickAsync(tabButton('AI 标注'));
    expect(resolvers.length).toBe(2);
    await clickAsync(tabButton('问答'));
    // 迟到响应到来：响应所属 mediaKey 仍等于当前 mediaKey → setChecking(false) 必须执行
    await act(async () => {
      resolvers[1]!(null);
    });
    await act(async () => {});
    expect(host.textContent).not.toContain('正在检查字幕…');
    expect(host.textContent).toContain('无官方字幕');
  });

  it('P2-2：标注区分 P 翻转时，旧 P 迟到的 ai.get 响应不覆盖新 P', async () => {
    const aiResolvers: Array<(v: unknown) => void> = [];
    callOpMock.mockImplementation((op: string) => {
      if (op === 'transcript.get') return Promise.resolve(null);
      if (op === 'ai.get') {
        return new Promise((resolve) => {
          aiResolvers.push(resolve);
        });
      }
      return Promise.resolve([]);
    });
    vi.useFakeTimers();
    await renderElement(panelElement());
    await act(async () => {});
    await clickAsync(tabButton('AI 标注'));
    await act(async () => {});
    expect(aiResolvers.length).toBe(1);

    // SPA 切 P（轮询 tick 触发新 load）→ ai.get #2（新分 P 键）
    currentP = 2;
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect(aiResolvers.length).toBe(2);

    // 旧 P 迟到响应：mediaKey 复核失败 → 不得写入（否则旧 P 知识点串台到新 P）
    await act(async () => {
      aiResolvers[0]!({ result: aiResultOf(['旧P知识点']), stale: false });
    });
    await act(async () => {});
    expect(host.textContent).not.toContain('旧P知识点');

    // 新 P 响应正常写入
    await act(async () => {
      aiResolvers[1]!({ result: aiResultOf(['新P知识点']), stale: false });
    });
    await act(async () => {});
    expect(host.textContent).toContain('新P知识点');
  });

  it('P2-2：BiliTimelineMarkers 分 P 翻转时，旧 P 迟到的 ai.get 响应不覆盖新 P', async () => {
    const aiResolvers: Array<(v: unknown) => void> = [];
    callOpMock.mockImplementation((op: string) => {
      if (op === 'ai.get') {
        return new Promise((resolve) => {
          aiResolvers.push(resolve);
        });
      }
      return Promise.resolve([]);
    });
    // <video> 预置可量化的 rect/duration（jsdom 默认全 0，标记条无法定位）
    const video = document.createElement('video');
    Object.defineProperty(video, 'duration', { value: 100, configurable: true });
    video.getBoundingClientRect = () =>
      ({ width: 640, height: 360, top: 100, left: 0, right: 640, bottom: 460, x: 0, y: 100, toJSON: () => ({}) }) as unknown as DOMRect;
    document.body.appendChild(video);

    await renderElement(createElement(BiliTimelineMarkers, { bvid: 'BV1Notes01', readPageP: () => currentP }));
    await act(async () => {});
    expect(aiResolvers.length).toBe(1);

    // 新 readPageP 闭包 → effect 重跑（cleanup + load）→ 检测到 P 变化 → ai.get #2
    currentP = 2;
    await renderElement(createElement(BiliTimelineMarkers, { bvid: 'BV1Notes01', readPageP: () => currentP }));
    await act(async () => {});
    expect(aiResolvers.length).toBe(2);

    // 旧 P 迟到响应：不写入（标记条保持不渲染）
    await act(async () => {
      aiResolvers[0]!({ result: aiResultOf(['旧P标记']), stale: false });
    });
    await act(async () => {});
    expect(host.querySelectorAll('.bili-timeline-mark')).toHaveLength(0);

    // 新 P 响应：标记条渲染
    await act(async () => {
      aiResolvers[1]!({ result: aiResultOf(['新P标记']), stale: false });
    });
    await act(async () => {});
    expect(host.querySelectorAll('.bili-timeline-mark').length).toBeGreaterThan(0);
  });
});
