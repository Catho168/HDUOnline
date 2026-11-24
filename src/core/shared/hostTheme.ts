/**
 * 站点宿主深浅模式判定（纯函数，供 HDU 注入入口与单元测试共用）。
 *
 * 智慧课堂站点没有公开的主题协议（KMedia SDK 动态重建，盲写选择器会漂移），这里按
 * 可信度依次采样多路信号，任一命中即判深色：
 *  1) html / body 的 data-theme 属性值或 class 名中含 "dark" 字样（站点显式声明）；
 *  2) documentElement → body 的 computed background-color 实际渲染亮度 < 0.35
 *    （页面整体深底；外层透明时继续向内层看，先命中者生效）。
 * 全部信号缺失/不可读时返回 'light'（现状兜底，行为安全——采样不到深色信号就保持亮色）。
 */
export type HostTheme = 'light' | 'dark';

/** 亮度阈值：与 B 站侧 core/bili/theme.ts 的深底判定同口径（0.35 以下视为深色） */
const DARK_LUMINANCE_THRESHOLD = 0.35;

/**
 * 解析 CSS 颜色字符串为 RGB 通道。
 * 支持 #rgb / #rrggbb / rgb(r,g,b) / rgba(r,g,b,a)（含空格或斜杠分隔的新语法）；
 * 透明色（alpha=0 或 transparent）与不可解析的写法返回 null，由调用方看下一路信号。
 */
export function parseColorChannels(raw: string): [number, number, number] | null {
  const value = raw.trim().toLowerCase();
  if (!value || value === 'transparent' || value === 'none') return null;
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    const body = hex[1] ?? '';
    const full = body.length === 3 ? body.replace(/./g, (c) => c + c) : body;
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
  }
  const rgb = value.match(/^rgba?\(\s*(\d+)\s*[,\s/]+\s*(\d+)\s*[,\s/]+\s*(\d+)(?:\s*[,\s/]+\s*([\d.]+))?\s*\)$/);
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]);
    if (alpha === 0) return null;
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }
  return null;
}

/** Rec.601 加权亮度（0~1），与 B 站侧判定口径一致 */
export function colorLuminance(channels: [number, number, number]): number {
  const [r, g, b] = channels;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** 显式深色信号：data-theme 属性值或 class 名中含 "dark" 字样 */
function hasExplicitDarkSignal(el: Element | null): boolean {
  if (!el) return false;
  try {
    const themeAttr = (el.getAttribute('data-theme') ?? '').toLowerCase();
    if (themeAttr.includes('dark')) return true;
    const classes = (el.getAttribute('class') ?? '').toLowerCase();
    return classes.split(/\s+/).some((cls) => cls.includes('dark'));
  } catch {
    return false;
  }
}

export function resolveHostTheme(doc: Document): HostTheme {
  // 1) 站点显式声明优先（属性/类名含 dark 字样）
  try {
    const html = doc.documentElement;
    if (hasExplicitDarkSignal(html) || hasExplicitDarkSignal(doc.body)) return 'dark';
  } catch {
    /* 属性/类名不可读时继续走背景色采样 */
  }
  // 2) 渲染背景亮度：外层（html）透明时看内层（body），先命中不透明背景者生效
  try {
    const targets = [doc.documentElement, doc.body];
    for (const el of targets) {
      if (!el) continue;
      const channels = parseColorChannels(doc.defaultView?.getComputedStyle(el).backgroundColor ?? '');
      if (!channels) continue;
      return colorLuminance(channels) < DARK_LUMINANCE_THRESHOLD ? 'dark' : 'light';
    }
  } catch {
    /* getComputedStyle 不可用时保持亮色兜底 */
  }
  return 'light';
}

/**
 * 注入面板主题决策纯函数（第 253 轮，站点主题适配域 / 主题跟随核对收口）。
 *
 * 决策优先级（审计后统一定式，机制图见 docs/巡检日志.md 第 253 轮）：
 *  1. settings.theme 显式 'light' / 'dark' → 直接采用（用户手动覆盖，最高优先）；
 *  2. 'system' / 未设置 → 交给调用方给的 fallback：
 *     - HDU 注入面板（App.tsx/useResolvedTheme）：系统 prefers-color-scheme
 *       （HDU 站点无暗色模式，跟随 OS 语义即设置页「跟随系统」文案承诺）；
 *     - B 站浮层（BiliCollectApp）：宿主深色探测 isBiliHostDark（B 站有完整
 *       暗色模式，跟随站点语境，机制不变）。
 * 旧行为完全保持（两处此前各自内联同型三元式，本轮收口为同一实现防漂移）。
 */
export function resolvePanelTheme(setting: 'system' | 'light' | 'dark' | undefined, fallback: HostTheme): HostTheme {
  if (setting === 'dark') return 'dark';
  if (setting === 'light') return 'light';
  return fallback;
}
