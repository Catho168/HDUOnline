/**
 * 本地模拟站点服务（E2E / 人工验收用；**不含任何真实课程数据与凭据**）。
 *
 * 提供：
 *  - 静态文件：player-sim.html、play-center-sim.html、sample.mp4（如存在）
 *  - 模拟站点接口：/jy-application-resourcemanage/v1/*（数据结构与 §3.2 清单一致）
 *  - Range 支持：供转写管线（音轨样本区间拉取）与截图取流验证
 *  - CORS：内容脚本/扩展页面跨源读取模拟接口与媒体
 *
 * 用法：
 *   node tests/fixtures/serve.mjs            # 默认 http://127.0.0.1:8788
 *   node tests/fixtures/serve.mjs --port=9000
 *
 * 说明：
 *  - 官方不提供视频素材；若要验证转写全链路，请自行放置 `tests/fixtures/sample.mp4`
 *    （建议 30 秒左右的短片段，勿提交到仓库）；
 *  - 页面中若未提供 sample.mp4，会自动使用 canvas 合成画面，仍可验证 seek / 截图 / 统计。
 *  - 所有 ID、时间、人名、地址均为占位值；媒体地址不携带任何真实签名。
 */

import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const portArg = process.argv.find((arg) => arg.startsWith('--port='));
export const PORT = portArg ? Number(portArg.split('=')[1]) : 8788;

const API_PREFIX = '/jy-application-resourcemanage';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ───────────────────────── 模拟数据（占位值，非真实课程） ─────────────────────────

/** 使用本地时区构造时间，保证与模拟页面上可读的日期时间完全一致 */
function localMs(year, month, day, hour, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

const VOD_TIME = 2820; // 47 分钟

const COURSES = {
  9001: {
    subjName: '线性代数（模拟课程）',
    subjCode: 'MATH1001',
    teclCode: 'TECL-9001',
    clroName: '第3教学楼 201',
    teacherNames: ['模拟教师'],
    semester: '2026-2027-1',
  },
};

/**
 * 课次列表：`courBeginTime` 必须与 play-center-sim.html 中被选中条目的
 * `.time` 文本（2026-10-12 18:00）对齐——这是 `sessionResolve` 的 DOM 时间对齐依据。
 */
const SESSIONS = [
  {
    id: 1227036,
    courBeginTime: localMs(2026, 9, 28, 18, 0),
    letiNumber: 10,
    letyName: '第3教学楼',
    clroName: '201',
    vodStatus: 1,
  },
  {
    id: 1227037,
    courBeginTime: localMs(2026, 10, 5, 18, 0),
    letiNumber: 11,
    letyName: '第3教学楼',
    clroName: '201',
    vodStatus: 1,
  },
  {
    id: 1227038,
    courBeginTime: localMs(2026, 10, 12, 18, 0),
    letiNumber: 12,
    letyName: '第3教学楼',
    clroName: '201',
    vodStatus: 1,
  },
];

function sampleUrl(view, baseUrl = `http://127.0.0.1:${PORT}`) {
  return `${baseUrl}/sample.mp4?view=${view}`;
}

function sessionsPayload(courseId, baseUrl = `http://127.0.0.1:${PORT}`) {
  const base = `${baseUrl}/sample.mp4`;
  const views = [
    { vodId: 7363, viewNum: 1, name: '教师1', url: `${base}?view=1`, vodTime: VOD_TIME },
    { vodId: 7364, viewNum: 2, name: 'PPT', url: `${base}?view=2`, vodTime: VOD_TIME },
    { vodId: 7366, viewNum: 3, name: '教师2', url: `${base}?view=3`, vodTime: VOD_TIME },
  ];
  const session = SESSIONS.find((item) => String(item.id) === String(courseId)) ?? SESSIONS[2];
  return {
    courId: session.id,
    teclId: 9001,
    courName: COURSES[9001].subjName,
    subjCode: COURSES[9001].subjCode,
    classRoomName: COURSES[9001].clroName,
    teacherNames: COURSES[9001].teacherNames,
    courBeginTime: session.courBeginTime,
    courEndTime: session.courBeginTime + VOD_TIME * 1000,
    letiNumber: session.letiNumber,
    letiName: session.letyName,
    vodTime: VOD_TIME,
    lastPlayTime: 30,
    courseVodViewList: views,
  };
}

/** 模拟接口路由（与 §3.2 清单一致；只实现"读"接口） */
function handleApi(pathname, searchParams, baseUrl = `http://127.0.0.1:${PORT}`) {
  if (pathname === `${API_PREFIX}/v1/currentuser`) {
    return { code: '0', data: { realName: '模拟学生', roleType: 1 } };
  }
  if (pathname === `${API_PREFIX}/v1/course_vod_urls_new`) {
    return { code: '0', data: sessionsPayload(searchParams.get('courseId'), baseUrl) };
  }
  if (pathname === `${API_PREFIX}/v1/subject_vod_list_new`) {
    return {
      code: '0',
      data: {
        records: SESSIONS.map((session) => ({
          id: session.id,
          courBeginTime: session.courBeginTime,
          courEndTime: session.courBeginTime + VOD_TIME * 1000,
          letiNumber: session.letiNumber,
          letyName: session.letyName,
          clroName: session.clroName,
          vodStatus: session.vodStatus,
          vodDisplayStatus: 1,
          noteFlag: false,
        })),
      },
    };
  }
  if (pathname === `${API_PREFIX}/v1/course_vod_videoinfos`) {
    return { code: '0', data: { openType: '直播、生成点播', message: '（模拟）' } };
  }
  if (pathname === `${API_PREFIX}/v1/source/vod/lastPlayInfoByTeclCode`) {
    return {
      code: '0',
      data: {
        courseId: 1227038,
        playTime: 30,
        vodUrls: [sampleUrl(1, baseUrl), sampleUrl(2, baseUrl), sampleUrl(3, baseUrl)],
      },
    };
  }
  if (pathname.startsWith(`${API_PREFIX}/v1/teachingClass/`)) {
    return {
      code: '0',
      data: {
        subjName: COURSES[9001].subjName,
        clroName: COURSES[9001].clroName,
        memberCount: 60,
      },
    };
  }
  if (pathname === `${API_PREFIX}/v1/group_subject_vod_list/t-1`) {
    return {
      code: '0',
      data: [
        {
          teclId: 9001,
          subjName: COURSES[9001].subjName,
          subjCode: COURSES[9001].subjCode,
          teclCode: COURSES[9001].teclCode,
          clroName: COURSES[9001].clroName,
          teacherNames: COURSES[9001].teacherNames,
          courTimes: SESSIONS.length,
        },
      ],
    };
  }
  if (pathname.startsWith(`${API_PREFIX}/v1/course/note/`)) {
    return { code: '0', data: [] };
  }
  if (pathname.startsWith(`${API_PREFIX}/v1/vod/`) && pathname.endsWith('/getCollection')) {
    return { code: '0', data: false };
  }
  if (pathname === `${API_PREFIX}/v1/myself/curriculum`) {
    return {
      code: '0',
      data: SESSIONS.map((session) => ({
        id: session.id,
        teclId: 9001,
        subjName: COURSES[9001].subjName,
        courBeginTime: session.courBeginTime,
        courEndTime: session.courBeginTime + VOD_TIME * 1000,
        clroName: COURSES[9001].clroName,
        letiNumber: session.letiNumber,
        courseStatus: '已结束',
      })),
    };
  }
  if (pathname === `${API_PREFIX}/v1/list/termYear`) {
    return { code: '0', data: [{ acteId: 9, termYear: '2026-2027-1' }] };
  }
  // 未实现的接口返回空数据（插件应静默降级）
  return { code: '0', data: null };
}

// ───────────────────────── CORS / HTTP ─────────────────────────

function applyCors(req, res, credentials = false) {
  const origin = req.headers.origin;
  if (credentials && origin) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('vary', 'Origin');
  } else {
    res.setHeader('access-control-allow-origin', '*');
  }
  res.setHeader('access-control-allow-methods', 'GET, HEAD, OPTIONS');
  res.setHeader('access-control-allow-headers', 'range, content-type, accept');
  res.setHeader('access-control-expose-headers', 'content-length, content-range, accept-ranges');
}

async function serveFile(req, res, filePath, corsOptions) {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  if (!info.isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.range;
  applyCors(req, res, corsOptions);

  if (range && /^bytes=/.test(range)) {
    // 支持 open / 闭区间 / 后缀区间三种 Range 形式（转写管线依赖）
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    let start = match && match[1] ? Number(match[1]) : undefined;
    let end = match && match[2] ? Number(match[2]) : undefined;
    if (start === undefined && end !== undefined) {
      // 后缀区间：bytes=-N（最后 N 字节）
      start = Math.max(0, info.size - end);
      end = info.size - 1;
    }
    start = start ?? 0;
    end = Math.min(end ?? info.size - 1, info.size - 1);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= info.size) {
      res.writeHead(416, { 'content-range': `bytes */${info.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'content-type': type,
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${info.size}`,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    'content-type': type,
    'content-length': info.size,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

export function createFixtureServer() {
  return createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      applyCors(req, res, true);
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);

    if (url.pathname.startsWith(API_PREFIX)) {
      const baseUrl = `http://${req.headers.host ?? `127.0.0.1:${PORT}`}`;
      const payload = handleApi(url.pathname, url.searchParams, baseUrl);
      const body = JSON.stringify(payload);
      applyCors(req, res, true);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      });
      if (req.method === 'HEAD') res.end();
      else res.end(body);
      return;
    }

    // `/` 默认打开新版播放页；旧版仍可直接访问
    const relative = url.pathname === '/' ? '/play-center-sim.html' : url.pathname;
    const filePath = resolve(root, '.' + relative);
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    await serveFile(req, res, filePath, false);
  });
}

/** 命令行启动（被 import 时不自动监听，便于测试） */
export function startFixtureServer(port = PORT) {
  const server = createFixtureServer();
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolvePromise({ server, port });
    });
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startFixtureServer()
    .then(({ port }) => {
      const base = `http://127.0.0.1:${port}`;
      process.stdout.write(
        [
          '模拟站点服务已启动：',
          `  新版播放页（#/play-center，URL 不含课次）：${base}/play-center-sim.html#/play-center?teclId=9001&teclCode=TECL-9001&subjId=1573&target=video`,
          `  旧版播放页：${base}/player-sim.html#/video-detail?teclId=9001&courseId=1227038`,
          `  学习中心接管验证：在模拟页把 hash 换成 #/home 或 #/list-video`,
          `  接口前缀：${base}${API_PREFIX}/v1/...`,
          '',
          '提示：',
          '  · `npm run dev` 的开发构建已额外匹配 http://127.0.0.1/* 与 http://localhost/*（生产构建不含），',
          '    因此可直接用开发版扩展打开上面的模拟页做端到端联调，无需修改 hosts。',
          '  · 若要验证转写全链路，请自备 tests/fixtures/sample.mp4（勿入库）。',
          '  · 截图/转写对 sample.mp4 发起 Range 请求时，本服务同时返回 CORS 头。',
          '',
        ].join('\n'),
      );
    })
    .catch((err) => {
      process.stderr.write(`模拟服务启动失败：${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}

export { API_PREFIX, root, SESSIONS, COURSES, VOD_TIME };
export const fixtureEntryUrl = pathToFileURL(join(root, 'play-center-sim.html')).href;
