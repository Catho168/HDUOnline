/**
 * B 站字幕查看浮层 —— B 站内容脚本与学习中心（HDU 侧 Shadow UI）共用的同一实现
 * （第 15 轮提取共享：两处引用本文件，不复制组件）。
 *
 *  - 数据：transcript.get 读 `bili:<bvid>`（P1 裸键）或 `bili:<bvid>:p<N>`（p≥2 分 P 键，
 *    第 16 轮多 P 支持）转写 → 时间 + 文本列表（两处上下文都能经 callOp → SW RPC 读取）；
 *  - 当前行高亮（第 16 轮包 B）：宿主传入 currentTime（B 站侧从 video timeupdate 节流
 *    传入）时，s<=t<e 的行加 is-current 视觉高亮；刻意不自动滚动（避免干扰阅读，真机
 *    观察项）；LearningCenter 宿主不传 currentTime 则无高亮；
 *  - AI 字幕标记（第 16 轮包 B）：transcript.aiSubtitle（bili.subtitle.fetch 落库写入）
 *    为 true 时头部显示「AI 生成」小标记。
 *  - 字幕搜索（第 24 轮功能扩展第一批）：列表上方搜索框按关键词过滤当前 mediaKey 的
 *    段落（filterTranscriptSegments 前端过滤，段数量级无需动用 transcript.search RPC），
 *    命中行仍是「时间戳 + 文本」，点击走同一 seek 机制（page/external 两模式通用）；
 *    无命中给友好空态，不影响无查询时的完整列表与高亮。
 *  - 行点击（seekMode，缺省 'page'）：
 *    · 'page'（B 站内容脚本）：页内优先直接设 <video>.currentTime（与「续看」chip 同路径，
 *      不整页刷新）；无 <video> 元素时回退 `?t=<sec>` URL 跳转（与统一搜索续看链接的
 *      withTimeParam 拼接口径一致，shared/utils 单份实现）；
 *    · 'external'（学习中心）：HDU 页内即使有 <video> 也是站内播放器、与 B 站视频无关，
 *      一律新标签打开 B 站 `?t=<sec>` 外链，落到字幕时间点。
 *  - Escape/Tab 归属（第 37 轮巡检接入、第 39 轮巡检统一派发 + Tab 圈闭）：打开期间
 *    登记进 components.tsx 的共享顶层归属栈，按 Esc 只关本浮层、不穿透关闭外层宿主
 *    面板；Tab 圈闭在本浮层内（详见 effect 处注释）。
 *  - 样式：组件自带一份作用域限定在 `.bili-sub-scope` 的样式（B 站侧 BILI_CSS 与
 *    学习中心侧 styles.ts 都不含 .bili-sub-* 行区样式），两处渲染效果一致，是唯一样式来源；
 *    暗色跟随宿主：`.bili-root[data-theme="dark"]`（B 站）与 `.hdu-root[data-theme="dark"]`
 *    （学习中心）祖先选择器自动生效，也可用 dark prop 显式指定。
 * 问答面板在 B 站侧由独立的 BiliQaPanel 承担（同壳不同组件）；AI 标注、字幕层实时
 * overlay 仍不做（下轮建议）。
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { callOp } from '@/core/shared/client';
import { errorTextOf } from '@/core/shared/errors';
import { formatSeconds } from '@/core/shared/duration';
import { biliMediaKey } from '@/core/shared/mediaRef';
import { currentSegmentIndex, filterTranscriptSegments } from '@/core/bili/assistant';
import { markTextSegments } from '@/core/search/unified';
import { buildSubtitleSrt, buildSubtitleTxt } from '@/core/export/subtitles';
import { localDayKey } from '@/core/shared/utils';
import { useUiStore } from './store';
import { emptySearchTip, recentQueryLabel } from './learning/recentQueries';
import { registerEscapeLayer, deepActiveElement } from './components';
import { downloadTextFile } from './reviewCards';
import type { TranscriptEntity } from '@/core/shared/types';

/**
 * 面板自带样式（作用域限定在 .bili-sub-scope，不污染宿主其他元素）：
 *  - 变量与 backdrop/modal 基础样式取自 bilibili.content.tsx BILI_CSS 的同值规则，
 *    学习中心侧 shadow root 没有 bili-* 变量，必须由组件自带；
 *  - 暗色覆盖原为 `.bili-root[data-theme="dark"]` 祖先选择器（BILI_CSS 口径），
 *    这里补上 .hdu-root 变体与 data-dark 显式入口。
 * 注意：样式只在 open 时随组件注入（shadow root 全局生效，两种宿主互不冲突）。
 */
const PANEL_CSS = String.raw`
.bili-sub-scope {
  --b-ink: #171a1d;
  --b-paper: #fff;
  --b-paper-2: #f6f7f8;
  --b-line: #e3e5e7;
  --b-accent: #00a1d6;
  --b-accent-soft: #e8f7ff;
  --b-shadow: 0 4px 20px rgba(0,0,0,.12);
  --b-radius: 12px;
  --b-font: "PingFang SC", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif;
  font-family: var(--b-font);
  color: var(--b-ink);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  /* backdrop（与 BILI_CSS 的 .bili-modal-backdrop 同值，HDU 侧靠这里获得全部样式） */
  position: fixed;
  inset: 0;
  z-index: 2147483001;
  background: rgba(0,0,0,.45);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: bili-fadein .15s ease;
}
.bili-sub-scope .bili-modal {
  background: var(--b-paper);
  border-radius: var(--b-radius);
  box-shadow: var(--b-shadow);
  width: 420px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  overflow-y: auto;
  animation: bili-slideup .2s ease;
}
.bili-sub-scope .bili-sub-modal { width: 520px; display: flex; flex-direction: column; }
.bili-sub-scope .bili-modal-head { padding: 20px 20px 0; display: flex; align-items: center; justify-content: space-between; }
.bili-sub-scope .bili-modal-head h3 { margin: 0; font-size: 16px; font-weight: 600; }
.bili-sub-scope .bili-modal-close {
  width: 28px; height: 28px; border-radius: 50%; border: none; background: transparent;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  color: #999; transition: background .15s;
}
.bili-sub-scope .bili-modal-close:hover { background: var(--b-paper-2); }
.bili-sub-scope .bili-sub-meta { padding: 6px 20px 0; font-size: 12px; color: #999; }
/* 空结果建议（第 263 轮，检索域 / 空态体验）：空态句下的换词提示（块级小字，
   颜色继承 .bili-sub-empty 的亮/暗两档，不另设色值） */
.bili-sub-scope .bili-sub-empty-tips { display: block; margin-top: 6px; font-size: 11px; }
/* 空结果最近搜索回放（第 270 轮，检索域 / 跨端一致）：前 3 个胶囊 chips（点击填词重搜），
   与统一搜索空态回放同语言（走面板 --b-* 变量） */
.bili-sub-scope .bili-sub-empty-recent { display: flex; justify-content: center; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.bili-sub-scope .bili-sub-recent-chip {
  border: 1px solid var(--b-line); border-radius: 99px; padding: 2px 10px;
  background: var(--b-paper-2); color: var(--b-ink); font-size: 11px; font-family: inherit;
  cursor: pointer; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  transition: border-color .12s ease, color .12s ease;
}
.bili-sub-scope .bili-sub-recent-chip:hover { border-color: var(--b-accent); color: var(--b-accent); }
/* 清除搜索按钮（第 266 轮，跨端一致性）：与统一搜索 .hdu-search-clear 同语言
   （18px 圆钮、muted → hover 危险色），走面板 --b-* 变量 */
.bili-sub-scope .bili-sub-clear {
  flex: 0 0 auto; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 50%;
  background: transparent; color: #999; font-size: 14px; line-height: 1; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; font-family: inherit;
  transition: background-color .12s ease, color .12s ease;
}
.bili-sub-scope .bili-sub-clear:hover { background: var(--b-paper-2); color: var(--b-ink); }
/* 字幕搜索框（第 24 轮功能扩展第一批）：纯前端过滤，样式跟随面板变量与暗色主题 */
.bili-sub-scope .bili-sub-toolbar { padding: 10px 20px 0; display: flex; align-items: center; gap: 8px; }
.bili-sub-scope .bili-sub-toolbar .bili-sub-search { flex: 1; min-width: 0; width: auto; }
.bili-sub-scope .bili-sub-tools { display: flex; gap: 6px; flex: none; }
.bili-sub-scope .bili-sub-export {
  border: 1px solid var(--b-line); background: var(--b-paper); color: var(--b-ink);
  font-size: 12px; line-height: 1; padding: 6px 10px; border-radius: 999px; cursor: pointer;
  font-family: inherit; transition: border-color .15s, color .15s;
}
.bili-sub-scope .bili-sub-export:hover { border-color: var(--b-accent); color: var(--b-accent); }
.bili-sub-scope .bili-sub-search {
  width: 100%;
  padding: 7px 12px;
  border: 1px solid var(--b-line);
  border-radius: 8px;
  background: var(--b-paper);
  color: var(--b-ink);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  transition: border-color .15s;
}
.bili-sub-scope .bili-sub-search:focus { border-color: var(--b-accent); }
.bili-sub-scope .bili-sub-search::placeholder { color: #999; }
.bili-sub-scope .bili-sub-list { padding: 8px 12px 16px; overflow-y: auto; min-height: 120px; }
.bili-sub-scope .bili-sub-row {
  display: flex; gap: 10px; width: 100%; text-align: left; padding: 7px 10px;
  border: none; background: transparent; border-radius: 8px; cursor: pointer;
  font-size: 13px; line-height: 1.5; font-family: inherit; color: var(--b-ink);
  transition: background .12s;
}
.bili-sub-scope .bili-sub-row:hover { background: var(--b-paper-2); }
.bili-sub-scope .bili-sub-time { flex-shrink: 0; min-width: 44px; color: var(--b-accent); font-variant-numeric: tabular-nums; }
.bili-sub-scope .bili-sub-text { flex: 1; min-width: 0; word-break: break-word; }
/* 搜索命中词高亮（第 259 轮，跨端一致性）：与统一搜索 .hdu-search-mark 同款金色淡底
   mark（亮色用深金保对比、暗色用亮金提亮，均走 color-mix 与面板墨色混合） */
.bili-sub-scope .bili-sub-text mark {
  background: color-mix(in srgb, #8a6a1f 16%, transparent);
  color: color-mix(in srgb, #8a6a1f 72%, var(--b-ink));
  border-radius: 3px; padding: 0 1px; font-weight: 600;
}
.bili-sub-scope .bili-sub-empty { padding: 28px 12px; text-align: center; color: #999; font-size: 13px; }
/* 当前行高亮（第 16 轮包 B）：s<=t<e 的行；刻意不自动滚动，避免干扰阅读（真机观察项） */
.bili-sub-scope .bili-sub-row.is-current { background: var(--b-accent-soft); }
.bili-sub-scope .bili-sub-row.is-current .bili-sub-time { font-weight: 600; }
/* AI 生成字幕小标记（第 16 轮包 B；落库字段 aiSubtitle 见 TranscriptEntity） */
.bili-sub-scope .bili-sub-ai {
  display: inline-block; margin-left: 8px; padding: 1px 6px; border-radius: 4px;
  font-size: 11px; line-height: 1.5; vertical-align: 1px;
  color: var(--b-accent); background: var(--b-accent-soft);
}
/* 暗色：B 站宿主（.bili-root[data-theme]）与学习中心宿主（.hdu-root[data-theme]）都跟随 */
.bili-root[data-theme="dark"] .bili-sub-scope,
.hdu-root[data-theme="dark"] .bili-sub-scope,
.bili-sub-scope[data-dark="true"] {
  --b-paper: #1d2126;
  --b-paper-2: #262b31;
  --b-line: #33383e;
  --b-ink: #e2e6ea;
  --b-accent-soft: rgba(88, 184, 220, 0.16);
  color: var(--b-ink);
}
.bili-root[data-theme="dark"] .bili-sub-scope .bili-sub-meta,
.hdu-root[data-theme="dark"] .bili-sub-scope .bili-sub-meta,
.bili-sub-scope[data-dark="true"] .bili-sub-meta { color: #8a9199; }
/* 搜索框聚焦光环（第 266 轮，跨端一致性）：与统一搜索 .hdu-search:focus-within 同语言
   （accent 边框已有，补 3px 柔光环） */
.bili-sub-scope .bili-sub-search:focus { box-shadow: 0 0 0 3px color-mix(in srgb, var(--b-accent) 16%, transparent); }
/* 清除按钮暗色档（随面板三路选择器） */
.bili-root[data-theme="dark"] .bili-sub-scope .bili-sub-clear,
.hdu-root[data-theme="dark"] .bili-sub-scope .bili-sub-clear,
.bili-sub-scope[data-dark="true"] .bili-sub-clear { color: #8a9199; }
.bili-root[data-theme="dark"] .bili-sub-scope .bili-sub-ai,
.hdu-root[data-theme="dark"] .bili-sub-scope .bili-sub-ai,
.bili-sub-scope[data-dark="true"] .bili-sub-ai { color: #58b8dc; }
.bili-root[data-theme="dark"] .bili-sub-scope .bili-sub-empty,
.hdu-root[data-theme="dark"] .bili-sub-scope .bili-sub-empty,
.bili-sub-scope[data-dark="true"] .bili-sub-empty { color: #8a9199; }
/* 命中词高亮暗色档（第 259 轮）：亮金软底 + 亮金字，随面板暗色三路选择器同步 */
.bili-root[data-theme="dark"] .bili-sub-scope .bili-sub-text mark,
.hdu-root[data-theme="dark"] .bili-sub-scope .bili-sub-text mark,
.bili-sub-scope[data-dark="true"] .bili-sub-text mark {
  background: color-mix(in srgb, #d9b969 20%, transparent);
  color: color-mix(in srgb, #d9b969 82%, var(--b-ink));
}
/* 搜索框占位文字在暗色下降亮度（输入框本体走已覆盖的 --b-paper/--b-line/--b-ink 变量） */
.bili-root[data-theme="dark"] .bili-sub-scope .bili-sub-search::placeholder,
.hdu-root[data-theme="dark"] .bili-sub-scope .bili-sub-search::placeholder,
.bili-sub-scope[data-dark="true"] .bili-sub-search::placeholder { color: #8a9199; }
.bili-root[data-theme="dark"] .bili-sub-scope .bili-modal-close,
.hdu-root[data-theme="dark"] .bili-sub-scope .bili-modal-close,
.bili-sub-scope[data-dark="true"] .bili-modal-close { color: #8a9199; }
@keyframes bili-fadein { from { opacity: 0; } to { opacity: 1; } }
@keyframes bili-slideup { from { transform: translateY(16px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
`;

export function BiliSubtitlePanel({
  bvid,
  p,
  open,
  onClose,
  seekMode = 'page',
  dark = false,
  currentTime,
}: {
  bvid: string;
  /** 分 P 序号（第 16 轮多 P）：p≥2 读分 P 键 `bili:<bvid>:p<N>`，P1/缺省读裸键 */
  p?: number;
  open: boolean;
  onClose: () => void;
  /**
   * 行点击行为：'page' = B 站上下文（页内 <video> 优先 seek，无 video 回退整页跳转）；
   * 'external' = 学习中心等非 B 站上下文（新标签打开 B 站 ?t= 外链）。
   */
  seekMode?: 'page' | 'external';
  /** 显式暗色（缺省跟随宿主 data-theme 祖先选择器） */
  dark?: boolean;
  /**
   * 当前播放秒数（B 站宿主从 video timeupdate 传入，节流 ~500ms）：s<=t<e 的行高亮。
   * 缺省（如学习中心宿主）无高亮；刻意不自动滚动，避免干扰阅读。
   */
  currentTime?: number;
}) {
  const [transcript, setTranscript] = useState<TranscriptEntity | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 字幕搜索关键词（第 24 轮功能扩展第一批）：纯前端过滤当前 mediaKey 的段落
  const [query, setQuery] = useState('');
  // 浮层 aria（第 248 轮巡检，无障碍域）：标题元素 id，role=dialog 的 aria-labelledby 指向它
  const titleId = useId();
  // 调用方传入的 onClose 往往是每次渲染新建的闭包：经 ref 引用，Escape 副作用只依赖
  // open，避免宿主状态变化重渲染时反复重挂监听（照 Modal 的 onCloseRef 既有模式）
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  // 浮层根元素（.bili-sub-scope）：Tab 圈闭容器（第 39 轮巡检，见下方归属 effect）
  const backdropRef = useRef<HTMLDivElement | null>(null);
  // 搜索框引用（第 267 轮）：清除按钮点击后焦点回归输入框（与统一搜索同行为）
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // 打开前焦点（第 279 轮，可访问性域）：浮层关闭时把焦点还给打开前的元素
  // （与共享 Modal 组件同行为，避免关闭后焦点落在 body）
  const lastFocusRef = useRef<Element | null>(null);
  // 最近搜索（第 270 轮，检索域 / 跨端一致）：空结果时回放前 3 个 chips（点击填词重搜）——
  // 与统一搜索共用 settings.ui.recentQueries（同一 store 实例，跨入口互通）
  const recentQueries = useUiStore().settings?.ui?.recentQueries ?? [];

  // Escape / Tab 归属：本浮层是宿主化全屏浮层（非 Modal 组件）。第 37 轮巡检接入
  // components.tsx 的共享顶层归属栈——此前按 Esc 会穿透到外层宿主面板把整个面板关掉；
  // 第 39 轮巡检起 Esc/Tab 由共享 window 监听器统一派发（不再自挂 keydown）：
  //  - Esc：浮层是栈顶（后于面板打开）时只关本浮层，面板保持；
  //  - Tab：圈闭在本浮层内——hub 宿主（BiliHubPanel）下面板是 Modal，浮层为栈顶期间
  //    面板的 Tab 圈闭让位，不圈闭则焦点可 Tab 到遮罩之下的面板内容（无障碍缺口）；
  //    B 站视频页（bilibili.content.tsx）与 HDU 学习中心（LearningCenter LibraryView）
  //    两个宿主共用本组件，浮层关闭（注销）后各宿主行为回到原状。
  useEffect(() => {
    if (!open) return undefined;
    // 记录打开前焦点（第 279 轮）：关闭/卸载时还原，与共享 Modal 同行为
    lastFocusRef.current = deepActiveElement();
    const layer = registerEscapeLayer({
      onEscape: () => onCloseRef.current(),
      trapContainer: () => backdropRef.current,
    });
    return () => {
      layer.dispose();
      (lastFocusRef.current as HTMLElement | null)?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open || !bvid) {
      setTranscript(null);
      setError(null);
      setQuery('');
      return;
    }
    let cancelled = false;
    setLoading(true);
    callOp('transcript.get', { mediaKey: biliMediaKey(bvid, p) })
      .then((value) => {
        if (!cancelled) setTranscript(value);
      })
      .catch((err) => {
        if (!cancelled) setError(errorTextOf(err, '字幕加载失败'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, bvid, p]);

  // 字幕搜索过滤：空查询返回全部段的副本；过滤逻辑在 core/bili/assistant 纯函数（可单测）
  const filteredSegments = useMemo(
    () => filterTranscriptSegments(transcript?.segments ?? [], query),
    [transcript, query],
  );
  // 渐进渲染（第 276 轮，性能域）：超长转写（数千段）不再一次性渲染全量 DOM——
  // 先渲染前 200 段，底部「显示更多」每次追加 200；换查询词（过滤结果变化）时重置
  const [visibleLimit, setVisibleLimit] = useState(200);
  useEffect(() => {
    setVisibleLimit(200);
  }, [query]);
  // 滚动近底自动追加（第 284 轮，性能域）：哨兵接近列表底部时自动追加 200 段——
  // IO root 指定列表滚动容器（浮层内滚动，viewport 观察不精确）；按钮保留为显式兜底
  const listRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const sentinel = loadMoreRef.current;
    const root = listRef.current;
    if (!sentinel || !root || filteredSegments.length <= visibleLimit) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisibleLimit((v) => v + 200);
      },
      { root, rootMargin: '120px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [filteredSegments.length, visibleLimit, open]);

  // 当前行索引：在过滤后的列表上重算 s<=t<e（过滤后行序会变，不能复用全量下标）；
  // 无匹配（片头/片尾间隙、未传 currentTime）返回 -1 不高亮
  const currentIndex = useMemo(() => currentSegmentIndex(filteredSegments, currentTime), [filteredSegments, currentTime]);

  // 字幕导出（第 105 轮巡检）：当前字幕 → TXT / SRT 下载（文件名带 bvid 与分 P 标记；
  // 纯函数序列化见 core/export/subtitles，无有效段落时不产文件）
  const exportSubtitle = useCallback(
    (fmt: 'txt' | 'srt') => {
      if (!transcript || transcript.segments.length === 0) return;
      const pLabel = p !== undefined && p > 1 ? `-P${p}` : '';
      downloadTextFile(
        `智慧课堂-字幕-${bvid}${pLabel}-${localDayKey()}.${fmt}`,
        fmt === 'txt' ? buildSubtitleTxt(transcript) : buildSubtitleSrt(transcript),
      );
    },
    [transcript, bvid, p],
  );
  // 定位当前播放句（第 295 轮，体验域）：把当前行滚入列表视野中央——不自动滚动
  // （尊重既有「避免干扰阅读」设计），提供手动定位能力；当前行未渲染（渐进窗口外）
  // 时先扩窗再定位
  const locateCurrentRow = useCallback(() => {
    if (currentIndex < 0) return;
    if (currentIndex >= visibleLimit) setVisibleLimit(currentIndex + 200);
    requestAnimationFrame(() => {
      const row = listRef.current?.querySelectorAll('.bili-sub-row')[currentIndex];
      row?.scrollIntoView({ block: 'center' });
    });
  }, [currentIndex, visibleLimit]);

  const handleSeek = useCallback(
    (sec: number) => {
      const target = Math.max(0, Math.floor(sec));
      // p≥2 分 P 外链带 ?p=N（与统一搜索的分 P 跳转同口径；?t= 紧随其后用 & 追加）
      const pageQuery = p !== undefined && p > 1 ? `p=${p}&` : '';
      // 学习中心等非 B 站上下文：页内 <video> 与该 B 站视频无关，一律新标签外链，
      // 让搜索结果 / 字幕列表直接落到对应时间点（?t= 口径与统一搜索续看一致）
      if (seekMode === 'external') {
        window.open(`https://www.bilibili.com/video/${bvid}?${pageQuery}t=${target}`, '_blank', 'noopener,noreferrer');
        return;
      }
      const video = document.querySelector('video');
      if (video) {
        // 页内直接跳转（与续看 chip 的 handleResume 同路径；不自动 play，避免抢播放控制权）
        video.currentTime = target;
        return;
      }
      // 无播放器元素（极端兜底）：按 ?t= 参数整页跳转（统一搜索续看链接同口径）
      window.location.assign(`https://www.bilibili.com/video/${bvid}?${pageQuery}t=${target}`);
    },
    [bvid, p, seekMode],
  );

  if (!open) return null;

  return (
    <div
      ref={backdropRef}
      className="bili-modal-backdrop bili-sub-scope"
      data-dark={dark ? 'true' : undefined}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* 组件自带样式（唯一样式来源，见 PANEL_CSS 注释）；shadow root 内全局生效 */}
      <style>{PANEL_CSS}</style>
      <div
        className="bili-modal bili-sub-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="bili-modal-head">
          <h3 id={titleId}>字幕</h3>
          <button type="button" className="bili-modal-close" onClick={onClose} aria-label="关闭字幕">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        {/* 命中计数（第 261 轮引入、第 266 轮修齐、第 275 轮补读屏通告）：
            过滤态「命中 X / 共 Y 条 · Z 处」——Z 为搜索词在过滤后段落中的总出现次数
            （按词计，markTextSegments 求和）；role=status 让过滤规模变化对读屏可感 */}
        <div className="bili-sub-meta" role="status">
          {loading ? (
            '字幕加载中…'
          ) : transcript ? (
            <>
              {/* 命中计数（第 261 轮引入、第 266 轮修齐）：过滤态「命中 X / 共 Y 条 · Z 处」——
                  Z 为搜索词在过滤后段落中的总出现次数（按词计，markTextSegments 求和）；
                  第 264 轮曾另起 .bili-sub-count 行，与既有 meta 计数重复，本轮并入 meta 行 */}
              {query.trim()
                ? `命中 ${filteredSegments.length} / 共 ${transcript.segments.length} 条 · ${filteredSegments.reduce(
                    (sum, seg) => sum + markTextSegments(seg.text, query.trim()).filter((part) => part.marked).length,
                    0,
                  )} 处`
                : `${transcript.segments.length} 条`}
              {transcript.lang ? ` · ${transcript.lang}` : ''}
              {transcript.aiSubtitle ? <span className="bili-sub-ai">AI 生成</span> : null}
            </>
          ) : (
            ''
          )}
        </div>
        {transcript && transcript.segments.length > 0 ? (
          <div className="bili-sub-toolbar">
            <input
              type="text"
              ref={searchInputRef}
              className="bili-sub-search"
              placeholder="搜索字幕内容，如：函数"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="搜索字幕"
            />
            {/* 清除搜索（第 266 轮，跨端一致性）：有输入时的 × 圆钮——与统一搜索
                .hdu-search-clear 同语义同视觉语言；第 267 轮：清空后焦点回归输入框 */}
            {query ? (
              <button
                type="button"
                className="bili-sub-clear"
                aria-label="清空搜索"
                title="清空搜索"
                onClick={() => {
                  setQuery('');
                  searchInputRef.current?.focus();
                }}
              >
                ×
              </button>
            ) : null}
            {/* 字幕导出（第 105 轮巡检）：TXT / SRT 一键下载 */}
            <div className="bili-sub-tools">
              {/* 定位当前播放句（第 295 轮，体验域）：手动滚到当前行（不自动滚动——
                  尊重既有「避免干扰阅读」设计）；无当前句（片头/片尾间隙）不渲染 */}
              {currentIndex >= 0 ? (
                <button type="button" className="bili-sub-export" onClick={locateCurrentRow} title="滚动到当前播放句">
                  定位当前句
                </button>
              ) : null}
              <button type="button" className="bili-sub-export" onClick={() => exportSubtitle('txt')}>
                导出 TXT
              </button>
              <button type="button" className="bili-sub-export" onClick={() => exportSubtitle('srt')}>
                导出 SRT
              </button>
            </div>
          </div>
        ) : null}
        <div ref={listRef} className="bili-sub-list">
          {loading ? (
            <div className="bili-sub-empty">字幕加载中…</div>
          ) : error ? (
            <div className="bili-sub-empty">{error}</div>
          ) : !transcript ? (
            <div className="bili-sub-empty">尚未获取字幕，请先点击「获取字幕」</div>
          ) : transcript.segments.length === 0 ? (
            <div className="bili-sub-empty">字幕内容为空</div>
          ) : filteredSegments.length === 0 ? (
            <div className="bili-sub-empty">
              未找到与「{query.trim()}」匹配的字幕
              {/* 空结果建议（第 263 轮，检索域 / 空态体验）：与统一搜索空态同款指引，
                  换词重试有方向 */}
              <span className="bili-sub-empty-tips">{emptySearchTip(query)}</span>
              {/* 最近搜索回放（第 270 轮，检索域 / 跨端一致）：空结果时回放前 3 个
                  chips（与统一搜索空态同款），点击填词重搜 */}
              {recentQueries.length > 0 ? (
                <span className="bili-sub-empty-recent" role="group" aria-label="从最近搜索重试">
                  {recentQueries.slice(0, 3).map((q) => (
                    <button key={q} type="button" className="bili-sub-recent-chip" title={q} onClick={() => setQuery(q)}>
                      {recentQueryLabel(q)}
                    </button>
                  ))}
                </span>
              ) : null}
            </div>
          ) : (
            <>
              {filteredSegments.slice(0, visibleLimit).map((seg, index) => (
                <button
                  key={`${seg.s}-${index}`}
                  type="button"
                  className={`bili-sub-row${index === currentIndex ? ' is-current' : ''}`}
                  onClick={() => handleSeek(seg.s)}
                  title={seekMode === 'external' ? '在新标签打开 B 站并跳到该句' : '跳转到该句'}
                >
                  <span className="bili-sub-time">{formatSeconds(seg.s)}</span>
                  {/* 搜索命中词高亮（第 259 轮，跨端一致性）：与统一搜索结果同款金色淡底
                      mark（markTextSegments 同一纯函数，大小写不敏感、全部出现标注）；
                      无查询时按原文渲染零开销 */}
                  <span className="bili-sub-text">
                    {query.trim()
                      ? markTextSegments(seg.text, query.trim()).map((part, j) =>
                          part.marked ? <mark key={j}>{part.text}</mark> : <span key={j}>{part.text}</span>,
                        )
                      : seg.text}
                  </span>
                </button>
              ))}
              {/* 渐进显示「显示更多」（第 276 轮，性能域）：每次追加 200 段，避免超长
                  转写一次性渲染全量 DOM（与知识库 visibleLimit 同模式） */}
              {filteredSegments.length > visibleLimit ? (
                <div ref={loadMoreRef} style={{ display: 'flex', justifyContent: 'center', padding: '8px 0 2px' }}>
                  <button
                    type="button"
                    className="bili-sub-export"
                    onClick={() => setVisibleLimit((v) => v + 200)}
                  >
                    显示更多（还有 {filteredSegments.length - visibleLimit} 段）
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
