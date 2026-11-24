// B 站内容脚本宿主样式（BILI_CSS）：收藏 FAB/弹窗、字幕/学习助手/学习中心入口、
// AI 标注时间轴条与 toast 的全部规则。自 bilibili.content.tsx 第 41 轮巡检按内聚块
// 纯搬移拆分，样式逐行未变；仍由 bilibili.content.tsx main 注入 shadow DOM（<style data-bili-collect>）。

export const BILI_CSS = String.raw`
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
.bili-root {
  --b-ink: #171a1d;
  --b-paper: #fff;
  --b-paper-2: #f6f7f8;
  --b-line: #e3e5e7;
  --b-accent: #00a1d6;
  --b-accent-hover: #00b5e5;
  --b-accent-soft: #e8f7ff;
  --b-danger: #f45a5a;
  --b-shadow: 0 4px 20px rgba(0,0,0,.12);
  --b-radius: 12px;
  --b-font: "PingFang SC", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif;
  font-family: var(--b-font);
  color: var(--b-ink);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

/* ───────── FAB 收敛（第 44 轮）：主入口 + 展开菜单 ─────────
   四枚常驻入口（收藏/字幕/学习助手/学习中心）合并为一枚主钮 + 上方竖排菜单。
   主钮 fixed 右下角独占 bottom:100 一格；菜单容器 fixed 于其上方，子钮保留原类名
   （.bili-fab/.bili-sub-fab/.bili-qa-fab/.bili-hub-fab）并常驻 DOM——收起态仅折叠
   视觉（opacity/transform）与指针（pointer-events:none），程序化 click（单测/e2e/
   工具栏探针联动）不受展开态影响。宿主是 pointer-events:none，交互层显式接管
   （与 content/ui/styles.ts 的约定一致）。 */
.bili-fab-main {
  position: fixed;
  right: 24px;
  bottom: 100px;
  z-index: 2147483000;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--b-accent);
  color: #fff;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 12px rgba(0,161,214,.35);
  transition: transform .15s, box-shadow .15s, background .15s;
  pointer-events: auto;
}
.bili-fab-main:hover {
  background: var(--b-accent-hover);
  box-shadow: 0 6px 18px rgba(0,161,214,.45);
}
.bili-fab-main svg { width: 22px; height: 22px; }
.bili-fab-main.is-open { transform: rotate(90deg); }
.bili-fab-main.is-open:hover { transform: rotate(90deg); }
.bili-fab-menu {
  position: fixed;
  right: 28px;
  bottom: 160px;
  z-index: 2147483000;
  display: flex;
  flex-direction: column-reverse;
  gap: 10px;
  pointer-events: none;
}
/* 子钮公共折叠态（:not(.is-open) 提升特异性，盖过 .bili-sub-fab:disabled 的 opacity）：
   收起不可见不可点；展开后显式恢复 pointer-events（容器 pointer-events:none 会被子钮
   继承，第 51 轮审计 P1-1：不在展开态恢复会导致真实指针点击穿透失效） */
.bili-fab-menu:not(.is-open) .bili-fab,
.bili-fab-menu:not(.is-open) .bili-sub-fab,
.bili-fab-menu:not(.is-open) .bili-qa-fab,
.bili-fab-menu:not(.is-open) .bili-hub-fab {
  opacity: 0;
  transform: translateY(6px) scale(.92);
  pointer-events: none;
}
.bili-fab-menu.is-open .bili-fab,
.bili-fab-menu.is-open .bili-sub-fab,
.bili-fab-menu.is-open .bili-qa-fab,
.bili-fab-menu.is-open .bili-hub-fab {
  pointer-events: auto;
}
.bili-fab {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--b-accent);
  color: #fff;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 12px rgba(0,161,214,.35);
  transition: transform .18s, opacity .18s, box-shadow .15s, background .15s;
}
.bili-fab:hover {
  background: var(--b-accent-hover);
  box-shadow: 0 6px 18px rgba(0,161,214,.45);
}
.bili-fab.is-collected {
  background: #fb7299;
  box-shadow: 0 4px 12px rgba(251,114,153,.35);
}
.bili-fab svg { width: 19px; height: 19px; }

/* 主钮今日到期复习数角标（第 77 轮巡检）：B 站粉与主钮蓝形成对比，白描边在
   明暗宿主下都与页面底色衔接；>0 才渲染（dueBadgeLabel 口径），>99 显示 99+ */
.bili-fab-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 99px;
  display: grid;
  place-items: center;
  box-sizing: border-box;
  background: #fb7299;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  font-family: var(--b-font);
  border: 2px solid rgba(255, 255, 255, .92);
  box-shadow: 0 1px 4px rgba(0, 0, 0, .2);
  pointer-events: none;
}

/* 菜单展开的次序感：子钮自下而上（DOM 序即视觉序，column-reverse）逐个弹入；
   收起不加延迟（.is-open 才生效），关闭仍干脆。减动效由文末全局规则兜底。 */
.bili-fab-menu.is-open .bili-fab { transition-delay: 0ms; }
.bili-fab-menu.is-open .bili-sub-fab { transition-delay: 40ms; }
.bili-fab-menu.is-open .bili-qa-fab { transition-delay: 80ms; }
.bili-fab-menu.is-open .bili-hub-fab { transition-delay: 120ms; }

/* 键盘焦点环：FAB 组五钮统一白环 + 品牌光晕，明暗宿主均可见 */
.bili-fab-main:focus-visible,
.bili-fab:focus-visible,
.bili-sub-fab:focus-visible,
.bili-qa-fab:focus-visible,
.bili-hub-fab:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
  box-shadow: 0 0 0 4px rgba(0, 161, 214, .35);
}

.bili-resume-chip {
  position: fixed;
  /* 第 44 轮 FAB 收敛后：主钮（.bili-fab-main）独占右下角 bottom:100 一格，
     续看 chip 移到主钮左侧同排，不再占用上方竖排槽位（原 332px 槽位随四枚
     竖排 FAB 一并取消） */
  right: 84px;
  bottom: 108px;
  z-index: 2147483000;
  padding: 7px 14px;
  border-radius: 16px;
  border: none;
  background: var(--b-paper);
  color: var(--b-accent);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(0,0,0,.18);
  transition: transform .15s, box-shadow .15s;
  pointer-events: auto;
}
.bili-resume-chip:hover {
  transform: scale(1.04);
  box-shadow: 0 6px 16px rgba(0,0,0,.22);
}

/* ───────── B 站深色主题适配 ─────────
   B 站官方深色模式下页面整体是深底，注入的 FAB（高饱和蓝 + 白图标）与续看 chip
   （纯白卡片）非常刺眼。宿主深色判定（isBiliHostDark）命中时给 .bili-root 挂
   data-theme="dark"，此处只覆盖 FAB / chip 自身的低亮度配色：
   FAB 降饱和深蓝、chip 深灰卡片（调性对齐 content/ui/styles.ts 的暗色 paper-2）+
   提亮文字、阴影换纯黑深投影。
   注意：不改共享变量（--b-paper/--b-accent 等同时被收藏弹窗使用，弹窗内还有多处
   硬编码浅色文字 #666/#999，整体换暗色会破坏可读性），收藏弹窗维持亮色。 */
.bili-root[data-theme="dark"] .bili-fab {
  background: #1c5d80;
  box-shadow: 0 4px 14px rgba(0,0,0,.5);
}
.bili-root[data-theme="dark"] .bili-fab-main {
  background: #1c5d80;
  box-shadow: 0 4px 14px rgba(0,0,0,.5);
}
.bili-root[data-theme="dark"] .bili-fab-main:hover {
  background: #26799f;
  box-shadow: 0 6px 18px rgba(0,0,0,.55);
}
.bili-root[data-theme="dark"] .bili-fab:hover {
  background: #26799f;
  box-shadow: 0 6px 18px rgba(0,0,0,.55);
}
.bili-root[data-theme="dark"] .bili-fab.is-collected {
  background: #b3496b;
  box-shadow: 0 4px 14px rgba(0,0,0,.5);
}
.bili-root[data-theme="dark"] .bili-resume-chip {
  background: #1d2126;
  color: #58b8dc;
  box-shadow: 0 4px 14px rgba(0,0,0,.5);
}
.bili-root[data-theme="dark"] .bili-resume-chip:hover {
  box-shadow: 0 6px 16px rgba(0,0,0,.6);
}

/* ───────── 字幕入口与查看浮层（第 14 轮字幕专项） ─────────
   入口：主 FAB 上方一枚独立小按钮（不动收藏流程的单击直达语义）。
   浮层样式已随第 15 轮共享化整体迁入 BiliSubtitlePanel.tsx（.bili-sub-scope 作用域，
   B 站与学习中心共用同一份实现与样式，此处不再重复维护 .bili-sub-* 行区规则）。 */
.bili-sub-fab {
  /* 定位由 .bili-fab-menu 容器管理（第 44 轮 FAB 收敛）；此处只保留皮肤 */
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--b-paper);
  color: var(--b-accent);
  border: 1px solid var(--b-line);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 12px rgba(0,0,0,.18);
  transition: transform .18s, opacity .18s, box-shadow .15s, border-color .15s;
}
.bili-sub-fab:hover {
  border-color: var(--b-accent);
  box-shadow: 0 6px 16px rgba(0,0,0,.22);
}
.bili-sub-fab:disabled { opacity: .6; cursor: wait; }
.bili-sub-fab svg { width: 19px; height: 19px; }
.bili-root[data-theme="dark"] .bili-sub-fab {
  background: #1d2126;
  color: #58b8dc;
  border-color: #33383e;
  box-shadow: 0 4px 14px rgba(0,0,0,.5);
}

/* ───────── 学习助手入口（第 24 轮功能扩展第一批；第 44 轮起为 FAB 菜单子钮） ─────────
   AI 时间点问答 + 收藏此时刻的统一入口：定位由 .bili-fab-menu 容器管理，此处只保留
   皮肤（问答面板 BiliQaPanel 与字幕浮层同壳不同组件，不新开独立浮窗体系）。 */
.bili-qa-fab {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--b-paper);
  color: var(--b-accent);
  border: 1px solid var(--b-line);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 12px rgba(0,0,0,.18);
  transition: transform .18s, opacity .18s, box-shadow .15s, border-color .15s;
}
.bili-qa-fab:hover {
  border-color: var(--b-accent);
  box-shadow: 0 6px 16px rgba(0,0,0,.22);
}
.bili-qa-fab svg { width: 19px; height: 19px; }
.bili-root[data-theme="dark"] .bili-qa-fab {
  background: #1d2126;
  color: #58b8dc;
  border-color: #33383e;
  box-shadow: 0 4px 14px rgba(0,0,0,.5);
}

/* ───────── 学习中心入口（第 32 轮巡检；第 44 轮起为 FAB 菜单子钮） ─────────
   知识库管理 + 统计的统一入口：定位由 .bili-fab-menu 容器管理，此处只保留皮肤。
   点击打开 BiliHubPanel——该面板挂在独立 shadow host（hdu-bili-hub-host，
   z-index 2147483001 模态浮层层）内，打开时盖住本宿主全部入口，关闭后让位。 */
.bili-hub-fab {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--b-paper);
  color: var(--b-accent);
  border: 1px solid var(--b-line);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 12px rgba(0,0,0,.18);
  transition: transform .18s, opacity .18s, box-shadow .15s, border-color .15s;
}
.bili-hub-fab:hover {
  border-color: var(--b-accent);
  box-shadow: 0 6px 16px rgba(0,0,0,.22);
}
.bili-hub-fab svg { width: 19px; height: 19px; }
.bili-root[data-theme="dark"] .bili-hub-fab {
  background: #1d2126;
  color: #58b8dc;
  border-color: #33383e;
  box-shadow: 0 4px 14px rgba(0,0,0,.5);
}

/* ───────── AI 标注时间轴叠加条（第 25 轮功能扩展第二批） ─────────
   行为对标 HDU 侧 App.tsx 的 TimelineLayer：aiResult.topics 的 intervals 换算成
   播放器宽度百分比，播放到区间高亮、点击 seek。定位用 <video> 的
   getBoundingClientRect（resize / SPA 换节点时由调用方重测跟随）。
   层级协调：宿主 stacking context（z-index 2147483000）内与 FAB 同层——页面内容
   之上、模态浮层（2147483001）/toast（2147483002）之下。 */
.bili-timeline {
  position: fixed;
  height: 10px;
  z-index: 2147483000;
  pointer-events: none;
}
.bili-timeline-mark {
  position: absolute;
  top: 0;
  height: 100%;
  min-width: 3px;
  padding: 0;
  border: none;
  border-radius: 2px;
  background: rgba(0, 161, 214, 0.5);
  cursor: pointer;
  pointer-events: auto;
  transition: background .15s;
}
.bili-timeline-mark:hover { background: rgba(0, 181, 229, 0.85); }
.bili-timeline-mark.is-low { background: rgba(0, 161, 214, 0.22); }
.bili-timeline-mark.is-active { background: #fb7299; }
.bili-root[data-theme="dark"] .bili-timeline-mark { background: rgba(88, 184, 220, 0.45); }
.bili-root[data-theme="dark"] .bili-timeline-mark.is-low { background: rgba(88, 184, 220, 0.2); }

.bili-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2147483001;
  background: rgba(0,0,0,.45);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: bili-fadein .15s ease;
  pointer-events: auto;
}
@keyframes bili-fadein { from { opacity: 0; } to { opacity: 1; } }

.bili-modal {
  background: var(--b-paper);
  border-radius: var(--b-radius);
  box-shadow: var(--b-shadow);
  width: 420px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  overflow-y: auto;
  animation: bili-slideup .2s ease;
}
@keyframes bili-slideup { from { transform: translateY(16px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

.bili-modal-head {
  padding: 20px 20px 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.bili-modal-head h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.bili-modal-close {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: none;
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #999;
  transition: background .15s;
}
.bili-modal-close:hover { background: var(--b-paper-2); }

.bili-video-preview {
  margin: 16px 20px 0;
  display: flex;
  gap: 12px;
  padding: 12px;
  background: var(--b-paper-2);
  border-radius: 8px;
}
.bili-video-cover {
  width: 120px;
  height: 75px;
  border-radius: 6px;
  object-fit: cover;
  flex-shrink: 0;
  background: #e3e5e7;
}
.bili-video-info { flex: 1; min-width: 0; }
.bili-video-title {
  font-size: 14px;
  font-weight: 500;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.bili-video-meta {
  margin-top: 6px;
  font-size: 12px;
  color: #999;
}

.bili-modal-body { padding: 16px 20px; }

.bili-field { margin-bottom: 14px; }
.bili-field-label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: #666;
  margin-bottom: 6px;
}

.bili-folder-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.bili-folder-chip {
  padding: 6px 14px;
  border-radius: 16px;
  border: 1px solid var(--b-line);
  background: var(--b-paper);
  font-size: 13px;
  cursor: pointer;
  transition: all .15s;
  color: var(--b-ink);
}
.bili-folder-chip:hover { border-color: var(--b-accent); color: var(--b-accent); }
.bili-folder-chip.is-active {
  background: var(--b-accent-soft);
  border-color: var(--b-accent);
  color: var(--b-accent);
  font-weight: 500;
}

.bili-new-folder {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.bili-new-folder input {
  flex: 1;
  padding: 6px 12px;
  border: 1px solid var(--b-line);
  border-radius: 6px;
  font-size: 13px;
  outline: none;
  transition: border-color .15s;
}
.bili-new-folder input:focus { border-color: var(--b-accent); }
.bili-new-folder button {
  padding: 6px 12px;
  border-radius: 6px;
  border: none;
  background: var(--b-accent);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
  transition: background .15s;
}
.bili-new-folder button:hover { background: var(--b-accent-hover); }

.bili-tags-input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--b-line);
  border-radius: 6px;
  font-size: 13px;
  outline: none;
  transition: border-color .15s;
}
.bili-tags-input:focus { border-color: var(--b-accent); }
.bili-tags-hint {
  margin-top: 4px;
  font-size: 12px;
  color: #999;
}

.bili-note-input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--b-line);
  border-radius: 6px;
  font-size: 13px;
  outline: none;
  resize: vertical;
  min-height: 60px;
  font-family: inherit;
  transition: border-color .15s;
}
.bili-note-input:focus { border-color: var(--b-accent); }

.bili-modal-foot {
  padding: 0 20px 20px;
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}
.bili-btn {
  padding: 8px 20px;
  border-radius: 6px;
  border: none;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all .15s;
}
.bili-btn-cancel {
  background: var(--b-paper-2);
  color: #666;
}
.bili-btn-cancel:hover { background: var(--b-line); }
.bili-btn-save {
  background: var(--b-accent);
  color: #fff;
}
.bili-btn-save:hover { background: var(--b-accent-hover); }
.bili-btn-save:disabled { opacity: .5; cursor: not-allowed; }

.bili-toast {
  position: fixed;
  top: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2147483002;
  padding: 10px 20px;
  border-radius: 8px;
  background: #333;
  color: #fff;
  font-size: 14px;
  box-shadow: 0 4px 12px rgba(0,0,0,.2);
  animation: bili-toast-in .2s ease;
}
/* 失败提示用红底变体；成功/「无字幕作罢」保持中性深灰（none 不是错误样式） */
.bili-toast.is-error { background: var(--b-danger); }
@keyframes bili-toast-in { from { opacity: 0; transform: translateX(-50%) translateY(-8px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }

/* 减动效：与 HDU 侧 UI_CSS 同口径，跟随系统偏好整体降时长（含 FAB 展开延迟） */
@media (prefers-reduced-motion: reduce) {
  .bili-root *, .bili-root *::before, .bili-root *::after {
    animation-duration: .001ms !important;
    transition-duration: .001ms !important;
    transition-delay: 0ms !important;
  }
}
`;
