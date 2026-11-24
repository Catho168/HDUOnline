/**
 * 设置页快捷键冲突 hint 行渲染测试（第 251 轮巡检，帮助域 / 一致性延续视角；
 * jsdom + react-dom 客户端渲染，无 JSX、直接 createElement，照 data-export-ui.test.ts
 * 的 Section 桩模式——settings / patchSettings 由测试持有，onChange 即改即存回灌）。
 *
 * 覆盖：
 *  1. 默认键位五键无 hint 行（设置区保持安静）；
 *  2. 预置占用键 / 重键 → 对应行下方 gold hint（.hdu-shortcut-hint）出现，文案含
 *     档位语义与当前值键帽 kbd；
 *  3. 输入框改键（受控 onChange → patchSettings 回灌）→ hint 实时出现 / 消失
 *     （即改即存模型下当前值即草稿值，与 goalConsistencyHint 同实时性）；
 *  4. hint 行 aria-live=polite（读屏可感知）。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from '@/core/shared/constants';
import type { AppSettings } from '@/core/shared/types';
import { LearningSection } from '@/entrypoints/options/App';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let settings: AppSettings;

/** 渲染当前 settings 并把 patchSettings 接成「即改即存回灌」（照 options 页真实数据流） */
async function render(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(LearningSection, {
        settings,
        patchSettings: async (patch: Partial<AppSettings>) => {
          settings = { ...settings, ...patch };
          await render();
        },
      }),
    );
  });
  await act(async () => {});
}

/** 快捷键卡（以区标题「快捷键」定位——学习区还有目标 / 字幕等其他带输入框的行） */
function shortcutCard(): HTMLElement {
  const card = [...host.querySelectorAll('.hdu-card')].find((c) =>
    [...c.querySelectorAll('.hdu-section-title')].some((t) => t.textContent === '快捷键'),
  );
  if (!card) throw new Error('快捷键卡未找到');
  return card as HTMLElement;
}

/** 第 index 个快捷键行的输入框（行顺序 = ask/favorite/note/prevTopic/nextTopic） */
function shortcutInput(index: number): HTMLInputElement {
  const rows = [...shortcutCard().querySelectorAll('.hdu-options-row')].filter((r) => r.querySelector('input'));
  const el = rows[index]?.querySelector('input');
  if (!el) throw new Error(`快捷键输入框 #${index} 未找到`);
  return el as HTMLInputElement;
}

/** 在输入框输入新值（受控组件走 input 事件，React onChange 归一） */
async function typeShortcut(index: number, value: string): Promise<void> {
  const input = shortcutInput(index);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {});
}

function hints(): HTMLElement[] {
  return [...host.querySelectorAll('.hdu-shortcut-hint')] as HTMLElement[];
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  settings = { ...DEFAULT_SETTINGS };
});

afterEach(() => {
  act(() => root.unmount());
});

describe('设置页快捷键冲突 hint（第 251 轮巡检）', () => {
  it('默认键位五键全绿：无 hint 行（设置区保持安静）', async () => {
    await render();
    expect(hints()).toHaveLength(0);
    // 五个输入框值与 DEFAULT_SHORTCUTS 一致（说明文案与速查浮层同源实时）
    const values = [0, 1, 2, 3, 4].map((i) => shortcutInput(i).value);
    expect(values).toEqual(['q', 'b', 'n', '[', ']']);
  });

  it('预置占用键（f）与重键（favorite=ask 同 q）→ 对应行 gold hint + 当前值键帽', async () => {
    settings = {
      ...settings,
      shortcuts: { ...settings.shortcuts, favorite: 'f', note: 'q' },
    };
    await render();
    const list = hints();
    expect(list).toHaveLength(3); // favorite（占用）+ ask（冲突赢家）+ note（冲突输家）
    const texts = list.map((h) => h.textContent ?? '');
    expect(texts.some((t) => t.includes('站点优先') && t.includes('f'))).toBe(true);
    expect(texts.some((t) => t.includes('优先生效'))).toBe(true); // ask 赢家文案
    expect(texts.some((t) => t.includes('本键将不触发'))).toBe(true); // note 输家文案
    // hint 行 aria-live=polite（读屏可感知）
    expect(list.every((h) => h.getAttribute('aria-live') === 'polite')).toBe(true);
    // 键帽 kbd 展示当前值（「当前冲突值」与输入框内容一眼对应）
    const kbds = [...host.querySelectorAll('.hdu-shortcut-hint kbd')].map((k) => k.textContent);
    expect(kbds).toContain('f');
    expect(kbds).toContain('q');
  });

  it('改键即改即存回灌：改成占用键 hint 出现、改回合法键 hint 消失（实时性锁定）', async () => {
    await render();
    expect(hints()).toHaveLength(0);
    // 提问键改成 f（站点占用）→ hint 即时出现
    await typeShortcut(0, 'f');
    expect(hints()).toHaveLength(1);
    expect(hints()[0]?.textContent).toContain('站点优先');
    // 改回合法键 b → hint 消失
    await typeShortcut(0, 'z');
    expect(hints()).toHaveLength(0);
    expect(shortcutInput(0).value).toBe('z');
    // settings.shortcuts 已持久化（patchSettings 回灌生效）
    expect(settings.shortcuts.ask).toBe('z');
  });
});
