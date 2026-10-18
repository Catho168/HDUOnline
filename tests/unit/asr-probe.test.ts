/**
 * MP4 音轨探测的回归测试。
 *
 * 背景：真实 47 分钟录播的 moov 约 2.4MB，固定“头 256KB + 尾 2MB”探测会失败，
 * 进而错误地触发整文件兜底（并被 400MB 护栏拒绝）。这里用 ffmpeg 生成两种
 * 典型布局（moov 在头 / moov 在尾），并把单次探测窗口调小，验证按
 * `appendBuffer()` 返回的下一段偏移迭代读取可以正确解析。
 *
 * ffmpeg 不可用时跳过（不阻塞常规单测）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { probeAudioTrack } from '@/core/asr/mp4';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const describeIfFfmpeg = hasFfmpeg ? describe : describe.skip;

describeIfFfmpeg('probeAudioTrack（分段迭代）', () => {
  let server: http.Server;
  let baseUrl = '';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdu-probe-'));
  const files: Record<'head' | 'tail', string> = {
    head: path.join(dir, 'head.mp4'),
    tail: path.join(dir, 'tail.mp4'),
  };

  beforeAll(async () => {
    for (const [name, faststart] of [
      ['head', true],
      ['tail', false],
    ] as const) {
      const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=64x48:r=30:d=10',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=48000:cl=mono',
        '-t',
        '10',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '32k',
        '-y',
        ...(faststart ? ['-movflags', '+faststart'] : []),
        files[name],
      ];
      const result = spawnSync('ffmpeg', args, { stdio: 'ignore' });
      if (result.status !== 0) throw new Error(`ffmpeg 生成 ${name} 失败`);
    }

    server = http.createServer((req, res) => {
      const name = (req.url ?? '')
        .replace(/^\//, '')
        .split('?')[0]
        ?.replace(/\.mp4$/, '') as 'head' | 'tail';
      const file = files[name];
      if (!file) {
        res.writeHead(404);
        res.end();
        return;
      }
      const size = fs.statSync(file).size;
      const range = req.headers.range;
      if (!range) {
        res.writeHead(200, { 'content-length': size, 'accept-ranges': 'bytes' });
        fs.createReadStream(file).pipe(res);
        return;
      }
      const matched = range.match(/bytes=(\d+)-(\d*)/);
      const start = Number(matched?.[1] ?? 0);
      const end = matched?.[2] ? Math.min(Number(matched[2]), size - 1) : size - 1;
      res.writeHead(206, {
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${size}`,
        'accept-ranges': 'bytes',
      });
      fs.createReadStream(file, { start, end }).pipe(res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  for (const layout of ['head', 'tail'] as const) {
    it(`moov 在${layout === 'head' ? '头' : '尾'}部时可解析音轨样本`, async () => {
      const probe = await probeAudioTrack(`${baseUrl}/${layout}.mp4`, undefined, {
        // 故意小于 moov 体积，确保走“继续拉取下一段”的路径
        chunkBytes: 1024,
      });
      const size = fs.statSync(files[layout]).size;
      expect(probe.fileSize).toBe(size);
      expect(probe.info.codec).toContain('mp4a');
      expect(probe.info.sampleRate).toBe(48000);
      expect(probe.info.durationSec).toBeGreaterThan(9.5);
      expect(probe.info.durationSec).toBeLessThan(10.5);
      expect(probe.samples.length).toBeGreaterThan(0);
      expect(probe.audioBytes).toBeGreaterThan(0);
      expect(probe.ranges.length).toBeGreaterThan(0);
      // AAC 的 AudioSpecificConfig 是 WebCodecs AudioDecoder.configure 的必需参数
      expect(probe.info.asc?.byteLength).toBeGreaterThan(0);
    });
  }
});
