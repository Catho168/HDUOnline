/**
 * 今晚补进度模拟行 EveningSimRow 渲染测试（jsdom + react-dom 客户端渲染，无 JSX、
 * 直接 createElement，照 milestone-wall-ui.test.ts 桩模式；组件自挂载、无取数）。
 *
 * 覆盖第 237 轮新增的行为约定：
 *  1. 默认输入值 = suggestedMin（分钟）且最小 5（已达标态 neededPerDaySec=0 → 5）；
 *  2. 点击「如果今晚学 X 分钟」→ aria-live 结果区即时输出两态文案（可达成 ✅ /
 *     还差 ❌）与着色类（is-hit jade / is-behind danger），结果用点击时刻的输入值；
 *  3. 输入改小后再点击 → 结果按新值更新（纯前端模拟、不写库）；
 *  4. 输入清 0 → 按钮 disabled（0 / 负数补学无意义，simulateEveningStudy 返回 null）。
 *
 * 注：受控输入走 library-view-batch.test.ts 同款「原型 value setter + input 事件」模式。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EveningSimRow } from '@/entrypoints/content/ui/learning/StatsView';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const H = 3600;

let host: HTMLElement;
let root: Root;

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
  await act(async () => {});
}

/** 受控数字输入赋值（原型 setter 绕过 React 实例 value tracker 去重） */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function simButton(): HTMLButtonElement {
  const el = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('如果今晚学'));
  if (!el) throw new Error('模拟按钮未找到');
  return el as HTMLButtonElement;
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
});

describe('今晚补进度模拟行渲染（第 237 轮巡检）', () => {
  it('默认输入取 suggestedMin；点击按钮 → aria-live 结果区可达成文案与 is-hit 着色', async () => {
    await renderElement(createElement(EveningSimRow, { weekSec: 3 * H, targetSec: 4 * H, suggestedMin: 96 }));

    const input = host.querySelector('.hdu-goal-sim-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe('96'); // 默认取预测行 neededPerDaySec 换算分钟
    // label for 关联（可达性：读屏可感知「今晚补」+ 分钟输入）
    const label = host.querySelector('.hdu-goal-sim-label');
    expect(label?.getAttribute('for')).toBe(input.id);
    // 按钮文案携带当前输入值
    expect(simButton().textContent).toContain('如果今晚学 96 分钟');
    // 结果区 aria-live 常驻、初始为空
    const result = host.querySelector('.hdu-goal-sim-result');
    expect(result?.getAttribute('aria-live')).toBe('polite');
    expect(result?.textContent).toBe('');

    await act(async () => {
      simButton().click();
    });
    await act(async () => {});

    // 3h + 96 分钟 = 4.6h ≥ 4h → 可达成 ✅（jade 着色）
    expect(result?.textContent).toBe('模拟：加上 96 分钟后 4.6h，可达成 ✅');
    expect(result?.className).toContain('is-hit');
    expect(result?.className).not.toContain('is-behind');
  });

  it('补学不足 → 还差文案与 is-behind 着色（缺口分钟向上取整）', async () => {
    await renderElement(createElement(EveningSimRow, { weekSec: 3 * H, targetSec: 4 * H, suggestedMin: 5 }));

    const input = host.querySelector('.hdu-goal-sim-input') as HTMLInputElement;
    await act(async () => {
      setInputValue(input, '10');
    });
    await act(async () => {});

    expect(simButton().textContent).toContain('如果今晚学 10 分钟');
    await act(async () => {
      simButton().click();
    });
    await act(async () => {});

    // 3h + 10 分钟 = 3.2h < 4h → 还差 50 分钟 ❌（danger 着色）
    const result = host.querySelector('.hdu-goal-sim-result');
    expect(result?.textContent).toBe('模拟：加上 10 分钟后 3.2h，还差 50 分钟 ❌');
    expect(result?.className).toContain('is-behind');
    expect(result?.className).not.toContain('is-hit');
  });

  it('suggestedMin=0（已达标态）默认落到最小 5；输入清 0 → 按钮 disabled', async () => {
    await renderElement(createElement(EveningSimRow, { weekSec: 5 * H, targetSec: 4 * H, suggestedMin: 0 }));
    const input = host.querySelector('.hdu-goal-sim-input') as HTMLInputElement;
    expect(input.value).toBe('5');

    await act(async () => {
      setInputValue(input, '0');
    });
    await act(async () => {});

    expect(simButton().disabled).toBe(true);
    // disabled 态点击不产生结果（防误触，纯前端模拟不写库）
    expect(host.querySelector('.hdu-goal-sim-result')?.textContent).toBe('');
  });
});
