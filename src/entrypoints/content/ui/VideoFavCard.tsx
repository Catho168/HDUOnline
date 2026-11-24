/**
 * 知识库收藏卡片（学习中心 LibraryView 与 Dashboard 知识库共用的唯一实现）。
 *
 * 背景：两处各有一份内联卡片实现，安全收口曾发生漂移——第 17 轮 safeExternalUrl
 * 收口只改了学习中心、漏了 Dashboard，第 18 轮才补修。本组件把
 * metadata.url → safeExternalUrl → withTimeParam 的安全链路收敛为一份。
 *
 * 原两份实现的差异裁决：
 *  - 「字幕已就绪」徽标与「查看字幕」入口（学习中心第 15 轮加）：subtitleReady +
 *    onViewSubtitle 可选能力，不传则不渲染（Dashboard 维持原状，不引入字幕能力）；
 *  - 「回到课堂」站内跳转（学习中心）：onOpenSession 可选能力，Dashboard 不传不渲染；
 *  - 底部动作组「加入复习 / 置顶 / 编辑 / 删除」（Dashboard）：onReview / onTogglePin /
 *    onEdit / onDelete 可选能力，学习中心只传 onEdit，其余不传不渲染；
 *  - 编辑按钮位置：学习中心在卡片头部右侧角标位（icon=edit），Dashboard 在底部
 *    动作组内（icon=settings），以 editPlacement 表达（默认 'head'）；
 *  - 进度块位置（Dashboard 原在备注之前，学习中心在卡片末尾）与 marginTop
 *    （8 vs 10）：无交互耦合的纯排版漂移，统一为学习中心样式（卡片末尾 / 10）。
 */
import type { FavoriteEntity, FavoriteType } from '@/core/shared/types';
import type { ReviewBadge } from '@/core/plan/reviewBadge';
import { markTextSegments } from '@/core/search/unified';
import { favoritedAgoLabel } from '@/core/shared/relativeTime';
import { formatClock, safeExternalUrl, withTimeParam } from '@/core/shared/utils';
import { formatSeconds } from '@/core/shared/duration';
import { Chip, ConfirmIconButton, IconButton, Progress } from './components';
import { Icon, type IconName } from './icons';

/**
 * 收藏类型元数据（中文标签 + 图标）的唯一来源（第 20 轮收口）：
 * 此前 dashboard 筛选栏 / 复习列表、学习中心筛选栏 / 复习卡片导出、本组件卡片头
 * 各持一份相同常量，统一改从本文件 import。类型全集固定六种，两处筛选栏均展示
 * 全部类型，无子集差异，故不做参数化派生。
 */
export const FAVORITE_META: Record<FavoriteType, { label: string; icon: IconName }> = {
  time: { label: '时间点', icon: 'clock' },
  ai: { label: 'AI 回答', icon: 'spark' },
  outline: { label: '大纲', icon: 'list' },
  screenshot: { label: '截图', icon: 'camera' },
  note: { label: '笔记', icon: 'note' },
  video: { label: '视频', icon: 'video' },
};

/** B 站视频收藏的 bvid（refId 即 bvid，B 站内容脚本收藏与收藏夹导入同一口径）。
 *  加 `/^BV[A-Za-z0-9]{8,}$/` 校验（第 16 轮 P3，与 bilibili.content.tsx 的 BV 口径同源）：
 *  脏 refId 不进外链拼接，也不参与字幕徽标匹配。 */
export function videoBvidOf(fav: FavoriteEntity): string {
  return fav.type === 'video' && typeof fav.refId === 'string' && /^BV[A-Za-z0-9]{8,}$/.test(fav.refId)
    ? fav.refId
    : '';
}

/**
 * 收藏时间相对化（第 241 轮巡检引入；第 243 轮起实现抽到 core/shared/relativeTime.ts
 * 供本课学习小条「本课笔记最近一条」复用同一分桶口径）：今天 / 昨天 / N 天前，
 * 满 7 天回落「MM-DD HH:mm」绝对时间——与回收站删除时间相对化（第 219 轮
 * deletedAgoLabel）同分桶口径。此处保留同名 re-export，旧引用与单测导入路径不变。
 */
export { favoritedAgoLabel };

/** 从收藏 metadata.url 提取分 P（`?p=N` / `&p=N`，N≥2 才算分 P；缺省/非法按 P1 处理。
 *  限长 4 位：与 readBiliPageP 同口径，防超长数字串经 Number 精度丢失（第 17 轮复核 P3-3） */
export function biliPageParamOf(url: unknown): number | undefined {
  const match = typeof url === 'string' ? url.match(/[?&]p=(\d{1,4})/) : null;
  const n = match ? Number(match[1]) : NaN;
  return Number.isInteger(n) && n >= 2 ? n : undefined;
}

export interface VideoFavCardProps {
  /** 收藏实体（type 任意；视频专属区块仅 type==='video' 且 metadata 有值时渲染） */
  fav: FavoriteEntity;
  /** 字幕已就绪（transcripts 已有该 bvid 的键）：显示「字幕已就绪」徽标 */
  subtitleReady?: boolean;
  /** 复习状态徽标（第 244 轮巡检，升级第 102 轮「复习中」孤岛 chip）：pending 作业
   *  按到期日分色——逾期 danger / 今日到期 jade / 未来 accent（label 带 M月D日）；
   *  未入计划 = default 中性。done/skipped 不传（null），由 lastReviewDoneLabel 承接。
   *  口径与知识库筛选 reviewAnyIds 同源（全量 pending 作业按 favoriteId 归属） */
  reviewBadge?: ReviewBadge | null;
  /** 上次复习完成时间短格式（如 'MM/DD'，第 224 轮巡检）：显示「上次复习 MM/DD」徽标；不传不渲染 */
  lastReviewDoneLabel?: string;
  /** 「查看字幕」入口回调（携带 bvid 与分 P）；不传则不渲染该入口 */
  onViewSubtitle?: (bvid: string, p: number | undefined) => void;
  /** 「回到课堂」站内跳转（无外链 url 且 fav.courId 存在时显示）；不传则不渲染 */
  onOpenSession?: (courId: number, teclId?: number) => void;
  /** 「加入复习」按钮；不传则不渲染 */
  onReview?: () => void;
  /** 是否在卡片底部展示收藏时间（第 34 轮：B 站学习中心开启；ai/note 卡片无封面/
   *  UP主等元信息行，收藏时间提供额外时间锚点）。不传不渲染，HDU 侧展示不变 */
  showFavoritedAt?: boolean;
  /** 「置顶」切换按钮；不传则不渲染 */
  onTogglePin?: () => void;
  /** 「编辑」按钮；不传则不渲染 */
  onEdit?: () => void;
  /** 编辑按钮位置：'head' 头部右侧角标位（学习中心，icon=edit）/ 'foot' 底部动作组（Dashboard，icon=settings） */
  editPlacement?: 'head' | 'foot';
  /** 「删除」两步确认按钮；不传则不渲染 */
  onDelete?: () => void;
  /** 搜索关键词（第 268 轮，检索域 / 三端一致）：标题中的命中词以金色 mark 高亮
   *  （markTextSegments 与统一搜索同规则）；不传或空串按原文渲染 */
  highlight?: string;
}

export function VideoFavCard({
  fav,
  subtitleReady,
  reviewBadge,
  lastReviewDoneLabel,
  onViewSubtitle,
  onOpenSession,
  onReview,
  showFavoritedAt,
  onTogglePin,
  onEdit,
  editPlacement = 'head',
  onDelete,
  highlight,
}: VideoFavCardProps) {
  const meta = FAVORITE_META[fav.type];
  const bvid = videoBvidOf(fav);
  const videoMeta = fav.type === 'video'
    ? (fav.metadata as {
        coverUrl?: string;
        url?: string;
        uploader?: string;
        duration?: string;
        durationSec?: number | null;
        lastPositionSec?: number;
        watchedRatio?: number;
      } | undefined)
    : undefined;
  // 向后兼容：旧数据无 durationSec 时回退旧时长文本
  const durationLabel = videoMeta?.durationSec != null ? formatSeconds(videoMeta.durationSec) : (videoMeta?.duration ?? '');
  // 第 17 轮 P2-1 收口（唯一样本，两入口共用）：metadata.url 直通「打开视频/从 N 续看」
  // anchor href，过协议白名单（与 unified 搜索跳转/今日待办同口径；脏 url 丢弃后两入口
  // 一并隐藏，不回退假链接）；续看再经 withTimeParam 拼 ?t= 秒数
  const videoUrl = safeExternalUrl(videoMeta?.url);
  const videoRatio =
    typeof videoMeta?.lastPositionSec === 'number' &&
    videoMeta.lastPositionSec > 0 &&
    typeof videoMeta.durationSec === 'number' &&
    videoMeta.durationSec > 0
      ? Math.min(1, videoMeta.lastPositionSec / videoMeta.durationSec)
      : null;
  const resumeUrl =
    videoUrl && videoRatio != null && videoRatio < 0.95
      ? withTimeParam(videoUrl, videoMeta?.lastPositionSec ?? 0)
      : null;
  const showSubtitleEntry = Boolean(subtitleReady && bvid && onViewSubtitle);
  const editInHead = editPlacement === 'head' && Boolean(onEdit);
  const editInFoot = editPlacement === 'foot' && Boolean(onEdit);
  const showFootActions = Boolean(onReview || onTogglePin || onDelete || editInFoot);
  return (
    <div className="hdu-card hover hdu-knowledge-card">
      <div className="hdu-knowledge-head">
        <Icon name={meta.icon} size={13} /> {meta.label}
        {fav.anchorTime != null ? <span className="hdu-time-badge">{formatClock(fav.anchorTime)}</span> : null}
        {fav.pinned ? <Chip tone="accent">置顶</Chip> : null}
        {/* 字幕已就绪：transcripts 已有该 bvid 的字幕键（裸键或分 P 键，前缀匹配） */}
        {subtitleReady ? <Chip tone="jade">字幕已就绪</Chip> : null}
        {/* 复习状态徽标（第 244 轮巡检，升级第 102 轮「复习中」chip）：pending 按到期日
            分色（逾期 danger / 今日 jade / 未来 accent 带 M月D日）、未入计划 default；
            口径 title 说明，克制不挤占主行 */}
        {reviewBadge ? (
          <Chip tone={reviewBadge.tone} title={reviewBadge.title}>
            {reviewBadge.label}
          </Chip>
        ) : null}
        {/* 上次复习完成时间（第 224 轮巡检）：帮助用户回忆该收藏的复习节奏 */}
        {lastReviewDoneLabel ? <Chip>上次复习 {lastReviewDoneLabel}</Chip> : null}
        {/* 编辑入口收在卡片头部右侧角标位，不影响封面/进度等正文布局 */}
        {editInHead ? (
          <span style={{ marginLeft: 'auto', display: 'flex' }}>
            <IconButton icon="edit" label="编辑" onClick={onEdit} />
          </span>
        ) : null}
      </div>
      {videoMeta?.coverUrl ? (
        <img
          src={videoMeta.coverUrl}
          alt=""
          referrerPolicy="no-referrer"
          style={{
            width: '100%',
            height: 120,
            objectFit: 'cover',
            borderRadius: 'var(--radius-sm)',
            marginTop: 8,
            background: 'var(--paper-3)',
          }}
        />
      ) : null}
      <div className="hdu-knowledge-title">
        {/* 搜索命中高亮（第 268 轮，检索域 / 三端一致）：知识库搜索时标题命中词以
            金色 mark 标出（与统一搜索 / B 站字幕搜索同规则）；无关键词按原文渲染 */}
        {highlight
          ? markTextSegments(fav.snapshot.title, highlight).map((part, i) =>
              part.marked ? (
                <mark key={i} className="hdu-search-mark">
                  {part.text}
                </mark>
              ) : (
                <span key={i}>{part.text}</span>
              ),
            )
          : fav.snapshot.title}
      </div>
      <div className="hdu-knowledge-text">
        {videoMeta && (videoMeta.uploader || durationLabel) ? (
          <span style={{ color: 'var(--muted)' }}>{[videoMeta.uploader, durationLabel].filter(Boolean).join(' · ')} · </span>
        ) : null}
        {fav.snapshot.content || '（无正文）'}
      </div>
      {fav.note ? <div className="hdu-hint">备注：{fav.note}</div> : null}
      <div className="hdu-knowledge-foot">
        {/* 收藏时间（可选能力，B 站学习中心开启）：置于foot 首位，操作按钮的
            marginLeft:auto 右推逻辑不受影响（ai/note 卡无 videoUrl 时同样右对齐） */}
        {showFavoritedAt ? (
          // 收藏时间相对化（第 241 轮巡检）：今天/昨天/N 天前，满 7 天回落绝对时间；
          // 非法 favoritedAt 不渲染该行
          favoritedAgoLabel(fav.favoritedAt) ? (
            <span className="hdu-hint" style={{ whiteSpace: 'nowrap' }}>收藏于 {favoritedAgoLabel(fav.favoritedAt)}</span>
          ) : null
        ) : null}
        {fav.tags.map((tag) => <span className="hdu-tag" key={tag}>{tag}</span>)}
        {/* 查看字幕：打开共享的字幕浮层（行点击在新标签打开 B 站 ?t= 外链）；
            分 P 从收藏 metadata.url 提取（?p=N），多 P 字幕的读取与外链都带上 */}
        {showSubtitleEntry ? (
          <button
            type="button"
            className="hdu-btn ghost small"
            style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}
            onClick={() => onViewSubtitle?.(bvid, biliPageParamOf(videoMeta?.url))}
          >
            查看字幕 <Icon name="eye" size={12} />
          </button>
        ) : null}
        {videoUrl ? (
          <a
            href={videoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hdu-btn ghost small"
            style={{ marginLeft: subtitleReady ? undefined : 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            打开视频 <Icon name="external" size={12} />
          </a>
        ) : fav.courId && onOpenSession ? (
          <button
            type="button"
            className="hdu-btn ghost small"
            style={{ marginLeft: subtitleReady ? undefined : 'auto' }}
            onClick={() => onOpenSession?.(fav.courId!, fav.teclId)}
          >
            回到课堂 <Icon name="arrowRight" size={12} />
          </button>
        ) : null}
        {showFootActions ? (
          <div style={videoUrl ? { display: 'flex', gap: 2 } : { marginLeft: 'auto', display: 'flex', gap: 2 }}>
            {onReview ? <IconButton icon="refresh" label="加入复习" onClick={onReview} /> : null}
            {onTogglePin ? <IconButton icon="star" label="置顶" onClick={onTogglePin} /> : null}
            {editInFoot ? <IconButton icon="settings" label="编辑" onClick={onEdit} /> : null}
            {onDelete ? <ConfirmIconButton icon="trash" label="删除" confirmLabel="再点一次确认移入回收站" onConfirm={onDelete} /> : null}
          </div>
        ) : null}
      </div>
      {videoRatio != null ? (
        videoRatio >= 0.95 ? (
          <div style={{ marginTop: 10 }}>
            <Chip tone="jade">已看完</Chip>
          </div>
        ) : (
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <Progress value={videoRatio} jade />
            </div>
            {resumeUrl ? (
              <a
                href={resumeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="hdu-btn ghost small"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}
              >
                从 {formatSeconds(videoMeta?.lastPositionSec ?? 0)} 续看
              </a>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}
