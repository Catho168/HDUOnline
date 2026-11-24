/**
 * B 站「学习助手」浮层（第 24 轮问答 + 第 25 轮 AI 标注/大纲 + 第 26 轮时间点笔记）
 * ——B 站视频页专用的学习面板，与 BiliSubtitlePanel 同壳（同 backdrop/modal 视觉），
 * 由 bilibili.content.tsx 的独立 FAB 打开；不新开独立浮窗体系。
 * 面板内「速览 / 问答 / AI 标注 / 大纲 / 笔记」五个标签页共用同一壳。
 * 第 44 轮巡检：新增速览页签（时长/播放位置/字幕覆盖/知识标注四格 + 回到上次的位置
 * 锚点 chips，对齐 HDU 侧 PlayPanel.OverviewTab）与独立大纲页签（outline 自 AI 标注
 * 页签拆出，当前播放节点高亮，对齐 HDU 侧 OutlineTab）；[ ] 快捷键在大纲节点间步进
 * 跳转（outlineStepTarget 纯函数，避让 BILI_RESERVED_KEYS 与输入态）。
 *
 *  - AI 标注：展示当前 mediaKey 的 topics/outline（点击时间区间/大纲节点页内 seek）；
 *    无结果但有字幕 → 「生成 AI 标注」发起 ai.generate，生成中/完成/失败由 AI_PROGRESS/
 *    AI_DONE/AI_FAILED 事件驱动（口径同 HDU 侧）；无字幕 → 友好空态，不发起请求；
 *  - 数据：问答页签 1s 轮询跟随分 P，transcript.get 读 `bili:<bvid>`/`bili:<bvid>:p<N>`
 *    判定问答可用性（qaAvailability / aiAnnotationReadiness 纯函数）并恢复该 P 的最近
 *    会话；**无官方字幕 → 入口可见但面板给友好空态，不发起 qa.ask / ai.generate**
 *    （第 14 轮方向裁决：B 站不做本地 ASR，无字幕作罢）；qa.ask 的转写缺失类错误在
 *    面板侧映射为 B 站语境文案（assistant.biliQaAskErrorText）；标注/笔记区以低频轮询
 *    跟随 SPA 切 P（?p= 变化 → 新 mediaKey 重读）；
 *  - 问答：qa.ask（流式）以当前播放时间为 anchorTime、当前分 P 的 mediaKey 落库；
 *    流式增量经 onBackgroundEvent 订阅 QA_DELTA / QA_DONE / QA_FAILED（SW 按 mediaKey
 *    路由到本标签页——qa.ask 携带 mediaKey 时 SW 会自动登记本页订阅，见 background/index.ts
 *    handleRequest）。流式内容是 JSON 片段，面板只做「生成中」指示，QA_DONE 渲染终稿
 *    （口径同 HDU 侧 content/index.ts）；
 *  - 笔记（第 26 轮）：当前 mediaKey 的时间点笔记列表（anchorTime 升序），新建取
 *    <video>.currentTime，删除走两步确认（复用 components.tsx 的 useTwoStepConfirm 原语）；
 *    **不依赖字幕**，无字幕视频同样可用；mediaKey 实时读分 P，切 P 后列表按新键重读；
 *  - 上下文窗口档位（第 27 轮问答页签引入，第 28 轮扩展到 AI 标注页签）：qa.ask /
 *    ai.generate 均支持 per-request windowPreset，两页签工具行提供同款「窗口 小/中/大」
 *    紧凑选择（WindowPresetChips 复用），初值沿用全局设置、切换仅影响本面板后续请求
 *    （不回写全局设置）；HDU 侧 PlayPanel 无选档 UI，协议可选参数缺省=全局设置，
 *    HDU 行为零变化；
 *  - 笔记 placeholder（第 27 轮）：随播放时间实时更新「记一笔（mm:ss）」（500ms 节流读
 *    页内 <video>），播放器不可用时回退静态文案；
 *  - 分 P：readPageP 在打开与每次提问时实时读 URL（与字幕「获取时实时读 ?p=」同一跟随
 *    机制，SPA 切 P 后新提问自然落到新分 P 的 mediaKey）；
 *  - 竞态口径（第 25 轮复核 P2-1/P2-2 修复）：transcript.get / ai.get / note.list 的
 *    迟到响应一律按「响应所属 mediaKey === 当前 mediaKey（mediaKeyRef）」复核后才写入，
 *    不依赖 effect 级 cancelled 标记——快速切页签/切 P 时旧响应既不覆盖新数据，也不会把
 *    共享的加载态（checking）永久卡住；
 *  - 收藏此时刻：工具行按钮经 onFavoriteMoment 回调交由宿主（BiliCollectApp）落库 +
 *    toast，面板不直接触达 fav.put（宿主持有 videoInfo/title 上下文）；笔记的保存/删除
 *    提示同理经 onToast 回调走宿主既有 toast 通道；
 *  - 收藏回答 / 笔记转收藏（第 33 轮）：AI 消息操作区的「收藏」按钮经 onFavoriteChat、
 *    笔记条目的「转收藏」按钮经 onConvertNote 同样交宿主落库（buildAiFavorite → fav.put /
 *    note.toFavorite）并 toast；已收藏回答本地防重（按钮置灰 + 重复点击提示）；
 *  - 依据时间跳转：回答带 evidence 时点击直接 seek 页内 <video>（B 站上下文 page 模式）；
 *  - 样式：自带一份作用域限定在 `.bili-qa-scope` 的样式；暗色跟随宿主
 *    `.bili-root[data-theme="dark"]` 祖先选择器（core/bili/theme 判定驱动）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { callOp, onBackgroundEvent } from '@/core/shared/client';
import { BILI_RESERVED_KEYS, DEFAULT_SHORTCUTS } from '@/core/shared/constants';
import { errorTextOf } from '@/core/shared/errors';
import { biliMediaKey, type MediaKey } from '@/core/shared/mediaRef';
import { loadSettings } from '@/core/shared/settings';
import { formatClock, localDayKey, uuid, eventTargetOf } from '@/core/shared/utils';
import { buildChatsMarkdown } from '@/core/export/chats';
import { buildNotesMarkdown } from '@/core/export/notes';
import { downloadTextFile } from './reviewCards';
import {
  biliQaAskErrorText,
  buildOverviewAnchors,
  notePlaceholderText,
  outlineStepTarget,
  qaAvailability,
  type AiFavoriteChatRef,
} from '@/core/bili/assistant';
import { AI_STAGE_LABELS, aiAnnotationReadiness, topicSeekTarget } from '@/core/bili/aiMarkers';
// 窗口档位 chips（第 29 轮抽为两面板共享组件）：本面板沿用 bili 皮肤（缺省 variant），
// 类名与 QA_PANEL_CSS 的 .bili-qa-window* 一致，外观与行为零变化
import { WindowPresetChips } from './WindowPresetChips';
import { BiliWeeklyMini } from './bili/BiliWeeklyMini';
// 第 50 轮轻量拆分：样式串 / 页内 <video> 读取 helper / 笔记条目外移到 ui/bili/qa/
import { QA_PANEL_CSS } from './bili/qa/qaStyles';
import { BiliNoteRow } from './bili/qa/BiliNoteRow';
import {
  NOTE_PLACEHOLDER_THROTTLE_MS,
  PLAY_CLOCK_THROTTLE_MS,
  readVideoClockLabel,
  readVideoCurrentTime,
  readVideoDurationSec,
} from './bili/qa/qaDom';
import type {
  AiResultEntity,
  ChatGroupInfo,
  ChatMessageEntity,
  ContextWindowPreset,
  ExternalNoteEntity,
  NoteEntity,
  ShortcutMap,
  TranscriptEntity,
} from '@/core/shared/types';

/** 学习助手面板页签（第 44 轮起五页签：速览/问答/AI 标注/大纲/笔记） */
export type BiliQaTab = 'overview' | 'qa' | 'annotate' | 'outline' | 'notes';

export function BiliQaPanel({
  bvid,
  open,
  onClose,
  readPageP,
  onFavoriteMoment,
  favoriting = false,
  onFavoriteChat,
  onConvertNote,
  onToast,
  videoTitle,
  durationSec = null,
  tabSignal,
}: {
  bvid: string;
  open: boolean;
  onClose: () => void;
  /**
   * 实时读当前分 P（B 站 SPA 切 P 不重载页面）：打开面板与每次提问时各读一次，
   * mediaKey 跟随当前 ?p=（与字幕「获取时实时读 URL」同一跟随机制）。
   */
  readPageP: () => number;
  /** 「收藏此时刻」回调：由宿主（BiliCollectApp）组装 fav.put 并 toast */
  onFavoriteMoment: () => void;
  /** 宿主正在保存时间点收藏（按钮置忙） */
  favoriting?: boolean;
  /**
   * 「收藏这条回答」回调（第 33 轮）：由宿主组装 type='ai' 收藏（buildAiFavorite）
   * 落库 + toast；面板侧另做已收藏 chatId 的本地防重（按钮置灰）。
   * 返回值（第 34 轮 P3-1）：宿主落库成功（含「已收藏过」防重命中）返回 true，
   * 失败返回 false（失败 toast 已由宿主提示）——面板仅在成功时把 chatId 置入
   * 已收藏集合，失败时按钮保持可点以便重试。
   */
  onFavoriteChat?: (chat: AiFavoriteChatRef) => boolean | void | Promise<boolean | void>;
  /** 「笔记转收藏」回调（第 33 轮）：由宿主调 note.toFavorite（folderId 缺省）并 toast */
  onConvertNote?: (noteId: string) => void | Promise<void>;
  /** 提示回调（第 26 轮笔记页签）：复用宿主既有 toast 通道（BiliCollectApp.showToast） */
  onToast?: (message: string, kind?: 'info' | 'error') => void;
  /** 视频标题（第 44 轮速览页签头部；宿主持有 videoInfo 挂载快照） */
  videoTitle?: string;
  /** 视频时长快照秒（第 44 轮速览「视频时长」格回退值；优先实时 <video>.duration） */
  durationSec?: number | null;
  /**
   * 页签切换信号（第 44 轮快捷键接线）：宿主 openQa(tab) 时递增 seq 并携带目标页签，
   * 面板在 seq 变化（或带信号打开）时切到 signal.tab——面板已开时按快捷键也能即时
   * 切换；所有打开路径（含点击 FAB）都经 openQa 递增信号，页签总是复位/直达预期
   * （第 51 轮审计 P3-3 注释口径修正）。
   */
  tabSignal?: { tab: BiliQaTab; seq: number };
}) {
  const [p, setP] = useState<number>(() => 1);
  // 面板分区（第 44 轮起五页签）：overview = 速览（四格 + 回位锚点），qa = AI 时间点
  // 问答（第 24 轮），annotate = AI 标注（第 25 轮），outline = 内容大纲（第 44 轮自
  // 标注页签拆出），notes = 时间点笔记（第 26 轮）
  const [tab, setTab] = useState<BiliQaTab>('qa');
  const [transcript, setTranscript] = useState<TranscriptEntity | null>(null);
  const [checking, setChecking] = useState(false);
  const [messages, setMessages] = useState<ChatMessageEntity[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | undefined>(undefined);
  // 会话历史管理（第 88 轮巡检）：查看/删除历史问答会话（只读预览；删除后既有轮询自动回退最新会话）
  const [historyOpen, setHistoryOpen] = useState(false);
  const [groups, setGroups] = useState<ChatGroupInfo[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  // 跨 P 聚合（第 104 轮巡检）：开启后按 bvid 聚合全部分 P 的会话（行带 mediaKey/p）
  const [crossP, setCrossP] = useState(false);
  // 历史搜索（第 89 轮巡检）：按首问摘要过滤
  const [historyQuery, setHistoryQuery] = useState('');
  // 清空全部（第 90 轮巡检）：两步确认
  const [clearAllArmed, setClearAllArmed] = useState(false);
  const [previewGroupId, setPreviewGroupId] = useState<string | null>(null);
  const [previewMessages, setPreviewMessages] = useState<ChatMessageEntity[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [streamingChatId, setStreamingChatId] = useState<string | undefined>(undefined);
  const [asking, setAsking] = useState(false);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  // AI 标注区：当前 mediaKey（生成落库与事件过滤键）+ 结果 + 生成中/失败态
  const [mediaKey, setMediaKey] = useState<MediaKey | null>(null);
  const [aiResult, setAiResult] = useState<AiResultEntity | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiStage, setAiStage] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  // 笔记区（第 26 轮）：当前 mediaKey 的时间点笔记 + 输入/保存态
  const [notes, setNotes] = useState<NoteEntity[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [noteInput, setNoteInput] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  // 已收藏的 AI 回答（第 33 轮）：本面板会话内的防重集合（按钮置灰）；宿主侧落库前
  // 仍按 refId 对 fav.list 复核，双保险
  const [favoritedChatIds, setFavoritedChatIds] = useState<Set<string>>(() => new Set());
  // 上下文窗口档位（第 27 轮问答页签引入，第 28 轮扩展到 AI 标注页签）：qa.ask /
  // ai.generate 均按 args.windowPreset ?? 全局设置取档（background/qa.ts、ai.ts 共用
  // resolveContextWindowPreset），初始沿用全局设置、切换仅影响本面板后续请求（不回写全局）
  const [windowPreset, setWindowPreset] = useState<ContextWindowPreset>('medium');
  // 笔记页签 placeholder 的实时时间文本（null = <video> 不可用，回退静态文案）
  const [noteClock, setNoteClock] = useState<string | null>(null);
  // 快捷键档位（第 44 轮）：面板打开时读全局 settings.shortcuts，[ ] 大纲步进用；
  // 读取失败保持 DEFAULT_SHORTCUTS（与 HDU 侧同源配置）
  const [shortcuts, setShortcuts] = useState<ShortcutMap>(DEFAULT_SHORTCUTS);
  // 速览/大纲页签的实时播放位置（500ms 节流读页内 <video>.currentTime）：
  // 速览「播放位置」格与大纲当前节点高亮共用
  const [playClock, setPlayClock] = useState<number | undefined>(undefined);
  // 速览页签：跨会话播放断点（video.progress.get.lastPositionSec）与最近会话消息
  //（取用户消息锚点做「上次提问」chips；notes 复用笔记页签的 state）
  const [ovLastPosition, setOvLastPosition] = useState<number | null>(null);
  const [ovChats, setOvChats] = useState<ChatMessageEntity[]>([]);
  // readPageP 以 ref 持有：父组件内联箭头每次渲染都是新引用，进 effect 依赖会造成反复重载
  const readPagePRef = useRef(readPageP);
  useEffect(() => {
    readPagePRef.current = readPageP;
  });
  // onToast 同理经 ref 引用（回调 identities 不进 effect 依赖）
  const onToastRef = useRef(onToast);
  useEffect(() => {
    onToastRef.current = onToast;
  });
  // onFavoriteChat / onConvertNote（第 33 轮）同理经 ref 引用
  const onFavoriteChatRef = useRef(onFavoriteChat);
  useEffect(() => {
    onFavoriteChatRef.current = onFavoriteChat;
  });
  const onConvertNoteRef = useRef(onConvertNote);
  useEffect(() => {
    onConvertNoteRef.current = onConvertNote;
  });
  // 打开面板时读一次全局设置作为档位初值（切换后仅本面板生效，不回写全局）；
  // 读取失败保持默认档（medium，与 DEFAULT_SETTINGS.contextWindow 一致）。
  // P3-1（第 28 轮）：用户在设置读取返回前已手动点选档位时不再回填——
  // 异步读取迟到覆盖用户选择（windowPresetTouchedRef 登记「已交互」）
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    loadSettings()
      .then((settings) => {
        if (cancelled) return;
        if (!windowPresetTouchedRef.current) setWindowPreset(settings.contextWindow);
        // 快捷键档位同源读取（第 44 轮）：settings.shortcuts 缺失（旧测试桩）保持默认
        if (settings.shortcuts) setShortcuts(settings.shortcuts);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);
  // 页签切换信号（第 44 轮）：仅随 seq 变化响应（宿主 openQa(tab) 递增），面板已开时
  // 按快捷键也能即时切页签；所有打开路径都经 openQa 递增信号（第 51 轮审计 P3-3 注释
  // 口径修正），页签总是落到预期目标
  const tabSignalSeq = tabSignal?.seq ?? 0;
  useEffect(() => {
    if (!open) return;
    const nextTab = tabSignal?.tab;
    if (nextTab) setTab(nextTab);
  }, [open, tabSignalSeq]);
  // 笔记页签 placeholder 随播放时间实时更新：500ms 节流读页内 <video>（与字幕浮层
  // timeupdate 节流同数量级），文本不变时 setState 同值短路不触发重渲染；
  // 无 <video>（或时间非法）置 null → placeholder 回退静态文案。非笔记页签不轮询
  useEffect(() => {
    if (!open || tab !== 'notes') {
      setNoteClock(null);
      return undefined;
    }
    const update = () => setNoteClock(readVideoClockLabel());
    update();
    const timer = window.setInterval(update, NOTE_PLACEHOLDER_THROTTLE_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [open, tab]);
  // 速览/大纲页签的实时播放位置（第 44 轮）：500ms 节流读页内 <video>，页签切走即停
  // 轮询并清值（同笔记 placeholder 的节流口径）
  useEffect(() => {
    if (!open || (tab !== 'overview' && tab !== 'outline')) {
      setPlayClock(undefined);
      return undefined;
    }
    const update = () => setPlayClock(readVideoCurrentTime());
    update();
    const timer = window.setInterval(update, PLAY_CLOCK_THROTTLE_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [open, tab]);
  /**
   * 当前 mediaKey 的同步 ref（P2-1/P2-2 竞态修复的复核基准）：transcript.get / ai.get /
   * note.list 的迟到响应只有在「响应所属 mediaKey === mediaKeyRef.current」时才允许写入
   * state——快速切页签/切 P 后，旧响应既不覆盖新数据，也不会把共享加载态永久卡住。
   */
  const mediaKeyRef = useRef<MediaKey | null>(null);
  // P2-1③（第 28 轮）：当前流式回答所属的 mediaKey（QA_DELTA 载荷无 mediaKey 字段，
  // 事件复核时与 mediaKeyRef 对照，杜绝跨 P 串显）
  const streamingMediaKeyRef = useRef<MediaKey | null>(null);
  // P2-1②（第 28 轮）：当前流式回答 chatId 的同步 ref——1s 轮询检测到切 P 时据此
  // 先 qa.abort 旧流再重置（state 的函数式更新拿不到「当前值」，事件处理器闭包也
  // 不含 streamingChatId 依赖，统一以本 ref 为准）
  const streamingChatIdRef = useRef<string | undefined>(undefined);
  // P3-1（第 28 轮）：用户是否已手动点选过窗口档位——loadSettings 异步回填初值时
  // 已交互则不覆盖（面板打开瞬间即可点 chips，与设置读取存在竞态）
  const windowPresetTouchedRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // 关闭/无 bvid 时清态复位（分区回默认问答页）。各页签的数据加载由页签自身的
  // 轮询 effect 负责：问答页签第 27 轮起同样用 1s 轮询跟随分 P（见下方 effect），
  // 标注/笔记页签沿用各自既有的轮询 effect。
  useEffect(() => {
    if (open && bvid) return undefined;
    setTab('qa');
    setTranscript(null);
    setMessages([]);
    setActiveGroupId(undefined);
    setStreamingChatId(undefined);
    setAsking(false);
    setInput('');
    setError(null);
    setMediaKey(null);
    mediaKeyRef.current = null;
    streamingMediaKeyRef.current = null;
    streamingChatIdRef.current = undefined;
    windowPresetTouchedRef.current = false;
    setAiResult(null);
    setAiBusy(false);
    setAiStage(null);
    setAiError(null);
    setNotes([]);
    setNotesLoading(false);
    setNoteInput('');
    setNoteSaving(false);
    setFavoritedChatIds(new Set());
    setOvLastPosition(null);
    setOvChats([]);
    return undefined;
  }, [open, bvid]);

  // 订阅 SW 事件（仅面板打开期间）：问答流式增量只做指示，QA_DONE 落终稿；
  // AI 标注生成中/完成/失败由 AI_PROGRESS/AI_DONE/AI_FAILED 驱动（按当前 mediaKey
  // 过滤，其他分 P / 其他视频的事件不落本页面板，口径同 HDU 侧 isForCurrentCour）
  useEffect(() => {
    if (!open) return undefined;
    return onBackgroundEvent((event) => {
      if (event.name === 'AI_PROGRESS') {
        if (event.data.mediaKey !== mediaKey) return;
        setAiBusy(true);
        setAiStage(event.data.stage);
        return;
      }
      if (event.name === 'AI_DONE') {
        if (event.data.mediaKey !== mediaKey) return;
        setAiBusy(false);
        setAiStage(null);
        setAiError(null);
        // 事件只带计数，终稿回读 ai.get（与 HDU 侧同口径）
        void callOp('ai.get', { mediaKey })
          .then((r) => setAiResult(r.result))
          .catch(() => undefined);
        return;
      }
      if (event.name === 'AI_FAILED') {
        if (event.data.mediaKey !== mediaKey) return;
        setAiBusy(false);
        setAiStage(null);
        setAiError(event.data.error.userMessage);
        return;
      }
      if (event.name === 'QA_DELTA') {
        // 流式内容是 JSON 片段，不渲染进正文；仅驱动「生成中」指示（口径同 HDU 面板）
        const data = event.data;
        // P2-1③（第 28 轮）：DELTA 载荷无 mediaKey 字段，按「发起流式时登记的
        // streamingMediaKeyRef」与当前 mediaKeyRef 对照——切 P 后旧 P 的迟到增量
        // 不得在新 P 视图点亮「生成中」（无流式登记时同样忽略）
        if (streamingMediaKeyRef.current === null || streamingMediaKeyRef.current !== mediaKeyRef.current) return;
        if (activeGroupId && data.groupId !== activeGroupId) return;
        setStreamingChatId(data.chatId);
        streamingChatIdRef.current = data.chatId;
        setAsking(true);
        return;
      }
      if (event.name === 'QA_DONE') {
        const message = event.data.message as ChatMessageEntity | undefined;
        if (!message) return;
        // P2-1③（第 28 轮）：DONE 载荷自带 message.mediaKey，直接与当前 mediaKeyRef
        // 复核——旧 P 流的迟到终稿不并入新 P 的消息列表（跨 P 串显杜绝）
        if (message.mediaKey !== mediaKeyRef.current) return;
        setMessages((prev) => {
          // 移除同 id 旧状态与同会话的空占位，再按时间归位
          const next = prev.filter(
            (m) => m.id !== message.id && !(m.role === 'ai' && m.content === '' && m.groupId === message.groupId),
          );
          return [...next, message].sort((a, b) => a.createdAt - b.createdAt);
        });
        // 流式态以 streamingChatIdRef 为准同步清除（ref 在各写入点与 state 同步更新）；
        // 流式归属登记一并解除（DONE 之后不再有本流的 DELTA）
        if (streamingChatIdRef.current === message.id) {
          streamingChatIdRef.current = undefined;
          setStreamingChatId(undefined);
          streamingMediaKeyRef.current = null;
        }
        setAsking(false);
        return;
      }
      if (event.name === 'QA_FAILED') {
        const { chatId, error: failedError } = event.data;
        // P2-1③ 同口径复核（第 29 轮审计#4，三链对称）：QA_FAILED 载荷与 QA_DELTA
        // 一样不带 mediaKey，归属只能取「发起流式时登记的流式 chat」——失败 chatId
        // 必须是当前登记的 streamingChatIdRef，且其归属 streamingMediaKeyRef 与当前
        // mediaKeyRef 一致才写 state。旧 P 的迟到失败（切 P 后登记已清除或已换新流）
        // 一律忽略：不标失败、不清流式登记、不复位 asking，避免误清新 P 流的「生成中」。
        if (
          streamingChatIdRef.current !== chatId ||
          streamingMediaKeyRef.current === null ||
          streamingMediaKeyRef.current !== mediaKeyRef.current
        ) {
          return;
        }
        setMessages((prev) =>
          prev.map((m) => (m.id === chatId ? { ...m, status: 'failed' as const, error: failedError.userMessage } : m)),
        );
        streamingChatIdRef.current = undefined;
        setStreamingChatId(undefined);
        streamingMediaKeyRef.current = null;
        setAsking(false);
      }
    });
  }, [open, activeGroupId, mediaKey]);

  // 问答区数据加载（第 27 轮审计 P2-1）：与标注/笔记区同型——1s 轮询跟随 ?p= 变化
  // （B 站 SPA 切 P 不重载页面）。此前问答页签只在打开时读一次字幕可用性与会话，
  // 切 P 后 handleAsk 会拿「旧 P 的 transcript 可用性 + 新 P 的 mediaKey」发请求：
  // 旧 P 无字幕 → 新 P 有字幕时输入框被错误隐藏；反向则 SW 抛 HDU 话术的转写缺失
  // 错误。现在切 P 后按新 mediaKey 重读 transcript 可用性，并恢复该 P 的最近会话
  // /消息（与标注/笔记页签同模式同节流）。竞态口径同 P2-1/P2-2 修复：响应写入一律
  // 按「响应所属 mediaKey === mediaKeyRef.current」复核，不引入新的迟到响应竞态。
  useEffect(() => {
    if (!open || tab !== 'qa' || !bvid) return undefined;
    let lastP = -1;
    const load = () => {
      const pageP = readPagePRef.current();
      if (pageP === lastP) return;
      lastP = pageP;
      // P2-1②（第 28 轮）：切 P 时旧 P 的流式回答可能仍在生成——先 abort 旧流再重置，
      // 消除「幽灵生成中」与并发双流（SW 侧中止后落 aborted 终态，不补发事件）
      const staleChatId = streamingChatIdRef.current;
      if (staleChatId) {
        void callOp('qa.abort', { chatId: staleChatId }).catch(() => undefined);
        streamingChatIdRef.current = undefined;
        streamingMediaKeyRef.current = null;
      }
      setP(pageP);
      const key = biliMediaKey(bvid, pageP);
      mediaKeyRef.current = key;
      setMediaKey(key);
      setChecking(true);
      setTranscript(null);
      setMessages([]);
      setActiveGroupId(undefined);
      setStreamingChatId(undefined);
      setAsking(false);
      setError(null);
      void callOp('transcript.get', { mediaKey: key })
        .then((value) => {
          // 迟到响应按 mediaKey 复核（第 25/26 轮既有模式）：切 P 后旧 P 响应不覆盖新 P
          if (key === mediaKeyRef.current) setTranscript(value);
        })
        .catch(() => {
          /* 读取失败按「无字幕」降级展示，不打断面板 */
        })
        .finally(() => {
          if (key === mediaKeyRef.current) setChecking(false);
        });
      // 恢复该 mediaKey 最近一个问答会话（无历史则空列表；失败不阻塞新提问）
      void callOp('qa.groups', { mediaKey: key })
        .then((groups) => {
          if (key !== mediaKeyRef.current) return [];
          const latest = groups[0];
          if (!latest) return [];
          if (key === mediaKeyRef.current) setActiveGroupId(latest.groupId);
          return callOp('qa.list', { mediaKey: key, groupId: latest.groupId });
        })
        .then((chats) => {
          if (key === mediaKeyRef.current) setMessages(chats);
        })
        .catch(() => {
          /* 历史读取失败不阻塞新提问 */
        });
    };
    load();
    const timer = window.setInterval(load, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [open, tab, bvid]);

  // 标注/大纲/速览三页签共享的 AI 数据加载（第 44 轮起条件扩为 aiGroupActive：三页签
  // 互切不重拉、不闪空态）：按当前分 P 的 mediaKey 读 transcript + aiResult，速览页签
  // 另读播放断点与最近会话（回位锚点）。B 站 SPA 切 P 不重载页面，用低频轮询跟随 ?p=
  // 变化——切 P 后旧 P 的结果/生成态立即清除、事件过滤键同步切换，避免串台。
  // 竞态口径（P2-1/P2-2 修复）：响应写入一律按「响应所属 mediaKey === mediaKeyRef.current」
  // 复核，不依赖 effect 级 cancelled——快速切页签后，迟到响应仍能解除共享的
  // checking 加载态（否则问答页签会永久停在「正在检查字幕…」），分 P 翻转时旧 P 响应不覆盖新 P。
  // 会话历史（第 88 轮巡检）：打开时拉取分组；预览/删除按当前分 P 的 mediaKey
  const openHistory = useCallback(() => {
    setHistoryOpen(true);
    setHistoryQuery('');
    setClearAllArmed(false);
    setPreviewGroupId(null);
    setPreviewMessages([]);
  }, []);

  // 分组加载（第 104 轮巡检）：跨 P 开关切换时重拉——聚合态走 qa.groupsAll（bvid 全部
  // 分 P，行带 mediaKey/p），普通态维持 qa.groups（当前分 P mediaKey）；排序口径不变
  const loadGroups = useCallback(
    (aggregated: boolean) => {
      const req = aggregated
        ? callOp('qa.groupsAll', { bvid })
        : callOp('qa.groups', { mediaKey: biliMediaKey(bvid, readPagePRef.current()) });
      return req
        .then((result) => setGroups([...result].sort((a, b) => b.lastAt - a.lastAt)))
        .catch(() => setGroups([]));
    },
    [bvid],
  );

  useEffect(() => {
    if (!historyOpen) return undefined;
    setGroupsLoading(true);
    loadGroups(crossP).finally(() => setGroupsLoading(false));
    return undefined;
  }, [historyOpen, crossP, loadGroups]);

  // 清空全部会话（第 90 轮巡检）：qa.clear 不带 groupId 即清空本视频（当前分 P）全部；两步确认
  const clearAllGroups = useCallback(() => {
    const key = biliMediaKey(bvid, readPageP());
    void callOp('qa.clear', { mediaKey: key }).catch(() => undefined);
    setMessages([]);
    setActiveGroupId(undefined);
    setGroups([]);
    setPreviewGroupId(null);
    setPreviewMessages([]);
    setClearAllArmed(false);
  }, [bvid, readPageP]);

  // 导出全部会话（第 91 轮巡检）：本视频全部消息 → Markdown；第 105 轮起跨 P 开启时
  // 走 qa.listAll 合并全部分 P（标题标注「全部分 P」，文件名带跨 P 标记）
  const exportAllGroups = useCallback(() => {
    if (crossP) {
      callOp('qa.listAll', { bvid })
        .then((list) =>
          downloadTextFile(
            `智慧课堂-问答记录-全部-跨P-${localDayKey()}.md`,
            buildChatsMarkdown(list, `${videoTitle || 'B 站视频'}（全部分 P）`),
          ),
        )
        .catch(() => onToastRef.current?.('导出失败，请重试', 'error'));
      return;
    }
    callOp('qa.list', { mediaKey: biliMediaKey(bvid, readPagePRef.current()) })
      .then((list) =>
        downloadTextFile(
          `智慧课堂-问答记录-全部-${localDayKey()}.md`,
          buildChatsMarkdown(list, videoTitle ? `${videoTitle}${readPageP() > 1 ? ` P${readPageP()}` : ''}` : 'B 站视频'),
        ),
      )
      .catch(() => onToastRef.current?.('导出失败，请重试', 'error'));
  }, [bvid, readPageP, videoTitle, crossP]);

  /** 导出单个历史会话（第 89 轮巡检）：qa.list 拉该组消息 → buildChatsMarkdown 下载；
   *  第 104 轮起 groupKey 可指定其他分 P 的 mediaKey（跨 P 聚合视图） */
  const exportGroup = useCallback(
    (groupId: string, title: string, groupKey?: MediaKey) => {
      const key = groupKey ?? biliMediaKey(bvid, readPagePRef.current());
      callOp('qa.list', { mediaKey: key, groupId })
        .then((list) =>
          downloadTextFile(
            `智慧课堂-问答记录-${localDayKey()}.md`,
            buildChatsMarkdown(list, `${videoTitle ? `${videoTitle}${readPageP() > 1 ? ` P${readPageP()}` : ''}` : 'B 站视频'} · ${title}`),
          ),
        )
        .catch(() => onToastRef.current?.('导出失败，请重试', 'error'));
    },
    [bvid, readPageP, videoTitle],
  );

  const previewGroup = useCallback(
    (groupId: string, groupKey?: MediaKey) => {
      const key = groupKey ?? biliMediaKey(bvid, readPagePRef.current());
      setPreviewGroupId(groupId);
      setPreviewLoading(true);
      callOp('qa.list', { mediaKey: key, groupId })
        .then((list) => setPreviewMessages(list))
        .catch(() => setPreviewMessages([]))
        .finally(() => setPreviewLoading(false));
    },
    [bvid],
  );

  const deleteGroup = useCallback(
    (groupId: string, groupKey?: MediaKey) => {
      const key = groupKey ?? biliMediaKey(bvid, readPagePRef.current());
      void callOp('qa.clear', { mediaKey: key, groupId }).catch(() => undefined);
      setGroups((prev) => prev.filter((group) => group.groupId !== groupId));
      if (previewGroupId === groupId) {
        setPreviewGroupId(null);
        setPreviewMessages([]);
      }
    },
    [bvid, previewGroupId],
  );

  // 历史搜索（第 89 轮巡检）：按首问摘要过滤
  const historyKeyword = historyQuery.trim().toLowerCase();
  const filteredGroups = groups.filter(
    (group) => !historyKeyword || group.title.toLowerCase().includes(historyKeyword),
  );

  const aiGroupActive = tab === 'annotate' || tab === 'outline' || tab === 'overview';
  useEffect(() => {
    if (!open || !aiGroupActive || !bvid) return undefined;
    let lastP = -1;
    const load = () => {
      const pageP = readPagePRef.current();
      if (pageP === lastP) return;
      lastP = pageP;
      setP(pageP);
      const key = biliMediaKey(bvid, pageP);
      mediaKeyRef.current = key;
      setMediaKey(key);
      setAiResult(null);
      setAiBusy(false);
      setAiStage(null);
      setAiError(null);
      setChecking(true);
      void callOp('transcript.get', { mediaKey: key })
        .then((value) => {
          if (key === mediaKeyRef.current) setTranscript(value);
        })
        .catch(() => {
          /* 读取失败按「无字幕」降级展示，不打断面板 */
        })
        .finally(() => {
          if (key === mediaKeyRef.current) setChecking(false);
        });
      void callOp('ai.get', { mediaKey: key })
        .then((r) => {
          if (key === mediaKeyRef.current) setAiResult(r.result);
        })
        .catch(() => {
          /* 读取失败按「无结果」降级展示 */
        });
      // 速览页签的回位锚点数据（标注/大纲页签顺带预取，无额外面板开销）：
      // 跨会话播放断点 + 最近会话的用户提问锚点
      void callOp('video.progress.get', { platform: 'bilibili', videoId: bvid })
        .then((progress) => {
          if (key === mediaKeyRef.current) setOvLastPosition(progress?.lastPositionSec ?? null);
        })
        .catch(() => {
          /* 断点读取失败不阻塞速览其余格子 */
        });
      void callOp('qa.groups', { mediaKey: key })
        .then((groups) => {
          if (key !== mediaKeyRef.current) return [];
          const latest = groups[0];
          if (!latest) return [];
          return callOp('qa.list', { mediaKey: key, groupId: latest.groupId });
        })
        .then((chats) => {
          if (key === mediaKeyRef.current) setOvChats(chats);
        })
        .catch(() => {
          /* 会话锚点读取失败不阻塞速览其余格子 */
        });
    };
    load();
    const timer = window.setInterval(load, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [open, aiGroupActive, bvid]);

  // 笔记区数据加载（第 26 轮；第 44 轮起速览页签共享同一份 notes，互切不重拉）：
  // 与标注区同型——低频轮询跟随 ?p=（SPA 切 P 后按新 mediaKey 重读；P1 裸键口径与
  // 字幕/问答一致）。笔记不依赖字幕，无字幕视频同样可用。
  // 迟到响应同样按 mediaKey 复核（同 P2-2 口径）。
  const notesGroupActive = tab === 'notes' || tab === 'overview';
  useEffect(() => {
    if (!open || !notesGroupActive || !bvid) return undefined;
    let lastP = -1;
    const load = () => {
      const pageP = readPagePRef.current();
      if (pageP === lastP) return;
      lastP = pageP;
      setP(pageP);
      const key = biliMediaKey(bvid, pageP);
      mediaKeyRef.current = key;
      setMediaKey(key);
      setNotesLoading(true);
      void callOp('note.list', { mediaKey: key })
        .then((list) => {
          if (key === mediaKeyRef.current) setNotes(list);
        })
        .catch(() => {
          if (key === mediaKeyRef.current) setNotes([]);
        })
        .finally(() => {
          if (key === mediaKeyRef.current) setNotesLoading(false);
        });
    };
    load();
    const timer = window.setInterval(load, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [open, notesGroupActive, bvid]);

  // 消息变化 / 流式开始时滚到列表底部（问答面板阅读动线）
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamingChatId, checking]);

  const handleAsk = useCallback(async () => {
    const question = input.trim();
    if (!question || asking) return;
    // 防御性复检：UI 已在无字幕时隐藏输入框，这里兜底避免误发请求
    const availability = qaAvailability(transcript);
    if (!availability.available) {
      setError(availability.message);
      return;
    }
    // 分 P 在提问时实时读 URL（SPA 切 P 后新提问自然落到新分 P 的 mediaKey）
    const pageP = readPagePRef.current();
    setP(pageP);
    // P2-1①（第 28 轮）：发送时捕获本次提问的 mediaKey（key）作为复核基准——
    // 后续每个 await 之后写 state 前都用 key === mediaKeyRef.current 复核，
    // 杜绝旧 P 的完成/失败整段渲染进新 P 视图（activeGroupId 不跨 P 带走、
    // messages 不串显、asking/streaming 不卡新 P）。轮询 load() 是 mediaKeyRef
    // 的权威写入者，这里同步一次消除「切 P 后 1s 内提问」的窗口期错判。
    const key = biliMediaKey(bvid, pageP);
    mediaKeyRef.current = key;
    setAsking(true);
    setError(null);
    // QA_DELTA 无 mediaKey 字段：发起流式时登记归属（事件处理器复核用，见 P2-1③）
    streamingMediaKeyRef.current = key;
    try {
      const result = await callOp('qa.ask', {
        mediaKey: key,
        question,
        anchorTime: readVideoCurrentTime(),
        groupId: activeGroupId,
        // per-request 档位（qa.ask 专有）：取面板内当前选中档，未切换时即全局设置值
        windowPreset,
      });
      if (key !== mediaKeyRef.current) return;
      setActiveGroupId(result.groupId);
      setStreamingChatId(result.immediate ? undefined : result.chatId);
      streamingChatIdRef.current = result.immediate ? undefined : result.chatId;
      // 拉取该会话全部消息（含用户消息与 AI 占位）；流式更新随后经事件推送合并
      const chats = await callOp('qa.list', { mediaKey: key, groupId: result.groupId }).catch(() => []);
      if (key !== mediaKeyRef.current) return;
      setMessages(chats);
      if (result.immediate) {
        // immediate：答案已终态落库，直接呈现（无流式过程）
        setAsking(false);
        streamingMediaKeyRef.current = null;
      }
    } catch (err) {
      if (key !== mediaKeyRef.current) return;
      setAsking(false);
      setStreamingChatId(undefined);
      streamingChatIdRef.current = undefined;
      streamingMediaKeyRef.current = null;
      // 转写缺失类错误映射为 B 站语境文案（P2-1）；其余错误经 errorTextOf 照常展示
      setError(biliQaAskErrorText(err));
    }
  }, [input, asking, transcript, activeGroupId, bvid, windowPreset]);

  const handleAbort = useCallback(() => {
    if (!streamingChatId) return;
    void callOp('qa.abort', { chatId: streamingChatId }).catch(() => undefined);
    // SW 侧中止不补发事件：本地立即解除流式态，并回读会话拿到 aborted 终态内容
    setStreamingChatId(undefined);
    streamingChatIdRef.current = undefined;
    streamingMediaKeyRef.current = null;
    setAsking(false);
    const pageP = readPagePRef.current();
    const key = biliMediaKey(bvid, pageP);
    callOp('qa.list', { mediaKey: key, groupId: activeGroupId })
      .then((chats) => {
        // 迟到响应按 mediaKey 复核（同 P2-1 口径）：切 P 后旧 P 的会话回读不覆盖新 P
        if (key === mediaKeyRef.current) setMessages(chats);
      })
      .catch(() => undefined);
  }, [streamingChatId, bvid, activeGroupId]);

  // 发起 AI 标注生成：mediaKey 在点击时实时读分 P（SPA 切 P 后生成自然落到新分 P）；
  // started=false（如已有任务在跑）给中性提示；进度/完成/失败走 AI_* 事件驱动
  const handleGenerate = useCallback(async () => {
    if (aiBusy) return;
    // 防御性复检：无字幕时 UI 不渲染生成按钮，这里兜底确保不发请求
    const availability = qaAvailability(transcript);
    if (!availability.available) {
      setAiError(availability.message);
      return;
    }
    const pageP = readPagePRef.current();
    setP(pageP);
    const key = biliMediaKey(bvid, pageP);
    mediaKeyRef.current = key;
    setMediaKey(key);
    setAiBusy(true);
    setAiStage(null);
    setAiError(null);
    try {
      // per-request 档位（第 28 轮，与问答页签同口径）：携带面板内当前选中档，
      // SW 侧按 args.windowPreset ?? 全局设置解析（background/ai.ts）
      const result = await callOp('ai.generate', { mediaKey: key, windowPreset });
      if (!result.started) {
        setAiBusy(false);
        setAiError(result.reason ?? '暂时无法生成，请稍后重试');
      }
    } catch (err) {
      setAiBusy(false);
      setAiError(errorTextOf(err, '生成失败，请稍后重试'));
    }
  }, [aiBusy, transcript, bvid, windowPreset]);

  // 停止生成：ai.abort 按 mediaKey 中止；SW 侧中止不补发事件，本地立即解除生成中态
  //（口径同 qa.abort）
  const handleAbortAi = useCallback(() => {
    if (!mediaKey) return;
    void callOp('ai.abort', { mediaKey }).catch(() => undefined);
    setAiBusy(false);
    setAiStage(null);
  }, [mediaKey]);

  const handleNewChat = useCallback(() => {
    setActiveGroupId(undefined);
    setMessages([]);
    setStreamingChatId(undefined);
    setAsking(false);
    setError(null);
    setInput('');
  }, []);

  // 保存时间点笔记（第 26 轮）：mediaKey 实时读分 P（P1 裸键口径与字幕/问答一致），
  // anchorTime 取当前 <video> 播放秒；成功后清空输入、按保存时的 mediaKey 就地刷新列表
  //（迟到不覆盖已切走的分 P），提示走宿主 toast 通道
  const handleSaveNote = useCallback(async () => {
    const text = noteInput.trim();
    if (!text || noteSaving) return;
    const pageP = readPagePRef.current();
    setP(pageP);
    const key = biliMediaKey(bvid, pageP);
    mediaKeyRef.current = key;
    setMediaKey(key);
    const now = Date.now();
    const note: ExternalNoteEntity = {
      id: uuid(),
      mediaKey: key,
      anchorTime: readVideoCurrentTime(),
      text,
      createdAt: now,
      updatedAt: now,
    };
    setNoteSaving(true);
    try {
      await callOp('note.put', { note });
      setNoteInput('');
      const list = await callOp('note.list', { mediaKey: key }).catch(() => null);
      if (list && key === mediaKeyRef.current) setNotes(list);
      onToastRef.current?.(`笔记已保存（${formatClock(note.anchorTime)}）`);
    } catch (err) {
      onToastRef.current?.(errorTextOf(err, '笔记保存失败，请重试'), 'error');
    } finally {
      setNoteSaving(false);
    }
  }, [noteInput, noteSaving, bvid]);

  // 删除笔记：软删除后就地刷新（先乐观移除再按当前 mediaKey 重读校正）
  const handleDeleteNote = useCallback(async (id: string) => {
    try {
      await callOp('note.softDelete', { id });
      setNotes((prev) => prev.filter((n) => n.id !== id));
      const key = mediaKeyRef.current;
      if (key) {
        const list = await callOp('note.list', { mediaKey: key }).catch(() => null);
        if (list && key === mediaKeyRef.current) setNotes(list);
      }
      onToastRef.current?.('笔记已删除');
    } catch (err) {
      onToastRef.current?.(errorTextOf(err, '笔记删除失败，请重试'), 'error');
    }
  }, []);

  const seekTo = useCallback((sec: number) => {
    const video = document.querySelector('video');
    if (video) video.currentTime = Math.max(0, Math.floor(sec));
  }, []);

  // [ ] 大纲步进快捷键（第 44 轮，对齐 HDU 侧 onShortcut 的 prevTopic/nextTopic）：
  // 面板打开期间挂 document keydown；避让口径与 HDU 一致（修饰键/输入态/contentEditable/
  // BILI_RESERVED_KEYS 站点占用键），命中后按当前播放位置在大纲节点间步进 seek
  // （outlineStepTarget 纯函数）。大纲数据在标注/大纲/速览页签加载（aiResult 共享），
  // 问答/笔记页签下无大纲数据时静默忽略。用户可配置键经 settings.shortcuts 同源读取。
  useEffect(() => {
    if (!open) return undefined;
    const onOutlineShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      // shadow DOM 内键盘事件冒泡到 document 时 target 被重定向为宿主（第 51 轮审计
      // P2-1）：取 composedPath()[0] 才是真实焦点目标，输入态避让才生效
      const target = eventTargetOf(event) as HTMLElement | null;
      if (target?.isContentEditable) return;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/i.test(target.tagName)) return;
      if (event.isComposing) return;
      const key = event.key.toLowerCase();
      if (BILI_RESERVED_KEYS.has(key)) return;
      let direction: -1 | 1 | null = null;
      if (key === shortcuts.prevTopic.toLowerCase()) direction = -1;
      else if (key === shortcuts.nextTopic.toLowerCase()) direction = 1;
      if (direction === null) return;
      const video = document.querySelector('video');
      const time = video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
      const targetSec = outlineStepTarget(aiResult?.outline ?? [], time, direction);
      if (targetSec !== null) seekTo(targetSec);
    };
    document.addEventListener('keydown', onOutlineShortcut);
    return () => document.removeEventListener('keydown', onOutlineShortcut);
  }, [open, shortcuts, aiResult, seekTo]);

  // 预览锚点跳转（第 106 轮巡检）：跨 P 聚合预览他 P 会话时，锚点不再落到当前 P
  // 播放器——换算为 `?p=N&t=<秒>` 新标签直达（与字幕行 external 模式同口径）；
  // 同 P（含非聚合态的缺省）维持页内 seekTo。
  const previewAnchorJump = useCallback(
    (sec: number, groupP: number | undefined) => {
      const currentP = readPagePRef.current();
      if (!groupP || groupP === currentP) {
        seekTo(sec);
        return;
      }
      window.open(
        `https://www.bilibili.com/video/${bvid}?p=${groupP}&t=${Math.max(0, Math.floor(sec))}`,
        '_blank',
        'noopener,noreferrer',
      );
    },
    [bvid, seekTo],
  );

  // 导出笔记（第 106 轮巡检）：当前视频（含分 P）全部时间点笔记 → Markdown
  const exportNotes = useCallback(() => {
    const pLabel = p > 1 ? ` P${p}` : '';
    const label = `${videoTitle || 'B 站视频'}${pLabel}`;
    downloadTextFile(`智慧课堂-笔记-${label}-${localDayKey()}.md`, buildNotesMarkdown(notes, label));
  }, [notes, videoTitle, p]);

  // 复制回答（第 114 轮巡检）：navigator.clipboard + 宿主 toast
  const copyAnswer = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onToastRef.current?.('已复制回答');
    } catch {
      onToastRef.current?.('复制失败，请重试', 'error');
    }
  }, []);

  // 收藏 AI 回答（第 33 轮）：经 onFavoriteChat 回调交宿主落库（buildAiFavorite →
  // fav.put → toast「已收藏该回答」）；已收藏的 chatId 本地防重——按钮置灰，重复点击
  // 给「已收藏过」提示（宿主侧落库前还会按 refId 复核，双保险）。
  // P3-1（第 34 轮）：宿主返回 false = 落库失败，不置入已收藏集合（按钮保持可点重试），
  // 修复「失败仍被标记已收藏」——此前 await 后无条件入集
  const handleFavoriteChat = useCallback(async (chat: ChatMessageEntity) => {
    if (favoritedChatIds.has(chat.id)) {
      onToastRef.current?.('该回答已收藏过');
      return;
    }
    // 同会话中该回答之前最近的一条用户提问（metadata.question 留档；无则空串）
    const idx = messages.findIndex((m) => m.id === chat.id);
    let question = '';
    for (let i = idx - 1; i >= 0; i -= 1) {
      const prev = messages[i];
      if (prev && prev.role === 'user') {
        question = prev.content;
        break;
      }
    }
    const result = await onFavoriteChatRef.current?.({
      chatId: chat.id,
      question,
      answer: chat.content,
      anchorTime: chat.anchorTime,
      groupId: chat.groupId,
    });
    if (result === false) return;
    setFavoritedChatIds((prev) => new Set(prev).add(chat.id));
  }, [favoritedChatIds, messages]);

  // 笔记转收藏（第 33 轮）：经 onConvertNote 回调交宿主调 note.toFavorite（folderId
  // 缺省进未分组；B 站笔记天然带 mediaKey 归属，第 29 轮守卫满足），提示由宿主 toast
  const handleConvertNote = useCallback(async (noteId: string) => {
    await onConvertNoteRef.current?.(noteId);
  }, []);

  // 窗口档位点选（问答 / AI 标注两页签共用，第 28 轮）：登记「已交互」后仅本地生效
  //（P3-1：loadSettings 异步回填初值时已交互则不覆盖；不回写全局设置）
  const selectWindowPreset = useCallback((preset: ContextWindowPreset) => {
    windowPresetTouchedRef.current = true;
    setWindowPreset(preset);
  }, []);

  if (!open) return null;

  const availability = qaAvailability(transcript);
  const busy = asking || streamingChatId !== undefined;
  const readiness = aiAnnotationReadiness(aiResult, transcript);

  /** 公共闸门（标注/大纲两页签共用）：加载中 / 生成中指示 / 空态矩阵。
   *  返回判别结果：blocked=true 渲染 node；blocked=false 携带就绪的 aiResult（供
   *  两个渲染主体在各自函数内拿到窄化后的 ai 数据——TS 无法跨函数收窄外部 readiness）。 */
  const renderAiGate = () => {
    if (checking) {
      return { blocked: true as const, node: <div className="bili-qa-empty">正在加载标注数据…</div> };
    }
    if (aiBusy) {
      return {
        blocked: true as const,
        node: (
          <div className="bili-ai-busy">
            <span className="bili-ai-busy-dot" />
            <span>正在生成 AI 标注…{aiStage ? `（${AI_STAGE_LABELS[aiStage] ?? aiStage}）` : ''}</span>
            <button type="button" className="bili-ai-stop" onClick={handleAbortAi}>
              停止
            </button>
          </div>
        ),
      };
    }
    if (readiness.state === 'no-subtitle') {
      return {
        blocked: true as const,
        node: (
          <div className="bili-qa-empty">
            {readiness.message}
            <div className="bili-qa-hint">可先点击播放器旁的字幕按钮获取 B 站官方字幕</div>
          </div>
        ),
      };
    }
    if (readiness.state === 'can-generate') {
      return {
        blocked: true as const,
        node: (
          <div className="bili-ai-empty">
            <div>还没有 AI 标注</div>
            <div className="bili-qa-hint">根据本视频字幕提取知识点与大纲，通常需要几十秒到几分钟</div>
            <button type="button" className="bili-ai-generate" onClick={() => void handleGenerate()}>
              生成 AI 标注
            </button>
          </div>
        ),
      };
    }
    if (readiness.aiResult.topics.length === 0 && readiness.aiResult.outline.length === 0) {
      return {
        blocked: true as const,
        node: <div className="bili-qa-empty">AI 标注内容为空，可稍后重试生成</div>,
      };
    }
    return { blocked: false as const, ai: readiness.aiResult };
  };

  /** 标注区主体：知识点列表（第 44 轮起大纲移至独立页签，对齐 HDU 侧 TopicsTab/OutlineTab 分工） */
  const renderAnnotateBody = () => {
    const gate = renderAiGate();
    if (gate.blocked) return gate.node;
    const { topics } = gate.ai;
    if (topics.length === 0) {
      return <div className="bili-qa-empty">没有知识点，可切到「大纲」页签查看内容结构</div>;
    }
    return (
      <div className="bili-ai-section">
        <div className="bili-ai-section-head">
          知识标注<span>{topics.length} 个知识点</span>
        </div>
        {topics.map((topic, i) => (
          <div key={`${topic.name}-${i}`} className={`bili-ai-topic${topic.confidence === 'low' ? ' is-low' : ''}`}>
            <div className="bili-ai-topic-head">
              <button
                type="button"
                className="bili-ai-topic-name"
                onClick={() => seekTo(topicSeekTarget(topic))}
                title="跳到该知识点开头"
              >
                {topic.name}
              </button>
              {topic.confidence === 'low' ? <span className="bili-ai-topic-conf">低置信</span> : null}
            </div>
            {topic.summary ? <div className="bili-ai-topic-summary">{topic.summary}</div> : null}
            <div className="bili-ai-topic-times">
              {topic.intervals.map(([s, e], j) => (
                <button type="button" key={j} className="bili-ai-time" onClick={() => seekTo(s)}>
                  {formatClock(s)}–{formatClock(e)}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  };

  /** 大纲区主体（第 44 轮独立页签）：节点列表 + 当前播放节点高亮（跟随播放刷新）。
   *  与 HDU OutlineTab 的差异：B 站面板暂不做 scrollIntoView 自动滚动（真机观察项）。 */
  const renderOutlineBody = () => {
    const gate = renderAiGate();
    if (gate.blocked) return gate.node;
    const outline = gate.ai.outline;
    if (outline.length === 0) {
      return <div className="bili-qa-empty">大纲内容为空，可切到「AI 标注」页签查看知识点</div>;
    }
    const time = playClock ?? 0;
    const activeIndex = outline.findIndex((node) => time >= node.start && time < node.end);
    return (
      <div className="bili-ai-section">
        <div className="bili-ai-section-head">
          内容大纲<span>{outline.length} 个节点</span>
        </div>
        {outline.map((node, i) => (
          <button
            type="button"
            key={`${node.title}-${i}`}
            className={`bili-ai-outline${node.level === 2 ? ' is-l2' : ''}${i === activeIndex ? ' is-active' : ''}`}
            onClick={() => seekTo(node.start)}
            title={`跳到 ${formatClock(node.start)}`}
          >
            <span className="bili-ai-outline-title">{node.title}</span>
            <span className="bili-ai-outline-time">{formatClock(node.start)}</span>
          </button>
        ))}
      </div>
    );
  };

  /** 速览区主体（第 44 轮，对齐 HDU 侧 OverviewTab）：视频时长/播放位置/字幕覆盖/
   *  知识标注四格 + 「回到上次的位置」锚点 chips（播放断点 + 上次提问 + 最近笔记） */
  const renderOverviewBody = () => {
    const duration = readVideoDurationSec(durationSec);
    const anchors = buildOverviewAnchors({ lastPositionSec: ovLastPosition, chats: ovChats, notes });
    return (
      <div>
        {videoTitle ? <div className="bili-ov-title">{videoTitle}</div> : null}
        <div className="bili-ov-grid">
          <div className="bili-ov-cell">
            <div className="bili-ov-label">视频时长</div>
            <div className="bili-ov-value">{duration != null ? formatClock(duration) : '--'}</div>
          </div>
          <div className="bili-ov-cell">
            <div className="bili-ov-label">播放位置</div>
            <div className="bili-ov-value">{formatClock(playClock ?? 0)}</div>
          </div>
          <div className="bili-ov-cell">
            <div className="bili-ov-label">字幕覆盖</div>
            <div className="bili-ov-value">
              {transcript ? (transcript.segments.length > 0 ? `${transcript.segments.length} 段` : '无文字') : '未获取'}
            </div>
          </div>
          <div className="bili-ov-cell">
            <div className="bili-ov-label">知识标注</div>
            <div className="bili-ov-value">{aiResult ? `${aiResult.topics.length} 个知识点` : '未生成'}</div>
          </div>
        </div>
        {anchors.length > 0 ? (
          <div>
            <div className="bili-ov-anchor-title">回到上次的位置</div>
            <div className="bili-ov-anchor-list">
              {anchors.map((anchor, i) => (
                <button
                  type="button"
                  key={`${anchor.kind}-${anchor.seconds}-${i}`}
                  className="bili-ov-anchor"
                  onClick={() => seekTo(anchor.seconds)}
                  title={`跳转到 ${formatClock(anchor.seconds)}`}
                >
                  {anchor.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {!transcript ? (
          <div className="bili-qa-hint">字幕来自 B 站官方字幕接口：点击字幕按钮获取后，这里会显示覆盖情况。</div>
        ) : null}
      </div>
    );
  };

  return (
    <div
      className="bili-modal-backdrop bili-qa-scope"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* 组件自带样式（唯一样式来源，见 qa/qaStyles.ts）；shadow root 内全局生效 */}
      <style>{QA_PANEL_CSS}</style>
      <div className="bili-modal bili-qa-modal">
        <div className="bili-modal-head">
          <h3>学习助手</h3>
          <button type="button" className="bili-modal-close" onClick={onClose} aria-label="关闭学习助手">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="bili-qa-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'overview'}
            className={`bili-qa-tab${tab === 'overview' ? ' is-active' : ''}`}
            onClick={() => setTab('overview')}
          >
            速览
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'qa'}
            className={`bili-qa-tab${tab === 'qa' ? ' is-active' : ''}`}
            onClick={() => setTab('qa')}
          >
            问答
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'annotate'}
            className={`bili-qa-tab${tab === 'annotate' ? ' is-active' : ''}`}
            onClick={() => setTab('annotate')}
          >
            AI 标注
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'outline'}
            className={`bili-qa-tab${tab === 'outline' ? ' is-active' : ''}`}
            onClick={() => setTab('outline')}
          >
            大纲
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'notes'}
            className={`bili-qa-tab${tab === 'notes' ? ' is-active' : ''}`}
            onClick={() => setTab('notes')}
          >
            笔记
          </button>
        </div>
        <div className="bili-qa-meta">
          {p > 1 ? `P${p} · ` : ''}
          {tab === 'qa'
            ? checking
              ? '正在检查字幕…'
              : availability.available
                ? `字幕可用 · ${transcript?.segments.length ?? 0} 段`
                : '无官方字幕'
            : tab === 'annotate'
              ? checking
                ? '正在加载…'
                : aiResult
                  ? `已生成 · ${aiResult.topics.length} 个知识点`
                  : availability.available
                    ? '尚未生成 AI 标注'
                    : '无官方字幕'
              : tab === 'outline'
                ? checking
                  ? '正在加载…'
                  : aiResult
                    ? `已生成 · ${aiResult.outline.length} 条大纲`
                    : availability.available
                      ? '尚未生成 AI 标注'
                      : '无官方字幕'
                : tab === 'overview'
                  ? checking
                    ? '正在加载…'
                    : transcript
                      ? `字幕 ${transcript.segments.length} 段 · ${aiResult ? `${aiResult.topics.length} 个知识点` : '未标注'}`
                      : '未获取字幕'
                  : notesLoading
                    ? '正在加载笔记…'
                    : `${notes.length} 条笔记`}
        </div>
        {tab === 'qa' ? (
          <>
            <div className="bili-qa-toolbar">
              <button type="button" className="bili-qa-moment" onClick={onFavoriteMoment} disabled={favoriting} title="把当前播放时间点存入知识库">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3.5 2" />
                </svg>
                {favoriting ? '收藏中…' : '收藏此时刻'}
              </button>
              {availability.available ? (
                <button type="button" className="bili-qa-newchat" onClick={handleNewChat} disabled={busy}>
                  新会话
                </button>
              ) : null}
              {/* 问答导出（第 81 轮巡检；第 82 轮升级为全量）：当前视频（mediaKey，含分 P）
                  全部会话消息 → Markdown 下载（core/export/chats 纯函数）；失败回退当前会话 */}
              {messages.length > 0 ? (
                <button
                  type="button"
                  className="bili-qa-newchat"
                  title="导出当前视频的全部问答"
                  onClick={() =>
                    void (async () => {
                      const key = biliMediaKey(bvid, readPageP());
                      const all = await callOp('qa.list', { mediaKey: key }).catch(() => messages);
                      downloadTextFile(
                        `智慧课堂-问答记录-${localDayKey()}.md`,
                        buildChatsMarkdown(all, videoTitle ? `${videoTitle}${readPageP() > 1 ? ` P${readPageP()}` : ''}` : 'B 站视频'),
                      );
                    })()
                  }
                >
                  导出问答
                </button>
              ) : null}
              {/* 会话历史（第 88 轮巡检）：查看/删除历史问答会话 */}
              <button
                type="button"
                className="bili-qa-newchat"
                onClick={openHistory}
                title="查看/删除历史问答会话"
              >
                会话历史
              </button>
              {/* 问答上下文窗口档位：qa.ask 支持 per-request windowPreset，切换仅影响本面板
                  后续问答；AI 标注页签同款可选档（第 28 轮），各自随请求下发 */}
              <WindowPresetChips
                value={windowPreset}
                onSelect={selectWindowPreset}
                ariaLabel="问答上下文窗口"
                titlePrefix="问答上下文窗口"
                titleSuffix="仅影响本面板问答；AI 标注生成亦可面板选档"
              />
            </div>
            <div className="bili-qa-body" ref={bodyRef} aria-live="polite">
              {checking ? (
                <div className="bili-qa-empty">正在检查字幕…</div>
              ) : !availability.available ? (
                <div className="bili-qa-empty">
                  {availability.message}
                  <div className="bili-qa-hint">可先点击播放器旁的字幕按钮获取 B 站官方字幕</div>
                </div>
              ) : messages.length === 0 ? (
                <div className="bili-qa-empty">基于当前播放位置附近的字幕提问，例如「刚才讲的概念是什么意思？」</div>
              ) : (
                messages.map((message) => (
                  <div
                    key={message.id}
                    className={`bili-qa-msg is-${message.role}${message.status === 'failed' ? ' is-failed' : ''}${
                      message.status === 'streaming' ? ' is-streaming' : ' is-done'
                    }`}
                  >
                    <div className="bili-qa-bubble">
                      {message.status === 'failed'
                        ? message.error ?? '回答失败，请重试'
                        : message.status === 'streaming'
                          ? '生成中…'
                          : message.status === 'aborted'
                            ? message.content
                              ? `${message.content}\n（已停止生成）`
                              : '已停止生成'
                            : message.content}
                    </div>
                    {message.role === 'ai' && message.status === 'done' ? (
                      <div className="bili-qa-msg-actions">
                        {message.evidence ? (
                          <button
                            type="button"
                            className="bili-qa-evidence"
                            onClick={() => seekTo(message.evidence!.start)}
                            title="跳转到依据所在时间点"
                          >
                            依据 {formatClock(message.evidence.start)}–{formatClock(message.evidence.end)}
                          </button>
                        ) : null}
                        {/* 复制回答（第 114 轮巡检）：navigator.clipboard + 宿主 toast */}
                        <button
                          type="button"
                          className="bili-qa-copy"
                          onClick={() => void copyAnswer(message.content)}
                          title="复制回答"
                          aria-label="复制回答"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" />
                            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                          </svg>
                        </button>
                        {/* 收藏这条回答（第 33 轮）：经 onFavoriteChat 交宿主落库；已收藏置灰 */}
                        <button
                          type="button"
                          className="bili-qa-fav"
                          onClick={() => void handleFavoriteChat(message)}
                          disabled={favoritedChatIds.has(message.id)}
                          title={favoritedChatIds.has(message.id) ? '已收藏' : '收藏这条回答'}
                          aria-label={favoritedChatIds.has(message.id) ? '已收藏' : '收藏这条回答'}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 3.8l2.5 5.1 5.6.8-4.1 4 1 5.6-5-2.7-5 2.7 1-5.6-4.1-4 5.6-.8z" />
                          </svg>
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>
            {availability.available ? (
              <div className="bili-qa-composer">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleAsk();
                  }}
                  placeholder="问点什么，如：这个公式怎么推导？"
                  maxLength={500}
                  disabled={busy}
                  aria-label="输入问题"
                />
                {streamingChatId ? (
                  <button type="button" className="bili-qa-send" onClick={handleAbort}>
                    停止
                  </button>
                ) : (
                  <button type="button" className="bili-qa-send" onClick={() => void handleAsk()} disabled={asking || !input.trim()}>
                    {asking ? '生成中…' : '提问'}
                  </button>
                )}
              </div>
            ) : null}
          </>
        ) : tab === 'annotate' ? (
          <>
            <div className="bili-qa-toolbar">
              {/* AI 标注上下文窗口档位（第 28 轮，第 27 轮建议 4）：与问答页签同款 chips，
                  ai.generate 支持 per-request windowPreset，生成请求携带所选档位
                  （缺省=全局设置；HDU 侧 PlayPanel 不加 UI，行为不变） */}
              <WindowPresetChips
                value={windowPreset}
                onSelect={selectWindowPreset}
                ariaLabel="AI 标注上下文窗口"
                titlePrefix="AI 标注上下文窗口"
                titleSuffix="仅影响本面板标注生成"
              />
            </div>
            <div className="bili-qa-body bili-ai-body">{renderAnnotateBody()}</div>
          </>
        ) : tab === 'outline' ? (
          <>
            <div className="bili-qa-toolbar">
              {/* 大纲页签（第 44 轮）与标注页签同源同款窗口档位：生成入口行为一致 */}
              <WindowPresetChips
                value={windowPreset}
                onSelect={selectWindowPreset}
                ariaLabel="大纲上下文窗口"
                titlePrefix="大纲上下文窗口"
                titleSuffix="仅影响本面板标注生成"
              />
            </div>
            <div className="bili-qa-body bili-ai-body">{renderOutlineBody()}</div>
          </>
        ) : tab === 'overview' ? (
          <div className="bili-qa-body bili-ai-body">
            {/* 本周学习小结 mini 卡（第 81 轮巡检）：速览页签直接看本周趋势，完整周报在学习中心统计页签 */}
            <BiliWeeklyMini />
            {renderOverviewBody()}
          </div>
        ) : (
          <>
            <div className="bili-qa-body bili-notes-body">
              {notesLoading ? (
                <div className="bili-qa-empty">正在加载笔记…</div>
              ) : notes.length === 0 ? (
                <div className="bili-qa-empty">
                  暂无笔记
                  <div className="bili-qa-hint">在下方记录这个时间点的想法；笔记不依赖字幕，点击时间戳可回到该时刻</div>
                </div>
              ) : (
                <>
                  {/* 导出笔记（第 106 轮巡检）：当前视频全部笔记 → Markdown 下载 */}
                  <div style={{ padding: '8px 12px 0', display: 'flex', justifyContent: 'flex-end' }}>
                    <button type="button" className="bili-qa-newchat" onClick={exportNotes}>
                      导出笔记
                    </button>
                  </div>
                  {notes.map((note) => (
                    <BiliNoteRow
                      key={note.id}
                      note={note}
                      onSeek={seekTo}
                      onConvert={(id) => void handleConvertNote(id)}
                      onDelete={(id) => void handleDeleteNote(id)}
                    />
                  ))}
                </>
              )}
            </div>
            <div className="bili-qa-composer bili-note-composer">
              <textarea
                value={noteInput}
                onChange={(e) => setNoteInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void handleSaveNote();
                  }
                }}
                placeholder={notePlaceholderText(noteClock)}
                maxLength={1000}
                rows={2}
                disabled={noteSaving}
                aria-label="输入笔记"
              />
              <button
                type="button"
                className="bili-qa-send"
                onClick={() => void handleSaveNote()}
                disabled={noteSaving || !noteInput.trim()}
              >
                {noteSaving ? '保存中…' : '保存'}
              </button>
            </div>
          </>
        )}
        {tab === 'qa' && error ? <div className="bili-qa-error">{error}</div> : null}
        {(tab === 'annotate' || tab === 'outline') && aiError ? (
          <div className="bili-qa-error">
            {aiError}
            {!aiBusy && readiness.state !== 'no-subtitle' ? (
              <button type="button" className="bili-ai-retry" onClick={() => void handleGenerate()}>
                重试
              </button>
            ) : null}
          </div>
        ) : null}
        {/* 会话历史（第 88 轮巡检）：查看/删除历史问答会话；预览为只读，当前会话保持最新组。
            浮层 aria（第 248 轮巡检，无障碍域）：role=dialog + aria-modal + 标题关联
            （aria-labelledby 指向头部标题 span）——此前仅关闭钮有 aria-label，弹层本体
            对屏幕阅读器是匿名区域；attributes 不影响 bili-styles 的展示。 */}
        {historyOpen ? (
          <div className="bili-qa-history-backdrop" onClick={() => setHistoryOpen(false)}>
            <div
              className="bili-qa-history"
              role="dialog"
              aria-modal="true"
              aria-labelledby="bili-qa-history-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="bili-qa-history-head">
                <span id="bili-qa-history-title">会话历史{groups.length > 0 ? `（${groups.length}）` : ''}</span>
                <button
                  type="button"
                  className="bili-qa-history-close"
                  onClick={() => setHistoryOpen(false)}
                  aria-label="关闭会话历史"
                >
                  ×
                </button>
              </div>
              <div className="bili-qa-history-body">
                {/* 搜索（第 89 轮巡检）：按首问摘要过滤 */}
                <div style={{ marginBottom: 8 }}>
                  <input
                    type="text"
                    className="bili-qa-search"
                    style={{ width: '100%' }}
                    value={historyQuery}
                    onChange={(e) => setHistoryQuery(e.target.value)}
                    placeholder="按首问内容过滤…"
                    aria-label="过滤历史会话"
                  />
                </div>
                {/* 跨 P 聚合（第 104 轮巡检）：开启后按 bvid 聚合全部分 P 的会话分组（qa.groupsAll） */}
                <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    type="button"
                    className={`bili-qa-crossp${crossP ? ' is-active' : ''}`}
                    aria-pressed={crossP}
                    onClick={() => setCrossP((v) => !v)}
                    title="聚合本视频全部分 P 的问答会话"
                  >
                    跨 P 聚合
                  </button>
                  <span className="bili-qa-crossp-hint">{crossP ? '展示全部分 P 的会话' : '仅当前分 P；开启后聚合全部 P'}</span>
                </div>
                {/* 清空全部（第 90 轮巡检）：两步确认；清空后当前会话一并清空。
                    导出全部（第 91 轮巡检）：本视频（当前分 P）全部会话 → Markdown */}
                {groups.length > 0 ? (
                  <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                    <button type="button" className="bili-qa-newchat" onClick={exportAllGroups}>
                      {crossP ? '导出全部（跨 P）' : '导出全部'}
                    </button>
                    {clearAllArmed ? (
                      <button type="button" className="bili-qa-newchat" onClick={clearAllGroups}>
                        再点一次确认清空全部
                      </button>
                    ) : (
                      <button type="button" className="bili-qa-newchat" onClick={() => setClearAllArmed(true)}>
                        清空全部
                      </button>
                    )}
                  </div>
                ) : null}
                {groupsLoading ? (
                  <div className="bili-qa-empty">正在加载…</div>
                ) : filteredGroups.length === 0 ? (
                  <div className="bili-qa-empty">
                    {groups.length === 0 ? '暂无历史会话；发起提问后会自动保存。' : '没有匹配的会话，换个关键词试试。'}
                  </div>
                ) : (
                  filteredGroups.map((group) => (
                    <div className="bili-qa-history-item" key={group.groupId}>
                      <div className="bili-qa-history-main">
                        <div className="bili-qa-history-title">{group.title || '（无标题）'}</div>
                        <div className="bili-qa-history-meta">
                          {crossP ? <span className="bili-qa-pbadge">P{group.p ?? 1}</span> : null}
                          <span>{group.count} 条消息</span>
                          <span>{new Date(group.lastAt).toLocaleString()}</span>
                        </div>
                      </div>
                      <div className="bili-qa-history-actions">
                        <button
                          type="button"
                          className="bili-qa-newchat"
                          onClick={() => previewGroup(group.groupId, group.mediaKey)}
                        >
                          {previewGroupId === group.groupId ? '收起' : '查看'}
                        </button>
                        {/* 导出单会话（第 89 轮巡检）：该组消息 → Markdown；跨 P 时按组所属 mediaKey */}
                        <button
                          type="button"
                          className="bili-qa-newchat"
                          onClick={() => exportGroup(group.groupId, group.title || '历史会话', group.mediaKey)}
                        >
                          导出
                        </button>
                        <button
                          type="button"
                          className="bili-qa-newchat"
                          onClick={() => deleteGroup(group.groupId, group.mediaKey)}
                        >
                          删除
                        </button>
                      </div>
                      {previewGroupId === group.groupId ? (
                        <div className="bili-qa-history-preview">
                          {previewLoading ? (
                            '正在加载…'
                          ) : previewMessages.length === 0 ? (
                            '（无消息）'
                          ) : (
                            previewMessages.map((m) => (
                              <div key={m.id} className="bili-qa-history-msg">
                                <b>{m.role === 'user' ? '问' : '答'}</b>
                                {m.anchorTime != null ? (
                                  <button
                                    type="button"
                                    className="bili-qa-history-anchor"
                                    onClick={() => previewAnchorJump(m.anchorTime!, group.p)}
                                    title={group.p && group.p !== p ? `跳转到 P${group.p} 的该时间点` : '跳转到该时间点'}
                                  >
                                    @{formatClock(m.anchorTime)}
                                  </button>
                                ) : null}
                                <p>{m.content || (m.insufficient ? '（字幕不足）' : '')}</p>
                              </div>
                            ))
                          )}
                        </div>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
