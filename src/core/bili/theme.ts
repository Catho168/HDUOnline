/**
 * B 站宿主深色主题判定（纯函数，供内容脚本与单元测试共用）。
 *
 * B 站官方深色模式由服务端参数驱动 :root 的 gauss 色板 CSS 变量（--bg1 等）整体变深，
 * 并写入 theme_style=dark cookie；不同页面版本还可能在 <html> 上挂 dark-mode/theme-dark
 * 类或 data-theme="dark" 属性。没有单一权威信号，这里按可信度依次检查多路信号，
 * 任一命中即视为深色：
 *  1) html 的 data-theme="dark" 属性 / dark-mode、theme-dark 类；
 *  2) cookie theme_style=dark（精确键值匹配）；
 *  3) CSS 变量探针：--bg1（页面主背景）实际渲染亮度 < 0.35（B 站深色下 --bg1 为深灰黑）。
 * 全部信号缺失/不可读时返回 false（亮色，即现状兜底）。
 */
export function isBiliHostDark(doc: Document): boolean {
  const html = doc.documentElement;
  if (html.dataset.theme === 'dark') return true;
  if (html.classList.contains('dark-mode') || html.classList.contains('theme-dark')) return true;
  try {
    const isDark = doc.cookie.split(';').some((kv) => kv.trim() === 'theme_style=dark');
    if (isDark) return true;
  } catch {
    /* cookie 不可读（如 document.cookie 被禁）时忽略 */
  }
  try {
    const raw = getComputedStyle(html).getPropertyValue('--bg1').trim();
    // 支持 #rgb / #rrggbb / rgb(r,g,b) 三种写法；解析失败按未命中处理
    const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    const rgb = raw.match(/^rgb\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)\s*\)$/i);
    const channels: [number, number, number] | null = hex
      ? (() => {
          const value = hex[1] ?? '';
          const full = value.length === 3 ? value.replace(/./g, (c) => c + c) : value;
          return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
        })()
      : rgb
        ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
        : null;
    if (channels) {
      const [r, g, b] = channels;
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return luminance < 0.35;
    }
  } catch {
    /* getComputedStyle 不可用时忽略 */
  }
  return false;
}
