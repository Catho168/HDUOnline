/**
 * 主题解析 Hook（Dashboard / Options / Popup 共用，第 24 轮审计复制漂移收口）。
 *
 * 口径：显式 `settings.theme` 优先；未设置（'system'）时跟随系统
 * `prefers-color-scheme`，并实时监听系统主题变化。
 */
import { useEffect, useState } from 'react';
import { resolvePanelTheme } from './hostTheme';
import type { AppSettings } from './types';

export function useResolvedTheme(settings: AppSettings | null): 'light' | 'dark' {
  const [dark, setDark] = useState(() => {
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  // 决策链收口到 resolvePanelTheme 纯函数（第 253 轮主题适配审计；行为不变：
  // 显式设置优先，'system' 回落系统偏好——与 B 站侧同一定式）
  return resolvePanelTheme(settings?.theme, dark ? 'dark' : 'light');
}
