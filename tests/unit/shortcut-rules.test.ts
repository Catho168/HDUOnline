/**
 * 快捷键设置防呆规则纯函数测试（第 251 轮巡检，帮助域 / 一致性延续视角）。
 *
 * 覆盖：默认键位全绿（无问题）；四类问题档（empty / format / reserved / conflict）
 * 的命中与优先级顺序；HDU 与 B 站保留键并集判定；大小写归一（与运行时
 * event.key.toLowerCase() 匹配同口径）；冲突链序判定（先注册者生效——ask → favorite
 * → note → prevTopic → nextTopic）；自定义 reserved 注入；shortcutIssuesOf 批量口径。
 * 基线对照：content/index.tsx onShortcut 的过滤与匹配链（站点优先 + 单键）。
 */

import { describe, expect, it } from 'vitest';
import { BILI_RESERVED_KEYS, DEFAULT_SHORTCUTS, RESERVED_KEYS } from '@/core/shared/constants';
import { shortcutIssueOf, shortcutIssuesOf } from '@/core/shared/shortcutRules';
import type { ShortcutMap } from '@/core/shared/types';

/** 快捷键测试造数（Partial 深度受限，直接展开） */
function shortcutsOf(patch: Partial<ShortcutMap>): ShortcutMap {
  return { ...DEFAULT_SHORTCUTS, ...patch };
}

describe('shortcutRules 键位防呆规则（第 251 轮巡检）', () => {
  it('默认键位（q/b/n/[/]）五键全绿：无任何问题档', () => {
    const issues = shortcutIssuesOf(DEFAULT_SHORTCUTS);
    for (const key of ['ask', 'favorite', 'note', 'prevTopic', 'nextTopic'] as const) {
      expect(issues[key]).toBeNull();
    }
    expect(shortcutIssueOf(DEFAULT_SHORTCUTS.ask, 'ask', DEFAULT_SHORTCUTS)).toBeNull();
  });

  it('empty：空值 → empty 档（优先级最高）；纯空格按空格键占用归 reserved 档', () => {
    expect(shortcutIssueOf('', 'ask', DEFAULT_SHORTCUTS)?.kind).toBe('empty');
    // 纯空格：运行时能对上空格键但 RESERVED_KEYS 先行让行（与运行时语义对齐）
    expect(shortcutIssueOf('   ', 'note', DEFAULT_SHORTCUTS)?.kind).toBe('reserved');
    // 首尾空格：运行时匹配不做 trim，带空格的值匹配不到任何键 → format 档
    expect(shortcutIssueOf(' q', 'ask', DEFAULT_SHORTCUTS)?.kind).toBe('format');
    expect(shortcutIssueOf('q ', 'note', DEFAULT_SHORTCUTS)?.kind).toBe('format');
    // 非字符串脏值按空值处理（设置链路不会产生，纯函数防御）
    expect(shortcutIssueOf(undefined as unknown as string, 'ask', DEFAULT_SHORTCUTS)?.kind).toBe('empty');
    expect(shortcutIssueOf('', 'ask', DEFAULT_SHORTCUTS)?.text).toContain('不会触发');
  });

  it('format：修饰键组合 / 组合符 → format 档（运行时遇修饰键让行，根本不可能命中）', () => {
    for (const value of ['ctrl+q', 'ctrl q', 'alt+q', 'cmd+q', 'meta+q', 'shift+q', 'control', 'command']) {
      expect(shortcutIssueOf(value, 'ask', DEFAULT_SHORTCUTS)?.kind).toBe('format');
    }
    expect(shortcutIssueOf('ctrl+q', 'ask', DEFAULT_SHORTCUTS)?.text).toContain('组合键不生效');
  });

  it('reserved：HDU 保留键（f/m/c/j/k/l/数字/空格等）→ reserved 档（站点优先让行）', () => {
    for (const key of RESERVED_KEYS) {
      const issue = shortcutIssueOf(key, 'ask', DEFAULT_SHORTCUTS);
      expect(issue?.kind).toBe('reserved');
    }
    expect(shortcutIssueOf('f', 'favorite', DEFAULT_SHORTCUTS)?.text).toContain('站点优先');
    expect(shortcutIssueOf('1', 'note', DEFAULT_SHORTCUTS)?.kind).toBe('reserved');
  });

  it('reserved 取 HDU ∪ B 站并集：B 站占用键（d/s 等）同样提示（同一 shortcuts 两侧共用）', () => {
    for (const key of BILI_RESERVED_KEYS) {
      expect(shortcutIssueOf(key, 'ask', DEFAULT_SHORTCUTS)?.kind).toBe('reserved');
    }
    expect(shortcutIssueOf('d', 'ask', DEFAULT_SHORTCUTS)?.kind).toBe('reserved');
    expect(shortcutIssueOf('s', 'note', DEFAULT_SHORTCUTS)?.kind).toBe('reserved');
  });

  it('conflict：两键同值 → 双双告警；链序先者（ask）生效、后者（favorite）失效', () => {
    const s = shortcutsOf({ favorite: 'q' });
    const ask = shortcutIssueOf('q', 'ask', s);
    const fav = shortcutIssueOf('q', 'favorite', s);
    expect(ask?.kind).toBe('conflict');
    expect(fav?.kind).toBe('conflict');
    // 链序判定：ask 在前 → 「本动作先注册、优先生效」；favorite 在后 → 「本键将不触发」
    expect(ask?.text).toContain('优先生效');
    expect(ask?.text).toContain('「收藏当前时间点」');
    expect(fav?.text).toContain('本键将不触发');
    expect(fav?.text).toContain('「提问」');
  });

  it('conflict 大小写归一：Q 与 q 视为同键（与运行时 toLowerCase 匹配同口径）', () => {
    const s = shortcutsOf({ note: 'Q' });
    expect(shortcutIssueOf('q', 'note', s)?.kind).toBe('conflict');
    expect(shortcutIssueOf('q', 'ask', s)?.kind).toBe('conflict');
  });

  it('问题优先级：reserved 先于 conflict（占用键即使重键也先报占用）', () => {
    // f 为保留键：两键同时设 f → 双双 reserved（冲突判定不覆盖）
    const s = shortcutsOf({ favorite: 'f' });
    expect(shortcutIssueOf('f', 'ask', s)?.kind).toBe('reserved');
    expect(shortcutIssueOf('f', 'favorite', s)?.kind).toBe('reserved');
  });

  it('自定义 reserved 注入（测试 / 未来域扩展用）', () => {
    const custom = new Set(['z']);
    expect(shortcutIssueOf('z', 'ask', DEFAULT_SHORTCUTS, custom)?.kind).toBe('reserved');
    // 默认表里 z 无冲突不报
    expect(shortcutIssueOf('z', 'ask', DEFAULT_SHORTCUTS)).toBeNull();
  });

  it('shortcutIssuesOf 批量：多键同时有问题逐键落位（互不影响其余键）', () => {
    const s = shortcutsOf({ ask: '', favorite: 'f', note: 'q', prevTopic: 'q' });
    const issues = shortcutIssuesOf(s);
    expect(issues.ask?.kind).toBe('empty');
    expect(issues.favorite?.kind).toBe('reserved');
    expect(issues.note?.kind).toBe('conflict');
    expect(issues.prevTopic?.kind).toBe('conflict');
    expect(issues.nextTopic).toBeNull();
  });
});
