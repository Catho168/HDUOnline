/**
 * 快捷键速查浮层一致性测试（第 240 轮巡检）：
 * 速查清单改为模块常量 SHORTCUT_SHEET_GROUPS 后，「实现注册的键位 vs 浮层展示的
 * 清单」一致性可锁定——
 *  1. ShortcutMap 全部五个可配置键（ask/favorite/note/prevTopic/nextTopic）在浮层
 *     清单中各出现且仅出现一次（无遗漏、无重复、无幽灵条目）；
 *  2. 固定行为键 Esc（共享浮层栈派发，components.tsx）入清单「通用」组；
 *  3. 大纲步进（prev/next）带作用域说明（B 站仅问答面板打开时生效——实现处
 *     BiliQaPanel.onOutlineShortcut 仅 open 时挂监听）；
 *  4. jsdom 渲染断言：自定义键位实时可见（shortcuts 传入值即所见）、分组标题与
 *     关键键位渲染在位。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SHORTCUT_SHEET_GROUPS, ShortcutsModal } from '@/entrypoints/content/ui/ShortcutsModal';
import { DEFAULT_SHORTCUTS } from '@/core/shared/constants';
import type { ShortcutMap } from '@/core/shared/types';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONFIGURABLE_KEYS = ['ask', 'favorite', 'note', 'prevTopic', 'nextTopic'] as const;

type ShortcutSheetRowOf = 'ask' | 'favorite' | 'note' | 'prevTopic' | 'nextTopic' | null;

function allRows(): Array<{ settingKey: ShortcutSheetRowOf; desc: string; scope: string; fixedKey?: string }> {
  return SHORTCUT_SHEET_GROUPS.flatMap((group) => group.rows);
}

let host: HTMLElement;
let root: Root;

async function renderModal(shortcuts: ShortcutMap): Promise<void> {
  await act(async () => {
    root.render(
      createElement(ShortcutsModal, { open: true, onClose: () => undefined, shortcuts }),
    );
  });
  await act(async () => {});
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = '';
});

describe('速查清单常量 vs 注册键位（第 240 轮盘点锁定）', () => {
  it('ShortcutMap 五个可配置键各出现且仅出现一次（无遗漏/重复/幽灵）', () => {
    const settingKeys = allRows().map((row) => row.settingKey);
    for (const key of CONFIGURABLE_KEYS) {
      expect(settingKeys.filter((k) => k === key)).toHaveLength(1);
    }
    // 无幽灵条目：settingKey 只允许这五个 + null（固定键）
    expect(settingKeys.every((k) => k === null || (CONFIGURABLE_KEYS as readonly string[]).includes(k))).toBe(true);
  });

  it('固定行为键 Esc 入「通用」组（共享浮层栈派发的真实实现）', () => {
    const escRows = allRows().filter((row) => row.settingKey === null);
    expect(escRows).toHaveLength(1);
    expect(escRows[0]!.fixedKey).toBe('Esc');
    const generalGroup = SHORTCUT_SHEET_GROUPS.find((group) => group.rows.some((row) => row.settingKey === null));
    expect(generalGroup?.title).toBe('通用');
  });

  it('大纲步进行带作用域说明（B 站仅问答面板打开时生效）', () => {
    const rows = allRows().filter((row) => row.settingKey === 'prevTopic' || row.settingKey === 'nextTopic');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.scope).toContain('HDU 播放页');
      expect(row.scope).toContain('B 站问答面板');
    }
  });

  it('ask/favorite/note 作用域覆盖 HDU 播放页与 B 站学习中心两侧实现', () => {
    for (const key of ['ask', 'favorite', 'note'] as const) {
      const row = allRows().find((r) => r.settingKey === key);
      expect(row?.scope).toContain('HDU 播放页');
      expect(row?.scope).toContain('B 站学习中心');
    }
  });
});

describe('ShortcutsModal 渲染（键位实时读取）', () => {
  it('默认键位渲染：分组标题、q/b/n/[/] 键帽与 Esc 在位', async () => {
    await renderModal(DEFAULT_SHORTCUTS);
    const text = document.body.textContent ?? '';
    expect(text).toContain('播放页快捷键');
    expect(text).toContain('通用');
    for (const key of Object.values(DEFAULT_SHORTCUTS)) {
      expect(text).toContain(key);
    }
    expect(text).toContain('Esc');
    expect(text).toContain('AI 问答');
  });

  it('自定义键位实时可见（用户改键即所见）', async () => {
    await renderModal({ ask: 'j', favorite: 'k', note: 'l', prevTopic: ',', nextTopic: '.' });
    const text = document.body.textContent ?? '';
    expect(text).toContain('j');
    expect(text).toContain('.');
    // 默认键不再出现（q/b/n 不在文档里）
    expect(text).not.toContain('q');
  });
});
