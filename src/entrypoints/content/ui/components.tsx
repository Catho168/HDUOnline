import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { Icon, type IconName } from './icons';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ───────────────────────── 按钮 ─────────────────────────

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'accent' | 'ghost';
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

export function Ring({ value, size = 76, label }: { value: number; size?: number; label?: string }) {
  const stroke = 5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <div className="hdu-ring" style={{ width: size, height: size }}>
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
      <span className="hdu-ring-label">{label ?? `${Math.round(pct * 100)}%`}</span>
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
      {action}
    </div>
  );
}

export function Skeleton({ height = 14, width = '100%', style }: { height?: number; width?: number | string; style?: CSSProperties }) {
  return <div className="hdu-skeleton" style={{ height, width, ...style }} />;
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
  return (
    <div className="hdu-pill-tabs" role="tablist">
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
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
  const lastFocus = useRef<Element | null>(null);
  useEffect(() => {
    if (!open) return;
    lastFocus.current = document.activeElement;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      (lastFocus.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="hdu-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="hdu-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} style={width ? { width } : undefined}>
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

type ToastLevel = 'info' | 'success' | 'warn' | 'error';
interface ToastItem {
  id: number;
  message: string;
  level: ToastLevel;
}

let toastSeq = 0;
let toastList: ToastItem[] = [];
const toastListeners = new Set<() => void>();

function emitToasts(): void {
  for (const listener of toastListeners) listener();
}

export function pushToast(message: string, level: ToastLevel = 'info', ttl = 3600): void {
  const id = ++toastSeq;
  toastList = [...toastList.slice(-3), { id, message, level }];
  emitToasts();
  window.setTimeout(() => {
    toastList = toastList.filter((t) => t.id !== id);
    emitToasts();
  }, ttl);
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
        </div>
      ))}
    </div>
  );
}
