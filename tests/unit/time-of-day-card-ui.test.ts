/**
 * 学习时段分布卡 TimeOfDayCard 渲染测试（jsdom + react-dom 客户端渲染，无 JSX、
 * 直接 createElement，照 milestone-wall-ui.test.ts 桩模式；callOp 整体 mock）。
 *
 * 覆盖第 238 轮新增的行为约定：
 *  1. stats.records 返回近 30 天流水 → 六行 .hdu-dist-row 分布条渲染（固定桶序），
 *     最高占比桶 is-top 高亮（恰一行）、条形带时长 title、foot 洞察文案（第 239 轮
 *     起达「黄金时段」门槛时升级为「你的黄金时段：晚间（18–23 点），占比 X%」——
 *     桩流水总量恰 60 分钟、晚间占比 83% 达门槛）+ 卡面「口径」徽标行；
 *  2. 流水为空数组 → 空态「暂无数据」（无洞察行）；
 *  3. 取数失败 → 失败态与空态分开提示 + 重试按钮，点击重试重新拉取（attempt 递增）；
 *  4. 取数窗口：stats.records 以本地日键 fromDay/toDay（近 30 天含今天）调用；
 *  5. 第 239 轮：不达黄金时段门槛（总有效 <60 分钟）→ 维持中性文案「你最常在…」。
 *
 * 时区无关：桩流水的 date / startTs 均按真实「今天」相对偏移构造（不过度依赖
 * 测试机时区；分桶断言只用 20 点 / 6 点两个远离桶界的时刻）。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { TimeOfDayCard } from '@/entrypoints/content/ui/learning/TimeOfDayCard';
import { localDayKey } from '@/core/shared/utils';
import type { WatchRecordEntity } from '@/core/shared/types';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

/** 桩流水：今天晚间两条（20 点 1200s + 21:30 1800s）+ 5 天前清晨一条（6 点 600s） */
function stubRecords(): WatchRecordEntity[] {
  const now = Date.now();
  const eveningTs = new Date(now).setHours(20, 0, 0, 0);
  const eveningTs2 = new Date(now).setHours(21, 30, 0, 0);
  const dawnDay = new Date(now - 5 * 86_400_000);
  dawnDay.setHours(6, 0, 0, 0);
  return [
    { courId: 1, teclId: 1, date: localDayKey(now), startTs: eveningTs, endTs: eveningTs + 1200_000, durationSec: 1200, playMode: 'vod', speed: 1, firstWatch: true, valid: true },
    { courId: 1, teclId: 1, date: localDayKey(now), startTs: eveningTs2, endTs: eveningTs2 + 1800_000, durationSec: 1800, playMode: 'vod', speed: 1, firstWatch: true, valid: true },
    { courId: 2, teclId: 2, date: localDayKey(dawnDay.getTime()), startTs: dawnDay.getTime(), endTs: dawnDay.getTime() + 600_000, durationSec: 600, playMode: 'vod', speed: 1, firstWatch: true, valid: true },
  ];
}

let host: HTMLElement;
let root: Root;

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
  // 放行 useEffect 内的 callOp promise
  await act(async () => {});
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  callOpMock.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
});

describe('学习时段分布卡渲染（第 238 轮巡检）', () => {
  it('六行分布条 + 最高桶 is-top 高亮（恰一行）+ 条形时长 title + foot 洞察文案', async () => {
    callOpMock.mockResolvedValue(stubRecords());
    await renderElement(createElement(TimeOfDayCard, null));

    // 取数路径：stats.records 近 30 天（fromDay/toDay 本地日键，含端点）；calls[0] = [op 名, args]
    expect(callOpMock).toHaveBeenCalledTimes(1);
    const arg = (callOpMock.mock.calls[0] as Array<unknown>)[1] as { fromDay: string; toDay: string };
    expect(arg.toDay).toBe(localDayKey());
    expect(arg.fromDay).toBe(localDayKey(Date.now() - 29 * 86_400_000));

    // 六桶全量行（含 0 秒桶），固定桶序
    const rows = [...host.querySelectorAll('.hdu-dist-tod .hdu-dist-row')];
    expect(rows.map((r) => r.querySelector('.hdu-dist-name')?.textContent)).toEqual([
      '清晨', '上午', '午后', '傍晚', '晚间', '深夜',
    ]);
    // 最高占比桶 = 晚间（3000 / 3600 = 83%）恰一行高亮
    const topRows = rows.filter((r) => r.className.includes('is-top'));
    expect(topRows).toHaveLength(1);
    expect(topRows[0]?.querySelector('.hdu-dist-name')?.textContent).toBe('晚间');
    expect(topRows[0]?.querySelector('.hdu-dist-pct')?.textContent).toBe('83%');
    // 条形 title 带时长 / 次数 / 占比（hover 提示）
    const topBar = topRows[0]?.querySelector('.hdu-dist-bar');
    expect(topBar?.getAttribute('title')).toContain('晚间（18–23 点）');
    expect(topBar?.getAttribute('title')).toContain('50 分钟');
    expect(topBar?.getAttribute('title')).toContain('2 次');
    // foot 洞察文案（.hdu-hint）：总量 3600s 恰达 60 分钟门槛 + 晚间 83% ≥25% →
    // 第 239 轮「黄金时段」建议文案（原第 238 轮中性文案「你最常在…」仅在未达
    // 门槛时出现，见下方第 5 条用例）
    const hint = [...host.querySelectorAll('.hdu-hint')].find((el) => !el.className.includes('hdu-caliber-hint'));
    expect(hint?.textContent).toContain('你的黄金时段：晚间（18–23 点）');
    expect(hint?.textContent).toContain('占比 83%');
    // 卡面口径标注（第 239 轮，分布卡口径统一）：「口径」徽标 + 站内有效 · 近 30 天
    const caliber = host.querySelector('.hdu-caliber-hint');
    expect(caliber?.querySelector('.hdu-caliber-tag')?.textContent).toBe('口径');
    expect(caliber?.textContent).toContain('站内有效时长 · 近 30 天');
  });

  it('空流水 → 空态「暂无数据」（无分布行、无洞察行）', async () => {
    callOpMock.mockResolvedValue([]);
    await renderElement(createElement(TimeOfDayCard, null));
    expect(host.querySelectorAll('.hdu-dist-tod .hdu-dist-row')).toHaveLength(0);
    expect(host.textContent).toContain('暂无数据');
    expect(host.querySelector('.hdu-hint')).toBeNull();
    // 空态不显示重试（无可重试的东西，等有观看记录即可）
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === '重试')).toBe(false);
  });

  it('取数失败 → 失败态与空态分开提示 + 重试按钮，点击重试重新拉取', async () => {
    callOpMock.mockRejectedValue(new Error('boom'));
    await renderElement(createElement(TimeOfDayCard, null));
    expect(host.textContent).toContain('暂时拿不到时段数据');
    const retry = [...host.querySelectorAll('button')].find((b) => b.textContent === '重试');
    expect(retry).toBeTruthy();

    // 切换为成功桩，点击「重试」→ attempt 递增 → 同一 effect 重新拉取
    callOpMock.mockResolvedValue(stubRecords());
    await act(async () => {
      retry!.click();
    });
    await act(async () => {});

    expect(callOpMock).toHaveBeenCalledTimes(2);
    expect(host.querySelectorAll('.hdu-dist-tod .hdu-dist-row')).toHaveLength(6);
  });

  it('全 invalid 流水（纯函数口径）→ 空态「暂无数据」', async () => {
    const invalid = stubRecords().map((r) => ({ ...r, valid: false }));
    callOpMock.mockResolvedValue(invalid);
    await renderElement(createElement(TimeOfDayCard, null));
    expect(host.textContent).toContain('暂无数据');
    expect(host.querySelectorAll('.hdu-dist-tod .hdu-dist-row')).toHaveLength(0);
  });

  it('不达黄金时段门槛（总有效 20 分钟 <60 分钟）→ foot 维持第 238 轮中性文案', async () => {
    // 仅今天 20 点一条 1200s（20 分钟）：晚间占比 100% 但总量不达门槛 → 防噪声不出建议
    const now = Date.now();
    const eveningTs = new Date(now).setHours(20, 0, 0, 0);
    callOpMock.mockResolvedValue([
      { courId: 1, teclId: 1, date: localDayKey(now), startTs: eveningTs, endTs: eveningTs + 1200_000, durationSec: 1200, playMode: 'vod', speed: 1, firstWatch: true, valid: true },
    ]);
    await renderElement(createElement(TimeOfDayCard, null));

    const hint = [...host.querySelectorAll('.hdu-hint')].find((el) => !el.className.includes('hdu-caliber-hint'));
    expect(hint?.textContent).toContain('你最常在晚间（18–23 点）学习');
    expect(hint?.textContent).toContain('占比 100%');
    // 口径行照常在场（有分布数据即标注）
    expect(host.querySelector('.hdu-caliber-hint')).toBeTruthy();
  });
});
