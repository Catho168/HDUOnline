/**
 * B 站宿主深色主题判定测试（node 环境，Document 用满足函数接口的最小桩对象，全确定性）。
 *
 * isBiliHostDark 按可信度依次检查多路信号（任一命中即深色）：
 *  1) html data-theme="dark" / dark-mode、theme-dark 类；
 *  2) cookie theme_style=dark（精确键值匹配，其它值/子串不算）；
 *  3) CSS 变量探针 --bg1 亮度 < 0.35（#rgb / #rrggbb / rgb() 三种写法）。
 * 无信号 / 解析失败 / getComputedStyle 不可用 → false（亮色兜底）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isBiliHostDark } from '@/core/bili/theme';

interface DocStubOptions {
  themeAttr?: string;
  classes?: string[];
  cookie?: string;
  bg1?: string;
}

/** 满足 isBiliHostDark 用到的最小 Document 接口（documentElement.dataset/classList + cookie） */
function makeDoc(opts: DocStubOptions): Document {
  const html = {
    dataset: { theme: opts.themeAttr } as unknown as DOMStringMap,
    classList: { contains: (cls: string) => (opts.classes ?? []).includes(cls) },
  };
  return { documentElement: html, cookie: opts.cookie ?? '' } as unknown as Document;
}

/** 打桩全局 getComputedStyle，只应 --bg1 探针（其余属性返回空串） */
function stubComputedStyle(bg1: string): void {
  vi.stubGlobal(
    'getComputedStyle',
    vi.fn(() => ({ getPropertyValue: (name: string) => (name === '--bg1' ? bg1 : '') })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isBiliHostDark 多路信号判定', () => {
  it('属性/类信号：data-theme="dark"、dark-mode、theme-dark 任一命中即深色', () => {
    expect(isBiliHostDark(makeDoc({ themeAttr: 'dark' }))).toBe(true);
    expect(isBiliHostDark(makeDoc({ classes: ['dark-mode'] }))).toBe(true);
    expect(isBiliHostDark(makeDoc({ classes: ['theme-dark'] }))).toBe(true);
    // 无关类名不算
    expect(isBiliHostDark(makeDoc({ classes: ['light-mode'] }))).toBe(false);
  });

  it('cookie 信号：theme_style=dark 精确匹配才算，子串/其它值不算', () => {
    expect(isBiliHostDark(makeDoc({ cookie: 'theme_style=dark' }))).toBe(true);
    expect(isBiliHostDark(makeDoc({ cookie: 'foo=1; theme_style=dark' }))).toBe(true);
    expect(isBiliHostDark(makeDoc({ cookie: 'theme_style=darkblue' }))).toBe(false);
    expect(isBiliHostDark(makeDoc({ cookie: 'theme_style=light' }))).toBe(false);
    expect(isBiliHostDark(makeDoc({ cookie: 'x_theme_style=dark' }))).toBe(false);
  });

  it('CSS 变量探针：--bg1 亮度 < 0.35 为深色，支持 #rgb/#rrggbb/rgb() 写法', () => {
    stubComputedStyle('#111111');
    expect(isBiliHostDark(makeDoc({}))).toBe(true);
    stubComputedStyle('#fff');
    expect(isBiliHostDark(makeDoc({}))).toBe(false);
    stubComputedStyle('rgb(17, 17, 17)');
    expect(isBiliHostDark(makeDoc({}))).toBe(true);
    stubComputedStyle('rgb(255, 255, 255)');
    expect(isBiliHostDark(makeDoc({}))).toBe(false);
    stubComputedStyle('#232830');
    expect(isBiliHostDark(makeDoc({}))).toBe(true);
    // ~#8a8a8a 亮度 ≈ 0.54，超过阈值按亮色
    stubComputedStyle('#8a8a8a');
    expect(isBiliHostDark(makeDoc({}))).toBe(false);
  });

  it('无信号 / 探针值解析失败 / getComputedStyle 不可用 → 亮色兜底', () => {
    // 探针值不是可解析颜色（B 站部分版本 --bg1 可能是空或非颜色 token）
    stubComputedStyle('white');
    expect(isBiliHostDark(makeDoc({}))).toBe(false);
    stubComputedStyle('');
    expect(isBiliHostDark(makeDoc({}))).toBe(false);
    // getComputedStyle 不可用（node 环境无此全局）：内部 try/catch 兜底返回 false
    vi.unstubAllGlobals();
    expect(isBiliHostDark(makeDoc({}))).toBe(false);
  });
});
