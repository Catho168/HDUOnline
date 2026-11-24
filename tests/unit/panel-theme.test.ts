/**
 * 注入面板主题决策纯函数测试（第 253 轮，站点主题适配域 / 主题跟随核对）。
 *
 * resolvePanelTheme 优先级链（机制图见 docs/巡检日志.md 第 253 轮）：
 *  1. settings.theme 显式 'light' / 'dark' → 直接采用（用户手动覆盖，最高优先）；
 *  2. 'system' / 未设置（undefined，设置未加载完成）→ 调用方 fallback：
 *     HDU 注入面板传系统 prefers-color-scheme、B 站浮层传宿主深色探测
 *     （isBiliHostDark）。消费方：useResolvedTheme（HDU 三页 + 面板内嵌）、
 *     BiliCollectApp（B 站全浮层经 .bili-root[data-theme] 祖先跟随）。
 */

import { describe, expect, it } from 'vitest';

import { resolvePanelTheme } from '@/core/shared/hostTheme';

describe('resolvePanelTheme（面板主题决策优先级链，第 253 轮）', () => {
  it("显式 'dark' 覆盖一切 fallback（用户手动深色）", () => {
    expect(resolvePanelTheme('dark', 'light')).toBe('dark');
    expect(resolvePanelTheme('dark', 'dark')).toBe('dark');
  });

  it("显式 'light' 覆盖一切 fallback（用户手动浅色，B 站暗色站下面板仍保持浅色）", () => {
    expect(resolvePanelTheme('light', 'dark')).toBe('light');
    expect(resolvePanelTheme('light', 'light')).toBe('light');
  });

  it("'system' → fallback（HDU=系统偏好 / B 站=宿主探测，既有行为不变）", () => {
    expect(resolvePanelTheme('system', 'dark')).toBe('dark');
    expect(resolvePanelTheme('system', 'light')).toBe('light');
  });

  it('未设置（undefined，settings 未加载完成 / 旧快照）→ fallback，不闪错', () => {
    expect(resolvePanelTheme(undefined, 'dark')).toBe('dark');
    expect(resolvePanelTheme(undefined, 'light')).toBe('light');
  });
});
