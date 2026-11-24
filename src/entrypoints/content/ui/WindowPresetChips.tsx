/**
 * 上下文窗口档位 chips（第 29 轮自 BiliQaPanel 抽出为两面板共享组件）：
 * qa.ask / ai.generate 的 per-request windowPreset（协议见 shared/ops.ts，档位含义见
 * shared/constants.ts 的 CONTEXT_WINDOW_PRESETS）的紧凑三档选择器。
 *
 * 为什么共享：B 站学习助手面板（BiliQaPanel，第 27/28 轮已验证）与 HDU 主面板
 * （PlayPanel，第 29 轮对齐）需要同一套「窗口 小/中/大」选择交互，抽成单份实现
 * 避免出现第三份拷贝；选中态由父级 value 驱动、点选经 onSelect 上抛——组件本身
 * 不持有业务状态，「已交互不覆盖」等守卫语义留在各面板。
 *
 * 为什么带 variant：两面板分属不同 shadow root，样式来源不同——B 站侧沿用
 * BiliQaPanel PANEL_CSS 里的 .bili-qa-window*（含 .bili-root[data-theme="dark"]
 * 暗色覆盖），默认 variant='bili' 保持 B 站标记与外观零变化；HDU 侧 styles.ts
 * 无对应类（且本轮不改 styles.ts），variant='hdu' 用自有 hdu- 前缀类并由组件
 * 自注入一小段样式（与 BiliQaPanel 自带 PANEL_CSS 同一模式），颜色全部走
 * .hdu-root 的 CSS 变量，暗色自动跟随。
 */

import type { ContextWindowPreset } from '@/core/shared/types';

/** 档位选项（与 Options「上下文窗口」同三项；顺序即展示顺序） */
export const WINDOW_PRESET_OPTIONS: Array<{ value: ContextWindowPreset; label: string }> = [
  { value: 'small', label: '小' },
  { value: 'medium', label: '中' },
  { value: 'large', label: '大' },
];

interface WindowPresetChipClasses {
  group: string;
  label: string;
  chip: string;
  chipActive: string;
}

/** bili 皮肤：类名与 BiliQaPanel 既有标记逐字一致（PANEL_CSS 继续提供样式） */
const BILI_CLASSES: WindowPresetChipClasses = {
  group: 'bili-qa-window',
  label: 'bili-qa-window-label',
  chip: 'bili-qa-window-chip',
  chipActive: 'is-active',
};

/** hdu 皮肤：hdu- 前缀避免与 styles.ts 既有类冲突（已核对无 .hdu-window-*） */
const HDU_CLASSES: WindowPresetChipClasses = {
  group: 'hdu-window-chips',
  label: 'hdu-window-chips-label',
  chip: 'hdu-window-chip',
  chipActive: 'is-active',
};

/** hdu 皮肤的紧凑样式（组件自注入，作用域=所在 shadow root；变量随 .hdu-root 暗色切换） */
const HDU_CHIPS_CSS = String.raw`
.hdu-window-chips { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; }
.hdu-window-chips-label { font-size: 10.5px; color: var(--muted); white-space: nowrap; }
.hdu-window-chip {
  padding: 2px 9px; border-radius: 99px; border: 1px solid var(--line);
  background: color-mix(in srgb, var(--paper-2) 70%, transparent);
  color: var(--muted); font-size: 11px; line-height: 1.6; font-family: inherit;
  white-space: nowrap; transition: border-color .15s ease, background-color .15s ease, color .15s ease;
}
.hdu-window-chip:hover { border-color: var(--accent); color: var(--accent); }
.hdu-window-chip.is-active {
  background: var(--accent-soft); border-color: transparent; color: var(--accent); font-weight: 500;
}
`;

export function WindowPresetChips({
  value,
  onSelect,
  ariaLabel,
  titlePrefix,
  titleSuffix,
  variant = 'bili',
}: {
  /** 当前选中档（受控）：初值由父级取全局设置 */
  value: ContextWindowPreset;
  /** 点选上抛：父级在回调里登记「已交互」并更新受控值 */
  onSelect: (preset: ContextWindowPreset) => void;
  /** 无障碍组标签（区分问答 / 标注等用途） */
  ariaLabel: string;
  /** tooltip 前缀（如「问答上下文窗口」） */
  titlePrefix: string;
  /** tooltip 括号内的影响范围说明 */
  titleSuffix: string;
  /** 皮肤：bili=B 站面板既有类（缺省，外观零变化）；hdu=HDU 面板自注入样式 */
  variant?: 'bili' | 'hdu';
}) {
  const cls = variant === 'hdu' ? HDU_CLASSES : BILI_CLASSES;
  return (
    <>
      {variant === 'hdu' ? <style>{HDU_CHIPS_CSS}</style> : null}
      <div className={cls.group} role="group" aria-label={ariaLabel}>
        <span className={cls.label}>窗口</span>
        {WINDOW_PRESET_OPTIONS.map((option) => (
          <button
            type="button"
            key={option.value}
            className={`${cls.chip}${value === option.value ? ` ${cls.chipActive}` : ''}`}
            onClick={() => onSelect(option.value)}
            title={`${titlePrefix}·${option.label}档（${titleSuffix}）`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </>
  );
}
