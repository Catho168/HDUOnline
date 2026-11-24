// 学习中心顶栏统一搜索（自 LearningCenter.tsx 第 40 轮巡检按视图纯搬移拆分，逻辑不变）。
// 导出供单元测试（topbar-search-keys.test.ts）：方向键导航的 combobox 行为验证。
import { useCallback, useEffect, useId, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { callOp } from '@/core/shared/client';
import { formatClock, withTimeParam } from '@/core/shared/utils';
import { SEARCH_FAVORITES_LIMIT, UNIFIED_GROUP_LABELS, markTextSegments, snippetToSegments, type UnifiedHit, type UnifiedSearchResult } from '@/core/search/unified';
import { SkeletonRows, Spinner, cx } from '../components';
import { Icon } from '../icons';
import { uiStore, useUiStore } from '../store';
import { RECENT_QUERY_CAP, emptySearchTip, pushRecentQuery, recentQueryLabel, removeRecentQuery } from './recentQueries';

/** 防抖时长：输入稳定 300ms 后才发起查询 */
const SEARCH_DEBOUNCE_MS = 300;
/** 与 background runUnifiedSearch 的 capPerSource 一致，仅用于提示文案 */
const SEARCH_CAP_PER_SOURCE = 5;

type SearchStatus = 'idle' | 'loading' | 'done' | 'error';

/**
 * 顶栏统一搜索：输入 ≥1 字符后防抖触发 `search.all`，聚合字幕 / 收藏 / 笔记 / 复习
 * 四组命中（第 245 轮巡检补复习组：pending 作业按收藏标题 + 标签匹配，跳转复用
 * 收藏跳转规则——video 收藏 ?t= 续看外链、站内课次 openSessionInSite）。
 *  - 字幕 / 笔记 → 复用课次跳转 openSessionInSite（命中带 anchorSec 时透传秒级直达，
 *    第 104 轮巡检；B 站宿主经 onSessionJump 覆写为新标签 ?t= 深链——第 77 轮巡检：
 *    B 站学习中心宿主内 uiStore 的 openSessionInSite 是空实现）；
 *  - 视频 / 外链收藏 → 新标签打开（?t= 续看规则与知识库卡片一致）；
 *  - 点击后收起面板并清空输入；Esc / 点击面板外收起。
 *    不再整体 preventDefault 面板 mousedown：那会连摘要文字的拖选一起禁掉；
 *    面板存续改由「点击面板外才收起」保证（不靠输入框焦点），结果条目的 click 因此始终能触发。
 *  - 方向键导航（combobox 完整化）：↑/↓ 在 option 间移动高亮（aria-activedescendant 方案，
 *    输入框保持焦点），↓ 在末项回绕到首项、↑ 反向；Home/End 跳到首/末项；
 *    Enter 执行当前高亮项（无高亮时维持原行为——不触发任何跳转）；
 *    输入内容变化 / 重新搜索 / 收起面板时高亮复位；与 Esc（关闭）不冲突。
 *  - 最近搜索 chips（第 246 轮巡检，搜索域）：非空提交（防抖触发 runSearch）记录到
 *    settings.ui.recentQueries（最新在前去重前移，最多 5 条，跨打开保留）；输入框聚焦
 *    且为空时在输入框下方回放成 chips 行——chip 点击填入关键词走既有防抖搜索链路
 *    （与手输同语义，不另起直发通道），chip 后缀 × 单条删除，「清空」一键清空；
 *    Esc / 点击面板外收起时一并隐藏 chips（与结果面板同生命周期，不留悬空行）。
 *  - 键盘流盘点补齐（第 247 轮巡检，键盘域）：盘点结论——上下循环 / Home / End /
 *    Enter 执行高亮 / 焦点管理（aria-activedescendant，输入框恒保持焦点）均已达标
 *    （见 tests/unit/topbar-search-keys.test.ts），本轮补两处防御：
 *    ①Enter 统一接管：面板打开时一律 preventDefault（防宿主页表单隐式提交），
 *      无高亮 / 无结果显式无操作（此前仅靠 active 守卫「不动作」，未拦默认行为）；
 *    ②浮层底部键位 hint 行「↑↓ 选择 · Enter 打开 · Esc 关闭」（仅在有可导航
 *      option 时出现；Esc 分层关闭不适用——chips 行与结果面板经 hasQuery 门互斥，
 *      恒不同屏，一键全关即正确行为）。
 */
/** 导出供单元测试（topbar-search-keys.test.ts）：方向键导航的 combobox 行为验证 */
export function TopBarSearch(props: { onSessionJump?: (courId: number, teclId?: number, anchorSec?: number) => void }) {
  // props 经 `?? {}` 兜底：createElement/JSX 无 props 时 React 可能传 null（第 77 轮）
  const { onSessionJump } = props ?? {};
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [result, setResult] = useState<UnifiedSearchResult | null>(null);
  const [open, setOpen] = useState(false);
  // 方向键高亮的扁平序号（跨分组连续编号）；null = 无高亮
  const [active, setActive] = useState<number | null>(null);
  // 最近搜索 chips 行可见性（第 246 轮巡检）：聚焦且输入为空时显示；Esc / 点击面板外 /
  // 点选结果（consume）后隐藏。不跟输入框 blur 走——点 chip 时 blur 先于 click，
  // 若 blur 即隐藏会在点击落地前拆掉按钮（既有面板「不靠输入框焦点」的同款取舍）
  const [recentOpen, setRecentOpen] = useState(false);
  // 组内展开态（第 260 轮，检索域 / 完整性）：total > cap 的组可「展开全部 N 条」——
  // 聚合器 all 字段带全量，展开是纯前端呈现；新搜索 / 收起面板时复位
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  // combobox 语义：aria-controls 指向结果列表（列表条件渲染，关闭时引用悬空是允许的）
  const listboxId = useId();
  // 结果面板引用：方向键 Enter 激活与高亮滚动定位都需要按扁平序号取 option 元素
  const popRef = useRef<HTMLDivElement | null>(null);
  // 输入框引用（第 266 轮）：清空按钮点击后焦点回归输入框（继续输入不丢焦点）
  const inputRef = useRef<HTMLInputElement | null>(null);
  // 递增序号：防抖/在途请求过期后不覆盖新一轮结果
  const seqRef = useRef(0);
  // 最近搜索列表（settings.ui.recentQueries，跨打开保留；随 store 订阅回放更新）
  const recentQueries = useUiStore().settings?.ui?.recentQueries ?? [];

  /** 最近搜索落盘（仿 overviewWeekOpen 模式：本地 state 即时生效 + saveSetting 异步落 chrome.storage） */
  const persistRecent = useCallback((next: string[]) => {
    const current = uiStore.getState().settings;
    const ui = { ...current.ui, recentQueries: next };
    uiStore.patch({ settings: { ...current, ui } });
    void uiStore.actions.saveSetting('ui', ui);
  }, []);

  /** 非空搜索提交记录一条最近搜索（去重前移；与既有列表逐字相等时不落盘） */
  const recordRecent = useCallback(
    (kw: string) => {
      const current = uiStore.getState().settings;
      const prev = current?.ui?.recentQueries ?? [];
      const next = pushRecentQuery(prev, kw, RECENT_QUERY_CAP);
      if (JSON.stringify(prev) === JSON.stringify(next)) return;
      persistRecent(next);
    },
    [persistRecent],
  );

  const runSearch = useCallback((kw: string) => {
    const seq = ++seqRef.current;
    setStatus('loading');
    setOpen(true);
    setActive(null); // 新一轮搜索结果可能与上一轮不同，高亮复位
    setExpandedGroups(new Set()); // 展开态不跨搜索残留（第 260 轮）
    recordRecent(kw);
    void callOp('search.all', { keyword: kw })
      .then((res) => {
        if (seq !== seqRef.current) return;
        setResult(res);
        setStatus('done');
      })
      .catch(() => {
        if (seq !== seqRef.current) return;
        setStatus('error');
      });
  }, [recordRecent]);

  useEffect(() => {
    const kw = query.trim();
    // 空关键词直接短路清空（不发起查询）
    if (kw.length < 1) {
      seqRef.current += 1;
      setStatus('idle');
      setResult(null);
      setOpen(false);
      setActive(null);
      return undefined;
    }
    // 输入内容变化时高亮复位（防抖结果尚未返回也可能先移动了高亮）
    setActive(null);
    const timer = window.setTimeout(() => runSearch(kw), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, runSearch]);

  // 点击面板外收起：捕获阶段监听 document，用 composedPath 穿透 shadow 边界判定真实落点。
  // 第 246 轮：chips 行也在 .hdu-topbar-search 容器内（点 chip / 删除 × / 清空不受影响），
  // 点外面板与 chips 一并收起（同一生命周期）
  useEffect(() => {
    if (!open && !recentOpen) return undefined;
    const onDocMouseDown = (event: MouseEvent) => {
      const inside = event.composedPath().some(
        (node) => node instanceof Element && node.classList.contains('hdu-topbar-search'),
      );
      if (!inside) {
        setOpen(false);
        setRecentOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    return () => document.removeEventListener('mousedown', onDocMouseDown, true);
  }, [open, recentOpen]);

  // 高亮变化后滚动到可见（面板 max-height 420px 内部滚动；jsdom 无 scrollIntoView，防御式跳过）
  useEffect(() => {
    if (active == null) return;
    const el = popRef.current?.querySelectorAll('[role="option"]')[active];
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [active]);

  /** 点击结果后：清空输入、收起面板（chips 行一并隐藏——本轮搜索已完结，下次聚焦再回放） */
  const consume = useCallback(() => {
    seqRef.current += 1;
    setQuery('');
    setResult(null);
    setStatus('idle');
    setOpen(false);
    setActive(null);
    setRecentOpen(false);
    setExpandedGroups(new Set());
  }, []);

  const hasQuery = query.trim().length >= 1;
  // 当前渲染的 option 总数（错误 / 加载 / 空态提示不是 option，计 0）；
  // 第 260 轮起按组展开态取 all / items（与 DOM 中 [role=option] 顺序一致；all 缺省回退 items）
  const optionCount = result
    ? result.groups.reduce((n, g) => n + (expandedGroups.has(g.kind) ? (g.all ?? g.items).length : g.items.length), 0)
    : 0;

  /** chips 点击：填入关键词（既有防抖 effect 负责发起搜索，与手输同一链路） */
  const applyRecentQuery = useCallback((q: string) => {
    setQuery(q);
  }, []);

  /** chips 单条删除（settings.ui.recentQueries 落盘） */
  const removeOneRecent = useCallback(
    (q: string) => {
      persistRecent(removeRecentQuery(uiStore.getState().settings?.ui?.recentQueries, q));
    },
    [persistRecent],
  );

  /** Enter 激活当前高亮项：按扁平序号取 DOM 元素，仅可操作条目（a/button）触发点击 */
  const activateOption = useCallback((index: number) => {
    const el = popRef.current?.querySelectorAll('[role="option"]')[index];
    if (el instanceof HTMLElement && el.matches('a, button')) el.click();
  }, []);

  return (
    <div className="hdu-topbar-search">
      <div className="hdu-search">
        <Icon name="search" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setActive(null);
              setOpen(false);
              setRecentOpen(false); // 第 246 轮：Esc 关闭面板时 chips 一并隐藏
              return;
            }
            // 方向键 / Home / End：仅在面板打开且有 option 时接管（aria-activedescendant，输入框保持焦点）
            if (open && optionCount > 0 && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
              e.preventDefault();
              setActive((prev) => {
                const cur = prev != null && prev < optionCount ? prev : null;
                if (e.key === 'ArrowDown') return cur == null ? 0 : (cur + 1) % optionCount;
                if (e.key === 'ArrowUp') return cur == null ? optionCount - 1 : (cur - 1 + optionCount) % optionCount;
                if (e.key === 'Home') return 0;
                return optionCount - 1;
              });
              return;
            }
            if (e.key === 'Enter' && open) {
              // 第 247 轮（键盘域盘点后防御补齐）：面板打开时 Enter 统一接管——
              // preventDefault 防止宿主页表单的隐式提交；有高亮执行当前项，
              // 无高亮 / 无结果（空态、加载、错误）显式无操作（不关面板不跳转）
              e.preventDefault();
              if (active != null && active < optionCount) activateOption(active);
              return;
            }
          }}
          onFocus={() => {
            if (hasQuery) setOpen(true);
            else setRecentOpen(true); // 第 246 轮：聚焦且为空时回放最近搜索 chips
          }}
          placeholder="搜索字幕、收藏、笔记、复习…"
          aria-label="统一搜索"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open && hasQuery}
          aria-controls={listboxId}
          aria-activedescendant={open && active != null && active < optionCount ? `${listboxId}-opt-${active}` : undefined}
        />
        {/* 清除输入（第 265 轮，检索域 / 输入体验）：有输入时提供一键 × 清空——
            与 Esc 同语义（清词 + 收面板 + 收 chips），免全选删除 */}
        {hasQuery ? (
          <button
            type="button"
            className="hdu-search-clear"
            aria-label="清空搜索"
            title="清空搜索"
            onClick={() => {
              setQuery('');
              setRecentOpen(false);
              // 焦点回归输入框（第 266 轮）：清空后继续输入不丢焦点
              inputRef.current?.focus();
            }}
          >
            ×
          </button>
        ) : null}
        {status === 'loading' ? <Spinner size={13} /> : null}
      </div>
      {/* 最近搜索 chips 行（第 246 轮巡检）：聚焦且输入为空时显示；chip 点击填入并
          （经既有防抖）执行搜索，后缀 × 单条删除，「清空」一键清空；无记录不渲染。
          超长词 CSS ellipsis 截断展示（title 给全文），与结果面板互斥（hasQuery 门） */}
      {recentOpen && !hasQuery && recentQueries.length > 0 ? (
        <div className="hdu-recent-row" role="group" aria-label="最近搜索">
          <span className="hdu-recent-label">最近搜索</span>
          {recentQueries.map((q) => (
            <span className="hdu-recent-chip" key={q}>
              <button type="button" className="hdu-recent-q" title={q} onClick={() => applyRecentQuery(q)}>
                {recentQueryLabel(q)}
              </button>
              <button
                type="button"
                className="hdu-recent-del"
                aria-label={`删除最近搜索 ${q}`}
                title="删除该条"
                onClick={() => removeOneRecent(q)}
              >
                ×
              </button>
            </span>
          ))}
          <button type="button" className="hdu-recent-clear" title="清空最近搜索记录" onClick={() => { persistRecent([]); inputRef.current?.focus(); }}>
            清空
          </button>
        </div>
      ) : null}
      {open && hasQuery ? (
        <div ref={popRef} id={listboxId} className="hdu-search-pop hdu-scroll" role="listbox" aria-label="统一搜索结果">
          {status === 'error' ? (
            <div className="hdu-search-hint">
              搜索失败，请重试
              <button type="button" className="hdu-btn ghost small" onClick={() => runSearch(query.trim())}>
                重试
              </button>
            </div>
          ) : status === 'loading' && !result ? (
            // 搜索中骨架（第 261 轮，检索域 / 反馈质感）：三行阶梯骨架替代单行
            // 「搜索中…」文字——与学习中心视图骨架同语言（SkeletonRows 共享组件，
            // shimmer 与 reduced-motion 兜底由 .hdu-skeleton 基类继承）
            <div className="hdu-search-loading">
              <SkeletonRows height={12} gap={9} />
            </div>
          ) : result && result.groups.length === 0 ? (
            // 空结果引导（第 259 轮，检索域 / 空态体验）：一句建议 + 最近搜索 chips
            // （有记录时回放前 3 个，点击填词重搜——与聚焦空输入时的 chips 同一链路）
            <div className="hdu-search-empty">
              <div className="hdu-search-hint">没有匹配的字幕、收藏、笔记或复习</div>
              <div className="hdu-search-empty-tips">{emptySearchTip(query)}</div>
              {recentQueries.length > 0 ? (
                <div className="hdu-search-empty-recent" role="group" aria-label="从最近搜索重试">
                  {recentQueries.slice(0, 3).map((q) => (
                    <button key={q} type="button" className="hdu-recent-q" title={q} onClick={() => applyRecentQuery(q)}>
                      {recentQueryLabel(q)}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            (() => {
              // 跨分组连续编号：高亮序号 / 元素 id 都用扁平序号，与 DOM 中 [role=option] 顺序一致
              let running = 0;
              return result?.groups.map((group) => {
                // 组内展开（第 260 轮）：total > 展示上限且带 all 的组可切换 items ↔ all
                // （纯前端，聚合器 all 已带全量；桩缺 all 回退 items 无展开按钮）；
                // 展开/收起后 option 总数变化，高亮序号复位防越界
                const isExpanded = expandedGroups.has(group.kind);
                const allItems = group.all ?? group.items;
                const canExpand = allItems.length > group.items.length;
                const shown = isExpanded ? allItems : group.items;
                const offset = running;
                running += shown.length;
                const toggleExpand = (event: ReactMouseEvent<HTMLButtonElement>) => {
                  setExpandedGroups((prev) => {
                    const next = new Set(prev);
                    if (next.has(group.kind)) next.delete(group.kind);
                    else next.add(group.kind);
                    return next;
                  });
                  setActive(null);
                  // 展开后把该组滚回面板可视区（第 262 轮）：长组展开时组头/按钮仍可见，
                  // 不用手动上翻；jsdom 无 scrollIntoView，防御式跳过（既有先例）
                  const head = event.currentTarget.closest('.hdu-search-group')?.querySelector('.hdu-search-group-head');
                  if (head && typeof head.scrollIntoView === 'function') head.scrollIntoView({ block: 'nearest' });
                };
                return (
                  <div
                    className="hdu-search-group"
                    role="group"
                    aria-label={isExpanded ? `${group.label}（已展开全部 ${group.total} 条）` : group.label}
                    key={group.kind}
                  >
                    <div className="hdu-search-group-head">
                      <span>{group.label}</span>
                      <span className="hdu-search-group-count">{group.total}</span>
                    </div>
                    {shown.map((hit, i) => (
                      <SearchItem
                        key={`${group.kind}-${i}`}
                        hit={hit}
                        kw={query.trim()}
                        onDone={consume}
                        id={`${listboxId}-opt-${offset + i}`}
                        active={active === offset + i}
                        onSessionJump={onSessionJump}
                      />
                    ))}
                    {/* 收藏触顶提示（第 18 轮审计留观项）移到展开按钮之前（第 265 轮）：
                        先说明数据范围（最近 30 条参与搜索），再给展开动作——语义顺序 */}
                    {group.kind === 'favorite' && result?.favoritesTruncated ? (
                      <div className="hdu-search-group-hint">收藏较多，仅搜索最近 {SEARCH_FAVORITES_LIMIT} 条</div>
                    ) : null}
                    {canExpand ? (
                      <button
                        type="button"
                        className="hdu-search-group-more"
                        aria-expanded={isExpanded}
                        onClick={toggleExpand}
                      >
                        {isExpanded ? '收起' : `展开全部 ${group.total} 条`}
                      </button>
                    ) : null}
                  </div>
                );
              });
            })()
          )}
          {result && result.totalCount > 0 ? (
            <div className="hdu-search-foot">
              全部 {result.totalCount} 条 · 每组最多显示 {SEARCH_CAP_PER_SOURCE} 条
            </div>
          ) : null}
          {/* 键位帮助 hint 行（第 247 轮巡检，键盘域）：浮层底部一行 muted 小字，
              仅在有可导航 option 时出现（空态 / 加载 / 错误不放——此时键位无意义）；
              窄口 CSS ellipsis 截断（title 给全文兜底） */}
          {optionCount > 0 ? (
            <div className="hdu-search-keys-hint" title="↑↓ 选择 · Enter 打开 · Esc 关闭">
              ↑↓ 选择 · Enter 打开 · Esc 关闭
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 单条搜索结果：按跳转类型渲染为课次按钮 / 新标签外链 / 静态条目；combobox 语义下统一挂 option 角色。
 * id / active 由父级按扁平序号下发（方向键 aria-activedescendant + 高亮视觉态）；
 * onSessionJump 覆写课次跳转（缺省走 uiStore.actions.openSessionInSite，HDU 站内语义）。
 *
 * 第 256 轮（检索域 / 结果呈现视角）：
 *  - snippet 的【命中词】文本标注升级为视觉高亮：snippetToSegments 纯函数解析
 *    （仅与关键词逐字相等的【】段标为命中，原文自带【】不误标），命中段渲染
 *    <mark class="hdu-search-mark">——聚合器注释里的「命中词以【】标注」语义不变，
 *    呈现层从文本符号升级为视觉标记。
 * 第 257 轮（检索域 / 定位能力延续）：transcript 多段命中条目在 option 元素之后渲染
 *  「命中 N 段」展开开关 + 命中段时间列表（repo 聚合的 segments，字幕时间序）——
 *  行点击按跳转类型直达该段时间点（course 带 anchorSec seek / 站外 url 带 ?t=）。
 *  展开区在 option 元素之外（button 内不可嵌套交互元素，且不打乱扁平 option 序号）；
 *  仅 hitSegments 非空且可跳转时渲染，单段 / 无 jump 条目不渲染（防不可用交互）。
 */
function SearchItem({
  hit,
  kw,
  onDone,
  id,
  active,
  onSessionJump,
}: {
  hit: UnifiedHit;
  /** 当前搜索词（snippet 命中段解析用；与聚合器标注同源） */
  kw: string;
  onDone: () => void;
  id?: string;
  active?: boolean;
  onSessionJump?: (courId: number, teclId?: number, anchorSec?: number) => void;
}) {
  const actions = uiStore.actions;
  const jump = hit.jump;
  const itemClass = cx('hdu-search-item', active ? 'is-active' : '');
  const segments = snippetToSegments(hit.snippet, kw);
  // 命中段展开态（第 257 轮）：仅 transcript 多段命中条目可展开；
  // 第 258 轮：关键词变化（新一轮搜索结果不同）时收起——展开态不跨搜索残留
  const [hitsOpen, setHitsOpen] = useState(false);
  useEffect(() => {
    setHitsOpen(false);
  }, [kw]);
  const hitSegments = hit.kind === 'transcript' && jump ? (hit.hitSegments ?? []) : [];
  const canExpandHits = hitSegments.length > 1;
  const openSession = onSessionJump ?? ((courId: number, teclId?: number, anchorSec?: number) => {
    // 秒级直达（第 104 轮巡检）：course 命中带 anchorSec 时透传（同课次播放页直接 seek；
    // 跨页深链的 ?t= 由 B 站宿主覆写与内容脚本启动钩子处理）。无锚点维持两参调用。
    if (anchorSec != null && Number.isFinite(anchorSec)) actions.openSessionInSite(courId, teclId, { anchorSec });
    else actions.openSessionInSite(courId, teclId);
  });
  /** 命中段行点击：按跳转类型落到该段时间点（站内 seek / 站外 ?t= 新标签） */
  const jumpToSegment = (startSec: number) => {
    if (!jump) return;
    if (jump.type === 'course') {
      openSession(jump.courId, jump.teclId, startSec);
    } else {
      window.open(withTimeParam(jump.url, startSec), '_blank', 'noopener,noreferrer');
    }
    onDone();
  };
  const inner = (
    <>
      <span className={`hdu-search-badge ${hit.kind}`}>{UNIFIED_GROUP_LABELS[hit.kind]}</span>
      {/* 置顶徽标（第 287 轮）：置顶收藏在结果中标识（pinnedFirst 排序优先） */}
      {hit.pinned ? <span className="hdu-search-badge pinned">置顶</span> : null}
      <span className="hdu-search-item-main">
        {/* 标题命中词高亮（第 267 轮）：与摘要同款 markTextSegments——标题里含关键词
            （如课次名 / 收藏标题命中）时同样金色标出；无命中返回原文零开销 */}
        <span className="hdu-search-item-title">
          {markTextSegments(hit.title, kw).map((part, j) =>
            part.marked ? (
              <mark key={j} className="hdu-search-mark">
                {part.text}
              </mark>
            ) : (
              <span key={j}>{part.text}</span>
            ),
          )}
        </span>
        {hit.snippet ? (
          <span className="hdu-search-item-snippet">
            {segments.map((seg, i) =>
              seg.marked ? (
                <mark key={i} className="hdu-search-mark">
                  {seg.text}
                </mark>
              ) : (
                <span key={i}>{seg.text}</span>
              ),
            )}
          </span>
        ) : null}
      </span>
      <Icon name={jump?.type === 'url' ? 'external' : 'arrowRight'} size={12} />
    </>
  );
  let optionEl: ReactNode;
  if (!jump) {
    optionEl = <div id={id} className={cx(itemClass, 'is-static')} role="option" aria-selected={active}>{inner}</div>;
  } else if (jump.type === 'url') {
    optionEl = (
      <a
        id={id}
        className={itemClass}
        role="option"
        aria-selected={active}
        href={jump.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onDone}
      >
        {inner}
      </a>
    );
  } else {
    optionEl = (
      <button
        type="button"
        id={id}
        className={itemClass}
        role="option"
        aria-selected={active}
        onClick={() => {
          // 无锚点维持两参调用（既有断言/覆写签名兼容）；带锚点才透传第三参
          if (jump.anchorSec != null) openSession(jump.courId, jump.teclId, jump.anchorSec);
          else openSession(jump.courId, jump.teclId);
          onDone();
        }}
      >
        {inner}
      </button>
    );
  }
  return (
    <>
      {optionEl}
      {canExpandHits ? (
        <div className="hdu-search-hits-block">
          <button
            type="button"
            className="hdu-search-hits-toggle"
            aria-expanded={hitsOpen}
            onClick={() => setHitsOpen((prev) => !prev)}
          >
            命中 {hit.hitCount ?? hitSegments.length} 段
            <span className="hdu-search-hits-caret" aria-hidden="true">
              {hitsOpen ? '▴' : '▾'}
            </span>
          </button>
          {hitsOpen ? (
            <div className="hdu-search-hits">
              {hitSegments.map((seg, i) => (
                <button
                  key={`${seg.startSec}-${i}`}
                  type="button"
                  className="hdu-search-hit-row"
                  title={`跳到 ${formatClock(seg.startSec)}`}
                  onClick={() => jumpToSegment(seg.startSec)}
                >
                  <span className="hdu-search-hit-time">{formatClock(seg.startSec)}</span>
                  {/* 段内命中词二次高亮（第 258 轮）：markTextSegments 在原始段文本中
                      定位关键词全部出现（段文本不带 buildSnippet 的【】标注） */}
                  <span className="hdu-search-hit-text">
                    {markTextSegments(seg.text, kw).map((part, j) =>
                      part.marked ? (
                        <mark key={j} className="hdu-search-mark">
                          {part.text}
                        </mark>
                      ) : (
                        <span key={j}>{part.text}</span>
                      ),
                    )}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
