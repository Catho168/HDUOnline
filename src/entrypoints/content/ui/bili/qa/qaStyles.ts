/**
 * B 站「学习助手」面板样式（第 50 轮自 BiliQaPanel.tsx 纯搬移拆分，样式逐行未变）：
 * 作用域限定在 .bili-qa-scope；变量与 backdrop/modal 同 BiliSubtitlePanel 的
 * PANEL_CSS 取值，B 站宿主的 shadow root 内全局生效，不污染站点。唯一样式来源，
 * 由 BiliQaPanel 以 <style>{QA_PANEL_CSS}</style> 注入。
 */

export const QA_PANEL_CSS = String.raw`
.bili-qa-scope {
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
  position: fixed;
  inset: 0;
  z-index: 2147483001;
  background: rgba(0,0,0,.45);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: bili-fadein .15s ease;
}
.bili-qa-scope .bili-modal {
  background: var(--b-paper);
  border-radius: var(--b-radius);
  box-shadow: var(--b-shadow);
  width: 460px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  overflow-y: auto;
  animation: bili-slideup .2s ease;
  display: flex;
  flex-direction: column;
}
.bili-qa-scope .bili-modal-head { padding: 20px 20px 0; display: flex; align-items: center; justify-content: space-between; }
.bili-qa-scope .bili-modal-head h3 { margin: 0; font-size: 16px; font-weight: 600; }
.bili-qa-scope .bili-modal-close {
  width: 28px; height: 28px; border-radius: 50%; border: none; background: transparent;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  color: #999; transition: background .15s;
}
.bili-qa-scope .bili-modal-close:hover { background: var(--b-paper-2); }
.bili-qa-scope .bili-qa-meta { padding: 6px 20px 0; font-size: 12px; color: #999; }
.bili-qa-scope .bili-qa-toolbar {
  padding: 10px 20px 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
}
.bili-qa-scope .bili-qa-moment, .bili-qa-scope .bili-qa-newchat {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 12px; border-radius: 15px; border: 1px solid var(--b-line);
  background: var(--b-paper); color: var(--b-accent);
  font-size: 12px; font-weight: 500; font-family: inherit; cursor: pointer;
  transition: border-color .15s, background .15s;
}
.bili-qa-scope .bili-qa-moment:hover, .bili-qa-scope .bili-qa-newchat:hover { border-color: var(--b-accent); background: var(--b-accent-soft); }
.bili-qa-scope .bili-qa-moment:disabled { opacity: .6; cursor: wait; }
.bili-qa-scope .bili-qa-moment svg { width: 13px; height: 13px; }
/* 问答上下文窗口档位（第 27 轮）：紧凑三档选择，贴工具行右缘，不挤占主操作按钮 */
.bili-qa-scope .bili-qa-window {
  margin-left: auto; display: inline-flex; align-items: center; gap: 4px;
}
.bili-qa-scope .bili-qa-window-label { font-size: 11px; color: #999; white-space: nowrap; }
.bili-qa-scope .bili-qa-window-chip {
  padding: 3px 9px; border-radius: 12px; border: 1px solid var(--b-line);
  background: var(--b-paper); color: #666; font-size: 11px; font-family: inherit;
  cursor: pointer; white-space: nowrap; transition: border-color .15s, background .15s, color .15s;
}
.bili-qa-scope .bili-qa-window-chip:hover { border-color: var(--b-accent); color: var(--b-accent); }
.bili-qa-scope .bili-qa-window-chip.is-active {
  background: var(--b-accent-soft); border-color: var(--b-accent); color: var(--b-accent); font-weight: 500;
}
.bili-qa-scope .bili-qa-body {
  padding: 10px 20px 6px; overflow-y: auto; min-height: 140px; flex: 1;
  display: flex; flex-direction: column; gap: 10px;
}
.bili-qa-scope .bili-qa-msg { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; }
.bili-qa-scope .bili-qa-msg.is-user { align-items: flex-end; }
.bili-qa-scope .bili-qa-bubble {
  max-width: 88%; padding: 8px 12px; border-radius: 10px; font-size: 13px; line-height: 1.6;
  white-space: pre-wrap; word-break: break-word;
}
.bili-qa-scope .is-user .bili-qa-bubble { background: var(--b-accent); color: #fff; border-bottom-right-radius: 3px; }
.bili-qa-scope .is-ai .bili-qa-bubble { background: var(--b-paper-2); color: var(--b-ink); border-bottom-left-radius: 3px; }
.bili-qa-scope .is-failed .bili-qa-bubble { background: rgba(244,90,90,.12); color: var(--b-danger); }
.bili-qa-scope .is-streaming .bili-qa-bubble { color: #999; }
/* 「生成中」呼吸点：流式增量是 JSON 片段不渲染，仅以指示动画表达进行中 */
.bili-qa-scope .bili-qa-bubble::after {
  content: ""; display: inline-block; width: 6px; height: 6px; margin-left: 6px;
  border-radius: 50%; background: var(--b-accent); vertical-align: 2px;
  animation: bili-qa-blink 1s ease-in-out infinite;
}
.bili-qa-scope .is-user .bili-qa-bubble::after, .bili-qa-scope .is-done .bili-qa-bubble::after { display: none; }
@keyframes bili-qa-blink { 0%, 100% { opacity: .25; } 50% { opacity: 1; } }
.bili-qa-scope .bili-qa-evidence {
  border: none; background: transparent; color: var(--b-accent); cursor: pointer;
  font-size: 12px; font-family: inherit; padding: 0 2px; font-variant-numeric: tabular-nums;
}
.bili-qa-scope .bili-qa-evidence:hover { text-decoration: underline; }
/* AI 消息操作区（第 33 轮）：依据跳转 + 收藏回答（icon-btn 形态，对齐 HDU PlayPanel） */
.bili-qa-scope .bili-qa-msg-actions { display: flex; align-items: center; gap: 6px; }
.bili-qa-scope .bili-qa-fav {
  border: none; background: transparent; color: #999; cursor: pointer; padding: 2px;
  border-radius: 5px; display: inline-flex; align-items: center; justify-content: center;
  transition: color .15s, background .15s;
}
.bili-qa-scope .bili-qa-fav svg { width: 14px; height: 14px; }
.bili-qa-scope .bili-qa-fav:hover { color: var(--b-accent); background: var(--b-accent-soft); }
.bili-qa-scope .bili-qa-fav:disabled { color: var(--b-accent); opacity: .45; cursor: default; background: transparent; }
.bili-qa-scope .bili-qa-empty { padding: 26px 12px; text-align: center; color: #999; font-size: 13px; }
.bili-qa-scope .bili-qa-hint { margin-top: 8px; font-size: 12px; color: #bbb; }
.bili-qa-scope .bili-qa-error { padding: 0 20px 8px; font-size: 12px; color: var(--b-danger); }
.bili-qa-scope .bili-qa-composer {
  padding: 8px 20px 20px; display: flex; gap: 8px; align-items: center;
}
.bili-qa-scope .bili-qa-composer input {
  flex: 1; min-width: 0; padding: 9px 12px; border: 1px solid var(--b-line);
  border-radius: 8px; font-size: 13px; font-family: inherit; outline: none;
  background: var(--b-paper); color: var(--b-ink); transition: border-color .15s;
}
.bili-qa-scope .bili-qa-composer input:focus { border-color: var(--b-accent); }
.bili-qa-scope .bili-qa-composer input:disabled { opacity: .6; }
.bili-qa-scope .bili-qa-composer input::placeholder { color: #999; }
.bili-qa-scope .bili-qa-send {
  padding: 9px 16px; border-radius: 8px; border: none; background: var(--b-accent);
  color: #fff; font-size: 13px; font-weight: 500; font-family: inherit; cursor: pointer;
  white-space: nowrap; transition: background .15s;
}
.bili-qa-scope .bili-qa-send:hover { background: var(--b-accent-hover); }
.bili-qa-scope .bili-qa-send:disabled { opacity: .5; cursor: not-allowed; }
/* ───────── 面板分区标签（第 25 轮：问答 / AI 标注） ───────── */
.bili-qa-scope .bili-qa-tabs {
  display: flex; gap: 2px; padding: 10px 20px 0;
  border-bottom: 1px solid var(--b-line);
}
.bili-qa-scope .bili-qa-tab {
  padding: 7px 14px; border: none; background: transparent; font-family: inherit;
  font-size: 13px; font-weight: 500; color: #666; cursor: pointer;
  border-bottom: 2px solid transparent; transition: color .15s, border-color .15s;
}
.bili-qa-scope .bili-qa-tab:hover { color: var(--b-accent); }
.bili-qa-scope .bili-qa-tab.is-active { color: var(--b-accent); border-bottom-color: var(--b-accent); }
/* AI 标注区：生成入口 / 生成中指示 / 知识点 / 大纲 */
.bili-qa-scope .bili-ai-empty { padding: 30px 16px; text-align: center; color: #999; font-size: 13px; }
.bili-qa-scope .bili-ai-generate {
  margin-top: 12px; padding: 8px 18px; border-radius: 8px; border: none;
  background: var(--b-accent); color: #fff; font-size: 13px; font-weight: 500;
  font-family: inherit; cursor: pointer; transition: background .15s;
}
.bili-qa-scope .bili-ai-generate:hover { background: var(--b-accent-hover); }
.bili-qa-scope .bili-ai-generate:disabled { opacity: .5; cursor: not-allowed; }
.bili-qa-scope .bili-ai-busy {
  display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  background: var(--b-accent-soft); border-radius: 8px; font-size: 12px; color: var(--b-accent);
}
.bili-qa-scope .bili-ai-busy-dot {
  width: 8px; height: 8px; border-radius: 50%; background: var(--b-accent); flex-shrink: 0;
  animation: bili-qa-blink 1s ease-in-out infinite;
}
.bili-qa-scope .bili-ai-stop {
  margin-left: auto; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--b-accent);
  background: transparent; color: var(--b-accent); font-size: 12px; font-family: inherit;
  cursor: pointer; white-space: nowrap;
}
.bili-qa-scope .bili-ai-stop:hover { background: rgba(255,255,255,.5); }
.bili-qa-scope .bili-ai-section { margin-bottom: 14px; }
.bili-qa-scope .bili-ai-section-head {
  font-size: 12px; font-weight: 600; color: #999; margin-bottom: 6px;
  display: flex; align-items: center; gap: 6px;
}
.bili-qa-scope .bili-ai-section-head span { font-weight: 400; }
.bili-qa-scope .bili-ai-topic {
  padding: 8px 10px; border: 1px solid var(--b-line); border-radius: 8px; margin-bottom: 6px;
}
.bili-qa-scope .bili-ai-topic.is-low { opacity: .65; }
.bili-qa-scope .bili-ai-topic-head { display: flex; align-items: center; gap: 6px; }
.bili-qa-scope .bili-ai-topic-name {
  border: none; background: transparent; padding: 0; font: inherit; color: var(--b-ink);
  cursor: pointer; text-align: left;
}
.bili-qa-scope .bili-ai-topic-name:hover { color: var(--b-accent); text-decoration: underline; }
.bili-qa-scope .bili-ai-topic-conf {
  font-size: 10px; color: #999; border: 1px solid var(--b-line); border-radius: 8px; padding: 0 6px;
}
.bili-qa-scope .bili-ai-topic-summary { margin-top: 4px; font-size: 12px; color: #666; line-height: 1.5; }
.bili-qa-scope .bili-ai-topic-times { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px; }
.bili-qa-scope .bili-ai-time {
  border: none; background: var(--b-paper-2); color: var(--b-accent); border-radius: 5px;
  font-size: 11px; font-family: inherit; padding: 2px 7px; cursor: pointer; font-variant-numeric: tabular-nums;
}
.bili-qa-scope .bili-ai-time:hover { background: var(--b-accent-soft); }
.bili-qa-scope .bili-ai-outline {
  display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  border: none; background: transparent; padding: 5px 8px; border-radius: 6px;
  cursor: pointer; font-family: inherit; color: var(--b-ink);
}
.bili-qa-scope .bili-ai-outline:hover { background: var(--b-paper-2); }
.bili-qa-scope .bili-ai-outline.is-l2 { padding-left: 24px; }
.bili-qa-scope .bili-ai-outline-title {
  flex: 1; min-width: 0; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bili-qa-scope .bili-ai-outline-time { font-size: 11px; color: #999; font-variant-numeric: tabular-nums; }
.bili-qa-scope .bili-ai-retry {
  border: 1px solid var(--b-line); background: var(--b-paper); color: var(--b-accent);
  border-radius: 6px; font-size: 12px; font-family: inherit; padding: 2px 10px;
  cursor: pointer; margin-left: 8px;
}
.bili-qa-scope .bili-ai-retry:hover { border-color: var(--b-accent); }
.bili-qa-scope .bili-ai-regen-note { font-size: 11px; color: #999; margin-bottom: 8px; }
/* ───────── 笔记页签（第 26 轮）：时间点笔记列表 + 底部输入区 ───────── */
.bili-qa-scope .bili-note-item {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 8px 10px; border: 1px solid var(--b-line); border-radius: 8px;
}
.bili-qa-scope .bili-note-time {
  border: none; background: var(--b-paper-2); color: var(--b-accent); border-radius: 5px;
  font-size: 11px; font-family: inherit; padding: 2px 7px; cursor: pointer;
  font-variant-numeric: tabular-nums; white-space: nowrap; flex-shrink: 0; margin-top: 1px;
}
.bili-qa-scope .bili-note-time:hover { background: var(--b-accent-soft); }
.bili-qa-scope .bili-note-text {
  flex: 1; min-width: 0; font-size: 13px; line-height: 1.6;
  white-space: pre-wrap; word-break: break-word;
}
.bili-qa-scope .bili-note-del {
  border: none; background: transparent; color: #999; font-size: 12px; font-family: inherit;
  cursor: pointer; white-space: nowrap; flex-shrink: 0; padding: 2px 6px; border-radius: 5px;
  transition: background .15s, color .15s;
}
.bili-qa-scope .bili-note-del:hover { color: var(--b-danger); }
/* 笔记「转收藏」（第 33 轮）：与删除同排的次要操作，主题色提示可转化 */
.bili-qa-scope .bili-note-convert {
  border: none; background: transparent; color: var(--b-accent); font-size: 12px; font-family: inherit;
  cursor: pointer; white-space: nowrap; flex-shrink: 0; padding: 2px 6px; border-radius: 5px;
  transition: background .15s, color .15s;
}
.bili-qa-scope .bili-note-convert:hover { background: var(--b-accent-soft); }
/* 两步确认态（useTwoStepConfirm 的 confirming）：警示底色 + 确认文案由组件切换 */
.bili-qa-scope .bili-note-del.is-confirm { color: #fff; background: var(--b-danger); }
.bili-qa-scope .bili-note-composer { align-items: flex-end; }
.bili-qa-scope .bili-note-composer textarea {
  flex: 1; min-width: 0; min-height: 56px; padding: 8px 12px;
  border: 1px solid var(--b-line); border-radius: 8px; font-size: 13px; font-family: inherit;
  line-height: 1.5; outline: none; resize: vertical; background: var(--b-paper); color: var(--b-ink);
  transition: border-color .15s;
}
.bili-qa-scope .bili-note-composer textarea:focus { border-color: var(--b-accent); }
.bili-qa-scope .bili-note-composer textarea:disabled { opacity: .6; }
.bili-qa-scope .bili-note-composer textarea::placeholder { color: #999; }
/* ───────── 速览页签（第 44 轮）：四格指标 + 回到上次的位置锚点 ───────── */
.bili-qa-scope .bili-ov-title { font-size: 13px; font-weight: 600; margin: 2px 0 10px; line-height: 1.5; }
.bili-qa-scope .bili-ov-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.bili-qa-scope .bili-ov-cell { border: 1px solid var(--b-line); border-radius: 8px; padding: 9px 12px; }
.bili-qa-scope .bili-ov-label { font-size: 11px; color: #999; margin-bottom: 3px; }
.bili-qa-scope .bili-ov-value { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
.bili-qa-scope .bili-ov-anchor-title { font-size: 12px; font-weight: 600; color: #999; margin: 14px 0 6px; }
.bili-qa-scope .bili-ov-anchor-list { display: flex; flex-wrap: wrap; gap: 6px; }
.bili-qa-scope .bili-ov-anchor {
  padding: 4px 10px; border-radius: 14px; border: 1px solid var(--b-line);
  background: var(--b-paper); color: var(--b-accent); font-size: 12px; font-family: inherit;
  cursor: pointer; transition: border-color .15s, background .15s;
}
.bili-qa-scope .bili-ov-anchor:hover { border-color: var(--b-accent); background: var(--b-accent-soft); }
/* 大纲页签当前节点高亮（第 44 轮，对齐 HDU OutlineTab 的 is-active） */
.bili-qa-scope .bili-ai-outline.is-active { background: var(--b-accent-soft); }
.bili-qa-scope .bili-ai-outline.is-active .bili-ai-outline-title { color: var(--b-accent); font-weight: 500; }
/* 暗色跟随 B 站宿主（.bili-root[data-theme] 由 isBiliHostDark 驱动）：
   只换面板变量，不硬编码行区颜色（与 BiliSubtitlePanel 的暗色口径一致） */
.bili-root[data-theme="dark"] .bili-qa-scope {
  --b-paper: #1d2126;
  --b-paper-2: #262b31;
  --b-line: #33383e;
  --b-ink: #e2e6ea;
  --b-accent: #2e86ab;
  --b-accent-hover: #3a97bd;
  --b-accent-soft: rgba(88, 184, 220, 0.16);
  color: var(--b-ink);
}
.bili-root[data-theme="dark"] .bili-qa-scope .bili-modal-close { color: #8a9199; }
.bili-root[data-theme="dark"] .bili-qa-scope .bili-qa-meta { color: #8a9199; }
.bili-root[data-theme="dark"] .bili-qa-scope .bili-qa-empty { color: #8a9199; }
.bili-root[data-theme="dark"] .bili-qa-scope .bili-qa-hint { color: #6d747b; }
.bili-root[data-theme="dark"] .bili-qa-scope .bili-qa-composer input::placeholder { color: #8a9199; }
.bili-root[data-theme="dark"] .bili-qa-scope .is-user .bili-qa-bubble { color: #fff; }
.bili-root[data-theme="dark"] .bili-qa-scope .is-streaming .bili-qa-bubble { color: #8a9199; }
.bili-root[data-theme="dark"] .bili-qa-scope .bili-qa-tab { color: #8a9199; }
.bili-root[data-theme="dark"] .bili-qa-scope .bili-qa-tab.is-active { color: #58b8dc; border-bottom-color: #58b8dc; }
.bili-root[data-theme="dark"] .bili-qa-scope .bili-qa-window-label { color: #8a9199; }
.bili-root[data-theme="dark"] .bili-qa-scope .bili-qa-window-chip { color: #8a9199; }
.bili-root[data-theme="dark"] .bili-qa-scope .bili-ai-empty { color: #8a9199; }
.bili-root[data-theme="dark"] .bili-qa-scope .bili-ai-section-head { color: #8a9199; }
.bili-root[data-theme="dark"] .bili-qa-scope .bili-ai-topic-summary { color: #a6adb5; }
.bili-root[data-theme="dark"] .bili-qa-scope .bili-ai-topic-conf { color: #8a9199; border-color: #33383e; }
.bili-root[data-theme="dark"] .bili-qa-scope .bili-ai-outline-time { color: #8a9199; }
.bili-root[data-theme="dark"] .bili-qa-scope .bili-ai-stop:hover { background: rgba(255,255,255,.08); }
.bili-root[data-theme="dark"] .bili-qa-scope .bili-ai-regen-note { color: #8a9199; }
.bili-root[data-theme="dark"] .bili-qa-scope .bili-qa-fav { color: #8a9199; }
.bili-root[data-theme="dark"] .bili-qa-scope .bili-note-del { color: #8a9199; }
.bili-root[data-theme="dark"] .bili-qa-scope .bili-note-composer textarea::placeholder { color: #8a9199; }
.bili-root[data-theme="dark"] .bili-qa-scope .bili-ov-label,
.bili-root[data-theme="dark"] .bili-qa-scope .bili-ov-anchor-title { color: #8a9199; }
@keyframes bili-fadein { from { opacity: 0; } to { opacity: 1; } }
@keyframes bili-slideup { from { transform: translateY(16px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

/* 速览页签「本周学习小结」mini 卡（第 81 轮巡检）：单行 flex，站内外合计 + 环比 + 指引 */
.bili-qa-scope .bili-qa-weekly {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-bottom: 10px; padding: 8px 10px;
  border: 1px solid var(--b-line); border-radius: 10px; background: var(--b-paper-2);
  font-size: 12px; color: var(--b-ink);
}
.bili-qa-scope .bili-qa-weekly-label { font-weight: 600; }
.bili-qa-scope .bili-qa-weekly-value { color: var(--b-accent); font-weight: 700; }
.bili-qa-scope .bili-qa-weekly-delta.is-up { color: var(--b-accent); }
.bili-qa-scope .bili-qa-weekly-delta.is-down { color: var(--b-danger); }
.bili-qa-scope .bili-qa-weekly-hint { margin-left: auto; color: var(--b-ink); opacity: .55; }

/* 会话历史（第 88 轮巡检）：面板内模态，查看/删除历史问答会话 */
.bili-qa-scope .bili-qa-history-backdrop {
  position: fixed; inset: 0; z-index: 20; background: rgba(0, 0, 0, .45);
  display: grid; place-items: center;
}
.bili-qa-scope .bili-qa-history {
  width: min(460px, 92vw); max-height: 72vh; overflow: auto;
  background: var(--b-paper); color: var(--b-ink); border-radius: 12px; padding: 12px;
}
.bili-qa-scope .bili-qa-history-head {
  display: flex; align-items: center; justify-content: space-between;
  font-weight: 600; font-size: 14px; margin-bottom: 10px;
}
.bili-qa-scope .bili-qa-history-close {
  border: none; background: transparent; color: var(--b-ink); font-size: 16px;
  cursor: pointer; padding: 2px 6px; border-radius: 6px;
}
.bili-qa-scope .bili-qa-history-close:hover { background: var(--b-paper-2); }
.bili-qa-scope .bili-qa-history-item {
  border: 1px solid var(--b-line); border-radius: 10px; padding: 8px 10px; margin-bottom: 8px;
}
.bili-qa-scope .bili-qa-history-main { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.bili-qa-scope .bili-qa-history-title { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bili-qa-scope .bili-qa-history-meta { display: flex; gap: 8px; font-size: 11px; color: var(--b-ink); opacity: .6; }
.bili-qa-scope .bili-qa-history-actions { display: flex; gap: 6px; flex: none; }
.bili-qa-scope .bili-qa-history-preview {
  margin-top: 8px; padding: 8px; border-radius: 8px; background: var(--b-paper-2);
  max-height: 220px; overflow: auto;
}
.bili-qa-scope .bili-qa-history-msg { font-size: 12px; line-height: 1.6; margin-bottom: 6px; }
.bili-qa-scope .bili-qa-history-msg b { margin-right: 6px; color: var(--b-accent); }
.bili-qa-scope .bili-qa-history-msg p { margin: 2px 0 0; white-space: pre-wrap; word-break: break-word; }
.bili-qa-scope .bili-qa-history-anchor {
  border: none; background: transparent; color: var(--b-accent); font-size: 11px;
  cursor: pointer; padding: 0 2px; font-family: inherit;
}
.bili-qa-scope .bili-qa-history-anchor:hover { text-decoration: underline; }
/* 跨 P 聚合（第 104 轮巡检）：开关胶囊 + 分 P 徽标 */
.bili-qa-scope .bili-qa-crossp {
  border: 1px solid var(--b-line); background: var(--b-paper); color: var(--b-ink);
  font-size: 12px; line-height: 1; padding: 5px 10px; border-radius: 999px; cursor: pointer;
  font-family: inherit; flex: none;
}
.bili-qa-scope .bili-qa-crossp:hover { border-color: var(--b-accent); color: var(--b-accent); }
.bili-qa-scope .bili-qa-crossp.is-active {
  background: var(--b-accent-soft); border-color: var(--b-accent); color: var(--b-accent); font-weight: 600;
}
.bili-qa-scope .bili-qa-crossp-hint { font-size: 11px; color: var(--b-ink); opacity: .55; }
.bili-qa-scope .bili-qa-pbadge {
  flex: none; font-size: 10px; font-weight: 600; line-height: 1; padding: 3px 6px;
  border-radius: 999px; background: var(--b-accent-soft); color: var(--b-accent);
}
`;
