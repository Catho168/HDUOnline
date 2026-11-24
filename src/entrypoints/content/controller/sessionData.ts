/**
 * 会话数据装载（D8，第 45 轮自 content/index.tsx 纯搬移拆分）：
 *  - loadSession：loadToken 竞态守卫下的课次元数据装载（接口 → DOM 兜底 → 教师名
 *    顶栏补全 → 播放器实测时长校正 → 落库 + 关联数据并发装载）；
 *  - fallbackMeta：接口未返回元数据时的 DOM 兜底；
 *  - loadRelated：转写/问答/AI/收藏/笔记/站点收藏状态/统计摘要/ASR 作业 九路并发
 *    装载（迟到响应按 token 复核）。
 * 逻辑/文案/落库口径逐行未变（仅 this.→ctx. 机械替换）；竞态守卫（loadToken）留在
 * 控制器实现内（R1），本模块经 ctx.nextLoadToken/isLoadTokenCurrent 访问，禁止自行自增。
 */

import { callOp } from '@/core/shared/client';
import { isDemoActive } from '@/core/demo';
import { hduMediaKey } from '@/core/shared/mediaRef';
import type { SessionMeta, SiteNote } from '@/core/shared/types';
import { log, parseTeacherNamesFromDom } from './dom';
import { fetchPlayPageData, fetchSiteCollectionStatus, fetchSiteNotes } from '../site/api';
import { uiStore } from '../ui/store';
import type { ControllerContext } from './context';

// ───────── 会话装载竞态守卫（R1）：loadToken 的唯一实现，外部经 ctx 三方法访问 ─────────

let loadToken = 0;

export function nextLoadToken(): number {
  loadToken += 1;
  return loadToken;
}

export function isLoadTokenCurrent(token: number): boolean {
  return token === loadToken;
}

export function currentLoadToken(): number {
  return loadToken;
}

// ───────────────────────── 会话数据装载（D8） ─────────────────────────

export async function loadSession(ctx: ControllerContext, courId: number): Promise<void> {
  const token = ctx.nextLoadToken();
  uiStore.patch({ busy: { ...uiStore.getState().busy, session: true } });
  try {
    const data = await fetchPlayPageData(courId, ctx.route.teclId);
    if (!ctx.isLoadTokenCurrent(token)) return;
    let meta = data?.meta ?? fallbackMeta(ctx, courId);
    let syntheticDemoMeta = false;
    if (!meta && (await isDemoActive())) {
      if (!ctx.isLoadTokenCurrent(token)) return;
      const saved = await callOp('session.get', { courId }).catch(() => null);
      if (!ctx.isLoadTokenCurrent(token)) return;
      if (saved) {
        meta = {
          courId: saved.courId,
          teclId: saved.teclId,
          courseName: saved.courseName ?? `教学班 ${saved.teclId}`,
          teacherNames: parseTeacherNamesFromDom(),
          durationSec: saved.durationSec ?? 0,
          views: [],
          courLabel: saved.courLabel ?? `课次 ${courId}`,
          letiNumber: saved.letiNumber,
          lastPlayTime: saved.lastPositionSec,
        };
      } else {
        syntheticDemoMeta = true;
        meta = demoSyntheticMeta(ctx, courId);
      }
    }
    if (!meta) {
      uiStore.patch({ busy: { ...uiStore.getState().busy, session: false } });
      return;
    }
    // 接口未返回教师时，用播放页顶栏兜底，并在落库时补全课程教师
    if (meta.teacherNames.length === 0) {
      const fromDom = parseTeacherNamesFromDom();
      if (fromDom.length > 0) meta.teacherNames = fromDom;
    }
    const duration = ctx.player?.getDuration(meta.durationSec) || meta.durationSec;
    if (duration > 0) meta.durationSec = Math.round(duration);
    ctx.setMeta(meta);
    uiStore.patch({
      session: meta,
      siteCollected: data?.siteCollected ?? false,
      duration,
      busy: { ...uiStore.getState().busy, session: false },
    });
    void ctx.sendPageContext();
    void ctx.sendSessionMeta(meta);
    if (meta.teclId > 0 && !syntheticDemoMeta) {
      await callOp('session.saveMeta', { meta }).catch((err) => log.debug('会话落库失败', err));
    }
    void ctx.loadRelated(courId, token);
    ctx.updateRects();
  } catch (err) {
    // 迟到失败不触碰新会话的 busy 指示（第 51 轮审计 P3-7 加固）
    if (!ctx.isLoadTokenCurrent(token)) return;
    log.warn('课次元数据加载失败', err);
    uiStore.patch({ busy: { ...uiStore.getState().busy, session: false } });
  }
}

function fallbackMeta(ctx: ControllerContext, courId: number): SessionMeta | null {
  const teclId = ctx.route.teclId ?? ctx.meta?.teclId ?? 0;
  if (!teclId) return null;
  const heading = document.querySelector('.play-header .course-title, .play-header .title, .play-header h1, .course-title');
  const courseName = heading?.textContent?.trim() || document.title.split(/[-–|]/)[0]?.trim() || `教学班 ${teclId}`;
  const durationSec = ctx.player?.getDuration() ?? 0;
  return {
    courId,
    teclId,
    courseName,
    teacherNames: parseTeacherNamesFromDom(),
    durationSec,
    views: [],
    courLabel: `课次 ${courId}`,
    lastPlayTime: undefined,
  };
}

function demoSyntheticMeta(ctx: ControllerContext, courId: number): SessionMeta {
  const heading = document.querySelector('.play-header .course-title, .play-header .title, .play-header h1, .course-title');
  const courseName = heading?.textContent?.trim() || document.title.split(/[-–|]/)[0]?.trim() || '演示课程回放';
  const durationSec = ctx.player?.getDuration() || 3060;
  return {
    courId,
    teclId: 9102,
    courseName,
    teacherNames: parseTeacherNamesFromDom(),
    durationSec,
    views: [],
    courLabel: `课次 ${courId}`,
    lastPlayTime: undefined,
  };
}

export async function loadRelated(ctx: ControllerContext, courId: number, token: number): Promise<void> {
  // 转写/问答/AI 链路在入口处包装成 mediaKey（UI 层仍持 courId 数字语义）
  const mediaKey = hduMediaKey(courId);
  const [transcript, ai, groups, favorites, notes, siteNotes, collected, summary, job] = await Promise.all([
    callOp('transcript.get', { mediaKey }).catch(() => null),
    callOp('ai.get', { mediaKey }).catch(() => ({ result: null, stale: false })),
    callOp('qa.groups', { mediaKey }).catch(() => []),
    callOp('fav.list', { filter: { courId, limit: 200 } }).catch(() => []),
    callOp('note.list', { courId }).catch(() => []),
    fetchSiteNotes(courId).catch(() => [] as SiteNote[]),
    fetchSiteCollectionStatus(courId).catch(() => null),
    callOp('stats.sessionSummary', { courId }).catch(() => null),
    // 页面刷新后 SW 可能仍在转写：恢复作业状态，问答/速览才知道"字幕正在生成"
    callOp('asr.status', { mediaKey }).catch(() => null),
  ]);
  if (!ctx.isLoadTokenCurrent(token)) return;
  const groupId = groups[0]?.groupId;
  const chats = groupId ? await callOp('qa.list', { mediaKey, groupId }).catch(() => []) : [];
  if (!ctx.isLoadTokenCurrent(token)) return;
  uiStore.patch({
    transcript,
    ai: ai.result,
    aiStale: ai.stale,
    chats,
    activeGroupId: groupId,
    job,
    favorites,
    notes,
    siteNotes,
    siteCollected: collected ?? false,
    watchedSec: summary?.watchedSec ?? 0,
    watchRatio: summary?.watchRatio ?? 0,
  });
}
