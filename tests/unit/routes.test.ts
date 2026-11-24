/**
 * 路由解析与课次 ID 抽取测试（§3.1）。
 *
 * 站点为 hash 路由 SPA：新版播放页 `#/play-center` 的 URL 不含课次 ID，
 * 旧形态 `video-detail` / `play-video` 保持兼容；`sameSession` 用于避免
 * 参数顺序变化或“课次补齐”导致整页重复注入。
 */

import { describe, expect, it } from 'vitest';
import {
  detectSite,
  hasCourId,
  hasSessionKey,
  isPlayRoute,
  parseRoute,
  sameSession,
} from '@/entrypoints/content/site/routes';
import { extractCourIdFromMediaUrl, extractCourIdFromMediaUrlWithEvidence } from '@/entrypoints/content/site/sessionResolve';

const WEBVPN_HOST = 'https://https-course-hdu-edu-cn-443.webvpn.hdu.edu.cn';
const PLAY_CENTER_HASH = '#/play-center?teclId=562388&teclCode=(2026-2027-1)-A0714201-35&subjId=1573&target=video';

describe('路由解析：play-center（新形态）', () => {
  it('识别 play-center 并提取教学班/课程/目标类型', () => {
    const route = parseRoute(PLAY_CENTER_HASH, WEBVPN_HOST);
    expect(route.kind).toBe('play-center');
    expect(route.site).toBe('webvpn');
    expect(route.teclId).toBe(562388);
    expect(route.teclCode).toBe('(2026-2027-1)-A0714201-35');
    expect(route.subjId).toBe(1573);
    expect(route.target).toBe('video');
    expect(route.courId).toBeUndefined(); // URL 不提供课次，需要事后识别
    expect(route.raw).toBe(PLAY_CENTER_HASH);
  });

  it('play-center 视为播放页，只要 teclId 存在即进入播放页流程', () => {
    const route = parseRoute(PLAY_CENTER_HASH, WEBVPN_HOST);
    expect(isPlayRoute(route)).toBe(true);
    expect(hasSessionKey(route)).toBe(true);
    expect(hasCourId(route)).toBe(false);
  });

  it('哈希只带 teclId 时也进入播放页流程（旧行为是静默不注入）', () => {
    const route = parseRoute('#/play-center?teclId=1&target=video', 'course.hdu.edu.cn');
    expect(isPlayRoute(route)).toBe(true);
    expect(hasSessionKey(route)).toBe(true);
  });

  it('站点补写 courseId 时直接用 URL 值（无需再识别）', () => {
    const route = parseRoute('#/play-center?teclId=562388&target=video&courseId=1227038', WEBVPN_HOST);
    expect(route.courId).toBe(1227038);
    expect(hasCourId(route)).toBe(true);
  });
});

describe('路由解析：旧形态保持兼容', () => {
  it('video-detail 的 courseId 就是课次', () => {
    const route = parseRoute('#/video-detail?teclId=9001&courseId=1227038', 'course.hdu.edu.cn');
    expect(route.kind).toBe('video-detail');
    expect(route.site).toBe('campus');
    expect(route.teclId).toBe(9001);
    expect(route.courId).toBe(1227038);
    expect(route.raw).toContain('courseId=1227038');
  });

  it('play-video 同时带 courseId/courId 时优先取 courId，分享参数透传', () => {
    const route = parseRoute(
      '#/play-video?signture=placeholder-not-a-real-signature&type=1&teclId=9001&courseId=1227038&courId=1227039',
      WEBVPN_HOST,
    );
    expect(route.kind).toBe('play-video');
    expect(route.courId).toBe(1227039);
    expect(route.raw).toContain('signture=placeholder-not-a-real-signature');
  });

  it('列表页与个人中心路由', () => {
    expect(parseRoute('#/list-video', 'course.hdu.edu.cn').kind).toBe('list-video');
    expect(parseRoute('#/list-live', 'course.hdu.edu.cn').kind).toBe('list-live');
    expect(parseRoute('#/home', 'course.hdu.edu.cn').kind).toBe('home');
    expect(parseRoute('#/personal-center/my-schedule', 'course.hdu.edu.cn').kind).toBe('my-schedule');
    expect(parseRoute('#/personal-center/my-record', 'course.hdu.edu.cn').kind).toBe('my-record');
    expect(parseRoute('#/personal-center/my-collection', 'course.hdu.edu.cn').kind).toBe('my-collection');
    expect(parseRoute('#/personal-center/my-note', 'course.hdu.edu.cn').kind).toBe('my-note');
    expect(parseRoute('#/unknown-page', 'course.hdu.edu.cn').kind).toBe('other');
  });

  it('空 hash 视为首页；缺失 ID 时不上报会话键', () => {
    expect(parseRoute('#', 'course.hdu.edu.cn').kind).toBe('home');
    expect(parseRoute('', 'course.hdu.edu.cn').kind).toBe('home');
    const route = parseRoute('#/video-detail?teclId=9001', 'course.hdu.edu.cn');
    expect(route.courId).toBeUndefined();
  });

  it('参数键大小写不敏感，数字兼容千分位/装饰字符', () => {
    const route = parseRoute('#/play-center?TECLID=9001&COURSEID=1,573&SUBJID=1573', 'course.hdu.edu.cn');
    expect(route.teclId).toBe(9001);
    expect(route.courId).toBe(1573);
    expect(route.subjId).toBe(1573);
    expect(parseRoute('#/play-center?teclId=abc&courseId=0&subjId=abc', 'course.hdu.edu.cn')).toMatchObject({
      teclId: undefined,
      courId: undefined,
      subjId: undefined,
    });
  });

  it('站点识别：webvpn 子域与主站', () => {
    expect(detectSite('https-course-hdu-edu-cn-443.webvpn.hdu.edu.cn')).toBe('webvpn');
    expect(detectSite('COURSE.HDU.EDU.CN')).toBe('campus');
  });
});

describe('sameSession：避免重复注入', () => {
  const before = parseRoute(PLAY_CENTER_HASH, WEBVPN_HOST);

  it('课次未知时补齐 courId 不被判定为另一会话', () => {
    const after = { ...before, courId: 1227038 };
    expect(sameSession(before, after)).toBe(true);
    expect(sameSession(after, before)).toBe(true);
  });

  it('教学班/课程/teclCode 任一变化都视为不同会话（课次未知时）', () => {
    expect(sameSession({ ...before, teclId: 1 }, before)).toBe(false);
    expect(sameSession({ ...before, subjId: 999 }, before)).toBe(false);
    expect(sameSession({ ...before, teclCode: 'OTHER' }, before)).toBe(false);
  });

  it('课次已知时以教学班 + 课次为准', () => {
    const a = { ...before, courId: 1227038 };
    const b = { ...before, courId: 1227039 };
    const same = { ...before, courId: 1227038, subjId: 999 };
    expect(sameSession(a, b)).toBe(false);
    expect(sameSession(a, same)).toBe(true);
  });

  it('路由种类不同或前值为 null 时不相等', () => {
    const detail = parseRoute('#/video-detail?teclId=562388&courseId=1227038', WEBVPN_HOST);
    expect(sameSession(before, detail)).toBe(false);
    expect(sameSession(null, before)).toBe(false);
  });
});

describe('课次 ID 抽取（媒体地址命名 / query）', () => {
  const COUR = 1227038;

  it('CloudIPC-{课次ID}-… 命名', () => {
    const url = `https://vod.example.com/vod/33060201041321000015/20261012/CloudIPC-${COUR}-2573705-3286223/1791805200000-1791808020000.mp4?auth_key=placeholder`;
    expect(extractCourIdFromMediaUrl(url)).toBe(COUR);
    expect(extractCourIdFromMediaUrlWithEvidence(url)).toEqual({ courId: COUR, evidence: 'media-name' });
  });

  it('媒体 query 里的 courseId / courId / course_id', () => {
    expect(extractCourIdFromMediaUrl('https://vod.example.com/plain.mp4?courseId=4242')).toBe(4242);
    expect(extractCourIdFromMediaUrl('https://vod.example.com/plain.mp4?courId=4243')).toBe(4243);
    expect(extractCourIdFromMediaUrl('https://vod.example.com/plain.mp4?course_id=4244')).toBe(4244);
    expect(extractCourIdFromMediaUrlWithEvidence('https://vod.example.com/plain.mp4?courseId=4242')).toEqual({
      courId: 4242,
      evidence: 'media-query',
    });
  });

  it('无法推断时返回 undefined', () => {
    expect(extractCourIdFromMediaUrl('https://vod.example.com/plain.mp4')).toBeUndefined();
    expect(extractCourIdFromMediaUrl('')).toBeUndefined();
    expect(extractCourIdFromMediaUrl('https://vod.example.com/plain.mp4?courseId=abc')).toBeUndefined();
  });
});
