/**
 * 「从 B 站导入」收藏夹批量导入弹窗（知识库视图工具栏入口）。
 *
 * 三步流程（分页与写入循环由前端编排，SW 只做单页请求 / 单条写入）：
 *  ① bili.nav.get 检测登录态 → bili.favlist.folders 列出收藏夹（单选）；
 *  ② 选中后逐页 bili.favlist.items（pn 递增直到 hasMore=false，页间 ~300ms），实时显示「已获取 x/y」；
 *  ③ 逐条转 fav.put 载荷写入（refId=bvid，命中去重记为跳过），完成后展示 导入/跳过/失败 计数；
 *  ④ 可选收尾：询问是否为本次新导入的视频生成每周学习计划（plan.weekly.create，见 core/plan/weekly）。
 *
 * 防重复点击（第 36 轮巡检）：导入进行中（fetching/importing）再次点击收藏夹行直接忽略
 * （runningRef 确定性守卫）；②③ 两阶段已有实时进度展示（已获取 x/y / 已写入 x/y）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { callOp } from '@/core/shared/client';
import { errorTextOf } from '@/core/shared/errors';
import type { BiliFavFolder, BiliFavItem } from '@/core/bili/favlist';
import type { FavoriteEntity } from '@/core/shared/types';
import { uuid } from '@/core/shared/utils';
import { Button, EmptyState, Modal, Progress, TextInput, cx } from './components';
import { Icon } from './icons';
import { uiStore } from './store';

/** 分页请求间隔（降低风控概率） */
const PAGE_DELAY_MS = 300;
/** 每页条数（B 站 resource/list 单页上限内） */
const PAGE_SIZE = 20;
/** 分页防御上限：超过 100 页仍未结束则中止（正常收藏夹远达不到） */
const MAX_PAGES = 100;

type Phase = 'loading' | 'pick' | 'fetching' | 'importing' | 'done';

interface ImportResult {
  imported: number;
  skipped: number;
  failed: number;
}

/** 生成计划成功后的本地摘要 */
interface PlanSummary {
  count: number;
  perDay: number;
  days: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function BiliImportModal({ open, onClose }: { open: boolean; onClose: (imported: boolean) => void }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [isLogin, setIsLogin] = useState<boolean | null>(null);
  const [folders, setFolders] = useState<BiliFavFolder[]>([]);
  const [activeFolder, setActiveFolder] = useState<BiliFavFolder | null>(null);
  const [fetchedCount, setFetchedCount] = useState(0);
  const [fetchedTotal, setFetchedTotal] = useState(0);
  const [writeProgress, setWriteProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<ImportResult | null>(null);
  /** 弹窗关闭/重置后中止进行中的分页与写入循环 */
  const cancelledRef = useRef(false);
  /**
   * 弹窗会话代际（第 38 轮巡检）：每次打开（open 变 true）递增。快速关+开时，旧会话
   * 的 in-flight 分页/写入循环在各检查点比对当前代际，不匹配即中止——仅靠布尔
   * cancelledRef 会在「关闭又立即重开」时被复位，旧循环会“复活”继续写入。
   */
  const sessionRef = useRef(0);
  /** 导入进行中标记（第 36 轮巡检，防重复点击）：fetching/importing 期间再次触发
   *  startImport 直接忽略——phase 置换到重渲染之间存在连点窗口，ref 守卫做确定性拦截 */
  const runningRef = useRef(false);
  /** 本次弹窗内是否已有实际写入（含中途关闭），决定关闭时是否刷新知识库列表 */
  const wroteRef = useRef(false);
  /** ── 每周学习计划询问区（done 阶段展示） ── */
  /** 本次导入新写入（不含跳过/失败）的 bvid，供「生成每周计划」使用 */
  const importedBvidsRef = useRef<string[]>([]);
  const [planPerDay, setPlanPerDay] = useState(2);
  const [planSummary, setPlanSummary] = useState<PlanSummary | null>(null);
  const [planDismissed, setPlanDismissed] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  /** 每天个数越界被收正（如 25→20）时的输入框短暂提示色（0.5s） */
  const [clampFlash, setClampFlash] = useState(false);
  const clampTimerRef = useRef<number | null>(null);

  /** 步骤①：登录态检测 → 收藏夹列表（各响应检查点比对会话代际，迟到即丢弃） */
  const loadFolders = useCallback(async () => {
    const session = sessionRef.current;
    setPhase('loading');
    setError(null);
    setIsLogin(null);
    setFolders([]);
    try {
      const nav = await callOp('bili.nav.get', {});
      if (cancelledRef.current || sessionRef.current !== session) return;
      setIsLogin(nav.isLogin);
      if (!nav.isLogin) {
        setPhase('pick');
        return;
      }
      const res = await callOp('bili.favlist.folders', {});
      if (cancelledRef.current || sessionRef.current !== session) return;
      setFolders(res.folders);
      setPhase('pick');
    } catch (err) {
      if (cancelledRef.current || sessionRef.current !== session) return;
      // 第 255 轮错误文案盘点：缺省兜底补上下文词（B 站收藏夹列表语境），AppError 的
      // userMessage 照常优先
      setError(errorTextOf(err, 'B 站收藏夹列表读取失败，请重试'));
      setPhase('pick');
    }
  }, []);

  // 打开时递增会话代际并重置状态进入步骤①；关闭时置取消标记
  useEffect(() => {
    if (open) {
      sessionRef.current += 1;
      cancelledRef.current = false;
      runningRef.current = false;
      wroteRef.current = false;
      setPhase('loading');
      setError(null);
      setResult(null);
      setActiveFolder(null);
      setFolders([]);
      setFetchedCount(0);
      setFetchedTotal(0);
      setWriteProgress({ done: 0, total: 0 });
      // 每周计划询问区一并复位
      importedBvidsRef.current = [];
      setPlanPerDay(2);
      setPlanSummary(null);
      setPlanDismissed(false);
      setPlanBusy(false);
      setPlanError(null);
      setClampFlash(false);
      if (clampTimerRef.current != null) {
        window.clearTimeout(clampTimerRef.current);
        clampTimerRef.current = null;
      }
      void loadFolders();
    } else {
      cancelledRef.current = true;
    }
  }, [open, loadFolders]);

  /** 步骤②：逐页拉取条目；步骤③：逐条写入知识库。
   *  入口先过 runningRef 防重复点击守卫（第 36 轮）：导入进行中（含 phase 置换到
   *  重渲染之间的连点窗口）再次触发直接忽略；守卫经 try/finally 在所有退出路径
   *  （完成/中途取消/分页失败）释放。各检查点（分页每轮、每条写入前）比对会话
   *  代际（第 38 轮巡检）：弹窗关闭或已重开新会话时，旧会话循环立即中止。 */
  const startImport = useCallback(async (folder: BiliFavFolder) => {
    if (runningRef.current) return;
    runningRef.current = true;
    const session = sessionRef.current;
    /** 检查点：弹窗已关闭（cancelled）或已进入新会话（快速关+开）即视为过期 */
    const stale = () => cancelledRef.current || sessionRef.current !== session;
    try {
      setActiveFolder(folder);
      setPhase('fetching');
      setError(null);
      setFetchedCount(0);
      setFetchedTotal(0);

      const collected: BiliFavItem[] = [];
      try {
        for (let pn = 1; pn <= MAX_PAGES; pn += 1) {
          if (stale()) return;
          const page = await callOp('bili.favlist.items', { mediaId: folder.id, pn, ps: PAGE_SIZE });
          if (stale()) return;
          collected.push(...page.items);
          setFetchedTotal(page.total);
          setFetchedCount(collected.length);
          // hasMore=false 或返回空页时结束分页（空页防御避免 hasMore 异常导致死循环）
          if (!page.hasMore || page.items.length === 0) break;
          await delay(PAGE_DELAY_MS);
        }
      } catch (err) {
        if (stale()) return;
        // 第 255 轮错误文案盘点：缺省兜底补上下文词（收藏清单拉取语境），AppError 的
        // userMessage 照常优先
        setError(errorTextOf(err, '收藏清单读取失败，导入已中止'));
        setPhase('pick');
        return;
      }
      if (stale()) return;

      // 步骤③：逐条写为视频收藏；putFavorite 以 type+refId 去重，返回旧条目（id 不同）即「跳过」
      setPhase('importing');
      setWriteProgress({ done: 0, total: collected.length });
      let imported = 0;
      let skipped = 0;
      let failed = 0;
      importedBvidsRef.current = [];
      for (const item of collected) {
        if (stale()) return;
        const url = `https://www.bilibili.com/video/${item.bvid}`;
        const favorite: Omit<FavoriteEntity, 'updatedAt'> = {
          id: uuid(),
          type: 'video',
          refId: item.bvid,
          snapshot: { title: item.title, content: item.intro || url },
          folderId: null,
          tags: [],
          pinned: false,
          favoritedAt: Date.now(),
          metadata: {
            platform: 'bilibili',
            bvid: item.bvid,
            coverUrl: item.coverUrl,
            uploader: item.uploader,
            durationSec: item.durationSec,
            url,
            intro: item.intro,
          },
        };
        try {
          const saved = await callOp('fav.put', { favorite });
          if (saved.id === favorite.id) {
            imported += 1;
            // 只收集本次新写入的 bvid（跳过/失败的不进计划）
            importedBvidsRef.current.push(item.bvid);
            wroteRef.current = true;
          } else {
            skipped += 1;
          }
        } catch {
          failed += 1;
        }
        setWriteProgress({ done: imported + skipped + failed, total: collected.length });
      }
      if (stale()) return;
      setResult({ imported, skipped, failed });
      setPhase('done');
    } finally {
      // 仅当仍是当前会话时释放运行标记：旧会话迟到收尾不得清掉新会话的防重守卫
      // （新会话的打开 effect 已自行复位 runningRef）
      if (sessionRef.current === session) runningRef.current = false;
    }
  }, []);

  /** 步骤④（可选）：把本次新导入的视频生成每周学习计划；失败仅就地提示，不影响导入结果 */
  const createPlan = useCallback(async () => {
    setPlanBusy(true);
    setPlanError(null);
    try {
      const perDay = Math.max(1, Math.min(20, Math.round(Number(planPerDay) || 2)));
      const res = await callOp('plan.weekly.create', {
        bvids: [...importedBvidsRef.current],
        perDay,
        label: activeFolder?.title || undefined,
      });
      const count = res.plan.bvids.length;
      setPlanSummary({ count, perDay: res.plan.perDay, days: Math.ceil(count / Math.max(1, res.plan.perDay)) });
      // 刷新联动：计划落库后立即自增 centerDataVersion（今日待办卡监听该版本号，
      // 与课程/课表同步后走同一信号），回到总览无需重开学习中心
      uiStore.patch({ centerDataVersion: uiStore.getState().centerDataVersion + 1 });
    } catch (err) {
      setPlanError(errorTextOf(err, '生成计划失败，请重试'));
    } finally {
      setPlanBusy(false);
    }
  }, [activeFolder, planPerDay]);

  /** 每天个数输入：clamp 到 1–20；越界被收正时给输入框 0.5s 边框提示色（无动画，reduced-motion 无影响） */
  const changePerDay = useCallback((raw: string) => {
    const n = Math.round(Number(raw));
    const outOfRange = Number.isFinite(n) && raw.trim() !== '' && (n > 20 || n < 1);
    setPlanPerDay(Math.max(1, Math.min(20, Number.isFinite(n) ? n : 2)));
    if (!outOfRange) return;
    setClampFlash(true);
    if (clampTimerRef.current != null) window.clearTimeout(clampTimerRef.current);
    clampTimerRef.current = window.setTimeout(() => setClampFlash(false), 500);
  }, []);

  // 卸载时清掉提示色定时器
  useEffect(
    () => () => {
      if (clampTimerRef.current != null) window.clearTimeout(clampTimerRef.current);
    },
    [],
  );

  const handleClose = useCallback(() => {
    cancelledRef.current = true;
    onClose(wroteRef.current);
  }, []);

  const retryableError = error !== null && (phase === 'pick' || phase === 'loading');

  return (
    <Modal
      open={open}
      title="从 B 站导入"
      onClose={handleClose}
      width={460}
      footer={
        phase === 'done' && result ? (
          <Button variant="accent" onClick={handleClose}>
            完成
          </Button>
        ) : undefined
      }
    >
      {error !== null ? (
        <div className="hdu-error-text" role="alert">
          {error}
          {retryableError ? (
            <Button size="small" variant="ghost" icon="refresh" style={{ marginLeft: 8 }} onClick={() => void loadFolders()}>
              重试
            </Button>
          ) : null}
        </div>
      ) : null}

      {phase === 'loading' ? (
        <div className="hdu-empty">
          <span className="hdu-spinner" />
          <div className="hdu-empty-text">正在连接 B 站，读取登录状态与收藏夹…</div>
        </div>
      ) : null}

      {phase === 'pick' && isLogin === false ? (
        <EmptyState
          icon="info"
          title="尚未登录 B 站"
          text="请先在浏览器中登录 bilibili.com。导入功能通过浏览器 Cookie 读取你自己收藏夹里的视频，数据只保存在本机扩展内。"
          action={
            /* 空态 CTA 统一 small ghost（第 249 轮空态模板化） */
            <Button size="small" variant="ghost" icon="external" onClick={() => window.open('https://www.bilibili.com', '_blank', 'noopener')}>
              去登录 B 站
            </Button>
          }
        />
      ) : null}

      {phase === 'pick' && isLogin === true ? (
        folders.length === 0 && error === null ? (
          <EmptyState icon="folder" title="没有可导入的收藏夹" text="当前 B 站账号下还没有创建任何收藏夹。" />
        ) : (
          <>
            <div className="hdu-hint">选择一个 B 站收藏夹，其中的视频稿件会导入知识库；已存在的视频会自动跳过。</div>
            <div className="hdu-list hdu-scroll" style={{ maxHeight: 320, overflowY: 'auto' }}>
              {folders.map((folder) => (
                <button key={folder.id} type="button" className="hdu-session-row" onClick={() => void startImport(folder)}>
                  <Icon name="folder" size={14} />
                  <div className="hdu-list-main">
                    <div className="hdu-list-title">{folder.title}</div>
                    <div className="hdu-list-sub">{folder.mediaCount} 条内容</div>
                  </div>
                  <Icon name="chevronRight" size={14} />
                </button>
              ))}
            </div>
          </>
        )
      ) : null}

      {phase === 'fetching' ? (
        <>
          <div className="hdu-list-title">正在拉取「{activeFolder?.title ?? ''}」…</div>
          <Progress value={fetchedTotal > 0 ? Math.min(1, fetchedCount / fetchedTotal) : 0} jade />
          <div className="hdu-hint">
            已获取 {fetchedCount}
            {fetchedTotal > 0 ? ` / ${fetchedTotal}` : ''} 条（页间自动稍作停顿，以降低风控概率）
          </div>
        </>
      ) : null}

      {phase === 'importing' ? (
        <>
          <div className="hdu-list-title">正在写入知识库…</div>
          <Progress value={writeProgress.total > 0 ? writeProgress.done / writeProgress.total : 0} jade />
          <div className="hdu-hint">
            已写入 {writeProgress.done} / {writeProgress.total} 条
          </div>
        </>
      ) : null}

      {phase === 'done' && result ? (
        <>
          <EmptyState
            icon={result.failed > 0 ? 'alert' : 'check'}
            title="导入完成"
            text={`导入 ${result.imported} / 跳过 ${result.skipped} / 失败 ${result.failed}`}
          />
          {/* 每周计划询问区：仅对本次新导入的视频提供（跳过/失败的不算）；onClose 语义不受影响 */}
          {result.imported > 0 && importedBvidsRef.current.length > 0 ? (
            planSummary ? (
              <div className="hdu-hint" role="status" style={{ marginTop: 10 }}>
                已生成计划：共 {planSummary.count} 个视频，每天 {planSummary.perDay} 个，约 {planSummary.days} 天完成。
              </div>
            ) : planDismissed ? null : (
              <div>
                <div className="hdu-divider" style={{ margin: '12px 0' }} />
                <div className="hdu-hint">
                  为本次导入的 {importedBvidsRef.current.length} 个视频生成每周学习计划？每天 1–20 个，按日历推进，不做补卡。
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                  <span style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>每天</span>
                  <TextInput
                    type="number"
                    min={1}
                    max={20}
                    aria-label="每天学习视频数"
                    value={planPerDay}
                    onChange={(e) => changePerDay(e.target.value)}
                    className={cx(clampFlash ? 'flash-clamp' : '')}
                    style={{ width: 64 }}
                  />
                  <span style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>个</span>
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                    <Button size="small" variant="ghost" onClick={() => setPlanDismissed(true)}>
                      暂不
                    </Button>
                    <Button size="small" variant="accent" loading={planBusy} onClick={() => void createPlan()}>
                      生成计划
                    </Button>
                  </span>
                </div>
                {planError ? (
                  <div className="hdu-error-text" role="alert" style={{ marginTop: 8 }}>
                    {planError}
                  </div>
                ) : null}
              </div>
            )
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}
