/**
 * 课次识别的 DOM 证据链测试（jsdom 环境）。
 *
 * 直接使用本地模拟页 `tests/fixtures/play-center-sim.html`（与人工验收同一份 DOM 结构），
 * 验证新版播放页（#/play-center，URL 不含课次 ID）能靠"被选中的课次条目时间"
 * 与 `/v1/subject_vod_list_new` 返回的 courBeginTime 对齐来识别课次。
 *
 * 说明：jsdom 不做布局，`getBoundingClientRect()` 恒为 0；这里显式打桩为非零尺寸，
 * 好让"元素可见性"判定的逻辑本身也被覆盖（真实浏览器里由布局真实提供）。
 */

// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { collectDomCandidates } from '@/entrypoints/content/site/observations';
import { resolveCourId, type ResolveDeps } from '@/entrypoints/content/site/sessionResolve';
import { parseRoute } from '@/entrypoints/content/site/routes';

const FIXTURE = resolve(__dirname, '../fixtures/play-center-sim.html');
/** 模拟页里被选中条目的开始时间（2026-10-12 18:00，本地时区） */
const SELECTED_BEGIN_MS = new Date(2026, 9, 12, 18, 0, 0, 0).getTime();

beforeAll(() => {
  const html = readFileSync(FIXTURE, 'utf8');
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? '';
  document.body.innerHTML = body;
  // jsdom 无布局：给所有元素一个可见矩形，避免被"可见性判定"整片过滤
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 120,
      bottom: 20,
      width: 120,
      height: 20,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

describe('模拟页结构（新旧播放页共用类名）', () => {
  it('含 3 路视频、站点进度条与课次列表', () => {
    expect(document.querySelectorAll('video')).toHaveLength(3);
    expect(document.querySelector('.jy-control-progress')).toBeTruthy();
    expect(document.querySelectorAll('.right-body .body-content .body-item')).toHaveLength(3);
  });

  it('播放地址不含课次信息（逼识别链走页面选中项）', () => {
    const src = document.querySelector('#primary')?.getAttribute('src') ?? '';
    expect(src).not.toContain('CloudIPC');
    expect(src).not.toMatch(/courseId=/i);
  });
});

describe('旧版播放页 fixture（player-sim）', () => {
  it('同样具备 3 路视频、站点进度条与课次列表选择器', () => {
    const html = readFileSync(resolve(__dirname, '../fixtures/player-sim.html'), 'utf8');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelectorAll('video')).toHaveLength(3);
    expect(doc.querySelector('.play-video .left-module-wrapper .player-wrapper video')).toBeTruthy();
    expect(doc.querySelectorAll('.second-player-container video')).toHaveLength(2);
    expect(doc.querySelector('.jy-control-progress')).toBeTruthy();
    expect(doc.querySelectorAll('.right-body .body-content .body-item')).toHaveLength(3);
    expect(doc.querySelector('.right-body .body-content .body-item.active')).toBeTruthy();
  });
});

describe('DOM 线索：新版播放页的课次条目', () => {
  it('每个课次条目都被识别出时间（近叶子节点、去重后 3 条）', () => {
    const candidates = collectDomCandidates();
    expect(candidates).toHaveLength(3);
    expect(candidates.map((item) => item.letiNumber).sort()).toEqual([10, 11, 12]);
  });

  it('标记出"被选中"的那一条（站点用 active 类表示当前课次）', () => {
    const candidates = collectDomCandidates();
    const selected = candidates.filter((item) => item.selected);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.beginMs).toBe(SELECTED_BEGIN_MS);
    expect(selected[0]?.letiNumber).toBe(12);
  });

  it('限定右栏容器扫描结果一致（不依赖页头日期）', () => {
    const scope = document.querySelector('.right-body');
    expect(scope).toBeTruthy();
    const candidates = collectDomCandidates(scope as Element);
    expect(candidates).toHaveLength(3);
    expect(candidates.filter((item) => item.selected)).toHaveLength(1);
  });

  it('无 video 播放地址时，靠选中项 + 课次列表即可识别课次', async () => {
    const route = parseRoute(
      '#/play-center?teclId=9001&teclCode=TECL-9001&subjId=1573&target=video',
      'course.hdu.edu.cn',
    );
    expect(route.kind).toBe('play-center');
    expect(route.courId).toBeUndefined();

    const deps: ResolveDeps = {
      fromUrl: route.courId,
      getVideoSrc: () => null,
      listObservedUrls: () => [],
      fetchLastPlayHint: async () => null,
      fetchSessions: async () => [
        { courId: 1227036, beginTime: SELECTED_BEGIN_MS - 14 * 24 * 3600 * 1000, letiNumber: 10 },
        { courId: 1227038, beginTime: SELECTED_BEGIN_MS, letiNumber: 12 },
        { courId: 1227037, beginTime: SELECTED_BEGIN_MS - 7 * 24 * 3600 * 1000, letiNumber: 11 },
      ],
      collectDomCandidates: () => collectDomCandidates(),
      matchesPlayingVideo: async () => false,
    };

    const result = await resolveCourId(deps);
    expect(result?.courId).toBe(1227038);
    expect(result?.source).toBe('dom-session-item');
    expect(result?.evidence).toBe('page-selection');
    expect(result?.confidence).toBe('inferred');
    expect(result?.verified).toBe(false);
  });

  it('页面里出现媒体地址时，与选中项核对通过后采用同一条课次', async () => {
    const videoSrc = 'https://vod.example.com/vod/rec/1791805200000-1791808020000.mp4?auth_key=placeholder';
    const deps: ResolveDeps = {
      getVideoSrc: () => videoSrc,
      listObservedUrls: () => [],
      fetchLastPlayHint: async () => null,
      fetchSessions: async () => [
        { courId: 1227036, beginTime: SELECTED_BEGIN_MS - 14 * 24 * 3600 * 1000, letiNumber: 10 },
        { courId: 1227038, beginTime: SELECTED_BEGIN_MS, letiNumber: 12 },
      ],
      collectDomCandidates: () => collectDomCandidates(),
      matchesPlayingVideo: async (courId) => courId === 1227038,
    };
    const result = await resolveCourId(deps);
    expect(result?.courId).toBe(1227038);
    expect(result?.verified).toBe(true);
  });

  it('媒体地址带 courseId 时直接作为直证（无需 DOM 对齐）', async () => {
    const src = 'https://vod.example.com/sample.mp4?courseId=1227038&view=1';
    const deps: ResolveDeps = {
      getVideoSrc: () => src,
      listObservedUrls: () => [],
      fetchLastPlayHint: async () => null,
      fetchSessions: async () => [],
      collectDomCandidates: () => [],
      matchesPlayingVideo: async () => false,
    };
    const result = await resolveCourId(deps);
    expect(result?.courId).toBe(1227038);
    expect(result?.evidence).toBe('media-query');
    expect(result?.confidence).toBe('direct');
  });
});
