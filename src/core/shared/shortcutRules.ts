/**
 * 快捷键设置防呆规则（第 251 轮巡检，帮助域 / 一致性延续视角）。
 *
 * 背景（探查结论，记巡检日志第 251 轮）：设置页 5 个可配置键是「即改即存」的
 * TextInput（无任何校验），运行时匹配链在 content/index.tsx onShortcut 与
 * BiliCollectApp / BiliQaPanel：`event.key.toLowerCase()` → 先过滤 RESERVED_KEYS /
 * BILI_RESERVED_KEYS（站点优先，让行原生按键）→ 按固定顺序 ask → favorite → note
 * → prevTopic → nextTopic 首个命中生效。由此存在两类「静默失效」面：
 *  ① 设成站点占用键（RESERVED_KEYS，如 f / m / 数字 / 空格）→ 运行时让行，永不触发；
 *  ② 两个动作设成同一个键 → 链序先者生效，后者静默失效。
 * 另有「根本不可能命中」的值：空值 / 修饰键组合（ctrl+q——运行时遇修饰键直接让行）。
 *
 * 本模块为纯函数规则（不触 UI、不触库）：逐键评估给出 warning 档问题（不阻断保存
 * ——与 goalConsistencyHint 同防呆哲学：软提示 + gold 淡底 hint 行，仿第 242 轮
 * 模式）。reserved 判定取 HDU 与 B 站保留键并集（同一 shortcuts 两侧共用，任一侧
 * 被占用即视为失效）。
 */

import { BILI_RESERVED_KEYS, RESERVED_KEYS } from './constants';
import type { ShortcutMap } from './types';

/** 可配置键的展示名（设置页 hint / 速查浮层共用文案口径） */
export const SHORTCUT_SETTING_LABELS: Record<keyof ShortcutMap, string> = {
  ask: '提问',
  favorite: '收藏当前时间点',
  note: '记笔记',
  prevTopic: '上一个知识点',
  nextTopic: '下一个知识点',
};

/** 运行时匹配链顺序（content/index.tsx onShortcut 与 B 站侧同序；冲突判定用） */
const CHAIN_ORDER: Array<keyof ShortcutMap> = ['ask', 'favorite', 'note', 'prevTopic', 'nextTopic'];

/** HDU 与 B 站保留键并集：任一侧被占用，快捷键在该侧永不触发 */
const ALL_RESERVED_KEYS = new Set([...RESERVED_KEYS, ...BILI_RESERVED_KEYS]);

/** 键位问题档位（UI 着色与测试断言用；当前全部为 warning 软提示） */
export type ShortcutIssueKind = 'empty' | 'format' | 'reserved' | 'conflict';

export interface ShortcutIssue {
  kind: ShortcutIssueKind;
  /** 用户可见文案（一行，无句号结尾——提示行家族惯例） */
  text: string;
}

/** 值归一：与运行时匹配同口径（trim + toLowerCase；非字符串视为空） */
function normalizeShortcutValue(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** 修饰键组合 / 组合符检测：运行时遇 ctrl/meta/alt 直接让行，此类值根本不可能命中 */
function looksLikeModifierCombo(value: string): boolean {
  if (value.includes('+') || value.includes('control') || value.includes('command') || value.includes('option')) {
    return true;
  }
  return /^(ctrl|cmd|meta|alt|shift)[\s-]/.test(value);
}

/**
 * 单键评估（纯函数）：value 为该键当前设置值，shortcuts 为完整设置（冲突判定用），
 * reserved 允许注入（缺省 = HDU ∪ B 站保留键并集）。
 * 返回 null = 该键无问题（正常可触发）；命中即返回最高优先级问题：
 * empty（空值）→ format（修饰键组合 / 首尾空格）→ reserved（站点占用）→
 * conflict（与其他动作重键）。
 * 判定与运行时（content/index.tsx onShortcut / B 站侧）对齐的三个细节：
 *  ① 运行时匹配不做 trim——首尾空格的值不可能等于任何 event.key → format 档；
 *  ② 纯空格值（' '）运行时能对上空格键但 RESERVED_KEYS 先行让行 → 归 reserved 档；
 *  ③ 冲突判定按 trim+toLowerCase 归一（用户输入 'Q' 与 'q' 视为同键，与运行时
 *     event.key.toLowerCase() 一致）。
 */
export function shortcutIssueOf(
  value: unknown,
  settingKey: keyof ShortcutMap,
  shortcuts: ShortcutMap,
  reserved: ReadonlySet<string> = ALL_RESERVED_KEYS,
): ShortcutIssue | null {
  const raw = typeof value === 'string' ? value : '';
  const normalized = raw.trim().toLowerCase();
  if (raw.length === 0) {
    return { kind: 'empty', text: '键位为空，该快捷键不会触发（恢复默认或输入单个按键）' };
  }
  if (normalized.length === 0) {
    // 纯空格：运行时对上空格键但保留键先行让行（站点优先），归占用档
    return { kind: 'reserved', text: '该键为播放器原生按键，按「站点优先」原则助手会让行、不会触发' };
  }
  if (raw !== raw.trim()) {
    return { kind: 'format', text: '键位含首尾空格，运行时匹配不到该键（请输入单个按键）' };
  }
  if (looksLikeModifierCombo(normalized)) {
    return { kind: 'format', text: '组合键不生效（助手仅响应单键，Ctrl / Alt / Cmd 组合一律让行站点）' };
  }
  if (reserved.has(normalized)) {
    return { kind: 'reserved', text: '该键为播放器原生按键，按「站点优先」原则助手会让行、不会触发' };
  }
  // 冲突判定：归一后与其他动作重键（链序先者生效）。空值行不参与冲突归并（empty 已单独提示）
  const rivals = CHAIN_ORDER.filter(
    (key) => key !== settingKey && normalizeShortcutValue(shortcuts?.[key]) === normalized,
  );
  if (rivals.length > 0) {
    const rivalLabels = rivals.map((key) => `「${SHORTCUT_SETTING_LABELS[key]}」`).join('、');
    const iAmWinner = CHAIN_ORDER.indexOf(settingKey) < Math.min(...rivals.map((key) => CHAIN_ORDER.indexOf(key)));
    return {
      kind: 'conflict',
      text: iAmWinner
        ? `与 ${rivalLabels} 共用此键：本动作先注册、优先生效，${rivalLabels} 将不触发`
        : `与 ${rivalLabels} 共用此键：先注册的动作优先，本键将不触发`,
    };
  }
  return null;
}

/** 逐键评估全部 5 个可配置键（设置页渲染一次调用的批量口径） */
export function shortcutIssuesOf(
  shortcuts: ShortcutMap,
  reserved?: ReadonlySet<string>,
): Record<keyof ShortcutMap, ShortcutIssue | null> {
  const out = {} as Record<keyof ShortcutMap, ShortcutIssue | null>;
  for (const key of CHAIN_ORDER) {
    out[key] = shortcutIssueOf(shortcuts?.[key], key, shortcuts, reserved);
  }
  return out;
}
