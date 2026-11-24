/**
 * B 站「学习中心」浮层（第 32 轮巡检）：把 HDU 侧已有的知识库管理与统计展示能力
 * 提供给 B 站网课场景。由 bilibili.content.tsx 的第 4 枚入口 FAB（.bili-hub-fab）打开，
 * 三个页签（第 35 轮巡检起）：
 *  - 知识库：fav.list 拉 B 站侧收藏（type=video 视频收藏 + type=time 收藏此时刻
 *    + type=ai 收藏的 AI 回答 + type=note 笔记转藏，后两类第 34 轮巡检收录），
 *    复用共享 VideoFavCard 渲染；卡片「加入复习」接 review.plan（口径照学习中心
 *    LibraryView 的 onReview 接线：成功「已加入复习计划」、失败 error toast），
 *    「编辑」打开共享 FavoriteEditModal（保存 fav.update / 删除 fav.softDelete）；
 *    卡片级删除入口（第 241 轮巡检）：与 HDU 知识库第 228 轮对齐——卡片直接给
 *    「删除」（两步确认），软删入回收站，toast 附「撤销」一键还原；进入面板时刷新 + 工具行手动刷新。
 *    工具行（第 35 轮）增「从收藏夹导入」入口：打开共享 BiliImportModal 批量导入
 *    B 站收藏夹（该组件仅依赖 callOp + props，导入落 fav.put 后回调刷新列表）。
 *    工具行（第 37 轮巡检）增「导出复习卡」入口：对当前筛选后的收藏列表经共享
 *    reviewCards 生成复习卡片 md 并下载（与 HDU 学习中心同一实现，同 md 口径）。
 *    字幕能力（第 36 轮巡检）：transcript.keys 全库主键前缀匹配判定各视频收藏的
 *    「字幕已就绪」（口径与 HDU 学习中心 LibraryView 一致，助手抽到 shared/mediaRef），
 *    卡片带「字幕已就绪」徽标与「查看字幕」入口，点开在独立 shadow host 内挂共享
 *    BiliSubtitlePanel（seekMode='external'，行点击新标签打开 B 站 ?t= 外链）。
 *  - 今日：挂 BiliHubTodayCard（第 35 轮巡检）——HDU 学习中心 TodayTodoCard 的
 *    B 站精简版，只做「今日到期复习」（review.due），完成接 review.complete；
 *    schedule.missed / todo.today / plan.weekly 依赖 HDU 课表体系，不引入。
 *  - 统计：挂共享 BiliWatchCard（stats.bili.overview，缺省 range=内部周/月切换），
 *    其下挂共享 PeriodReportCard（stats.period 学习周报/月报，第 34 轮巡检，双端同源）。
 *
 * 样式桥接（关键差异，相对 BiliQaPanel/BiliSubtitlePanel 的「同宿主 + 自带 bili 皮肤」）：
 *  VideoFavCard / BiliWatchCard / FavoriteEditModal 依赖 .hdu-* 类与 --ink/--paper 等
 *  CSS 变量（UI_CSS，仅注入在 HDU 侧 shadow root），B 站宿主 shadow（hdu-bili-collect-host，
 *  BILI_CSS 体系）里没有这些变量，直接挂会裸奔。本组件用**独立 shadow host**
 *  （hdu-bili-hub-host）承载：其中注入全量 UI_CSS，portal 容器挂 .hdu-root 类 +
 *  data-theme，hdu-* 样式在独立 shadow 内完整生效；与 BILI_CSS 天然隔离，互不污染，
 *  也不触碰既有三 FAB 与两个面板。层级：host z-index=2147483001（模态浮层层，高于
 *  收藏宿主的 2147483000 stacking context），面板打开时盖住页内 FAB，关闭即让位；
 *  面板内提示走 components.tsx 的 pushToast/ToastHost 通道（与学习中心 LibraryView
 *  的复习提示同源同文案），ToastHost 渲染在本 portal 内，不被收藏宿主遮挡。
 *
 * 深色模式：dark prop 由宿主（BiliCollectApp 的 isBiliHostDark 跟随机制）传入，
 * 落在 .hdu-root[data-theme="dark"] 上，UI_CSS 的暗色变量整组生效。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { callOp } from '@/core/shared/client';
import { errorTextOf } from '@/core/shared/errors';
import { loadSettings, saveSettings } from '@/core/shared/settings';
import { emptySearchTip, pushRecentQuery, recentQueryLabel, removeRecentQuery, RECENT_QUERY_CAP } from './learning/recentQueries';
import { hasBiliTranscriptKey, parseMediaKey } from '@/core/shared/mediaRef';
import { collectTopTags } from '@/core/shared/tags';
import type { FavoriteEntity, FolderEntity, ReviewJobEntity, ShortcutMap } from '@/core/shared/types';
import { DEFAULT_SHORTCUTS } from '@/core/shared/constants';
import { reviewBadgeForJob, type ReviewBadge } from '@/core/plan/reviewBadge';
import { ShortcutsModal } from './ShortcutsModal';
import { ErrorBoundary } from './ErrorBoundary';
import { Button, EmptyState, Modal, PillTabs, Skeleton, ToastHost, cx, pushToast, deepActiveElement } from './components';
import { VideoFavCard, videoBvidOf } from './VideoFavCard';
import { BiliWatchCard } from './BiliWatchCard';
import { AchievementStrip } from './learning/AchievementStrip';
import { BiliSubtitlePanel } from './BiliSubtitlePanel';
import { FavoriteEditModal } from './FavoriteEditModal';
import { BiliImportModal } from './BiliImportModal';
import { BiliHubTodayCard } from './BiliHubTodayCard';
import { PeriodReportCard } from './PeriodReportCard';
import { ActivityHeatmap } from './learning/ActivityHeatmap';
import { TopBarSearch } from './learning/TopBarSearch';
import { lessonHash } from '../site/navigation';
import { SITE_ORIGINS } from '@/core/shared/constants';
import { withTimeParam } from '@/core/shared/utils';
import { downloadTextFile, exportReviewCards } from './reviewCards';
import { buildFavoritesCsv } from '@/core/export/csv';
import { formatMonthDay, localDayKey } from '@/core/shared/utils';
import { UI_CSS } from './styles';

/** 学习中心独立 shadow host 的元素 id（e2e 冒烟按此 id 穿透查询） */
export const BILI_HUB_HOST_ID = 'hdu-bili-hub-host';

/** fav.list 单次拉取上限（与收藏宿主既有全量口径一致；个人知识库量级远小于此） */
const HUB_FAV_LIMIT = 500;

const HUB_TAB_ITEMS: Array<{ value: 'library' | 'today' | 'stats'; label: string }> = [
  { value: 'library', label: '知识库' },
  { value: 'today', label: '今日' },
  { value: 'stats', label: '统计' },
];

/** B 站 bvid 口径（与 videoBvidOf / bilibili.content.tsx 的 BV 正则同源） */
const BVID_PATTERN = /^BV[A-Za-z0-9]{8,}$/;

/**
 * 纯函数：该收藏是否属于 B 站侧（学习中心页签只展示 B 站内容，HDU 站内收藏不混入）。
 *  - video：refId 是合法 bvid（B 站内容脚本收藏与收藏夹导入都落 BV refId）；
 *  - time：收藏此时刻把 bvid 落在 metadata.bvid（buildMomentFavorite 口径）；
 *  - ai：收藏 AI 回答把 bvid 落在 metadata.bvid（buildAiFavorite 口径，第 34 轮收录）；
 *    HDU 站内 AI 收藏（favoriteChat）落 courId/teclId、不带 metadata，据此排除；
 *  - note：B 站笔记转藏（note.toFavorite ← ExternalNoteEntity）把 mediaKey 落在
 *    metadata.mediaKey（`bili:<bvid>[:pN]`，noteToFavorite 口径，第 34 轮收录）；
 *    HDU 站内笔记转藏落 courId/teclId、无 metadata，据此排除；
 *  - 其余类型（outline/screenshot）目前仅 HDU 站内产生，不进 B 站学习中心。
 */
export function isBiliHubFavorite(fav: FavoriteEntity): boolean {
  if (fav.type === 'video') return videoBvidOf(fav) !== '';
  if (fav.type === 'time' || fav.type === 'ai') {
    const bvid = (fav.metadata as { bvid?: unknown } | undefined)?.bvid;
    return typeof bvid === 'string' && BVID_PATTERN.test(bvid);
  }
  if (fav.type === 'note') {
    // mediaKey 须能解析为合法 B 站键（bili:<bvid>[:pN]，bvid 非空、分 P 后缀合法）；
    // 'hdu:<courId>' 形状的键与其他脏值一律排除
    const mediaKey = (fav.metadata as { mediaKey?: unknown } | undefined)?.mediaKey;
    return typeof mediaKey === 'string' && parseMediaKey(mediaKey)?.kind === 'bili';
  }
  return false;
}

/** 纯函数：知识库列表排序——置顶优先，其余按收藏时间倒序（新收藏在前） */
export function sortHubFavorites(list: FavoriteEntity[]): FavoriteEntity[] {
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.favoritedAt - a.favoritedAt;
  });
}

/**
 * 纯函数：知识库列表按关键词过滤（第 33 轮巡检）——标题（snapshot.title）/备注（note）/
 * 标签（tags）大小写不敏感 contains；空白查询返回全部的原样副本。纯前端内存过滤
 * （列表已全量拉取，不新增 op），与既有置顶/时间排序叠加：先过滤后排序由调用方保证。
 */
export function filterHubFavorites(list: FavoriteEntity[], query: string): FavoriteEntity[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return [...list];
  return list.filter((fav) => {
    const fields = [fav.snapshot?.title ?? '', fav.note ?? '', ...(Array.isArray(fav.tags) ? fav.tags : [])];
    return fields.some((field) => field.toLowerCase().includes(keyword));
  });
}

/**
 * 知识库类型筛选口径（第 34 轮巡检）：全部 / 视频（type=video）/ 此时刻（type=time）
 * / 问答（type=ai，收藏的 AI 回答）/ 笔记（type=note，笔记转藏）。
 * 分组取舍：与 FavoriteType 的 B 站侧可产出子集一一对应（outline/screenshot 仅 HDU
 * 站内产生，不设 chip），ai 命名「问答」、note 命名「笔记」与学习助手页签措辞一致。
 */
export type HubFavoriteTypeFilter = 'all' | 'video' | 'time' | 'ai' | 'note';

const HUB_TYPE_FILTERS: Array<{ value: HubFavoriteTypeFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'video', label: '视频' },
  { value: 'time', label: '此时刻' },
  { value: 'ai', label: '问答' },
  { value: 'note', label: '笔记' },
];

/**
 * 纯函数：知识库列表按类型过滤（第 34 轮巡检）。入参约定为 B 站侧列表
 * （已经 isBiliHubFavorite 过滤），video/time/ai/note 直接按 type 字段筛选，
 * all 返回原序副本。与关键词过滤（filterHubFavorites）为 AND 叠加，先后顺序
 * 不影响结果集，均保持原序。
 */
export function filterHubFavoritesByType(list: FavoriteEntity[], type: HubFavoriteTypeFilter): FavoriteEntity[] {
  if (type === 'all') return [...list];
  return list.filter((fav) => fav.type === type);
}

/** 类型 chips 紧凑样式（组件自注入，照 WindowPresetChips 的 hdu 皮肤模式；颜色走 .hdu-root 变量，暗色自动跟随） */
const HUB_TYPE_CHIPS_CSS = String.raw`
.hdu-hub-type-chips { display: inline-flex; align-items: center; gap: 6px; flex: none; }
.hdu-hub-type-chip {
  padding: 3px 10px; border-radius: 99px; border: 1px solid var(--line);
  background: color-mix(in srgb, var(--paper-2) 70%, transparent);
  color: var(--muted); font-size: 11.5px; line-height: 1.6; font-family: inherit;
  white-space: nowrap; cursor: pointer;
  transition: border-color .15s ease, background-color .15s ease, color .15s ease;
}
.hdu-hub-type-chip:hover { border-color: var(--accent); color: var(--accent); }
.hdu-hub-type-chip.is-active { background: var(--accent-soft); border-color: transparent; color: var(--accent); font-weight: 500; }
`;

/** 知识库类型筛选 chips（全部 / 视频 / 此时刻 / 问答 / 笔记）：受控单选，选中态高亮 */
function HubTypeChips({ value, onChange }: { value: HubFavoriteTypeFilter; onChange: (next: HubFavoriteTypeFilter) => void }) {
  return (
    <>
      {/* 样式随组件注入所在 shadow root（本面板仅此一处使用，不重复注入） */}
      <style>{HUB_TYPE_CHIPS_CSS}</style>
      <div className="hdu-hub-type-chips" role="group" aria-label="按类型筛选">
        {HUB_TYPE_FILTERS.map((option) => (
          <button
            type="button"
            key={option.value}
            className={`hdu-hub-type-chip${value === option.value ? ' is-active' : ''}`}
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * 获取（或创建）学习中心独立 shadow host，返回 portal 挂载容器。
 * 幂等：host/shadow/样式/容器任一已存在则直接复用（React 严格模式重复调用安全）。
 */
function ensureHubHost(): HTMLElement {
  let host = document.getElementById(BILI_HUB_HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = BILI_HUB_HOST_ID;
    // 与 hdu-bili-collect-host 同款宿主样式；z-index 取模态浮层层（2147483001）：
    // 面板打开时整体盖在收藏宿主（2147483000）之上，关闭后空宿主无渲染不挡页面
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483001; pointer-events: none;';
    document.body.appendChild(host);
  }
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  if (!shadow.querySelector('style[data-bili-hub]')) {
    const style = document.createElement('style');
    style.setAttribute('data-bili-hub', '1');
    // 全量 UI_CSS：.hdu-* 类与明暗两套 --* 变量的唯一样式来源（与 HDU 侧同一份）
    style.textContent = UI_CSS;
    shadow.appendChild(style);
  }
  let container = shadow.querySelector<HTMLElement>('#bili-hub-root');
  if (!container) {
    container = document.createElement('div');
    container.id = 'bili-hub-root';
    container.style.cssText = 'position: fixed; inset: 0; pointer-events: none;';
    shadow.appendChild(container);
  }
  return container;
}

export function BiliHubPanel({
  open,
  onClose,
  dark = false,
}: {
  open: boolean;
  onClose: () => void;
  /** 宿主深色主题（isBiliHostDark 跟随机制的当前值） */
  dark?: boolean;
}) {
  const [tab, setTab] = useState<'library' | 'today' | 'stats'>('library');
  const [favorites, setFavorites] = useState<FavoriteEntity[]>([]);
  const [folders, setFolders] = useState<FolderEntity[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<FavoriteEntity | null>(null);
  // 「从收藏夹导入」弹窗开合（第 35 轮）：打开共享 BiliImportModal，导入成功后刷新知识库
  const [importOpen, setImportOpen] = useState(false);
  // 快捷键速查浮层（第 224 轮巡检）：与 HDU 播放页共用 ShortcutsModal；打开时读实时设置
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [shortcuts, setShortcuts] = useState<ShortcutMap>(DEFAULT_SHORTCUTS);
  const openShortcuts = useCallback(async () => {
    const settings = await loadSettings().catch(() => null);
    setShortcuts(settings?.shortcuts ?? DEFAULT_SHORTCUTS);
    setShortcutsOpen(true);
  }, []);
  // 知识库搜索关键词（第 33 轮）：纯前端过滤当前已加载列表（标题/备注/标签）
  const [query, setQuery] = useState('');
  // 搜索框引用（第 312 轮）：chips「清空」后焦点回归输入框（四端一致）
  const hubSearchRef = useRef<HTMLInputElement | null>(null);
  // 最近搜索（第 304 轮，检索域）：与统一搜索 / HDU 知识库共用 settings.ui.recentQueries——
  // 输入停顿 800ms 记录一条（去重前移、最多 5 条）；搜索词为空时在工具行平铺 chips，
  // 点击回填、可单条删除（看板 Library 同款 loadSettings/saveSettings 通道）
  const [recentQueries, setRecentQueries] = useState<string[]>([]);
  useEffect(() => {
    void loadSettings().then((s) => setRecentQueries(s.ui?.recentQueries ?? []));
  }, []);
  const persistRecent = useCallback((next: string[]) => {
    setRecentQueries(next);
    void (async () => {
      const current = await loadSettings();
      await saveSettings({ ui: { ...current.ui, recentQueries: next } });
    })();
  }, []);
  useEffect(() => {
    const kw = query.trim();
    if (!kw) return;
    const timer = window.setTimeout(() => {
      const next = pushRecentQuery(recentQueries, kw, RECENT_QUERY_CAP);
      if (JSON.stringify(recentQueries) !== JSON.stringify(next)) persistRecent(next);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [query, recentQueries, persistRecent]);
  // 知识库类型筛选（第 34 轮）：全部 / 视频 / 此时刻 / 问答 / 笔记，与搜索过滤 AND 叠加
  const [typeFilter, setTypeFilter] = useState<HubFavoriteTypeFilter>('all');
  // 知识库文件夹筛选（第 79 轮巡检）：all=全部 / none=未分组 / 其余为 folderId
  const [folderFilter, setFolderFilter] = useState<'all' | 'none' | string>('all');
  // 知识库标签筛选（第 82 轮巡检）：null = 全部标签；候选取自当前收藏的高频标签
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  // 复习状态筛选（第 107 轮巡检）：all=全部 / reviewing=复习中 / none=未入计划
  //（归属 = reviewAnyIds：review.list 全量 pending 作业的 favoriteIds，不限当日）
  const [reviewFilter, setReviewFilter] = useState<'all' | 'reviewing' | 'none'>('all');
  const [reviewAnyIds, setReviewAnyIds] = useState<Set<string>>(new Set());
  // 上次复习完成时间（第 224 轮 HDU 侧引入；第 225 轮接入 B 站）：done 作业按收藏取最近一次 → 'MM/DD'
  const [lastReviewDoneLabels, setLastReviewDoneLabels] = useState<Map<string, string>>(new Map());
  // 知识库排序（第 113 轮巡检）：default=置顶/时间（原序）/ title=标题 / review=复习中优先。
  // 第 116 轮起持久化到 settings.ui.hubSortKey（跨打开保留；读取失败回退默认）。
  const [sortKey, setSortKeyState] = useState<'default' | 'title' | 'review'>('default');
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    loadSettings()
      .then((settings) => {
        if (!cancelled) setSortKeyState(settings.ui.hubSortKey ?? 'default');
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);
  // 面板关闭后焦点回归（第 293 轮，可访问性域）：打开时记录打开前焦点、关闭/卸载时
  // 还原——与字幕浮层 / 共享 Modal 同行为，避免关闭后焦点落在 body
  const lastFocusRef = useRef<Element | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    lastFocusRef.current = deepActiveElement();
    return () => {
      (lastFocusRef.current as HTMLElement | null)?.focus?.();
    };
  }, [open]);
  const setSortKey = useCallback((key: 'default' | 'title' | 'review') => {
    setSortKeyState(key);
    void (async () => {
      const settings = await loadSettings().catch(() => null);
      if (!settings) return;
      await saveSettings({ ui: { ...settings.ui, hubSortKey: key } }).catch(() => undefined);
    })();
  }, []);
  // 批量整理（第 88 轮巡检）：多选 → 批量移动文件夹 / 批量删除（进回收站）
  const [tidyMode, setTidyMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [tidyFolder, setTidyFolder] = useState('');
  // 批量打标签（第 89 轮巡检）
  const [tidyTags, setTidyTags] = useState('');
  // 批量操作撤销（第 90 轮巡检）：记录上一次批量移动/打标签前的条目状态
  const [lastBatch, setLastBatch] = useState<Array<{ id: string; folderId: string | null; tags: string[] }> | null>(null);
  // portal 容器（首次打开时惰性创建独立 shadow host；关闭仅卸载内容，host 复用）
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  // ── 字幕就绪状态（第 36 轮巡检；口径与 HDU 学习中心 LibraryView 一致） ──
  // transcript.keys 一次取全库主键（仅键不载正文，开销低于逐个 transcript.get 拉正文），
  // 按 bvid 前缀匹配（P1 裸键或 p≥2 分 P 键）判定各视频收藏是否已有字幕 → 卡片
  // 「字幕已就绪」徽标与「查看字幕」入口；点开「查看字幕」时由 BiliSubtitlePanel
  // 自行经 transcript.get 拉正文，本面板只管开合与 bvid/分 P 透传。
  const [subReady, setSubReady] = useState<ReadonlySet<string>>(() => new Set<string>());
  // 复习状态徽标数据源（第 244 轮巡检，升级第 102 轮 review.due「复习中」孤岛 chip，
  // 与 HDU 知识库 LibraryView 同款同口径）：每收藏最早到期的 pending 作业 + 任意状态
  // 归属（区分「未入计划」与「计划已走完」），均自 review.list 一路取齐
  const [reviewDueByFav, setReviewDueByFav] = useState<Map<string, ReviewJobEntity>>(new Map());
  const [hasAnyReviewIds, setHasAnyReviewIds] = useState<Set<string>>(new Set());
  // 当前查看字幕的 bvid 与分 P（null = 浮层关闭；分 P 来自收藏 metadata.url 的 ?p=）
  const [subBvid, setSubBvid] = useState<string | null>(null);
  const [subP, setSubP] = useState<number | undefined>(undefined);
  // 当前列表里视频收藏的 bvid 去重串（逗号拼接作 effect 依赖；无变化不重复拉 keys）
  const videoBvidsKey = useMemo(
    () => [...new Set(favorites.map(videoBvidOf).filter(Boolean))].join(','),
    [favorites],
  );
  useEffect(() => {
    if (!videoBvidsKey) {
      setSubReady(new Set<string>());
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      const keys = await callOp('transcript.keys', {}).catch(() => [] as string[]);
      if (cancelled) return;
      const ready = new Set<string>();
      for (const bvid of videoBvidsKey.split(',')) {
        if (hasBiliTranscriptKey(keys, bvid)) ready.add(bvid);
      }
      setSubReady(ready);
    })();
    return () => {
      cancelled = true;
    };
  }, [videoBvidsKey]);

  // 拉取 B 站侧收藏 + 文件夹（ folders 失败不阻塞列表，编辑弹窗降级为无分组可选）。
  // seq 守卫（第 38 轮巡检）：快速重开面板/手动刷新叠加时，慢的旧响应不得覆盖
  // 新数据——每次 load 递增序号，响应回来时序号不匹配（已有更新的 load 在跑）即丢弃
  const loadSeqRef = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    try {
      const [favResult, folderResult, allJobsResult] = await Promise.all([
        callOp('fav.list', { filter: { limit: HUB_FAV_LIMIT } }),
        callOp('folder.list', { includeArchived: false }).catch(() => [] as FolderEntity[]),
        callOp('review.list', {}).catch(() => [] as ReviewJobEntity[]),
      ]);
      if (loadSeqRef.current !== seq) return;
      setFolders(folderResult);
      // 复习状态数据源（第 244 轮巡检）：原 review.due 独立往返收编进 review.list
      // 单路（徽标信息升级为全量 pending + 到期日分色超集，少一次 op 往返）
      {
        const dueByFav = new Map<string, ReviewJobEntity>();
        const anyIds = new Set<string>();
        const pendingIds = new Set<string>();
        for (const job of allJobsResult) {
          if (!job || typeof job.favoriteId !== 'string') continue;
          anyIds.add(job.favoriteId);
          if (job.status === 'pending') {
            pendingIds.add(job.favoriteId);
            const prev = dueByFav.get(job.favoriteId);
            // 取最早到期（最紧急）的 pending 作业作徽标依据；脏 dueDate 不入选
            if (!prev || (typeof job.dueDate === 'string' && job.dueDate < prev.dueDate)) dueByFav.set(job.favoriteId, job);
          }
        }
        setReviewDueByFav(dueByFav);
        setHasAnyReviewIds(anyIds);
        // 复习状态筛选数据源（第 107 轮巡检）：全量 pending 作业的 favoriteIds（不限当日）
        setReviewAnyIds(pendingIds);
      }
      // 上次复习完成时间（第 225 轮巡检）：done 作业按收藏取最近一次 updatedAt → 'MM/DD'
      {
        const latest = new Map<string, number>();
        for (const job of allJobsResult) {
          if (!job || job.status !== 'done' || typeof job.favoriteId !== 'string') continue;
          const ts = typeof job.updatedAt === 'number' ? job.updatedAt : 0;
          const prev = latest.get(job.favoriteId);
          if (prev === undefined || ts > prev) latest.set(job.favoriteId, ts);
        }
        const labels = new Map<string, string>();
        for (const [id, ts] of latest) {
          const label = formatMonthDay(ts);
          if (label) labels.set(id, label);
        }
        setLastReviewDoneLabels(labels);
      }
      setFavorites(sortHubFavorites(favResult.filter(isBiliHubFavorite)));
    } catch (err) {
      if (loadSeqRef.current !== seq) return;
      pushToast(errorTextOf(err, '知识库加载失败，请重试'), 'error');
    } finally {
      if (loadSeqRef.current === seq) setLoading(false);
    }
  }, []);

  // 进入面板时刷新（SPA 常驻，不重复触发）
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // 面板打开时确保独立 shadow host 就绪
  useEffect(() => {
    if (!open) return;
    setPortalHost(ensureHubHost());
  }, [open]);

  // 面板每次打开时重置列表筛选（第 34 轮巡检 P3-4）、导入弹窗开合（第 35 轮）与
  // 字幕浮层开合（第 36 轮）：搜索词/类型筛选/弹窗/字幕浮层都是面板内临时状态，
  // SPA 常驻组件在关闭再打开后不应残留——否则列表仍处于过滤态（看似「内容丢失」）、
  // 导入弹窗或字幕浮层意外随面板重开
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setTypeFilter('all');
    setFolderFilter('all');
    setTagFilter(null);
    setTidyMode(false);
    setSelectedIds(new Set());
    setTidyFolder('');
    setImportOpen(false);
    setSubBvid(null);
    setSubP(undefined);
  }, [open]);

  // 「加入复习」：与学习中心 LibraryView 同参数同文案（review.plan 不校验 courId，
  // B 站收藏同样可入计划）；成功/失败都走本 portal 内的 ToastHost。
  // busy 守卫（第 38 轮巡检，与 HDU 学习中心 LibraryView 同型）：同一收藏的复习
  // 请求进行中忽略重复点击，防止并发双击重复入计划（repo planReview 先 cancel 再
  // put，串行重复点击只是重置计划、无副作用，守卫只拦同一收藏的并发双击）
  const reviewingIdRef = useRef<string | null>(null);
  const handleReview = useCallback(async (fav: FavoriteEntity) => {
    if (reviewingIdRef.current === fav.id) return;
    reviewingIdRef.current = fav.id;
    try {
      await callOp('review.plan', { favoriteId: fav.id });
      pushToast('已加入复习计划', 'success');
    } catch (err) {
      pushToast(errorTextOf(err, '加入复习失败'), 'error');
    } finally {
      reviewingIdRef.current = null;
    }
  }, []);

  // 统一搜索的课次跳转（第 77 轮巡检，B 站宿主版）：新标签打开 HDU 播放页深链
  // （play-center 形态）。B 站宿主内 uiStore 的 openSessionInSite 是空实现（HDU
  // 内容脚本才注入真实现），且从 B 站跳转不应丢失当前视频页，故覆写为新标签；
  // origin 取 campus 主站（webvpn 链接需会话内改写，B 站侧无上下文可判，取主站）。
  // 秒级直达（第 104 轮巡检）：命中带 anchorSec 时拼 ?t=<秒>（真实 query，withTimeParam
  // 去重），HDU 内容脚本启动时读取并在播放器就绪后 seek——「搜索命中 → 落点秒数」闭环。
  const openHduSession = useCallback((courId: number, teclId?: number, anchorSec?: number) => {
    if (!Number.isFinite(courId) || courId <= 0) return;
    let url = `${SITE_ORIGINS.campus}/${lessonHash({ courId, teclId, prefer: 'play-center' })}`;
    if (anchorSec != null && Number.isFinite(anchorSec) && anchorSec >= 0) url = withTimeParam(url, anchorSec);
    window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  // 列表过滤（纯前端）与既有排序叠加：favorites 已按置顶/时间排序，过滤保持原序。
  // 叠加顺序：先类型 chips（第 34 轮）后关键词搜索（第 33 轮）——两者 AND 语义，顺序不影响结果集；
  // 文件夹筛选（第 79 轮巡检）与标签筛选（第 82 轮巡检）再 AND 叠加（none=未分组：folderId 为空/null）
  const visibleFavorites = useMemo(() => {
    const base = filterHubFavorites(filterHubFavoritesByType(favorites, typeFilter), query);
    const filtered = base.filter((fav) => {
      if (folderFilter !== 'all' && (fav.folderId ?? 'none') !== folderFilter) return false;
      if (tagFilter !== null && !(Array.isArray(fav.tags) ? fav.tags : []).includes(tagFilter)) return false;
      if (reviewFilter === 'reviewing' && !reviewAnyIds.has(fav.id)) return false;
      if (reviewFilter === 'none' && reviewAnyIds.has(fav.id)) return false;
      return true;
    });
    // 排序（第 113 轮巡检）：默认保持原序（置顶/时间）；标题按中文典序；复习中优先
    if (sortKey === 'title') return [...filtered].sort((a, b) => a.snapshot.title.localeCompare(b.snapshot.title, 'zh-Hans-CN'));
    if (sortKey === 'review') return [...filtered].sort((a, b) => Number(reviewAnyIds.has(b.id)) - Number(reviewAnyIds.has(a.id)));
    return filtered;
  }, [favorites, typeFilter, query, folderFilter, tagFilter, reviewFilter, reviewAnyIds, sortKey]);

  // 复习状态徽标（第 244 轮巡检）：收藏 id → 徽标 | null（与 HDU LibraryView 同款）。
  // 在册 pending → 分色徽标；有历史但无 pending → null（「上次复习」chip 承接）；
  // 从未入计划 → 未入计划中性徽标
  const reviewBadgeById = useMemo(() => {
    const map = new Map<string, ReviewBadge | null>();
    for (const fav of favorites) {
      const job = reviewDueByFav.get(fav.id);
      if (job) map.set(fav.id, reviewBadgeForJob(job));
      else map.set(fav.id, hasAnyReviewIds.has(fav.id) ? null : reviewBadgeForJob(null));
    }
    return map;
  }, [favorites, reviewDueByFav, hasAnyReviewIds]);
  // B 站知识库渐进显示（第 230 轮巡检）：与 HDU 知识库同策略，大收藏量下先渲染前 60 条
  const [hubVisibleLimit, setHubVisibleLimit] = useState(60);
  useEffect(() => {
    setHubVisibleLimit(60);
  }, [visibleFavorites]);
  // 滚动近底自动追加（第 286 轮，性能/可用性域）：哨兵接近视口时自动追加 60 条——
  // 与 HDU 知识库 / B 站字幕渐进同模式；按钮保留为显式兜底（无 IO 环境仍可用）
  const hubLoadMoreRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = hubLoadMoreRef.current;
    if (!el || visibleFavorites.length <= hubVisibleLimit) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setHubVisibleLimit((v) => v + 60);
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visibleFavorites.length, hubVisibleLimit]);

  // 高频标签（第 82 轮巡检）：当前收藏自动聚合，供标签筛选 chips
  const topTags = useMemo(() => collectTopTags(favorites, 8), [favorites]);

  // 批量整理（第 88 轮巡检）：移动到文件夹 / 批量删除（软删除，可在看板回收站恢复）
  const toggleTidy = useCallback(() => {
    setTidyMode((v) => !v);
    setSelectedIds(new Set());
    setTidyFolder('');
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const batchMove = useCallback(async () => {
    const targets = visibleFavorites.filter((fav) => selectedIds.has(fav.id));
    if (targets.length === 0 || tidyFolder === '') return;
    const folderId = tidyFolder === '__none__' ? null : tidyFolder;
    try {
      setLastBatch(targets.map((fav) => ({ id: fav.id, folderId: fav.folderId ?? null, tags: fav.tags })));
      for (const fav of targets) {
        await callOp('fav.update', { id: fav.id, patch: { folderId } });
      }
      pushToast(`已移动 ${targets.length} 项`, 'success');
      setSelectedIds(new Set());
      setTidyMode(false);
      void load();
    } catch (err) {
      pushToast(errorTextOf(err, '批量移动失败'), 'error');
    }
  }, [visibleFavorites, selectedIds, tidyFolder, load]);

  const batchDelete = useCallback(async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    try {
      await callOp('fav.softDelete', { ids });
      // 撤销入口（第 227 轮巡检）：软删除即入回收站，toast 附「撤销」一键还原
      pushToast(`已删除 ${ids.length} 项（可在学习看板回收站恢复）`, 'success', 3600, {
        label: '撤销',
        run: async () => {
          await callOp('trash.restore', { keys: ids.map((id) => `favorite:${id}`) });
          pushToast('已撤销删除', 'success');
          void load();
        },
      });
      setSelectedIds(new Set());
      setTidyMode(false);
      void load();
    } catch (err) {
      pushToast(errorTextOf(err, '批量删除失败'), 'error');
    }
  }, [selectedIds, load]);

  // 卡片级删除入口（第 241 轮巡检）：与 HDU 知识库第 228 轮同口径——软删除入回收站，
  // toast 附「撤销」一键还原（undo 走 trash.restore，favorite:<id> 键规则与回收站一致）；
  // 之前删除入口只在编辑弹窗内（第 41 轮裁决），对齐后卡片直达少一步
  const removeFavorite = useCallback(
    async (fav: FavoriteEntity) => {
      try {
        await callOp('fav.softDelete', { ids: [fav.id] });
        pushToast('已移入回收站', 'success', 3600, {
          label: '撤销',
          run: async () => {
            await callOp('trash.restore', { keys: [`favorite:${fav.id}`] });
            pushToast('已撤销删除', 'success');
            void load();
          },
        });
        void load();
      } catch (err) {
        pushToast(errorTextOf(err, '删除失败'), 'error');
      }
    },
    [load],
  );

  // 批量加入复习计划（第 89 轮巡检）：逐项 review.plan，单项失败不中断
  const batchReview = useCallback(async () => {
    const targets = visibleFavorites.filter((fav) => selectedIds.has(fav.id));
    if (targets.length === 0) return;
    let ok = 0;
    for (const fav of targets) {
      try {
        await callOp('review.plan', { favoriteId: fav.id });
        ok += 1;
      } catch {
        /* 单项失败继续其余 */
      }
    }
    pushToast(
      ok === targets.length ? `已将 ${ok} 项加入复习计划` : `已加入 ${ok}/${targets.length} 项（部分失败）`,
      ok > 0 ? 'success' : 'error',
    );
    setSelectedIds(new Set());
    void load();
  }, [visibleFavorites, selectedIds, load]);

  // 批量打标签（第 89 轮巡检）：输入标签（空格/逗号分隔）并入所选收藏的标签集合
  const batchTag = useCallback(async () => {
    const tags = tidyTags.split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean);
    const targets = visibleFavorites.filter((fav) => selectedIds.has(fav.id));
    if (targets.length === 0 || tags.length === 0) return;
    try {
      setLastBatch(targets.map((fav) => ({ id: fav.id, folderId: fav.folderId ?? null, tags: fav.tags })));
      for (const fav of targets) {
        const merged = [...new Set([...(Array.isArray(fav.tags) ? fav.tags : []), ...tags])];
        await callOp('fav.update', { id: fav.id, patch: { tags: merged } });
      }
      pushToast(`已为 ${targets.length} 项添加标签`, 'success');
      setTidyTags('');
      setSelectedIds(new Set());
      setTidyMode(false);
      void load();
    } catch (err) {
      pushToast(errorTextOf(err, '批量打标签失败'), 'error');
    }
  }, [visibleFavorites, selectedIds, tidyTags, load]);

  // 撤销上次批量操作（第 90 轮巡检）：按快照恢复 folderId/tags
  const undoLastBatch = useCallback(async () => {
    const entries = lastBatch;
    if (!entries || entries.length === 0) return;
    try {
      for (const entry of entries) {
        await callOp('fav.update', { id: entry.id, patch: { folderId: entry.folderId, tags: entry.tags } });
      }
      pushToast('已撤销上次批量操作', 'success');
      setLastBatch(null);
      void load();
    } catch (err) {
      pushToast(errorTextOf(err, '撤销失败'), 'error');
    }
  }, [lastBatch, load]);

  if (!open || !portalHost) return null;

  return createPortal(
    <div className="hdu-root" data-theme={dark ? 'dark' : undefined}>
      <Modal open title="学习中心" onClose={onClose} width={720}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
          <PillTabs value={tab} items={HUB_TAB_ITEMS} onChange={setTab} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, justifyContent: 'flex-end' }}>
            {/* 统一搜索（第 77 轮巡检）：与 HDU 学习中心顶栏同一 TopBarSearch 组件
                （search.all 四路聚合：字幕/收藏/笔记/复习，第 245 轮补复习组）；
                课次跳转经 onSessionJump 覆写为「新标签打开 HDU 播放页深链」（见 openHduSession 注释） */}
            <div style={{ flex: 1, maxWidth: 260, minWidth: 140 }}>
              <TopBarSearch onSessionJump={openHduSession} />
            </div>
            {tab === 'library' ? (
              <Button size="small" icon="refresh" onClick={() => void load()} disabled={loading}>
                刷新
              </Button>
            ) : null}
          </div>
        </div>
        {/* 页签级错误边界（第 274 轮，健壮性域）：单页签渲染错误只降级当前页签内容
            （页签栏 / 搜索栏不受影响），切页签经 key 重建自动复位 */}
        <ErrorBoundary key={tab} entry={`bili-hub/${tab}`} retryable={false}>
        {tab === 'library' ? (
          <>
            {/* 知识库工具行（第 33/34/35/37 轮）：搜索框（标题/备注/标签，大小写不敏感）
                + 类型筛选 chips（全部/视频/此时刻/问答/笔记），两者 AND 叠加过滤当前已加载列表；
                「导出复习卡」对当前筛选后的列表生成复习卡片 md 并下载（与 HDU 学习中心
                同一实现 ./reviewCards，第 37 轮巡检）；「从收藏夹导入」打开共享
                BiliImportModal，批量导入 B 站收藏夹到知识库 */}
            <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <input
                ref={hubSearchRef}
                className="hdu-input hdu-hub-search"
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索标题、备注或标签…"
                aria-label="搜索知识库"
                maxLength={100}
                style={{ flex: 1, minWidth: 0 }}
              />
              {/* 最近搜索回放（第 304 轮，检索域）：搜索词为空时平铺最近关键词 chips，
                  与统一搜索 / HDU 知识库同源（settings.ui.recentQueries）；工具行 flexWrap
                  wrap + 本行 flex-basis 100%，自动独占一行 */}
              {!query.trim() && recentQueries.length > 0 ? (
                <div className="hdu-lib-recent" role="group" aria-label="从最近搜索重试">
                  <span className="hdu-lib-recent-label">最近搜索</span>
                  {recentQueries.map((q) => (
                    <span key={q} className="hdu-lib-recent-chip">
                      <button
                        type="button"
                        title={q}
                        onClick={() => {
                          setQuery(q);
                        }}
                      >
                        {recentQueryLabel(q)}
                      </button>
                      <button
                        type="button"
                        className="hdu-lib-recent-del"
                        aria-label={`删除最近搜索 ${q}`}
                        title="删除该条最近搜索"
                        onClick={() => persistRecent(removeRecentQuery(recentQueries, q))}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                      <button type="button" className="hdu-lib-recent-clear" onClick={() => { persistRecent([]); hubSearchRef.current?.focus(); }}>清空</button>
                </div>
              ) : null}
              <HubTypeChips value={typeFilter} onChange={setTypeFilter} />
              {/* 文件夹筛选（第 79 轮巡检）：全部 / 未分组 / 各文件夹，纯前端过滤当前列表 */}
              <select
                className="hdu-input hdu-hub-folder"
                value={folderFilter}
                onChange={(e) => setFolderFilter(e.target.value)}
                aria-label="按文件夹筛选"
              >
                <option value="all">全部文件夹</option>
                <option value="none">未分组</option>
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.name}
                  </option>
                ))}
              </select>
              {/* 复习状态筛选（第 107 轮巡检）：全部 / 复习中 / 未入计划（基于 review.due 待完成作业归属） */}
              <select
                className="hdu-input hdu-hub-folder"
                value={reviewFilter}
                onChange={(e) => setReviewFilter(e.target.value as 'all' | 'reviewing' | 'none')}
                aria-label="按复习状态筛选"
              >
                {/* 计数（第 230 轮巡检）：与 HDU 知识库复习筛选 pills 的全库计数口径对齐 */}
                <option value="all">全部复习状态（{favorites.length}）</option>
                <option value="reviewing">复习中（{reviewAnyIds.size}）</option>
                <option value="none">未入计划（{Math.max(0, favorites.length - reviewAnyIds.size)}）</option>
              </select>
              {/* 排序（第 113 轮巡检）：默认（置顶/时间）/ 标题 / 复习中优先 */}
              <select
                className="hdu-input hdu-hub-folder"
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as 'default' | 'title' | 'review')}
                aria-label="知识库排序"
              >
                <option value="default">默认排序</option>
                <option value="title">按标题</option>
                <option value="review">复习中优先</option>
              </select>
              {/* 标签筛选（第 82 轮巡检）：当前收藏自动聚合的高频标签，点选切换（再点取消）；
                  类名独立于类型 chips（hdu-hub-tag-*），避免既有的类型 chips 断言串扰 */}
              {topTags.length > 0 ? (
                <span className="hdu-hub-tag-chips" role="group" aria-label="按标签筛选">
                  {topTags.map((t) => (
                    <button
                      type="button"
                      key={t}
                      className={`hdu-hub-tag-chip${tagFilter === t ? ' is-active' : ''}`}
                      aria-pressed={tagFilter === t}
                      onClick={() => setTagFilter((prev) => (prev === t ? null : t))}
                    >
                      # {t}
                    </button>
                  ))}
                </span>
              ) : null}
              <Button
                size="small"
                icon="download"
                onClick={() => exportReviewCards(visibleFavorites)}
                disabled={visibleFavorites.length === 0}
              >
                导出复习卡
              </Button>
              <Button size="small" icon="download" onClick={() => setImportOpen(true)}>
                从收藏夹导入
              </Button>
              {/* 撤销上次批量操作（第 90 轮巡检） */}
              {lastBatch ? (
                <Button size="small" variant="ghost" icon="refresh" onClick={() => void undoLastBatch()}>
                  撤销批量
                </Button>
              ) : null}
              {/* 批量整理（第 88 轮巡检）：多选 → 批量移动文件夹 / 批量删除 */}
              <Button size="small" variant="ghost" icon="list" onClick={toggleTidy}>
                {tidyMode ? '退出整理' : '批量整理'}
              </Button>
              {/* 快捷键速查（第 224 轮巡检）：与 HDU 播放页共享 ShortcutsModal */}
              <Button size="small" variant="ghost" icon="scan" onClick={() => void openShortcuts()}>
                快捷键
              </Button>
              {/* 清单 CSV 导出（第 92 轮巡检）：列口径与看板导出一致 */}
              <Button
                size="small"
                variant="ghost"
                icon="download"
                disabled={visibleFavorites.length === 0}
                onClick={() =>
                  downloadTextFile(`收藏清单-${localDayKey()}.csv`, buildFavoritesCsv(visibleFavorites), 'text/csv;charset=utf-8')
                }
              >
                导出 CSV
              </Button>
            </div>
            {/* 批量整理操作条（第 88 轮巡检）：整理模式下显示 */}
            {tidyMode ? (
              <div className="hdu-tidy-bar">
                <span>已选 {selectedIds.size} 项</span>
                {/* 全选（第 93 轮巡检） */}
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={visibleFavorites.length > 0 && selectedIds.size === visibleFavorites.length}
                    onChange={(e) =>
                      setSelectedIds(e.target.checked ? new Set(visibleFavorites.map((fav) => fav.id)) : new Set())
                    }
                  />
                  全选
                </label>
                <select
                  className="hdu-input"
                  style={{ width: 'auto', height: 28 }}
                  value={tidyFolder}
                  disabled={selectedIds.size === 0}
                  aria-label="批量移动目标文件夹"
                  onChange={(e) => setTidyFolder(e.target.value)}
                >
                  <option value="">选择文件夹…</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                  <option value="__none__">移出文件夹（未分组）</option>
                </select>
                <Button size="small" icon="folder" disabled={selectedIds.size === 0 || tidyFolder === ''} onClick={() => void batchMove()}>
                  移动
                </Button>
                <Button size="small" variant="ghost" disabled={selectedIds.size === 0} onClick={() => void batchDelete()}>
                  删除
                </Button>
                {/* 批量打标签 / 批量加入复习计划（第 89 轮巡检） */}
                <input
                  className="hdu-input"
                  style={{ width: 130, height: 28 }}
                  value={tidyTags}
                  placeholder="标签（空格分隔）"
                  aria-label="批量打标签"
                  disabled={selectedIds.size === 0}
                  onChange={(e) => setTidyTags(e.target.value)}
                />
                <Button
                  size="small"
                  variant="ghost"
                  disabled={selectedIds.size === 0 || tidyTags.trim() === ''}
                  onClick={() => void batchTag()}
                >
                  打标签
                </Button>
                <Button size="small" icon="check" disabled={selectedIds.size === 0} onClick={() => void batchReview()}>
                  加入复习
                </Button>
                <Button size="small" variant="ghost" onClick={toggleTidy}>
                  取消整理
                </Button>
              </div>
            ) : null}
            {loading && favorites.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Skeleton height={140} />
                <Skeleton height={140} />
              </div>
            ) : favorites.length === 0 ? (
              <div className="hdu-card">
                <EmptyState
                  icon="video"
                  title="还没有收藏的视频"
                  text="在 B 站视频页点「收藏到知识库」，或在学习助手里收藏此时刻，它们会汇集在这里，可编辑、可加入复习计划。"
                />
              </div>
            ) : visibleFavorites.length === 0 ? (
              <div className="hdu-card">
                <EmptyState
                  icon="search"
                  title="没有匹配的收藏"
                  text={
                    query.trim()
                      ? `没有与「${query.trim()}」匹配的收藏，换个关键词或类型试试。${query.trim().length > 16 ? emptySearchTip(query) : ''}`
                      : '该类型下暂无收藏，切回「全部」查看其他内容。'
                  }
                />
              </div>
            ) : (
              <div className="hdu-knowledge-grid">
                {visibleFavorites.slice(0, hubVisibleLimit).map((fav) => {
                  const bvid = videoBvidOf(fav);
                  const selected = selectedIds.has(fav.id);
                  return (
                    /* 整理模式下点击卡片即切换选中（第 88 轮巡检）；onClickCapture 阻断卡片内部按钮 */
                    <div
                      key={fav.id}
                      className={cx('hdu-tidy-wrap', tidyMode && selected ? 'is-selected' : '')}
                      onClickCapture={(e) => {
                        if (!tidyMode) return;
                        e.stopPropagation();
                        e.preventDefault();
                        toggleSelect(fav.id);
                      }}
                    >
                      {tidyMode ? <span className="hdu-tidy-check">{selected ? '✓' : ''}</span> : null}
                      <VideoFavCard
                        fav={fav}
                        showFavoritedAt
                        reviewBadge={reviewBadgeById.get(fav.id) ?? null}
                        lastReviewDoneLabel={lastReviewDoneLabels.get(fav.id)}
                        // 字幕能力仅视频收藏具备（VideoFavCard 的字幕槽位按 videoBvidOf 门控，
                        // time/ai/note 卡不传不渲染）；就绪判定见上方 transcript.keys effect
                        subtitleReady={bvid !== '' && subReady.has(bvid)}
                        onViewSubtitle={(targetBvid, page) => {
                          setSubBvid(targetBvid);
                          setSubP(page);
                        }}
                        onReview={() => void handleReview(fav)}
                        onEdit={() => setEditing(fav)}
                        // 卡片级删除（第 241 轮巡检）：与 HDU 知识库同能力同文案（两步确认）
                        onDelete={() => void removeFavorite(fav)}
                      />
                    </div>
                  );
                })}
                {/* B 站知识库渐进显示「显示更多」（第 230 轮巡检）：与 HDU 知识库同策略；
                    第 286 轮起哨兵接近视口自动追加（按钮保留为显式兜底） */}
                {visibleFavorites.length > hubVisibleLimit ? (
                  <div
                    ref={hubLoadMoreRef}
                    style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 2px' }}
                  >
                    <Button size="small" variant="ghost" onClick={() => setHubVisibleLimit((v) => v + 60)}>
                      显示更多（还有 {visibleFavorites.length - hubVisibleLimit} 条）
                    </Button>
                  </div>
                ) : null}
              </div>
            )}
          </>
        ) : tab === 'today' ? (
          /* 今日待办精简卡（第 35 轮巡检）：review.due 今日到期复习 + review.complete 完成。
              独立取数组件，页签切换/面板重开重新挂载即刷新 */
          <BiliHubTodayCard />
        ) : (
          <>
            {/* 学习成就速览（第 130 轮巡检）：与 HDU 总览同一共享组件（全局口径，数据自取） */}
            <AchievementStrip />
            <BiliWatchCard />
            <div style={{ height: 16 }} />
            {/* 学习周报 / 月报（第 34 轮巡检）：与 HDU 统计页共用同一 PeriodReportCard
                （stats.period，缺省「近 8 周」，组件自带周/月 PillTabs 切换）；报告含
                站外（B 站等）时长，独立口径在卡内注明，不影响 HDU 侧展示 */}
            <PeriodReportCard />
            {/* 学习热力图（第 77 轮巡检）：与 HDU 统计页同一 ActivityHeatmap
                （stats.heatmap，日级「周列 × 7 行」强度网格，双端同源同口径）；
                明细行「回看」覆写为新标签 HDU 深链（与统一搜索同策略，第 80 轮） */}
            <div style={{ height: 16 }} />
            <ActivityHeatmap onOpenCourse={openHduSession} />
          </>
        )}
        </ErrorBoundary>
        {/* 双端对齐说明（第 248 轮巡检，B 站对齐收官）：多轮对齐后的收官注脚——与 HDU
            学习中心同源的能力不再逐处标注，只保留「明确不适用 / 有意取舍」的 3 条差异
            （复习改期完整弹层 / 回收站视图位置 / 课表体系），落在面板 foot 虚线脚注行
            （.hdu-hub-foot-note，UI_CSS 新增类）；内容与巡检日志第 248 轮对齐核对表一致 */}
        <div className="hdu-hub-foot-note">
          <b>与 HDU 学习中心的功能对齐说明</b>：知识库、今日待办、学习统计、统一搜索、快捷键与成就等能力双端同源（同一组件/同一口径）。已知差异——
          ① 复习「改期」的完整日期弹层（改期留痕 / 批量改期）仅 HDU 复习计划页提供，本卡为精简快捷档；
          ② 回收站视图设在 HDU 学习看板，本面板删除的条目同入回收站、可跨端恢复；
          ③ 课表与补看依赖 HDU 课表体系，B 站侧不适用。
        </div>
      </Modal>
      {/* 编辑弹层（共享组件全能力形态：备注/标签/文件夹/新建文件夹/置顶/移入回收站）；
          保存或删除成功后关窗 + 提示 + 就地刷新列表。与面板 Modal 平级渲染（对齐
          LearningCenter 的既有模式）：不再嵌套在面板 Modal children 内，配合 Modal 的
          栈顶 Escape 口径，编辑弹层打开时按 Esc 只关编辑弹层、不连带关闭面板 */}
      <FavoriteEditModal
        favorite={editing}
        folders={folders}
        onClose={() => setEditing(null)}
        onDone={(toast) => {
          setEditing(null);
          pushToast(toast, 'success');
          void load();
        }}
        onError={(toast) => pushToast(toast, 'error')}
      />
      {/* 「从收藏夹导入」批量导入弹窗（第 35 轮巡检）：与面板 Modal / 编辑弹层平级渲染
          （对齐 Modal 栈顶 Escape 口径，按 Esc 只关本弹层）。onClose(imported) 的
          imported = 本次是否有实际写入（组件内 wroteRef 口径）：有则提示 + 刷新知识库
          列表，纯跳过/中途取消不刷；每周计划询问区（plan.weekly.create）由组件自理 */}
      <BiliImportModal
        open={importOpen}
        onClose={(imported) => {
          setImportOpen(false);
          if (imported) {
            pushToast('收藏夹导入完成', 'success');
            void load();
          }
        }}
      />
      {/* 快捷键速查（第 224 轮巡检）：与 HDU 播放页共享同一浮层组件 */}
      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} shortcuts={shortcuts} />
      {/* 查看字幕浮层（第 36 轮巡检）：复用 B 站字幕面板的同一实现（不复制组件）。
          宿主化要点：本 portal 的 #bili-hub-root 容器 pointer-events:none（交互层
          显式接管模式），而 BiliSubtitlePanel 自带的 .bili-sub-scope 未声明
          pointer-events，直接挂会继承 none 导致整层不可点——包一层 pointer-events:
          auto 的全屏容器接管交互；z-index 抬到面板 Modal（.hdu-modal-backdrop
          2147483003）之上，字幕浮层盖在学习中心面板上。seekMode='external'：本宿主
          页内没有目标 B 站播放器，行点击降级为新标签打开 B 站 ?t= 外链；dark 显式
          透传（组件亦支持 .hdu-root[data-theme] 祖先跟随，双保险）。仅打开时渲染
          包裹层，关闭后不留全屏可点层。 */}
      {subBvid !== null ? (
        <div style={{ position: 'fixed', inset: 0, zIndex: 2147483005, pointerEvents: 'auto' }}>
          <BiliSubtitlePanel
            bvid={subBvid}
            p={subP}
            open
            onClose={() => setSubBvid(null)}
            seekMode="external"
            dark={dark}
          />
        </div>
      ) : null}
      {/* 面板提示通道：渲染在本 portal 内（hdu-toast-stack，UI_CSS 已注入本 shadow），
          不依赖收藏宿主的 bili toast——那层在本 host 之下，会被面板遮住 */}
      <ToastHost />
    </div>,
    portalHost,
  );
}
