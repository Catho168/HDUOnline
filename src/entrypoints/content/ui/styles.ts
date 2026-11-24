/** Shadow DOM 内的完整样式表。所有类名带 hdu- 前缀，不使用站点变量。 */

export const UI_CSS = String.raw`
:host {
  all: initial;
}
*, *::before, *::after { box-sizing: border-box; }
.hdu-root {
  --ink: #171a1d;
  --ink-soft: #474d52;
  /* 次要文字：比 #7b7f82 深一档，亮色侧对 paper 底色达到 AA 对比；暗色侧单独定义不受影响 */
  --muted: #6a6e71;
  --paper: #f5f1e8;
  --paper-2: #fffdf8;
  --paper-3: #eee8db;
  --line: #e2d9c8;
  --line-strong: #cfc3ad;
  --accent: #a4551b;
  --accent-2: #c47a36;
  --accent-soft: #f1e2cc;
  --jade: #0f766e;
  --jade-soft: #dcebe7;
  --danger: #a12a2a;
  --danger-soft: #f6e2df;
  --info: #1f4f8f;
  --info-soft: #e0e9f4;
  --gold: #8a6a1f;
  --shadow: 0 1px 2px rgba(23, 26, 29, .05), 0 18px 44px -24px rgba(23, 26, 29, .28);
  --shadow-soft: 0 1px 2px rgba(23, 26, 29, .04), 0 10px 24px -18px rgba(23, 26, 29, .22);
  --radius: 18px;
  --radius-sm: 12px;
  --font-sans: "PingFang SC", "Microsoft YaHei", "Segoe UI", system-ui, -apple-system, sans-serif;
  --font-serif: "Songti SC", "Noto Serif SC", "Source Han Serif SC", "STSong", Georgia, serif;
  --font-mono: "SFMono-Regular", "Cascadia Code", Consolas, monospace;
  font-family: var(--font-sans);
  color: var(--ink);
  font-size: 14px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
.hdu-root[data-theme="dark"] {
  --ink: #ece8dd;
  --ink-soft: #bcb6a8;
  /* 次要文字（第 253 轮暗色对比度抽查微调）：#8c877c 对 paper-3 底只有 4.25:1（AA 差
     一口气），提亮到 #948f84 后 paper/paper-2/paper-3 三档底全部 ≥4.5:1（与亮色侧
     第 240 轮 AA 收口同思路）；层级感仍由 --ink-soft 保住 */
  --muted: #948f84;
  --paper: #131518;
  --paper-2: #1a1d21;
  --paper-3: #22262b;
  --line: #2c3137;
  --line-strong: #3d444c;
  --accent: #dfa05a;
  --accent-2: #e9b87c;
  --accent-soft: #392a1a;
  --jade: #63d8c5;
  --jade-soft: #14322e;
  --danger: #f08a82;
  --danger-soft: #3a2020;
  --info: #8ab4ee;
  --info-soft: #1c2a3d;
  --gold: #d9b969;
  --shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 20px 48px -24px rgba(0, 0, 0, .7);
  --shadow-soft: 0 1px 2px rgba(0, 0, 0, .35), 0 10px 24px -18px rgba(0, 0, 0, .6);
}
.hdu-root h1, .hdu-root h2, .hdu-root h3, .hdu-root h4, .hdu-root p { margin: 0; }
/* 控件 reset 用 :where() 归零类名特异性（Chrome 110 起可用，manifest 已要求 ≥110）：
   原写法「.hdu-root button」是 (0,1,1)，会压制所有 (0,1,0) 的单类按钮样式——
   真实 Chrome headless 计算样式实测：.hdu-btn 的 border/background/color/font-size
   以及 .hdu-capsule、.hdu-timeline-mark、.hdu-topic、.hdu-folder、.hdu-filter-pill、
   .hdu-note-time（含 mono 字体）等全被 reset 覆盖丢失。
   :where(.hdu-root) 后特异性降为 (0,0,1)：无类名的裸 button 仍吃到 reset
   （如 .hdu-plan-menu-anchor > button 的触发器），任何组件类规则都能正常生效。 */
:where(.hdu-root) button, :where(.hdu-root) input, :where(.hdu-root) textarea, :where(.hdu-root) select { font: inherit; color: inherit; }
:where(.hdu-root) button { border: 0; background: transparent; cursor: pointer; }
.hdu-root button:disabled { cursor: not-allowed; opacity: .45; }
.hdu-root a { color: inherit; text-decoration: none; }
.hdu-root ul, .hdu-root ol { margin: 0; padding: 0; list-style: none; }
.hdu-root ::selection { background: var(--accent-soft); color: var(--ink); }
.hdu-root :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }
.hdu-scroll { scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; }
.hdu-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.hdu-scroll::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 99px; }
.hdu-scroll::-webkit-scrollbar-track { background: transparent; }

/* 宿主是 pointer-events:none，交互层显式接管 */
.hdu-center, .hdu-dock, .hdu-panel, .hdu-capsule, .hdu-toast-stack, .hdu-modal-backdrop { pointer-events: auto; }
.hdu-caption, .hdu-timeline { pointer-events: none; }
.hdu-timeline-mark { pointer-events: auto; }

/* ───────── 学习中心外壳 ───────── */
.hdu-center {
  position: fixed; inset: 0; z-index: 2147483000;
  display: flex; overflow: hidden;
  background-color: var(--paper);
  background:
    radial-gradient(1200px 700px at 78% -10%, color-mix(in srgb, var(--accent-soft) 55%, transparent), transparent 60%),
    radial-gradient(900px 600px at -10% 100%, color-mix(in srgb, var(--jade-soft) 40%, transparent), transparent 55%),
    var(--paper);
  animation: hdu-fade-in .22s ease-out;
  overscroll-behavior: contain;
}
.hdu-center::after {
  content: ""; position: absolute; inset: 0; pointer-events: none; opacity: .35;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.035'/%3E%3C/svg%3E");
  mix-blend-mode: multiply;
}
.hdu-root[data-theme="dark"] .hdu-center::after { mix-blend-mode: screen; opacity: .18; }

.hdu-rail {
  position: relative; z-index: 2; width: 228px; flex: 0 0 228px;
  display: flex; flex-direction: column; gap: 26px;
  padding: 24px 14px 18px;
  border-right: 1px solid var(--line);
  background-color: color-mix(in srgb, var(--paper-2) 62%, var(--paper));
  background: color-mix(in srgb, var(--paper-2) 62%, transparent);
  backdrop-filter: blur(8px);
}
.hdu-brand { display: flex; align-items: center; gap: 11px; padding: 0 8px; }
.hdu-brand-mark {
  width: 38px; height: 38px; border-radius: 11px; flex: 0 0 auto;
  display: grid; place-items: center;
  background: var(--ink); color: var(--paper-2);
  font-family: var(--font-serif); font-size: 20px; font-weight: 600;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--paper) 18%, transparent);
}
.hdu-brand-name { font-family: var(--font-serif); font-size: 16px; font-weight: 600; letter-spacing: .01em; line-height: 1.25; }
.hdu-brand-sub { font-size: 10.5px; color: var(--muted); letter-spacing: .12em; text-transform: uppercase; margin-top: 2px; }
.hdu-nav { display: flex; flex-direction: column; gap: 3px; }
.hdu-nav-label { padding: 0 12px 8px; font-size: 10.5px; letter-spacing: .16em; color: var(--muted); text-transform: uppercase; }
.hdu-nav-item {
  display: flex; align-items: center; gap: 11px; width: 100%;
  padding: 10px 12px; border-radius: 11px; color: var(--ink-soft);
  /* hover 无 transform，过渡只枚举实际变化的属性 */
  font-size: 13.5px; text-align: left; transition: background .15s ease, color .15s ease;
}
.hdu-nav-item:hover { background: color-mix(in srgb, var(--paper-3) 70%, transparent); color: var(--ink); }
.hdu-nav-item.is-active { background: var(--ink); color: var(--paper-2); box-shadow: var(--shadow-soft); }
.hdu-nav-item.is-active .hdu-nav-count { color: color-mix(in srgb, var(--paper-2) 72%, transparent); background: color-mix(in srgb, var(--paper-2) 14%, transparent); }
.hdu-nav-item svg { width: 17px; height: 17px; flex: 0 0 auto; opacity: .9; }
.hdu-nav-count { margin-left: auto; font-size: 10.5px; font-variant-numeric: tabular-nums; padding: 1px 7px; border-radius: 99px; background: var(--paper-3); color: var(--muted); }
.hdu-rail-foot { margin-top: auto; display: flex; flex-direction: column; gap: 10px; padding: 12px 8px 0; border-top: 1px solid var(--line); }
.hdu-status-line { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--muted); }
.hdu-dot { width: 7px; height: 7px; border-radius: 99px; background: var(--line-strong); flex: 0 0 auto; }
.hdu-dot.ok { background: var(--jade); box-shadow: 0 0 0 3px color-mix(in srgb, var(--jade) 18%, transparent); }
.hdu-dot.warn { background: var(--accent-2); }
.hdu-dot.err { background: var(--danger); }
.hdu-rail-actions { display: flex; gap: 6px; }

.hdu-main { position: relative; z-index: 1; flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.hdu-topbar {
  /* 显式建立 stacking context 并成为定位基准：不依赖 backdrop-filter 的隐式实现差异，
     同时让窄窗口下搜索下拉可以锚定整个顶栏（见 ≤960 媒体查询） */
  position: relative; z-index: 2;
  display: flex; align-items: center; gap: 18px; min-height: 66px;
  padding: 12px 34px; border-bottom: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
  background: color-mix(in srgb, var(--paper) 72%, transparent); backdrop-filter: blur(10px);
}
.hdu-topbar-title { font-family: var(--font-serif); font-size: 18px; font-weight: 600; letter-spacing: .01em; }
.hdu-topbar-sub { font-size: 11.5px; color: var(--muted); margin-top: 1px; }
.hdu-topbar-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.hdu-content { flex: 1; overflow: auto; overscroll-behavior: contain; }
.hdu-content-inner { max-width: 1180px; margin: 0 auto; padding: 28px 34px 84px; }

/* ───────── 通用控件 ───────── */
.hdu-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  height: 34px; padding: 0 13px; border-radius: 10px;
  border: 1px solid var(--line); background: var(--paper-2); color: var(--ink-soft);
  font-size: 12.5px; font-weight: 500; white-space: nowrap;
  transition: border-color .15s ease, background .15s ease, color .15s ease, transform .15s ease, box-shadow .15s ease;
}
.hdu-btn svg { width: 15px; height: 15px; }
.hdu-btn:hover:not(:disabled) { border-color: var(--line-strong); color: var(--ink); transform: translateY(-1px); box-shadow: var(--shadow-soft); }
.hdu-btn:active:not(:disabled) { transform: translateY(0); }
.hdu-btn.primary { background: var(--ink); border-color: var(--ink); color: var(--paper-2); }
.hdu-btn.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--ink) 88%, var(--accent)); }
/* danger 变体（第 247 轮巡检，数据安全域）：purge 类「不可恢复」确认按钮的 danger 语义底色，
   覆盖 trash 批量横幅「确认删除 / 确认清空」、行级「确认删除」与 dashboard 回收站
   ConfirmButton 的静态态；源序刻意放在 .is-confirm 之前——两步确认态（红字淡红底）
   以同特异性后序覆盖 danger 底色，确认步骤的视觉权重仍更高 */
.hdu-btn.danger { background: var(--danger); border-color: var(--danger); color: #fff; }
.hdu-btn.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 86%, #000); }
.hdu-btn.danger:active:not(:disabled) { background: color-mix(in srgb, var(--danger) 78%, #000); }
/* 暗色主题下 danger 底白字对比不足：换深字（与 accent 变体同思路） */
.hdu-root[data-theme="dark"] .hdu-btn.danger { color: #2a0505; }
.hdu-btn.accent { background: var(--accent); border-color: var(--accent); color: #fff9f1; }
/* 暗色主题的 --accent 是浅橙，白字对比只有 ~2.3:1；换深字（与 hero 区覆盖 #221408 同思路） */
.hdu-root[data-theme="dark"] .hdu-btn.accent { color: #241304; }
.hdu-btn.ghost { background: transparent; border-color: transparent; color: var(--muted); }
.hdu-btn.ghost:hover:not(:disabled) { background: var(--paper-3); color: var(--ink); box-shadow: none; }
.hdu-btn.small { height: 28px; padding: 0 10px; border-radius: 8px; font-size: 11.5px; }
.hdu-btn.icon { width: 34px; padding: 0; }
.hdu-btn.icon.small { width: 28px; }
.hdu-icon-btn { display: inline-grid; place-items: center; width: 30px; height: 30px; border-radius: 9px; color: var(--muted); transition: background .15s, color .15s; }
.hdu-icon-btn:hover { background: var(--paper-3); color: var(--ink); }
.hdu-icon-btn svg { width: 16px; height: 16px; }

.hdu-chip {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
  padding: 3px 9px; border-radius: 99px; border: 1px solid var(--line);
  background: color-mix(in srgb, var(--paper-2) 70%, transparent);
  font-size: 11px; color: var(--ink-soft); white-space: nowrap;
}
.hdu-chip.accent { background: var(--accent-soft); border-color: transparent; color: var(--accent); }
/* 亮色侧 accent 徽标字对 accent-soft 底 4.24:1（AA 差口气，第 253 轮对比度抽查）：
   文字 color-mix 收深一档（≥4.5:1）；暗色侧 accent/accent-soft 本就 6.1:1，不受影响 */
.hdu-root:not([data-theme="dark"]) .hdu-chip.accent { color: color-mix(in srgb, var(--accent) 84%, #000); }
.hdu-chip.jade { background: var(--jade-soft); border-color: transparent; color: var(--jade); }
.hdu-chip.danger { background: var(--danger-soft); border-color: transparent; color: var(--danger); }
.hdu-chip.info { background: var(--info-soft); border-color: transparent; color: var(--info); }
.hdu-chip svg { width: 12px; height: 12px; }

.hdu-card {
  position: relative; border: 1px solid var(--line); border-radius: var(--radius);
  background-color: var(--paper-2);
  background: color-mix(in srgb, var(--paper-2) 82%, transparent);
  box-shadow: var(--shadow-soft);
}
.hdu-card.pad { padding: 20px; }
.hdu-card.hover { transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease; }
.hdu-card.hover:hover { transform: translateY(-2px); border-color: var(--line-strong); box-shadow: var(--shadow); }

.hdu-section { margin-top: 30px; }
.hdu-section:first-child { margin-top: 0; }
.hdu-section-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 13px; }
.hdu-section-title { font-family: var(--font-serif); font-size: 16.5px; font-weight: 600; letter-spacing: .01em; }
.hdu-section-sub { font-size: 11.5px; color: var(--muted); }
.hdu-section-actions { margin-left: auto; display: flex; gap: 6px; }

.hdu-grid { display: grid; gap: 14px; }
.hdu-grid.g2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.hdu-grid.g3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.hdu-grid.g4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }

.hdu-progress { height: 5px; border-radius: 99px; background: var(--paper-3); overflow: hidden; }
.hdu-progress > i { display: block; height: 100%; border-radius: inherit; background: var(--accent); transition: width .4s ease; }
.hdu-progress.jade > i { background: var(--jade); }

.hdu-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 38px 20px; text-align: center; color: var(--muted); }
.hdu-empty-mark { width: 44px; height: 44px; border-radius: 14px; display: grid; place-items: center; background: var(--paper-3); color: var(--muted); }
.hdu-empty-mark svg { width: 21px; height: 21px; }
.hdu-empty-title { font-family: var(--font-serif); font-size: 14.5px; color: var(--ink-soft); }
.hdu-empty-text { font-size: 12px; max-width: 340px; line-height: 1.6; }
/* 空态 CTA（第 249 轮空态模板化伴随样式）：统一 icon/标题/描述/CTA 的垂直节奏
   （text 与 CTA 在 10px gap 基础上 +2px 步进）；CTA 统一 small ghost（调用点按
   EmptyState 模板契约收口，此处兜底居中排布与换行） */
.hdu-empty-action { display: flex; justify-content: center; flex-wrap: wrap; gap: 8px; margin-top: 2px; }
.hdu-empty-action .hdu-btn { flex: none; }

.hdu-skeleton { border-radius: 10px; background: linear-gradient(90deg, var(--paper-3), color-mix(in srgb, var(--paper-3) 45%, var(--paper-2)), var(--paper-3)); background-size: 200% 100%; animation: hdu-shimmer 1.4s infinite linear; }
.hdu-spinner { width: 15px; height: 15px; border-radius: 99px; border: 2px solid color-mix(in srgb, currentColor 25%, transparent); border-top-color: currentColor; animation: hdu-spin .8s linear infinite; flex: 0 0 auto; }
.hdu-divider { height: 1px; background: var(--line); margin: 16px 0; }

/* ───────── 总览 ───────── */
.hdu-hero { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); gap: 16px; }
.hdu-hero-main {
  position: relative; overflow: hidden; padding: 26px 28px; border-radius: 22px;
  background: var(--ink); color: var(--paper-2); box-shadow: var(--shadow);
  display: flex; flex-direction: column; gap: 20px; min-height: 216px;
}
.hdu-hero-main::before {
  content: ""; position: absolute; right: -70px; top: -110px; width: 320px; height: 320px; border-radius: 50%;
  border: 1px solid color-mix(in srgb, var(--paper-2) 16%, transparent);
  box-shadow: 0 0 0 38px color-mix(in srgb, var(--paper-2) 4%, transparent), 0 0 0 76px color-mix(in srgb, var(--paper-2) 3%, transparent);
}
.hdu-hero-eyebrow { font-size: 10.5px; letter-spacing: .18em; text-transform: uppercase; color: color-mix(in srgb, var(--paper-2) 58%, transparent); }
.hdu-hero-title { font-family: var(--font-serif); font-size: clamp(22px, 2.2vw, 30px); font-weight: 600; line-height: 1.3; letter-spacing: .01em; max-width: 420px; }
.hdu-hero-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; color: color-mix(in srgb, var(--paper-2) 68%, transparent); }
.hdu-hero-actions { display: flex; align-items: center; gap: 8px; margin-top: auto; flex-wrap: wrap; }
.hdu-hero-main .hdu-btn { background: color-mix(in srgb, var(--paper-2) 8%, transparent); border-color: color-mix(in srgb, var(--paper-2) 18%, transparent); color: var(--paper-2); }
.hdu-hero-main .hdu-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--paper-2) 16%, transparent); box-shadow: none; }
.hdu-hero-main .hdu-btn.accent { background: var(--accent-2); border-color: var(--accent-2); color: #221408; }
.hdu-ring { position: relative; width: 76px; height: 76px; flex: 0 0 auto; display: grid; place-items: center; }
.hdu-hero-main > .hdu-ring { position: absolute; right: 26px; bottom: 24px; }
.hdu-ring svg { position: absolute; inset: 0; transform: rotate(-90deg); }
.hdu-ring-track { fill: none; stroke: color-mix(in srgb, var(--paper-2) 16%, transparent); stroke-width: 5; }
/* card 变体（浅底卡片内）：hero 深底用的 paper-2 16% 在明暗两主题的纸底上都几乎不可见，
   改按 ink 10% 混合，亮色呈淡灰、暗色呈淡亮，与底色都有可见层次 */
.hdu-ring.card .hdu-ring-track { stroke: color-mix(in srgb, var(--ink) 10%, transparent); }
.hdu-ring-fill { fill: none; stroke: var(--accent-2); stroke-width: 5; stroke-linecap: round; transition: stroke-dashoffset .5s ease; }
.hdu-ring-label { font-family: var(--font-serif); font-size: 16px; font-variant-numeric: tabular-nums; }
.hdu-hero-side { display: flex; flex-direction: column; gap: 12px; }
/* 数字卡统一刻度：padding 与 .hdu-metric / .hdu-stat 对齐到 18px 20px（见下方统一刻度注释） */
.hdu-mini-card { padding: 18px 20px; border-radius: 18px; border: 1px solid var(--line); background: color-mix(in srgb, var(--paper-2) 78%, transparent); display: flex; flex-direction: column; gap: 6px; }
.hdu-mini-label { font-size: 11px; color: var(--muted); letter-spacing: .04em; }
.hdu-mini-value { font-family: var(--font-serif); font-size: 25px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.1; }
.hdu-mini-value small { font-family: var(--font-sans); font-size: 11px; color: var(--muted); font-weight: 400; margin-left: 5px; }
.hdu-mini-foot { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--muted); }

.hdu-stat-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
/* 三套数字卡统一刻度：padding 一律 18px 20px（与 .hdu-metric 相同；popup 侧另有 12px 13px 压缩覆盖），
   字号保留层级差异——metric 34px 是 hero 级、stat 26px / mini 25px 是次级，这是设计意图，不合并 */
.hdu-stat { padding: 18px 20px; border-radius: 16px; border: 1px solid var(--line); background: color-mix(in srgb, var(--paper-2) 72%, transparent); }
.hdu-stat-top { display: flex; align-items: center; gap: 7px; color: var(--muted); font-size: 11.5px; }
.hdu-stat-top svg { width: 14px; height: 14px; }
.hdu-stat-value { margin-top: 9px; font-family: var(--font-serif); font-size: 26px; font-weight: 600; line-height: 1.1; font-variant-numeric: tabular-nums; }
.hdu-stat-value small { font-family: var(--font-sans); font-size: 11px; color: var(--muted); font-weight: 400; margin-left: 4px; }
.hdu-stat-foot { margin-top: 5px; font-size: 11px; color: var(--muted); }

/* 第 17 轮实测修复（P1-1）：此前 align-items:flex-end 使列收缩到内容高，
   track 的 flex:1 在列内无自由空间可分 → 整图塌缩为 fill 的 min-height 2px，
   趋势信息完全丢失；stretch 让列撑满容器高，track 才能占位、fill 的百分比高度才有分母 */
.hdu-bars { display: flex; align-items: stretch; gap: 8px; height: 132px; padding-top: 8px; }
.hdu-bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 7px; min-width: 0; }
.hdu-bar-track { width: 100%; max-width: 34px; flex: 1; display: flex; align-items: flex-end; border-radius: 6px; background: color-mix(in srgb, var(--paper-3) 55%, transparent); overflow: hidden; }
.hdu-bar-fill { width: 100%; border-radius: 6px 6px 3px 3px; background: var(--accent); opacity: .82; transition: height .4s ease; min-height: 2px; }
.hdu-bar-col.today .hdu-bar-fill { background: var(--jade); opacity: 1; }
.hdu-bar-label { font-size: 9.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
.hdu-chart-legend { display: flex; align-items: center; gap: 14px; font-size: 11px; color: var(--muted); }

.hdu-list { display: flex; flex-direction: column; }
.hdu-list-row { display: flex; align-items: center; gap: 12px; padding: 12px 4px; border-bottom: 1px solid color-mix(in srgb, var(--line) 62%, transparent); }
.hdu-list-row:last-child { border-bottom: 0; }
.hdu-list-main { min-width: 0; flex: 1; }
.hdu-list-title { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hdu-list-sub { margin-top: 2px; font-size: 11px; color: var(--muted); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.hdu-list-side { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.hdu-time-badge { font-family: var(--font-mono); font-size: 10.5px; color: var(--muted); padding: 2px 6px; border-radius: 6px; background: var(--paper-3); }

/* ───────── 课程 ───────── */
.hdu-course-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
.hdu-course-card { overflow: hidden; display: flex; flex-direction: column; }
.hdu-course-cover {
  position: relative; height: 92px; padding: 17px 19px;
  display: flex; align-items: flex-start; justify-content: space-between;
  background: var(--ink); color: var(--paper-2); overflow: hidden;
}
.hdu-course-cover::before { content: ""; position: absolute; right: -30px; bottom: -70px; width: 180px; height: 180px; border-radius: 50%; border: 1px solid color-mix(in srgb, var(--paper-2) 16%, transparent); box-shadow: 0 0 0 26px color-mix(in srgb, var(--paper-2) 4%, transparent); }
.hdu-course-cover.c1 { background: #26323a; }
.hdu-course-cover.c2 { background: #3d3428; }
.hdu-course-cover.c3 { background: #2b3a32; }
.hdu-course-cover.c4 { background: #3a2c33; }
.hdu-course-kicker { font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: color-mix(in srgb, var(--paper-2) 55%, transparent); }
.hdu-course-name { margin-top: 5px; font-family: var(--font-serif); font-size: 18px; font-weight: 600; line-height: 1.3; max-width: 270px; }
.hdu-course-teacher { margin-top: 3px; font-size: 11px; color: color-mix(in srgb, var(--paper-2) 62%, transparent); }
.hdu-course-badge { position: relative; z-index: 1; }
.hdu-course-badge .hdu-chip { background: color-mix(in srgb, var(--paper-2) 13%, transparent); border-color: color-mix(in srgb, var(--paper-2) 18%, transparent); color: color-mix(in srgb, var(--paper-2) 82%, transparent); }
.hdu-course-body { padding: 15px 17px 16px; display: flex; flex-direction: column; gap: 11px; flex: 1; }
.hdu-course-stats { display: flex; gap: 14px; font-size: 11.5px; color: var(--muted); flex-wrap: wrap; }
.hdu-course-stats b { color: var(--ink-soft); font-weight: 600; font-variant-numeric: tabular-nums; }
/* 课程卡「下一节」直达行（第 255 轮课程域候选 B）：jade 软底轻提示行，与 .hdu-golden-hint
   家族同克制度（7%/14% 两档 color-mix，暗色由 --jade / --ink-soft 变量自动跟随）；
   行为语言与 .hdu-session-row 一致（软底 hover + 右侧 chevron + 标签 ellipsis），不新增色板 */
.hdu-course-next { display: flex; align-items: center; gap: 7px; padding: 7px 10px; border-radius: 9px; background: color-mix(in srgb, var(--jade) 7%, transparent); color: var(--ink-soft); font-size: 12px; transition: background .13s; text-align: left; width: 100%; }
.hdu-course-next:hover { background: color-mix(in srgb, var(--jade) 14%, transparent); }
.hdu-course-next > svg { flex: 0 0 auto; color: var(--jade); }
.hdu-course-next-label { flex: 1; min-width: 0; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hdu-course-foot { margin-top: auto; display: flex; align-items: center; gap: 8px; }
.hdu-session-list { border-top: 1px solid var(--line); padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 2px; max-height: 280px; overflow: auto; }
.hdu-session-row { display: flex; align-items: center; gap: 9px; padding: 8px 9px; border-radius: 9px; transition: background .13s; text-align: left; width: 100%; }
.hdu-session-row:hover { background: var(--paper-3); }
.hdu-session-dot { width: 6px; height: 6px; border-radius: 99px; background: var(--line-strong); flex: 0 0 auto; }
.hdu-session-dot.done { background: var(--jade); }
.hdu-session-dot.partial { background: var(--accent-2); }
.hdu-session-label { flex: 1; min-width: 0; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hdu-session-badges { display: flex; gap: 4px; flex: 0 0 auto; }
.hdu-session-badge { font-size: 9.5px; padding: 1px 5px; border-radius: 4px; background: var(--paper-3); color: var(--muted); }

/* ───────── 课表 / 补看 ───────── */
.hdu-missed-list { display: flex; flex-direction: column; gap: 9px; }
.hdu-missed { display: flex; align-items: center; gap: 12px; padding: 13px 15px; border: 1px solid var(--line); border-radius: 14px; background: color-mix(in srgb, var(--paper-2) 65%, transparent); }
.hdu-missed:hover { border-color: var(--line-strong); }
.hdu-missed-date { width: 46px; flex: 0 0 auto; text-align: center; padding-right: 12px; border-right: 1px solid var(--line); }
.hdu-missed-day { font-family: var(--font-serif); font-size: 19px; line-height: 1.1; font-variant-numeric: tabular-nums; }
.hdu-missed-month { font-size: 9.5px; color: var(--muted); letter-spacing: .08em; }
.hdu-week { display: grid; grid-template-columns: 58px repeat(7, minmax(0, 1fr)); gap: 6px; }
.hdu-week-head { font-size: 10.5px; color: var(--muted); text-align: center; padding: 5px 0; }
.hdu-week-cell { min-height: 76px; border-radius: 10px; border: 1px dashed color-mix(in srgb, var(--line) 80%, transparent); padding: 6px; display: flex; flex-direction: column; gap: 4px; }
.hdu-week-cell.has { border-style: solid; background: color-mix(in srgb, var(--paper-2) 70%, transparent); }
.hdu-week-course { font-size: 10.5px; font-weight: 500; line-height: 1.35; padding: 4px 5px; border-radius: 6px; background: var(--accent-soft); color: var(--accent); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.hdu-week-course.jade { background: var(--jade-soft); color: var(--jade); }

/* ───────── 今日待办 ───────── */
.hdu-today-body { display: flex; flex-direction: column; gap: 16px; margin-top: 4px; }
.hdu-todo-head { display: flex; align-items: center; gap: 8px; font-size: 11.5px; font-weight: 600; color: var(--ink-soft); margin-bottom: 2px; }
.hdu-todo-count { font-size: 10px; font-weight: 400; color: var(--muted); background: var(--paper-3); border-radius: 999px; padding: 1px 8px; }
.hdu-todo-rows { display: flex; flex-direction: column; }
.hdu-todo-row { display: flex; align-items: center; gap: 11px; padding: 10px 2px; border-bottom: 1px solid color-mix(in srgb, var(--line) 62%, transparent); }
.hdu-todo-row:last-child { border-bottom: 0; }
.hdu-todo-check { width: 15px; height: 15px; flex: 0 0 auto; accent-color: var(--jade); cursor: pointer; }
.hdu-todo-row.is-done .hdu-list-title { color: var(--muted); text-decoration: line-through; }
.hdu-todo-row.is-done .hdu-list-sub { opacity: .65; }
.hdu-today .hdu-empty { padding: 26px 0 16px; }
/* 今日待办庆祝条（第 233 轮巡检）：全部完成后的正向反馈，jade 软渐变底 + 入场动画；
   颜色走变量，暗色主题随 .hdu-root[data-theme="dark"] 覆盖自动生效 */
.hdu-celebrate { display: flex; align-items: flex-start; gap: 10px; margin-top: 8px; padding: 10px 14px; border: 1px solid color-mix(in srgb, var(--jade) 45%, transparent); border-radius: var(--radius); background: linear-gradient(135deg, var(--jade-soft), transparent); animation: hdu-celebrate-in .25s ease-out; }
.hdu-celebrate-emoji { font-size: 22px; line-height: 1.2; }
.hdu-celebrate-title { font-size: 13px; font-weight: 700; color: var(--jade); }
.hdu-celebrate-hint { font-size: 12px; color: var(--ink-soft); line-height: 1.6; margin-top: 1px; }
@keyframes hdu-celebrate-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }

/* 每周计划摘要菜单（今日待办 video 分区头的 Chip 入口）：
   触发按钮包住 Chip（Chip 是 span，不受 .hdu-root button 重置影响，外观稳定），
   浮层绝对定位锚在按钮下方，模式照顶栏搜索下拉的简化版。 */
.hdu-plan-menu-anchor { position: relative; display: inline-flex; }
.hdu-plan-menu-anchor > button { display: inline-flex; padding: 0; }
.hdu-plan-menu {
  position: absolute; top: calc(100% + 6px); left: 0; width: 252px; z-index: 70;
  display: flex; flex-direction: column; gap: 8px; padding: 12px 13px;
  border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--paper-2);
  box-shadow: var(--shadow); animation: hdu-rise .15s ease-out; text-align: left;
}
.hdu-plan-menu-title { font-family: var(--font-serif); font-size: 13px; font-weight: 600; color: var(--ink); }
.hdu-plan-menu-rows { display: flex; flex-direction: column; gap: 3px; font-size: 11.5px; color: var(--muted); }
.hdu-plan-menu-foot { font-size: 10.5px; color: var(--muted); line-height: 1.6; }
.hdu-plan-menu-actions { display: flex; justify-content: flex-end; }
/* 两步确认态（取消计划按钮 / 收藏编辑弹层的删除按钮共用）：红色文案 + 淡红底，
   提示下一次点击将真正执行。放在 ghost/primary 变体之后，同特异性下按源序覆盖 hover 态 */
.hdu-root .hdu-btn.is-confirm {
  color: var(--danger); background: var(--danger-soft);
  border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
}
/* 图标按钮的两步确认态（dashboard/options 危险操作两步化后的行内删除按钮共用，
   ConfirmIconButton 在确认态下传 is-confirm）：配色口径与 .hdu-btn.is-confirm 相同 */
.hdu-root .hdu-icon-btn.is-confirm {
  color: var(--danger); background: var(--danger-soft);
  border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
}

/* ───────── 知识库 ───────── */
.hdu-filterbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
.hdu-input, .hdu-textarea, .hdu-select {
  border: 1px solid var(--line); border-radius: 10px; background: var(--paper-2);
  padding: 8px 11px; font-size: 12.5px; color: var(--ink); outline: none; transition: border-color .15s, box-shadow .15s;
}
.hdu-input:focus, .hdu-textarea:focus, .hdu-select:focus { border-color: var(--accent-2); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-2) 16%, transparent); }
/* 越界纠正的短暂视觉反馈（如每天个数输入 25 被收正为 20）：0.5s 后由组件移除该类；
   无动画实现，仅换边框色——prefers-reduced-motion 下由全局降时长规则兜底，不受影响 */
.hdu-input.flash-clamp { border-color: var(--danger); box-shadow: 0 0 0 3px color-mix(in srgb, var(--danger) 14%, transparent); }
.hdu-input::placeholder, .hdu-textarea::placeholder { color: var(--muted); }
.hdu-search { display: flex; align-items: center; gap: 7px; min-width: 220px; flex: 1; max-width: 360px; border: 1px solid var(--line); border-radius: 11px; background: var(--paper-2); padding: 0 10px; height: 34px; }
/* 聚焦态（第 262 轮，样式域 / 反馈质感）：容器 focus-within 响应输入聚焦——accent 边框
   + 12% 光环，与按钮/输入族焦点语言一致（学习中心顶栏与知识库搜索框共用本类） */
.hdu-search:focus-within { border-color: color-mix(in srgb, var(--accent) 55%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent); }
/* 清除输入按钮（第 265 轮，检索域 / 输入体验）：有输入时的 × 圆钮（muted → hover danger），
   与 Spinner 同槽位（loading 时 × 与 spinner 并排，× 在前） */
.hdu-search-clear {
  flex: 0 0 auto; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 50%;
  background: transparent; color: var(--muted); font-size: 14px; line-height: 1;
  cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
  transition: background-color .12s ease, color .12s ease;
}
.hdu-search-clear:hover { background: var(--paper-3); color: var(--danger); }
.hdu-search svg { width: 15px; height: 15px; color: var(--muted); flex: 0 0 auto; }
.hdu-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; font-size: 12.5px; }

/* 最近搜索回放（第 303 轮，检索域 / 效率）：知识库搜索词为空时平铺最近关键词 chips，
   与统一搜索 / B 站字幕同源（settings.ui.recentQueries）；整行占满筛选栏（flex-basis 100%），
   看板知识库（dashboard）同用本类 */
.hdu-lib-recent { flex-basis: 100%; display: flex; align-items: center; flex-wrap: wrap; gap: 5px; font-size: 11px; color: var(--muted); }
.hdu-lib-recent-label { flex: 0 0 auto; }
.hdu-lib-recent-chip { display: inline-flex; align-items: center; gap: 2px; border: 1px solid var(--line); border-radius: 999px; background: var(--paper-2); padding: 2px 4px 2px 9px; }
.hdu-lib-recent-chip > button:first-child { border: 0; background: transparent; padding: 2px 2px; font: inherit; color: var(--ink-soft); cursor: pointer; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hdu-lib-recent-chip > button:first-child:hover { color: var(--accent); }
.hdu-lib-recent-del { border: 0; background: transparent; color: var(--muted); font-size: 12px; line-height: 1; padding: 2px 5px; cursor: pointer; border-radius: 50%; }
.hdu-lib-recent-del:hover { color: var(--danger); background: var(--paper-3); }
.hdu-lib-recent-clear { flex: 0 0 auto; border: 0; background: transparent; color: var(--muted); font-size: 11px; cursor: pointer; padding: 2px 6px; border-radius: 999px; }
.hdu-lib-recent-clear:hover { color: var(--danger); background: var(--paper-3); }

/* ───────── 顶栏统一搜索（复用知识库搜索框样式，下拉为四组分区；第 245 轮 +复习组） ───────── */
.hdu-topbar-search { position: relative; display: flex; }
.hdu-topbar-search .hdu-search { min-width: 190px; max-width: 250px; height: 30px; }
.hdu-search-pop {
  position: absolute; top: calc(100% + 6px); right: 0; width: 400px; max-height: 420px;
  overflow: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px;
  border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper-2);
  box-shadow: var(--shadow); z-index: 60;
  animation: hdu-rise .15s ease-out;
}
.hdu-search-hint { padding: 16px 10px; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 12px; color: var(--muted); text-align: center; }
.hdu-search-group { display: flex; flex-direction: column; gap: 2px; }
/* 分组间分隔线（第 245 轮样式打磨）：多组同屏时以 1px 细线分区，首组不带线 */
.hdu-search-group + .hdu-search-group { border-top: 1px solid var(--line); margin-top: 4px; padding-top: 6px; }
.hdu-search-group-head { display: flex; align-items: center; gap: 6px; padding: 4px 8px 2px; font-size: 10.5px; letter-spacing: .08em; color: var(--muted); text-transform: uppercase; }
.hdu-search-group-count { font-variant-numeric: tabular-nums; padding: 0 6px; border-radius: 99px; background: var(--paper-3); letter-spacing: 0; }
/* 收藏触顶降级提示（favoritesTruncated，第 18 轮审计留观项）：中性说明文字，仅用既有 muted 令牌 */
.hdu-search-group-hint { padding: 2px 8px 1px; font-size: 10.5px; color: var(--muted); }
/* 组内展开全部（第 260 轮，检索域 / 完整性）：total > 展示上限的组尾居中小按钮——
   ghost 质感（透明底 + muted 字，hover 转 accent），与 keys-hint 同层级 */
.hdu-search-group-more {
  align-self: center; margin: 2px 0 1px; padding: 3px 12px; border: 0; border-radius: 99px;
  background: transparent; color: var(--muted); font-size: 10.5px; font-family: inherit;
  font-variant-numeric: tabular-nums; letter-spacing: .02em; cursor: pointer;
  transition: background-color .12s ease, color .12s ease;
}
.hdu-search-group-more:hover { background: var(--paper-3); color: var(--accent); }
.hdu-search-item {
  display: flex; align-items: flex-start; gap: 8px; width: 100%;
  padding: 7px 8px; border-radius: 9px; border: 0; background: transparent;
  color: var(--ink-soft); text-align: left; text-decoration: none; font-size: inherit;
  transition: background .12s ease, color .12s ease;
}
.hdu-search-item:hover { background: var(--paper-3); color: var(--ink); }
/* 方向键高亮（aria-activedescendant，输入框保持焦点）：底色与 hover 一致，
   另加左侧 2px accent 内嵌条区分「键盘选中」与「鼠标悬停」（第 245 轮样式打磨） */
.hdu-search-item.is-active { background: var(--paper-3); color: var(--ink); box-shadow: inset 2px 0 0 var(--accent); }
/* 按压反馈：在 hover 底色上向黑混一档，明暗两套主题的加深方向一致 */
.hdu-search-item:active { background: color-mix(in srgb, var(--paper-3) 86%, #000); }
.hdu-search-item.is-static { cursor: default; }
.hdu-search-item > svg { flex: 0 0 auto; margin-top: 3px; color: var(--muted); }
.hdu-search-badge { flex: 0 0 auto; margin-top: 1px; font-size: 10px; padding: 1px 7px; border-radius: 99px; white-space: nowrap; }
.hdu-search-badge.transcript { background: var(--info-soft); color: var(--info); }
.hdu-search-badge.favorite { background: var(--accent-soft); color: var(--accent); }
.hdu-search-badge.note { background: var(--jade-soft); color: var(--jade); }
/* 复习组徽标（第 245 轮）：jade 描边空心变体——实底 jade 已被笔记组占用，
   空心描边既保持「正向行动」语义色家族，又与三枚实底徽标一眼区分 */
.hdu-search-badge.review { background: transparent; border: 1px solid color-mix(in srgb, var(--jade) 45%, transparent); color: var(--jade); padding: 0 6px; }
/* 置顶徽标（第 287 轮，检索域）：gold 描边空心（与复习组同构、色系区分）——
   pinnedFirst 排序的置顶收藏在结果中标识 */
.hdu-search-badge.pinned { background: transparent; border: 1px solid color-mix(in srgb, var(--gold) 50%, transparent); color: var(--gold); padding: 0 6px; }
.hdu-search-item-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.hdu-search-item-title { font-size: 12.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hdu-search-item-snippet { font-size: 11px; color: var(--muted); line-height: 1.55; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
/* 命中词视觉高亮（第 256 轮，检索域）：snippet 的【】文本标注升级为 <mark>。
   gold 软底 + 同族深字色（与收藏徽标 accent-soft 家族同克制度），暗色由 --* 变量
   自动跟随；圆角 3px + 无 padding 保持行内小字的呼吸感，background 非继承属性
   不会污染 -webkit-line-clamp 的多行截断 */
.hdu-search-mark {
  background: color-mix(in srgb, var(--gold) 16%, transparent);
  color: color-mix(in srgb, var(--gold) 78%, var(--ink));
  border-radius: 3px; padding: 0 1px; font-weight: 600;
}
/* transcript 多段命中展开区（第 257 轮，检索域 / 定位能力）：option 条目之后的
   「命中 N 段」开关 + 时间点行列表。toggle 沿用 jade 语境色（与第 256 轮 meta 行
   同语义升级为可交互）；行 = mono 时钟 + 截断文本，hover 软底 + 左缩进表达层级；
   均在 option 元素之外，不参与 combobox 扁平导航序号 */
.hdu-search-hits-block { margin: -2px 0 2px 26px; display: flex; flex-direction: column; gap: 2px; }
.hdu-search-hits-toggle {
  align-self: flex-start; display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 8px; border: 0; border-radius: 99px; background: transparent;
  font-size: 10px; color: var(--jade); font-variant-numeric: tabular-nums; letter-spacing: .02em;
  cursor: pointer; transition: background-color .12s ease;
}
.hdu-search-hits-toggle:hover { background: var(--jade-soft); }
.hdu-search-hits-caret { font-size: 9px; line-height: 1; }
.hdu-search-hits { display: flex; flex-direction: column; gap: 1px; padding: 4px 0 2px; }
.hdu-search-hit-row {
  display: flex; align-items: baseline; gap: 8px; width: 100%;
  padding: 4px 8px; border: 0; border-radius: 7px; background: transparent;
  color: var(--muted); text-align: left; font-size: 11px; line-height: 1.5;
  cursor: pointer; transition: background-color .12s ease, color .12s ease;
}
.hdu-search-hit-row:hover { background: var(--paper-3); color: var(--ink); }
.hdu-search-hit-time { flex: 0 0 auto; font-family: var(--font-mono); font-size: 10.5px; color: var(--ink-soft); font-variant-numeric: tabular-nums; }
.hdu-search-hit-text { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hdu-search-foot { padding: 6px 8px 2px; border-top: 1px solid var(--line); font-size: 10.5px; color: var(--muted); }
/* 键位帮助 hint 行（第 247 轮巡检，键盘域）：结果面板底部一行 muted 小字
   「↑↓ 选择 · Enter 打开 · Esc 关闭」。与统计脚注（.hdu-search-foot）以 1px 细线
   分隔、层级更低（更小字号 + muted）；窄口 400px 内单行 ellipsis 截断，
   title 给全文兜底（组件已挂）。方向键符号随文本流，不做 ltr 强制 */
.hdu-search-keys-hint {
  padding: 5px 8px 1px; margin-top: -2px; border-top: 1px dashed color-mix(in srgb, var(--line) 75%, transparent);
  font-size: 10px; color: color-mix(in srgb, var(--muted) 82%, transparent);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: center; letter-spacing: .04em;
}
/* 搜索中骨架（第 261 轮，检索域 / 反馈质感）：结果面板加载态的三行阶梯骨架容器
   （行本体为共享 SkeletonRows），替代单行「搜索中…」文字 */
.hdu-search-loading { padding: 10px 8px 6px; display: flex; flex-direction: column; }

/* 空结果引导（第 259 轮，检索域 / 空态体验）：建议句 + 最近搜索 chips 回放（前 3 个，
   点击填词走既有防抖搜索链路）；chips 借用 .hdu-recent-q 加胶囊底，hover 转 accent */
.hdu-search-empty { display: flex; flex-direction: column; gap: 2px; padding: 10px 8px 6px; }
.hdu-search-empty-tips { font-size: 10.5px; color: color-mix(in srgb, var(--muted) 82%, transparent); text-align: center; }
.hdu-search-empty-recent { display: flex; justify-content: center; flex-wrap: wrap; gap: 4px; padding-top: 4px; }
.hdu-search-empty-recent .hdu-recent-q { border: 1px solid var(--line); border-radius: 99px; padding: 2px 10px; background: var(--paper-3); }
.hdu-search-empty-recent .hdu-recent-q:hover { border-color: var(--accent); color: var(--accent); }

/* 设置页每日目标 7 日格预览（第 259 轮，目标域收官）：与上方合理性提示行的间距；
   组件本体（.hdu-goal-week 族）与总览 / 看板 / 统计页同源，无新增视觉面 */
.hdu-goal-preview { margin-top: 6px; display: flex; flex-direction: column; gap: 6px; }
/* 预览标识（第 267 轮，目标域）：两块预览（周目标完成度行 / 7 日格）的统一 eyebrow
   小标——与「口径」徽标同语言（小字 + 宽字距），标明该行是即时重算的预览而非既成统计 */
.hdu-preview-tag { font-size: 10px; color: var(--muted); letter-spacing: .18em; }

/* 最近搜索 chips 行（第 246 轮巡检）：锚在输入框正下方（与结果面板同锚点，互斥出现——
   hasQuery 门控），小号胶囊 chips + 单条删除 × + muted「清空」；多条 flex-wrap 换行 */
.hdu-recent-row {
  position: absolute; top: calc(100% + 6px); right: 0; max-width: 340px; z-index: 60;
  display: flex; align-items: center; flex-wrap: wrap; gap: 5px;
  padding: 7px 9px; border: 1px solid var(--line); border-radius: var(--radius);
  background: var(--paper-2); box-shadow: var(--shadow);
  animation: hdu-rise .15s ease-out;
}
.hdu-recent-label { flex: none; font-size: 10.5px; letter-spacing: .05em; color: var(--muted); }
.hdu-recent-chip { display: inline-flex; align-items: center; border-radius: 999px; background: var(--paper-3); overflow: hidden; transition: background-color .13s ease; }
.hdu-recent-chip:hover { background: color-mix(in srgb, var(--accent) 12%, var(--paper-3)); }
.hdu-recent-chip:active { background: color-mix(in srgb, var(--accent) 22%, var(--paper-3)); }
/* chip 主体：超长词 ellipsis 截断（title 给全文）；padding 留出与删除 × 的呼吸位 */
.hdu-recent-q {
  border: 0; background: transparent; cursor: pointer; font-family: inherit;
  padding: 3px 3px 3px 9px; font-size: 11.5px; color: var(--ink-soft);
  max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.hdu-recent-chip:hover .hdu-recent-q { color: var(--ink); }
/* 删除 ×：hit area ≥20px（强制样式项），hover 转 danger 预示删除语义 */
.hdu-recent-del {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 20px; height: 20px; margin-right: 2px;
  border: 0; background: transparent; cursor: pointer; font-family: inherit;
  font-size: 12px; line-height: 1; color: var(--muted); padding: 0;
}
.hdu-recent-del:hover { color: var(--danger); }
/* 「清空」文字按钮：muted 常态，hover 才提级（不与 chips 抢视觉） */
.hdu-recent-clear {
  flex: none; border: 0; background: transparent; cursor: pointer; font-family: inherit;
  padding: 3px 6px; font-size: 10.5px; color: var(--muted);
}
.hdu-recent-clear:hover { color: var(--ink); text-decoration: underline; }
.hdu-filter-pill { height: 29px; padding: 0 11px; border-radius: 99px; border: 1px solid var(--line); background: transparent; font-size: 11.5px; color: var(--muted); transition: background-color .15s ease, border-color .15s ease, color .15s ease; }
.hdu-filter-pill:hover { border-color: var(--line-strong); color: var(--ink); }
.hdu-filter-pill.is-active { background: var(--ink); border-color: var(--ink); color: var(--paper-2); }
.hdu-knowledge-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 13px; }
.hdu-knowledge-card { padding: 15px 16px; display: flex; flex-direction: column; gap: 9px; }
.hdu-knowledge-head { display: flex; align-items: center; gap: 7px; font-size: 10.5px; color: var(--muted); }
.hdu-knowledge-title { font-family: var(--font-serif); font-size: 14.5px; font-weight: 600; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.hdu-knowledge-text { font-size: 12px; color: var(--ink-soft); line-height: 1.6; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.hdu-knowledge-foot { margin-top: auto; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.hdu-tag { font-size: 10px; padding: 1px 6px; border-radius: 4px; background: var(--paper-3); color: var(--ink-soft); }
.hdu-folder-row { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; margin-bottom: 14px; }
/* 标签管理弹层行（第 124 轮巡检）：标签名 + 频次 + 改名/合并操作 */
.hdu-tag-manage-row { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper-2); }
/* 筛选快照 chips（第 125 轮巡检）：套用按钮 + 删除小叉 */
.hdu-snapshot-chip { display: inline-flex; align-items: center; gap: 2px; }
.hdu-snapshot-chip .hdu-folder { border-top-right-radius: 0; border-bottom-right-radius: 0; }
.hdu-snapshot-del { border: 1px solid var(--line); border-left: none; border-radius: 0 999px 999px 0; background: transparent; color: var(--muted); font-size: 12px; line-height: 1; padding: 4px 7px 4px 4px; cursor: pointer; }
.hdu-snapshot-del:hover { color: var(--danger); border-color: var(--danger); }
/* 标签统计看板（第 125 轮巡检）：每标签 收藏/复习中/完成 三列小卡 */
.hdu-tag-stats { display: flex; flex-direction: column; gap: 6px; margin: -6px 0 14px; }
.hdu-tag-stat-row { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper-2); cursor: pointer; text-align: left; width: 100%; }
.hdu-tag-stat-row:hover { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 6%, transparent); }
.hdu-tag-stat-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
/* 标签覆盖率摘要（第 151 轮巡检）：已打标/全部收藏 + 渐变进度条 */
.hdu-tag-coverage { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 8px; background: color-mix(in srgb, var(--accent) 4%, var(--paper-2)); }
/* 统计窗口说明卡（第 164 轮巡检）：趋势/健康度两个窗口概念 + 列清单；第 165 轮起可折叠 */
.hdu-window-note { display: flex; align-items: flex-start; gap: 8px; padding: 6px 10px; border: 1px dashed var(--line-strong); border-radius: 8px; font-size: 11px; color: var(--muted); line-height: 1.7; background: var(--paper-2); }
.hdu-window-note b { color: var(--ink-soft); margin-right: 4px; }
.hdu-window-note .hdu-folder { flex: none; }
/* 回收站批量操作下拉（第 168 轮巡检）：三类批量操作收纳；第 181 轮补窄面板溢出保护与危险项红字 */
.hdu-batch-wrap { position: relative; flex: none; }
.hdu-batch-menu { position: absolute; top: calc(100% + 4px); right: 0; z-index: 5; display: flex; flex-direction: column; gap: 4px; padding: 6px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper); box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12); min-width: 150px; max-width: calc(100vw - 32px); }
.hdu-batch-menu .hdu-folder { text-align: left; }
.hdu-batch-menu .hdu-folder.is-danger-text { color: var(--danger); }
/* 菜单项 hover 与键盘焦点统一（第 185 轮巡检）；hover 过渡（第 188 轮巡检） */
.hdu-batch-menu .hdu-folder { transition: background 0.1s ease, border-color 0.1s ease; }
.hdu-batch-menu .hdu-folder:hover,
.hdu-batch-menu .hdu-folder:focus-visible { background: color-mix(in srgb, var(--accent) 12%, transparent); border-color: var(--accent); }
/* 危险项与还原项分隔线（第 188 轮巡检） */
.hdu-batch-menu .hdu-folder.is-danger-text { border-top: 1px solid var(--line); border-radius: 0 0 6px 6px; margin-top: 2px; padding-top: 7px; }
/* 浮层层级约定（第 211 轮巡检文档化；第 212 轮补现存元素清单）：
 * 2 = 面板内 sticky 元素（确认横幅/结果条，跟随面板滚动容器）；
 * 5 = 面板内绝对定位下拉（批量菜单，高于 sticky 横幅）；
 * 2003 = 全屏 Modal 遮罩（最高，覆盖一切面板内浮层）。
 * 新增浮层请按「面板内 < 全屏」原则取值，勿跳级。
 * 现存元素：2 → .hdu-window-note.is-danger（确认横幅）/.is-success（结果条）；
 * 5 → .hdu-batch-menu（批量操作菜单）；2003 → .hdu-modal-backdrop（全部 Modal）。 */
/* 确认横幅 sticky（第 189 轮巡检）：长列表滚动时横幅固定在面板顶部；第 190 轮加底部阴影提示滚动边界；
   第 191 轮加 role=status 语义与 10s 倒计时进度条；
   第 192 轮进度条颜色随操作类型（彻底删除 danger / 还原类 accent）+ 悬停暂停倒计时；
   第 194 轮加成功结果反馈条（is-success，绿色描边）；第 198 轮长摘要断词 */
.hdu-window-note.is-danger { animation: hdu-fade-in .15s ease-out; position: sticky; top: 0; z-index: 2; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1); overflow: hidden; }
.hdu-confirm-timer { position: absolute; left: 0; bottom: 0; height: 2px; width: 100%; background: var(--accent); animation: hdu-timer-shrink 10s linear forwards; }
.hdu-window-note.is-purge .hdu-confirm-timer { background: var(--danger); }
.hdu-window-note.is-danger:hover .hdu-confirm-timer,
.hdu-window-note.is-danger:focus-within .hdu-confirm-timer { animation-play-state: paused; }
@keyframes hdu-timer-shrink { from { width: 100%; } to { width: 0; } }
/* 批量操作成功结果条（第 194 轮巡检）；第 197 轮加淡入动画（与确认横幅一致）；第 198 轮长摘要断词；第 201 轮尺寸统一（min-height/居中）；第 218 轮文本可选中 + 淡出 */
.hdu-window-note.is-success { border-color: color-mix(in srgb, var(--accent) 45%, transparent); color: var(--ink); animation: hdu-fade-in .15s ease-out; min-height: 34px; align-items: center; }
.hdu-window-note.is-success,
.hdu-window-note.is-danger { word-break: break-word; }
.hdu-window-note.is-fading { opacity: 0; transition: opacity .2s ease; }
.hdu-window-note { user-select: text; }
.hdu-window-note.is-danger { min-height: 34px; align-items: center; }
/* 回收站勾选框键盘焦点环（第 188 轮巡检） */
.hdu-tag-manage-row input[type='checkbox']:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
/* 说明内容焦点样式（第 210 轮巡检）：tabIndex -1 聚焦时轻微高亮 */
.hdu-window-note > span:focus { background: color-mix(in srgb, var(--accent) 6%, transparent); border-radius: 4px; }
/* 批量菜单项图标与文字对齐（第 210 轮巡检） */
.hdu-batch-menu .hdu-folder { display: inline-flex; align-items: center; gap: 4px; }
/* 回收站勾选行高亮（第 173 轮巡检）：勾选中的条目强调色描边浅底；第 186 轮 checkbox 主题化 */
.hdu-tag-manage-row.is-checked { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 7%, var(--paper-2)); }
.hdu-tag-manage-row input[type='checkbox'] { accent-color: var(--accent); width: 14px; height: 14px; cursor: pointer; flex: none; }
/* 迷你角标（第 184 轮巡检）：入口按钮内的小状态徽标，与今日待办角标同风格 */
.hdu-mini-badge { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 999px; font-size: 10px; font-weight: 600; line-height: 16px; color: var(--paper); background: var(--accent); }
/* 回收站类型徽标着色（第 174 轮巡检）：收藏强调色 / 笔记中性 */
.hdu-trash-kind { padding: 0 5px; border-radius: 4px; font-weight: 600; }
.hdu-trash-kind.is-fav { color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.hdu-trash-kind.is-note { color: var(--muted); background: var(--paper-3); }
/* 过期倒计时紧迫度（第 178 轮巡检）：≤3 天警示色 */
.hdu-hint.is-urgent { color: var(--danger); font-weight: 600; }
/* 失败结果条加粗（第 200 轮巡检）：失败摘要更醒目 */
.hdu-window-note.is-danger { font-weight: 600; }
/* 批量菜单/确认横幅入场动效（第 178 轮巡检）：reduced-motion 下由全局降时长规则兜底 */
.hdu-batch-menu { animation: hdu-rise .18s ease-out; }
.hdu-window-note.is-danger { animation: hdu-fade-in .15s ease-out; }
.hdu-tag-coverage-label { flex: none; font-size: 11px; font-weight: 600; color: var(--ink-soft); }
.hdu-tag-coverage-bar { flex: 1 1 auto; min-width: 40px; height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; }
.hdu-tag-coverage-bar i { display: block; height: 100%; border-radius: 3px; background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 70%, transparent), var(--accent)); transition: width .3s ease; }
/* 覆盖率条入场生长动画（第 154 轮巡检）：面板打开重挂载时从 0 生长一次；
   prefers-reduced-motion 下由全局降时长规则兜底（见文末媒体查询） */
@keyframes hdu-coverage-grow { from { width: 0; } }
.hdu-tag-coverage-bar i { animation: hdu-coverage-grow .6s ease-out; }
.hdu-tag-coverage-num { flex: none; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.hdu-tag-coverage-num b { color: var(--ink); }
/* 覆盖率未达标强调（第 152 轮巡检）：警示色描边 + 浅底，进度条转警示色 */
.hdu-tag-coverage.is-warning { border-color: color-mix(in srgb, var(--danger) 55%, transparent); background: color-mix(in srgb, var(--danger) 6%, var(--paper-2)); }
.hdu-tag-coverage.is-warning .hdu-tag-coverage-bar i { background: linear-gradient(90deg, color-mix(in srgb, var(--danger) 70%, transparent), var(--danger)); }
.hdu-tag-coverage.is-warning .hdu-tag-coverage-num { color: var(--danger); }
.hdu-tag-manage-row.is-warning { border-color: color-mix(in srgb, var(--danger) 55%, transparent); background: color-mix(in srgb, var(--danger) 6%, var(--paper-2)); }
/* 未打标收藏行（第 150/151 轮巡检）：悬停边框微亮，激活态复用 is-active */
.hdu-tag-manage-row { transition: border-color .15s ease, background .15s ease; }
.hdu-tag-manage-row:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); }
/* 迷你趋势柱（第 151 轮巡检细节）：可点柱悬停加亮，暗示可交互 */
.hdu-trend-bar { transition: filter .15s ease, transform .15s ease; }
.hdu-trend-bar:hover { filter: brightness(1.25); }
/* 标签统计近 4 周完成迷你趋势（第 130 轮巡检）：左旧右新小柱，本周柱用强调色；
   第 134 轮起为可点按钮（点柱看该周明细） */
.hdu-tag-trend { display: inline-flex; align-items: flex-end; gap: 2px; height: 15px; flex: none; }
.hdu-trend-bar { display: inline-block; width: 4px; border-radius: 1px; background: var(--line-strong); border: none; padding: 0; cursor: pointer; }
.hdu-trend-bar.is-now { background: var(--accent); }
.hdu-tag-stat-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; color: var(--ink); }
.hdu-tag-stat-num { flex: none; font-size: 11px; color: var(--muted); }
.hdu-tag-stat-num b { color: var(--ink); font-variant-numeric: tabular-nums; margin-right: 2px; }
/* 学习成就徽章（第 125 轮巡检）：解锁亮色 / 未解锁置灰 */
.hdu-achievement-row { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.hdu-achievement { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--paper-2); opacity: .62; }
.hdu-achievement.is-unlocked { opacity: 1; border-color: color-mix(in srgb, var(--accent) 45%, transparent); background: color-mix(in srgb, var(--accent) 7%, transparent); }
.hdu-achievement-name { font-size: 12px; font-weight: 600; color: var(--ink); }
/* 自定义徽章来源角标（第 154 轮巡检）：名称行尾小徽标，强调色描边浅底 */
.hdu-badge-src { display: inline-block; margin-left: 5px; padding: 0 5px; border-radius: 4px; font-size: 9px; font-weight: 600; line-height: 16px; vertical-align: 1px; color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent); }
.hdu-achievement-desc { font-size: 10.5px; color: var(--muted); }
/* 总览成就速览条（第 127 轮巡检）：已解锁计数 + 最近徽章 chips + 直达统计入口 */
.hdu-achv-strip { margin-bottom: 12px; }
.hdu-achv-strip-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.hdu-achv-strip-title { font-size: 12.5px; font-weight: 600; color: var(--ink); }
.hdu-achv-strip-row { display: flex; flex-wrap: wrap; gap: 6px; }
.hdu-achv-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); border-radius: 999px; background: color-mix(in srgb, var(--accent) 8%, transparent); font-size: 11px; color: var(--ink); }
/* 徽章联动 foot（第 252 轮口径核对收官）：本周亮点（周目标达成）与成就条联动提示行，
   jade 小字接在距下一枚进度条下——复用 .hdu-hint 的节奏（11px 小字）但 jade 着色，
   与 Progress jade 变体 / is-hit 家族同色系，暗色随变量自动跟随 */
.hdu-achv-weekly-link { margin-top: 6px; font-size: 11px; color: var(--jade); }
.hdu-folder { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 11px; border-radius: 9px; border: 1px solid var(--line); background: color-mix(in srgb, var(--paper-2) 65%, transparent); font-size: 11.5px; color: var(--ink-soft); white-space: nowrap; }
.hdu-folder.is-active { border-color: var(--ink); background: var(--ink); color: var(--paper-2); }

/* ───────── 统计 ───────── */
/* 三张指标卡（站内累计 / 站外视频 / 连续学习）：auto-fit 自然收编——
   原来固定 3 列、到 600px 才收单列，中间 610-820px 视口（学习中心是 fixed 全屏，
   侧栏还占 196-228px）每列只剩 ~190px 偏挤。收编阈值按内容宽（grid 容器宽）计，
   不是视口宽：每列 minmax(240px)、列间距 14px，3 列需 3×240+2×14=748，
   2 列需 2×240+14=494——内容宽 ≥748px 时 3 列、494-748px 收 2 列、更窄 1 列，
   ≥1080 宽屏仍是 3 列不受影响。 */
.hdu-stat-hero { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 14px; }
.hdu-metric { padding: 18px 20px; display: flex; flex-direction: column; gap: 8px; }
.hdu-metric-head { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 11.5px; }
.hdu-metric-value { font-family: var(--font-serif); font-size: 34px; font-weight: 600; line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.hdu-metric-value small { font-family: var(--font-sans); font-size: 11px; color: var(--muted); font-weight: 400; margin-left: 5px; }
.hdu-dist { display: flex; flex-direction: column; gap: 11px; }
.hdu-dist-row { display: grid; grid-template-columns: minmax(0, 1fr) 90px 44px; align-items: center; gap: 10px; font-size: 12px; }
.hdu-dist-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--ink-soft); }
.hdu-dist-bar { height: 5px; border-radius: 99px; background: var(--paper-3); overflow: hidden; }
.hdu-dist-bar > i { display: block; height: 100%; background: var(--accent-2); border-radius: inherit; }
.hdu-dist-val { text-align: right; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.hdu-note-text { font-size: 11.5px; color: var(--muted); line-height: 1.7; padding: 13px 15px; border: 1px dashed var(--line-strong); border-radius: 12px; }

/* ───────── 播放页面板 ───────── */
.hdu-dock {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
  display: flex; align-items: center; gap: 8px;
  padding: 7px; border-radius: 16px;
  background-color: var(--paper-2);
  background: color-mix(in srgb, var(--paper-2) 92%, transparent);
  border: 1px solid var(--line); box-shadow: var(--shadow);
  backdrop-filter: blur(14px);
  animation: hdu-rise .25s ease-out;
}
.hdu-dock-btn { display: inline-flex; align-items: center; gap: 7px; height: 36px; padding: 0 12px; border-radius: 10px; font-size: 12px; color: var(--ink-soft); transition: background .15s, color .15s; }
.hdu-dock-btn:hover { background: var(--paper-3); color: var(--ink); }
.hdu-dock-btn.is-active { background: var(--ink); color: var(--paper-2); }
.hdu-dock-btn svg { width: 16px; height: 16px; }
.hdu-dock-mark { position: relative; width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; background: var(--ink); color: var(--paper-2); font-family: var(--font-serif); font-size: 16px; }
/* 入口坞今日待办徽标（第 77 轮巡检）：挂「学」标右上角，描边与底色衔接宿主面板 */
.hdu-dock-badge {
  position: absolute; top: -6px; right: -6px; min-width: 17px; height: 17px; padding: 0 4px;
  border-radius: 99px; display: grid; place-items: center; box-sizing: border-box;
  background: var(--danger); color: #fff; font-family: var(--font-sans); font-size: 10px; font-weight: 600;
  line-height: 1; border: 2px solid var(--paper-2); pointer-events: none;
}

.hdu-panel {
  position: fixed; top: 84px; right: 20px; bottom: 86px; z-index: 2147483000;
  width: 384px; max-width: calc(100vw - 40px);
  display: flex; flex-direction: column; overflow: hidden;
  border: 1px solid var(--line); border-radius: 20px;
  background-color: var(--paper);
  background: color-mix(in srgb, var(--paper) 96%, transparent);
  box-shadow: var(--shadow); backdrop-filter: blur(18px);
  animation: hdu-rise .24s ease-out;
}
.hdu-panel-full { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.hdu-panel-head { padding: 15px 16px 12px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 9px; }
.hdu-panel-head-top { display: flex; align-items: flex-start; gap: 9px; }
.hdu-panel-session { flex: 1; min-width: 0; }
.hdu-panel-course { font-family: var(--font-serif); font-size: 15.5px; font-weight: 600; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hdu-panel-cour { font-size: 10.5px; color: var(--muted); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hdu-panel-head-actions { display: flex; gap: 2px; flex: 0 0 auto; }
.hdu-panel-status { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
/* 本课学习小条（第 241 轮巡检）：收起态一行摘要 / 展开态明细卡；数字 tabular-nums */
.hdu-lesson-strip { border: 1px solid color-mix(in srgb, var(--line) 70%, transparent); border-radius: 9px; background: color-mix(in srgb, var(--paper-3) 40%, transparent); overflow: hidden; transition: border-color .15s, background .15s; }
.hdu-lesson-strip:hover { border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
.hdu-lesson-strip.is-expanded { background: var(--paper-3); }
.hdu-lesson-strip-head { display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 9px; border: none; background: transparent; cursor: pointer; font-family: inherit; font-size: 11px; color: var(--muted); text-align: left; }
.hdu-lesson-strip-head:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.hdu-lesson-strip-summary { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hdu-num { font-variant-numeric: tabular-nums; color: var(--ink); font-weight: 600; }
.hdu-lesson-strip-sep { margin: 0 2px; opacity: .6; }
.hdu-lesson-strip-badge { flex: 0 0 auto; padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 600; font-variant-numeric: tabular-nums; color: #fff; background: var(--danger); }
.hdu-lesson-strip-body { display: flex; flex-direction: column; gap: 5px; padding: 2px 9px 9px; }
.hdu-lesson-strip-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--muted); }
.hdu-lesson-strip-value { font-size: 12px; }
.hdu-lesson-todo { display: flex; align-items: center; gap: 6px; margin-top: 2px; padding: 6px 8px; border-radius: 8px; border: none; font-family: inherit; font-size: 11px; text-align: left; }
.hdu-lesson-todo.is-danger { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); cursor: pointer; font-weight: 600; transition: background .15s; }
.hdu-lesson-todo.is-danger:hover { background: color-mix(in srgb, var(--danger) 22%, transparent); }
.hdu-lesson-todo.is-danger:focus-visible { outline: 2px solid var(--danger); outline-offset: 1px; }
.hdu-lesson-todo.is-jade { color: var(--jade); background: color-mix(in srgb, var(--jade) 10%, transparent); }
.hdu-lesson-todo-action { margin-left: auto; flex: 0 0 auto; opacity: .85; }
/* 本课笔记行（第 243 轮巡检）：与待办行同排版（复用 .hdu-lesson-todo 的行高/图标位/padding），
   信息态 info 着色 + hover 加深；N=0 轻入口弱化态——虚线边 + 半透明，hover 恢复 */
.hdu-lesson-note.is-info { color: var(--info); background: color-mix(in srgb, var(--info) 10%, transparent); cursor: pointer; font-weight: 600; transition: background .15s; }
.hdu-lesson-note.is-info:hover { background: color-mix(in srgb, var(--info) 20%, transparent); }
.hdu-lesson-note.is-info:focus-visible { outline: 2px solid var(--info); outline-offset: 1px; }
.hdu-lesson-note.is-empty { color: var(--muted); background: transparent; border: 1px dashed color-mix(in srgb, var(--line-strong) 85%, transparent); padding: 5px 7px; cursor: pointer; opacity: .8; transition: opacity .15s, border-color .15s; font-weight: 400; }
.hdu-lesson-note.is-empty:hover { opacity: 1; border-color: color-mix(in srgb, var(--accent) 55%, transparent); color: var(--ink-soft); }
.hdu-lesson-note.is-empty:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.hdu-lesson-note.is-empty .hdu-lesson-todo-action { opacity: .7; }
.hdu-panel-tabs { display: flex; gap: 1px; padding: 6px 8px; border-bottom: 1px solid var(--line); overflow-x: auto; scrollbar-width: none; }
.hdu-panel-tabs::-webkit-scrollbar { display: none; }
.hdu-panel-tab { position: relative; height: 30px; padding: 0 10px; border-radius: 8px; font-size: 11.5px; color: var(--muted); white-space: nowrap; transition: color .15s, background .15s; }
.hdu-panel-tab:hover { color: var(--ink); background: var(--paper-3); }
.hdu-panel-tab.is-active { color: var(--ink); background: var(--paper-3); font-weight: 600; }
.hdu-panel-tab .hdu-tab-dot { position: absolute; top: 5px; right: 5px; width: 4px; height: 4px; border-radius: 99px; background: var(--accent); }
.hdu-panel-body { flex: 1; min-height: 0; overflow: auto; padding: 14px 16px 18px; }
.hdu-panel-foot { border-top: 1px solid var(--line); padding: 10px 12px; background: color-mix(in srgb, var(--paper-2) 55%, transparent); }
.hdu-panel-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.hdu-panel-actions .hdu-btn { flex: 0 0 auto; }

.hdu-overview-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.hdu-overview-cell { padding: 11px 12px; border: 1px solid var(--line); border-radius: 11px; background: color-mix(in srgb, var(--paper-2) 60%, transparent); }
.hdu-overview-label { font-size: 10px; color: var(--muted); letter-spacing: .04em; }
.hdu-overview-value { margin-top: 4px; font-family: var(--font-serif); font-size: 18px; font-variant-numeric: tabular-nums; }
.hdu-overview-value.small { font-family: var(--font-sans); font-size: 12px; font-weight: 500; }

.hdu-transcript { display: flex; flex-direction: column; gap: 2px; }
.hdu-seg { display: flex; gap: 9px; padding: 7px 6px; border-radius: 8px; text-align: left; width: 100%; transition: background .13s; }
.hdu-seg:hover { background: var(--paper-3); }
.hdu-seg.is-active { background: var(--accent-soft); }
.hdu-seg-time { flex: 0 0 40px; font-family: var(--font-mono); font-size: 10px; color: var(--muted); padding-top: 2px; font-variant-numeric: tabular-nums; }
.hdu-seg-text { font-size: 12.5px; line-height: 1.6; color: var(--ink-soft); }
.hdu-seg.is-active .hdu-seg-text { color: var(--ink); }
.hdu-topic { padding: 11px 12px; border-radius: 12px; border: 1px solid var(--line); background: color-mix(in srgb, var(--paper-2) 55%, transparent); display: flex; flex-direction: column; gap: 6px; text-align: left; width: 100%; }
.hdu-topic + .hdu-topic { margin-top: 8px; }
.hdu-topic:hover { border-color: var(--line-strong); background: var(--paper-2); }
.hdu-topic-head { display: flex; align-items: center; gap: 7px; }
.hdu-topic-name { font-size: 12.5px; font-weight: 600; }
.hdu-topic-sum { font-size: 11.5px; color: var(--muted); line-height: 1.6; }
.hdu-topic-times { display: flex; gap: 5px; flex-wrap: wrap; }
.hdu-topic-time { font-family: var(--font-mono); font-size: 9.5px; padding: 1px 5px; border-radius: 4px; background: var(--paper-3); color: var(--ink-soft); }
.hdu-topic.low { opacity: .62; }
.hdu-outline { display: flex; flex-direction: column; gap: 1px; }
.hdu-outline-row { display: flex; align-items: center; gap: 8px; padding: 7px 6px; border-radius: 8px; text-align: left; width: 100%; transition: background .13s; }
.hdu-outline-row:hover { background: var(--paper-3); }
.hdu-outline-row.l2 { padding-left: 24px; }
.hdu-outline-row.is-active { background: var(--jade-soft); }
.hdu-outline-mark { width: 4px; height: 4px; border-radius: 99px; background: var(--line-strong); flex: 0 0 auto; }
.hdu-outline-row.l1 .hdu-outline-mark { width: 6px; height: 6px; background: var(--accent-2); }
.hdu-outline-title { flex: 1; min-width: 0; font-size: 12px; color: var(--ink-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hdu-outline-row.l1 .hdu-outline-title { font-weight: 600; color: var(--ink); }
.hdu-outline-time { font-family: var(--font-mono); font-size: 9.5px; color: var(--muted); }

.hdu-qa { display: flex; flex-direction: column; gap: 13px; }
.hdu-qa-msg { display: flex; flex-direction: column; gap: 5px; }
.hdu-qa-msg.user { align-items: flex-end; }
.hdu-qa-bubble { max-width: 92%; padding: 9px 12px; border-radius: 13px; font-size: 12.5px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; }
.hdu-qa-msg.user .hdu-qa-bubble { background: var(--ink); color: var(--paper-2); border-bottom-right-radius: 4px; }
.hdu-qa-msg.ai .hdu-qa-bubble { background: var(--paper-2); border: 1px solid var(--line); border-bottom-left-radius: 4px; color: var(--ink-soft); }
.hdu-qa-meta { display: flex; align-items: center; gap: 8px; font-size: 10px; color: var(--muted); }
.hdu-qa-anchor { font-family: var(--font-mono); }
.hdu-qa-evidence { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 5px; background: var(--info-soft); color: var(--info); font-size: 10px; }
/* 会话历史消息预览（第 104 轮巡检）：HDU 侧历史会话的只读消息预览块（与 B 站侧同构） */
.hdu-qa-hist-preview { flex-basis: 100%; margin-top: 6px; padding: 8px 10px; border-radius: 8px; background: var(--paper-2); border: 1px solid color-mix(in srgb, var(--line) 70%, transparent); max-height: 220px; overflow: auto; }
.hdu-qa-hist-msg { font-size: 12px; line-height: 1.6; margin-bottom: 6px; }
.hdu-qa-hist-msg p { margin: 2px 0 0; white-space: pre-wrap; word-break: break-word; }
.hdu-qa-hist-anchor { all: unset; cursor: pointer; color: var(--accent); font-size: 11px; margin-left: 6px; }
.hdu-qa-hist-anchor:hover { text-decoration: underline; }
.hdu-composer { display: flex; align-items: flex-end; gap: 7px; }
.hdu-composer textarea { flex: 1; min-height: 36px; max-height: 110px; resize: none; border: 1px solid var(--line); border-radius: 11px; background: var(--paper-2); padding: 8px 10px; font-size: 12.5px; line-height: 1.5; outline: none; }
.hdu-composer textarea:focus { border-color: var(--accent-2); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-2) 14%, transparent); }
.hdu-composer-hint { display: flex; align-items: center; gap: 7px; margin-top: 6px; font-size: 10px; color: var(--muted); flex-wrap: wrap; }
.hdu-composer-hint kbd { font-family: var(--font-mono); font-size: 9.5px; padding: 1px 5px; border-radius: 4px; background: var(--paper-3); border: 1px solid var(--line); }

.hdu-note { display: flex; gap: 10px; padding: 10px 4px; border-bottom: 1px solid color-mix(in srgb, var(--line) 60%, transparent); }
.hdu-note:last-child { border-bottom: 0; }
.hdu-note-time { flex: 0 0 42px; font-family: var(--font-mono); font-size: 10px; color: var(--accent); padding-top: 2px; cursor: pointer; }
.hdu-note-body { flex: 1; min-width: 0; }
.hdu-note-text { font-size: 12px; line-height: 1.6; color: var(--ink-soft); white-space: pre-wrap; word-break: break-word; }
/* 笔记行课程名小徽标（第 122 轮巡检）：知识库我的笔记行显示归属课程，配合课程筛选 */
.hdu-note-course { display: inline-block; padding: 0 6px; margin-right: 4px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent); font-size: 10.5px; line-height: 16px; vertical-align: 1px; }
.hdu-note-actions { display: flex; gap: 2px; flex: 0 0 auto; }
.hdu-fav-row { display: flex; align-items: flex-start; gap: 9px; padding: 10px 4px; border-bottom: 1px solid color-mix(in srgb, var(--line) 60%, transparent); }
.hdu-fav-row:last-child { border-bottom: 0; }
.hdu-fav-icon { width: 26px; height: 26px; border-radius: 8px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); flex: 0 0 auto; }
.hdu-fav-icon svg { width: 13px; height: 13px; }
.hdu-fav-body { flex: 1; min-width: 0; }
.hdu-fav-title { font-size: 12px; font-weight: 500; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.hdu-fav-sub { margin-top: 2px; font-size: 10.5px; color: var(--muted); display: flex; gap: 7px; flex-wrap: wrap; }

.hdu-caption {
  position: fixed; z-index: 2147483001; left: 50%; transform: translateX(-50%);
  max-width: min(72vw, 900px); padding: 8px 14px; border-radius: 10px;
  font-size: 20px; line-height: 1.5; text-align: center; color: #fff;
  background: rgba(10, 14, 22, .76); text-shadow: 0 1px 2px rgba(0,0,0,.55);
  pointer-events: none; transition: opacity .18s ease;
  font-family: var(--font-sans);
}

.hdu-timeline {
  position: fixed; z-index: 2147482999; height: 9px; pointer-events: none;
  border-radius: 99px;
}
.hdu-timeline-mark { position: absolute; bottom: 0; height: 4px; border-radius: 99px; background: var(--accent-2); opacity: .6; pointer-events: auto; cursor: pointer; transition: opacity .15s, height .15s; }
.hdu-timeline-mark:hover { opacity: 1; height: 6px; }
.hdu-timeline-mark.low { opacity: .28; }
.hdu-timeline-mark.is-active { opacity: 1; background: var(--jade); }

.hdu-capsule {
  position: fixed; left: 50%; top: 14px; transform: translateX(-50%); z-index: 2147483000;
  display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px;
  border-radius: 99px; border: 1px solid var(--line); background-color: var(--paper-2);
  background: color-mix(in srgb, var(--paper-2) 92%, transparent);
  box-shadow: var(--shadow-soft); backdrop-filter: blur(12px);
  font-size: 11.5px; color: var(--ink-soft); cursor: pointer; max-width: min(80vw, 620px); white-space: nowrap;
  animation: hdu-fade-in .2s ease-out;
}
.hdu-capsule:hover { border-color: var(--line-strong); }
.hdu-capsule b { font-weight: 600; color: var(--ink); overflow: hidden; text-overflow: ellipsis; }
.hdu-capsule .hdu-dot { margin-left: 2px; }

/* toast 高于全部浮层（第 38 轮巡检：字幕浮层包裹层 2147483005、弹窗遮罩
   2147483003、模态浮层层 2147483001）：弹窗/字幕浮层内触发的提示不能被遮挡 */
.hdu-toast-stack { position: fixed; right: 20px; bottom: 82px; z-index: 2147483006; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; pointer-events: none; }
.hdu-toast { display: flex; align-items: flex-start; gap: 8px; max-width: 360px; padding: 10px 13px; border-radius: 12px; border: 1px solid var(--line); background: var(--paper-2); box-shadow: var(--shadow); font-size: 12px; color: var(--ink-soft); animation: hdu-rise .2s ease-out; pointer-events: auto; }
.hdu-toast.error { border-color: color-mix(in srgb, var(--danger) 35%, var(--line)); }
.hdu-toast .hdu-toast-icon { width: 15px; height: 15px; flex: 0 0 auto; margin-top: 1px; color: var(--jade); }
.hdu-toast.error .hdu-toast-icon { color: var(--danger); }
/* error 专用关闭钮（第 249 轮 toast 分级伴随样式）：20px 命中区（含 2px 内边距），
   弱色不抢主体、hover 提亮；整条 toast 本就可点击关闭，此钮让「关掉它」意图更明确 */
.hdu-toast .hdu-toast-close { flex: 0 0 auto; display: grid; place-items: center; width: 20px; height: 20px; margin: -1px -1px 0 0; padding: 0; border: none; border-radius: 6px; background: transparent; color: var(--muted); cursor: pointer; }
.hdu-toast .hdu-toast-close:hover { color: var(--ink); background: color-mix(in srgb, var(--ink) 8%, transparent); }
.hdu-root[data-theme="dark"] .hdu-toast .hdu-toast-close:hover { color: var(--ink-soft); background: color-mix(in srgb, var(--ink) 18%, transparent); }

.hdu-modal-backdrop { position: fixed; inset: 0; z-index: 2147483003; background: rgba(12, 14, 17, .38); backdrop-filter: blur(3px); display: grid; place-items: center; animation: hdu-fade-in .15s ease-out; }
.hdu-modal { width: min(560px, calc(100vw - 40px)); max-height: calc(100vh - 80px); display: flex; flex-direction: column; border-radius: 18px; border: 1px solid var(--line); background: var(--paper); box-shadow: var(--shadow); overflow: hidden; animation: hdu-rise .2s ease-out; }
.hdu-modal-head { padding: 16px 18px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 10px; }
.hdu-modal-title { font-family: var(--font-serif); font-size: 16px; font-weight: 600; }
.hdu-modal-body { padding: 16px 18px; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
.hdu-modal-foot { padding: 12px 18px; border-top: 1px solid var(--line); display: flex; justify-content: flex-end; gap: 8px; }
.hdu-field { display: flex; flex-direction: column; gap: 5px; }
.hdu-field label { font-size: 11.5px; color: var(--muted); }
.hdu-field .hdu-input, .hdu-field .hdu-textarea { width: 100%; }
.hdu-hint { font-size: 11px; color: var(--muted); line-height: 1.6; }
/* 内联警示片段（第 233 轮巡检）：回收站统计行「3 天内将清理 K」红字加粗，与 .is-urgent 同语义但作用于片段 */
.hdu-warn-inline { color: var(--danger); font-weight: 600; }
.hdu-error-text { font-size: 11.5px; color: var(--danger); line-height: 1.6; }

.hdu-pill-tabs { display: inline-flex; gap: 2px; padding: 3px; border-radius: 10px; background: var(--paper-3); }
.hdu-pill-tab { height: 27px; padding: 0 10px; border-radius: 7px; font-size: 11.5px; color: var(--muted); }
.hdu-pill-tab.is-active { background: var(--paper-2); color: var(--ink); box-shadow: 0 1px 2px rgba(0,0,0,.06); }

.hdu-scroll-x { overflow-x: auto; scrollbar-width: none; }
.hdu-scroll-x::-webkit-scrollbar { display: none; }

/* 学习热力图（第 77 轮巡检）：周列 × 7 行日格，档位色由 --jade 系混合出 5 阶；
   窄容器经 .hdu-heatmap-scroll 横向滚动（日格 min-width 收紧不换行） */
.hdu-heatmap { display: flex; flex-direction: column; gap: 10px; }
.hdu-heatmap-scroll { overflow-x: auto; scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; }
.hdu-heatmap-inner { display: flex; gap: 8px; min-width: max-content; padding-bottom: 2px; }
.hdu-heatmap-axis { display: grid; grid-template-rows: repeat(7, 12px); gap: 3px; margin-top: 18px; flex: none; }
.hdu-heatmap-axis span { font-size: 9px; line-height: 12px; color: var(--muted); text-align: right; }
.hdu-heatmap-body { display: flex; flex-direction: column; gap: 4px; }
.hdu-heatmap-months { display: flex; gap: 3px; height: 14px; }
.hdu-heatmap-month { width: 12px; flex: none; font-size: 10px; line-height: 14px; color: var(--muted); white-space: nowrap; overflow: visible; }
.hdu-heatmap-grid { display: grid; grid-template-rows: repeat(7, 12px); grid-auto-flow: column; grid-auto-columns: 12px; gap: 3px; }
.hdu-heatmap-cell {
  width: 12px; height: 12px; border-radius: 3px; box-sizing: border-box;
  background: var(--paper-3); border: 1px solid color-mix(in srgb, var(--line) 55%, transparent);
  transition: transform .12s ease, box-shadow .12s ease;
}
.hdu-heatmap-cell:hover { transform: scale(1.25); box-shadow: 0 0 0 1px var(--accent-soft); z-index: 1; }
.hdu-heatmap-cell[data-level='1'] { background: color-mix(in srgb, var(--jade) 22%, var(--paper-3)); }
.hdu-heatmap-cell[data-level='2'] { background: color-mix(in srgb, var(--jade) 45%, var(--paper-3)); }
.hdu-heatmap-cell[data-level='3'] { background: color-mix(in srgb, var(--jade) 72%, var(--paper-2)); }
.hdu-heatmap-cell[data-level='4'] { background: var(--jade); border-color: transparent; }
.hdu-heatmap-cell.is-today { outline: 2px solid var(--accent); outline-offset: 1px; }
/* 复习计划今日到期行强调（第 98 轮巡检） */
.hdu-todo-row.is-today-due { border-left: 3px solid var(--accent); }
/* 复习计划已逾期行强调（第 100 轮巡检） */
.hdu-todo-row.is-overdue { border-left: 3px solid var(--danger); }
/* 复习计划周视图条（第 105 轮巡检）：逾期 + 今日起 7 天分栏，点选按日筛选 */
.hdu-week-strip { display: flex; gap: 6px; margin-bottom: 10px; overflow-x: auto; }
.hdu-week-col { flex: 1 0 62px; display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 7px 4px; border: 1px solid color-mix(in srgb, var(--line) 70%, transparent); border-radius: 9px; background: transparent; cursor: pointer; font-family: inherit; transition: border-color .15s, background .15s; }
.hdu-week-col:hover:not(:disabled) { border-color: var(--accent); }
.hdu-week-col.is-active { background: color-mix(in srgb, var(--accent) 12%, transparent); border-color: var(--accent); }
.hdu-week-col.today { border-color: color-mix(in srgb, var(--accent) 55%, transparent); }
.hdu-week-col.overdue .hdu-week-col-count { color: var(--danger); }
.hdu-week-col:disabled { opacity: .45; cursor: default; }
.hdu-week-col-label { font-size: 10.5px; color: var(--muted); white-space: nowrap; }
.hdu-week-col.is-active .hdu-week-col-label { color: var(--accent); }
.hdu-week-col-count { font-size: 14px; font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; }
/* 7 日到期预测小柱图（第 241 轮巡检）：复用 .hdu-bars 家族基线（间距/字号与周历条对齐），
   可点柱（有到期的日柱/逾期柱）hover 抬亮 + focus-visible；最高柱 accent 高亮，今日柱 jade */
.hdu-review-forecast { display: flex; align-items: stretch; gap: 6px; margin-bottom: 10px; padding: 8px 8px 6px; border: 1px solid color-mix(in srgb, var(--line) 70%, transparent); border-radius: 10px; overflow-x: auto; }
.hdu-forecast-col { flex: 1 0 44px; display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 0; border: none; background: transparent; cursor: default; font-family: inherit; border-radius: 8px; transition: background .15s; }
.hdu-forecast-col:not(:disabled) { cursor: pointer; }
.hdu-forecast-col:not(:disabled):hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
.hdu-root .hdu-forecast-col:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.hdu-forecast-track { width: 100%; max-width: 30px; height: 56px; display: flex; align-items: flex-end; border-radius: 6px; background: color-mix(in srgb, var(--paper-3) 55%, transparent); overflow: hidden; }
.hdu-forecast-fill { width: 100%; border-radius: 6px 6px 3px 3px; background: var(--accent); opacity: .82; transition: height .3s ease; min-height: 2px; }
.hdu-forecast-col.is-peak .hdu-forecast-fill { background: var(--accent); opacity: 1; box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--accent) 45%, transparent) inset; }
.hdu-forecast-col.is-overdue .hdu-forecast-fill { background: var(--danger); }
.hdu-forecast-col.is-overdue.is-peak { box-shadow: none; }
.hdu-forecast-col.is-today:not(.is-overdue) .hdu-forecast-track { background: color-mix(in srgb, var(--jade) 14%, transparent); }
.hdu-forecast-col.is-today:not(.is-overdue) .hdu-forecast-fill { background: var(--jade); }
.hdu-forecast-col.is-today.is-peak:not(.is-overdue) .hdu-forecast-fill { opacity: 1; }
.hdu-forecast-count { font-size: 12px; font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; line-height: 1.2; }
.hdu-forecast-col.is-peak .hdu-forecast-count { color: var(--accent); }
.hdu-forecast-col.is-overdue .hdu-forecast-count { color: var(--danger); }
.hdu-forecast-col:disabled .hdu-forecast-count { color: var(--muted); font-weight: 500; }
.hdu-forecast-label { font-size: 10.5px; color: var(--muted); white-space: nowrap; }
.hdu-forecast-empty { margin-bottom: 10px; padding: 10px 12px; border: 1px dashed color-mix(in srgb, var(--line) 80%, transparent); border-radius: 10px; font-size: 11.5px; color: var(--muted); text-align: center; }
/* 复习计划完整周视图（第 106 轮巡检）：7 日分栏内嵌作业行 */
.hdu-week-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-bottom: 4px; }
.hdu-week-grid.is-14 { grid-template-columns: repeat(7, minmax(0, 1fr)); }
/* 复习统计条（第 108 轮巡检）：待完成/今日到期/已逾期/已完成/已跳过 计数一览 */
.hdu-review-stats { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.hdu-review-stat { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--muted); border: 1px solid color-mix(in srgb, var(--line) 70%, transparent); border-radius: 999px; padding: 4px 10px; }
button.hdu-review-stat { cursor: pointer; font-family: inherit; }
button.hdu-review-stat:hover { border-color: var(--accent); }
.hdu-review-stat.is-active { border-color: var(--accent); color: var(--ink); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.hdu-review-stat b { font-size: 13px; color: var(--ink); font-variant-numeric: tabular-nums; }
.hdu-review-stat.is-today b { color: var(--accent); }
.hdu-review-stat.is-overdue b { color: var(--danger); }
.hdu-review-stat.is-done b { color: var(--jade); }

/* 复习统计摘要行（第 247 轮巡检，复习域收官 / 信息视角）：预测柱图下方四 mini 指标
   横排（累计完成 / 本周完成 / 连续天数 / 跳过率）。与上方 .hdu-review-stats 计数条
   （pending 视角）互补；数值 tabular-nums + 标签 muted 两行式，格间 1px 细竖线分隔；
   跳过率 danger 淡色档（语义警示但不抢眼），空态一行 muted 说明（虚线框，对齐
   .hdu-forecast-empty 家族）。颜色全走 CSS 变量，暗色随 .hdu-root[data-theme] 自动生效 */
.hdu-review-stats-summary {
  display: flex; align-items: stretch; margin-bottom: 10px; padding: 8px 6px;
  border: 1px solid color-mix(in srgb, var(--line) 70%, transparent); border-radius: 10px;
  background: color-mix(in srgb, var(--paper-3) 55%, transparent); overflow-x: auto;
}
.hdu-review-stat-mini { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 0 16px; min-width: 0; }
.hdu-review-stat-mini + .hdu-review-stat-mini { border-left: 1px solid color-mix(in srgb, var(--line) 80%, transparent); }
.hdu-review-stat-value { font-size: 15px; font-weight: 700; line-height: 1.2; color: var(--ink); font-variant-numeric: tabular-nums; }
.hdu-review-stat-label { font-size: 10.5px; color: var(--muted); line-height: 1.4; white-space: nowrap; }
/* 跳过率 danger 淡色档：danger 字色 + 透明度降一档，提示存在跳过而不渲染成告警 */
.hdu-review-stat-mini.is-skip .hdu-review-stat-value { color: var(--danger); opacity: .82; }
.hdu-review-stats-summary.is-empty {
  display: block; padding: 8px 12px; font-size: 11px; color: var(--muted); line-height: 1.6;
  border-style: dashed; background: transparent;
}
/* 倍增间隔刻度条（第 246 轮巡检）：pending 行 hdu-list-sub 内 4 格迷你档位条
   （3/7/14/30 天）。5px 高与 11px 文字行基线居中（父级 align-items:center），
   已完成档实色 jade、当前档 accent（与完成建议同色系）、未来档淡线色 */
.hdu-interval-scale { display: inline-flex; align-items: center; gap: 2px; flex: none; }
.hdu-interval-cell { display: inline-block; width: 10px; height: 5px; border-radius: 2px; background: color-mix(in srgb, var(--line-strong) 40%, transparent); }
.hdu-interval-cell.is-done { background: var(--jade); }
.hdu-interval-cell.is-cur { background: var(--accent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent); }
/* 行内操作浮层基线：窄行不挤压——hdu-list-sub 已 flex-wrap，刻度条整条随行折行不截断 */
.hdu-week-day { border: 1px solid color-mix(in srgb, var(--line) 70%, transparent); border-radius: 10px; padding: 8px; min-height: 86px; display: flex; flex-direction: column; gap: 6px; transition: opacity .15s; }
.hdu-week-day.today { border-color: color-mix(in srgb, var(--accent) 55%, transparent); background: color-mix(in srgb, var(--accent) 6%, transparent); }
.hdu-week-day.overdue { border-color: color-mix(in srgb, var(--danger) 45%, transparent); }
.hdu-week-day.is-dim { opacity: .38; }
.hdu-week-day-head { display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--muted); }
.hdu-week-day.today .hdu-week-day-head { color: var(--accent); font-weight: 600; }
.hdu-week-day.overdue .hdu-week-day-head { color: var(--danger); }
.hdu-week-day-count { font-variant-numeric: tabular-nums; }
.hdu-week-day-empty { color: var(--muted); opacity: .5; text-align: center; margin: auto; }
.hdu-week-job { border: 1px solid color-mix(in srgb, var(--line) 62%, transparent); border-radius: 8px; padding: 6px 7px; display: flex; flex-direction: column; gap: 4px; background: var(--paper-2); }
.hdu-week-job-title { font-size: 12px; font-weight: 600; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hdu-week-job-sub { font-size: 10.5px; color: var(--muted); }
.hdu-week-job-actions { display: flex; gap: 5px; }
/* 复习计划月视图（第 111 轮巡检）：月份导航 + 星期表头 + 周历栅格 */
.hdu-month-nav { display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 8px; }
.hdu-month-label { font-size: 13px; font-weight: 600; color: var(--ink); min-width: 88px; text-align: center; }
.hdu-month-weekdays { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; margin-bottom: 4px; }
.hdu-month-weekdays span { text-align: center; font-size: 10.5px; color: var(--muted); }
.hdu-month-grid { grid-template-columns: repeat(7, minmax(0, 1fr)); }
.hdu-month-grid .hdu-week-day { min-height: 64px; }
.hdu-week-job.is-overdue { border-left: 3px solid var(--danger); }
/* 月视图格内折叠开关（第 123 轮巡检）：「还有 N 项 / 收起」小 pill，居中铺满格宽 */
.hdu-cell-more { width: 100%; margin-top: 4px; padding: 2px 0; border: 1px dashed var(--line-strong); border-radius: 8px; background: transparent; color: var(--muted); font-size: 10px; line-height: 16px; cursor: pointer; text-align: center; }
.hdu-cell-more:hover { color: var(--accent); border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
/* 月视图格内密度（第 124 轮巡检）：格内作业行改块级流式排布——操作按钮转行内横排
   自动换行（原先 4 枚按钮竖叠把格子拉得极高）；标题放宽为两行截断，全文靠 title 悬浮 */
.hdu-month-grid .hdu-week-job { display: block; }
.hdu-month-grid .hdu-week-job-title { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 1.35; }
.hdu-month-grid .hdu-week-job-sub { margin-top: 1px; }
.hdu-month-grid .hdu-week-job .hdu-btn { height: 20px; padding: 0 7px; font-size: 10px; border-radius: 6px; margin: 3px 3px 0 0; }
.hdu-month-grid .hdu-week-job .hdu-btn svg { width: 11px; height: 11px; }
/* 今日格子脉冲（第 97 轮巡检）：prefers-reduced-motion 下由全局降时长规则关闭 */
@keyframes hdu-today-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 45%, transparent); }
  50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 45%, transparent); }
}
.hdu-heatmap-cell.is-today { animation: hdu-today-pulse 2.4s ease-in-out infinite; }
.hdu-heatmap-cell.is-future { visibility: hidden; }
/* 格子可点（第 79 轮巡检）：点击弹出当日学习明细 */
.hdu-heatmap-cell.is-clickable { cursor: pointer; }
/* B站知识库文件夹筛选下拉（第 79 轮巡检）：随工具行换行，宽度随内容 */
.hdu-hub-folder { width: auto; flex: none; height: 30px; padding: 0 8px; }
/* B站知识库标签筛选 chips（第 82 轮巡检）：与类型 chips 同视觉、独立类名避免断言串扰 */
.hdu-hub-tag-chips { display: inline-flex; align-items: center; gap: 6px; flex: none; flex-wrap: wrap; }
.hdu-hub-tag-chip {
  padding: 3px 10px; border-radius: 99px; border: 1px solid var(--line);
  background: color-mix(in srgb, var(--paper-2) 70%, transparent);
  color: var(--muted); font-size: 11.5px; line-height: 1.6; font-family: inherit;
  white-space: nowrap; cursor: pointer;
  transition: border-color .15s ease, background-color .15s ease, color .15s ease;
}
.hdu-hub-tag-chip:hover { border-color: var(--accent); color: var(--accent); }
.hdu-hub-tag-chip.is-active { background: var(--accent-soft); border-color: transparent; color: var(--accent); font-weight: 500; }
/* 热力图月视图（第 81 轮巡检）：31 行日格对齐当月天数，纵轴同步 31 行 */
.hdu-heatmap-grid.is-monthly { grid-template-rows: repeat(31, 12px); }
.hdu-heatmap-axis.is-monthly { grid-template-rows: repeat(31, 12px); }
/* 知识库批量整理（第 88 轮巡检）：多选勾选角标 + 操作条 */
.hdu-knowledge-grid .hdu-tidy-wrap { position: relative; display: flex; }
.hdu-knowledge-grid .hdu-tidy-wrap.is-selected .hdu-knowledge-card { outline: 2px solid var(--accent); outline-offset: 1px; }
.hdu-tidy-check {
  position: absolute; top: 8px; left: 8px; z-index: 2; width: 20px; height: 20px;
  border-radius: 6px; border: 1px solid var(--line-strong); background: var(--paper);
  display: grid; place-items: center; font-size: 12px; color: var(--accent); pointer-events: none;
}
.hdu-tidy-bar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 10px; border: 1px solid var(--accent); border-radius: 10px;
  background: var(--accent-soft); margin-bottom: 10px; font-size: 12px;
}
.hdu-heatmap-foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 11px; color: var(--muted); }
.hdu-heatmap-legend { display: inline-flex; align-items: center; gap: 4px; }
.hdu-heatmap-legend i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; background: var(--paper-3); border: 1px solid color-mix(in srgb, var(--line) 55%, transparent); }
.hdu-heatmap-legend i[data-level='1'] { background: color-mix(in srgb, var(--jade) 22%, var(--paper-3)); }
.hdu-heatmap-legend i[data-level='2'] { background: color-mix(in srgb, var(--jade) 45%, var(--paper-3)); }
.hdu-heatmap-legend i[data-level='3'] { background: color-mix(in srgb, var(--jade) 72%, var(--paper-2)); }
.hdu-heatmap-legend i[data-level='4'] { background: var(--jade); border-color: transparent; }

/* ── 第 234 轮巡检新增样式 ────────────────────────────── */
/* 打卡月历卡（第 234 轮）：周行 × 7 列月历格，达标日玉色打勾、有学习未达标淡色、
   今日描边强调；月份导航复用 .hdu-month-label + .hdu-folder 并补 hover/disabled 态 */
.hdu-checkin-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; }
.hdu-checkin-cell {
  min-height: 52px; border: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
  border-radius: 9px; padding: 5px 6px; display: flex; flex-direction: column; gap: 2px;
  background: color-mix(in srgb, var(--paper-2) 40%, transparent);
}
.hdu-checkin-cell.is-out { opacity: .32; background: transparent; }
.hdu-checkin-cell.is-future { visibility: hidden; }
.hdu-checkin-cell.is-partial { background: color-mix(in srgb, var(--paper-3) 72%, transparent); }
.hdu-checkin-cell.is-hit { border-color: color-mix(in srgb, var(--jade) 45%, transparent); background: color-mix(in srgb, var(--jade) 14%, transparent); }
/* 目标线层（第 261 轮，目标域 / 双口径延伸）：达成每日目标的格叠加金色内描边——
   与打卡 ✓ 的 jade 软底叠加可同格并存（金框 + 玉底 = 打卡且达标），gold 与 today
   的 accent outline 色系相邻但语义不同（目标 vs 今天），格内面积错开不易混淆 */
.hdu-checkin-cell.is-goal { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--gold) 60%, transparent); }
.hdu-checkin-legend i.is-goal { background: color-mix(in srgb, var(--gold) 24%, transparent); border-color: color-mix(in srgb, var(--gold) 60%, transparent); }
/* 今日格描边强调（区别于热力图的脉冲动画：月历格是静态查阅视图，用稳定 outline） */
.hdu-checkin-cell.is-today { outline: 2px solid color-mix(in srgb, var(--accent) 65%, transparent); outline-offset: -1px; }
.hdu-checkin-cell.is-today .hdu-checkin-day { color: var(--accent); font-weight: 700; }
.hdu-checkin-day { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; line-height: 1.2; }
.hdu-checkin-sec { font-size: 10px; color: var(--muted); line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hdu-checkin-mark { font-size: 11px; font-weight: 700; color: var(--jade); line-height: 1.25; display: flex; align-items: baseline; gap: 3px; min-width: 0; }
.hdu-checkin-mark .hdu-checkin-sec { color: color-mix(in srgb, var(--jade) 80%, var(--ink)); font-weight: 500; }
.hdu-checkin-cell.is-partial .hdu-checkin-sec { color: var(--ink-soft); }
/* 头部摘要行：本月打卡 X 天 + 达标率徽标（jade pill）+ 累计有效小字 */
.hdu-checkin-summary { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12.5px; color: var(--ink-soft); margin-bottom: 10px; }
.hdu-checkin-summary b { font-size: 15px; color: var(--jade); font-variant-numeric: tabular-nums; }
.hdu-checkin-rate { padding: 2px 10px; border-radius: 999px; font-size: 11.5px; font-weight: 600; color: var(--jade); border: 1px solid color-mix(in srgb, var(--jade) 45%, transparent); background: color-mix(in srgb, var(--jade) 10%, transparent); }
/* 目标达成率徽标（第 265 轮，目标域 / 双口径延伸）：gold 变体与打卡达标率（jade）并排 */
.hdu-checkin-rate.is-goal { color: var(--gold); border-color: color-mix(in srgb, var(--gold) 45%, transparent); background: color-mix(in srgb, var(--gold) 10%, transparent); }
.hdu-checkin-total { font-size: 11px; color: var(--muted); }
.hdu-checkin-legend { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 10px; font-size: 11px; color: var(--muted); }
.hdu-checkin-legend span { display: inline-flex; align-items: center; gap: 5px; }
.hdu-checkin-legend i { width: 12px; height: 12px; border-radius: 4px; display: inline-block; border: 1px solid color-mix(in srgb, var(--line) 70%, transparent); }
.hdu-checkin-legend i.is-hit { background: color-mix(in srgb, var(--jade) 14%, transparent); border-color: color-mix(in srgb, var(--jade) 45%, transparent); }
.hdu-checkin-legend i.is-partial { background: color-mix(in srgb, var(--paper-3) 72%, transparent); }
/* 月份导航 hover 态补齐：.hdu-folder 基类无 hover，这里按打卡月历场景补齐（与
   .hdu-batch-menu .hdu-folder:hover 同手法），disabled 明确降透明度 */
.hdu-checkin-wrap .hdu-month-nav .hdu-folder { min-width: 30px; justify-content: center; padding: 0 9px; }
.hdu-checkin-wrap .hdu-month-nav .hdu-folder:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
.hdu-checkin-wrap .hdu-month-nav .hdu-folder:disabled { opacity: .45; cursor: default; }

/* 每日目标 Ring 卡（第 234 轮）：OverviewView hero 侧 mini 卡内的环行布局；
   达标态环线转 jade（Ring 组件本体无 variant 参数，CSS 覆写最省），文案两态排版 */
.hdu-goal-ring-row { display: flex; align-items: center; gap: 12px; margin-top: 6px; }
.hdu-goal-ring.is-done .hdu-ring-fill { stroke: var(--jade); }
.hdu-goal-ring.is-done .hdu-ring-label { color: var(--jade); }
.hdu-goal-ring-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.hdu-goal-ring-value { font-size: 20px; font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; line-height: 1.15; }
.hdu-goal-ring-value small { font-size: 11px; font-weight: 400; color: var(--muted); margin-left: 3px; }
.hdu-goal-ring-foot { font-size: 11px; color: var(--muted); line-height: 1.5; display: flex; align-items: center; gap: 6px; }
.hdu-goal-ring-foot.is-done { color: var(--jade); }
.hdu-goal-edit { flex: none; width: 22px; height: 22px; padding: 0; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; color: var(--muted); background: transparent; border: 1px solid transparent; }
.hdu-goal-edit:hover { color: var(--accent); border-color: var(--line); background: color-mix(in srgb, var(--accent) 8%, transparent); }

/* 本周目标达成 7 日格（第 256 轮，目标域 / 习惯视角）：今日目标卡下方的周节奏点阵——
   7 格等宽横排（dot + 周几标签竖排），达标 jade 实心、未达标线框空心、未来日更淡、
   今天外圈 accent 描边；foot 一行 tabular-nums 摘要。颜色全走 --* 变量，暗色自动跟随 */
.hdu-goal-week { margin-top: 10px; padding-top: 10px; border-top: 1px dashed color-mix(in srgb, var(--line) 75%, transparent); display: flex; flex-direction: column; gap: 7px; }
.hdu-goal-week-cells { display: flex; gap: 6px; }
.hdu-goal-week-cell { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; }
.hdu-goal-week-dot {
  width: 14px; height: 14px; border-radius: 99px; display: inline-block;
  border: 1.5px solid color-mix(in srgb, var(--muted) 42%, transparent);
  background: transparent; transition: background-color .15s ease, border-color .15s ease;
}
.hdu-goal-week-cell.is-hit .hdu-goal-week-dot { background: var(--jade); border-color: var(--jade); }
.hdu-goal-week-cell.is-future .hdu-goal-week-dot { border-color: color-mix(in srgb, var(--muted) 22%, transparent); }
.hdu-goal-week-cell.is-today .hdu-goal-week-dot { box-shadow: 0 0 0 2.5px color-mix(in srgb, var(--accent) 55%, transparent); }
.hdu-goal-week-label { font-size: 9.5px; color: var(--muted); letter-spacing: .04em; line-height: 1; }
.hdu-goal-week-cell.is-today .hdu-goal-week-label { color: var(--ink); font-weight: 600; }
.hdu-goal-week-foot { font-size: 10.5px; color: var(--muted); font-variant-numeric: tabular-nums; letter-spacing: .02em; }

/* 三步上手引导卡（第 256 轮，引导域 / 冷启动视角）：空态 EmptyState 之下的步骤清单——
   序号圆点（完成转 jade ✓）+ 步骤名 + 一句怎么做；虚线左轨把三步串成路径感。
   学习中心 / 看板全宽版与 popup 窄版（.is-compact）共用一族，颜色走 --* 变量 */
.hdu-onboard-wrap { display: flex; flex-direction: column; gap: 14px; }
.hdu-onboard {
  border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px;
  background: color-mix(in srgb, var(--paper-2) 72%, transparent);
  display: flex; flex-direction: column; gap: 10px;
}
.hdu-onboard-head { display: flex; align-items: center; gap: 8px; }
.hdu-onboard-title { font-family: var(--font-serif); font-size: 14px; font-weight: 600; color: var(--ink); letter-spacing: .02em; }
.hdu-onboard-count {
  font-size: 10.5px; color: var(--jade); background: var(--jade-soft);
  border-radius: 99px; padding: 1px 8px; font-variant-numeric: tabular-nums; letter-spacing: .04em;
}
.hdu-onboard.is-all-done .hdu-onboard-count { background: transparent; border: 1px solid color-mix(in srgb, var(--jade) 45%, transparent); }
.hdu-onboard-sub { font-size: 11px; color: var(--muted); line-height: 1.5; }
.hdu-onboard-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.hdu-onboard-step { position: relative; display: flex; align-items: flex-start; gap: 10px; padding: 7px 0; }
/* 左轨竖虚线：首末行裁段（与里程碑墙 .hdu-milestone-node::before 同款手法） */
.hdu-onboard-step::before {
  content: ""; position: absolute; left: 10px; top: -8px; bottom: -8px;
  border-left: 1.5px dashed color-mix(in srgb, var(--line) 90%, transparent);
}
.hdu-onboard-step:first-child::before { top: 16px; }
.hdu-onboard-step:last-child::before { bottom: calc(100% - 16px); }
.hdu-onboard-step-mark {
  position: relative; z-index: 1; flex: none; width: 21px; height: 21px; border-radius: 99px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums;
  color: var(--muted); border: 1.5px solid color-mix(in srgb, var(--muted) 42%, transparent);
  background: var(--paper-2);
}
.hdu-onboard-step.is-done .hdu-onboard-step-mark { color: var(--jade); border-color: var(--jade); background: var(--jade-soft); }
.hdu-onboard-step-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.hdu-onboard-step-label { font-size: 12.5px; font-weight: 600; color: var(--ink); line-height: 1.3; }
.hdu-onboard-step.is-done .hdu-onboard-step-label { color: color-mix(in srgb, var(--ink) 72%, var(--muted)); }
.hdu-onboard-step-hint { font-size: 11px; color: var(--muted); line-height: 1.55; }
/* 步骤直达动作（第 257 轮，引导域 / 可执行性）：步骤行尾小号按钮——jade 描边空心
   （与复习组搜索徽标同族语言：正向行动色但不与实底徽标混淆），hover 实底加深 */
.hdu-onboard-step-action {
  flex: none; align-self: center; padding: 3px 10px; border-radius: 99px;
  border: 1px solid color-mix(in srgb, var(--jade) 45%, transparent); background: transparent;
  color: var(--jade); font-size: 10.5px; font-weight: 500; letter-spacing: .02em;
  cursor: pointer; transition: background-color .12s ease, color .12s ease;
  white-space: nowrap;
}
.hdu-onboard-step-action:hover { background: var(--jade); color: var(--paper-2); }
.hdu-onboard-step.is-done .hdu-onboard-step-action { opacity: .55; }
/* popup 窄版（372px 弹窗）：压缩留白，步骤 hint 单行截断（title 全文兜底由调用方可加） */
.hdu-onboard.is-compact { padding: 12px 13px; gap: 8px; }
.hdu-onboard.is-compact .hdu-onboard-step { padding: 5px 0; }
.hdu-onboard.is-compact .hdu-onboard-step-hint { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* 卡片页脚插槽（第 319 轮，演示域）：冷启动一键演示行——提示文案 + 行动按钮两端对齐 */
.hdu-onboard-foot { margin-top: 4px; padding-top: 10px; border-top: 1px dashed color-mix(in srgb, var(--muted) 26%, transparent); }
.hdu-onboard-foot-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.hdu-onboard-foot-hint { font-size: 11px; color: var(--muted); line-height: 1.5; min-width: 0; }
/* 演示模式角标（第 319 轮）：琥珀色 accent chip + 退出按钮，三入口页头通用 */
.hdu-demo-badge { display: inline-flex; align-items: center; gap: 4px; }

/* ── 第 235 轮巡检新增样式 ────────────────────────────── */
/* 学习里程碑时间线墙（第 235 轮）：纵向时间轴——左日期、中节点圆点 + 贯通竖线、
   右标题 + 说明；节点按 kind 着色（累计=accent-2 / 连续=jade / 单日=gold /
   打卡=info），行 hover 高亮；颜色全走既有 CSS 变量，暗色随 data-theme 生效 */
.hdu-milestone-list { display: flex; flex-direction: column; }
/* 第 237 轮起行内 button.hdu-milestone-btn 承载原 grid 布局（行 div 退为 listitem +
   hover 底色载体）；hover 235 轮 62% → 82% 加深（全部行可点，提示面更大） */
.hdu-milestone-row { border-radius: 10px; transition: background .13s ease; }
.hdu-milestone-row:hover { background: color-mix(in srgb, var(--paper-3) 82%, transparent); }
.hdu-milestone-date { font-family: var(--font-mono); font-size: 10.5px; color: var(--muted); text-align: right; padding-top: 3px; font-variant-numeric: tabular-nums; white-space: nowrap; }
/* 节点列：圆点居中，::before 画贯通竖线；首行裁上段、末行裁下段，单条不画线 */
.hdu-milestone-node { position: relative; min-height: 32px; display: flex; justify-content: center; align-items: flex-start; }
.hdu-milestone-node::before { content: ""; position: absolute; top: -10px; bottom: -10px; width: 2px; background: color-mix(in srgb, var(--line) 80%, transparent); }
.hdu-milestone-row:first-child .hdu-milestone-node::before { top: 7px; }
.hdu-milestone-row:last-child .hdu-milestone-node::before { bottom: auto; height: 11px; }
.hdu-milestone-row:first-child:last-child .hdu-milestone-node::before { display: none; }
.hdu-milestone-dot {
  position: relative; z-index: 1; width: 11px; height: 11px; margin-top: 4px; border-radius: 99px;
  background: var(--paper-2); border: 2.5px solid var(--accent-2);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-2) 14%, transparent);
}
.hdu-milestone-node.is-streak .hdu-milestone-dot { border-color: var(--jade); box-shadow: 0 0 0 3px color-mix(in srgb, var(--jade) 14%, transparent); }
.hdu-milestone-node.is-daily .hdu-milestone-dot { border-color: var(--gold); box-shadow: 0 0 0 3px color-mix(in srgb, var(--gold) 16%, transparent); }
.hdu-milestone-node.is-checkin .hdu-milestone-dot { border-color: var(--info); box-shadow: 0 0 0 3px color-mix(in srgb, var(--info) 14%, transparent); }
.hdu-milestone-main { min-width: 0; display: flex; flex-direction: column; gap: 1px; padding-top: 1px; }
.hdu-milestone-title { font-size: 12.5px; font-weight: 600; color: var(--ink); line-height: 1.45; }
.hdu-milestone-detail { font-size: 11px; color: var(--muted); line-height: 1.5; }
/* 窄口：日期列收窄、行距收紧（≤600 单列栅格不涉及本卡，独立处理；第 237 轮起
   grid 落在行内 button 上，选择器随之指向 .hdu-milestone-btn） */
@media (max-width: 600px) {
  .hdu-milestone-btn { grid-template-columns: 44px 16px minmax(0, 1fr) auto; padding: 8px 4px; }
  .hdu-milestone-date { font-size: 10px; }
}
/* 周目标连续达成徽标（第 235 轮）：jade 底小徽标（配色口径与 .hdu-checkin-rate 同族）；
   口径说明走 title 悬停，不占卡面；「复制摘要」按钮 loading 态复用既有 .hdu-btn + .hdu-spinner */
.hdu-goal-streak {
  display: inline-flex; align-items: center; gap: 4px; align-self: flex-start;
  padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 600;
  color: var(--jade); border: 1px solid color-mix(in srgb, var(--jade) 45%, transparent);
  background: color-mix(in srgb, var(--jade) 10%, transparent);
}

/* ── 第 236 轮巡检新增样式 ────────────────────────────── */
/* 周目标达成预测行（第 236 轮）：本周目标卡 Progress 下方小字——
   达标态整行 jade；进行中态基础文案中性灰、节奏判断片段按 willHit 两态着色
   （可达成 jade / 预计差 danger）；新周一态走中性灰（不加修饰类） */
.hdu-goal-forecast { margin-top: 7px; font-size: 11px; line-height: 1.5; color: var(--muted); }
.hdu-goal-forecast.is-hit { color: var(--jade); font-weight: 500; }
.hdu-goal-forecast .hdu-goal-forecast-pace { white-space: nowrap; }
.hdu-goal-forecast .hdu-goal-forecast-pace.is-hit { color: var(--jade); font-weight: 600; }
.hdu-goal-forecast .hdu-goal-forecast-pace.is-behind { color: var(--danger); font-weight: 600; }

/* 打卡月历可点击格（第 236 轮）：有学习的格子改 button 语义——重置 UA 默认外观，
   hover 抬升 + 边框加深、active 按压回弹、focus-visible 描边（键盘可达）；
   disabled（补位 / 未来 / 无学习格）保持原视觉，不做点击态 */
.hdu-checkin-grid button.hdu-checkin-cell {
  appearance: none; font: inherit; text-align: left; cursor: pointer;
  transition: transform .12s ease, border-color .12s ease, box-shadow .12s ease, background .12s ease;
}
.hdu-checkin-grid button.hdu-checkin-cell:disabled { cursor: default; }
.hdu-checkin-cell.is-clickable:hover {
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
  transform: translateY(-1px);
  box-shadow: 0 2px 8px color-mix(in srgb, var(--ink) 12%, transparent);
}
.hdu-checkin-cell.is-clickable:hover .hdu-checkin-day { color: var(--ink-soft); }
.hdu-checkin-cell.is-clickable:active { transform: translateY(0); box-shadow: none; }
.hdu-checkin-cell.is-clickable:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

/* 里程碑 foot 行（第 236 轮）：左「共 X 个里程碑」计数、右「复制里程碑」ghost
   小按钮（loading 态复用既有 .hdu-spinner），窄口换行不挤压 */
.hdu-milestone-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
.hdu-milestone-foot .hdu-hint { flex: 1 1 auto; min-width: 0; }

/* ── 第 237 轮巡检新增样式 ────────────────────────────── */
/* 里程碑行可点态（第 237 轮，可用性 / 一致性视角）：行内 button 重置 UA 默认外观并
   承载原 grid 布局（右增「›」指示列），cursor + hover 底色加深（235 轮规则 62%→82%）
   + focus-visible 描边（键盘 Enter / Space 原生触发）+ active 轻按压反馈；
   「›」muted 常驻、hover 转 accent——可点暗示，暗色随 data-theme 生效 */
.hdu-milestone-btn {
  appearance: none; background: none; border: 0; font: inherit; color: inherit;
  width: 100%; text-align: left; cursor: pointer;
  display: grid; grid-template-columns: 52px 18px minmax(0, 1fr) auto; gap: 10px;
  padding: 9px 8px; border-radius: 10px; align-items: stretch;
}
.hdu-milestone-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.hdu-milestone-btn:active .hdu-milestone-main { opacity: .75; }
.hdu-milestone-arrow {
  align-self: center; font-size: 14px; line-height: 1; color: var(--muted); opacity: .8;
  transition: color .13s ease, opacity .13s ease;
}
.hdu-milestone-row:hover .hdu-milestone-arrow { color: var(--accent); opacity: 1; }

/* 今晚补进度模拟行（第 237 轮，目标管理 / 模拟视角）：预测行下 what-if 轻交互——
   「今晚补」label + 小数字输入（spin 按钮隐藏）+ 单位 +「如果今晚学 X 分钟」ghost
   小按钮一行内联排版（11px 小字，与预测行基线一致）；结果区 aria-live 两态着色
   （可达成 jade ✅ / 还差 danger ❌），空态零高度不占位 */
.hdu-goal-sim { margin-top: 7px; font-size: 11px; line-height: 1.5; color: var(--muted); }
.hdu-goal-sim-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.hdu-goal-sim-label { white-space: nowrap; }
.hdu-goal-sim-input {
  width: 56px; padding: 3px 6px; font-size: 11px; text-align: center;
  appearance: textfield; -moz-appearance: textfield;
}
.hdu-goal-sim-input::-webkit-outer-spin-button,
.hdu-goal-sim-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.hdu-goal-sim-unit { white-space: nowrap; }
.hdu-goal-sim-result { margin-top: 5px; }
.hdu-goal-sim-result:empty { display: none; }
.hdu-goal-sim-result.is-hit { color: var(--jade); font-weight: 600; }
.hdu-goal-sim-result.is-behind { color: var(--danger); font-weight: 600; }

/* ───────── 第 238 轮巡检块：每日目标快捷模拟 chips + 学习时段分布卡 ───────── */

/* 每日目标快捷模拟 chips（目标管理 / 模拟视角）：今日目标 Ring 卡 foot 下的固定三档
   what-if——pill 小 chip 一行（.hdu-filter-pill 收小到 24px 高、11px 小字，与 Ring
   foot 文案同一基线网格；间距 6px 同第 237 轮 sim-row），active 选中态沿用
   .hdu-filter-pill.is-active 反白（暗色主题自动跟随）；结果行 aria-live 两态着色
   复用第 237 轮 is-hit jade / is-behind danger 配色，空态零高度不占位 */
.hdu-goal-sim-chips { margin-top: 8px; font-size: 11px; line-height: 1.5; }
.hdu-goal-sim-chip-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.hdu-goal-sim-chip-row .hdu-filter-pill { height: 24px; padding: 0 10px; font-size: 11px; cursor: pointer; flex: none; }
.hdu-goal-sim-chips-result { margin-top: 6px; color: var(--muted); }
.hdu-goal-sim-chips-result:empty { display: none; }
.hdu-goal-sim-chips-result.is-hit { color: var(--jade); font-weight: 600; }
.hdu-goal-sim-chips-result.is-behind { color: var(--danger); font-weight: 600; }

/* 学习时段分布卡（信息 / 自我认知视角）：复用 .hdu-dist-* 分布条家族，四列行
   （窄口 label 40px 两字不换行 / 条形 1fr / 占比 % / 时长），最高桶 is-top 高亮
   （主 accent 条 + label 加深 + accent 百分比）；条形宽度过渡 + hover 微亮，
   时长提示走条形 title（原生 tooltip，免自绘弹层）；foot 洞察文案走既有
   .hdu-hint（与各卡 foot 同风格）。暗色对比由既有 --* 变量整组跟随 */
.hdu-dist-tod { gap: 9px; }
.hdu-dist-tod .hdu-dist-row.is-tod { grid-template-columns: 40px minmax(0, 1fr) 36px 64px; gap: 8px; }
.hdu-dist-tod .hdu-dist-pct { text-align: right; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.hdu-dist-tod .hdu-dist-bar > i { transition: width .25s ease, filter .15s ease; }
.hdu-dist-tod .hdu-dist-bar:hover > i { filter: brightness(1.12); }
.hdu-dist-row.is-top .hdu-dist-bar > i { background: var(--accent); }
.hdu-dist-row.is-top .hdu-dist-name { color: var(--ink); font-weight: 600; }
.hdu-dist-row.is-top .hdu-dist-pct { color: var(--accent); font-weight: 600; }

/* ───────── 第 239 轮巡检块：黄金时段提示行 + 分布卡口径徽标 ───────── */

/* 黄金时段提示行（建议 / 引导视角）：总览今日待办卡下方一行轻提示——在黄金时段
   jade 软底 + 实线描边 + ⏰ 图标（is-now），未到态中性灰 + 虚线描边（「提醒条」
   语义，与 is-now 一眼可辨）；aria-live=polite / role=status 由组件声明。
   间距基线核对：上方承接 .hdu-today（今日待办卡）本轮补的 14px 下间距（顺手打磨：
   待办卡与学习成就条原本 0 间距过挤），与提示行 12px 上间距相邻折叠取 14px；下方
   12px 接学习成就条（与 .hdu-achv-strip 既有 margin-bottom 12px 同档）。无数据
   不渲染（组件返回 null），间距规则不生效、布局回原状。暗色由 --* 变量整组跟随 */
.hdu-today { margin-bottom: 14px; }
.hdu-golden-hint {
  display: flex; align-items: center; gap: 7px;
  margin: 12px 0; padding: 7px 12px;
  border-radius: 10px; border: 1px dashed var(--line);
  font-size: 11.5px; line-height: 1.5; color: var(--muted);
  background: color-mix(in srgb, var(--paper-2) 72%, transparent);
}
.hdu-golden-hint.is-now {
  border-style: solid;
  border-color: color-mix(in srgb, var(--jade) 30%, transparent);
  background: color-mix(in srgb, var(--jade) 9%, transparent);
  color: var(--jade); font-weight: 500;
}
.hdu-golden-hint-icon { flex: none; font-size: 13px; line-height: 1; }
.hdu-golden-hint-text { min-width: 0; }

/* 本周亮点标杆行（第 250 轮巡检，激励域 / 榜样视角）：黄金时段提示行的同族兄弟行。
   间距走相邻折叠：本行 margin-top 0——黄金行在时与其 margin-bottom 12px 成组（折叠
   取 12px），黄金行缺位（不达门槛不渲染）时承接 .hdu-today 的 margin-bottom 14px；
   下 12px 与黄金行上间距同档接学习成就条。无亮点不渲染（组件返回 null），间距
   规则不生效、布局回原状。
   语言对齐 .hdu-golden-hint 家族（同圆角 / 同字号 / 同虚线基座）但区分度走 gold：
   jade 软底换更淡的 jade 7% + --gold 点缀图标（标杆=值得庆祝，区别于黄金时段行的
   纯 jade「建议」语义）。文案换行策略 overflow-wrap: anywhere（长文案在小屏容器内
   不断行溢出），min-width:0 让 flex 子项可收缩换行 */
.hdu-weekly-highlight {
  display: flex; align-items: flex-start; gap: 7px;
  margin: 0 0 12px; padding: 7px 12px;
  border-radius: 10px; border: 1px dashed color-mix(in srgb, var(--jade) 26%, transparent);
  font-size: 11.5px; line-height: 1.5; color: var(--jade); font-weight: 500;
  background: color-mix(in srgb, var(--jade) 7%, transparent);
}
.hdu-weekly-highlight-icon { flex: none; font-size: 12px; line-height: 1.3; color: var(--gold); }
.hdu-weekly-highlight-text { min-width: 0; overflow-wrap: anywhere; }

/* 近 4 周亮点回看展开区（第 251 轮巡检，激励域 / 回顾延续视角）：主行 flex-wrap 后
   的全宽子块——flex: 1 0 100% 让展开区独占一行并落入同一 jade 软底盒内（与主行的
   视觉从属：左侧 1.5px jade 细线 + 10px 左缩进 = 引用块语言，一眼读出「这是主行
   的展开细节」）；展开态 is-expanded 顺便松开 align-items 顶对齐的行尾按钮基线。
   行节奏：6px 行距（半档，密而有序——比 .hdu-list 的 8px 紧半档，回看列表轻量）；
   周标签列 muted 10.5px 等宽数字（tabular-nums，'11-16–11-22' 型区间不跳宽）、
   固定 86px 宽保证多行文案列对齐；文案 min-width:0 可收缩换行；本周行「本周」
   徽标 jade 10px pill（.hdu-caliber-tag 家族同款 pill 语言、取 jade 淡档区分
   「进行中」语义）；空态句 muted 11px 居中。全走 --* 变量，暗色自动跟随 */
.hdu-weekly-highlight.is-expanded { align-items: flex-start; }
.hdu-weekly-history {
  flex: 1 0 100%;
  margin-top: 8px; padding: 2px 0 2px 10px;
  border-left: 1.5px solid color-mix(in srgb, var(--jade) 45%, transparent);
  display: flex; flex-direction: column; gap: 6px;
}
.hdu-weekly-history-row { display: flex; align-items: baseline; gap: 8px; }
.hdu-weekly-history-label {
  flex: none; width: 86px; font-size: 10.5px; color: var(--muted);
  font-variant-numeric: tabular-nums; letter-spacing: .01em;
}
.hdu-weekly-history-text { min-width: 0; flex: 1 1 auto; font-size: 11.5px; line-height: 1.5; color: var(--ink); overflow-wrap: anywhere; }
.hdu-weekly-history-badge {
  flex: none; padding: 0 7px; border-radius: 999px;
  background: color-mix(in srgb, var(--jade) 16%, transparent); color: var(--jade);
  font-size: 10px; line-height: 16px; font-weight: 600; white-space: nowrap;
}
.hdu-weekly-history-empty { font-size: 11px; color: var(--muted); text-align: center; padding: 4px 0; }
.hdu-weekly-history-toggle {
  flex: none; margin-left: auto; display: inline-flex; align-items: center; gap: 3px;
  border: 0; background: transparent; padding: 2px 4px; border-radius: 6px;
  font: inherit; font-size: 11px; color: var(--muted); cursor: pointer;
  transition: color .15s, background .15s;
}
.hdu-weekly-history-toggle:hover { color: var(--ink); background: color-mix(in srgb, var(--jade) 10%, transparent); }
.hdu-weekly-history-toggle .hdu-weekly-history-caret { display: inline-flex; transition: transform .18s ease; }
.hdu-weekly-history-toggle[aria-expanded='true'] .hdu-weekly-history-caret { transform: rotate(180deg); }
.hdu-root .hdu-weekly-history-toggle:focus-visible { outline: 2px solid var(--jade); outline-offset: 1px; }

/* 分布卡口径 hint 行（一致性视角，第 239 轮）：统一 .hdu-hint 基座（11px /
   line-height 1.6 / --muted，与各卡 foot 同源同字号同颜色）+ 「口径」muted 徽标
   （.hdu-caliber-tag：10px pill、--paper-3 软底，.hdu-time-badge 家族同款但更轻）
   + flex 顶对齐（口径文案换行时徽标不悬空）。四张分布卡（学习时段 / 课程分布 /
   热力图 / 打卡月历）同一句式「口径 | 站内/站外 · 窗口 · 归桶/打卡线」同一观感，
   多卡 hint 行高 / 字号 / 颜色由此规则单点约束；暗色随变量自动生效 */
.hdu-caliber-hint { display: flex; align-items: flex-start; gap: 6px; }
.hdu-caliber-tag {
  flex: none; margin-top: 1px; padding: 0 6px; border-radius: 999px;
  background: var(--paper-3); color: var(--muted);
  font-size: 10px; line-height: 16px; white-space: nowrap;
}

/* ───────── 第 240 轮巡检块：复习日历格直达清单 + 笔记统计小卡 + 速查清单分组 ───────── */

/* 月历格头可点（第 240 轮巡检）：有到期作业的格头日期变按钮——透明基座保证
   未 hover 时与不可点格观感一致；hover 抬升 + accent 软底描边（对齐第 236 轮
   月历格可点态视觉语言）；focus-visible 双环供键盘可达（全局 focus 样式不覆盖
   shadow 内新类，这里显式声明） */
.hdu-month-cell-btn {
  display: flex; align-items: center; justify-content: space-between; width: 100%;
  padding: 1px 2px; margin: -1px -2px; border: 1px solid transparent; border-radius: 7px;
  background: transparent; color: inherit; font: inherit; cursor: pointer;
  transition: border-color .15s, background .15s, transform .15s;
}
.hdu-month-cell-btn:hover { border-color: color-mix(in srgb, var(--accent) 55%, transparent); background: color-mix(in srgb, var(--accent) 8%, transparent); transform: translateY(-1px); }
.hdu-root .hdu-month-cell-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

/* 选中日期格（第 240 轮巡检）：is-selected 描边 + 软底，与 today 描边层进
   （选中实线 accent > 今天 55% accent > 普通 line）；月历格与周历列共用 .hdu-week-day */
.hdu-week-day.is-selected { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }

/* 清除日期过滤 chip（第 240 轮巡检）：日期过滤定位标 pill——danger 淡底示意
   「过滤生效中」，× 清除钮 hover 反白加深；与 .hdu-snapshot-chip 同族但取 danger 淡档 */
.hdu-day-filter-chip {
  display: inline-flex; align-items: center; gap: 6px; padding: 4px 6px 4px 10px;
  border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent); border-radius: 999px;
  background: color-mix(in srgb, var(--danger) 8%, transparent);
  font-size: 11.5px; color: var(--ink);
}
.hdu-day-filter-clear {
  flex: none; width: 16px; height: 16px; padding: 0; border: 0; border-radius: 999px;
  background: color-mix(in srgb, var(--danger) 18%, transparent); color: var(--danger);
  font-size: 12px; line-height: 16px; cursor: pointer; text-align: center;
  transition: background .15s, color .15s;
}
.hdu-day-filter-clear:hover { background: var(--danger); color: #fff; }
.hdu-root .hdu-day-filter-clear:focus-visible { outline: 2px solid var(--danger); outline-offset: 1px; }

/* 按日过滤命中行（第 240 轮巡检）：列表行 accent 左细条 + 淡底，与既有
   is-today-due / is-overdue 左边框着色语言同族（不着色到期状态，只标「定位目标」） */
.hdu-todo-row.is-day-target { background: color-mix(in srgb, var(--accent) 6%, transparent); box-shadow: inset 3px 0 0 color-mix(in srgb, var(--accent) 55%, transparent); }

/* 笔记统计小卡（第 240 轮巡检）：指标 pill 行（与复习统计条同骨架）+ 课程 Top3
   （序号徽标 + 课程名截断 + 计数右对齐的三列网格）+ foot 链接 hover 下划线偏移 */
.hdu-notestat-metrics { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.hdu-notestat-metric { display: inline-flex; align-items: baseline; gap: 5px; font-size: 11.5px; color: var(--muted); border: 1px solid color-mix(in srgb, var(--line) 70%, transparent); border-radius: 999px; padding: 4px 10px; }
.hdu-notestat-metric b { font-size: 13px; color: var(--ink); font-variant-numeric: tabular-nums; }
.hdu-notestat-metric.is-recent b { color: var(--jade); }
.hdu-notestat-top { display: flex; flex-direction: column; gap: 6px; }
.hdu-notestat-row { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 5px 8px; border: 1px solid color-mix(in srgb, var(--line) 62%, transparent); border-radius: 8px; background: var(--paper-2); }
.hdu-notestat-rank { flex: none; width: 18px; height: 18px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); font-size: 10.5px; font-weight: 600; line-height: 18px; text-align: center; font-variant-numeric: tabular-nums; }
.hdu-notestat-name { min-width: 0; font-size: 12px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hdu-notestat-count { font-size: 12px; font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; text-align: right; }
.hdu-notestat-foot { margin-top: 10px; }
.hdu-notestat-link { border: 0; background: transparent; padding: 0; font: inherit; font-size: 11.5px; color: var(--accent); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; text-decoration-color: color-mix(in srgb, var(--accent) 45%, transparent); transition: text-underline-offset .15s, text-decoration-color .15s; }
.hdu-notestat-link:hover { text-underline-offset: 4px; text-decoration-color: var(--accent); }
.hdu-root .hdu-notestat-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }

/* 速查浮层分组（第 240 轮巡检）：组标题小字 muted + 每行作用域副行（flex 顶对齐，
   scope 换行不挤压键帽）；键帽沿用行内既有 kbd 内联样式，暗色随变量跟随 */
.hdu-shortcut-group-title { font-size: 10.5px; color: var(--muted); font-weight: 600; letter-spacing: .02em; margin-bottom: 2px; }
.hdu-shortcut-row { display: flex; align-items: flex-start; gap: 10px; }
.hdu-shortcut-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; font-size: 12.5px; color: var(--ink); }
.hdu-shortcut-scope { font-size: 10.5px; color: var(--muted); }

@keyframes hdu-spin { to { transform: rotate(360deg); } }
@keyframes hdu-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes hdu-rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes hdu-shimmer { to { background-position: -200% 0; } }
/* 减动效全局兜底（第 97 轮起，第 252 轮视图过渡审计补强）：
   - 降时长到 .001ms（原有）：hdu-rise / hdu-fade-in / celebrate-in 等一次性动画
     立即到达终态，视觉等价于无动画；
   - animation-iteration-count: 1（第 252 轮新增）：无限循环动画（hdu-shimmer 骨架 /
     hdu-spin 转圈 / hdu-today-pulse 今日格脉冲）在降时长后若仍 infinite，会以每毫秒
     千次的频率空转烧 CPU——一并收敛到单次；
   - transition-delay: 0ms（第 252 轮新增，与 bili-styles 同口径对齐）：FAB 展开等
     带延迟的过渡在减动效下不再空等延迟。
   Shadow DOM 下 media query 随宿主文档生效（核实：styles 注入 shadow root 内，
   @media 按顶层文档媒体特性求值，prefers-reduced-motion 有效） */
@media (prefers-reduced-motion: reduce) {
  .hdu-root *, .hdu-root *::before, .hdu-root *::after {
    animation-duration: .001ms !important;
    transition-duration: .001ms !important;
    animation-iteration-count: 1 !important;
    transition-delay: 0ms !important;
  }
}

/* ───────── 第 242 轮巡检块：目标合理性提示 + 预测图口径标注 ───────── */

/* 目标合理性提示行（防呆视角，options 学习目标分区）：软提示不阻断保存——
   两档语义着色：偏低 gold（建议性「可以更大胆」）/ 偏高 danger 淡色（警惕性
   「几乎达不到」），均取 color-mix 淡底 + 同色系文字（--gold / --danger 变量
   暗色自动跟随）；焦点微交互：两个目标输入框（提示行的前 1 / 前 2 个兄弟行内）
   任一聚焦时提示行透明度抬升（:has 精确关联，不因同卡其他输入误触发）；
   窄口换行：行高 1.6 自由换行，徽标 flex 顶对齐不悬空 */
.hdu-goal-hint {
  display: flex; align-items: flex-start; gap: 7px;
  margin: 6px 0 2px; padding: 7px 11px; border-radius: 8px;
  font-size: 11px; line-height: 1.6;
  border: 1px solid transparent;
  opacity: .78; transition: opacity .18s ease;
}
.hdu-options-row:has(.hdu-input:focus) + .hdu-goal-hint,
.hdu-options-row:has(.hdu-input:focus) + .hdu-options-row + .hdu-goal-hint { opacity: 1; }
.hdu-goal-hint::before { content: '⚑'; flex: none; font-size: 11px; line-height: 1.6; }
.hdu-goal-hint.is-low {
  color: var(--gold);
  background: color-mix(in srgb, var(--gold) 9%, transparent);
  border-color: color-mix(in srgb, var(--gold) 30%, transparent);
}
.hdu-goal-hint.is-high {
  color: var(--danger);
  background: var(--danger-soft);
  border-color: color-mix(in srgb, var(--danger) 32%, transparent);
}
@media (max-width: 600px) {
  .hdu-goal-hint { padding: 6px 9px; font-size: 10.5px; }
}

/* 预测图「同口径」标注行（复习计划视图）：复用第 239 轮 .hdu-caliber-hint 句式
   （「口径」pill + muted 说明文字），间距收口——图底标注统一 margin-top 6px /
   margin-bottom 2px，与上方柱图（.hdu-review-forecast）及下方类型筛选行的
   10px 间距形成「图 6 / 筛选 10」的呼吸层次；窄口下说明文字允许换行（flex 顶对齐
   徽标不悬空，继承 .hdu-caliber-hint） */
.hdu-forecast-caliber { margin-top: 6px; margin-bottom: 2px; }

@media (max-width: 1080px) {
  .hdu-rail { width: 196px; flex-basis: 196px; }
  .hdu-content-inner { padding: 24px 24px 72px; }
  .hdu-topbar { padding: 12px 24px; }
  .hdu-stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .hdu-hero { grid-template-columns: 1fr; }
  .hdu-hero-side { flex-direction: row; }
  .hdu-mini-card { flex: 1; }
}
/* ───────── 第 244 轮巡检样式块（全走 --* 变量，暗色随 .hdu-root[data-theme="dark"] 自动跟随） ───────── */
/* 顺延到指定日 · 快捷日期 chips 网格（改期弹层 / 行内浮层 / 批量弹层三处共用）：
   两行 chip（主行 label + 副行 M月D日 周X muted 小字 tabular-nums），交互三件套
   （hover 软底 / :focus-visible 描边 / is-active 选中）与周历条 .hdu-week-col 同构 */
.hdu-resched-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 6px; }
.hdu-resched-chip { display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 6px 4px 5px; border: 1px solid color-mix(in srgb, var(--line) 70%, transparent); border-radius: 9px; background: transparent; cursor: pointer; font-family: inherit; transition: border-color .15s, background .15s; }
.hdu-resched-chip:hover:not(:disabled) { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
.hdu-root .hdu-resched-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.hdu-resched-chip.is-active { background: color-mix(in srgb, var(--accent) 12%, transparent); border-color: var(--accent); }
.hdu-resched-chip.is-active .hdu-resched-chip-label { color: var(--accent); }
.hdu-resched-chip:disabled { opacity: .5; cursor: default; }
.hdu-resched-chip-label { font-size: 12px; font-weight: 600; color: var(--ink); line-height: 1.3; white-space: nowrap; }
.hdu-resched-chip-date { font-size: 10px; color: var(--muted); font-variant-numeric: tabular-nums; line-height: 1.3; white-space: nowrap; }
/* 行内顺延浮层（列表行「改期」展开）：标题行 + chips 网格 + 底部「其他日期…」与口径提示；
   软底浅面板与筛选快照行同族，出现在行详情位不挤占操作列基线 */
.hdu-resched-pop { margin-top: 8px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--line) 85%, transparent); border-radius: 10px; background: color-mix(in srgb, var(--paper-2) 82%, transparent); display: flex; flex-direction: column; gap: 8px; }
.hdu-resched-pop-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.hdu-resched-pop-title { font-size: 11.5px; font-weight: 600; color: var(--ink-soft); }
.hdu-resched-pop-close { border: none; background: transparent; color: var(--muted); font-size: 14px; line-height: 1; padding: 2px 6px; cursor: pointer; border-radius: 6px; transition: color .15s, background .15s; }
.hdu-resched-pop-close:hover { color: var(--danger); background: color-mix(in srgb, var(--danger) 10%, transparent); }
.hdu-root .hdu-resched-pop-close:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.hdu-resched-pop-foot { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.hdu-resched-pop-foot .hdu-hint { font-size: 10.5px; opacity: .85; }
/* B 站学习中心面板 foot 对齐说明（第 248 轮巡检，B 站对齐收官）：虚线分隔的脚注行，
   与 .hdu-resched-pop 软底浅面板族同克制度——虚线上边界隔离正文内容、hint 字号不抢焦点 */
.hdu-hub-foot-note { margin-top: 14px; padding-top: 10px; border-top: 1px dashed color-mix(in srgb, var(--line) 90%, transparent); font-size: 11px; color: var(--muted); line-height: 1.7; }
.hdu-hub-foot-note b { color: var(--ink-soft); font-weight: 600; }
/* 弹窗容器焦点态（第 248 轮巡检，无障碍域伴随样式核对）：Modal 打开时焦点程序化
   移入容器（tabIndex=-1，aria-labelledby 播报标题）；键盘流下浏览器可能给整框画出
   :focus-visible outline——容器本身不是 Tab 停靠点（Tab 由 trapTab 在内部按钮间圈闭），
   去掉容器 outline，避免「一个大框套住整个弹窗」的噪音；内部按钮的 :focus-visible
   （.hdu-root :focus-visible 全局规则）不受影响 */
.hdu-root .hdu-modal:focus { outline: none; }
/* 知识库卡片头部防溢出（第 244 轮复习状态徽标后头部 chip 至多 6 枚）：可折行不挤占主行 */
.hdu-knowledge-head { flex-wrap: wrap; row-gap: 4px; }
/* 总览近 7 天折叠卡（第 244 轮首屏密度审计）：标题行 = 整行按钮，摘要分钟数
   tabular-nums 右对齐；chevron 开合旋转过渡（收起 -90° 指右，展开回正） */
.hdu-overview-week.hdu-card.pad { padding: 14px 18px; }
.hdu-overview-week-head { display: flex; align-items: center; gap: 7px; width: 100%; border: none; background: transparent; cursor: pointer; font-family: inherit; padding: 2px 4px; margin: -2px -4px; border-radius: 8px; transition: background .15s; }
.hdu-overview-week-head:hover { background: color-mix(in srgb, var(--accent) 7%, transparent); }
.hdu-root .hdu-overview-week-head:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.hdu-overview-week-caret { display: inline-flex; color: var(--muted); transition: transform .2s ease; transform: rotate(-90deg); }
.hdu-overview-week-head.is-open .hdu-overview-week-caret { transform: rotate(0deg); }
.hdu-overview-week-title { font-size: 14px; font-weight: 600; color: var(--ink); }
.hdu-overview-week-sum { margin-left: auto; font-size: 12.5px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
/* 窄窗口搜索下拉（≤960）：真实 Chrome 168 组窗口矩阵实测——
   821–940px 区间下拉锚自身（right:0 + width:400px）会向左溢出 .hdu-main 的
   overflow:hidden，出现 6–84px 的左裁切带；960–1080px 区间 right:0 干净、≥1081 不触发。
   因此这两条规则独立成 ≤960 块（原来放在 ≤820 块内，821–940 无覆盖，是 P0 裁切的根因）：
   拉平搜索框容器的定位基准，让下拉改锚整个顶栏（topbar 已显式 position:relative），
   横向铺满顶栏内容区，任何搜索框位置下都不越界。 */
@media (max-width: 960px) {
  .hdu-topbar-search { position: static; }
  .hdu-search-pop { left: 16px; right: 16px; width: auto; }
}
@media (max-width: 820px) {
  .hdu-center { flex-direction: column; }
  .hdu-rail { width: 100%; flex: 0 0 auto; flex-direction: row; align-items: center; gap: 12px; padding: 10px 14px; border-right: 0; border-bottom: 1px solid var(--line); overflow-x: auto; }
  .hdu-brand { padding: 0; flex: 0 0 auto; }
  .hdu-brand-sub { display: none; }
  .hdu-nav { flex-direction: row; gap: 2px; }
  .hdu-nav-label { display: none; }
  .hdu-nav-item { width: auto; padding: 8px 10px; white-space: nowrap; }
  .hdu-nav-count { display: none; }
  .hdu-rail-foot { display: none; }
  .hdu-topbar { min-height: 54px; padding: 8px 16px; }
  .hdu-content-inner { padding: 18px 16px 70px; }
  .hdu-grid.g3, .hdu-grid.g4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .hdu-panel { top: 10px; right: 10px; bottom: 76px; width: calc(100vw - 20px); }
  .hdu-week { grid-template-columns: 42px repeat(7, minmax(0, 1fr)); }
}
@media (max-width: 600px) {
  /* stat-hero 已由上方 auto-fit 自然收编，≤600 仍强制单列（手机全宽更整洁，也避免 2+1 孤行） */
  .hdu-grid.g2, .hdu-grid.g3, .hdu-grid.g4, .hdu-stat-grid, .hdu-stat-hero { grid-template-columns: 1fr; }
  .hdu-course-grid, .hdu-knowledge-grid { grid-template-columns: 1fr; }
  .hdu-hero-side { flex-direction: column; }
  .hdu-dock { right: 10px; bottom: 10px; }
}

/* ───────── 第 252 轮巡检块：学习中心视图切换 fade 微过渡 ───────── */

/* 视图切换 fade-only 微过渡（视图域 / 体验视角，审计落地）：六视图切换此前为
   三元链直切无过渡；.hdu-content-inner 由 LearningCenter 以 key={view} 随切换
   重挂载，本类随挂载播一次 hdu-fade-in（opacity-only，不用 transform 大动效）。
   - 首挂载不播动画：类由组件在首次视图切换后才加上（viewFadeOn），面板打开首帧
     不闪；本规则只描述「切换后的挂载」如何淡入；
   - 时长 .18s（介于 hdu-fade-in .15s 与 .22s 用例之间的轻量档），ease-out 收尾；
   - prefers-reduced-motion: reduce 由文末全局兜底块覆盖（.hdu-root * 降时长 +
     单次迭代），无需在此重复——这也是全仓统一 reduce 块「一处覆盖」的约定。 */
.hdu-view-fade { animation: hdu-fade-in .18s ease-out; }
`;
