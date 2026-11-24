/**
 * B 站视频学习统计聚合（第 25 轮任务 B）。
 *
 * 数据来源（只读聚合，不新增写入路径、不改任何统计口径）：
 *  - externalWatch：站外时长流水，主键 `${date}:${bvid}`，同日同视频一条累计
 *    （见 repo/external）；TopN 按区间 × bvid 聚合，recent / streak 为全历史口径；
 *  - videoProgress：最后位置 / 时长 / 标题，主键 `bilibili:<bvid>`（见 repo/video）；
 *  - favorites（type='video'）：收藏标题与 metadata.url（还原站外跳转链接）。
 *
 * 标题降级口径（与第 22 轮标题回查一致）：
 *   videoProgress.title → 收藏 snapshot.title → externalWatch 上报标题 → 「B 站视频 <bvid>」
 *
 * 连续天数口径：externalWatch 有记录的自然日集合，复用站内 computeStreak——
 * 今天有记录则从今天回溯；今天还没有记录不立即断链，从昨天往回数「昨天及以前
 * 的连续天数」。
 */

import { getDb, mapDbError } from '../index';
import { computeStreak } from '../../stats/aggregate';
import type {
  BiliOverviewResult,
  BiliRecentWatchedRow,
  BiliTopWatchedRow,
  ExternalWatchEntity,
  FavoriteEntity,
  VideoProgressEntity,
} from '../../shared/types';
import { dayKeyToTs, localDayKey, ratio, safeExternalUrl } from '../../shared/utils';

/** TopN / recent 的默认条数（N=5） */
export const BILI_STATS_DEFAULT_LIMIT = 5;

/** 聚合区间（本地自然日键，含端点）；由 op 层按 stats.period 的周/月口径给出 */
export interface BiliRange {
  fromDay: string;
  toDay: string;
}

function wrap<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err) => {
    throw mapDbError(err);
  });
}

/** 条数钳制：非法值回退默认 5，合法值收进 [1, 50] */
function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return BILI_STATS_DEFAULT_LIMIT;
  return Math.min(50, Math.max(1, Math.floor(limit)));
}

/** externalWatch 行防御式校验（与 aggregate.externalSecondsByDay 同规则，脏行逐条跳过） */
function asExternalRow(row: unknown): ExternalWatchEntity | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Partial<ExternalWatchEntity>;
  if (typeof r.date !== 'string' || r.date.length === 0) return null;
  if (typeof r.bvid !== 'string' || r.bvid.length === 0) return null;
  if (typeof r.seconds !== 'number' || !Number.isFinite(r.seconds) || r.seconds <= 0) return null;
  return r as ExternalWatchEntity;
}

/** 标题占位（与 unified 搜索 B 站回退一致） */
export function biliTitleFallback(bvid: string): string {
  return `B 站视频 ${bvid}`;
}

/** 单个 bvid 解析出的展示元数据 */
interface BiliVideoMeta {
  title: string;
  url: string;
  lastPositionSec: number;
  durationSec: number | null;
}

/**
 * 批量解析标题 / 链接 / 最后位置（无 N+1：videoProgress 与 video 收藏各一次
 * 全量读取；两表都是小表——每视频至多一条进度，收藏量级有限）。
 *
 *  - 标题优先级见文件头；tickTitles 为 externalWatch 上报标题（最低优先级源）；
 *  - 链接：收藏 metadata.url 经 safeExternalUrl 白名单校验后优先，否则按 bvid
 *    还原官方链接（与 unified 搜索同口径）；多 P 的 ?p= 随收藏 url 自带，
 *    续看 ?t= 由调用方用 withTimeParam 追加；
 *  - 最后位置 / 时长：videoProgress 缺失时分别回退 0 / null。
 */
async function resolveBiliMeta(
  bvids: string[],
  tickTitles: Map<string, string>,
): Promise<Map<string, BiliVideoMeta>> {
  const out = new Map<string, BiliVideoMeta>();
  if (bvids.length === 0) return out;
  const db = await getDb();
  const [progressList, videoFavs] = await Promise.all([
    db.getAll('videoProgress'),
    db.getAllFromIndex('favorites', 'type', 'video'),
  ]);
  const progressByBvid = new Map(progressList.map((p) => [p.videoId, p] as const));
  const favByRefId = new Map<string, FavoriteEntity>();
  for (const fav of videoFavs) {
    if (fav.deletedAt != null) continue;
    if (typeof fav.refId !== 'string' || fav.refId.length === 0) continue;
    if (!favByRefId.has(fav.refId)) favByRefId.set(fav.refId, fav);
  }

  for (const bvid of bvids) {
    const progress: VideoProgressEntity | undefined = progressByBvid.get(bvid);
    const fav = favByRefId.get(bvid);
    const progressTitle = typeof progress?.title === 'string' ? progress.title.trim() : '';
    const favTitle = typeof fav?.snapshot?.title === 'string' ? fav.snapshot.title.trim() : '';
    const tickTitle = tickTitles.get(bvid) ?? '';
    const metaUrl: unknown = fav?.metadata?.url;
    const position = progress?.lastPositionSec;
    const duration = progress?.durationSec;
    out.set(bvid, {
      title: progressTitle || favTitle || tickTitle || biliTitleFallback(bvid),
      url: safeExternalUrl(metaUrl) ?? `https://www.bilibili.com/video/${bvid}`,
      lastPositionSec:
        typeof position === 'number' && Number.isFinite(position) && position > 0 ? Math.floor(position) : 0,
      durationSec:
        typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : null,
    });
  }
  return out;
}

/**
 * 区间内（本周/本月，边界由 op 层按 periodBuckets 口径给出）externalWatch 按
 * bvid 聚合秒数，TopN（默认 N=5）降序；并列秒数按 bvid 字典序稳定输出。
 * 空库 / 区间无记录返回 []。share = 该 bvid 秒数 / 区间总秒数。
 */
export async function biliTopWatched(range: BiliRange, limit: number = BILI_STATS_DEFAULT_LIMIT): Promise<BiliTopWatchedRow[]> {
  return wrap(async () => {
    const cap = clampLimit(limit);
    const db = await getDb();
    const rows = await db.getAllFromIndex('externalWatch', 'date', IDBKeyRange.bound(range.fromDay, range.toDay));
    const secByBvid = new Map<string, number>();
    const tickTitles = new Map<string, string>();
    for (const row of rows) {
      const parsed = asExternalRow(row);
      if (!parsed) continue;
      secByBvid.set(parsed.bvid, (secByBvid.get(parsed.bvid) ?? 0) + parsed.seconds);
      const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
      if (title && !tickTitles.has(parsed.bvid)) tickTitles.set(parsed.bvid, title);
    }
    const total = [...secByBvid.values()].reduce((sum, sec) => sum + sec, 0);
    const top = [...secByBvid.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, cap);
    const meta = await resolveBiliMeta(
      top.map(([bvid]) => bvid),
      tickTitles,
    );
    return top.map(([bvid, totalSec]) => ({
      bvid,
      title: meta.get(bvid)?.title ?? biliTitleFallback(bvid),
      totalSec: Math.round(totalSec),
      share: ratio(totalSec, total),
    }));
  });
}

/**
 * 最近观看的 B 站视频（全历史）：按最后观看日降序（同日按累计秒数、再按 bvid
 * 字典序稳定输出），取前 limit 条。累计秒为全历史合计；最后位置从 videoProgress
 * 读，读不到置 0；lastWatchedAt 为最后观看日本地 00:00 毫秒（externalWatch 按
 * 日累计，无时刻精度）。空库返回 []。
 */
export async function biliRecentWatched(limit: number = BILI_STATS_DEFAULT_LIMIT): Promise<BiliRecentWatchedRow[]> {
  return wrap(async () => {
    const cap = clampLimit(limit);
    const db = await getDb();
    const rows = await db.getAll('externalWatch');
    const agg = new Map<string, { totalSec: number; lastDay: string }>();
    const tickTitles = new Map<string, string>();
    for (const row of rows) {
      const parsed = asExternalRow(row);
      if (!parsed) continue;
      const entry = agg.get(parsed.bvid) ?? { totalSec: 0, lastDay: '' };
      entry.totalSec += parsed.seconds;
      // date 键为 'YYYY-MM-DD'，字典序即日历序
      if (parsed.date > entry.lastDay) entry.lastDay = parsed.date;
      agg.set(parsed.bvid, entry);
      const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
      if (title && !tickTitles.has(parsed.bvid)) tickTitles.set(parsed.bvid, title);
    }
    const ordered = [...agg.entries()]
      .sort(
        (a, b) =>
          b[1].lastDay.localeCompare(a[1].lastDay) || b[1].totalSec - a[1].totalSec || a[0].localeCompare(b[0]),
      )
      .slice(0, cap);
    const meta = await resolveBiliMeta(
      ordered.map(([bvid]) => bvid),
      tickTitles,
    );
    return ordered.map(([bvid, entry]) => {
      const resolved = meta.get(bvid);
      return {
        bvid,
        title: resolved?.title ?? biliTitleFallback(bvid),
        totalSec: Math.round(entry.totalSec),
        lastDay: entry.lastDay,
        lastWatchedAt: dayKeyToTs(entry.lastDay),
        lastPositionSec: resolved?.lastPositionSec ?? 0,
        durationSec: resolved?.durationSec ?? null,
        url: resolved?.url ?? `https://www.bilibili.com/video/${bvid}`,
      };
    });
  });
}

/**
 * 连续学习天数：externalWatch 有记录的自然日，从今天（今天尚无记录则从昨天）
 * 往回数连续天数。口径与站内 computeStreak 完全一致（复用同一实现）；
 * now 由调用方注入（缺省 Date.now()），保证可测。
 */
export async function biliStreakDays(now: number = Date.now()): Promise<number> {
  return wrap(async () => {
    const db = await getDb();
    const rows = await db.getAll('externalWatch');
    const days = new Set<string>();
    for (const row of rows) {
      const parsed = asExternalRow(row);
      if (parsed) days.add(parsed.date);
    }
    return computeStreak(days, localDayKey(now), now);
  });
}

/** 便捷封装：一次返回 op stats.bili.overview 的全部聚合结果 */
export async function buildBiliOverview(
  range: BiliRange & { kind: BiliOverviewResult['range']['kind'] },
  limit: number = BILI_STATS_DEFAULT_LIMIT,
): Promise<BiliOverviewResult> {
  const cap = clampLimit(limit);
  const [top, recent, streakDays] = await Promise.all([
    biliTopWatched(range, cap),
    biliRecentWatched(cap),
    biliStreakDays(),
  ]);
  return {
    range: { kind: range.kind, startDay: range.fromDay, endDay: range.toDay },
    top,
    recent,
    streakDays,
  };
}
