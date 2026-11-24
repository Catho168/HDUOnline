/**
 * 课程卡「下一节」直达行（第 255 轮课程域候选 B，进度视角）：
 *  1. nextUnfinishedSession 纯函数（core/stats/aggregate）：课程时间序第一个未完看课次；
 *  2. CoursesView 渲染：未完看课程卡带「下一节 · 课次」jade 直达行（点击 openSessionInSite），
 *     全完看课程卡不渲染该行（完看 100% chip 承担语义）。
 * 渲染断言照 CoursesView 同域测试惯例（jsdom + createRoot，无 JSX 直接 createElement；
 * uiStore.bindActions 注入 openSessionInSite 侦钉，不触真实路由）。
 */

// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { nextUnfinishedSession } from '@/core/stats/aggregate';
import { CoursesView } from '@/entrypoints/content/ui/learning/CoursesView';
import { uiStore } from '@/entrypoints/content/ui/store';
import type { BundleData } from '@/entrypoints/content/ui/learning/shared';
import type { CourseBundle, SessionEntity } from '@/core/shared/types';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 课次固件（beginTime ISO 串为真实口径）；done 决定 watchState */
function makeSession(courId: number, beginTime: string, opts: { done?: boolean; watching?: boolean; label?: string } = {}): SessionEntity {
  return {
    courId,
    teclId: 33,
    beginTime,
    endTime: beginTime,
    courLabel: opts.label ?? `第 ${courId} 讲`,
    watchState: opts.done ? 'finished' : opts.watching ? 'watching' : 'unwatched',
    watchRatio: opts.done ? 1 : opts.watching ? 0.4 : 0,
  } as SessionEntity;
}

function makeBundle(teclId: number, sessions: SessionEntity[]): CourseBundle {
  return {
    course: { teclId, subjName: `课程 ${teclId}`, teacherNames: [], teclCode: `T${teclId}`, updatedAt: 0 },
    sessions,
    sessionCount: sessions.length,
    watchedSec: 600,
    finishedCount: sessions.filter((s) => s.watchState === 'finished').length,
    transcriptCount: 0,
    topicCount: 0,
  } as CourseBundle;
}

function makeData(bundles: CourseBundle[]): BundleData {
  return {
    bundles,
    report: null,
    missed: [],
    favorites: [],
    folders: [],
    notes: [],
    schedule: [],
    reviewPending: 0,
    loading: false,
    error: null,
  } as unknown as BundleData;
}

describe('nextUnfinishedSession 纯函数（下一节定位）', () => {
  it('课程时间序第一个未完看课次：与输入排序无关（倒序输入也取最早的未完看）', () => {
    // course.bundles 的 sessions 为 beginTime 倒序（最新在前）；未完看 = 901（11-16）与 902（11-18），
    // 最早者为 901
    const sessions = [
      makeSession(903, '2026-11-20T10:00:00+08:00', { done: true }),
      makeSession(902, '2026-11-18T10:00:00+08:00'),
      makeSession(901, '2026-11-16T10:00:00+08:00'),
    ];
    expect(nextUnfinishedSession(sessions)?.courId).toBe(901);
  });

  it('跳看后集的缺口优先：最早未完看（补看哲学），已完看跳过', () => {
    const sessions = [
      makeSession(905, '2026-11-24T10:00:00+08:00'),
      makeSession(904, '2026-11-22T10:00:00+08:00', { done: true }),
      makeSession(903, '2026-11-20T10:00:00+08:00'),
      makeSession(902, '2026-11-18T10:00:00+08:00', { done: true }),
    ];
    expect(nextUnfinishedSession(sessions)?.courId).toBe(903);
  });

  it('全部完看 / 空列表 / 非数组 / 脏课次：null 或不崩（防御式）', () => {
    expect(nextUnfinishedSession([makeSession(901, '2026-11-16T10:00:00+08:00', { done: true })])).toBeNull();
    expect(nextUnfinishedSession([])).toBeNull();
    expect(nextUnfinishedSession(undefined)).toBeNull();
    expect(nextUnfinishedSession(null)).toBeNull();
    // 脏课次（beginTime 非法 / 缺 courId）不崩，可解析者按序返回
    const dirty = [{ ...makeSession(901, 'not-a-date'), courId: undefined } as unknown as SessionEntity, makeSession(902, '2026-11-18T10:00:00+08:00')];
    expect(nextUnfinishedSession(dirty)?.courId).toBe(902);
    // 两个同刻课次按 courId 稳定排序
    const sameTime = [makeSession(912, '2026-11-18T10:00:00+08:00'), makeSession(911, '2026-11-18T10:00:00+08:00')];
    expect(nextUnfinishedSession(sameTime)?.courId).toBe(911);
  });
});

describe('CoursesView 课程卡「下一节」直达行（第 255 轮候选 B）', () => {
  let host: HTMLElement;
  let root: Root;
  let openSpy: Mock;

  async function renderView(bundles: CourseBundle[]): Promise<void> {
    await act(async () => {
      root.render(createElement(CoursesView, { data: makeData(bundles) }));
    });
    await act(async () => {});
  }

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    openSpy = vi.fn();
    uiStore.bindActions({ openSessionInSite: openSpy as never });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    document.body.innerHTML = '';
    // 还原全局 store 的注入钉（本文件内隔离，防泄漏到后续用例）
    uiStore.bindActions({ openSessionInSite: () => undefined });
  });

  it('未完看课程卡渲染「下一节 · 课次」行，点击直达该节（openSessionInSite 带 teclId）', async () => {
    await renderView([
      makeBundle(33, [
        makeSession(902, '2026-11-18T10:00:00+08:00'),
        makeSession(901, '2026-11-16T10:00:00+08:00', { done: true }),
      ]),
    ]);

    const nextRow = host.querySelector<HTMLButtonElement>('.hdu-course-next');
    expect(nextRow).toBeDefined();
    // 落点 = 课程时间序第一个未完看（902，而非倒序输入的第一项）
    expect(nextRow!.textContent).toContain('下一节');
    expect(nextRow!.textContent).toContain('第 902 讲');
    await act(async () => {
      nextRow!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy.mock.calls[0]?.[0]).toBe(902);
    expect(openSpy.mock.calls[0]?.[1]).toBe(33);
  });

  it('全部完看 / 无课次：不渲染下一节行（退回既有「展开课次」交互）', async () => {
    await renderView([
      makeBundle(34, [makeSession(913, '2026-11-20T10:00:00+08:00', { done: true })]),
      makeBundle(35, []),
    ]);

    expect(host.querySelector('.hdu-course-next')).toBeNull();
    expect(host.textContent).toContain('课程 34');
    expect(host.textContent).toContain('课程 35');
  });
});
