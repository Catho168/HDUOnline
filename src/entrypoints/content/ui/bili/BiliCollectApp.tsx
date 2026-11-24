// B 站收藏弹窗主组件（BiliCollectApp）：四枚入口 FAB（收藏/字幕/学习助手/学习中心）、
// 收藏弹窗、续看 chip、字幕/问答/学习中心面板接线、toast 通道与宿主深色跟随。
// 自 bilibili.content.tsx 第 41 轮巡检按内聚块纯搬移拆分，逻辑/类名/文案/props 逐行未变。

import { useState, useCallback, useEffect, useRef } from 'react';
import { callOp } from '@/core/shared/client';
import { BILI_RESERVED_KEYS, DEFAULT_SHORTCUTS } from '@/core/shared/constants';
import { AppError } from '@/core/shared/errors';
import { formatSeconds } from '@/core/shared/duration';
import { uuid, eventTargetOf } from '@/core/shared/utils';
import { loadSettings, onSettingsChanged } from '@/core/shared/settings';
import type { FavoriteEntity, FolderEntity, ShortcutMap } from '@/core/shared/types';
import { resolvePanelTheme } from '@/core/shared/hostTheme';
import { isBiliHostDark } from '@/core/bili/theme';
import { buildAiFavorite, buildMomentFavorite, type AiFavoriteChatRef } from '@/core/bili/assistant';
import { dueBadgeLabel } from '@/core/plan/today';
import { BiliSubtitlePanel } from '@/entrypoints/content/ui/BiliSubtitlePanel';
import { BiliQaPanel, type BiliQaTab } from '@/entrypoints/content/ui/BiliQaPanel';
import { BiliHubPanel } from '@/entrypoints/content/ui/BiliHubPanel';
import { watchVideoElement } from '@/entrypoints/content/ui/videoWatcher';
import { BiliTimelineMarkers } from './BiliTimelineMarkers';
import { extractBiliVideoInfo, readBiliPageP, type BiliVideoInfo } from './videoInfo';

/** 浮层当前行高亮的 timeupdate 节流间隔（timeupdate 约 4 次/秒，节流到 ~500ms 足够逐行高亮） */
const SUB_TIMEUPDATE_THROTTLE_MS = 500;

/** 命名导出供单测（jsdom 冒烟）复用；default 仍是内容脚本定义 */
export function BiliCollectApp() {
  const [videoInfo] = useState<BiliVideoInfo | null>(() => extractBiliVideoInfo());
  const [open, setOpen] = useState(false);
  const [folders, setFolders] = useState<FolderEntity[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [tags, setTags] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [collected, setCollected] = useState(false);
  const [resumePositionSec, setResumePositionSec] = useState<number | null>(null);
  // 字幕入口：获取中状态 + 查看浮层开关 + 获取时的分 P（浮层按 mediaKey 分 P 读字幕）
  const [subLoading, setSubLoading] = useState(false);
  const [subOpen, setSubOpen] = useState(false);
  const [subP, setSubP] = useState(1);
  // 学习助手（AI 时间点问答）浮层开关 + 「收藏此时刻」保存中状态
  const [qaOpen, setQaOpen] = useState(false);
  const [momentSaving, setMomentSaving] = useState(false);
  // 学习中心（BiliHubPanel：知识库/统计两页签）浮层开关（第 32 轮）
  const [hubOpen, setHubOpen] = useState(false);
  // 今日到期复习徽标（第 77 轮巡检）：主入口 FAB 的角标显示今日到期复习数，
  // 挂载即拉取 + 5 分钟低频轮询；学习中心关闭后重拉（「今日」页签完成复习后即时回落）。
  // 失败静默保持现值（徽标是辅助信息，不因单次失败闪灭）
  const [dueCount, setDueCount] = useState(0);
  const refreshDueCount = useCallback(() => {
    callOp('review.due', {})
      .then((jobs) => setDueCount(Array.isArray(jobs) ? jobs.length : 0))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    refreshDueCount();
    const timer = window.setInterval(refreshDueCount, 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [refreshDueCount]);
  const prevHubOpenRef = useRef(false);
  useEffect(() => {
    if (prevHubOpenRef.current && !hubOpen) refreshDueCount();
    prevHubOpenRef.current = hubOpen;
  }, [hubOpen, refreshDueCount]);
  // FAB 收敛（第 44 轮）：四枚常驻浮窗入口合并为「学习」主入口 + 上方展开菜单。
  // 子钮保留原类名并常驻 DOM，收起态仅折叠视觉与指针（opacity/pointer-events），
  // 程序化 click（单测/e2e/工具栏探针联动）不受展开态影响。
  const [menuOpen, setMenuOpen] = useState(false);
  // 快捷键档位（第 44 轮）：挂载时读全局 settings.shortcuts（与 HDU 侧同源配置），
  // 读取失败保持 DEFAULT_SHORTCUTS
  const [shortcuts, setShortcuts] = useState<ShortcutMap>(DEFAULT_SHORTCUTS);
  // FAB 组根元素（外点关闭判定用，第 51 轮审计 P3-6）
  const groupRef = useRef<HTMLDivElement | null>(null);
  // 学习助手面板页签切换信号（第 44 轮）：openQa(tab) 递增 seq；q/n 快捷键经此
  // 直达问答/笔记页签（面板已开时按快捷键也能即时切换）
  const [qaTabSignal, setQaTabSignal] = useState<{ tab: BiliQaTab; seq: number }>({ tab: 'qa', seq: 0 });
  // 浮层「当前播放行」高亮：只在浮层打开期间监听 <video> timeupdate（节流 500ms），
  // 关闭即停止监听与等待轮询（LearningCenter 宿主不传 currentTime，无高亮）；
  // SPA 切 P/切清晰度替换 <video> 节点后由 watchVideoElement 重新捕获并重挂（高亮恢复跟随）
  const [subCurrentTime, setSubCurrentTime] = useState<number | undefined>(undefined);
  const [toast, setToast] = useState<string | null>(null);
  const [toastKind, setToastKind] = useState<'info' | 'error'>('info');
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  // 宿主深色主题：初始判定 + 持续跟随（B 站深色开关可能改 <html> 属性/cookie/CSS 变量，
  // 三种途径都监不全——MutationObserver 监属性变化 + 低频轮询兜底）
  const [hostDark, setHostDark] = useState(() => isBiliHostDark(document));

  useEffect(() => {
    const sync = () => setHostDark(isBiliHostDark(document));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    const timer = window.setInterval(sync, 5000);
    return () => {
      observer.disconnect();
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!subOpen) return undefined;
    let video: HTMLVideoElement | null = null;
    let lastAt = 0;
    const onTimeUpdate = () => {
      const now = Date.now();
      if (now - lastAt < SUB_TIMEUPDATE_THROTTLE_MS) return;
      lastAt = now;
      if (video) setSubCurrentTime(video.currentTime);
    };
    // 播放器元素可能晚于内容脚本就绪（B 站 SPA）：等待出现后再监听（兜底保留）；
    // 面板关闭（本 effect 清理）即 stop() 终止等待轮询与节点跟随，不再无谓空转；
    // SPA 切 P/切清晰度替换 <video> 节点后由 watcher 重新捕获并在此重挂监听，
    // is-current 高亮恢复跟随新节点
    const watcher = watchVideoElement({
      onVideo: (el) => {
        if (video === el) return;
        video?.removeEventListener('timeupdate', onTimeUpdate);
        video = el;
        setSubCurrentTime(el.currentTime);
        el.addEventListener('timeupdate', onTimeUpdate);
      },
    });
    return () => {
      watcher.stop();
      video?.removeEventListener('timeupdate', onTimeUpdate);
      video = null;
    };
  }, [subOpen]);

  const showToast = useCallback((msg: string, kind: 'info' | 'error' = 'info') => {
    setToast(msg);
    setToastKind(kind);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }, []);

  useEffect(() => {
    if (!videoInfo) return;
    callOp('fav.list', { filter: { limit: 1 } }).then(() => {});
    callOp('folder.list', { includeArchived: false }).then((result) => {
      setFolders(result as FolderEntity[]);
    }).catch(() => {});

    callOp('fav.list', { filter: { limit: 500 } }).then((result) => {
      const favs = result as FavoriteEntity[];
      const already = favs.some((f) => f.type === 'video' && f.refId === videoInfo.bvid);
      setCollected(already);
    }).catch(() => {});

    // 续看提示：上次位置 ≥30s 且未看完（无时长或比率 <0.95）才提示；不自动 seek
    let cancelled = false;
    callOp('video.progress.get', { platform: 'bilibili', videoId: videoInfo.bvid })
      .then((progress) => {
        if (cancelled || !progress) return;
        const last = progress.lastPositionSec;
        const dur = progress.durationSec;
        const ratio = dur != null && dur > 0 ? last / dur : null;
        if (last >= 30 && (ratio == null || ratio < 0.95)) {
          setResumePositionSec(last);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [videoInfo]);

  const handleResume = useCallback(() => {
    const positionSec = resumePositionSec;
    setResumePositionSec(null);
    if (positionSec == null) return;
    const video = document.querySelector('video');
    if (video) {
      video.currentTime = positionSec;
      void video.play().catch(() => {});
    }
  }, [resumePositionSec]);

  /**
   * 获取 B 站官方字幕（bili.subtitle.fetch，SW 侧拉取落库）。
   * 「该视频没有可用字幕」是作罢提示（中性 toast，非错误样式）；其余失败走错误样式。
   * 分 P 在点击时实时读 URL（SPA 切 P 不重跑内容脚本）；p≥2 的 toast 带分 P（P1 省略）。
   */
  const handleFetchSubtitle = useCallback(async () => {
    if (!videoInfo || subLoading) return;
    setSubLoading(true);
    const p = readBiliPageP();
    setSubP(p);
    try {
      // 字幕链三段顺序请求最坏 45s，超默认 RPC 30s 会先报错而 SW 稍后才落库（第 15 轮 P3-2）
      const result = await callOp('bili.subtitle.fetch', { bvid: videoInfo.bvid, p }, { timeoutMs: 60_000 });
      if (result.status === 'none') {
        showToast(p > 1 ? `该视频 P${p} 没有可用字幕` : '该视频没有可用字幕');
      } else {
        const pageLabel = p > 1 ? ` · P${p}` : '';
        showToast(`字幕已就绪（${result.segments} 条 · ${result.lanDoc || result.lan || '未知语言'}${pageLabel}）`);
        setSubOpen(true);
      }
    } catch (err) {
      showToast(err instanceof AppError ? err.userMessage : '字幕获取失败，请稍后重试', 'error');
    } finally {
      setSubLoading(false);
    }
  }, [videoInfo, subLoading, showToast]);

  const handleSave = useCallback(async () => {
    if (!videoInfo || saving) return;
    setSaving(true);
    try {
      let folderId = selectedFolderId;

      if (showNewFolder && newFolderName.trim()) {
        const newFolder: FolderEntity = {
          id: uuid(),
          name: newFolderName.trim(),
          orderIndex: folders.length,
          archived: false,
          createdAt: Date.now(),
        };
        await callOp('folder.upsert', { folder: newFolder });
        folderId = newFolder.id;
        setFolders((prev) => [...prev, newFolder]);
        setShowNewFolder(false);
        setNewFolderName('');
      }

      const favorite: Omit<FavoriteEntity, 'updatedAt'> = {
        id: uuid(),
        type: 'video',
        refId: videoInfo.bvid,
        snapshot: {
          title: videoInfo.title,
          content: videoInfo.description || videoInfo.url,
        },
        folderId: folderId ?? null,
        tags: tags.split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean),
        note: note.trim() || undefined,
        pinned: false,
        favoritedAt: Date.now(),
        metadata: {
          platform: 'bilibili',
          bvid: videoInfo.bvid,
          coverUrl: videoInfo.coverUrl,
          uploader: videoInfo.uploader,
          duration: videoInfo.duration,
          durationSec: videoInfo.durationSec,
          url: videoInfo.url,
        },
      };

      await callOp('fav.put', { favorite });
      setCollected(true);
      setOpen(false);
      showToast('已收藏到知识库');
      setTags('');
      setNote('');
    } catch {
      showToast('收藏失败，请重试', 'error');
    } finally {
      setSaving(false);
    }
  }, [videoInfo, saving, selectedFolderId, showNewFolder, newFolderName, folders, tags, note, showToast]);

  /**
   * 收藏此时刻（学习助手工具行入口）：type='time'（FavoriteType 时间点类取值），
   * anchorTime 取 <video>.currentTime，mediaKey 按当前分 P（bili:<bvid>[:pN]）与
   * bvid/p/url 一起落 metadata；payload 组装走 core/bili/assistant.buildMomentFavorite
   * 纯函数，命名惯例同 HDU 站内 addTimeFavorite（「标题 · 时刻」）。成功后复用现有 toast。
   * url 取动作触发时的 location 现值（第 27 轮审计 P2-2）：videoInfo.url 是挂载时
   * 一次性快照，经 `?t=` 进页会带旧 t、SPA 切 P 后分 P 失真，复习跳转不正确。
   */
  const handleFavoriteMoment = useCallback(async () => {
    if (!videoInfo || momentSaving) return;
    const video = document.querySelector('video');
    if (!video || !Number.isFinite(video.currentTime)) {
      showToast('未找到可播放的视频，无法收藏此时刻', 'error');
      return;
    }
    setMomentSaving(true);
    try {
      const favorite = buildMomentFavorite({
        id: uuid(),
        bvid: videoInfo.bvid,
        p: readBiliPageP(),
        title: videoInfo.title,
        currentTime: video.currentTime,
        url: window.location.href,
        now: Date.now(),
      });
      await callOp('fav.put', { favorite });
      showToast(`已收藏此时刻（${formatSeconds(favorite.anchorTime)}）`);
    } catch {
      showToast('收藏失败，请重试', 'error');
    } finally {
      setMomentSaving(false);
    }
  }, [videoInfo, momentSaving, showToast]);

  // 「收藏这条回答」（第 33 轮巡检）：学习助手问答页签 AI 消息操作区入口。payload 组装走
  // core/bili/assistant.buildAiFavorite 纯函数（type='ai'，refId=chatId，字段口径同 HDU
  // 站内 favoriteChat：标题=回答摘要、content=回答全文；metadata 带 bvid/platform/url
  // 供检索回跳）。落库前按 refId 对 fav.list 复核防重：同一回答已收藏给中性提示，不重复写入。
  // 返回值（第 34 轮 P3-1）：成功（含防重命中）true / 失败 false，面板据此决定是否
  // 置入已收藏集合——失败不再被误标「已收藏」（toast 仍由本宿主提示）。
  const [chatFavoriteSaving, setChatFavoriteSaving] = useState(false);
  const handleFavoriteChat = useCallback(async (chat: AiFavoriteChatRef): Promise<boolean> => {
    if (!videoInfo || chatFavoriteSaving) return false;
    setChatFavoriteSaving(true);
    try {
      const existing = await callOp('fav.list', { filter: { limit: 500 } }).catch(() => [] as FavoriteEntity[]);
      if (Array.isArray(existing) && existing.some((f) => f.type === 'ai' && f.refId === chat.chatId)) {
        showToast('该回答已收藏过');
        return true;
      }
      await callOp('fav.put', {
        favorite: buildAiFavorite({
          id: uuid(),
          bvid: videoInfo.bvid,
          p: readBiliPageP(),
          title: videoInfo.title,
          chat,
          url: window.location.href,
          now: Date.now(),
        }),
      });
      showToast('已收藏该回答');
      return true;
    } catch {
      showToast('收藏失败，请重试', 'error');
      return false;
    } finally {
      setChatFavoriteSaving(false);
    }
  }, [videoInfo, chatFavoriteSaving, showToast]);

  // 「笔记转收藏」（第 33 轮巡检）：学习助手笔记页签条目入口，走既有 note.toFavorite op
  // （folderId 缺省进未分组；B 站笔记天然带 mediaKey 归属，第 29 轮守卫满足）。
  const handleConvertNote = useCallback(async (noteId: string) => {
    try {
      await callOp('note.toFavorite', { id: noteId });
      showToast('已转为收藏');
    } catch (err) {
      showToast(err instanceof AppError ? err.userMessage : '转收藏失败，请重试', 'error');
    }
  }, [showToast]);

  /** 打开学习助手面板并切到指定页签（第 44 轮）：q/n 快捷键与点击 FAB 的统一入口
   *  （第 51 轮审计 P3-3 口径修正：点击 .bili-qa-fab 也走这里） */
  const openQa = useCallback((tab: BiliQaTab) => {
    setQaTabSignal((prev) => ({ tab, seq: prev.seq + 1 }));
    setQaOpen(true);
  }, []);

  // 快捷键（第 44 轮，对齐 HDU 侧 onShortcut 的「站点优先」口径）：
  //   q → 学习助手·问答页签；b → 收藏此时刻（与 HDU addTimeFavorite 同语义，非打开
  //   收藏弹窗）；n → 学习助手·笔记页签；[ ] 大纲步进在 BiliQaPanel 内处理（大纲数据
  //   在面板中加载）。避让：修饰键 / 输入态 / contentEditable / BILI_RESERVED_KEYS
  //  （B 站播放器占用键，见 constants.ts）一律让行。
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      // shadow DOM 内键盘事件冒泡到 document 时 target 被重定向为宿主（第 51 轮审计
      // P2-1）：取 composedPath()[0] 才是真实焦点目标，输入态避让才生效
      const target = eventTargetOf(event) as HTMLElement | null;
      if (target?.isContentEditable) return;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/i.test(target.tagName)) return;
      if (event.isComposing) return;
      const key = event.key.toLowerCase();
      if (BILI_RESERVED_KEYS.has(key)) return;
      if (key === shortcuts.ask.toLowerCase()) {
        openQa('qa');
      } else if (key === shortcuts.favorite.toLowerCase()) {
        void handleFavoriteMoment();
      } else if (key === shortcuts.note.toLowerCase()) {
        openQa('notes');
      }
    };
    document.addEventListener('keydown', onShortcut);
    return () => document.removeEventListener('keydown', onShortcut);
  }, [shortcuts, openQa, handleFavoriteMoment]);

  // 菜单展开期间点击组外（页面其他区域）自动收起（第 51 轮审计 P3-6）：经
  // composedPath 判定真实点击目标是否落在 FAB 组内（shadow 重定向同 P2-1）
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDocPointerDown = (event: PointerEvent) => {
      const path = event.composedPath?.() ?? [];
      const group = groupRef.current;
      if (group && !path.includes(group)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointerDown, { capture: true });
    return () => document.removeEventListener('pointerdown', onDocPointerDown, { capture: true });
  }, [menuOpen]);

  // 快捷键档位同源读取（第 44 轮，挂载时一次；读取失败保持 DEFAULT_SHORTCUTS）
  useEffect(() => {
    let cancelled = false;
    loadSettings()
      .then((settings) => {
        if (!cancelled && settings.shortcuts) setShortcuts(settings.shortcuts);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // 用户手动主题覆盖（第 253 轮主题适配审计落地）：settings.theme 显式 'light'/'dark'
  // 时优先于宿主探测（设置页「主题」分区已有三态项，此前 B 站侧未接线——审计缺口）；
  // 'system' / 未加载完成回落宿主深色跟随（机制不变）。settings 变化实时跟随。
  const [themeSetting, setThemeSetting] = useState<'system' | 'light' | 'dark'>('system');
  useEffect(() => {
    let cancelled = false;
    loadSettings()
      .then((settings) => {
        if (!cancelled) setThemeSetting(settings.theme);
      })
      .catch(() => undefined);
    const offSettingsChanged = onSettingsChanged((settings) => {
      setThemeSetting(settings.theme);
    });
    return () => {
      cancelled = true;
      offSettingsChanged();
    };
  }, []);
  const panelDark = resolvePanelTheme(themeSetting, hostDark ? 'dark' : 'light') === 'dark';

  if (!videoInfo) return null;

  const dueBadge = dueBadgeLabel(dueCount);

  return (
    <div className="bili-root" data-theme={panelDark ? 'dark' : undefined}>
      {/* FAB 收敛（第 44 轮）：四枚常驻浮窗入口合并为「学习」主入口 + 上方展开菜单，
          降低右下角视觉侵扰。子钮保留原类名（.bili-fab/.bili-sub-fab/.bili-qa-fab/
          .bili-hub-fab）并常驻 DOM——收起态仅折叠视觉与指针，程序化 click（单测/e2e/
          工具栏探针联动）不受展开态影响；B 站工具栏探针命中时由宿主隐藏整组
          （.bili-fab-group），单入口策略不变。 */}
      <div className="bili-fab-group" ref={groupRef}>
        <div className={`bili-fab-menu${menuOpen ? ' is-open' : ''}`}>
          <button
            type="button"
            className={`bili-fab${collected ? ' is-collected' : ''}`}
            onClick={() => { setMenuOpen(false); setOpen(true); }}
            title={collected ? '已收藏 - 点击管理' : '收藏到知识库'}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {collected ? (
                <path d="M12 3.8l2.5 5.1 5.6.8-4.1 4 1 5.6-5-2.7-5 2.7 1-5.6-4.1-4 5.6-.8z" fill="currentColor" />
              ) : (
                <path d="M12 3.8l2.5 5.1 5.6.8-4.1 4 1 5.6-5-2.7-5 2.7 1-5.6-4.1-4 5.6-.8z" />
              )}
            </svg>
          </button>

          <button
            type="button"
            className="bili-sub-fab"
            onClick={() => { setMenuOpen(false); void handleFetchSubtitle(); }}
            disabled={subLoading}
            title={subLoading ? '正在获取字幕…' : '获取 B 站字幕（无字幕时作罢）'}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="5" width="18" height="14" rx="3" />
              <path d="M7 14.5h4M13 14.5h4" />
            </svg>
          </button>

          <button
            type="button"
            className="bili-qa-fab"
            onClick={() => { setMenuOpen(false); openQa('qa'); }}
            title="学习助手：速览 · 问答 · AI 标注 · 大纲 · 笔记"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.2 0-2.4-.2-3.4-.7L4 20l1-4.2A8.5 8.5 0 1 1 21 11.5z" />
              <path d="M8.5 10.5h7M8.5 13.5h4" />
            </svg>
          </button>

          <button
            type="button"
            className="bili-hub-fab"
            onClick={() => { setMenuOpen(false); setHubOpen(true); }}
            title="学习中心：知识库 · 统计"
          >
            {/* 书本图标（与 content/ui/icons.tsx 的 book 同路径，描边风格对齐其余入口） */}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 4.5h6a2 2 0 0 1 2 2V20a2.5 2.5 0 0 0-2.5-2.2H4z" />
              <path d="M20 4.5h-6a2 2 0 0 0-2 2V20a2.5 2.5 0 0 1 2.5-2.2H20z" />
            </svg>
          </button>
        </div>

        <button
          type="button"
          className={`bili-fab-main${menuOpen ? ' is-open' : ''}`}
          onClick={() => setMenuOpen((v) => !v)}
          title={dueBadge ? `学习（今日 ${dueBadge} 项复习到期）` : '学习（展开功能菜单）'}
          aria-expanded={menuOpen}
          aria-label={dueBadge ? `学习功能菜单（今日 ${dueBadge} 项复习到期）` : '学习功能菜单'}
        >
          {/* 四角星（spark）主图标：AI 学习助手的总入口 */}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3l2 5.6L19.6 11 14 13l-2 5.6L10 13 4.4 11 10 8.6z" />
          </svg>
          {/* 今日到期复习数角标（第 77 轮巡检）：>0 才渲染，口径见 dueBadgeLabel */}
          {dueBadge ? <span className="bili-fab-badge" aria-hidden="true">{dueBadge}</span> : null}
        </button>
      </div>

      {open ? (
        <div className="bili-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="bili-modal">
            <div className="bili-modal-head">
              <h3>收藏视频到知识库</h3>
              <button type="button" className="bili-modal-close" onClick={() => setOpen(false)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>

            <div className="bili-video-preview">
              {videoInfo.coverUrl ? (
                <img className="bili-video-cover" src={videoInfo.coverUrl} alt="" referrerPolicy="no-referrer" />
              ) : (
                <div className="bili-video-cover" />
              )}
              <div className="bili-video-info">
                <div className="bili-video-title">{videoInfo.title}</div>
                <div className="bili-video-meta">
                  {videoInfo.uploader ? <span>{videoInfo.uploader}</span> : null}
                  {videoInfo.duration ? <span> · {videoInfo.duration}</span> : null}
                </div>
              </div>
            </div>

            <div className="bili-modal-body">
              <div className="bili-field">
                <label className="bili-field-label">选择文件夹</label>
                <div className="bili-folder-list">
                  <button
                    type="button"
                    className={`bili-folder-chip${selectedFolderId === null && !showNewFolder ? ' is-active' : ''}`}
                    onClick={() => { setSelectedFolderId(null); setShowNewFolder(false); }}
                  >
                    不分类
                  </button>
                  {folders.map((f) => (
                    <button
                      type="button"
                      key={f.id}
                      className={`bili-folder-chip${selectedFolderId === f.id ? ' is-active' : ''}`}
                      onClick={() => { setSelectedFolderId(f.id); setShowNewFolder(false); }}
                    >
                      {f.name}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={`bili-folder-chip${showNewFolder ? ' is-active' : ''}`}
                    onClick={() => setShowNewFolder(true)}
                  >
                    + 新建
                  </button>
                </div>
                {showNewFolder ? (
                  <div className="bili-new-folder">
                    <input
                      type="text"
                      placeholder="文件夹名称"
                      value={newFolderName}
                      onChange={(e) => setNewFolderName(e.target.value)}
                      maxLength={50}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (newFolderName.trim()) {
                          setSelectedFolderId('__new__');
                        }
                      }}
                      disabled={!newFolderName.trim()}
                    >
                      确认
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="bili-field">
                <label className="bili-field-label">标签</label>
                <input
                  type="text"
                  className="bili-tags-input"
                  placeholder="用空格或逗号分隔，如：高数 编程"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                />
                <div className="bili-tags-hint">多个标签用空格、逗号分隔</div>
              </div>

              <div className="bili-field">
                <label className="bili-field-label">备注</label>
                <textarea
                  className="bili-note-input"
                  placeholder="添加备注（可选）"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={500}
                />
              </div>
            </div>

            <div className="bili-modal-foot">
              <button type="button" className="bili-btn bili-btn-cancel" onClick={() => setOpen(false)}>取消</button>
              <button
                type="button"
                className="bili-btn bili-btn-save"
                onClick={handleSave}
                disabled={saving || (showNewFolder && !newFolderName.trim())}
              >
                {saving ? '保存中…' : collected ? '更新收藏' : '收藏'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {resumePositionSec != null ? (
        <button type="button" className="bili-resume-chip" onClick={handleResume} title="跳转到上次播放位置">
          续看 {formatSeconds(resumePositionSec)}
        </button>
      ) : null}

      <BiliSubtitlePanel
        bvid={videoInfo.bvid}
        p={subP}
        open={subOpen}
        onClose={() => setSubOpen(false)}
        currentTime={subCurrentTime}
      />

      {/* 学习助手（AI 时间点问答 + AI 标注 + 时间点笔记 + 收藏此时刻工具行）：readPageP
          在打开/提问/保存时实时读 URL，分 P 跟随机制与字幕一致；无官方字幕时问答/标注
          给友好空态（笔记不依赖字幕仍可用）；提示复用宿主 toast 通道；收藏回答/笔记转
          收藏（第 33 轮）经回调在此落库 */}
      <BiliQaPanel
        bvid={videoInfo.bvid}
        open={qaOpen}
        onClose={() => setQaOpen(false)}
        readPageP={readBiliPageP}
        onFavoriteMoment={() => void handleFavoriteMoment()}
        favoriting={momentSaving}
        onFavoriteChat={handleFavoriteChat}
        onConvertNote={handleConvertNote}
        onToast={showToast}
        videoTitle={videoInfo.title}
        durationSec={videoInfo.durationSec}
        tabSignal={qaTabSignal}
      />

      {/* 学习中心（第 32 轮）：知识库管理（VideoFavCard 列表 + 加入复习 + 编辑弹层）
          与统计（BiliWatchCard）。面板经 portal 挂独立 shadow host（hdu-bili-hub-host，
          注入全量 UI_CSS + .hdu-root 类），深色跟随宿主判定；打开时盖住本宿主浮层，
          关闭后让位，不影响既有三 FAB 与字幕/问答面板 */}
      <BiliHubPanel open={hubOpen} onClose={() => setHubOpen(false)} dark={panelDark} />

      {/* AI 标注时间轴叠加条：aiResult.topics 存在时跟随 <video> 定位渲染（无结果不渲染，
          任何异常 fail-soft），点击标记 seek 到区间起点 */}
      <BiliTimelineMarkers bvid={videoInfo.bvid} readPageP={readBiliPageP} />

      {toast ? <div className={`bili-toast${toastKind === 'error' ? ' is-error' : ''}`}>{toast}</div> : null}
    </div>
  );
}
