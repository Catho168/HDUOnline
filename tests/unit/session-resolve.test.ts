/**
 * 课次识别测试（§3.1 修订版）。
 *
 * 覆盖 2026-10-16 的真实故障形态：站点播放页由 `#/video-detail` 变为
 * `#/play-center?teclId=&teclCode=&subjId=&target=video`（URL 不含课次 ID），
 * 课次只能在页面右栏切换。这里锁定多证据链的优先级、核对规则与有状态解析器。
 *
 * 测试数据全部为占位值，不含任何真实课程信息；媒体地址中的签名参数为占位符。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  extractCourIdFromMediaUrlWithEvidence,
  extractCourIdFromResourceUrl,
  extractCourIdFromVideoUrl,
  isVideoLikeUrl,
  matchSessionByTime,
  parseDatetimeMs,
  parseLetiNumber,
  resolveCourId,
  resolveSourceLabel,
  SessionResolver,
  sourceForEvidence,
  type ResolveDeps,
  type SessionTimeRow,
} from '@/entrypoints/content/site/sessionResolve';

const COUR = 1227038;

const MEDIA_URL = `https://vod.example.com/vod/33060201041321000015/20261012/CloudIPC-${COUR}-2573705-3286223/1791805200000-1791808020000.mp4?auth_key=placeholder-not-a-real-signature`;
/** 站点并非所有媒体地址都带 CloudIPC 命名；这种地址里推断不出课次。 */
const OPAQUE_MEDIA_URL =
  'https://vod.example.com/vod/33060201041321000015/20261012/rec/1791805200000-1791808020000.mp4?auth_key=placeholder-not-a-real-signature';

function localMs(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

function deps(overrides: Partial<ResolveDeps> = {}): ResolveDeps {
  return {
    fromUrl: undefined,
    getVideoSrc: () => null,
    listObservedUrls: () => [],
    fetchLastPlayHint: async () => null,
    fetchSessions: async () => [],
    collectDomCandidates: () => [],
    matchesPlayingVideo: async () => false,
    ...overrides,
  };
}

describe('课次证据抽取', () => {
  it('从媒体地址命名推断课次（CloudIPC-{课次ID}-…）', () => {
    expect(extractCourIdFromVideoUrl(MEDIA_URL)).toBe(COUR);
    expect(extractCourIdFromVideoUrl('https://vod.example.com/a/b.mp4?courseId=4242')).toBe(4242);
    expect(extractCourIdFromVideoUrl('https://vod.example.com/plain.mp4')).toBeUndefined();
    expect(extractCourIdFromVideoUrl('')).toBeUndefined();
    expect(extractCourIdFromMediaUrlWithEvidence(MEDIA_URL)).toEqual({ courId: COUR, evidence: 'media-name' });
    expect(extractCourIdFromMediaUrlWithEvidence('https://vod.example.com/a/b.mp4?courId=4243')).toEqual({
      courId: 4243,
      evidence: 'media-query',
    });
  });

  it('从站点请求地址推断课次（course_vod_urls_new / course_vod_videoinfos）', () => {
    expect(
      extractCourIdFromResourceUrl(`https://course.hdu.edu.cn/jy-application-resourcemanage/v1/course_vod_urls_new?courseId=${COUR}`),
    ).toBe(COUR);
    expect(
      extractCourIdFromResourceUrl(
        `https://course.hdu.edu.cn/jy-application-resourcemanage/v1/course_vod_videoinfos?courseId=${COUR}`,
      ),
    ).toBe(COUR);
    expect(extractCourIdFromResourceUrl('https://course.hdu.edu.cn/other?courseId=1')).toBeUndefined();
    expect(extractCourIdFromResourceUrl(MEDIA_URL)).toBe(COUR);
    expect(isVideoLikeUrl(MEDIA_URL)).toBe(true);
    expect(isVideoLikeUrl('https://course.hdu.edu.cn/api?courseId=1')).toBe(false);
  });

  it('解析页面文本里的日期时间与节次', () => {
    const beginMs = localMs(2026, 10, 14, 10, 25);
    expect(parseDatetimeMs('第5周 - 周三 第3节 2026-10-14 10:25 正心楼512')).toBe(beginMs);
    expect(parseDatetimeMs('2026-10-14T10:25')).toBe(beginMs);
    expect(parseDatetimeMs('2026/10/14 10:25:30')).toBe(localMs(2026, 10, 14, 10, 25) + 30_000);
    expect(parseDatetimeMs('2026年10月14日 10:25')).toBe(beginMs);
    expect(parseDatetimeMs('第5周 第3节')).toBeUndefined();
    // 非法日期不得被 Date 自动进位
    expect(parseDatetimeMs('2026-02-30 10:00')).toBeUndefined();
    expect(parseLetiNumber('第5周 - 周三 第3节')).toBe(3);
    expect(parseLetiNumber('第12节课')).toBe(12);
    expect(parseLetiNumber('没有节次')).toBeUndefined();
  });

  it('课次列表按开始时间匹配（±90 秒），退化到节次号', () => {
    const rows: SessionTimeRow[] = [
      { courId: 1, beginTime: localMs(2026, 10, 14, 8, 40), letiNumber: 1 },
      { courId: 2, beginTime: localMs(2026, 10, 14, 10, 25), letiNumber: 3 },
    ];
    expect(matchSessionByTime(rows, localMs(2026, 10, 14, 10, 25) + 30_000)).toBe(2);
    expect(matchSessionByTime(rows, localMs(2026, 10, 14, 10, 26) + 30_000)).toBe(2); // 90 秒内
    expect(matchSessionByTime(rows, localMs(2026, 10, 14, 10, 30), 1)).toBe(1); // 时间不中，按节次
    expect(matchSessionByTime(rows, localMs(2026, 10, 14, 23, 0))).toBeUndefined();
  });
});

describe('课次识别主流程', () => {
  it('优先级 1：URL 里的课次直接采用', async () => {
    const result = await resolveCourId(deps({ fromUrl: COUR }));
    expect(result).toEqual({ courId: COUR, evidence: 'url', confidence: 'direct', source: 'url' });
  });

  it('优先级 2：正在播放的媒体地址优先于页面请求记录', async () => {
    const result = await resolveCourId(
      deps({
        getVideoSrc: () => MEDIA_URL,
        listObservedUrls: () => [`https://x/jy-application-resourcemanage/v1/course_vod_urls_new?courseId=999`],
      }),
    );
    expect(result?.courId).toBe(COUR);
    expect(result?.evidence).toBe('media-name');
    expect(result?.source).toBe('video-file');
    expect(result?.confidence).toBe('direct');
  });

  it('优先级 3：页面请求记录里最近一次课次（未核对时标记 inferred/unverified）', async () => {
    const result = await resolveCourId(
      deps({
        listObservedUrls: () => [
          'https://x/jy-application-resourcemanage/v1/course_vod_urls_new?courseId=11',
          'https://x/jy-application-resourcemanage/v1/course_vod_urls_new?courseId=22',
        ],
      }),
    );
    expect(result?.courId).toBe(22);
    expect(result?.evidence).toBe('site-request');
    expect(result?.source).toBe('network');
    expect(result?.confidence).toBe('inferred');
    expect(result?.verified).toBe(false);
  });

  it('推断来源必须与正在播放的文件核对，不一致则继续尝试下一个候选', async () => {
    const matches = vi.fn(async (courId: number) => courId === 2);
    const result = await resolveCourId(
      deps({
        getVideoSrc: () => OPAQUE_MEDIA_URL,
        fetchLastPlayHint: async () => ({ courseId: 1, videoUrls: [] }),
        collectDomCandidates: () => [
          { beginMs: localMs(2026, 10, 14, 10, 25), letiNumber: 3, selected: true },
        ],
        fetchSessions: async () => [
          { courId: 2, beginTime: localMs(2026, 10, 14, 10, 25), letiNumber: 3 },
        ],
        matchesPlayingVideo: matches,
      }),
    );
    expect(result).toEqual({
      courId: 2,
      evidence: 'page-selection',
      confidence: 'inferred',
      source: 'dom-session-item',
      verified: true,
    });
    expect(matches).toHaveBeenCalledWith(1, OPAQUE_MEDIA_URL); // 站点记录候选被核对后否决
  });

  it('推断来源全部核对失败时返回 null（交给用户手动选择）', async () => {
    const result = await resolveCourId(
      deps({
        getVideoSrc: () => OPAQUE_MEDIA_URL,
        fetchLastPlayHint: async () => ({ courseId: 1, videoUrls: [] }),
        matchesPlayingVideo: async () => false,
      }),
    );
    expect(result).toBeNull();
  });

  it('没有播放器地址（尚未开始播放）时接受推断来源并标记为未核对', async () => {
    const result = await resolveCourId(deps({ fetchLastPlayHint: async () => ({ courseId: 7, videoUrls: [] }) }));
    expect(result).toEqual({
      courId: 7,
      evidence: 'site-last-play',
      confidence: 'inferred',
      source: 'last-play',
      verified: false,
    });
  });

  it('站点播放记录里带回与当前播放文件相同的地址 → 已核对', async () => {
    const result = await resolveCourId(
      deps({
        getVideoSrc: () => OPAQUE_MEDIA_URL,
        fetchLastPlayHint: async () => ({ courseId: COUR, videoUrls: [OPAQUE_MEDIA_URL] }),
      }),
    );
    expect(result).toEqual({
      courId: COUR,
      evidence: 'site-last-play',
      confidence: 'inferred',
      source: 'last-play',
      verified: true,
    });
  });

  it('课次列表选中项通过时间对齐（play-center 页面内切换课次的主要证据）', async () => {
    const rows: SessionTimeRow[] = [
      { courId: 1, beginTime: localMs(2026, 10, 14, 8, 40), letiNumber: 1 },
      { courId: 2, beginTime: localMs(2026, 10, 14, 10, 25), letiNumber: 3 },
    ];
    const result = await resolveCourId(
      deps({
        collectDomCandidates: () => [
          { beginMs: localMs(2026, 10, 14, 8, 40), letiNumber: 1, selected: false },
          { beginMs: localMs(2026, 10, 14, 10, 25), letiNumber: 3, selected: true },
        ],
        fetchSessions: async () => rows,
      }),
    );
    expect(result).toEqual({
      courId: 2,
      evidence: 'page-selection',
      confidence: 'inferred',
      source: 'dom-session-item',
      verified: false,
    });
  });

  it('选中项显式携带 courId 时优先采用（仍需属于当前教学班列表）', async () => {
    const result = await resolveCourId(
      deps({
        collectDomCandidates: () => [{ courId: 9, selected: true }],
        fetchSessions: async () => [{ courId: 9, beginTime: 0 }],
      }),
    );
    expect(result?.courId).toBe(9);
    expect(result?.evidence).toBe('page-selection');

    const notBelonging = await resolveCourId(
      deps({
        collectDomCandidates: () => [{ courId: 9, selected: true }],
        fetchSessions: async () => [{ courId: 10, beginTime: 0 }],
      }),
    );
    expect(notBelonging).toBeNull();
  });

  it('only 选项可限定证据链（用于定位问题）', async () => {
    const result = await resolveCourId(deps({ fromUrl: COUR, getVideoSrc: () => MEDIA_URL }), {
      only: ['video-file'],
    });
    expect(result?.source).toBe('video-file');
    expect(result?.evidence).toBe('media-name');
  });

  it('用户手动选择优先于所有自动证据', async () => {
    const result = await resolveCourId(deps({ fromUrl: COUR, getVideoSrc: () => MEDIA_URL }), {
      manualCourId: 77,
    });
    expect(result).toEqual({ courId: 77, evidence: 'manual', confidence: 'direct', source: 'manual' });
  });

  it('blob:/data: 播放地址不参与推断', async () => {
    const result = await resolveCourId(
      deps({
        getVideoSrc: () => 'blob:https://course.hdu.edu.cn/1234',
        fetchLastPlayHint: async () => ({ courseId: 7, videoUrls: [] }),
      }),
    );
    expect(result?.courId).toBe(7);
    expect(result?.source).toBe('last-play');
    expect(result?.verified).toBe(false);
  });

  it('来源展示名与证据映射', () => {
    expect(sourceForEvidence('media-name')).toBe('video-file');
    expect(sourceForEvidence('site-request')).toBe('network');
    expect(sourceForEvidence('page-selection')).toBe('dom-session-item');
    expect(resolveSourceLabel('url')).toBe('地址参数');
    expect(resolveSourceLabel('video-file')).toBe('播放地址');
    expect(resolveSourceLabel('manual')).toBe('手动选择');
  });
});

describe('SessionResolver（内容脚本有状态门面）', () => {
  it('喂入观测地址后无需视频即可识别；手动选择覆盖自动结果', async () => {
    const resolver = new SessionResolver(deps());
    resolver.noteObservedUrl(
      'https://x/jy-application-resourcemanage/v1/course_vod_urls_new?courseId=33',
    );
    expect(resolver.getObservedUrls()).toHaveLength(1);

    const automatic = await resolver.resolve();
    expect(automatic?.courId).toBe(33);
    expect(automatic?.source).toBe('network');
    expect(resolver.getLastResult()).toEqual(automatic);

    resolver.setManual(77);
    expect(resolver.getManual()).toBe(77);
    const manual = await resolver.resolve();
    expect(manual?.courId).toBe(77);
    expect(manual?.source).toBe('manual');

    resolver.clearManual();
    const again = await resolver.resolve();
    expect(again?.courId).toBe(33);
  });

  it('同一观测地址只保留一份，resetObservations 清空', async () => {
    const resolver = new SessionResolver(deps());
    const url = 'https://x/jy-application-resourcemanage/v1/course_vod_urls_new?courseId=33';
    resolver.noteObservedUrl(url);
    resolver.noteObservedUrl(url);
    expect(resolver.getObservedUrls()).toEqual([url]);

    resolver.resetObservations();
    expect(resolver.getObservedUrls()).toEqual([]);
    expect(await resolver.resolve()).toBeNull();
  });

  it('页面课次列表选择可直接驱动识别（无播放地址时）', async () => {
    const resolver = new SessionResolver(
      deps({
        collectDomCandidates: () => [
          { beginMs: localMs(2026, 10, 12, 18, 0), letiNumber: 12, selected: true },
        ],
        fetchSessions: async () => [
          { courId: 1227038, beginTime: localMs(2026, 10, 12, 18, 0), letiNumber: 12 },
        ],
      }),
    );
    const result = await resolver.resolve();
    expect(result?.courId).toBe(1227038);
    expect(result?.evidence).toBe('page-selection');
    expect(result?.verified).toBe(false);
  });
});
