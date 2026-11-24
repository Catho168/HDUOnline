/**
 * 快捷键速查浮层（第 223 轮巡检首立于 HDU 播放页；第 224 轮抽为 HDU/B 站共享组件；
 * 第 240 轮巡检核对补齐：清单改为模块常量 SHORTCUT_SHEET_GROUPS + 作用域说明 +
 * 通用键位分组——与实现注册处逐条对照（对照表见巡检日志第 240 轮「二、研判」），
 * 一致性由 tests/unit/shortcuts-sheet.test.ts 锁定）。
 *
 * 键位实时读取调用方传入的 settings.shortcuts——用户自定义值即所见；
 * 固定行为键（Esc 关闭弹层，components.tsx 共享浮层栈派发）不随设置。
 * 实现上全部为单键（不响应 Ctrl/Cmd/Alt 组合，修饰键一律让行站点），无平台差异。
 */
import { Modal } from './components';
import type { ShortcutMap } from '@/core/shared/types';

/** 可配置键位（ShortcutMap 的键）或固定键位（settingKey=null 时用 fixedKey） */
export interface ShortcutSheetRow {
  /** 对应 settings.shortcuts 的键；null = 固定行为键（见 fixedKey） */
  settingKey: 'ask' | 'favorite' | 'note' | 'prevTopic' | 'nextTopic' | null;
  /** 固定键位展示名（settingKey 为 null 时必填） */
  fixedKey?: string;
  /** 作用说明 */
  desc: string;
  /** 生效范围（与实现注册处一一对应） */
  scope: string;
}

/** 速查清单常量（第 240 轮盘点产物，测试锁定「注册键位 vs 浮层清单」一一对应）：
 *  - 播放页组：HDU onShortcut（content/index.tsx，仅播放路由）与 B 站
 *    BiliCollectApp/BiliQaPanel 的键位完全对齐；
 *  - 通用组：Esc 由共享浮层栈统一派发（components.tsx escapeLayerStack），栈顶消费。
 */
export const SHORTCUT_SHEET_GROUPS: Array<{ title: string; rows: ShortcutSheetRow[] }> = [
  {
    title: '播放页快捷键（可在设置中自定义）',
    rows: [
      { settingKey: 'ask', desc: 'AI 问答（以当前播放位置为锚点提问）', scope: 'HDU 播放页 · B 站学习中心' },
      { settingKey: 'favorite', desc: '收藏此时刻（存入知识库）', scope: 'HDU 播放页 · B 站学习中心' },
      { settingKey: 'note', desc: '新增时间点笔记（打开笔记页签）', scope: 'HDU 播放页 · B 站学习中心' },
      { settingKey: 'prevTopic', desc: '上一个大纲 / 知识点', scope: 'HDU 播放页 · B 站问答面板打开时' },
      { settingKey: 'nextTopic', desc: '下一个大纲 / 知识点', scope: 'HDU 播放页 · B 站问答面板打开时' },
    ],
  },
  {
    title: '通用',
    rows: [{ settingKey: null, fixedKey: 'Esc', desc: '关闭弹层 / 浮层（栈顶优先）', scope: '通用（HDU 与 B 站全部弹窗）' }],
  },
];

export function ShortcutsModal({
  open,
  onClose,
  shortcuts,
}: {
  open: boolean;
  onClose: () => void;
  shortcuts: ShortcutMap;
}) {
  return (
    <Modal open={open} title="快捷键速查" onClose={onClose} width={380}>
      <div className="hdu-shortcut-sheet" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {SHORTCUT_SHEET_GROUPS.map((group) => (
          <div key={group.title} className="hdu-shortcut-group">
            <div className="hdu-shortcut-group-title">{group.title}</div>
            {group.rows.map((row) => {
              const keyLabel = row.settingKey ? shortcuts[row.settingKey] : row.fixedKey ?? '';
              return (
                <div key={row.desc} className="hdu-shortcut-row">
                  <kbd
                    style={{
                      flex: 'none',
                      minWidth: 34,
                      textAlign: 'center',
                      padding: '3px 8px',
                      borderRadius: 6,
                      border: '1px solid var(--line, rgba(127,127,127,.35))',
                      fontVariantNumeric: 'tabular-nums',
                      fontWeight: 600,
                    }}
                  >
                    {keyLabel}
                  </kbd>
                  <span className="hdu-shortcut-main">
                    <span>{row.desc}</span>
                    <span className="hdu-shortcut-scope">{row.scope}</span>
                  </span>
                </div>
              );
            })}
          </div>
        ))}
        <div className="hdu-hint" style={{ marginTop: 4 }}>
          均为单键，无平台差异（Ctrl/Cmd/Alt 组合一律让行站点）；输入状态下自动让行站点播放器原生按键；以上可配置按键均可在设置页自定义。
        </div>
      </div>
    </Modal>
  );
}
