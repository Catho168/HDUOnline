/**
 * 站点宿主深浅模式判定纯函数测试（resolveHostTheme / parseColorChannels / colorLuminance）。
 *
 * 口径（与实现注释一致）：
 *  - 显式深色信号优先：html/body 的 data-theme 属性值或 class 名含 "dark" 字样 → dark；
 *  - 否则按渲染背景亮度：html → body 依次取 computed background-color，外层透明看内层，
 *    先命中不透明背景者生效，亮度 < 0.35 → dark；
 *  - 全部信号缺失/不可读 → light（安全兜底，采样不到深色信号就保持亮色）。
 */

// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import { colorLuminance, parseColorChannels, resolveHostTheme } from '@/core/shared/hostTheme';

describe('parseColorChannels（CSS 颜色解析）', () => {
  it('解析 #rgb / #rrggbb / rgb() / rgba()（含空格与斜杠分隔的新语法）', () => {
    expect(parseColorChannels('#fff')).toEqual([255, 255, 255]);
    expect(parseColorChannels('#1a1d21')).toEqual([26, 29, 33]);
    expect(parseColorChannels('rgb(20, 22, 26)')).toEqual([20, 22, 26]);
    expect(parseColorChannels('rgba(20, 22, 26, 0.5)')).toEqual([20, 22, 26]);
    expect(parseColorChannels('rgb(20 22 26 / 0.5)')).toEqual([20, 22, 26]);
  });

  it('透明色与不可解析输入返回 null（由调用方看下一路信号）', () => {
    expect(parseColorChannels('rgba(0, 0, 0, 0)')).toBeNull();
    expect(parseColorChannels('transparent')).toBeNull();
    expect(parseColorChannels('none')).toBeNull();
    expect(parseColorChannels('')).toBeNull();
    expect(parseColorChannels('   ')).toBeNull();
    expect(parseColorChannels('not-a-color')).toBeNull();
    expect(parseColorChannels('#12345')).toBeNull();
  });
});

describe('colorLuminance（Rec.601 加权亮度）', () => {
  it('黑为 0、白为 1', () => {
    expect(colorLuminance([0, 0, 0])).toBe(0);
    expect(colorLuminance([255, 255, 255])).toBeCloseTo(1);
  });

  it('典型深底低于 0.35 阈值、典型纸面亮底高于阈值', () => {
    expect(colorLuminance([17, 19, 24])).toBeLessThan(0.35);
    expect(colorLuminance([26, 29, 33])).toBeLessThan(0.35);
    expect(colorLuminance([245, 241, 232])).toBeGreaterThan(0.85);
  });
});

describe('resolveHostTheme（站点深浅判定）', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('class');
    document.documentElement.style.backgroundColor = '';
    document.body.removeAttribute('data-theme');
    document.body.removeAttribute('class');
    document.body.style.backgroundColor = '';
  });

  it('无任何信号 → light（安全兜底）', () => {
    expect(resolveHostTheme(document)).toBe('light');
  });

  it('html data-theme="dark" → dark（显式声明优先于背景采样）', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.style.backgroundColor = 'rgb(245, 245, 245)';
    expect(resolveHostTheme(document)).toBe('dark');
  });

  it('body class 含 dark 字样（如 theme-dark）→ dark', () => {
    document.body.className = 'site-root theme-dark';
    expect(resolveHostTheme(document)).toBe('dark');
  });

  it('data-theme="light" 不算深色信号，回落背景亮度判定', () => {
    document.documentElement.setAttribute('data-theme', 'light');
    document.documentElement.style.backgroundColor = 'rgb(17, 19, 24)';
    expect(resolveHostTheme(document)).toBe('dark');
  });

  it('html 深底 → dark；html 亮底 → light', () => {
    document.documentElement.style.backgroundColor = 'rgb(17, 19, 24)';
    expect(resolveHostTheme(document)).toBe('dark');
    document.documentElement.style.backgroundColor = 'rgb(245, 241, 232)';
    expect(resolveHostTheme(document)).toBe('light');
  });

  it('html 背景透明时看 body：body 深底 → dark', () => {
    document.body.style.backgroundColor = 'rgb(17, 19, 24)';
    expect(resolveHostTheme(document)).toBe('dark');
  });

  it('html 不透明亮底时不再看 body（先命中不透明背景者生效）', () => {
    document.documentElement.style.backgroundColor = 'rgb(245, 241, 232)';
    document.body.style.backgroundColor = 'rgb(17, 19, 24)';
    expect(resolveHostTheme(document)).toBe('light');
  });

  it('半透明深底（rgba alpha>0）按颜色亮度参与判定', () => {
    document.documentElement.style.backgroundColor = 'rgba(17, 19, 24, 0.9)';
    expect(resolveHostTheme(document)).toBe('dark');
  });
});
