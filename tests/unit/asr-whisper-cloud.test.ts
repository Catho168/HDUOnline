/** transcribeChunkDetailed 云端分支测试：静音跳过不上传、取消中断在途请求、绝对时间戳。 */

import { describe, expect, it } from 'vitest';
import { transcribeChunkDetailed } from '@/core/asr/whisper';
import { AppError } from '@/core/shared/errors';

const CFG = { baseUrl: 'https://asr.example.com', apiKey: 'sk-test-not-a-real-key', model: 'test-model' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type MockFetch = typeof fetch & { calls: Array<[string, RequestInit]> };

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response): MockFetch {
  const calls: Array<[string, RequestInit]> = [];
  const fn = (async (url: unknown, init?: RequestInit) => {
    const requestInit = init ?? ({} as RequestInit);
    calls.push([String(url), requestInit]);
    return impl(String(url), requestInit);
  }) as MockFetch;
  fn.calls = calls;
  return fn;
}

/** 非静音 PCM：恒定小幅值正弦 */
function tonePcm(seconds: number, rate = 16_000): Float32Array {
  const pcm = new Float32Array(Math.floor(seconds * rate));
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / rate);
  return pcm;
}

describe('transcribeChunkDetailed · 云端分支', () => {
  it('未加载本地模型也可云端转写（不抛 ASR_MODEL_MISSING）', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({ text: '你好', segments: [{ start: 0, end: 2, text: '你好' }] }),
    );
    // Node 测试环境没有本地模型：能走完即说明 cloud 分支不依赖 cached 管线
    const result = await transcribeChunkDetailed(tonePcm(3), {
      offsetSec: 0,
      lang: 'zh',
      cloud: { cfg: CFG, fetchImpl },
    });
    expect(result.segments.length).toBeGreaterThan(0);
  });

  it('静音切片不发出任何云端请求', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ text: '不应到达' }));
    const result = await transcribeChunkDetailed(new Float32Array(16_000 * 2), {
      offsetSec: 0,
      lang: 'zh',
      cloud: { cfg: CFG, fetchImpl },
    });
    expect(fetchImpl.calls).toHaveLength(0);
    expect(result.segments).toEqual([]);
    expect(result.stats.silentSec).toBeCloseTo(2, 3);
  });

  it('返回段落为整节课绝对时间戳（offsetSec + 切片内偏移）', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({
        text: '同学们好',
        segments: [{ start: 1, end: 3, text: '同学们好' }],
      }),
    );
    const result = await transcribeChunkDetailed(tonePcm(5), {
      offsetSec: 600,
      lang: 'zh',
      cloud: { cfg: CFG, fetchImpl },
    });
    expect(fetchImpl.calls).toHaveLength(1);
    expect(result.segments).toEqual([{ s: 601, e: 603, text: '同学们好' }]);
    expect(result.stats.speechSec).toBeCloseTo(5, 3);
    expect(result.stats.segmentCount).toBe(1);
  });

  it('取消时 AbortController 生效：在途请求被中止并抛 ASR_CANCELLED', async () => {
    const fetchImpl = mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    let stopChecks = 0;
    await expect(
      transcribeChunkDetailed(tonePcm(125), {
        offsetSec: 0,
        lang: 'zh',
        cloud: { cfg: CFG, fetchImpl },
        // 前两次检查放行（进入切片与首个 watcher 周期），之后永久取消
        shouldStop: () => (++stopChecks > 2 ? 'cancel' : 'none'),
      }),
    ).rejects.toMatchObject({ code: 'ASR_CANCELLED' });
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('云端鉴权失败原样上抛 ASR_AUTH_FAILED（不包成 ASR_INFER_FAILED）', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ error: { message: 'invalid key' } }, 401));
    try {
      await transcribeChunkDetailed(tonePcm(2), {
        offsetSec: 0,
        lang: 'zh',
        cloud: { cfg: CFG, fetchImpl },
      });
      expect.unreachable('应抛出 ASR_AUTH_FAILED');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('ASR_AUTH_FAILED');
    }
  });

  it('无 cloud 配置且未加载模型时仍抛 ASR_MODEL_MISSING', async () => {
    await expect(
      transcribeChunkDetailed(tonePcm(1), { offsetSec: 0, lang: 'zh' }),
    ).rejects.toMatchObject({ code: 'ASR_MODEL_MISSING' });
  });
});
