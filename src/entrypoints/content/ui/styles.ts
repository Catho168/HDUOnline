/** Shadow DOM 内的完整样式表。所有类名带 hdu- 前缀，不使用站点变量。 */

export const UI_CSS = String.raw`
:host {
  all: initial;
}
*, *::before, *::after { box-sizing: border-box; }
.hdu-root {
  --ink: #171a1d;
  --ink-soft: #474d52;
  --muted: #7b7f82;
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
  --muted: #8c877c;
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
.hdu-root button, .hdu-root input, .hdu-root textarea, .hdu-root select { font: inherit; color: inherit; }
.hdu-root button { border: 0; background: transparent; cursor: pointer; }
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
  font-size: 13.5px; text-align: left; transition: background .15s ease, color .15s ease, transform .15s ease;
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
.hdu-btn.accent { background: var(--accent); border-color: var(--accent); color: #fff9f1; }
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
.hdu-ring-fill { fill: none; stroke: var(--accent-2); stroke-width: 5; stroke-linecap: round; transition: stroke-dashoffset .5s ease; }
.hdu-ring-label { font-family: var(--font-serif); font-size: 16px; font-variant-numeric: tabular-nums; }
.hdu-hero-side { display: flex; flex-direction: column; gap: 12px; }
.hdu-mini-card { padding: 16px 18px; border-radius: 18px; border: 1px solid var(--line); background: color-mix(in srgb, var(--paper-2) 78%, transparent); display: flex; flex-direction: column; gap: 6px; }
.hdu-mini-label { font-size: 11px; color: var(--muted); letter-spacing: .04em; }
.hdu-mini-value { font-family: var(--font-serif); font-size: 25px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.1; }
.hdu-mini-value small { font-family: var(--font-sans); font-size: 11px; color: var(--muted); font-weight: 400; margin-left: 5px; }
.hdu-mini-foot { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--muted); }

.hdu-stat-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.hdu-stat { padding: 16px 17px; border-radius: 16px; border: 1px solid var(--line); background: color-mix(in srgb, var(--paper-2) 72%, transparent); }
.hdu-stat-top { display: flex; align-items: center; gap: 7px; color: var(--muted); font-size: 11.5px; }
.hdu-stat-top svg { width: 14px; height: 14px; }
.hdu-stat-value { margin-top: 9px; font-family: var(--font-serif); font-size: 26px; font-weight: 600; line-height: 1.1; font-variant-numeric: tabular-nums; }
.hdu-stat-value small { font-family: var(--font-sans); font-size: 11px; color: var(--muted); font-weight: 400; margin-left: 4px; }
.hdu-stat-foot { margin-top: 5px; font-size: 11px; color: var(--muted); }

.hdu-bars { display: flex; align-items: flex-end; gap: 8px; height: 132px; padding-top: 8px; }
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
.hdu-course-foot { margin-top: auto; display: flex; align-items: center; gap: 8px; }
.hdu-session-list { border-top: 1px solid var(--line); padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 2px; max-height: 280px; overflow: auto; }
.hdu-session-row { display: flex; align-items: center; gap: 9px; padding: 8px 9px; border-radius: 9px; transition: background .13s; text-align: left; width: 100%; }
.hdu-session-row:hover { background: var(--paper-3); }
.hdu-session-row.is-current { background: var(--accent-soft); }
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

/* ───────── 知识库 ───────── */
.hdu-filterbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
.hdu-input, .hdu-textarea, .hdu-select {
  border: 1px solid var(--line); border-radius: 10px; background: var(--paper-2);
  padding: 8px 11px; font-size: 12.5px; color: var(--ink); outline: none; transition: border-color .15s, box-shadow .15s;
}
.hdu-input:focus, .hdu-textarea:focus, .hdu-select:focus { border-color: var(--accent-2); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-2) 16%, transparent); }
.hdu-input::placeholder, .hdu-textarea::placeholder { color: var(--muted); }
.hdu-search { display: flex; align-items: center; gap: 7px; min-width: 220px; flex: 1; max-width: 360px; border: 1px solid var(--line); border-radius: 11px; background: var(--paper-2); padding: 0 10px; height: 34px; }
.hdu-search svg { width: 15px; height: 15px; color: var(--muted); flex: 0 0 auto; }
.hdu-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; font-size: 12.5px; }
.hdu-filter-pill { height: 29px; padding: 0 11px; border-radius: 99px; border: 1px solid var(--line); background: transparent; font-size: 11.5px; color: var(--muted); transition: all .15s; }
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
.hdu-folder { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 11px; border-radius: 9px; border: 1px solid var(--line); background: color-mix(in srgb, var(--paper-2) 65%, transparent); font-size: 11.5px; color: var(--ink-soft); white-space: nowrap; }
.hdu-folder.is-active { border-color: var(--ink); background: var(--ink); color: var(--paper-2); }

/* ───────── 统计 ───────── */
.hdu-stat-hero { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
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
.hdu-dock-mark { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; background: var(--ink); color: var(--paper-2); font-family: var(--font-serif); font-size: 16px; }

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
.hdu-panel.is-collapsed { width: 58px; bottom: auto; height: 58px; border-radius: 16px; cursor: pointer; }
.hdu-panel.is-collapsed .hdu-panel-collapsed-inner { display: flex; }
.hdu-panel.is-collapsed .hdu-panel-full { display: none; }
.hdu-panel-collapsed-inner { display: none; width: 100%; height: 100%; align-items: center; justify-content: center; position: relative; background: var(--ink); color: var(--paper-2); }
.hdu-panel-collapsed-inner svg { width: 19px; height: 19px; }
.hdu-panel-collapsed-dot { position: absolute; top: 12px; right: 12px; width: 6px; height: 6px; border-radius: 99px; background: var(--accent-2); }
.hdu-panel-full { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.hdu-panel-head { padding: 15px 16px 12px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 9px; }
.hdu-panel-head-top { display: flex; align-items: flex-start; gap: 9px; }
.hdu-panel-session { flex: 1; min-width: 0; }
.hdu-panel-course { font-family: var(--font-serif); font-size: 15.5px; font-weight: 600; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hdu-panel-cour { font-size: 10.5px; color: var(--muted); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hdu-panel-head-actions { display: flex; gap: 2px; flex: 0 0 auto; }
.hdu-panel-status { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
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

.hdu-panel-topline { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid color-mix(in srgb, var(--line) 70%, transparent); font-size: 11.5px; color: var(--muted); }
.hdu-panel-topline b { color: var(--ink-soft); font-weight: 500; }

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
.hdu-caption.is-hidden { opacity: 0; }

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

.hdu-toast-stack { position: fixed; right: 20px; bottom: 82px; z-index: 2147483002; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; pointer-events: none; }
.hdu-toast { display: flex; align-items: flex-start; gap: 8px; max-width: 360px; padding: 10px 13px; border-radius: 12px; border: 1px solid var(--line); background: var(--paper-2); box-shadow: var(--shadow); font-size: 12px; color: var(--ink-soft); animation: hdu-rise .2s ease-out; pointer-events: auto; }
.hdu-toast.error { border-color: color-mix(in srgb, var(--danger) 35%, var(--line)); }
.hdu-toast .hdu-toast-icon { width: 15px; height: 15px; flex: 0 0 auto; margin-top: 1px; color: var(--jade); }
.hdu-toast.error .hdu-toast-icon { color: var(--danger); }

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
.hdu-error-text { font-size: 11.5px; color: var(--danger); line-height: 1.6; }

.hdu-pill-tabs { display: inline-flex; gap: 2px; padding: 3px; border-radius: 10px; background: var(--paper-3); }
.hdu-pill-tab { height: 27px; padding: 0 10px; border-radius: 7px; font-size: 11.5px; color: var(--muted); }
.hdu-pill-tab.is-active { background: var(--paper-2); color: var(--ink); box-shadow: 0 1px 2px rgba(0,0,0,.06); }

.hdu-scroll-x { overflow-x: auto; scrollbar-width: none; }
.hdu-scroll-x::-webkit-scrollbar { display: none; }

@keyframes hdu-spin { to { transform: rotate(360deg); } }
@keyframes hdu-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes hdu-rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes hdu-shimmer { to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) {
  .hdu-root *, .hdu-root *::before, .hdu-root *::after { animation-duration: .001ms !important; transition-duration: .001ms !important; }
}

@media (max-width: 1080px) {
  .hdu-rail { width: 196px; flex-basis: 196px; }
  .hdu-content-inner { padding: 24px 24px 72px; }
  .hdu-topbar { padding: 12px 24px; }
  .hdu-stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .hdu-hero { grid-template-columns: 1fr; }
  .hdu-hero-side { flex-direction: row; }
  .hdu-mini-card { flex: 1; }
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
  .hdu-grid.g2, .hdu-grid.g3, .hdu-grid.g4, .hdu-stat-grid, .hdu-stat-hero { grid-template-columns: 1fr; }
  .hdu-course-grid, .hdu-knowledge-grid { grid-template-columns: 1fr; }
  .hdu-hero-side { flex-direction: column; }
  .hdu-dock { right: 10px; bottom: 10px; }
}
`;
