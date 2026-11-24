// 学习中心「知识库」视图（自 LearningCenter.tsx 第 40 轮巡检按视图纯搬移拆分，逻辑不变）：
// 收藏卡片网格（筛选 / 搜索 / 文件夹）、笔记列表、B 站导入与字幕浮层、收藏编辑弹层、导出复习卡。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callOp } from '@/core/shared/client';
import { errorTextOf } from '@/core/shared/errors';
import { hasBiliTranscriptKey } from '@/core/shared/mediaRef';
import { collectTagCounts } from '@/core/shared/tags';
import { buildTagStats, buildTagStatsCsv, computeTagTrend, lastTagDoneAt, listTagDoneInWindow, type TagStatRow } from '@/core/shared/tagStats';
import { buildFavoritesCsv } from '@/core/export/csv';
import { buildGroupedNotesMarkdown } from '@/core/export/notes';
import type { FavoriteEntity, FavoriteType, ReviewJobEntity, TagEntity } from '@/core/shared/types';
import { reviewBadgeForJob, type ReviewBadge } from '@/core/plan/reviewBadge';
import { formatBytes, formatClock, formatCount99, formatMonthDay, formatPercent, localDayKey, nextMenuFocusIndex, safeJsonParseStringArray } from '@/core/shared/utils';
import { pushToast, Button, ConfirmButton, EmptyIllustration, EmptyState, Modal, Progress, SectionHead, SkeletonRows, cx, useDismissable, useEscapeClose } from '../components';
import { Icon } from '../icons';
import { BiliImportModal } from '../BiliImportModal';
import { BiliSubtitlePanel } from '../BiliSubtitlePanel';
import { FAVORITE_META, VideoFavCard, videoBvidOf } from '../VideoFavCard';
import { FavoriteEditModal } from '../FavoriteEditModal';
import { downloadTextFile, exportReviewCards } from '../reviewCards';
import { uiStore, useUiStore } from '../store';
import { emptySearchTip, pushRecentQuery, recentQueryLabel, removeRecentQuery, RECENT_QUERY_CAP } from './recentQueries';
import type { BundleData } from './shared';

// ───────────────────────── 知识库 ─────────────────────────

/** 本地日期 → 'YYYY-MM-DD'（标签统计周窗口计算用，第 134 轮巡检） */
function dateKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 最近完成相对时间（第 155 轮巡检）：1 小时内 / N 小时前 / N 天前 / 超一周回落 MM/DD；脏值 — */
function relativeDoneLabel(ts: number | undefined): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return '—';
  const diff = Date.now() - ts;
  if (diff < 0) return '—';
  if (diff < 3_600_000) return '1 小时内';
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 删除时间相对化（第 219 轮巡检）：今天 / N 天前 / 超一周回落日期 */
function deletedAgoLabel(deletedAt: number): string {
  const days = Math.floor((Date.now() - deletedAt) / 86_400_000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  return new Date(deletedAt).toLocaleDateString();
}

/** 统计窗口说明卡文案（第 179 轮巡检：集中常量，为 i18n 预留；第 250 轮审计修齐：
 *  趋势窗口第 135 轮起可切 4/8/12 周，文案不再写死「近 4 周」而随 tagTrendWeeks 实时反映） */
const WINDOW_NOTE_TITLE = '统计窗口';
const windowNoteWindows = (trendWeeks: number, staleWindowDays: number): string =>
  `趋势柱＝近 ${trendWeeks} 周 · 健康度＝近 ${staleWindowDays} 天（设置可调）。`;
/** 第 250 轮审计修齐：列清单补上「趋势」列（第 130/135 轮起的近 N 周迷你柱列，
 *  原清单漏列——列数与实际行内单元格一一核对） */
const WINDOW_NOTE_COLUMNS = '列：收藏 · 复习中 · 已完成 · 完成率 · 趋势 · 本周 · 最近完成；点行按该标签筛选。';

// hasBiliTranscriptKey（transcripts 主键前缀匹配判定字幕就绪）第 36 轮抽到
// @/core/shared/mediaRef 共享：本视图与 B 站学习中心面板（BiliHubPanel）同口径复用。

export function LibraryView({ data }: { data: BundleData }) {
  const [type, setType] = useState<FavoriteType | 'all'>('all');
  const [folder, setFolder] = useState<string | 'all'>('all');
  // 标签筛选（第 82 轮巡检）：null = 全部标签；候选取自当前收藏的高频标签
  const [tag, setTag] = useState<string | null>(null);
  // 批量整理（第 88 轮巡检）：多选 → 批量移动文件夹 / 批量删除（进回收站）
  const [tidyMode, setTidyMode] = useState(false);
  // 整理模式勾选（第 88 轮巡检）：多选 → 批量移动文件夹 / 批量删除；第 173 轮起会话内保留
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() =>
    new Set(safeJsonParseStringArray(sessionStorage.getItem('hdu-tidy-selected'))),
  );
  // 勾选变化同步 sessionStorage（第 173 轮巡检）：切视图不丢
  useEffect(() => {
    try {
      sessionStorage.setItem('hdu-tidy-selected', JSON.stringify([...selectedIds]));
    } catch {
      /* 存储不可用时跳过 */
    }
  }, [selectedIds]);
  const [tidyFolder, setTidyFolder] = useState('');
  // 批量打标签（第 89 轮巡检）
  const [tidyTags, setTidyTags] = useState('');
  // 批量操作撤销（第 90 轮巡检）：记录上一次批量移动/打标签前的条目状态
  const [lastBatch, setLastBatch] = useState<Array<{ id: string; folderId: string | null; tags: string[] }> | null>(null);
  const [query, setQuery] = useState('');
  // 最近搜索（第 303 轮，检索域）：与统一搜索 / B 站字幕共用 settings.ui.recentQueries——
  // 输入停顿 800ms 记录一条（去重前移、最多 5 条）；搜索词为空时在输入框下方回放 chips，
  // 点击即重搜、可单条删除（TopBarSearch.persistRecent 同款落盘通道）
  const recentQueries = useUiStore().settings?.ui?.recentQueries ?? [];
  const persistRecent = useCallback((next: string[]) => {
    const current = uiStore.getState().settings;
    const ui = { ...current.ui, recentQueries: next };
    uiStore.patch({ settings: { ...current, ui } });
    void uiStore.actions.saveSetting('ui', ui);
  }, []);
  useEffect(() => {
    const kw = query.trim();
    if (!kw) return;
    const timer = window.setTimeout(() => {
      const prev = uiStore.getState().settings?.ui?.recentQueries ?? [];
      const next = pushRecentQuery(prev, kw, RECENT_QUERY_CAP);
      if (JSON.stringify(prev) !== JSON.stringify(next)) persistRecent(next);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [query, persistRecent]);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<FavoriteEntity | null>(null);
  // 标签管理（第 124 轮巡检）：注册表标签的重命名 / 合并（tag.list / tag.rename / tag.merge op；
  // op 与 repo 能力第 24 轮前已备，本轮接入 UI）。改名 / 合并后整库刷新（data.reload）。
  const [tagManageOpen, setTagManageOpen] = useState(false);
  const [tagRows, setTagRows] = useState<TagEntity[]>([]);
  const [tagLoading, setTagLoading] = useState(false);
  const [renamingTag, setRenamingTag] = useState<{ id: string; name: string } | null>(null);
  const [mergingTag, setMergingTag] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState('');
  const [tagBusy, setTagBusy] = useState(false);
  // 标签统计看板（第 125 轮巡检）：每标签 收藏/复习中/完成 收藏数（打开时经 review.list 现取）
  const [tagStatsOpen, setTagStatsOpen] = useState(false);
  const [tagStatsRows, setTagStatsRows] = useState<TagStatRow[] | null>(null);
  const [tagStatsLoading, setTagStatsLoading] = useState(false);
  const [tagWeekRows, setTagWeekRows] = useState<Array<{ tag: string; done: number }>>([]);
  // 仅看未打标（第 133 轮巡检）：与标签统计面板的未打标提示联动
  const [untaggedOnly, setUntaggedOnly] = useState(false);
  // 近 4 周趋势（第 130 轮巡检）：index 0 = 最旧 … 末位 = 本周（旧 → 新）；
  // 第 135 轮起窗口可切 4/8/12 周；第 136 轮起窗口选择持久化（settings.ui.tagTrendWeeks）
  const [tagTrend, setTagTrend] = useState<Array<Array<{ tag: string; done: number }>>>([]);
  const [tagTrendWeeks, setTagTrendWeeksState] = useState<4 | 8 | 12>(() => {
    const stored = uiStore.getState().settings.ui?.tagTrendWeeks;
    return stored === 8 || stored === 12 ? stored : 4;
  });
  const setTagTrendWeeks = useCallback((weeks: 4 | 8 | 12) => {
    setTagTrendWeeksState(weeks);
    const settings = uiStore.getState().settings;
    const ui = { ...settings.ui, tagTrendWeeks: weeks };
    uiStore.patch({ settings: { ...settings, ui } });
    void uiStore.actions.saveSetting('ui', ui);
  }, []);
  // 趋势柱点选明细（第 134 轮巡检）：点柱查看该标签该周的已完成作业
  const [tagJobs, setTagJobs] = useState<Array<{ favoriteId?: unknown; status?: unknown; updatedAt?: unknown; favorite?: { snapshot?: { title?: unknown } } | null } | null>>([]);
  const [trendDetail, setTrendDetail] = useState<{ tag: string; weekIdx: number } | null>(null);
  // 标签搜索（第 134 轮巡检）：统计面板内按标签名过滤
  const [tagStatsQuery, setTagStatsQuery] = useState('');
  // 回收站搜索防抖（第 176 轮巡检；第 203 轮时长抽常量）：输入即时回显，150ms 后生效过滤
  const TRASH_SEARCH_DEBOUNCE_MS = 150;
  const [trashQueryDraft, setTrashQueryDraft] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setTrashQuery(trashQueryDraft), TRASH_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [trashQueryDraft]);
  // 删除时间排序（第 176 轮巡检）：最新删除优先 / 最早删除优先；第 177 轮起随设置持久化
  const [trashSort, setTrashSortState] = useState<'newest' | 'oldest'>(() => {
    const stored = uiStore.getState().settings.ui?.trashSort;
    return stored === 'oldest' ? 'oldest' : 'newest';
  });
  const setTrashSort = useCallback((sort: 'newest' | 'oldest') => {
    setTrashSortState(sort);
    const settings = uiStore.getState().settings;
    const ui = { ...settings.ui, trashSort: sort };
    uiStore.patch({ settings: { ...settings, ui } });
    void uiStore.actions.saveSetting('ui', ui);
  }, []);
  // 只看零完成（第 158 轮巡检）：统计面板内聚焦近 4 周零完成的标签
  const [staleOnly, setStaleOnly] = useState(false);
  // 回收站多选（第 164 轮巡检）：勾选条目批量还原；第 166 轮起会话内保留（sessionStorage，切视图不丢）
  const [trashSelected, setTrashSelected] = useState<Set<string>>(() => {
    try {
      // 第 167 轮起经 safeJsonParseStringArray 防御式解析（非法 JSON/非数组回退空）
      return new Set(safeJsonParseStringArray(sessionStorage.getItem('hdu-trash-selected')));
    } catch {
      return new Set<string>();
    }
  });
  // 回收站搜索框引用（第 202 轮巡检）：清空搜索后聚焦
  const trashSearchRef = useRef<HTMLInputElement | null>(null);
  const updateTrashSelected = useCallback((nextOrUpdater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    setTrashSelected((prev) => {
      const next = typeof nextOrUpdater === 'function' ? nextOrUpdater(prev) : nextOrUpdater;
      try {
        sessionStorage.setItem('hdu-trash-selected', JSON.stringify([...next]));
      } catch {
        /* 存储不可用时仅保留内存态 */
      }
      return next;
    });
  }, []);
  // 批量操作下拉（第 168 轮巡检）：收纳还原/还原并复习/彻底删除三类批量操作
  const [batchMenuOpen, setBatchMenuOpen] = useState(false);
  // 待确认的批量操作（第 168 轮巡检）：>10 项还原类与彻底删除需横幅确认
  const [pendingBatchConfirm, setPendingBatchConfirm] = useState<'restore' | 'plan' | 'purge' | 'purgeAll' | null>(null);
  // 清空后的空态反馈（第 247 轮巡检，数据安全域）：清空回收站成功后置位，
  // 空态文案随之切换为「已永久删除」确认反馈；重新拉到条目 / 重新打开回收站即复位
  const [trashJustPurged, setTrashJustPurged] = useState(false);
  // 批量操作结果反馈条（第 194 轮巡检）：完成后在横幅位置短暂显示结果摘要（3s 自动消失）
  const [batchResult, setBatchResult] = useState<string | null>(null);
  // 结果条附操作时间（第 218 轮巡检）：HH:mm 随操作时刻记录。
  // 注意：这里必须调用 setBatchResult——若误写成 showBatchResult 会无限递归（RangeError），
  // 成功反馈全部损坏、后续 loadTrash 不执行（第 221 轮巡检定位的回收站 e2e 失败根因）。
  const showBatchResult = useCallback((message: string) => {
    const now = new Date();
    const pad2 = (n: number) => String(n).padStart(2, '0');
    setBatchResult(`${message}（${pad2(now.getHours())}:${pad2(now.getMinutes())}）`);
  }, []);
  // 批量操作耗时文案（第 222 轮巡检）：附「用时 X.Xs」辅助大批量体感；<0.1s 的瞬时操作不显示，避免噪声
  const withElapsed = useCallback((message: string, startedAt: number): string => {
    const sec = (Date.now() - startedAt) / 1000;
    return sec >= 0.1 ? `${message} · 用时 ${sec.toFixed(1)}s` : message;
  }, []);
  // 失败结果条附重试（第 197 轮巡检）：失败摘要在结果条展示时可直接重试批量操作
  const [batchRetryPending, setBatchRetryPending] = useState(false);
  // 结果条淡出（第 218 轮巡检）：自动消失前先淡出 200ms
  const [batchResultFading, setBatchResultFading] = useState(false);
  // 结果条出现时滚动到可见（第 198 轮巡检）：长列表中不丢失反馈
  const batchResultRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (batchResult) batchResultRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [batchResult]);
  // 结果条 Esc 关闭（第 200 轮巡检）：按 Esc 可关闭结果条（确认横幅优先级更高，其打开时不响应）
  useEffect(() => {
    if (!batchResult || pendingBatchConfirm) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setBatchResult(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [batchResult, pendingBatchConfirm]);
  // 批量操作进度（第 168 轮巡检）：逐项执行时显示 done/total
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  // 确认横幅 10 秒无操作自动取消（第 183 轮巡检）：避免长挂遮挡列表
  useEffect(() => {
    if (!pendingBatchConfirm) return;
    const timer = window.setTimeout(() => setPendingBatchConfirm(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [pendingBatchConfirm]);
  // 批量操作结果反馈条自动消失（第 194 轮巡检；第 199 轮失败摘要停留 6s，成功 3s；第 218 轮消失前淡出 200ms）
  useEffect(() => {
    if (!batchResult) return;
    const ms = batchResult.startsWith('⚠') ? 6_000 : 3_000;
    const timer = window.setTimeout(() => {
      setBatchResultFading(true);
      window.setTimeout(() => {
        setBatchResult(null);
        setBatchResultFading(false);
      }, 200);
    }, ms);
    return () => window.clearTimeout(timer);
  }, [batchResult]);
  // 批量菜单容器（第 183 轮巡检）：Tab 圈闭容器引用
  const batchMenuRef = useRef<HTMLDivElement | null>(null);
  // 发起按钮引用（第 184 轮巡检）：菜单/横幅关闭后焦点回归
  const batchTriggerRef = useRef<HTMLButtonElement | null>(null);
  const batchMenuWasOpenRef = useRef(false);
  // 鼠标打开标记（第 185 轮巡检）：鼠标点击打开的菜单/横幅关闭后不抢焦点（仅键盘路径回归）
  const batchMouseOpenedRef = useRef(false);
  useEffect(() => {
    if (!batchMenuOpen && batchMenuWasOpenRef.current) {
      // 菜单从打开→关闭：仅键盘路径（Enter/Space 打开）才回归焦点，鼠标路径不抢焦点
      if (!batchMouseOpenedRef.current) batchTriggerRef.current?.focus();
      batchMouseOpenedRef.current = false;
    }
    batchMenuWasOpenRef.current = batchMenuOpen;
  }, [batchMenuOpen]);
  useEffect(() => {
    if (!pendingBatchConfirm && batchMenuWasOpenRef.current) {
      if (!batchMouseOpenedRef.current) batchTriggerRef.current?.focus();
    }
  }, [pendingBatchConfirm]);
  // 连续部分失败计数（第 171 轮巡检）：≥3 次提示改走单条排查；第 172 轮起随设置持久化
  const [batchRetryCount, setBatchRetryCountState] = useState(() => uiStore.getState().settings.ui?.batchRetryCount ?? 0);
  const setBatchRetryCount = useCallback((count: number) => {
    setBatchRetryCountState(count);
    const settings = uiStore.getState().settings;
    const ui = { ...settings.ui, batchRetryCount: count };
    uiStore.patch({ settings: { ...settings, ui } });
    void uiStore.actions.saveSetting('ui', ui);
  }, []);
  // 导出预览（第 164 轮巡检）：点「导出 CSV」先弹层预览内容与行数，确认后落盘
  const [exportPreview, setExportPreview] = useState<{ name: string; content: string } | null>(null);
  // 统计窗口说明卡折叠（第 165 轮巡检）：默认展开，收起后仅保留一行标题；第 166 轮起随设置持久化
  const [windowNoteOpen, setWindowNoteOpen] = useState(() => uiStore.getState().settings.ui?.windowNoteOpen ?? true);
  const setWindowNoteOpenPersisted = useCallback(
    (open: boolean) => {
      setWindowNoteOpen(open);
      const settings = uiStore.getState().settings;
      const ui = { ...settings.ui, windowNoteOpen: open };
      uiStore.patch({ settings: { ...settings, ui } });
      void uiStore.actions.saveSetting('ui', ui);
    },
    [],
  );
  // 说明卡 Esc 收起（第 201 轮巡检；第 207 轮改用 useEscapeClose 共享 hook）：按 Esc 收起说明卡
  //（确认横幅/结果条/批量进度优先；且要求最近 5 秒内用户与页面有交互，避免误触）
  const lastPanelInteractionRef = useRef(0);
  const windowNoteToggleRef = useRef<HTMLButtonElement | null>(null);
  const windowNoteContentRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const mark = (): void => {
      lastPanelInteractionRef.current = Date.now();
    };
    document.addEventListener('mousedown', mark);
    document.addEventListener('keydown', mark);
    return () => {
      document.removeEventListener('mousedown', mark);
      document.removeEventListener('keydown', mark);
    };
  }, []);
  useEscapeClose(
    windowNoteOpen && !pendingBatchConfirm && !batchResult && !batchProgress,
    () => {
      // 交互前提：最近 5 秒内用户与页面有交互才收起（避免打开面板误触）；
      // 收起渲染后焦点到「展开」按钮（第 208 轮巡检，键盘用户不迷路）
      if (Date.now() - lastPanelInteractionRef.current < 5_000) {
        setWindowNoteOpenPersisted(false);
        window.setTimeout(() => windowNoteToggleRef.current?.focus(), 0);
      }
    },
  );
  // 每标签最近完成时间（第 155 轮巡检）：面板行内显示相对时间 + 第 156 轮「按最近完成」排序，与 CSV 最近完成列同数据源
  const lastDoneMap = useMemo(() => lastTagDoneAt(tagJobs, data.favorites), [tagJobs, data.favorites]);
  // 健康度窗口（第 159 轮设置可配；第 160 轮起面板健康度口径与之统一）
  const [staleWindowDays, setStaleWindowDays] = useState(() => uiStore.getState().settings.ui?.staleWindowDays ?? 28);
  const staleCutoff = Date.now() - staleWindowDays * 86_400_000;
  // 第 126 轮：统计排序键（收藏数 / 复习中 / 完成率）——纯前端重排；
  // 第 139 轮起排序选择持久化（settings.ui.tagStatsSort，跨打开保留）；
  // 第 156 轮起增「按最近完成」档（久未复习 / 从未完成的标签排前）
  const [tagStatsSort, setTagStatsSortState] = useState<'favorites' | 'reviewing' | 'doneRate' | 'lastDone'>(() => {
    const stored = uiStore.getState().settings.ui?.tagStatsSort;
    return stored === 'reviewing' || stored === 'doneRate' || stored === 'lastDone' ? stored : 'favorites';
  });
  const setTagStatsSort = useCallback((key: 'favorites' | 'reviewing' | 'doneRate' | 'lastDone') => {
    setTagStatsSortState(key);
    const settings = uiStore.getState().settings;
    const ui = { ...settings.ui, tagStatsSort: key };
    uiStore.patch({ settings: { ...settings, ui } });
    void uiStore.actions.saveSetting('ui', ui);
  }, []);
  // 说明卡 Esc 收起（第 201 轮巡检）：按 Esc 收起说明卡（确认横幅/结果条优先，其打开时不响应）
  useEffect(() => {
    if (!windowNoteOpen || pendingBatchConfirm || batchResult || batchProgress) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setWindowNoteOpenPersisted(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [windowNoteOpen, pendingBatchConfirm, batchResult, batchProgress, setWindowNoteOpenPersisted]);

  const tagStatsSorted = useMemo(() => {
    const rows = [...(tagStatsRows ?? [])];
    if (tagStatsSort === 'reviewing') rows.sort((a, b) => b.reviewing - a.reviewing || b.favorites - a.favorites);
    else if (tagStatsSort === 'doneRate')
      rows.sort((a, b) => b.done / Math.max(1, b.favorites) - a.done / Math.max(1, a.favorites) || b.favorites - a.favorites);
    else if (tagStatsSort === 'lastDone') {
      // 久未复习排前（第 156 轮巡检）：最近完成时间早者在前；从未完成（无记录）视为最久，排最前
      const tsOf = (tag: string): number => lastDoneMap.get(tag) ?? 0;
      rows.sort((a, b) => tsOf(a.tag) - tsOf(b.tag) || b.favorites - a.favorites);
    }
    // 只看零完成（第 158 轮巡检；第 160 轮起口径统一为 staleWindowDays 窗口：最近完成早于窗口起点）
    const focused = staleOnly
      ? rows.filter((row) => row.done > 0 && (lastDoneMap.get(row.tag) ?? 0) < staleCutoff)
      : rows;
    // 面板内标签搜索（第 134 轮巡检）：标签多时快速定位（大小写不敏感）
    const q = tagStatsQuery.trim().toLowerCase();
    const byQuery = q ? focused.filter((row) => row.tag.toLowerCase().includes(q)) : focused;
    return byQuery;
  }, [tagStatsRows, tagStatsSort, tagStatsQuery, lastDoneMap, staleOnly, staleCutoff]);
  // 趋势柱点选明细（第 134 轮巡检；第 137 轮附周区间）：该标签在该周窗口内完成的作业（标题 + 完成时间）
  const trendDetailData = useMemo(() => {
    if (!trendDetail) return null;
    const now = new Date();
    const day = (now.getDay() + 6) % 7;
    const weeksBack = tagTrend.length - 1 - trendDetail.weekIdx;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day - weeksBack * 7);
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    const rows = listTagDoneInWindow(tagJobs, data.favorites, trendDetail.tag, dateKeyOf(monday), dateKeyOf(sunday));
    const favCount = data.favorites.filter((fav) => Array.isArray(fav?.tags) && fav.tags.includes(trendDetail.tag)).length;
    return {
      rows,
      rangeLabel: `${dateKeyOf(monday).slice(5)} ~ ${dateKeyOf(sunday).slice(5)}`,
      rate: favCount > 0 ? Math.round((rows.length / favCount) * 100) : 0,
      favCount,
    };
  }, [trendDetail, tagJobs, data.favorites, tagTrend.length]);
  // 复制明细（第 138 轮巡检）：趋势柱点选弹层的内容进剪贴板
  const copyTrendDetail = useCallback(async () => {
    if (!trendDetail || !trendDetailData) return;
    const lines = [
      `「${trendDetail.tag}」完成明细（${trendDetailData.rangeLabel}，共 ${trendDetailData.rows.length} 项）`,
      ...trendDetailData.rows.map((row) => `- ${row.title}（${row.doneAt}）`),
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      pushToast('已复制完成明细', 'success');
    } catch {
      pushToast('复制失败：剪贴板未授权', 'error');
    }
  }, [trendDetail, trendDetailData]);
  // 导出该周 CSV（第 143 轮巡检）：趋势柱点选弹层的内容落盘
  const exportTrendDetailCsv = useCallback(() => {
    if (!trendDetail || !trendDetailData) return;
    const csv = [
      '标签,标题,完成时间,统计窗口',
      ...trendDetailData.rows.map((row) => `${trendDetail.tag},${row.title},${row.doneAt},${trendDetailData.rangeLabel}`),
    ].join('\n');
    downloadTextFile(`智慧课堂-标签完成明细-${trendDetail.tag}-${localDayKey()}.csv`, csv, 'text/csv');
    pushToast('已导出该周完成明细 CSV', 'success');
  }, [trendDetail, trendDetailData]);
  // 「加入复习」busy 守卫（第 38 轮巡检，与 B 站学习中心 BiliHubPanel 同型）：同一收藏
  // 的复习请求进行中忽略重复点击，防止并发双击重复入计划（repo planReview 先 cancel
  // 再 put，串行重复点击只是重置计划、无副作用，守卫只拦同一收藏的并发双击）
  const reviewingIdRef = useRef<string | null>(null);
  // 关窗回调固定引用：store 变化重渲染时不会让 Modal 的焦点副作用反复重跑
  const closeEditing = useCallback(() => setEditing(null), []);
  const actions = uiStore.actions;
  // ── B 站视频字幕就绪状态（第 15 轮收口；第 16 轮改键集合前缀匹配） ──
  // transcripts store 已有该 bvid 字幕（P1 裸键或 p≥2 分 P 键）→ 卡片显示「字幕已就绪」徽标
  // 与查看入口。transcript.keys 一次取全库主键（仅键不载正文，开销低于逐个 transcript.get
  // 拉正文），UI 侧按 bvid 前缀匹配；点开「查看字幕」时由 BiliSubtitlePanel 自行读取正文。
  const [subReady, setSubReady] = useState<ReadonlySet<string>>(() => new Set<string>());
  // 复习状态徽标（第 244 轮巡检，升级第 102 轮 review.due「复习中」孤岛 chip）：
  // 每收藏最近到期（最早 dueDate）的 pending 作业——reviewBadgeForJob 按到期日分色
  const [reviewDueByFav, setReviewDueByFav] = useState<Map<string, ReviewJobEntity>>(new Map());
  // 有过复习作业（任意状态）的收藏 id：区分「未入计划」与「计划已走完」（后者不标，
  // 由「上次复习」chip 承接反馈），口径与第 229 轮筛选计数同源互补
  const [hasAnyReviewIds, setHasAnyReviewIds] = useState<Set<string>>(new Set());
  // 上次复习完成时间（第 224 轮巡检）：review.list 已完成作业按收藏取最近一次 → 'MM/DD'
  const [lastReviewDoneLabels, setLastReviewDoneLabels] = useState<Map<string, string>>(new Map());
  // 复习状态筛选（第 228 轮巡检，对齐 B 站学习中心）：全部 / 复习中 / 未入计划（全量 pending 作业归属）
  const [reviewAnyIds, setReviewAnyIds] = useState<Set<string>>(new Set());
  const [reviewFilter, setReviewFilter] = useState<'all' | 'reviewing' | 'none'>('all');
  // 课程筛选（第 318 轮，功能域）：按收藏所属课程（courId）过滤收藏卡片；课程名随 course.bundles 装载
  const [favCourse, setFavCourse] = useState<number | 'all'>('all');
  const [courseNameByCour, setCourseNameByCour] = useState<Record<number, string>>({});
  // 知识库列表渐进显示（第 225 轮巡检）：大收藏量下避免一次性全量渲染；筛选/搜索变化即重置
  // （重置 effect 紧跟 filtered 声明之后，避免 TDZ）
  const [visibleLimit, setVisibleLimit] = useState(60);
  // 滚动近底自动追加（第 283 轮，性能/可用性域）：哨兵元素接近视口时自动追加 60 条，
  // 保留「显示更多」按钮作为显式兜底（无 IntersectionObserver 的环境按钮仍可用）；
  // observer effect 紧跟 filtered 声明之后（避免 TDZ）
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  // 搜索框引用（第 285 轮）：× 清空后焦点回归输入框（四端一致）
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [subBvid, setSubBvid] = useState<string | null>(null);
  const [subP, setSubP] = useState<number | undefined>(undefined);
  const videoBvidsKey = useMemo(
    () => [...new Set(data.favorites.map(videoBvidOf).filter(Boolean))].join(','),
    [data.favorites],
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
      const bvids = videoBvidsKey.split(',');
      const ready = new Set<string>();
      for (const bvid of bvids) {
        if (hasBiliTranscriptKey(keys, bvid)) ready.add(bvid);
      }
      setSubReady(ready);
    })();
    return () => {
      cancelled = true;
    };
  }, [videoBvidsKey]);

  // 上次复习完成时间（第 224 轮巡检）+ 复习状态数据源（第 244 轮巡检合并三份一次取齐）：
  // review.list 单次往返同时构建——①done 作业按收藏取最近一次 → 「上次复习 MM/DD」；
  // ②每收藏最早到期的 pending 作业 → 复习状态徽标（reviewBadgeForJob 分色）；
  // ③全量 pending 归属（reviewAnyIds，第 228 轮筛选）与任意状态归属（hasAnyReviewIds，
  //  区分「未入计划」与「计划已走完」）。原第 102 轮 review.due 独立往返在此收编
  //  （徽标口径升级为全量 pending + 到期日分色，信息超集，少一次 op 往返）
  useEffect(() => {
    let cancelled = false;
    callOp('review.list', {})
      .then((jobs) => {
        if (cancelled) return;
        const latest = new Map<string, number>();
        const dueByFav = new Map<string, ReviewJobEntity>();
        const anyIds = new Set<string>();
        const pendingIds = new Set<string>();
        for (const job of jobs) {
          if (!job || typeof job.favoriteId !== 'string') continue;
          anyIds.add(job.favoriteId);
          if (job.status === 'pending') {
            pendingIds.add(job.favoriteId);
            const prev = dueByFav.get(job.favoriteId);
            // 取最早到期（最紧急）的 pending 作业作徽标依据；脏 dueDate 不入选
            if (!prev || (typeof job.dueDate === 'string' && job.dueDate < prev.dueDate)) dueByFav.set(job.favoriteId, job);
          }
          if (job.status !== 'done' || typeof job.updatedAt !== 'number') continue;
          const prev = latest.get(job.favoriteId);
          if (prev === undefined || job.updatedAt > prev) latest.set(job.favoriteId, job.updatedAt);
        }
        const labels = new Map<string, string>();
        for (const [id, ts] of latest) {
          const label = formatMonthDay(ts);
          if (label) labels.set(id, label);
        }
        setLastReviewDoneLabels(labels);
        setReviewDueByFav(dueByFav);
        setHasAnyReviewIds(anyIds);
        // 复习状态筛选数据源（第 228 轮巡检）：全量 pending 作业的 favoriteIds（不限当日）
        setReviewAnyIds(pendingIds);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // 课程名映射（第 318 轮，功能域）：courId → 课程名（随 course.bundles 装载，失败静默）
  useEffect(() => {
    let cancelled = false;
    callOp('course.bundles', {})
      .then((bundles) => {
        if (cancelled) return;
        const map: Record<number, string> = {};
        for (const bundle of Array.isArray(bundles) ? bundles : []) {
          const name = bundle?.course?.subjName;
          for (const session of Array.isArray(bundle?.sessions) ? bundle.sessions : []) {
            if (session?.courId != null && name) map[session.courId] = name;
          }
        }
        setCourseNameByCour(map);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  // 课程 chips（第 318 轮，功能域）：随收藏聚合（有收藏的课程才出现，按名称升序，带计数）
  const favCourseOptions = useMemo(() => {
    const counts = new Map<number, number>();
    for (const fav of data.favorites) {
      if (fav.courId != null) counts.set(fav.courId, (counts.get(fav.courId) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([courId, count]) => ({ courId, count, name: courseNameByCour[courId] ?? `课程 #${courId}` }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }, [data.favorites, courseNameByCour]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.favorites.filter((fav) => {
      if (type !== 'all' && fav.type !== type) return false;
      if (folder !== 'all' && (fav.folderId ?? '') !== folder) return false;
      if (tag !== null && !fav.tags.includes(tag)) return false;
      // 课程筛选（第 318 轮，功能域）：按收藏所属课程（courId）过滤
      if (favCourse !== 'all' && fav.courId !== favCourse) return false;
      // 仅看未打标（第 133 轮巡检）：标签统计面板的未打标提示点击后联动
      if (untaggedOnly && Array.isArray(fav.tags) && fav.tags.length > 0) return false;
      if (q) {
        const hay = `${fav.snapshot.title} ${fav.snapshot.content} ${fav.note ?? ''} ${fav.tags.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      // 复习状态筛选（第 228 轮巡检）：复习中 = 全量 pending 作业归属；未入计划 = 不在册
      if (reviewFilter === 'reviewing' && !reviewAnyIds.has(fav.id)) return false;
      if (reviewFilter === 'none' && reviewAnyIds.has(fav.id)) return false;
      return true;
    });
  }, [data.favorites, type, folder, tag, favCourse, query, untaggedOnly, reviewFilter, reviewAnyIds]);
  // 滚动近底自动追加（第 283 轮，性能/可用性域）：哨兵元素接近视口时自动追加 60 条
  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el || filtered.length <= visibleLimit) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisibleLimit((v) => v + 60);
      },
      { rootMargin: '240px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [filtered.length, visibleLimit]);
  // 渐进显示重置（第 225 轮巡检）：筛选/搜索/标签变化后回到首批 60 条
  useEffect(() => {
    setVisibleLimit(60);
  }, [filtered]);

  // 复习状态徽标（第 244 轮巡检）：收藏 id → 徽标 | null（null = 不渲染徽标）。
  // 在册 pending → reviewBadgeForJob 分色；有历史但无 pending（计划已走完/全跳过）
  // → null（由「上次复习」chip 承接，避免误标「未入计划」）；从未入计划 → 未入计划徽标
  const reviewBadgeById = useMemo(() => {
    const map = new Map<string, ReviewBadge | null>();
    for (const fav of data.favorites) {
      const job = reviewDueByFav.get(fav.id);
      if (job) map.set(fav.id, reviewBadgeForJob(job));
      else map.set(fav.id, hasAnyReviewIds.has(fav.id) ? null : reviewBadgeForJob(null));
    }
    return map;
  }, [data.favorites, reviewDueByFav, hasAnyReviewIds]);

  // 高频标签（第 82 轮巡检）：当前收藏自动聚合，供标签筛选 chips；第 123 轮起带频次（标签看板）
  const tagCounts = useMemo(() => collectTagCounts(data.favorites, 8), [data.favorites]);
  const topTags = useMemo(() => tagCounts.map((entry) => entry.tag), [tagCounts]);
  const tagTotal = useMemo(() => tagCounts.reduce((sum, entry) => sum + entry.count, 0), [tagCounts]);
  // 标签管理（第 124 轮巡检）：全量标签频次（看板只取前 8，管理弹层按注册表全量展示）
  const countByTag = useMemo(() => {
    const map = new Map<string, number>();
    for (const fav of data.favorites) {
      for (const t of Array.isArray(fav?.tags) ? fav.tags : []) map.set(t, (map.get(t) ?? 0) + 1);
    }
    return map;
  }, [data.favorites]);
  // 编辑弹层标签输入联想（第 124 轮巡检）：放宽到前 30 个高频标签
  const tagSuggestions = useMemo(() => collectTagCounts(data.favorites, 30).map((entry) => entry.tag), [data.favorites]);
  // 未打标收藏数（第 131 轮巡检）：标签统计面板提示补录
  const untaggedCount = useMemo(
    () => data.favorites.filter((fav) => !Array.isArray(fav?.tags) || fav.tags.length === 0).length,
    [data.favorites],
  );
  // ── 标签管理（第 124 轮巡检）──────────────────────────────
  const refreshTagRows = useCallback(async () => {
    const rows = await callOp('tag.list', {});
    setTagRows(Array.isArray(rows) ? rows : []);
  }, []);
  const openTagManage = useCallback(() => {
    setRenamingTag(null);
    setMergingTag(null);
    setTagManageOpen(true);
    setTagLoading(true);
    void (async () => {
      try {
        const rows = await callOp('tag.list', {});
        const known = new Set((Array.isArray(rows) ? rows : []).map((row) => row.name));
        // 打标自动登记：收藏里出现而注册表缺失的标签补建（rename/merge 才能全覆盖看板标签）
        const missing = [...countByTag.keys()].filter((name) => !known.has(name));
        for (const name of missing) {
          try {
            await callOp('tag.create', { name });
          } catch {
            /* 单项登记失败不中断（可能并发已建） */
          }
        }
        const finalRows = missing.length > 0 ? await callOp('tag.list', {}) : rows;
        setTagRows(Array.isArray(finalRows) ? finalRows : []);
      } catch (err) {
        pushToast(errorTextOf(err, '标签列表读取失败'), 'error');
      } finally {
        setTagLoading(false);
      }
    })();
  }, [countByTag]);
  const saveTagRename = useCallback(async () => {
    if (!renamingTag || !renamingTag.name.trim() || tagBusy) return;
    setTagBusy(true);
    try {
      await callOp('tag.rename', { id: renamingTag.id, name: renamingTag.name.trim() });
      pushToast('标签已重命名', 'success');
      setRenamingTag(null);
      await refreshTagRows();
      void data.reload?.();
    } catch (err) {
      pushToast(errorTextOf(err, '重命名失败，请重试'), 'error');
    } finally {
      setTagBusy(false);
    }
  }, [renamingTag, tagBusy, refreshTagRows, data]);
  const confirmTagMerge = useCallback(async () => {
    if (!mergingTag || !mergeTarget || tagBusy) return;
    setTagBusy(true);
    try {
      await callOp('tag.merge', { fromIds: [mergingTag], toId: mergeTarget });
      pushToast('标签已合并', 'success');
      setMergingTag(null);
      setMergeTarget('');
      await refreshTagRows();
      void data.reload?.();
    } catch (err) {
      pushToast(errorTextOf(err, '合并失败，请重试'), 'error');
    } finally {
      setTagBusy(false);
    }
  }, [mergingTag, mergeTarget, tagBusy, refreshTagRows, data]);
  const loadTagStats = useCallback(async () => {
    setTagStatsLoading(true);
    try {
      const jobs = await callOp('review.list', {});
      setTagStatsRows(buildTagStats(data.favorites, jobs, 12));
      setTagJobs(Array.isArray(jobs) ? jobs : []);
      // 本周完成 + 近 N 周趋势（第 129/130/135 轮巡检）：本周一..周日与往前滚动的按标签完成数；
      // 第 144 轮起趋势计算抽为 computeTagTrend 纯函数
      const trend = computeTagTrend(jobs, data.favorites, Date.now(), tagTrendWeeks);
      setTagTrend(trend);
      setTagWeekRows(trend[trend.length - 1] ?? []);
    } catch (err) {
      pushToast(errorTextOf(err, '标签统计读取失败'), 'error');
      setTagStatsRows([]);
    } finally {
      setTagStatsLoading(false);
    }
  }, [data.favorites, tagTrendWeeks]);
  // 标签健康度一键加入复习（第 136 轮巡检）：⚠ 标签的相关收藏重新入计划（review.plan 逐个提交）
  const planTagRefresh = useCallback(
    async (tag: string) => {
      const targets = data.favorites.filter((fav) => Array.isArray(fav?.tags) && fav.tags.includes(tag));
      if (targets.length === 0) return;
      let ok = 0;
      for (const fav of targets) {
        try {
          await callOp('review.plan', { favoriteId: fav.id });
          ok += 1;
        } catch {
          /* 单项失败继续 */
        }
      }
      pushToast(
        ok === targets.length ? `已把「${tag}」的 ${ok} 个收藏加入复习计划` : `已加入 ${ok}/${targets.length} 项（部分失败）`,
        ok > 0 ? 'success' : 'error',
      );
      if (ok > 0) {
        await loadTagStats();
        void data.reload?.();
      }
    },
    [data, loadTagStats],
  );
  // 回收站（第 146 轮巡检）：软删除的收藏列表 + 一键还原；第 147 轮起支持搜索与全部还原；
  // 第 149 轮起支持类型筛选、还原并加入复习、显示自动清理日期
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashRows, setTrashRows] = useState<Array<{ key: string; kind: string; id: string; title: string; deletedAt: number; expiresAt: number }>>([]);
  const [trashQuery, setTrashQuery] = useState('');
  const [trashKindFilter, setTrashKindFilterState] = useState<'all' | 'favorite' | 'note'>(() => {
    const stored = uiStore.getState().settings.ui?.trashKindFilter;
    return stored === 'favorite' || stored === 'note' ? stored : 'all';
  });
  const setTrashKindFilter = useCallback((kind: 'all' | 'favorite' | 'note') => {
    setTrashKindFilterState(kind);
    const settings = uiStore.getState().settings;
    const ui = { ...settings.ui, trashKindFilter: kind };
    uiStore.patch({ settings: { ...settings, ui } });
    void uiStore.actions.saveSetting('ui', ui);
  }, []);
  const [trashRestoring, setTrashRestoring] = useState(false);
  const loadTrash = useCallback(async () => {
    setTrashLoading(true);
    try {
      const rows = await callOp('trash.list', {});
      const nextRows = (Array.isArray(rows) ? rows : []).filter((row) => row.kind === 'favorite');
      setTrashRows(nextRows);
      if (nextRows.length > 0) setTrashJustPurged(false);
    } catch (err) {
      pushToast(errorTextOf(err, '回收站读取失败'), 'error');
      setTrashRows([]);
    } finally {
      setTrashLoading(false);
    }
  }, []);
  const toggleTrash = useCallback(() => {
    // 批量执行中禁用收起（第 170 轮巡检）：避免中途打断导致状态不明
    if (batchProgress) {
      pushToast('批量操作执行中，请稍候', 'warn');
      return;
    }
    setTrashOpen((prev) => {
      const next = !prev;
      if (next) {
        setTrashJustPurged(false); // 第 247 轮：重新打开回收站即复位清空反馈（不留陈旧「已永久删除」空态）
        void loadTrash();
      }
      return next;
    });
  }, [loadTrash, batchProgress]);
  // 回收站续期（第 233 轮巡检）：即将清理的条目一键重置 30 天自动清理期
  const extendTrashItem = useCallback(
    async (key: string) => {
      try {
        await callOp('trash.extend', { key, days: 30 });
        pushToast('已续期 30 天', 'success');
        void loadTrash();
      } catch (err) {
        pushToast(errorTextOf(err, '续期失败，请重试'), 'error');
      }
    },
    [loadTrash],
  );
  // 卡片级删除入口（第 228 轮巡检）：与学习看板同口径——软删除入回收站，toast 附「撤销」一键还原
  const removeFavorite = useCallback(
    async (fav: FavoriteEntity) => {
      await callOp('fav.softDelete', { ids: [fav.id] });
      pushToast('已移入回收站', 'success', 3600, {
        label: '撤销',
        run: async () => {
          await callOp('trash.restore', { keys: [`favorite:${fav.id}`] });
          pushToast('已撤销删除', 'success');
          void data.reload?.();
        },
      });
      void data.reload?.();
    },
    [data],
  );
  const restoreTrashItem = useCallback(
    async (key: string) => {
      try {
        setBatchResult('⏳ 还原中…');
        await callOp('trash.restore', { keys: [key] });
        // 今日待办显性化（第 161 轮巡检）：还原的收藏若在今日待办中，toast 一并说明
        const favId = trashRows.find((row) => row.key === key)?.id;
        const due = await callOp('review.due', { date: localDayKey() }).catch(() => []);
        const inToday = favId != null && Array.isArray(due) && due.some((job) => job?.favoriteId === favId);
        showBatchResult(`✅ ${inToday ? '已还原 · 该收藏在今日待办中' : '已还原'}`);
        await loadTrash();
        void data.reload?.();
        // 还原后刷新今日待办卡（第 159 轮巡检）：跨视图同步
        uiStore.patch({ todoRefreshTick: (uiStore.getState().todoRefreshTick ?? 0) + 1 });
      } catch (err) {
        pushToast(errorTextOf(err, '还原失败，请重试'), 'error');
      }
    },
    [data, loadTrash, trashRows],
  );
  const restoreAllTrash = useCallback(async () => {
    if (trashRows.length === 0) return;
    const startedAt = Date.now();
    setTrashRestoring(true);
    try {
      await callOp('trash.restore', { keys: trashRows.map((row) => row.key) });
      // 今日待办显性化（第 161 轮巡检）：全部还原后统计其中今日到期的条数
      const due = await callOp('review.due', { date: localDayKey() }).catch(() => []);
      const ids = new Set(trashRows.map((row) => row.id));
      const dueCount = Array.isArray(due) ? due.filter((job) => ids.has(job?.favoriteId)).length : 0;
      showBatchResult(
        withElapsed(`✅ ${dueCount > 0 ? `已还原 ${trashRows.length} 项 · ${dueCount} 项在今日待办中` : `已还原 ${trashRows.length} 项`}`, startedAt),
      );
      await loadTrash();
      void data.reload?.();
      // 还原后刷新今日待办卡（第 159 轮巡检）：跨视图同步
      uiStore.patch({ todoRefreshTick: (uiStore.getState().todoRefreshTick ?? 0) + 1 });
    } catch (err) {
      pushToast(errorTextOf(err, '还原失败，请重试'), 'error');
    } finally {
      setTrashRestoring(false);
    }
  }, [trashRows, data, loadTrash]);
  // 批量还原选中（第 164 轮巡检）：勾选条目一键还原，附今日待办状态说明
  const restoreSelectedTrash = useCallback(async () => {
    const keys = [...trashSelected];
    if (keys.length === 0) return;
    const startedAt = Date.now();
    setTrashRestoring(true);
    try {
      await callOp('trash.restore', { keys });
      const due = await callOp('review.due', { date: localDayKey() }).catch(() => []);
      const ids = new Set(trashRows.filter((row) => trashSelected.has(row.key)).map((row) => row.id));
      const dueCount = Array.isArray(due) ? due.filter((job) => ids.has(job?.favoriteId)).length : 0;
      showBatchResult(withElapsed(`✅ ${dueCount > 0 ? `已还原 ${keys.length} 项 · ${dueCount} 项在今日待办中` : `已还原 ${keys.length} 项`}`, startedAt));
      updateTrashSelected(new Set());
      await loadTrash();
      void data.reload?.();
      // 还原后刷新今日待办卡（第 159 轮巡检）：跨视图同步
      uiStore.patch({ todoRefreshTick: (uiStore.getState().todoRefreshTick ?? 0) + 1 });
    } catch (err) {
      pushToast(errorTextOf(err, '还原失败，请重试'), 'error');
    } finally {
      setTrashRestoring(false);
    }
  }, [trashSelected, trashRows, data, loadTrash]);
  // 批量彻底删除选中（第 165 轮巡检）：不可恢复，恒两步确认
  const purgeSelectedTrash = useCallback(async () => {
    const keys = [...trashSelected];
    if (keys.length === 0) return;
    const startedAt = Date.now();
    setTrashPurging(true);
    try {
      await callOp('trash.purge', { keys });
      showBatchResult(withElapsed(`🗑 已彻底删除 ${keys.length} 项`, startedAt));
      updateTrashSelected(new Set());
      await loadTrash();
      void data.reload?.();
    } catch (err) {
      pushToast(errorTextOf(err, '彻底删除失败，请重试'), 'error');
    } finally {
      setTrashPurging(false);
    }
  }, [trashSelected, data, loadTrash]);
  // 导出内容复制（第 165 轮巡检）：预览层一键复制 CSV 文本，不落盘也能带走
  const copyExportPreview = useCallback(async () => {
    if (!exportPreview) return;
    try {
      await navigator.clipboard.writeText(exportPreview.content);
      pushToast('已复制到剪贴板', 'success');
    } catch (err) {
      pushToast(errorTextOf(err, '复制失败，请重试'), 'error');
    }
  }, [exportPreview]);
  // 批量还原并加入复习（第 167 轮巡检）：勾选中的收藏逐个 restore + plan，toast 汇总成功数
  const restoreSelectedAndPlanTrash = useCallback(async () => {
    const rows = trashRows.filter((row) => trashSelected.has(row.key) && row.kind === 'favorite');
    if (rows.length === 0) return;
    const startedAt = Date.now();
    setRestoringPlanKey('__batch__');
    let ok = 0;
    const failedTitles: string[] = [];
    // 逐项进度（第 168 轮巡检）：大批量执行时按钮区显示 done/total（含失败项）
    setBatchProgress({ done: 0, total: rows.length });
    for (const row of rows) {
      try {
        await callOp('trash.restore', { keys: [row.key] });
        await callOp('review.plan', { favoriteId: row.id });
        ok += 1;
      } catch {
        // 部分失败明细（第 169 轮巡检）：记录失败条目标题，toast 点名便于补救
        failedTitles.push(row.title);
      }
      setBatchProgress({ done: ok + failedTitles.length, total: rows.length });
    }
    setBatchProgress(null);
    // 失败项自动保留勾选（第 170 轮巡检）：失败项仍在回收站，勾选不清理即可再次批量重试；
    // 第 171 轮起连续 3 次部分失败提示改走单条排查
    if (failedTitles.length > 0) {
      const nextRetry = batchRetryCount + 1;
      setBatchRetryCount(nextRetry);
      const retryHint = nextRetry >= 3 ? ' · 已连续多次部分失败，建议逐条还原排查' : ' · 已保留勾选可重试';
      // 失败摘要同步到结果条（第 196 轮巡检）：⚠ 前缀走 is-danger 变体，与成功反馈对称
      showBatchResult(withElapsed(`⚠ 已还原并加入复习 ${ok}/${rows.length} 项（部分失败）· 失败：${failedTitles.slice(0, 2).join('、')}${failedTitles.length > 2 ? ' 等' : ''}${retryHint}`, startedAt));
      setBatchRetryPending(true);
      pushToast(
        `已还原并加入复习 ${ok}/${rows.length} 项（部分失败）· 失败：${failedTitles.slice(0, 2).join('、')}${failedTitles.length > 2 ? ' 等' : ''}${retryHint}`,
        ok > 0 ? 'warn' : 'error',
      );
    } else {
      setBatchRetryCount(0);
      setBatchRetryPending(false);
      showBatchResult(withElapsed(`✅ 已还原并加入复习 ${ok} 项`, startedAt));
    }
    if (ok > 0) {
      await loadTrash();
      void data.reload?.();
      // 还原后刷新今日待办卡（第 159 轮巡检）：跨视图同步
      uiStore.patch({ todoRefreshTick: (uiStore.getState().todoRefreshTick ?? 0) + 1 });
    }
    setRestoringPlanKey(null);
  }, [trashSelected, trashRows, data, loadTrash, updateTrashSelected, batchRetryCount]);
  // 勾选中可「还原并复习」的收藏数（第 167 轮巡检）
  const favSelectedCount = trashRows.filter((row) => trashSelected.has(row.key) && row.kind === 'favorite').length;
  // 清空回收站（第 146 轮巡检）：两步确认后清空
  const [trashPurging, setTrashPurging] = useState(false);
  // 彻底删除单条（第 148 轮巡检）：两步确认后永久删除
  const [purgingKey, setPurgingKey] = useState<string | null>(null);
  // 还原并加入复习（第 149 轮巡检）：还原后立即 review.plan
  const [restoringPlanKey, setRestoringPlanKey] = useState<string | null>(null);
  // 当前可见回收站行（第 164 轮巡检）：类型筛选 + 搜索过滤后的行，供全选/列表共用
  const trashVisibleRows = useMemo(
    () =>
      trashRows
        .filter((row) => trashKindFilter === 'all' || row.kind === trashKindFilter)
        .filter((row) => !trashQuery.trim() || row.title.toLowerCase().includes(trashQuery.trim().toLowerCase()))
        .sort((a, b) => (trashSort === 'newest' ? b.deletedAt - a.deletedAt : a.deletedAt - b.deletedAt)),
    [trashRows, trashKindFilter, trashQuery, trashSort],
  );
  // 回收站列表渐进显示（第 226 轮巡检）：与知识库同策略，大数量下先渲染前 60 条
  const [trashVisibleLimit, setTrashVisibleLimit] = useState(60);
  useEffect(() => {
    setTrashVisibleLimit(60);
  }, [trashVisibleRows]);
  // 今日新增统计（第 231 轮巡检）：删除时间为今天的条目数
  const todayNewTrashCount = useMemo(
    () => trashRows.filter((row) => localDayKey(row.deletedAt) === localDayKey()).length,
    [trashRows],
  );
  // 即将清理统计（第 232 轮巡检）：3 天内到期的条目数
  const soonExpireTrashCount = useMemo(
    () => trashRows.filter((row) => row.expiresAt > 0 && row.expiresAt - Date.now() <= 3 * 86_400_000).length,
    [trashRows],
  );
  // 勾选自动清理（第 168 轮巡检）：条目已不在回收站（被还原/删除）时从勾选集剔除，避免计数虚挂
  useEffect(() => {
    const valid = new Set(trashRows.map((row) => row.key));
    updateTrashSelected((prev) => {
      const next = new Set([...prev].filter((key) => valid.has(key)));
      return next.size === prev.size ? prev : next;
    });
  }, [trashRows, updateTrashSelected]);
  // 整理模式勾选自动清理（第 172 轮巡检）：条目被软删除/移出知识库后从勾选中剔除，与回收站勾选对齐
  useEffect(() => {
    const valid = new Set(data.favorites.filter((fav) => !fav?.deletedAt).map((fav) => fav.id));
    setSelectedIds((prev) => {
      const next = new Set([...prev].filter((id) => valid.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [data.favorites]);
  // 批量菜单点击外部关闭 + Esc 关闭 + Tab 圈闭（第 169/174/183 轮巡检；第 177 轮合并为 useDismissable）；
  // 第 211 轮核对：Enter 执行菜单项后经同一路径（batchMenuOpen 跳变）回归发起按钮 ✓
  useDismissable(batchMenuOpen, () => setBatchMenuOpen(false), {
    ignoreSelector: '.hdu-batch-wrap',
    trapContainer: () => batchMenuRef.current,
  });
  // 全选框半选态（第 174 轮巡检）：部分勾选时 indeterminate
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (selectAllRef.current) {
      const selected = trashVisibleRows.filter((row) => trashSelected.has(row.key)).length;
      selectAllRef.current.indeterminate = selected > 0 && selected < trashVisibleRows.length;
    }
  }, [trashVisibleRows, trashSelected]);
  const purgeTrash = useCallback(async () => {
    const startedAt = Date.now();
    setTrashPurging(true);
    try {
      await callOp('trash.purge', {});
      pushToast('回收站已清空，内容已永久删除', 'success');
      showBatchResult(withElapsed('🗑 回收站已清空（内容已永久删除）', startedAt));
      setTrashJustPurged(true); // 第 247 轮：空态文案随之切换为「已永久删除」确认反馈
      await loadTrash();
      void data.reload?.();
    } catch (err) {
      pushToast(errorTextOf(err, '清空失败，请重试'), 'error');
    } finally {
      setTrashPurging(false);
    }
  }, [data, loadTrash]);
  const purgeTrashItem = useCallback(
    async (key: string) => {
      try {
        await callOp('trash.purge', { keys: [key] });
        pushToast('已彻底删除', 'success');
        await loadTrash();
        void data.reload?.();
      } catch (err) {
        pushToast(errorTextOf(err, '彻底删除失败，请重试'), 'error');
      } finally {
        setPurgingKey(null);
      }
    },
    [data, loadTrash],
  );
  const restoreTrashAndPlan = useCallback(
    async (key: string, favoriteId: string) => {
      setRestoringPlanKey(key);
      try {
        await callOp('trash.restore', { keys: [key] });
        const planned = await callOp('review.plan', { favoriteId });
        // 今日到期显性化（第 160 轮巡检）：计划生成的作业有今日及以前到期时，toast 提示已进入今日待办
        const today = localDayKey();
        const dueToday = Array.isArray(planned) && planned.some((job) => typeof job?.dueDate === 'string' && job.dueDate <= today);
        showBatchResult(`✅ ${dueToday ? '已还原并加入复习计划 · 已进入今日待办' : '已还原并加入复习计划'}`);
        await loadTrash();
        void data.reload?.();
        // 还原后刷新今日待办卡（第 159 轮巡检）：跨视图同步
        uiStore.patch({ todoRefreshTick: (uiStore.getState().todoRefreshTick ?? 0) + 1 });
      } catch (err) {
        // 第 255 轮错误文案盘点：泛化兜底「操作失败，请重试」补上下文词——与同视图
        // 其余还原路径（还原失败，请重试）保持同族句式
        pushToast(errorTextOf(err, '还原失败，请重试'), 'error');
      } finally {
        setRestoringPlanKey(null);
      }
    },
    [data, loadTrash],
  );
  // 标签覆盖率（第 151 轮巡检）：已打标收藏 / 全部收藏（数据洞察，与未打标行呼应）
  const tagCoverage = useMemo(() => {
    const total = data.favorites.length;
    const tagged = Math.max(0, total - untaggedCount);
    return { total, tagged, pct: total > 0 ? Math.round((tagged / total) * 100) : 100 };
  }, [data.favorites, untaggedCount]);
  // 覆盖率目标（第 152 轮巡检）：0/缺省 = 不设目标；未达标时覆盖率行与未打标行强调
  const [tagCoverageGoal, setTagCoverageGoal] = useState(() => uiStore.getState().settings.ui?.tagCoverageGoal ?? 0);
  const coverageGap = tagCoverageGoal > 0 ? Math.max(0, Math.ceil((tagCoverageGoal / 100) * tagCoverage.total) - tagCoverage.tagged) : 0;
  const coverageBelowGoal = tagCoverageGoal > 0 && tagCoverage.pct < tagCoverageGoal;
  const tagStatsPanelRef = useRef<HTMLDivElement | null>(null);
  const toggleTagStats = useCallback(() => {
    setTagStatsOpen((prev) => {
      const next = !prev;
      if (next) {
        void loadTagStats();
        // 打开面板后焦点到面板容器（第 215 轮巡检；第 218 轮改为容器——首个控件会随数据加载变化，容器稳定）
        window.setTimeout(() => tagStatsPanelRef.current?.focus(), 0);
        // 覆盖率目标（第 152 轮巡检）：每次打开面板取最新设置（options 页可改）
        const settings = uiStore.getState().settings;
        const goal = settings.ui?.tagCoverageGoal ?? 0;
        setTagCoverageGoal(goal);
        // 健康度窗口（第 160 轮巡检）：面板健康度口径与设置联动
        setStaleWindowDays(settings.ui?.staleWindowDays ?? 28);
        // 首次达标祝贺（第 153 轮巡检）：设了目标、当前已达标且未庆祝过 → toast 一次并登记时间戳
        if (goal > 0 && tagCoverage.total > 0 && tagCoverage.pct >= goal && !settings.ui?.tagCoverageCelebratedAt) {
          pushToast(`🎉 标签覆盖率已达标（${tagCoverage.pct}%），继续保持！`, 'success');
          const ui = { ...settings.ui, tagCoverageCelebratedAt: Date.now() };
          uiStore.patch({ settings: { ...settings, ui } });
          void uiStore.actions.saveSetting('ui', ui);
        }
      }
      return next;
    });
  }, [loadTagStats, tagCoverage]);
  // 标签统计导出 CSV（第 127 轮巡检；第 132 轮起附近 4 周趋势列；第 140 轮起附健康度列；
  // 第 151 轮起附未打标收藏行）：当前排序的统计表一键带走
  const staleTags = useMemo(
    () =>
      (tagStatsRows ?? [])
        .filter((row) => row.done > 0 && tagTrend.every((week) => !week.some((entry) => entry.tag === row.tag && entry.done > 0)))
        .map((row) => row.tag),
    [tagStatsRows, tagTrend],
  );
  // 导出预览（第 164 轮巡检）：点「导出 CSV」先弹层预览内容与行数，确认后落盘
  const buildTagStatsExport = useCallback(() => {
    const now = new Date();
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const sortLabel = tagStatsSort === 'favorites' ? '按收藏' : tagStatsSort === 'reviewing' ? '按复习中' : tagStatsSort === 'doneRate' ? '按完成率' : '按最近完成';
    const filterLabel = staleOnly ? '只看零完成' : untaggedOnly ? '只看未打标' : tag ? `标签 ${tag}` : '全部';
    return {
      name: `智慧课堂-标签统计-${localDayKey()}-${tagStatsSorted.length}标签.csv`,
      content: buildTagStatsCsv(tagStatsSorted, tagTrend, staleTags, untaggedCount, {
        tagged: tagCoverage.tagged,
        total: tagCoverage.total,
        pct: tagCoverage.pct,
        goal: tagCoverageGoal,
        // 导出时间戳（第 157 轮巡检）：多份导出按时间归档
        exportedAt: `${localDayKey()} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
      }, lastDoneMap, {
        sort: sortLabel,
        filter: filterLabel,
        // 覆盖率目标档位（第 163 轮巡检）：完整还原导出语境
        goal: tagCoverageGoal > 0 ? `目标 ${tagCoverageGoal}%` : '未设目标',
      }),
    };
  }, [tagStatsSorted, tagTrend, staleTags, untaggedCount, tagCoverage, tagCoverageGoal, lastDoneMap, tagStatsSort, staleOnly, untaggedOnly, tag]);
  const requestExportCsv = useCallback(() => {
    setExportPreview(buildTagStatsExport());
  }, [buildTagStatsExport]);
  const confirmExportCsv = useCallback(() => {
    if (!exportPreview) return;
    downloadTextFile(exportPreview.name, exportPreview.content, 'text/csv');
    // 导出提示附未打标数（第 156 轮巡检）：落盘内容自我说明
    pushToast(untaggedCount > 0 ? `已导出标签统计 CSV（含未打标 ${untaggedCount} 条）` : '已导出标签统计 CSV', 'success');
    setExportPreview(null);
  }, [exportPreview, untaggedCount]);

  // 汇编范围（第 115 轮巡检）：all=全部 / internal=仅站内 / bili=仅B站
  const [noteScope, setNoteScope] = useState<'all' | 'internal' | 'bili'>('all');
  // 笔记搜索（第 117 轮巡检）：按内容过滤我的笔记（大小写不敏感）
  const [noteQuery, setNoteQuery] = useState('');
  const noteKw = noteQuery.trim().toLowerCase();
  // 笔记课程筛选（第 122 轮巡检）：按所属课程过滤我的笔记（课程名来自课次 bundle；
  // B 站外部笔记无 teclId，选中任一课程时自然只剩站内笔记）
  const [noteCourse, setNoteCourse] = useState('');
  const noteCourseNameByTecl = useMemo(() => {
    const map = new Map<number, string>();
    for (const bundle of data.bundles) {
      const course = bundle.course;
      if (course?.teclId != null) map.set(course.teclId, course.subjName ?? '未命名课程');
    }
    return map;
  }, [data.bundles]);
  const noteCourseOptions = useMemo(() => {
    const seen = new Map<number, string>();
    for (const note of data.notes) {
      if (note.teclId != null && !seen.has(note.teclId)) {
        seen.set(note.teclId, noteCourseNameByTecl.get(note.teclId) ?? '未命名课程');
      }
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1], 'zh'));
  }, [data.notes, noteCourseNameByTecl]);
  const visibleNotes = useMemo(
    () => data.notes.filter(
      (note) =>
        (!noteKw || note.text.toLowerCase().includes(noteKw))
        && (!noteCourse || String(note.teclId ?? '') === noteCourse),
    ),
    [data.notes, noteKw, noteCourse],
  );

  // 笔记汇编分组（第 109 轮巡检；第 112 轮起纳入 B 站外部笔记）：
  // 站内笔记按课程（teclId → 课程名）；B 站笔记按收藏标题（mediaKey → favorite.snapshot.title），
  // 未匹配的归「其他 / B 站笔记」，不丢弃。
  const buildNoteGroups = useCallback(async () => {
    const byTecl = new Map<number, string>();
    for (const bundle of data.bundles) {
      const course = bundle.course;
      if (course?.teclId != null) {
        byTecl.set(course.teclId, `${course.subjName ?? '未命名课程'}${course.semester ? `（${course.semester}）` : ''}`);
      }
    }
    const biliTitleByMediaKey = new Map<string, string>();
    for (const fav of data.favorites) {
      const key = fav.metadata?.mediaKey;
      if (typeof key === 'string' && key) biliTitleByMediaKey.set(key, fav.snapshot.title);
    }
    const all = await callOp('note.listAll', {}).catch(() => data.notes);
    const groups = new Map<string, { kind: 'internal' | 'bili'; notes: Array<{ text: string; anchorTime?: number }> }>();
    for (const note of Array.isArray(all) ? all : []) {
      const record = note as { courId?: number; teclId?: number; mediaKey?: string; text: string; anchorTime?: number };
      const isBili = record.courId == null;
      const label = isBili
        ? (record.mediaKey != null && biliTitleByMediaKey.get(record.mediaKey)) || 'B 站笔记'
        : record.teclId != null && byTecl.has(record.teclId)
          ? byTecl.get(record.teclId)!
          : '其他';
      const entry = groups.get(label) ?? { kind: isBili ? 'bili' : 'internal', notes: [] };
      entry.notes.push({ text: record.text, anchorTime: record.anchorTime });
      groups.set(label, entry);
    }
    return [...groups.entries()]
      .filter(([, group]) => noteScope === 'all' || (noteScope === 'bili' ? group.kind === 'bili' : group.kind === 'internal'))
      .map(([label, group]) => ({ label, notes: group.notes }));
  }, [data.bundles, data.favorites, data.notes, noteScope]);

  // 导出笔记汇编（第 107 轮巡检；第 112 轮起纳入 B 站外部笔记并按组输出）
  const exportNotesAssembly = useCallback(async () => {
    try {
      const groups = await buildNoteGroups();
      downloadTextFile(`智慧课堂-笔记汇编-${localDayKey()}.md`, buildGroupedNotesMarkdown(groups, '全部笔记'));
      pushToast('笔记汇编已导出', 'success');
    } catch (err) {
      pushToast(errorTextOf(err, '导出失败，请重试'), 'error');
    }
  }, [buildNoteGroups]);

  // 复习卡片导出（第 37 轮巡检）：md 口径 / 下载方式 / 成功提示抽到 ./reviewCards 共享，
  // B 站学习中心面板的「导出复习卡」入口复用同一实现；本视图行为不变
  const exportCards = useCallback(() => {
    exportReviewCards(filtered);
  }, [filtered]);

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
    const targets = filtered.filter((fav) => selectedIds.has(fav.id));
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
      if (data.reload) await data.reload();
    } catch (err) {
      pushToast(errorTextOf(err, '批量移动失败'), 'error');
    }
  }, [filtered, selectedIds, tidyFolder, data]);

  const batchDelete = useCallback(async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    try {
      await callOp('fav.softDelete', { ids });
      pushToast(`已删除 ${ids.length} 项（可在学习看板回收站恢复）`, 'success');
      setSelectedIds(new Set());
      setTidyMode(false);
      if (data.reload) await data.reload();
    } catch (err) {
      pushToast(errorTextOf(err, '批量删除失败'), 'error');
    }
  }, [selectedIds, data]);

  // 批量加入复习计划（第 89 轮巡检）：逐项 review.plan，单项失败不中断
  const batchReview = useCallback(async () => {
    const targets = filtered.filter((fav) => selectedIds.has(fav.id));
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
    if (data.reload) await data.reload();
  }, [filtered, selectedIds, data]);

  // 批量打标签（第 89 轮巡检）：输入标签（空格/逗号分隔）并入所选收藏的标签集合
  const batchTag = useCallback(async () => {
    const tags = tidyTags.split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean);
    const targets = filtered.filter((fav) => selectedIds.has(fav.id));
    if (targets.length === 0 || tags.length === 0) return;
    try {
      setLastBatch(targets.map((fav) => ({ id: fav.id, folderId: fav.folderId ?? null, tags: fav.tags })));
      for (const fav of targets) {
        const merged = [...new Set([...fav.tags, ...tags])];
        await callOp('fav.update', { id: fav.id, patch: { tags: merged } });
      }
      pushToast(`已为 ${targets.length} 项添加标签`, 'success');
      setTidyTags('');
      setSelectedIds(new Set());
      setTidyMode(false);
      if (data.reload) await data.reload();
    } catch (err) {
      pushToast(errorTextOf(err, '批量打标签失败'), 'error');
    }
  }, [filtered, selectedIds, tidyTags, data]);

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
      if (data.reload) await data.reload();
    } catch (err) {
      pushToast(errorTextOf(err, '撤销失败'), 'error');
    }
  }, [lastBatch, data]);

  return (
    <>
      <div className="hdu-filterbar">
        <div className="hdu-search">
          <Icon name="search" />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题、内容、标签…"
            aria-label="搜索收藏、笔记与标签"
          />
          {/* 清除搜索（第 268 轮，检索域 / 三端一致）：与统一搜索 × 同款（清词，
              :focus-within 聚焦态由 .hdu-search 共用样式继承）；第 285 轮：清空后
              焦点回归输入框（与统一搜索 / B 站同行为） */}
          {query ? (
            <button
              type="button"
              className="hdu-search-clear"
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
        </div>
        {/* 最近搜索回放（第 303 轮，检索域）：搜索词为空时平铺最近关键词（与统一搜索 /
            B 站字幕同源 settings.ui.recentQueries），点击即重搜、可单条删除 */}
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
                    searchInputRef.current?.focus();
                  }}
                >
                  {recentQueryLabel(q)}
                </button>
                <button
                  type="button"
                  className="hdu-lib-recent-del"
                  aria-label={`删除最近搜索 ${q}`}
                  title="删除该条最近搜索"
                    onClick={() => persistRecent(removeRecentQuery(uiStore.getState().settings?.ui?.recentQueries, q))}
                  >
                    ×
                  </button>
                </span>
              ))}
              <button type="button" className="hdu-lib-recent-clear" onClick={() => { persistRecent([]); searchInputRef.current?.focus(); }}>清空</button>
            </div>
          ) : null}
        <button type="button" className={cx('hdu-filter-pill', type === 'all' ? 'is-active' : '')} onClick={() => setType('all')}>全部</button>
        {(Object.keys(FAVORITE_META) as FavoriteType[]).map((key) => (
          <button type="button" key={key} className={cx('hdu-filter-pill', type === key ? 'is-active' : '')} onClick={() => setType(key)}>
            {FAVORITE_META[key].label}
          </button>
        ))}
        {/* 复习状态筛选（第 228 轮巡检）：全部 / 复习中 / 未入计划（对齐 B 站学习中心第 107 轮）；第 229 轮附全库计数 */}
        <span className="hdu-hint" style={{ flex: 'none' }}>复习</span>
        {([
          ['all', '全部', data.favorites.length],
          ['reviewing', '复习中', reviewAnyIds.size],
          ['none', '未入计划', Math.max(0, data.favorites.length - reviewAnyIds.size)],
        ] as const).map(([key, label, count]) => (
          <button type="button" key={key} className={cx('hdu-filter-pill', reviewFilter === key ? 'is-active' : '')} onClick={() => setReviewFilter(key)}>
            {label}（{count}）
          </button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* 撤销上次批量操作（第 90 轮巡检） */}
          {lastBatch ? (
            <Button size="small" variant="ghost" icon="refresh" onClick={() => void undoLastBatch()}>
              撤销批量
            </Button>
          ) : null}
          <Button size="small" variant="ghost" icon="list" onClick={toggleTidy}>
            {tidyMode ? '退出整理' : '批量整理'}
          </Button>
          <Button size="small" icon="video" onClick={() => setImportOpen(true)}>从 B 站导入</Button>
          <Button size="small" icon="download" onClick={exportCards} disabled={filtered.length === 0}>导出卡片</Button>
          {/* 清单 CSV 导出（第 92 轮巡检）：列口径与看板导出一致 */}
          <Button
            size="small"
            variant="ghost"
            icon="download"
            disabled={filtered.length === 0}
            onClick={() => downloadTextFile(`收藏清单-${localDayKey()}.csv`, buildFavoritesCsv(filtered), 'text/csv;charset=utf-8')}
          >
            导出 CSV
          </Button>
        </div>
      </div>
      {data.folders.length > 0 ? (
        <div className="hdu-folder-row hdu-scroll-x">
          <button type="button" className={cx('hdu-folder', folder === 'all' ? 'is-active' : '')} onClick={() => setFolder('all')}>全部文件夹</button>
          {data.folders.map((f) => (
            <button type="button" key={f.id} className={cx('hdu-folder', folder === f.id ? 'is-active' : '')} onClick={() => setFolder(f.id)}>
              <Icon name="folder" size={13} /> {f.name}
            </button>
          ))}
        </div>
      ) : null}
      {favCourseOptions.length > 0 ? (
        /* 课程筛选（第 318 轮，功能域）：按收藏所属课程过滤（与类型/文件夹/标签筛选叠加）；
           课程清单随收藏聚合（有收藏的课程才出现，按名称升序，带计数） */
        <div className="hdu-folder-row hdu-scroll-x" aria-label="知识库课程筛选">
          <button type="button" className={cx('hdu-folder', favCourse === 'all' ? 'is-active' : '')} onClick={() => setFavCourse('all')}>全部课程</button>
          {favCourseOptions.map(({ courId, name, count }) => (
            <button
              type="button"
              key={courId}
              className={cx('hdu-folder', favCourse === courId ? 'is-active' : '')}
              onClick={() => setFavCourse(favCourse === courId ? 'all' : courId)}
              title={`课程「${name}」：${count} 个收藏`}
            >
              {name} · {count}
            </button>
          ))}
        </div>
      ) : null}
      {topTags.length > 0 ? (
        /* 标签筛选（第 82 轮巡检）：当前收藏自动聚合的高频标签，点选切换（再点取消）；
            第 123 轮起为「标签看板」——chips 带频次（# 标签 · 次数），行首给汇总 */
        <div className="hdu-folder-row hdu-scroll-x" aria-label="知识库标签看板">
          <span className="hdu-hint" style={{ flex: 'none', alignSelf: 'center' }}>标签看板 · 共 {tagTotal} 次打标</span>
          <button type="button" className={cx('hdu-folder', tag === null ? 'is-active' : '')} onClick={() => setTag(null)}>全部标签</button>
          {tagCounts.map(({ tag: t, count }) => (
            <button
              type="button"
              key={t}
              className={cx('hdu-folder', tag === t ? 'is-active' : '')}
              onClick={() => setTag(tag === t ? null : t)}
              title={`标签「${t}」：${count} 个收藏`}
            >
              # {t} · {count}
            </button>
          ))}
          {/* 标签管理（第 124 轮巡检）：重命名 / 合并注册表标签 */}
          <button type="button" className="hdu-folder" onClick={openTagManage} title="重命名或合并标签">
            管理标签
          </button>
          {/* 标签统计（第 125 轮巡检）：每标签 收藏/复习中/完成 收藏数；第 213 轮加 aria-expanded */}
          <button
            type="button"
            className={cx('hdu-folder', tagStatsOpen ? 'is-active' : '')}
            aria-expanded={tagStatsOpen}
            onClick={toggleTagStats}
            title="按标签查看收藏与复习完成情况"
          >
            标签统计
          </button>
        </div>
      ) : null}
      {tagStatsOpen ? (
        <div ref={tagStatsPanelRef} className="hdu-tag-stats" role="region" aria-label="标签统计看板">
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span className="hdu-hint" style={{ flex: 'none' }}>
              排序
            </span>
            {(
              [
                ['favorites', '按收藏'],
                ['reviewing', '按复习中'],
                ['doneRate', '按完成率'],
                ['lastDone', '按最近完成'],
              ] as const
            ).map(([key, label]) => (
              <button
                type="button"
                key={key}
                className={cx('hdu-folder', tagStatsSort === key ? 'is-active' : '')}
                onClick={() => setTagStatsSort(key)}
              >
                {label}
              </button>
            ))}
            {/* 只看零完成（第 158 轮巡检；第 160 轮起窗口随设置）：聚焦窗口内零完成的标签 */}
            <button
              type="button"
              className={cx('hdu-folder', staleOnly ? 'is-active' : '')}
              title={`只看近 ${staleWindowDays} 天零完成的标签`}
              onClick={() => setStaleOnly((prev) => !prev)}
            >
              ⚠ 只看零完成
            </button>
            {/* 趋势窗口（第 135 轮巡检）：近 4/8/12 周切换 */}
            {([4, 8, 12] as const).map((weeks) => (
              <button
                type="button"
                key={weeks}
                className={cx('hdu-folder', tagTrendWeeks === weeks ? 'is-active' : '')}
                onClick={() => {
                  setTagTrendWeeks(weeks);
                  void loadTagStats();
                }}
              >
                近 {weeks} 周
              </button>
            ))}
            {/* 标签搜索（第 134 轮巡检）：标签多时快速定位 */}
            <input
              type="text"
              className="hdu-input"
              value={tagStatsQuery}
              onChange={(e) => setTagStatsQuery(e.target.value)}
              placeholder="搜索标签…"
              aria-label="搜索标签"
              style={{ width: 110 }}
            />
            <Button
              size="small"
              variant="ghost"
              icon="download"
              disabled={!tagStatsRows || tagStatsRows.length === 0}
              title={!tagStatsRows || tagStatsRows.length === 0 ? '暂无标签可导出' : '导出前预览内容与行数'}
              onClick={requestExportCsv}
            >
              导出 CSV
            </Button>
          </div>
          {/* 统计窗口说明卡（第 164 轮巡检；第 165 轮起可折叠；第 179 轮文案常量化）：两个窗口概念 + 列清单合一 */}
          <div className="hdu-window-note">
            <span
              ref={windowNoteContentRef}
              tabIndex={-1}
              style={{ flex: '1 1 auto', minWidth: 0, outline: 'none' }}
            >
              <b>{WINDOW_NOTE_TITLE}</b>：{windowNoteWindows(tagTrendWeeks, staleWindowDays)}
              {windowNoteOpen ? WINDOW_NOTE_COLUMNS : ''}
            </span>
            <button
              type="button"
              ref={windowNoteToggleRef}
              className="hdu-folder"
              aria-expanded={windowNoteOpen}
              onClick={() => {
                const next = !windowNoteOpen;
                setWindowNoteOpenPersisted(next);
                // 展开后焦点到说明内容（第 209 轮巡检，与 Esc 收起后到按钮对称）
                if (next) window.setTimeout(() => windowNoteContentRef.current?.focus(), 0);
              }}
            >
              {windowNoteOpen ? '收起' : '展开'}
            </button>
          </div>
          {/* 标签覆盖率摘要（第 151 轮巡检）：已打标 / 全部收藏 + 进度条（数据洞察）；
              第 152 轮起设了目标且未达标时整行警示强调，附「还差 N 个」 */}
          <div className={cx('hdu-tag-coverage', coverageBelowGoal ? 'is-warning' : '')} aria-label="标签覆盖率">
            <span className="hdu-tag-coverage-label">标签覆盖率{coverageBelowGoal ? `（目标 ${tagCoverageGoal}%）` : ''}</span>
            <span className="hdu-tag-coverage-bar" role="progressbar" aria-valuenow={tagCoverage.pct} aria-valuemin={0} aria-valuemax={100}>
              <i style={{ width: `${tagCoverage.pct}%` }} />
            </span>
            <span className="hdu-tag-coverage-num">
              <b>{tagCoverage.tagged}</b>/{tagCoverage.total}（{tagCoverage.pct}%）
              {coverageBelowGoal ? ` · ⚠ 还差 ${coverageGap} 个` : ''}
            </span>
          </div>
          {/* 未打标收藏行（第 150 轮巡检）：点击联动「只看未打标」筛选；第 152 轮起未达标时同步警示强调 */}
          <button
            type="button"
            className={cx('hdu-tag-manage-row', untaggedOnly ? 'is-active' : '', coverageBelowGoal && untaggedCount > 0 ? 'is-warning' : '')}
            onClick={() => {
              setUntaggedOnly((prev) => !prev);
              setTidyMode(true);
            }}
          >
            <span style={{ flex: '1 1 auto', minWidth: 0, textAlign: 'left' }}>⚠ 未打标收藏（{untaggedCount}）</span>
          </button>
          {tagStatsLoading ? (
            <div className="hdu-hint">统计读取中…</div>
          ) : !tagStatsRows || tagStatsRows.length === 0 ? (
            /* 空态引导（第 157 轮巡检；第 191 轮改用 EmptyIllustration 共享组件）：有收藏无标签 → 一键进整理模式批量打标；无收藏 → 先收藏 */
            <EmptyIllustration
              icon="🏷"
              hint={
                data.favorites.length === 0
                  ? '知识库还没有收藏——先收藏一些视频或知识点。'
                  : '收藏还没打标签，统计暂无数据。'
              }
              action={
                data.favorites.length > 0 ? (
                  <button
                    type="button"
                    className="hdu-folder"
                    onClick={() => {
                      setTagStatsOpen(false);
                      setUntaggedOnly(true);
                      setTidyMode(true);
                    }}
                  >
                    去批量打标
                  </button>
                ) : null
              }
            />
          ) : (
            tagStatsSorted.map((row) => {
              // 健康度（第 160 轮巡检口径统一）：有完成记录但最近完成早于窗口起点（默认近 28 天，可配）
              const isStale = row.done > 0 && (lastDoneMap.get(row.tag) ?? 0) < staleCutoff;
              return (
              <button
                type="button"
                key={row.tag}
                className="hdu-tag-stat-row"
                title={`按标签「${row.tag}」筛选收藏`}
                onClick={() => {
                  setTag(row.tag);
                  setTagStatsOpen(false);
                }}
              >
                <span className="hdu-tag-stat-name" title={row.tag}>
                  # {row.tag}
                  {/* 标签健康度（第 132/136 轮巡检；第 160 轮起窗口随设置可配并与通知口径统一）：
                      有过完成但窗口内零完成 → 一键重新入计划；title 联动最近完成时间。
                      第 319 轮修复：行本身是 <button>，内层交互元素必须用 role="button" 的
                      <span>——此前真实 <button> 嵌套触发 validateDOMNesting 告警（演示数据
                      首次点亮该状态时曝光）；键盘可达性以 tabIndex + Enter/Space 补齐 */}
                  {isStale ? (
                    <span
                      role="button"
                      tabIndex={0}
                      className="hdu-folder"
                      title={`该标签的复习近 ${staleWindowDays} 天没有完成记录（最近完成：${relativeDoneLabel(lastDoneMap.get(row.tag))}）；点击把相关收藏重新加入复习计划`}
                      onClick={() => void planTagRefresh(row.tag)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          void planTagRefresh(row.tag);
                        }
                      }}
                    >
                      ⚠ 近 {staleWindowDays} 天零完成 · 重新入计划
                    </span>
                  ) : null}
                </span>
                <span className="hdu-tag-stat-num">
                  <b>{row.favorites}</b> 收藏
                </span>
                <span className="hdu-tag-stat-num">
                  <b>{row.reviewing}</b> 复习中
                </span>
                <span className="hdu-tag-stat-num">
                  <b>{row.done}</b> 已完成
                </span>
                {/* 完成率（第 136 轮巡检）：已完成 / 收藏数 */}
                <span className="hdu-tag-stat-num">
                  <b>{Math.round((row.done / Math.max(1, row.favorites)) * 100)}%</b>
                </span>
                {/* 近 N 周完成迷你趋势（第 130/135 轮巡检）：左旧右新，柱高随完成数；悬停报数（第 131 轮）、点柱看周明细（第 134 轮） */}
                <span className="hdu-tag-trend" title={`近 ${tagTrend.length} 周完成趋势（左旧右新，点柱看明细）`}>
                  {tagTrend.map((week, weekIdx) => {
                    const done = week.find((entry) => entry.tag === row.tag)?.done ?? 0;
                    const label = weekIdx === tagTrend.length - 1 ? '本周' : `${tagTrend.length - 1 - weekIdx} 周前`;
                    // 第 319 轮修复：行内交互柱同样降级为 role="button"（外层行是 <button>，
                    // 真实 <button> 嵌套触发 validateDOMNesting；键盘可达性同上补齐）
                    return (
                      <span
                        role="button"
                        tabIndex={done > 0 ? 0 : undefined}
                        key={weekIdx}
                        title={done > 0 ? `${label}完成 ${done} 项 · 点击查看明细` : `${label}无完成记录`}
                        aria-label={`${label}完成 ${done} 项`}
                        style={{ height: 3 + Math.min(3, done) * 4 }}
                        className={cx('hdu-trend-bar', weekIdx === tagTrend.length - 1 ? 'is-now' : '')}
                        onClick={
                          done > 0
                            ? (e) => {
                                // 阻止冒泡到统计行（行点击是「按标签筛选」并收起面板）
                                e.stopPropagation();
                                setTrendDetail({ tag: row.tag, weekIdx });
                              }
                            : undefined
                        }
                        onKeyDown={
                          done > 0
                            ? (e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setTrendDetail({ tag: row.tag, weekIdx });
                                }
                              }
                            : undefined
                        }
                      />
                    );
                  })}
                </span>
                <span className="hdu-tag-stat-num">
                  <b>{tagWeekRows.find((week) => week.tag === row.tag)?.done ?? 0}</b> 本周
                </span>
                {/* 最近完成（第 155 轮巡检）：相对时间，与 CSV 最近完成列同口径 */}
                <span className="hdu-tag-stat-num" title={`最近一次复习完成：${relativeDoneLabel(lastDoneMap.get(row.tag))}`}>
                  <b>{relativeDoneLabel(lastDoneMap.get(row.tag))}</b>
                </span>
              </button>
              );
            })
          )}
          {untaggedCount > 0 ? (
            <button
              type="button"
              className={cx('hdu-folder', untaggedOnly ? 'is-active' : '')}
              onClick={() => {
                setUntaggedOnly((prev) => !prev);
                // 联动整理模式（第 134 轮巡检）：进入未打标视图时顺手开整理，勾选即可批量打标
                setTidyMode(true);
              }}
              title="只看还没打标签的收藏（可配合整理模式批量打标）"
            >
              ⚠ 有 {untaggedCount} 个收藏还没打标签 · {untaggedOnly ? '取消查看' : '点击查看'}
            </button>
          ) : null}
        </div>
      ) : null}
      {/* 回收站（第 146 轮巡检）：软删除的收藏，可一键还原；第 171 轮起批量执行中置灰 */}
      <div style={{ marginBottom: 10 }}>
        <button
          type="button"
          className={cx('hdu-folder', trashSelected.size > 0 ? 'is-active' : '')}
          onClick={toggleTrash}
          disabled={!!batchProgress}
          aria-expanded={trashOpen}
          aria-label={
            batchProgress
              ? '回收站（批量操作执行中）'
              : trashSelected.size > 0
                ? '回收站（已勾选 ' + trashSelected.size + ' 项待批量操作）'
                : '打开回收站'
          }
          title={
            batchProgress
              ? '批量操作执行中，请稍候'
              : trashSelected.size > 0
                ? `软删除的收藏可在此还原 · 已勾选 ${trashSelected.size} 项待批量操作`
                : '软删除的收藏可在此还原'
          }
          style={batchProgress ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
        >
          {batchProgress
            ? `⏳ 批量执行中 ${batchProgress.done}/${batchProgress.total}（${formatPercent(batchProgress.done, batchProgress.total)}）`
            : trashSelected.size > 0
              ? null
              : `🗑 回收站${trashRows.length > 0 ? `（${trashRows.length}）` : ''}`}
          {trashSelected.size > 0 && !batchProgress ? (
            <span className="hdu-mini-badge">🗑 已选 {formatCount99(trashSelected.size)}</span>
          ) : null}
        </button>
      </div>
      {trashOpen ? (
        <div ref={tagStatsPanelRef} tabIndex={-1} className="hdu-tag-stats" role="region" aria-label="回收站">
          {/* 批量操作结果反馈条（第 194 轮巡检；第 223 轮提升到面板级）：完成后短暂显示结果摘要，3s 自动消失；
              第 195 轮起带操作图标；第 196 轮失败走危险态 + 手动关闭 + aria-live；第 200 轮失败摘要加粗 + Esc 关闭。
              面板级渲染：单条还原清空列表后（空态分支）反馈条仍可见，不再随条目列表一起消失。 */}
          {batchResult && !pendingBatchConfirm && !batchProgress ? (
            <div
              ref={batchResultRef}
              className={cx('hdu-window-note', batchResult.startsWith('⚠') ? 'is-danger' : 'is-success', batchResultFading ? 'is-fading' : '')}
              role="status"
              aria-live="polite"
            >
              {batchResult}
              {batchRetryPending && batchResult.startsWith('⚠') ? (
                <button
                  type="button"
                  className="hdu-folder"
                  disabled={!!batchProgress}
                  onClick={() => {
                    // 重试不清结果条：执行中由 batchProgress 显示进度，完成后结果条被新摘要覆盖（第 198 轮巡检）
                    setBatchRetryPending(false);
                    void restoreSelectedAndPlanTrash();
                  }}
                >
                  重试失败项
                </button>
              ) : null}
              <button
                type="button"
                className="hdu-folder"
                style={{ marginLeft: 'auto', flex: 'none' }}
                onClick={() => setBatchResult(null)}
                title="关闭"
              >
                ✕
              </button>
            </div>
          ) : null}
          {/* 回收站统计行（第 231 轮巡检）：总数 + 今日新增，一眼掌握回收站动态；第 232 轮附「即将清理」预告；
              第 233 轮 K>0 时该片段红字加粗（hdu-warn-inline）内联警示，K=0 维持纯文本不渲染片段 */}
          {trashRows.length > 0 ? (
            <div className="hdu-hint" style={{ padding: '2px 0' }}>
              共 {trashRows.length} 项{todayNewTrashCount > 0 ? ` · 今日新增 ${todayNewTrashCount}` : ''}
              {soonExpireTrashCount > 0 ? (
                <>
                  {' · '}
                  <span className="hdu-warn-inline">3 天内将清理 {soonExpireTrashCount}</span>
                </>
              ) : null}
            </div>
          ) : null}
          {trashLoading ? (
            <div className="hdu-hint">回收站读取中…</div>
          ) : trashRows.length === 0 ? (
            /* 空态引导（第 169 轮巡检；第 170 轮附返回按钮；第 191 轮改用 EmptyIllustration 共享组件） */
            <EmptyIllustration
              icon="🗑"
              hint={
                trashJustPurged
                  ? /* 清空后反馈（第 247 轮巡检）：确认「已永久删除」，与常规空态引导区分 */
                    '回收站已清空，原内容已永久删除（不可恢复）。新删除的收藏 / 笔记会先进入这里保留 30 天，可随时还原。'
                  : data.favorites.length === 0
                    ? '知识库还没有收藏——先收藏一些视频或知识点。'
                    : '回收站为空——删除的收藏 / 笔记会先进入这里保留 30 天，可随时还原。'
              }
              action={
                <button type="button" className="hdu-folder" onClick={() => setTrashOpen(false)}>
                  回到知识库列表
                </button>
              }
            />
          ) : (
            <>
              {/* 工具行分层（第 180 轮巡检）：筛选区（类型/全选/搜索）与操作区（排序/批量）分行；第 182 轮加分组微型标签 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, rowGap: 4, flexWrap: 'wrap' }}>
                <span className="hdu-hint" style={{ flex: 'none', fontWeight: 600 }}>
                  筛选
                </span>
                {(
                  [
                    ['all', '全部', trashRows.length],
                    ['favorite', '收藏', trashRows.filter((row) => row.kind === 'favorite').length],
                    ['note', '笔记', trashRows.filter((row) => row.kind === 'note').length],
                  ] as const
                ).map(([key, label, count]) => (
                  <button
                    key={key}
                    type="button"
                    className={cx('hdu-folder', trashKindFilter === key ? 'is-active' : '')}
                    disabled={count === 0 && key !== 'all'}
                    style={count === 0 && key !== 'all' ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                    onClick={() => setTrashKindFilter(key)}
                  >
                    {label}（{count}）
                  </button>
                ))}
                {/* 筛选重置（第 181 轮巡检）：类型/搜索/排序一键复位默认值 */}
                {(trashKindFilter !== 'all' || trashQuery || trashSort !== 'newest') ? (
                  <Button
                    size="small"
                    variant="ghost"
                    onClick={() => {
                      setTrashKindFilter('all');
                      setTrashQueryDraft('');
                      setTrashQuery('');
                      setTrashSort('newest');
                      updateTrashSelected(new Set());
                    }}
                    title="重置类型筛选、搜索、排序与勾选"
                  >
                    ↺ 重置
                  </Button>
                ) : null}
                {/* 全选（第 164 轮巡检）：对当前筛选/搜索可见的条目批量勾选；第 171 轮补勾选体系说明 */}
                <label
                  className="hdu-hint"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none' }}
                  title="此处勾选用于批量还原/删除；知识库整理模式的勾选用于批量打标/移动"
                >
                  <input
                    type="checkbox"
                    ref={selectAllRef}
                    aria-label="全选当前列表"
                    checked={trashVisibleRows.length > 0 && trashVisibleRows.every((row) => trashSelected.has(row.key))}
                    onChange={() =>
                      updateTrashSelected((prev) => {
                        const allSelected = trashVisibleRows.length > 0 && trashVisibleRows.every((row) => prev.has(row.key));
                        const next = new Set(prev);
                        for (const row of trashVisibleRows) {
                          if (allSelected) next.delete(row.key);
                          else next.add(row.key);
                        }
                        return next;
                      })
                    }
                  />
                  全选
                </label>
                <input
                  type="text"
                  ref={trashSearchRef}
                  className="hdu-input"
                  value={trashQueryDraft}
                  onChange={(e) => setTrashQueryDraft(e.target.value)}
                  onKeyDown={(e) => {
                    // Esc 清空搜索并保持聚焦（第 205 轮巡检；第 206 轮加交互前提——与说明卡 Esc 同口径）
                    if (e.key === 'Escape' && trashQueryDraft && Date.now() - uiStore.lastInteractionAt < 5_000) {
                      setTrashQueryDraft('');
                      setTrashQuery('');
                    }
                  }}
                  placeholder="搜索回收站…"
                  aria-label="搜索回收站"
                  style={{ flex: '1 1 auto', minWidth: 0 }}
                />
                {/* 搜索匹配数（第 219 轮巡检）：搜索生效时显示匹配条数 */}
                {trashQuery ? (
                  <span className="hdu-hint" style={{ flex: 'none' }}>
                    匹配 {trashVisibleRows.length} 项
                  </span>
                ) : null}
                {/* 搜索清空（第 175 轮巡检）：有输入时一键清空；第 202 轮清空后聚焦搜索框 */}
                {trashQueryDraft ? (
                  <Button
                    size="small"
                    variant="ghost"
                    onClick={() => {
                      setTrashQueryDraft('');
                      setTrashQuery('');
                      trashSearchRef.current?.focus();
                    }}
                    title="清空搜索"
                  >
                    ✕
                  </Button>
                ) : null}
                {/* 工具行分层（第 180 轮巡检）：筛选区（类型/全选/搜索）与操作区（排序/批量）分行，降低单行密度 */}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, rowGap: 4, flexWrap: 'wrap' }}>
                <span className="hdu-hint" style={{ flex: 'none', fontWeight: 600 }}>
                  操作
                </span>
                {/* 删除时间排序切换（第 176 轮巡检）：最新/最早删除优先 */}
                <Button
                  size="small"
                  variant="ghost"
                  onClick={() => setTrashSort(trashSort === 'newest' ? 'oldest' : 'newest')}
                  title="按删除时间排序切换"
                >
                  {trashSort === 'newest' ? '↓ 最新删除' : '↑ 最早删除'}
                </Button>
                {trashRows.length > 10 ? (
                  /* 批量确认（第 162 轮巡检）：>10 项的全部还原两步确认，防误触大批量还原；批量执行中禁用（第 173 轮） */
                  <ConfirmButton
                    size="small"
                    variant="ghost"
                    loading={trashRestoring}
                    disabled={!!batchProgress}
                    confirmLabel={`确认还原 ${trashRows.length} 项？`}
                    onConfirm={() => void restoreAllTrash()}
                  >
                    全部还原
                  </ConfirmButton>
                ) : (
                  <Button
                    size="small"
                    variant="ghost"
                    loading={trashRestoring}
                    disabled={!!batchProgress}
                    onClick={() => void restoreAllTrash()}
                  >
                    全部还原
                  </Button>
                )}
                {/* 批量操作下拉（第 168 轮巡检）：收纳还原/还原并复习/彻底删除三类批量操作 */}
                {trashSelected.size > 0 ? (
                  <div className="hdu-batch-wrap">
                    <button
                      type="button"
                      ref={batchTriggerRef}
                      className={cx('hdu-folder', trashSelected.size > 0 ? 'is-active' : '')}
                      disabled={!!pendingBatchConfirm}
                      title={pendingBatchConfirm ? '请先处理确认横幅' : undefined}
                      onClick={() => {
                        batchMouseOpenedRef.current = true;
                        setBatchMenuOpen((prev) => !prev);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') batchMouseOpenedRef.current = false;
                      }}
                    >
                      批量操作（{trashSelected.size}）▾
                    </button>
                    {batchMenuOpen ? (
                      <div
                        ref={batchMenuRef}
                        className="hdu-batch-menu"
                        role="menu"
                        aria-label="批量操作菜单"
                        onKeyDown={(e) => {
                          // 键盘导航（第 175 轮巡检；第 190 轮抽 nextMenuFocusIndex 纯函数）：
                          // ↑↓ 相对移动、Home/End 跳首尾、Enter 触发当前项
                          const items = Array.from(e.currentTarget.querySelectorAll('button'));
                          const idx = items.indexOf(document.activeElement as HTMLButtonElement);
                          const target = nextMenuFocusIndex(e.key, items.length, idx);
                          if (target >= 0) {
                            e.preventDefault();
                            items[target]?.focus();
                          }
                        }}
                      >
                        {/* 二次确认预告（第 187 轮巡检）：勾选超 10 项时提前告知 */}
                        {trashSelected.size > 10 ? <div className="hdu-hint" style={{ padding: '0 4px' }}>勾选超 10 项，执行时将二次确认</div> : null}
                        <button
                          type="button"
                          role="menuitem"
                          className="hdu-folder"
                          autoFocus
                          onClick={() => {
                            setBatchMenuOpen(false);
                            if (trashSelected.size > 10) setPendingBatchConfirm('restore');
                            else void restoreSelectedTrash();
                          }}
                        >
                          <span aria-hidden>↩</span> 还原选中
                        </button>
                        {favSelectedCount > 0 ? (
                          <button
                            type="button"
                            role="menuitem"
                            className="hdu-folder"
                            onClick={() => {
                              setBatchMenuOpen(false);
                              if (favSelectedCount > 10) setPendingBatchConfirm('plan');
                              else void restoreSelectedAndPlanTrash();
                            }}
                          >
                            <span aria-hidden>📖</span> 还原并复习选中
                          </button>
                        ) : null}
                        <button
                          type="button"
                          role="menuitem"
                          className="hdu-folder is-danger-text"
                          onClick={() => {
                            setBatchMenuOpen(false);
                            // 彻底删除不可恢复，恒走确认横幅
                            setPendingBatchConfirm('purge');
                          }}
                        >
                          <span aria-hidden>🗑</span> 彻底删除选中
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {/* 批量执行进度（第 168 轮巡检）：逐项执行时显示 done/total；第 222 轮附百分比（tabular-nums 防跳动） */}
                {batchProgress ? (
                  <span className="hdu-hint" style={{ flex: 'none', fontVariantNumeric: 'tabular-nums' }}>
                    批量执行中 {batchProgress.done}/{batchProgress.total}（{formatPercent(batchProgress.done, batchProgress.total)}）…
                  </span>
                ) : null}
              </div>
              {/* 批量操作确认横幅（第 168 轮巡检；第 191 轮加 role=status、10s 倒计时进度条与 key 重挂） */}
              {pendingBatchConfirm ? (
                <div
                  key={pendingBatchConfirm}
                  className={cx(
                    'hdu-window-note is-danger',
                    pendingBatchConfirm === 'purge' || pendingBatchConfirm === 'purgeAll' ? 'is-purge' : '',
                  )}
                  role="status"
                  style={{ borderColor: 'color-mix(in srgb, var(--danger) 55%, transparent)' }}
                >
                  <span style={{ flex: '1 1 auto' }}>
                    ⚠{' '}
                    {pendingBatchConfirm === 'restore'
                      ? `确认还原选中 ${trashSelected.size} 项？`
                      : pendingBatchConfirm === 'plan'
                        ? `确认还原并复习选中 ${favSelectedCount} 项？`
                        : pendingBatchConfirm === 'purgeAll'
                          ? `确认清空回收站全部 ${trashRows.length} 项？（不可恢复）· 将清空：${trashVisibleRows.slice(0, 2).map((row) => row.title).join('、')}${trashRows.length > 2 ? ' 等' : ''}`
                          : `确认彻底删除选中 ${trashSelected.size} 项？（不可恢复）· 将删除：${trashRows.filter((row) => trashSelected.has(row.key)).slice(0, 2).map((row) => row.title).join('、')}${trashSelected.size > 2 ? ' 等' : ''}`}
                  </span>
                  <span className="hdu-confirm-timer" aria-hidden />
                  <Button
                    size="small"
                    /* danger 语义色（第 247 轮巡检）：彻底删除/清空类确认按钮给 danger 底色，
                        还原类保持中性——与横幅 is-purge 倒计时同一家族的权重信号 */
                    variant={pendingBatchConfirm === 'purge' || pendingBatchConfirm === 'purgeAll' ? 'danger' : 'default'}
                    onClick={() => {
                      const action = pendingBatchConfirm;
                      setPendingBatchConfirm(null);
                      if (action === 'restore') void restoreSelectedTrash();
                      else if (action === 'plan') void restoreSelectedAndPlanTrash();
                      else if (action === 'purgeAll') void purgeTrash();
                      else void purgeSelectedTrash();
                    }}
                  >
                    {/* 确认文案按操作类型区分（第 232 轮巡检）：降低批量误操作风险 */}
                    {pendingBatchConfirm === 'restore'
                      ? '确认还原'
                      : pendingBatchConfirm === 'plan'
                        ? '确认还原并复习'
                        : pendingBatchConfirm === 'purgeAll'
                          ? '确认清空'
                          : '确认删除'}
                  </Button>
                  <Button size="small" variant="ghost" onClick={() => setPendingBatchConfirm(null)}>
                    取消
                  </Button>
                </div>
              ) : null}
              {/* 搜索无匹配空态（第 220 轮巡检）：搜索生效但无匹配条目时提示；第 226 轮附「清空搜索」一键回全部 */}
              {!batchResult && !pendingBatchConfirm && !batchProgress && trashQuery && trashVisibleRows.length === 0 ? (
                <div className="hdu-window-note" role="status" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <span style={{ flex: '1 1 auto' }}>🔍 无匹配条目</span>
                  <Button
                    size="small"
                    variant="ghost"
                    onClick={() => {
                      setTrashQueryDraft('');
                      setTrashQuery('');
                    }}
                  >
                    清空搜索
                  </Button>
                </div>
              ) : null}
              {trashVisibleRows.slice(0, trashVisibleLimit).map((row) => (
                  <div key={row.key} className={cx('hdu-tag-manage-row', trashSelected.has(row.key) ? 'is-checked' : '')}>
                    {/* 多选勾选（第 164 轮巡检）：配合「还原选中」批量还原 */}
                    <input
                      type="checkbox"
                      aria-label={trashSelected.has(row.key) ? `已勾选：${row.title}` : `选中：${row.title}`}
                      checked={trashSelected.has(row.key)}
                      onChange={() =>
                        updateTrashSelected((prev) => {
                          const next = new Set(prev);
                          if (next.has(row.key)) next.delete(row.key);
                          else next.add(row.key);
                          return next;
                        })
                      }
                    />
                    <span
                      style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={row.title}
                    >
                      {/* 类型徽标着色（第 174 轮巡检）：收藏强调色 / 笔记中性 */}
                      <span className={cx('hdu-trash-kind', row.kind === 'favorite' ? 'is-fav' : 'is-note')}>
                        [{row.kind === 'favorite' ? '收藏' : row.kind === 'note' ? '笔记' : row.kind}]
                      </span>{' '}
                      {row.title}
                      <span className="hdu-hint" title={`删除于 ${new Date(row.deletedAt).toLocaleDateString()}`}> · {deletedAgoLabel(row.deletedAt)}删除</span>
                      {row.expiresAt > 0 ? (
                        (() => {
                          // 过期倒计时精确到天（第 177 轮巡检）：当天标「今天」，其余「N 天后清理」；
                          // 第 178 轮起 ≤3 天用警示色强调紧迫度
                          const days = Math.ceil((row.expiresAt - Date.now()) / 86_400_000);
                          const label = days <= 0 ? '今天清理' : `${days} 天后清理`;
                          return (
                            <span
                              className={cx('hdu-hint', days <= 3 ? 'is-urgent' : '')}
                              title={`自动清理于 ${new Date(row.expiresAt).toLocaleDateString()}`}
                            >
                              {' '}· {label}
                            </span>
                          );
                        })()
                      ) : null}
                    </span>
                    <Button size="small" variant="ghost" onClick={() => void restoreTrashItem(row.key)}>
                      还原
                    </Button>
                    {row.kind === 'favorite' ? (
                      <Button
                        size="small"
                        variant="ghost"
                        loading={restoringPlanKey === row.key}
                        title="还原到知识库并加入复习计划"
                        onClick={() => void restoreTrashAndPlan(row.key, row.id)}
                      >
                        还原并复习
                      </Button>
                    ) : null}
                    {/* 续期（第 233 轮巡检）：3 天内将清理的条目可一键重置 30 天 */}
                    {row.expiresAt > 0 && row.expiresAt - Date.now() <= 3 * 86_400_000 ? (
                      <Button size="small" variant="ghost" title="把自动清理时间重置为 30 天后" onClick={() => void extendTrashItem(row.key)}>
                        续期
                      </Button>
                    ) : null}
                    {purgingKey === row.key ? (
                      /* 确认态 danger 底色（第 247 轮巡检）：不可恢复操作与普通主操作一眼区分 */
                      <Button size="small" variant="danger" onClick={() => void purgeTrashItem(row.key)} title="永久删除，不可恢复">
                        确认删除
                      </Button>
                    ) : (
                      <Button
                        size="small"
                        variant="ghost"
                        title="彻底删除该条目（不可恢复）"
                        onClick={() => setPurgingKey(row.key)}
                      >
                        彻底删除
                      </Button>
                    )}
                  </div>
                ))}
                {/* 回收站渐进显示「显示更多」（第 226 轮巡检）：与知识库同策略，每次追加 60 条 */}
                {trashVisibleRows.length > trashVisibleLimit ? (
                  <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 2px' }}>
                    <Button size="small" variant="ghost" onClick={() => setTrashVisibleLimit((v) => v + 60)}>
                      显示更多（还有 {trashVisibleRows.length - trashVisibleLimit} 条）
                    </Button>
                  </div>
                ) : null}
                {/* 清空回收站（第 146 轮巡检）：第 194 轮起确认横幅化（不可恢复，恒确认） */}
                <Button
                  size="small"
                  variant="ghost"
                  loading={trashPurging}
                  disabled={!!batchProgress || !!pendingBatchConfirm}
                  onClick={() => setPendingBatchConfirm('purgeAll')}
                >
                  清空回收站
                </Button>
            </>
          )}
        </div>
      ) : null}
      {/* 导出预览（第 164 轮巡检）：确认后落盘，降低「导出才发现口径不对」的返工 */}
      <Modal open={exportPreview !== null} title="导出预览" onClose={() => setExportPreview(null)} width={480}>
        {exportPreview ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="hdu-hint">
              {exportPreview.name} · 共 {exportPreview.content.trimEnd().split('\n').length} 行 · 约{" "}
              {formatBytes(new Blob([exportPreview.content]).size)}
            </div>
            {/* 元信息行高亮（第 166 轮巡检）：覆盖率/统计口径一眼可见 */}
            {(() => {
              const metaLines = exportPreview.content.split('\n').filter((line) => line.startsWith('标签覆盖率') || line.startsWith('统计口径'));
              return metaLines.length > 0 ? (
                <div className="hdu-window-note" style={{ flexDirection: 'column', gap: 2 }}>
                  {metaLines.map((line) => (
                    <div key={line}>
                      <b>元信息</b>
                      {line}
                    </div>
                  ))}
                </div>
              ) : null;
            })()}
            <pre
              style={{
                margin: 0,
                padding: '8px 10px',
                maxHeight: 260,
                overflow: 'auto',
                background: 'var(--paper-3)',
                borderRadius: 8,
                fontSize: 11,
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {exportPreview.content.trimEnd().split('\n').slice(0, 10).join('\n')}
            </pre>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button size="small" variant="ghost" onClick={() => void copyExportPreview()}>
                复制内容
              </Button>
              <Button size="small" variant="ghost" onClick={() => setExportPreview(null)}>
                取消
              </Button>
              <Button size="small" onClick={confirmExportCsv}>
                确认导出
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
      {/* 趋势柱点选明细（第 134 轮巡检）：该标签该周完成的作业列表（标题 + 完成时间） */}
      <Modal
        open={trendDetail !== null}
        title={
          trendDetail
            ? `「${trendDetail.tag}」${
                trendDetail.weekIdx === tagTrend.length - 1
                  ? '本周'
                  : `${tagTrend.length - 1 - trendDetail.weekIdx} 周前`
              }完成明细`
            : '完成明细'
        }
        onClose={() => setTrendDetail(null)}
        width={420}
      >
        {trendDetailData === null || trendDetailData.rows.length === 0 ? (
          <div className="hdu-hint">该周无完成记录。</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div className="hdu-hint" style={{ flex: '1 1 auto' }}>
                统计窗口 {trendDetailData.rangeLabel} · 共 {trendDetailData.rows.length} 项
                {trendDetailData.favCount > 0 ? ` · 完成率 ${trendDetailData.rate}%（${trendDetailData.rows.length}/${trendDetailData.favCount}）` : ''}
              </div>
              {/* 完成率进度条（第 145 轮巡检） */}
              <Progress value={trendDetailData.rows.length / Math.max(1, trendDetailData.favCount)} jade />
              {/* 复制明细（第 138 轮巡检）+ 导出 CSV（第 143 轮巡检）：弹层内容进剪贴板/落盘 */}
              <Button size="small" variant="ghost" onClick={() => void copyTrendDetail()}>
                复制明细
              </Button>
              <Button size="small" variant="ghost" icon="download" onClick={exportTrendDetailCsv}>
                导出 CSV
              </Button>
            </div>
            {trendDetailData.rows.map((row, index) => (
              <div key={`${row.ts}-${index}`} className="hdu-tag-manage-row">
                <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {row.title}
                  {row.round !== null ? ` · 第 ${row.round} 轮` : ''}
                  {row.dueDate ? ` · 到期 ${row.dueDate}` : ''}
                  {row.tags.length > 0 ? ` · ${row.tags.join('、')}` : ''}
                </span>
                <span className="hdu-hint" style={{ flex: 'none' }}>
                  {row.doneAt}
                </span>
              </div>
            ))}
          </div>
        )}
      </Modal>
      {/* 批量整理操作条（第 88 轮巡检）：整理模式下显示，移动到文件夹 / 批量删除；第 171 轮补勾选体系说明 */}
      {tidyMode ? (
        <div className="hdu-tidy-bar" title="此处勾选用于批量打标/移动/删除；回收站的勾选用于批量还原/删除">
          <span>已选 {selectedIds.size} 项</span>
          {/* 全选（第 93 轮巡检） */}
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input
              type="checkbox"
              checked={filtered.length > 0 && selectedIds.size === filtered.length}
              onChange={(e) => setSelectedIds(e.target.checked ? new Set(filtered.map((fav) => fav.id)) : new Set())}
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
            {data.folders.map((f) => (
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
          <Button size="small" variant="ghost" disabled={selectedIds.size === 0 || tidyTags.trim() === ''} onClick={() => void batchTag()}>
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
      {/* 装载态骨架（第 253 轮，视图域 / 反馈一致性）：BundleData 异步装载期间不再
          闪现「知识库还是空的」误导空态（盘点结论：本视图收藏列表此前无 loading 态）；
          骨架行高度阶梯贴近真实卡片首行，到达后不跳版。
          min-height 300px（第 254 轮跳版核对）：真实内容为 knowledge 网格
          （minmax(290px,1fr) 列），面板宽 ≥600px 时首屏通常 2 列 × 2 行，单卡高 ≈
          padding 30px + 头部 15px + 两行标题 ~42px + 三行摘要 ~57px + 底部动作 ~24px
          ≈ 150px，2 行 + 13px gap ≈ 313px → 骨架卡 min-height 300px 兜底，网格到达后
          页面高度不塌陷（空库 / 少量收藏时骨架短暂偏高属可接受的加载态权衡） */}
      {data.loading ? (
        <div className="hdu-card" style={{ minHeight: 300 }}>
          <SkeletonRows widths={['46%', '88%', '38%']} height={16} />
        </div>
      ) : filtered.length === 0 ? (
        <div className="hdu-card">
          <EmptyState
            icon="library"
            title={data.favorites.length === 0 ? '知识库还是空的' : '没有匹配的条目'}
            text={
              data.favorites.length === 0
                ? '在播放页收藏时间点、AI 回答、大纲节点或截图，在 B 站收藏网课视频，它们会汇集在这里，可检索、可导出。'
                : query.trim()
                  ? // 搜索态建议（第 269 轮，检索域 / 三端空态对齐）：与统一搜索 / B 站字幕搜索同款指引；
                    // 第 310 轮起超长词用 emptySearchTip 点名长度（与五端建议词同口径）
                    `${query.trim().length > 16 ? emptySearchTip(query) : '试试更短的关键词，或换个说法'}；也可以清除搜索查看全部。`
                  : '试试更换筛选条件或清除搜索关键词。'
            }
            action={
              data.favorites.length === 0 ? undefined : query.trim() ? (
                /* 清除搜索（第 296 轮，可用性域）：空态建议的直达动作——一键清词恢复全量 */
                <Button size="small" variant="ghost" icon="refresh" onClick={() => setQuery('')}>
                  清除搜索
                </Button>
              ) : (
                /* 重置筛选（第 296 轮，可用性域）：筛选态空结果的直达动作 */
                <Button
                  size="small"
                  variant="ghost"
                  icon="refresh"
                  onClick={() => {
                    setType('all');
                    setFolder('all');
                    setTag(null);
                    setReviewFilter('all');
                  }}
                >
                  重置筛选
                </Button>
              )
            }
          />
        </div>
      ) : (
        <div className="hdu-knowledge-grid">
          {filtered.slice(0, visibleLimit).map((fav) => {
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
                  highlight={query.trim()}
                  subtitleReady={bvid ? subReady.has(bvid) : false}
                  reviewBadge={reviewBadgeById.get(fav.id) ?? null}
                  lastReviewDoneLabel={lastReviewDoneLabels.get(fav.id)}
                  onDelete={() => void removeFavorite(fav)}
                  onViewSubtitle={(targetBvid, page) => {
                    setSubBvid(targetBvid);
                    setSubP(page);
                  }}
                  onOpenSession={(courId, teclId) => actions.openSessionInSite(courId, teclId)}
                  onEdit={() => setEditing(fav)}
                  onReview={async () => {
                    // 与 Dashboard 知识库同组件同槽位（VideoFavCard 底部动作组）、同参数与同成功文案；
                    // repo planReview 不校验 courId，HDU 与 B 站收藏均可入计划。
                    // 失败按学习中心惯例走 error toast（dashboard 侧未处理 rejection，这里补齐避免未处理拒绝）。
                    // busy 守卫（第 38 轮巡检）：同一收藏请求进行中忽略重复点击（与 B 站面板同型）
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
                  }}
                />
              </div>
            );
          })}
          {/* 渐进显示「显示更多」（第 225 轮巡检）：每次追加 60 条，避免大收藏量一次性渲染；
              第 283 轮起哨兵元素接近视口时自动追加（按钮保留为显式兜底） */}
          {filtered.length > visibleLimit ? (
            <div ref={loadMoreRef} style={{ display: 'flex', justifyContent: 'center', padding: '8px 0 2px' }}>
              <Button size="small" variant="ghost" onClick={() => setVisibleLimit((v) => v + 60)}>
                显示更多（还有 {filtered.length - visibleLimit} 条）
              </Button>
            </div>
          ) : null}
        </div>
      )}
      {data.notes.length > 0 ? (
        <div className="hdu-section">
          <SectionHead
            title="我的笔记"
            sub={`${visibleNotes.length}/${data.notes.length} 条时间戳笔记`}
            actions={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {/* 汇编范围（第 115 轮巡检）：全部 / 仅站内 / 仅B站 */}
                <select
                  className="hdu-input"
                  style={{ height: 26 }}
                  value={noteScope}
                  onChange={(e) => setNoteScope(e.target.value as 'all' | 'internal' | 'bili')}
                  aria-label="笔记汇编范围"
                >
                  <option value="all">全部笔记</option>
                  <option value="internal">仅站内</option>
                  <option value="bili">仅 B 站</option>
                </select>
                {/* 导出笔记汇编（第 107 轮巡检；第 112 轮起纳入 B 站外部笔记并按课程/视频分组） */}
                <Button
                  size="small"
                  variant="ghost"
                  icon="download"
                  onClick={() => void exportNotesAssembly()}
                >
                  导出笔记
                </Button>
              </span>
            }
          />
          <div className="hdu-card pad">
            {/* 笔记搜索（第 117 轮巡检）：按内容过滤我的笔记；课程筛选（第 122 轮巡检）并排 */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <input
                type="text"
                className="hdu-input"
                style={{ flex: 1 }}
                placeholder="搜索笔记内容…"
                value={noteQuery}
                onChange={(e) => setNoteQuery(e.target.value)}
                aria-label="搜索笔记"
              />
              <select
                className="hdu-input"
                style={{ flex: 'none', width: 'auto' }}
                value={noteCourse}
                onChange={(e) => setNoteCourse(e.target.value)}
                aria-label="笔记课程筛选"
              >
                <option value="">全部课程</option>
                {noteCourseOptions.map(([teclId, name]) => (
                  <option key={teclId} value={String(teclId)}>{name}</option>
                ))}
              </select>
            </div>
            <div className="hdu-list">
              {visibleNotes.slice(0, 12).map((note) => {
                const noteCourseName = note.teclId != null ? noteCourseNameByTecl.get(note.teclId) : undefined;
                return (
                  <div className="hdu-note" key={note.id}>
                    <button type="button" className="hdu-note-time" onClick={() => actions.openSessionInSite(note.courId, note.teclId)}>
                      {formatClock(note.anchorTime)}
                    </button>
                    <div className="hdu-note-body">
                      <div className="hdu-note-text">{note.text}</div>
                      <div className="hdu-hint" style={{ marginTop: 4 }}>
                        {noteCourseName ? <span className="hdu-note-course">{noteCourseName}</span> : null}
                        {localDayKey(new Date(note.createdAt))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
      {/* 有实际导入时：关闭弹窗后刷新知识库列表并提示 */}
      <BiliImportModal
        open={importOpen}
        onClose={(imported) => {
          setImportOpen(false);
          if (imported) {
            void data.reload?.();
            pushToast('B 站收藏已导入知识库', 'success');
          }
        }}
      />
      {/* 查看字幕浮层：复用 B 站字幕面板的同一实现（不复制组件）；HDU 页内没有目标播放器，
          行点击经 seekMode='external' 降级为打开 B 站 ?t= 外链；p 来自收藏 metadata.url */}
      <BiliSubtitlePanel
        bvid={subBvid ?? ''}
        p={subP}
        open={subBvid !== null}
        onClose={() => setSubBvid(null)}
        seekMode="external"
      />
      {/* 收藏卡片编辑弹层：与 Dashboard 知识库共用同一实现（./FavoriteEditModal.tsx），
          op 通道一致；本入口保留全部能力（弹层内删除两步确认 / 置顶 / 新建文件夹均为默认开启），
          失败提示经 onError 走 pushToast */}
      <FavoriteEditModal
        favorite={editing}
        folders={data.folders}
        onClose={closeEditing}
        tagSuggestions={tagSuggestions}
        onDone={(toast) => {
          setEditing(null);
          pushToast(toast, 'success');
          void data.reload?.();
        }}
        onError={(toast) => pushToast(toast, 'error')}
      />
      {/* 标签管理弹层（第 124 轮巡检）：注册表标签重命名 / 合并；操作后整库刷新 */}
      <Modal
        open={tagManageOpen}
        title="标签管理"
        onClose={() => {
          setTagManageOpen(false);
          setRenamingTag(null);
          setMergingTag(null);
        }}
        width={460}
      >
        {tagLoading ? (
          <div className="hdu-hint">标签读取中…</div>
        ) : tagRows.length === 0 ? (
          <div className="hdu-hint">还没有登记标签；在收藏编辑里打标后会自动登记。</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {tagRows.map((t) => (
              <div key={t.id} className="hdu-tag-manage-row">
                {renamingTag?.id === t.id ? (
                  <>
                    <input
                      className="hdu-input"
                      value={renamingTag.name}
                      autoFocus
                      aria-label="新标签名"
                      onChange={(e) => setRenamingTag({ id: t.id, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveTagRename();
                      }}
                      style={{ flex: '1 1 auto', minWidth: 0 }}
                    />
                    <Button size="small" variant="primary" loading={tagBusy} disabled={!renamingTag.name.trim()} onClick={() => void saveTagRename()}>
                      保存
                    </Button>
                    <Button size="small" variant="ghost" onClick={() => setRenamingTag(null)}>
                      取消
                    </Button>
                  </>
                ) : mergingTag === t.id ? (
                  <>
                    <span className="hdu-hint" style={{ flex: 'none' }}>
                      「{t.name}」合并到
                    </span>
                    <select
                      className="hdu-input"
                      value={mergeTarget}
                      aria-label="合并目标标签"
                      onChange={(e) => setMergeTarget(e.target.value)}
                      style={{ flex: '1 1 auto', minWidth: 0 }}
                    >
                      <option value="">选择目标标签…</option>
                      {tagRows
                        .filter((other) => other.id !== t.id)
                        .map((other) => (
                          <option key={other.id} value={other.id}>
                            {other.name}
                          </option>
                        ))}
                    </select>
                    <Button size="small" variant="primary" loading={tagBusy} disabled={!mergeTarget} onClick={() => void confirmTagMerge()}>
                      确认合并
                    </Button>
                    <Button size="small" variant="ghost" onClick={() => { setMergingTag(null); setMergeTarget(''); }}>
                      取消
                    </Button>
                  </>
                ) : (
                  <>
                    <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      # {t.name} <span className="hdu-hint">· {countByTag.get(t.name) ?? 0} 个收藏</span>
                    </span>
                    <Button size="small" variant="ghost" onClick={() => setRenamingTag({ id: t.id, name: t.name })}>
                      改名
                    </Button>
                    {tagRows.length > 1 ? (
                      <Button size="small" variant="ghost" onClick={() => { setMergingTag(t.id); setMergeTarget(''); }}>
                        合并…
                      </Button>
                    ) : null}
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </Modal>
    </>
  );
}
