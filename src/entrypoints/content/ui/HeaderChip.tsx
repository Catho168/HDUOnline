/**
 * 播放页顶栏 chip（注入式 UI 第一阶段）。
 *
 * 渲染在站点 `.play-header` 末尾的独立 shadow host 内（由 site/anchor.ts 挂载），
 * 与站点原生顶栏融合，替代顶部浮窗胶囊（SessionCapsule）成为面板入口。
 *
 * 设计铁律（对应技术实现文档注入条款修订）：
 *  - 自有令牌 + 组件内自包含 CSS，不继承站点类名 / 不用站点 CSS 变量；
 *  - 只读对齐：启动时读取站点 `.play-header .title` 的计算颜色与字号做视觉融合，失败用默认值；
 *  - chip 文本不出现「教师：/老师：」与日期时间样式（防污染课次识别证据链）；
 *  - 点击行为与浮窗胶囊完全一致（togglePanel，同一 store 动作）。
 */

import { useEffect, useState } from 'react';
import { Icon } from './icons';
import { uiStore, useUiStore } from './store';

export const CHIP_CSS = `
:host { all: initial; }
.hdu-anchor-chip {
  display: inline-flex; align-items: center; gap: 7px;
  height: 30px; padding: 0 12px 0 10px;
  margin-left: 4px; flex-shrink: 0;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.14);
  background: rgba(15, 23, 42, 0.045);
  color: #1f2937;
  font-size: 12.5px; line-height: 1; white-space: nowrap;
  cursor: pointer; user-select: none;
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  transition: background .15s ease, border-color .15s ease;
  animation: hdu-anchor-chip-in .2s ease-out;
}
.hdu-anchor-chip:hover { background: rgba(15, 23, 42, 0.085); }
.hdu-anchor-chip:active { background: rgba(15, 23, 42, 0.12); }
.hdu-anchor-chip svg { flex: 0 0 auto; }
.hdu-anchor-chip-name { font-weight: 600; max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
.hdu-anchor-chip-label { opacity: 0.72; max-width: 140px; overflow: hidden; text-overflow: ellipsis; }
.hdu-anchor-chip-dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; }
.hdu-anchor-chip-dot.ok { background: #16a34a; }
.hdu-anchor-chip-dot.err { background: #dc2626; }
.hdu-anchor-chip-dot.warn { background: #d97706; }
@keyframes hdu-anchor-chip-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
/* 第 17 轮实测修复（P2-1）：≤900px 隐藏课次标签，避免 chip 占宽把站点顶栏文本挤到换行
   （实测 768/820 下 header 46→67px、站点标题两行；隐藏约 145px 标签恢复单行压力） */
@media (max-width: 900px) {
  .hdu-anchor-chip-label { display: none; }
}
`;

/** 只读读取站点顶栏标题的计算样式，融合字号与文字颜色；读取失败返回默认值。
 *  resolved 标记是否真正读到了站点标题（第 16 轮 P3：对齐哨兵从「颜色 != 默认值」
 *  的隐式推断改为显式状态——站点标题色恰为默认色 #1f2937 时旧实现会永远空转轮询）。 */
function readHeaderAffinity(header: HTMLElement | null): { color: string; fontSize: string; resolved: boolean } {
  const defaults = { color: '#1f2937', fontSize: '12.5px', resolved: false };
  try {
    const title = header?.querySelector('.title, .course-title');
    if (!title) return defaults;
    const style = getComputedStyle(title);
    const sizePx = Number.parseFloat(style.fontSize);
    return {
      color: /^#[0-9a-f]+|^rgb/.test(style.color) ? style.color : defaults.color,
      fontSize: Number.isFinite(sizePx) && sizePx >= 11 && sizePx <= 16 ? `${Math.max(11.5, sizePx - 2.5)}px` : defaults.fontSize,
      resolved: true,
    };
  } catch {
    return defaults;
  }
}

export function HeaderChip() {
  const state = useUiStore();
  const session = state.session;
  const resolution = state.resolution;
  const [affinity, setAffinity] = useState(() => readHeaderAffinity(document.querySelector('.play-header')));
  // 对齐哨兵（显式状态）：resolve 到站点标题后即停止轮询，颜色是否恰好等于默认值不再参与判断
  const affinityResolved = affinity.resolved;

  // 站点顶栏可能晚于 chip 挂载或被 Vue 重渲染：未 resolve 时周期性重试只读对齐
  useEffect(() => {
    if (affinityResolved) return;
    const timer = window.setInterval(() => {
      const next = readHeaderAffinity(document.querySelector('.play-header'));
      if (next.resolved) {
        setAffinity(next);
        window.clearInterval(timer);
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [affinityResolved]);

  if (!session && resolution.phase === 'idle') return null;
  const status = resolution.phase === 'resolved' ? 'ok' : resolution.phase === 'unresolved' ? 'err' : 'warn';
  return (
    <button
      type="button"
      className="hdu-anchor-chip"
      onClick={() => uiStore.actions.togglePanel()}
      title="打开本节助手"
      style={{ color: affinity.color, fontSize: affinity.fontSize }}
    >
      <Icon name="book" size={13} />
      <span className="hdu-anchor-chip-name">{session?.courseName ?? '智慧课堂'}</span>
      <span className="hdu-anchor-chip-label">· {session?.courLabel ?? (resolution.phase === 'resolving' ? '识别课次中' : '待识别课次')}</span>
      <span className={`hdu-anchor-chip-dot ${status}`} />
    </button>
  );
}
