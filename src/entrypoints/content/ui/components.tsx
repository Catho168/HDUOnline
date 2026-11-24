import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { Icon, type IconName } from './icons';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ───────────────────────── 按钮 ─────────────────────────

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'accent' | 'ghost' | 'danger';
  size?: 'default' | 'small' | 'icon';
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
}

export function Button({
  variant = 'default',
  size = 'default',
  icon,
  iconRight,
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cx('hdu-btn', variant, size === 'small' ? 'small' : '', size === 'icon' ? 'icon' : '', className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <span className="hdu-spinner" /> : icon ? <Icon name={icon} /> : null}
      {children}
      {iconRight ? <Icon name={iconRight} /> : null}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  className,
  ...rest
}: { icon: IconName; label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={cx('hdu-icon-btn', className)} aria-label={label} title={label} {...rest}>
      <Icon name={icon} />
    </button>
  );
}

// ───────────────────────── 两步确认 ─────────────────────────

/**
 * 两步确认 hook（dashboard / options 入口危险操作两步化的通用行为，
 * 对齐 LearningCenter 内联模式）：
 *  - 第一次点击 `step()` 返回 false 并进入确认态（按钮加 is-confirm 警示样式、
 *    文案切换由调用方负责），3 秒无操作自动复原；
 *  - 第二次点击 `step()` 返回 true（状态已复位），调用方此时才真正执行；
 *  - 关闭弹窗 / 执行成功等场景可手动 `reset()` 复位，卸载时自动清定时器。
 */
export function useTwoStepConfirm(): { confirming: boolean; arm: () => void; step: () => boolean; reset: () => void } {
  const [confirming, setConfirming] = useState(false);
  // 「再点一次确认」的 3 秒复原定时器；复位与卸载时都要清（照 LearningCenter 的既有清理方式）
  const timerRef = useRef<number | null>(null);

  const reset = useCallback(() => {
    setConfirming(false);
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => reset, [reset]);

  const arm = useCallback(() => {
    reset();
    setConfirming(true);
    timerRef.current = window.setTimeout(() => setConfirming(false), 3000);
  }, [reset]);

  const step = useCallback((): boolean => {
    if (!confirming) {
      arm();
      return false;
    }
    reset();
    return true;
  }, [confirming, arm, reset]);

  return { confirming, arm, step, reset };
}

/** `useTwoStepConfirm` + Button 的组合：文案随确认态切换，第二次点击才触发 onConfirm */
export function ConfirmButton({
  confirmLabel,
  onConfirm,
  children,
  ...rest
}: Omit<ButtonProps, 'onClick'> & { confirmLabel: string; onConfirm: () => void | Promise<void> }) {
  const { confirming, step } = useTwoStepConfirm();
  return (
    <Button
      {...rest}
      className={cx(rest.className, confirming ? 'is-confirm' : '')}
      onClick={() => {
        if (step()) void onConfirm();
      }}
    >
      {confirming ? confirmLabel : children}
    </Button>
  );
}

/** `useTwoStepConfirm` + IconButton 的组合：确认态下图标变警示配色、title/aria-label 切为确认文案 */
export function ConfirmIconButton({
  icon,
  label,
  confirmLabel,
  onConfirm,
  ...rest
}: {
  icon: IconName;
  /** 默认（未进入确认态）的 title/aria-label */
  label: string;
  /** 确认态下切换为的确认文案 */
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>) {
  const { confirming, step } = useTwoStepConfirm();
  return (
    <IconButton
      {...rest}
      icon={icon}
      label={confirming ? confirmLabel : label}
      className={cx(rest.className, confirming ? 'is-confirm' : '')}
      onClick={() => {
        if (step()) void onConfirm();
      }}
    />
  );
}

// ───────────────────────── 基础展示 ─────────────────────────

export function Chip({
  tone = 'default',
  icon,
  children,
  className,
  title,
}: {
  tone?: 'default' | 'accent' | 'jade' | 'danger' | 'info';
  icon?: IconName;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span className={cx('hdu-chip', tone !== 'default' ? tone : '', className)} title={title}>
      {icon ? <Icon name={icon} /> : null}
      {children}
    </span>
  );
}

export function Progress({ value, jade = false, className }: { value: number; jade?: boolean; className?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div className={cx('hdu-progress', jade ? 'jade' : '', className)} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * 环形进度。
 *  - variant：'hero'（默认）用于 hero 深底（track 为 paper-2 16% 混合），
 *    'card' 用于浅底卡片（track 按 ink 10% 混合，明暗主题都可见，见 styles.ts）；
 *  - labelSize：label 字号；缺省时按环径缩放（size≤48 用 11px，避免 40px 环里「100%」顶满，
 *    hero 76px 环仍走样式表默认 16px）。
 */
export function Ring({
  value,
  size = 76,
  label,
  variant = 'hero',
  title,
  labelSize,
}: {
  value: number;
  size?: number;
  label?: string;
  variant?: 'hero' | 'card';
  title?: string;
  labelSize?: number;
}) {
  const stroke = 5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const resolvedLabelSize = labelSize ?? (size <= 48 ? 11 : undefined);
  return (
    <div className={cx('hdu-ring', variant === 'card' ? 'card' : '')} style={{ width: size, height: size }} title={title}>
      <svg width={size} height={size}>
        <circle className="hdu-ring-track" cx={size / 2} cy={size / 2} r={radius} />
        <circle
          className="hdu-ring-fill"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct)}
        />
      </svg>
      <span className="hdu-ring-label" style={resolvedLabelSize != null ? { fontSize: resolvedLabelSize } : undefined}>
        {label ?? `${Math.round(pct * 100)}%`}
      </span>
    </div>
  );
}

export function SectionHead({
  title,
  sub,
  actions,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="hdu-section-head">
      <div className="hdu-section-title">{title}</div>
      {sub ? <div className="hdu-section-sub">{sub}</div> : null}
      {actions ? <div className="hdu-section-actions">{actions}</div> : null}
    </div>
  );
}

export function StatCard({
  icon,
  label,
  value,
  unit,
  foot,
}: {
  icon: IconName;
  label: string;
  value: ReactNode;
  unit?: string;
  foot?: ReactNode;
}) {
  return (
    <div className="hdu-stat">
      <div className="hdu-stat-top">
        <Icon name={icon} />
        {label}
      </div>
      <div className="hdu-stat-value">
        {value}
        {unit ? <small>{unit}</small> : null}
      </div>
      {foot ? <div className="hdu-stat-foot">{foot}</div> : null}
    </div>
  );
}

/**
 * 空态组件分工（第 193 轮巡检文档化；第 249 轮补文案模板契约）：
 * - EmptyState：通用「无数据」空态（icon=图标库名、title=主标题、text=补充说明、
 *   action=可选操作），用于列表/报表等无内容场景；
 * - EmptyIllustration：面板内「说明卡式」空态（icon=emoji、hint=机制说明、action=操作钮），
 *   用于回收站/标签统计等需要引导操作的空态。
 * 两者不互相替代：EmptyState 面向「没有数据可展示」，EmptyIllustration 面向「解释规则 + 引导操作」。
 *
 * 文案模板契约（第 249 轮空态审计，全仓按此归位）：
 *  - 引导型：title（短名词短语，说清缺什么、不带句号）+ text（一句现状 + 下一步，
 *    句号结尾）+ action（站内有明确动作才给；按钮统一 size="small" variant="ghost"）；
 *  - 告知型：title + text，无 action（无动作可做、或状态本身是好消息）；
 *  - emoji 规则：EmptyState 的 title/text 不夹 emoji（视觉锚由 icon 承担；emoji 只出现在
 *    EmptyIllustration 的 icon 牌与专门的庆祝元素如 .hdu-celebrate-emoji）。
 * action 渲染在 .hdu-empty-action 容器内（样式表统一与 text 的垂直间距）。
 */

export function EmptyState({
  icon,
  title,
  text,
  action,
}: {
  icon: IconName;
  title: string;
  text?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="hdu-empty">
      <div className="hdu-empty-mark">
        <Icon name={icon} />
      </div>
      <div className="hdu-empty-title">{title}</div>
      {text ? <div className="hdu-empty-text">{text}</div> : null}
      {action ? <div className="hdu-empty-action">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ height = 14, width = '100%', style }: { height?: number; width?: number | string; style?: CSSProperties }) {
  return <div className="hdu-skeleton" style={{ height, width, ...style }} />;
}

/**
 * 统一骨架行组（第 253 轮，视图域 / 反馈一致性视角）：标题 60% / 内容 90% / 尾行 40%
 * 的宽度阶梯（默认），给「异步视图缺加载态」的落点一处标准件——阶梯宽度模拟真实
 * 内容的文本层次（标题短、正文长、尾注更短），避免整列等宽骨架的呆板观感；
 * shimmer 动画与 prefers-reduced-motion 兜底由 .hdu-skeleton 基类（UI_CSS）整组继承。
 * 调用方可用 widths/height/gap 覆写；跳版控制由调用方保证（骨架块高度 ≈ 真实内容块）。
 */
export function SkeletonRows({
  widths = ['60%', '90%', '40%'],
  height = 14,
  gap = 10,
  style,
}: {
  widths?: Array<number | string>;
  height?: number;
  gap?: number;
  style?: CSSProperties;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap, ...style }} aria-hidden="true">
      {widths.map((w, i) => (
        <Skeleton key={i} height={height} width={w} />
      ))}
    </div>
  );
}

export function Spinner({ size = 15 }: { size?: number }) {
  return <span className="hdu-spinner" style={{ width: size, height: size }} />;
}

// ───────────────────────── 图表 ─────────────────────────

export function BarChart({
  data,
  height = 132,
}: {
  data: Array<{ label: string; value: number; today?: boolean }>;
  height?: number;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="hdu-bars" style={{ height }} role="img" aria-label="每日学习时长柱状图">
      {data.map((d, i) => (
        <div key={`${d.label}-${i}`} className={cx('hdu-bar-col', d.today ? 'today' : '')} title={`${d.label} · ${Math.round(d.value / 60)} 分钟`}>
          <div className="hdu-bar-track">
            <div className="hdu-bar-fill" style={{ height: `${Math.max(d.value > 0 ? 4 : 0, (d.value / max) * 100)}%` }} />
          </div>
          <span className="hdu-bar-label">{d.label}</span>
        </div>
      ))}
    </div>
  );
}

// ───────────────────────── 表单 ─────────────────────────

export function Field({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="hdu-field">
      <label>{label}</label>
      {children}
      {hint ? <div className="hdu-hint">{hint}</div> : null}
    </div>
  );
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx('hdu-input', className)} {...rest} />;
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx('hdu-textarea', className)} {...rest} />;
}

export function PillTabs<T extends string>({
  value,
  items,
  onChange,
}: {
  value: T;
  items: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  // 方向键导航（第 278 轮，可访问性域）：tablist 语义下键盘用户按 ←/→/Home/End
  // 切换页签（WAI-ARIA 惯例）——onChange 切内容 + 焦点跟随到目标页签；
  // roving tabindex：仅激活页签可 Tab，其余 -1（焦点圈闭选择器同步受益）
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const index = items.findIndex((item) => item.value === value);
    let next = index;
    if (event.key === 'ArrowRight') next = Math.min(items.length - 1, index + 1);
    else if (event.key === 'ArrowLeft') next = Math.max(0, index - 1);
    else if (event.key === 'Home') next = 0;
    else next = items.length - 1;
    event.preventDefault();
    const target = items[next];
    if (next !== index && target) onChange(target.value);
    requestAnimationFrame(() => tabRefs.current[next]?.focus());
  };
  return (
    <div className="hdu-pill-tabs" role="tablist" onKeyDown={onKeyDown}>
      {items.map((item, i) => (
        <button
          key={item.value}
          ref={(el) => {
            tabRefs.current[i] = el;
          }}
          type="button"
          role="tab"
          tabIndex={item.value === value ? 0 : -1}
          aria-selected={item.value === value}
          className={cx('hdu-pill-tab', item.value === value ? 'is-active' : '')}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

// ───────────────────────── 弹窗 ─────────────────────────

/**
 * 顶层 Escape 归属层句柄：栈顶浮层对 Esc 的响应（通常为关闭自身）。
 * 返回 false 预留「放弃消费」能力（当前所有实现均消费，返回 void）。
 */
export interface EscapeLayerHandle {
  onEscape(): boolean | void;
  /**
   * 栈顶期间的 Tab 圈闭（第 39 轮巡检）：返回本浮层的圈闭容器，Tab 键由共享
   * 监听器转交 trapTab 在容器内首尾循环；缺省或返回 null = 本浮层不参与圈闭。
   */
  trapContainer?(): HTMLElement | null;
}

interface EscapeLayer {
  token: symbol;
  handle: EscapeLayerHandle;
}

/** 注册句柄：注销自身（关闭或卸载时调用一次） */
export interface EscapeLayerRegistration {
  /** 从归属栈注销（关闭 / 卸载时调用） */
  dispose(): void;
}

/**
 * 已打开「顶层 Escape 归属层」的模块级栈（按打开顺序，存注册令牌）：Modal 弹窗与
 * 字幕浮层（BiliSubtitlePanel 宿主化实例，非 Modal 组件）等全屏浮层统一登记于此。
 * 嵌套/平级多浮层并存时（如学习中心面板上再开编辑收藏弹层、面板内再开字幕浮层），
 * Escape / Tab 只作用于最后打开的栈顶浮层——按 Esc 只关最上层，不连带关闭外层
 * 面板（第 33 轮巡检 P2 收口；第 37 轮巡检把 Modal 专属打开栈抽成通用注册器，
 * 字幕浮层同体系接入）。栈随 effect 挂载/清理维护；单浮层场景栈长为 1，行为与
 * 既有单弹窗实现完全一致。
 *
 * 派发说明（第 39 轮巡检）：Escape / Tab 由下方**共享的单例 window capture 监听器**
 * 统一派发——触发时实时查栈顶调 `handle.onEscape()`、Tab 转交 `trapContainer()`
 * 圈闭。消费方只提供回调、不再各自挂 keydown 判栈顶（消除「每层自挂监听」的重复
 * 模板；onEscape 也从只注册不调用的预留死 API 变为真实派发契约）。
 */
const escapeLayerStack: EscapeLayer[] = [];

/** Esc / Tab 统一派发：只作用于栈顶浮层（非栈顶浮层不感知，见栈注释） */
function dispatchEscapeLayerKey(event: KeyboardEvent): void {
  const top = escapeLayerStack[escapeLayerStack.length - 1];
  if (!top) return;
  if (event.key === 'Escape') {
    // 栈顶消费 Esc：拦下不传给宿主页面，也不穿透关闭外层浮层
    event.stopPropagation();
    top.handle.onEscape();
    return;
  }
  if (event.key === 'Tab') {
    const container = top.handle.trapContainer?.();
    if (container) trapTab(event, container);
  }
}

/** 共享监听器随首个浮层注册挂上、栈清空后摘除（懒绑定，模块导入期不触碰 window） */
let escapeKeyListenerBound = false;

function bindEscapeKeyListener(): void {
  if (escapeKeyListenerBound) return;
  escapeKeyListenerBound = true;
  window.addEventListener('keydown', dispatchEscapeLayerKey, true);
}

function unbindEscapeKeyListenerWhenIdle(): void {
  if (!escapeKeyListenerBound || escapeLayerStack.length > 0) return;
  escapeKeyListenerBound = false;
  window.removeEventListener('keydown', dispatchEscapeLayerKey, true);
}

/**
 * 注册一个顶层 Escape 归属层（浮层打开期间挂载、关闭/卸载时注销）。
 * Modal 与字幕浮层等宿主化浮层共用同一归属栈与同一 window 监听器：按 Esc 只关
 * 栈顶浮层，Tab 只在栈顶浮层内圈闭。
 */
export function registerEscapeLayer(handle: EscapeLayerHandle): EscapeLayerRegistration {
  const token = Symbol('hdu-escape-layer');
  escapeLayerStack.push({ token, handle });
  bindEscapeKeyListener();
  return {
    dispose: () => {
      const at = escapeLayerStack.findIndex((layer) => layer.token === token);
      if (at >= 0) escapeLayerStack.splice(at, 1);
      unbindEscapeKeyListenerWhenIdle();
    },
  };
}

/** 空态插画三段式（第 191 轮巡检）：图标牌 + 说明 + 可选操作，回收站/标签统计空态统一复用 */
export function EmptyIllustration({
  icon,
  hint,
  action,
}: {
  icon: string;
  hint: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '14px 8px' }}>
      <span
        aria-hidden
        style={{
          width: 44,
          height: 44,
          display: 'grid',
          placeItems: 'center',
          fontSize: 22,
          borderRadius: 12,
          border: '1px dashed var(--line-strong)',
          background: 'var(--paper-2)',
        }}
      >
        {icon}
      </span>
      <span className="hdu-hint" style={{ textAlign: 'center' }}>
        {hint}
      </span>
      {action}
    </div>
  );
}

/**
 * 可关闭浮层的统一 dismiss hook（第 177 轮巡检）：合并「Esc 归属层」与「点击外部关闭」
 * 两套监听——open 时注册 Esc 层 + 挂 document 点击监听（点击 ignoreSelector 元素之外
 * 自动 onClose），关闭/卸载时统一清理。onClose 经 ref 保持稳定，不依赖调用方 useCallback。
 */
export function useDismissable(
  open: boolean,
  onClose: () => void,
  options?: { ignoreSelector?: string; trapContainer?: () => HTMLElement | null },
): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const ignoreSelector = options?.ignoreSelector;
  const trapContainer = options?.trapContainer;
  useEffect(() => {
    if (!open) return;
    const layer = registerEscapeLayer({
      onEscape: () => onCloseRef.current(),
      ...(trapContainer ? { trapContainer } : {}),
    });
    const onDocClick = (event: MouseEvent): void => {
      const target = event.target as Element | null;
      if (!ignoreSelector || !target?.closest(ignoreSelector)) onCloseRef.current();
    };
    document.addEventListener('click', onDocClick);
    return () => {
      layer.dispose();
      document.removeEventListener('click', onDocClick);
    };
  }, [open, ignoreSelector, trapContainer]);
}

/**
 * 仅 Esc 关闭的轻量 hook（第 207 轮巡检）：active 时注册 Esc 归属层（无外点关闭/Tab 圈闭），
 * 按 Esc 触发 onEscape。用于说明卡等「只响应键盘 Esc」的浮层。
 */
export function useEscapeClose(active: boolean, onEscape: () => void): void {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const layer = registerEscapeLayer({ onEscape: () => onEscapeRef.current() });
    return () => layer.dispose();
  }, [active]);
}

/** 穿透 shadow 边界取当前焦点：内容脚本 UI 挂在 shadow root 里，document.activeElement 只会返回宿主元素 */
export function deepActiveElement(): Element | null {
  let node = document.activeElement;
  while (node instanceof HTMLElement && node.shadowRoot) {
    const inner: Element | null = node.shadowRoot.activeElement;
    if (!inner || inner === node) break;
    node = inner;
  }
  return node;
}

/**
 * Tab 圈闭：焦点在弹窗内首尾循环；焦点意外落在弹窗外（或停在容器自身）时拉回弹窗。
 * 只查可聚焦元素与 disabled，不做布局可见性过滤（无渲染 hidden 子节点的场景够用）。
 */
function trapTab(event: KeyboardEvent, container: HTMLElement | null): void {
  if (!container) return;
  const items = Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) {
    event.preventDefault();
    return;
  }
  const active = deepActiveElement();
  const inside = active instanceof HTMLElement && active !== container && container.contains(active);
  if (!inside) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  }
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const lastFocus = useRef<Element | null>(null);
  // 调用方传入的 onClose 往往是每次渲染新建的闭包：经 ref 引用，
  // 焦点副作用只依赖 open，避免 store 变化重渲染时反复重跑（焦点被拽出弹窗）。
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    lastFocus.current = deepActiveElement();
    // 焦点移入弹窗容器（tabIndex=-1）：屏幕阅读器依 aria-labelledby 播报窗体标题
    dialogRef.current?.focus();
    // 登记顶层 Escape/Tab 归属栈：多弹窗/浮层并存时仅栈顶（最后打开）响应——
    // Esc 关闭自身、Tab 在弹窗内圈闭，均由共享 window 监听器统一派发
    // （见 registerEscapeLayer，第 39 轮巡检起不再自挂 keydown 判栈顶）
    const layer = registerEscapeLayer({
      onEscape: () => onCloseRef.current(),
      trapContainer: () => dialogRef.current,
    });
    return () => {
      layer.dispose();
      // 仅在关闭/卸载时执行一次：把焦点还给打开弹窗前的元素
      (lastFocus.current as HTMLElement | null)?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="hdu-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCloseRef.current(); }}>
      <div
        className="hdu-modal"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={width ? { width } : undefined}
      >
        <div className="hdu-modal-head">
          <div className="hdu-modal-title" id={titleId}>{title}</div>
          <div style={{ marginLeft: 'auto' }}>
            <IconButton icon="close" label="关闭" onClick={onClose} />
          </div>
        </div>
        <div className="hdu-modal-body hdu-scroll">{children}</div>
        {footer ? <div className="hdu-modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

// ───────────────────────── Toast ─────────────────────────

export type ToastLevel = 'info' | 'success' | 'warn' | 'error';
interface ToastItem {
  id: number;
  message: string;
  level: ToastLevel;
  /** 可选操作（第 227 轮巡检）：如「撤销」——渲染为 toast 内按钮，点击即执行并收起 */
  action?: { label: string; run: () => Promise<void> | void };
}

/**
 * Toast 时长分级（第 249 轮巡检）：按类型给默认停留时长，兼顾可读与防打扰——
 *  - error 5s：错误需要读清楚原因（原全类型统一 3.6s，错误偏短）；
 *  - warn 4s：需要留意但不致命；
 *  - success 3s：确认类反馈，读完即走；
 *  - info 2.5s：轻提示，最短。
 * 显式传 ttl 仍可覆盖（第 245 轮「排到」toast 8s 先例保持兼容）。
 */
export const TOAST_TTL_MS: Record<ToastLevel, number> = {
  info: 2500,
  success: 3000,
  warn: 4000,
  error: 5000,
};

/** 带 action 的 toast（如「撤销」）的保底停留时长（第 227 轮 6s，第 249 轮提到 8s 给足反应窗口） */
export const TOAST_TTL_WITH_ACTION_MS = 8000;

/** 同屏 toast 栈上限：超过则最旧先出（第 249 轮显式化；原实现 slice(-3)+1 实际容 4 条，统一为 3） */
export const TOAST_STACK_MAX = 3;

/**
 * 时长解析（纯函数）：显式 ttl 优先；未传时按 level 取 TOAST_TTL_MS 分级默认值；
 * 带 action 时保底 TOAST_TTL_WITH_ACTION_MS（取两者较大值，显式更长的 ttl 不被压缩）。
 */
export function resolveToastTtl(level: ToastLevel, ttl?: number, hasAction = false): number {
  const base = ttl ?? TOAST_TTL_MS[level];
  return hasAction ? Math.max(base, TOAST_TTL_WITH_ACTION_MS) : base;
}

/** 栈入列（纯函数）：新条目追加到末尾（渲染时位于栈底），超出 TOAST_STACK_MAX 从最旧端裁剪 */
export function pushToastToList(list: ToastItem[], item: ToastItem, max = TOAST_STACK_MAX): ToastItem[] {
  return [...list, item].slice(-max);
}

let toastSeq = 0;
let toastList: ToastItem[] = [];
const toastListeners = new Set<() => void>();

function emitToasts(): void {
  for (const listener of toastListeners) listener();
}

export function pushToast(
  message: string,
  level: ToastLevel = 'info',
  ttl?: number,
  action?: { label: string; run: () => Promise<void> | void },
): void {
  const id = ++toastSeq;
  const effectiveTtl = resolveToastTtl(level, ttl, action != null);
  toastList = pushToastToList(toastList, { id, message, level, action });
  emitToasts();
  window.setTimeout(() => {
    toastList = toastList.filter((t) => t.id !== id);
    emitToasts();
  }, effectiveTtl);
}

function subscribeToasts(cb: () => void): () => void {
  toastListeners.add(cb);
  return () => toastListeners.delete(cb);
}

export function ToastHost() {
  const toasts = useSyncExternalStore(subscribeToasts, () => toastList);
  const dismiss = useCallback((id: number) => {
    toastList = toastList.filter((t) => t.id !== id);
    emitToasts();
  }, []);
  if (toasts.length === 0) return null;
  return (
    <div className="hdu-toast-stack" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx('hdu-toast', t.level === 'error' ? 'error' : '')} onClick={() => dismiss(t.id)}>
          <span className="hdu-toast-icon">
            <Icon name={t.level === 'error' ? 'alert' : t.level === 'warn' ? 'alert' : t.level === 'success' ? 'check' : 'info'} />
          </span>
          <span>{t.message}</span>
          {/* toast 内联操作（第 227 轮巡检）：如批量删除后的「撤销」，点击即执行并收起 */}
          {t.action ? (
            <button
              type="button"
              className="hdu-folder"
              style={{ flex: 'none', marginLeft: 6 }}
              onClick={(e) => {
                e.stopPropagation();
                dismiss(t.id);
                void t.action?.run();
              }}
            >
              {t.action.label}
            </button>
          ) : null}
          {/* error 专用关闭钮（第 249 轮巡检）：错误停留最长（5s），给显式收起入口；
              整条 toast 本就可点击关闭（hit area 全条），此钮只是让「关掉它」意图更明确 */}
          {t.level === 'error' ? (
            <button
              type="button"
              className="hdu-toast-close"
              aria-label="关闭提示"
              title="关闭提示"
              onClick={(e) => {
                e.stopPropagation();
                dismiss(t.id);
              }}
            >
              <Icon name="close" size={11} />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
