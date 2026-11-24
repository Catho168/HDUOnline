/**
 * B 站字幕适配器单测：纯函数（选轨口径 / 秒映射 / coverage 合并 / 分 P 映射）
 * 与 fetchBiliSubtitle 全链路（fetch + wbi key 双注入，风控码语义断言）。
 *
 * 口径依据见 src/core/bili/subtitle.ts 头注释；无字幕一律 status:'none'（作罢，不抛错）。
 */

import { describe, expect, it } from 'vitest';
import { AppError } from '@/core/shared/errors';
import {
  assertSubtitleCdnUrl,
  fetchBiliSubtitle,
  isChineseSubtitle,
  mergeCoverage,
  normalizeSubtitleUrl,
  parseSubtitleSegments,
  parseSubtitleTrack,
  parseSubtitleTracks,
  pickSubtitleTrack,
  resolvePageCid,
  type BiliSubtitleTrack,
} from '@/core/bili/subtitle';

function track(partial: Partial<BiliSubtitleTrack>): BiliSubtitleTrack {
  return { lan: 'zh-CN', lanDoc: '中文', ai: false, url: 'https://aisubtitle.hdslb.com/a.json', ...partial };
}

function okRes(payload: unknown): unknown {
  return { ok: true, status: 200, json: async () => payload };
}

/** 按 URL 前缀路由的假 fetch（记录每次请求的 URL 供断言） */
function makeFetchImpl(routes: Record<string, unknown>, recorded: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    recorded.push(url);
    for (const prefix of Object.keys(routes)) {
      if (url.startsWith(prefix)) return okRes(routes[prefix]) as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

const KEYS = { imgKey: 'imgKeyTest', subKey: 'subKeyTest' };
const PAGELIST = 'https://api.bilibili.com/x/player/pagelist';
const PLAYER = 'https://api.bilibili.com/x/player/wbi/v2';
const SUBTITLE_JSON = 'https://aisubtitle.hdslb.com/sub.json';

describe('normalizeSubtitleUrl', () => {
  it('协议相对 // 补 https；空串原样', () => {
    expect(normalizeSubtitleUrl('//aisubtitle.hdslb.com/a.json')).toBe('https://aisubtitle.hdslb.com/a.json');
    expect(normalizeSubtitleUrl('https://aisubtitle.hdslb.com/a.json')).toBe('https://aisubtitle.hdslb.com/a.json');
    expect(normalizeSubtitleUrl('')).toBe('');
  });
});

describe('parseSubtitleTrack / parseSubtitleTracks', () => {
  it('ai_type 判 AI（1=AI，0=UP 主）', () => {
    expect(parseSubtitleTrack({ subtitle_url: '//h/x.json', lan: 'ai-zh', ai_type: 1 })).toMatchObject({ ai: true, url: 'https://h/x.json' });
    expect(parseSubtitleTrack({ subtitle_url: '//h/x.json', lan: 'zh-CN', ai_type: 0 })).toMatchObject({ ai: false });
  });

  it('ai_type 缺失时以 ai_status=1 兜底判 AI', () => {
    expect(parseSubtitleTrack({ subtitle_url: '//h/x.json', ai_status: 1 })).toMatchObject({ ai: true });
    expect(parseSubtitleTrack({ subtitle_url: '//h/x.json', ai_status: 0 })).toMatchObject({ ai: false });
  });

  it('subtitle_url 缺失视为无效轨返回 null；非记录返回 null', () => {
    expect(parseSubtitleTrack({ lan: 'zh-CN' })).toBeNull();
    expect(parseSubtitleTrack(null)).toBeNull();
    expect(parseSubtitleTrack('x')).toBeNull();
  });

  it('data.subtitle.subtitles 缺失/非数组一律为空列表', () => {
    expect(parseSubtitleTracks({ subtitle: { subtitles: [{ subtitle_url: '//h/x.json' }] } })).toHaveLength(1);
    expect(parseSubtitleTracks({})).toEqual([]);
    expect(parseSubtitleTracks({ subtitle: {} })).toEqual([]);
    expect(parseSubtitleTracks(null)).toEqual([]);
  });
});

describe('pickSubtitleTrack 选轨口径', () => {
  it('UP 主字幕优先于 AI 字幕（即使 AI 是中文、UP 主是英文）', () => {
    const picked = pickSubtitleTrack([
      track({ lan: 'zh-CN', lanDoc: '中文（机器翻译）', ai: true }),
      track({ lan: 'en-US', lanDoc: 'English (uploader)', ai: false }),
    ]);
    expect(picked?.ai).toBe(false);
    expect(picked?.lan).toBe('en-US');
  });

  it('同为 UP 主时 zh/中文优先；lan 不带 zh 但语言名含「中文」也算中文', () => {
    expect(pickSubtitleTrack([track({ lan: 'en-US', lanDoc: 'English' }), track({ lan: 'zh-Hans' })])?.lan).toBe('zh-Hans');
    expect(pickSubtitleTrack([track({ lan: 'en-US', lanDoc: 'English' }), track({ lan: 'cmn', lanDoc: '中文（简体）' })])?.lan).toBe('cmn');
  });

  it('同为 AI 字幕时同样 zh 优先', () => {
    const picked = pickSubtitleTrack([
      track({ lan: 'en-US', lanDoc: 'English (AI)', ai: true }),
      track({ lan: 'ai-zh', ai: true, lanDoc: '中文（自动识别）' }),
    ]);
    expect(picked?.lan).toBe('ai-zh');
    expect(picked?.ai).toBe(true);
  });

  it('其余保持接口返回顺序（稳定兜底）；空列表返回 null', () => {
    expect(pickSubtitleTrack([track({ lan: 'ko', lanDoc: '한국어' }), track({ lan: 'ja', lanDoc: '日本語' })])?.lan).toBe('ko');
    expect(pickSubtitleTrack([])).toBeNull();
  });

  it('isChineseSubtitle：zh 前缀与「中文」名称两条路径', () => {
    expect(isChineseSubtitle(track({ lan: 'zh-TW' }))).toBe(true);
    expect(isChineseSubtitle(track({ lan: 'zh' }))).toBe(true);
    expect(isChineseSubtitle(track({ lan: 'en', lanDoc: '中文' }))).toBe(true);
    expect(isChineseSubtitle(track({ lan: 'en', lanDoc: 'English' }))).toBe(false);
  });
});

describe('parseSubtitleSegments 秒映射与 coverage', () => {
  it('from/to/content（秒）直接映射为仓库 segments（仓库 s/e 单位即秒，不换算）', () => {
    const { segments } = parseSubtitleSegments({ body: [{ from: 1.2, to: 3.4, content: '第一句' }] });
    expect(segments).toEqual([{ s: 1.2, e: 3.4, text: '第一句' }]);
  });

  it('无 content / 时间缺失的行跳过；to<from 收口到 from；乱序输入按 from 排序', () => {
    const { segments } = parseSubtitleSegments({
      body: [
        { from: 9, to: 11, content: '后句' },
        { from: 2, to: 1, content: '脏数据收口' },
        { from: 1, to: 2 },
        { to: 3, content: '缺 from' },
        'junk',
        { from: 1, to: 2, content: '前句' },
      ],
    });
    expect(segments).toEqual([
      { s: 1, e: 2, text: '前句' },
      { s: 2, e: 2, text: '脏数据收口' },
      { s: 9, e: 11, text: '后句' },
    ]);
  });

  it('coverage 为有文字区间并集（相邻重叠合并），coveredSec 为区间长度和', () => {
    const { coverage, coveredSec } = parseSubtitleSegments({
      body: [
        { from: 0, to: 5, content: 'a' },
        { from: 5, to: 8, content: 'b' },
        { from: 20, to: 30, content: 'c' },
      ],
    });
    expect(coverage).toEqual([
      { start: 0, end: 8 },
      { start: 20, end: 30 },
    ]);
    expect(coveredSec).toBeCloseTo(18, 10);
  });

  it('容忍直接给数组；空 body 返回空段', () => {
    expect(parseSubtitleSegments([{ from: 0, to: 1, content: 'x' }]).segments).toHaveLength(1);
    expect(parseSubtitleSegments({ body: [] })).toEqual({ segments: [], coverage: [], coveredSec: 0 });
    expect(parseSubtitleSegments(null).segments).toEqual([]);
  });
});

describe('mergeCoverage', () => {
  it('合并重叠与相接区间，丢弃空段，保持 start 升序', () => {
    expect(mergeCoverage([{ start: 5, end: 9 }, { start: 0, end: 6 }, { start: 3, end: 3 }, { start: 12, end: 12 }])).toEqual([
      { start: 0, end: 9 },
    ]);
    expect(mergeCoverage([])).toEqual([]);
  });
});

describe('resolvePageCid 分 P 映射', () => {
  const pages = [{ cid: 11, duration: 100 }, { cid: 22, duration: 200 }, { cid: 33, duration: 300 }];

  it('p 从 1 计取对应分 P；时长转 durationSec', () => {
    expect(resolvePageCid(pages, 1)).toEqual({ cid: 11, durationSec: 100 });
    expect(resolvePageCid(pages, 2)).toEqual({ cid: 22, durationSec: 200 });
  });

  it('p 越界回退最后一个分 P；非法 p 回退 P1', () => {
    expect(resolvePageCid(pages, 99)?.cid).toBe(33);
    expect(resolvePageCid(pages, 0)?.cid).toBe(11);
    expect(resolvePageCid(pages, Number.NaN)?.cid).toBe(11);
  });

  it('无分页 / cid 缺失返回 null；duration 非法为 null', () => {
    expect(resolvePageCid([], 1)).toBeNull();
    expect(resolvePageCid('x', 1)).toBeNull();
    expect(resolvePageCid([{ duration: 5 }], 1)).toBeNull();
    expect(resolvePageCid([{ cid: 1 }], 1)).toEqual({ cid: 1, durationSec: null });
    expect(resolvePageCid([{ cid: 1, duration: -2 }], 1)).toEqual({ cid: 1, durationSec: null });
  });
});

describe('fetchBiliSubtitle 全链路（注入 fetch + wbi key）', () => {
  const PAGES_OK = { code: 0, data: [{ cid: 42, duration: 600 }] };
  const PLAYER_OK = {
    code: 0,
    data: { subtitle: { subtitles: [{ subtitle_url: '//aisubtitle.hdslb.com/sub.json', lan: 'zh-CN', lan_doc: '中文', ai_type: 0 }] } },
  };
  const BODY_OK = { body: [{ from: 1.5, to: 4, content: '第一句' }, { from: 4, to: 8.2, content: '第二句' }] };

  function deps(fetchImpl: typeof fetch) {
    return { deps: { fetchImpl, getWbiKeys: async () => KEYS } };
  }

  it('subtitles 为空 → status none（无字幕作罢，不抛错）', async () => {
    const recorded: string[] = [];
    const fetchImpl = makeFetchImpl({ [PAGELIST]: PAGES_OK, [PLAYER]: { code: 0, data: { subtitle: { subtitles: [] } } } }, recorded);
    const result = await fetchBiliSubtitle('BV1xx411c7mD', deps(fetchImpl));
    expect(result).toEqual({ status: 'none' });
  });

  it('完整链路：pagelist cid → wbi 签名 player 接口 → 拉字幕 JSON → 秒映射', async () => {
    const recorded: string[] = [];
    const fetchImpl = makeFetchImpl({ [PAGELIST]: PAGES_OK, [PLAYER]: PLAYER_OK, [SUBTITLE_JSON]: BODY_OK }, recorded);
    const result = await fetchBiliSubtitle('BV1xx411c7mD', deps(fetchImpl));

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.cid).toBe(42);
    expect(result.durationSec).toBe(600);
    expect(result.lan).toBe('zh-CN');
    expect(result.lanDoc).toBe('中文');
    expect(result.ai).toBe(false);
    expect(result.segments).toEqual([
      { s: 1.5, e: 4, text: '第一句' },
      { s: 4, e: 8.2, text: '第二句' },
    ]);
    expect(result.coverage).toEqual([{ start: 1.5, end: 8.2 }]);
    expect(result.coveredSec).toBeCloseTo(6.7, 10);

    // 请求形状：pagelist 带 bvid；player/wbi/v2 带 bvid+cid+wts+w_rid（wbi 签名生效）；字幕 JSON 走 https
    expect(recorded[0]).toBe(`${PAGELIST}?bvid=BV1xx411c7mD`);
    const playerUrl = new URL(recorded[1] ?? '');
    expect(recorded[1]).toContain(PLAYER);
    expect(playerUrl.searchParams.get('bvid')).toBe('BV1xx411c7mD');
    expect(playerUrl.searchParams.get('cid')).toBe('42');
    expect(Number(playerUrl.searchParams.get('wts'))).toBeGreaterThan(0);
    expect(playerUrl.searchParams.get('w_rid')).toMatch(/^[0-9a-f]{32}$/);
    expect(recorded[2]).toBe(SUBTITLE_JSON);
  });

  it('字幕 JSON 有轨但无有效正文 → 作罢返回 none', async () => {
    const recorded: string[] = [];
    const fetchImpl = makeFetchImpl({ [PAGELIST]: PAGES_OK, [PLAYER]: PLAYER_OK, [SUBTITLE_JSON]: { body: [{ to: 2, content: '缺 from' }] } }, recorded);
    expect(await fetchBiliSubtitle('BV1xx411c7mD', deps(fetchImpl))).toEqual({ status: 'none' });
  });

  it('多 P：p 参数映射到对应分 P 的 cid', async () => {
    const recorded: string[] = [];
    const fetchImpl = makeFetchImpl(
      { [PAGELIST]: { code: 0, data: [{ cid: 11 }, { cid: 22 }] }, [PLAYER]: PLAYER_OK, [SUBTITLE_JSON]: BODY_OK },
      recorded,
    );
    const result = await fetchBiliSubtitle('BV1xx411c7mD', { ...deps(fetchImpl), p: 2 });
    expect(result.status === 'ok' && result.cid).toBe(22);
    expect(new URL(recorded[1] ?? '').searchParams.get('cid')).toBe('22');
  });

  it.each([-412, -352, -799])('风控码 %d → BILI_API_FAILED 且可重试（带中文语义提示）', async (code) => {
    const fetchImpl = makeFetchImpl({ [PAGELIST]: PAGES_OK, [PLAYER]: { code, message: 'risk control' } }, []);
    const err = await fetchBiliSubtitle('BV1xx411c7mD', deps(fetchImpl)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    const appErr = err as AppError;
    expect(appErr.code).toBe('BILI_API_FAILED');
    expect(appErr.retryable).toBe(true);
    // -352/-412 为「风控拦截」、-799 为「请求过于频繁」，均为 apiClient 预置中文提示
    expect(appErr.userMessage).toContain('B 站');
    expect(appErr.userMessage).not.toMatch(/code /);
  });

  it('非风控业务码（-101 未登录）不可重试；pagelist code!=0 同样抛 BILI_API_FAILED', async () => {
    const fetchImpl = makeFetchImpl({ [PAGELIST]: PAGES_OK, [PLAYER]: { code: -101, message: '账号未登录' } }, []);
    const err = (await fetchBiliSubtitle('BV1xx411c7mD', deps(fetchImpl)).catch((e: unknown) => e)) as AppError;
    expect(err.code).toBe('BILI_API_FAILED');
    expect(err.retryable).toBe(false);

    const badList = makeFetchImpl({ [PAGELIST]: { code: -404, message: '啥都没有' } }, []);
    const err2 = (await fetchBiliSubtitle('BV1xx411c7mD', deps(badList)).catch((e: unknown) => e)) as AppError;
    expect(err2.code).toBe('BILI_API_FAILED');
    expect(err2.retryable).toBe(false);
  });

  it('pagelist 无有效分 P → BILI_API_FAILED（可重试）', async () => {
    const fetchImpl = makeFetchImpl({ [PAGELIST]: { code: 0, data: [] } }, []);
    const err = (await fetchBiliSubtitle('BV1xx411c7mD', deps(fetchImpl)).catch((e: unknown) => e)) as AppError;
    expect(err.code).toBe('BILI_API_FAILED');
    expect(err.retryable).toBe(true);
  });

  it('bvid 不合法抛 INVALID_INPUT（不发起任何请求）', async () => {
    const recorded: string[] = [];
    const fetchImpl = makeFetchImpl({}, recorded);
    const err = (await fetchBiliSubtitle('abc', deps(fetchImpl)).catch((e: unknown) => e)) as AppError;
    expect(err.code).toBe('INVALID_INPUT');
    expect(recorded).toEqual([]);
  });
});

describe('字幕安全加固（第 15 轮：CDN 域白名单 P2-1 / 负时间戳 P3-1）', () => {
  it('assertSubtitleCdnUrl：官方 .hdslb.com 子域放行', () => {
    expect(() => assertSubtitleCdnUrl('https://aisubtitle.hdslb.com/sub.json')).not.toThrow();
    expect(() => assertSubtitleCdnUrl('https://i0.hdslb.com/nested/path.json')).not.toThrow();
  });

  it('assertSubtitleCdnUrl：非官方域与畸形 URL 拒绝（不可重试）', () => {
    for (const url of [
      'https://example.com/sub.json',
      'https://course.hdu.edu.cn/sub.json',
      'https://hdslb.com.evil.test/sub.json',
      'not-a-url',
      '',
    ]) {
      const err = (() => {
        try {
          assertSubtitleCdnUrl(url);
          return null;
        } catch (e) {
          return e as AppError;
        }
      })();
      expect(err?.code, url).toBe('BILI_API_FAILED');
      expect(err?.retryable, url).toBe(false);
    }
  });

  it('全链路：subtitle_url 指向非官方域 → 拦截且不发起该次 fetch', async () => {
    const PAGES_OK = { code: 0, data: [{ cid: 42 }] };
    const PLAYER_EVIL = {
      code: 0,
      data: { subtitle: { subtitles: [{ subtitle_url: 'https://example.com/evil.json', lan: 'zh-CN', lan_doc: '中文', ai_type: 0 }] } },
    };
    const recorded: string[] = [];
    const fetchImpl = makeFetchImpl(
      { [PAGELIST]: PAGES_OK, [PLAYER]: PLAYER_EVIL, 'https://example.com': { body: [] } },
      recorded,
    );
    const err = (await fetchBiliSubtitle('BV1xx411c7mD', {
      deps: { fetchImpl, getWbiKeys: async () => KEYS },
    }).catch((e: unknown) => e)) as AppError;
    expect(err.code).toBe('BILI_API_FAILED');
    expect(err.retryable).toBe(false);
    // 只发出 pagelist + player 两发，恶意 subtitle_url 未被请求
    expect(recorded.length).toBe(2);
    expect(recorded.every((url) => !url.includes('example.com'))).toBe(true);
  });

  it('parseSubtitleSegments：from < 0 的行丢弃（防 coverage 虚增）', () => {
    const { segments, coverage, coveredSec } = parseSubtitleSegments({
      body: [
        { from: -5, to: 3, content: '负起点脏数据' },
        { from: 10, to: 14, content: '正常句' },
      ],
    });
    expect(segments).toEqual([{ s: 10, e: 14, text: '正常句' }]);
    expect(coverage).toEqual([{ start: 10, end: 14 }]);
    expect(coveredSec).toBeCloseTo(4, 10);
  });
});
