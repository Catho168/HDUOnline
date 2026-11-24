/**
 * HDUOnline 宣传片素材采集（video-shotcraft 阶段 4）。
 *
 * 链路（与 scripts/e2e-smoke.mjs 同款，已验证）：fixture 模拟站点（假数据接口）
 *   + dev 构建扩展（headless Chrome + CDP Extensions.loadUnpacked）
 *   + 扩展 IndexedDB 预置虚构演示数据 → 真实渲染 UI → 2x 截图。
 * 全部数据为本地 fixture 与脚本预置的假数据，不触达真实账号/站点。
 *
 * 用法：node capture.mjs [--only hdu|player|bili]
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const EXT_DIR = join(repo, '.output', 'chrome-mv3-dev');
const FIXTURE = join(repo, 'tests', 'fixtures', 'serve.mjs');
const BILI_FIXTURE_HTML = readFileSync(join(repo, 'tests', 'fixtures', 'bili-video-sim.html'), 'utf8');
const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = join(here, 'out');
mkdirSync(OUT, { recursive: true });

const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : 'all';
const BILI_VID = 'BV1E2E00100';
const COUR_ID = 1227038;
const TECL_ID = 9001;
const HDU_KEY = `hdu:${COUR_ID}`;
const BILI_KEY = `bili:${BILI_VID}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────────────────────── 假数据（全部虚构，线性代数演示课） ───────────────────────── */
const now = Date.now();
const dayKey = (offsetDays = 0) => {
  const d = new Date(now - offsetDays * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const ts = (offsetDays, hour = 19, min = 30) => {
  const d = new Date(now - offsetDays * 86400000);
  d.setHours(hour, min, 0, 0);
  return d.getTime();
};

const SEGMENTS = [
  [0, 42, '大家好，今天我们进入第三章：矩阵的运算。'],
  [42, 96, '先回顾一下矩阵的定义：m 行 n 列的数表，记作 A。'],
  [96, 168, '矩阵乘法的定义：A 是 m×n 矩阵，B 是 n×p 矩阵，乘积 C=AB 的第 i 行第 j 列元素，等于 A 的第 i 行与 B 的第 j 列的对应乘积之和。'],
  [168, 235, '注意，矩阵乘法要求左边的列数等于右边的行数，这是可乘的前提条件。'],
  [235, 320, '重点来了：矩阵乘法不满足交换律。举一个二阶矩阵的反例，AB 和 BA 算出来是两个不同的矩阵。'],
  [320, 388, '但是结合律和分配律是成立的，即 (AB)C = A(BC)，这个在证明题里会反复用到。'],
  [388, 465, '接下来看单位矩阵 E：任何矩阵乘以单位矩阵都保持不变，它在矩阵运算里的地位相当于数字 1。'],
  [465, 540, '下面介绍矩阵的转置：把行变成列。转置有一个重要性质：(AB)ᵀ = BᵀAᵀ，注意顺序要反过来。'],
  [540, 625, '如果两个矩阵相乘等于单位矩阵，我们就说它们互为逆矩阵，记作 A⁻¹。'],
  [625, 700, '可逆的充要条件是行列式不等于零，这是本章最重要的判定之一。'],
  [700, 780, '逆矩阵的求法：伴随矩阵除以行列式，二阶矩阵有非常简洁的口诀。'],
  [780, 860, '最后引入特征值：如果 Av = λv，v 是非零向量，那么 λ 就叫特征值，v 是对应的特征向量。'],
  [860, 940, '特征方程是 |A−λE| = 0，解这个多项式方程就能得到全部特征值。'],
  [940, 1020, '特征值的几何直观：它描述线性变换中方向不变的那些方向，缩放的比例就是特征值。'],
  [1020, 1105, '下一节我们讲相似对角化，预习时请思考：什么样的矩阵可以对角化？下课。'],
];

const seed = {
  transcripts: [
    {
      mediaKey: HDU_KEY,
      segments: SEGMENTS.map(([s, e, text]) => ({ s, e, text })),
      model: 'whisper-small', lang: 'zh-CN', glossaryVersion: 0,
      createdAt: now - 3600_000, source: 'local-webgpu', coveredSec: 1105,
      coverage: [{ start: 0, end: 540 }, { start: 540, end: 1105 }],
      durationSec: 2820, aiSubtitle: false, partial: false,
    },
    {
      mediaKey: BILI_KEY,
      segments: [
        { s: 1, e: 6, text: '欢迎大家来到线性代数公开课' },
        { s: 6, e: 12, text: '今天我们讲解矩阵乘法的定义' },
        { s: 12, e: 18, text: '矩阵乘法不满足交换律' },
        { s: 18, e: 26, text: '先看一个二阶矩阵的反例' },
        { s: 60, e: 66, text: '最后介绍特征值的直观含义' },
      ],
      model: 'bili-official-subtitle', lang: 'zh-CN', glossaryVersion: 0,
      createdAt: now - 7200_000, source: 'bili-official-subtitle', coveredSec: 26,
      coverage: [{ start: 1, end: 26 }], durationSec: 600, aiSubtitle: false, partial: false,
    },
  ],
  aiResults: [
    {
      mediaKey: HDU_KEY, promptVersion: 1, model: 'claude-sonnet',
      topics: [
        { name: '矩阵乘法的定义', summary: '可乘条件与行乘列法则，C=AB 的第 i 行 j 列元素求法。', confidence: 'high', intervals: [[96, 235]] },
        { name: '交换律不成立', summary: '二阶矩阵反例：AB ≠ BA；结合律与分配律成立。', confidence: 'high', intervals: [[235, 388]] },
        { name: '转置与逆矩阵', summary: '(AB)ᵀ=BᵀAᵀ；A⁻¹ 存在当且仅当 det A ≠ 0。', confidence: 'high', intervals: [[465, 780]] },
        { name: '特征值与特征向量', summary: 'Av=λv；特征方程 |A−λE|=0；几何直观是不变方向的缩放。', confidence: 'medium', intervals: [[780, 1105]] },
      ],
      outline: [
        { level: 1, title: '矩阵运算', start: 0, end: 465 },
        { level: 2, title: '乘法定义与可乘条件', start: 96, end: 235 },
        { level: 2, title: '交换律反例', start: 235, end: 388 },
        { level: 1, title: '转置与逆', start: 465, end: 780 },
        { level: 2, title: '转置的性质', start: 465, end: 540 },
        { level: 2, title: '逆矩阵与行列式', start: 540, end: 780 },
        { level: 1, title: '特征值初步', start: 780, end: 1105 },
      ],
      createdAt: now - 1800_000,
    },
    {
      mediaKey: BILI_KEY, promptVersion: 1, model: 'claude-sonnet',
      topics: [
        { name: '矩阵乘法', summary: '矩阵乘法的定义与运算性质。', confidence: 'high', intervals: [[6, 30]] },
        { name: '特征值', summary: '特征值的直观含义。', confidence: 'low', intervals: [[60, 120]] },
      ],
      outline: [{ level: 1, title: '矩阵乘法', start: 6, end: 30 }],
      createdAt: now - 1800_000,
    },
  ],
  chats: [
    { id: 'seed-q1', mediaKey: HDU_KEY, groupId: 'seed-group-1', role: 'user', content: '矩阵乘法为什么不满足交换律？', anchorTime: 320, status: 'done', createdAt: now - 1200_000 },
    { id: 'seed-a1', mediaKey: HDU_KEY, groupId: 'seed-group-1', role: 'ai', content: '因为矩阵乘法本质上是对线性变换的复合，先后顺序会影响结果。讲义里的二阶反例：同一组元素换了位置，乘积的主对角线就不一样了（依据字幕 05:25）。', anchorTime: 320, status: 'done', createdAt: now - 1199_000 },
    { id: 'seed-q2', mediaKey: HDU_KEY, groupId: 'seed-group-2', role: 'user', content: '特征值到底有什么用？', anchorTime: 860, status: 'done', createdAt: now - 900_000 },
    { id: 'seed-a2', mediaKey: HDU_KEY, groupId: 'seed-group-2', role: 'ai', content: '特征值告诉你线性变换在哪些方向上只做缩放。比如振动分析里，特征值决定固有频率；图像处理里，主成分分析靠最大的特征值找主方向（依据字幕 14:20）。', anchorTime: 860, status: 'done', createdAt: now - 899_000 },
  ],
  notes: [
    { id: 'seed-note-1', courId: COUR_ID, teclId: TECL_ID, anchorTime: 320, text: '交换律反例必考：AB≠BA，记住"先 A 后 B"和"先 B 后 A"结果不同。', createdAt: ts(0, 20, 12), updatedAt: ts(0, 20, 12) },
    { id: 'seed-note-2', courId: COUR_ID, teclId: TECL_ID, anchorTime: 625, text: '可逆 ⟺ det A ≠ 0，伴随矩阵法求二阶逆矩阵的口诀：主对角交换、副对角变号。', createdAt: ts(0, 20, 40), updatedAt: ts(0, 20, 40) },
    { id: 'seed-note-3', courId: COUR_ID, teclId: TECL_ID, anchorTime: 940, text: '特征值几何直观：不变方向上的缩放倍数。', createdAt: ts(1, 21, 5), updatedAt: ts(1, 21, 5) },
  ],
  favorites: [
    {
      id: 'seed-fav-hdu-time', type: 'time', refId: `${HDU_KEY}@320`,
      snapshot: { title: '线性代数（模拟课程）· 交换律反例', content: '矩阵乘法不满足交换律的二阶反例。' },
      anchorTime: 320, folderId: null, tags: ['反例'], note: '', pinned: true,
      favoritedAt: ts(0, 20, 15), updatedAt: ts(0, 20, 15),
      metadata: { platform: 'hdu', courId: COUR_ID, teclId: TECL_ID, mediaKey: HDU_KEY },
    },
    {
      id: 'seed-fav-hdu-ai', type: 'ai', refId: 'seed-group-2',
      snapshot: { title: '特征值到底有什么用？', content: '特征值告诉你线性变换在哪些方向上只做缩放。' },
      anchorTime: 860, folderId: null, tags: [], note: '', pinned: false,
      favoritedAt: ts(0, 21, 2), updatedAt: ts(0, 21, 2),
      metadata: { platform: 'hdu', courId: COUR_ID, teclId: TECL_ID, mediaKey: HDU_KEY, question: '特征值到底有什么用？' },
    },
    {
      id: 'seed-fav-bili-video', type: 'video', refId: BILI_VID,
      snapshot: { title: '线性代数公开课：矩阵乘法（演示）', content: 'B 站收藏的网课视频（演示数据）。' },
      folderId: null, tags: ['网课'], note: '考前再看一遍', pinned: false,
      favoritedAt: ts(1, 21, 30), updatedAt: ts(1, 21, 30),
      metadata: { platform: 'bilibili', bvid: BILI_VID, url: `https://www.bilibili.com/video/${BILI_VID}`, uploader: '模拟教师', duration: '10:00', durationSec: 600, coverUrl: '' },
    },
    {
      id: 'seed-fav-bili-ai', type: 'ai', refId: 'seed-bili-chat-1',
      snapshot: { title: '特征值的直观含义（演示）', content: '特征值描述线性变换的不变方向（演示数据）。' },
      anchorTime: 60, folderId: null, tags: [], note: '', pinned: false,
      favoritedAt: ts(1, 21, 40), updatedAt: ts(1, 21, 40),
      metadata: { platform: 'bilibili', bvid: BILI_VID, url: `https://www.bilibili.com/video/${BILI_VID}`, mediaKey: BILI_KEY, videoTitle: '线性代数公开课（演示）', question: '特征值是什么？' },
    },
  ],
  reviewJobs: [
    { id: 'seed-review-1', favoriteId: 'seed-fav-bili-ai', dueDate: dayKey(0), round: 1, template: 'regular', status: 'pending', createdAt: ts(2, 12), updatedAt: ts(2, 12) },
    { id: 'seed-review-2', favoriteId: 'seed-fav-hdu-time', dueDate: dayKey(0), round: 1, template: 'regular', status: 'pending', createdAt: ts(2, 12), updatedAt: ts(2, 12) },
  ],
  watchRecords: (() => {
    const rows = [];
    let id = 1;
    const plan = [2820, 1200, 2400, 1800, 3300, 0, 2700, 3600, 1500, 0, 2900, 2100];
    for (let d = 0; d < plan.length; d += 1) {
      const sec = plan[d];
      if (!sec) continue;
      rows.push({
        id: id++, courId: d % 3 === 0 ? 1227036 : d % 3 === 1 ? 1227037 : 1227038, teclId: TECL_ID,
        date: dayKey(d), startTs: ts(d, d === 0 ? 8 : 19, 30), endTs: ts(d, d === 0 ? 8 : 19, 30) + sec * 1000,
        durationSec: sec, playMode: 'vod', speed: 1, firstWatch: true, valid: true,
      });
    }
    return rows;
  })(),
  externalWatch: [
    { id: 'ew-1', date: dayKey(0), bvid: BILI_VID, title: '线性代数公开课：矩阵乘法', seconds: 1500 },
    { id: 'ew-2', date: dayKey(2), bvid: BILI_VID, title: '线性代数公开课：矩阵乘法', seconds: 900 },
    { id: 'ew-3', date: dayKey(4), bvid: 'BV1Demo0002', title: '概率论速成：条件概率', seconds: 2100 },
  ],
  videoProgress: [{ id: HDU_KEY, positionSec: 320, updatedAt: now - 600_000 }],
};

/* ───────────────────────── 裸 CDP（与 e2e 同款） ───────────────────────── */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

function findBrowser() {
  return CHROME_CANDIDATES.find((p) => existsSync(p));
}

function createCdp(browserPath, profileDir) {
  const chrome = spawn(
    browserPath,
    [
      '--headless=new',
      '--enable-unsafe-extension-debugging',
      '--remote-debugging-pipe',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,OptimizationHints',
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  );
  const writeStream = chrome.stdio[3];
  const readStream = chrome.stdio[4];
  let buffer = '';
  let seq = 0;
  const pending = new Map();
  const eventListeners = new Set();
  readStream.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\0')) >= 0) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!raw.trim()) continue;
      let message;
      try { message = JSON.parse(raw); } catch { continue; }
      if (message.method) for (const listener of eventListeners) listener(message);
      const key = message.sessionId ? `${message.sessionId}:${message.id}` : String(message.id);
      const resolver = pending.get(key);
      if (resolver) {
        pending.delete(key);
        if (message.error) resolver.reject(new Error(JSON.stringify(message.error)));
        else resolver.resolve(message.result);
      }
    }
  });
  const send = (method, params = {}, sessionId) => {
    const id = ++seq;
    const key = sessionId ? `${sessionId}:${id}` : String(id);
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolvePromise, rejectPromise) => {
      pending.set(key, { resolve: resolvePromise, reject: rejectPromise });
      writeStream.write(`${JSON.stringify(payload)}\0`);
      setTimeout(() => { if (pending.delete(key)) rejectPromise(new Error(`CDP 超时：${method}`)); }, 30_000);
    });
  };
  const onEvent = (handler) => { eventListeners.add(handler); return () => eventListeners.delete(handler); };
  return { chrome, send, onEvent };
}

async function ensureMockServer() {
  try {
    const res = await fetch(`${BASE}/jy-application-resourcemanage/v1/currentuser`);
    if (res.ok) return null;
  } catch { /* 未启动 */ }
  const child = spawn(process.execPath, [FIXTURE], { stdio: 'ignore' });
  for (let i = 0; i < 20; i += 1) {
    await sleep(300);
    try {
      const res = await fetch(`${BASE}/jy-application-resourcemanage/v1/currentuser`);
      if (res.ok) return child;
    } catch { /* 继续等待 */ }
  }
  throw new Error('模拟站点服务启动失败');
}

/* ───────────────────────── 页面助手 ───────────────────────── */
async function openPage(send, url, { dsf = 2 } = {}) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: dsf, mobile: false }, sessionId);
  if (url !== 'about:blank') {
    await send('Page.navigate', { url }, sessionId).catch(() => {});
  }
  return { targetId, sessionId };
}
const evaluate = (send, sid) => async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
  if (result.exceptionDetails) return `异常：${result.exceptionDetails.text}`;
  return result.result.value;
};
async function waitForExpr(send, sid, expression, desc, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = await evaluate(send, sid)(expression).catch(() => false);
    if (v) return true;
    await sleep(250);
  }
  console.log(`  ! 等待超时：${desc}`);
  return false;
}
async function shot(send, sid, name, clip) {
  const params = { format: 'png', captureBeyondViewport: false };
  if (clip) params.clip = clip;
  const result = await send('Page.captureScreenshot', params, sid);
  if (!result?.data) { console.log('  ! 截图失败', name); return; }
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(result.data, 'base64'));
  console.log('  ✓', name);
}
async function settle(send, sid, ms = 1200) {
  await evaluate(send, sid)('document.fonts.ready.then(() => true)').catch(() => {});
  await sleep(ms);
}
/** 在 shadow 宿主内按可见文本点击（取包含文本的最小子树，兼容带图标/徽标的导航项） */
const clickShadowText = (send, sid, hostId, text) => evaluate(send, sid)(`(() => {
  const root = document.getElementById('${hostId}')?.shadowRoot;
  if (!root) return 'no-host';
  const want = ${JSON.stringify(text)};
  const exact = [...root.querySelectorAll('*')].filter((el) => el.textContent
    && el.offsetParent !== null && el.textContent.trim() === want);
  let candidates = exact;
  if (!candidates.length) {
    candidates = [...root.querySelectorAll('*')].filter((el) => {
      if (!el.textContent || el.offsetParent === null) return false;
      const t = el.textContent.trim();
      return t.includes(want) && t.length <= want.length + 24;
    });
  }
  if (!candidates.length) return 'not-found';
  // 取文本最短（最贴近目标词）的候选，避免“浏览我的课程”抢了“我的课程”
  let best = candidates[0];
  for (const el of candidates) {
    const a = el.textContent.trim().length - want.length;
    const b = best.textContent.trim().length - want.length;
    if (a < b) best = el;
  }
  best.click();
  return 'clicked:' + best.tagName + ':' + best.textContent.trim().slice(0, 12);
})()`);

/* ───────────────────────── 预置（扩展页面上下文写 IndexedDB） ───────────────────────── */
async function evalInExtPage(send, extId, expression) {
  const target = await send('Target.createTarget', { url: `chrome-extension://${extId}/options.html` });
  const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const sid = attached.sessionId;
  await send('Runtime.enable', {}, sid);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await waitForExpr(send, sid, 'document.readyState === "complete"', '扩展页面加载完成', 6000);
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
      if (!result.exceptionDetails) return result.result.value;
      if (attempt === 2) return `异常：${result.exceptionDetails.text}`;
      await sleep(500);
    }
    return null;
  } finally {
    await send('Target.closeTarget', { targetId: target.targetId }).catch(() => {});
  }
}

async function seedDatabase(send, extId) {
  const expression = `((seed) => (async () => {
    const request = indexedDB.open('hdu-assistant');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const stores = Array.from(db.objectStoreNames);
      const need = ['transcripts','aiResults','chats','notes','favorites','reviewJobs','watchRecords','externalWatch','videoProgress'];
      if (!need.every((n) => stores.includes(n))) return 'no-stores:' + stores.join(',');
      const tx = db.transaction(need, 'readwrite');
      for (const t of seed.transcripts) tx.objectStore('transcripts').put(t);
      for (const t of seed.aiResults) tx.objectStore('aiResults').put(t);
      for (const t of seed.chats) tx.objectStore('chats').put(t);
      for (const t of seed.notes) tx.objectStore('notes').put(t);
      for (const t of seed.favorites) tx.objectStore('favorites').put(t);
      for (const t of seed.reviewJobs) tx.objectStore('reviewJobs').put(t);
      for (const t of seed.watchRecords) tx.objectStore('watchRecords').put(t);
      for (const t of seed.externalWatch) tx.objectStore('externalWatch').put(t);
      for (const t of seed.videoProgress) tx.objectStore('videoProgress').put(t);
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error('abort'));
      });
      return 'ok';
    } finally { db.close(); }
  })())(${JSON.stringify(seed)})`;
  let outcome = '';
  for (let attempt = 0; attempt < 30; attempt += 1) {
    outcome = await evalInExtPage(send, extId, expression);
    if (outcome === 'ok') break;
    await sleep(400);
  }
  console.log('seed:', outcome);
  if (outcome !== 'ok') throw new Error('预置失败: ' + outcome);
}

/* ───────────────────────── 采集任务 ───────────────────────── */
async function captureLearningCenter(send) {
  console.log('· 学习中心');
  const page = await openPage(send, `${BASE}/play-center-sim.html#/home`);
  const mounted = await waitForExpr(send, page.sessionId,
    "!!document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelector('.hdu-root')", '学习中心接管');
  if (!mounted) throw new Error('学习中心未接管');
  await settle(send, page.sessionId, 2400);
  await shot(send, page.sessionId, 'lc-01-overview');
  for (const [text, name] of [['我的课程', 'lc-02-courses'], ['课表与补看', 'lc-03-schedule'], ['知识库', 'lc-04-library'], ['学习统计', 'lc-05-stats']]) {
    const res = await clickShadowText(send, page.sessionId, 'hdu-assistant-host', text);
    await settle(send, page.sessionId, 1500);
    await shot(send, page.sessionId, name);
    if (res !== 'clicked') console.log('  ! 点击失败', text, res);
  }
  await send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
}

async function capturePlayer(send) {
  console.log('· 播放页');
  const page = await openPage(send, `${BASE}/play-center-sim.html#/play-center?teclId=9001&teclCode=TECL-9001&subjId=1573&target=video`);
  const mounted = await waitForExpr(send, page.sessionId,
    "!!document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelector('.hdu-panel')", '播放页面板');
  if (!mounted) throw new Error('播放页面板未出现');
  await evaluate(send, page.sessionId)(`(() => {
    for (const v of document.querySelectorAll('video')) { try { v.currentTime = 320; } catch (e) {} }
    return true;
  })()`).catch(() => {});
  await settle(send, page.sessionId, 2400);
  await shot(send, page.sessionId, 'pl-01-overview');
  for (const [text, name] of [['标注', 'pl-02-annotate'], ['大纲', 'pl-03-outline'], ['问答', 'pl-04-qa'], ['笔记', 'pl-05-notes']]) {
    const res = await clickShadowText(send, page.sessionId, 'hdu-assistant-host', text);
    await settle(send, page.sessionId, 1400);
    await shot(send, page.sessionId, name);
    if (res !== 'clicked') console.log('  ! 点击失败', text, res);
  }
  await send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
}

async function captureBili(send, onEvent) {
  console.log('· B站');
  const page = await openPage(send, 'about:blank');
  const offRequest = onEvent((message) => {
    if (message.sessionId !== page.sessionId || message.method !== 'Fetch.requestPaused') return;
    const requestUrl = String(message.params?.request?.url ?? '');
    const isDocument = requestUrl.startsWith('https://www.bilibili.com/video/');
    void send('Fetch.fulfillRequest', {
      requestId: message.params.requestId,
      responseCode: isDocument ? 200 : 404,
      responseHeaders: isDocument ? [{ name: 'content-type', value: 'text/html; charset=utf-8' }] : [],
      body: isDocument ? Buffer.from(BILI_FIXTURE_HTML, 'utf8').toString('base64') : '',
    }, page.sessionId).catch(() => {});
  });
  await send('Fetch.enable', { patterns: [{ urlPattern: 'https://www.bilibili.com/*' }] }, page.sessionId);
  await send('Page.navigate', { url: `https://www.bilibili.com/video/${BILI_VID}` }, page.sessionId);
  const host = 'hdu-bili-collect-host';
  const mounted = await waitForExpr(send, page.sessionId,
    `(() => { const r = document.getElementById('${host}')?.shadowRoot; return !!r?.querySelector('.bili-fab') && !!r?.querySelector('.bili-qa-fab') && !!r?.querySelector('.bili-hub-fab'); })()`,
    'B站助手挂载');
  if (!mounted) throw new Error('B站助手未挂载');
  await settle(send, page.sessionId, 2000);
  await shot(send, page.sessionId, 'bili-01-page');
  const biliClick = (selector) => evaluate(send, page.sessionId)(
    `(() => { document.getElementById('${host}')?.shadowRoot?.querySelector('${selector}')?.click(); return true; })()`);
  await biliClick('.bili-sub-fab');
  const subOk = await waitForExpr(send, page.sessionId,
    `!!document.getElementById('${host}')?.shadowRoot?.querySelector('.bili-sub-list')`, '字幕浮层');
  await settle(send, page.sessionId, 1200);
  await shot(send, page.sessionId, 'bili-02-subtitles');
  await biliClick('.bili-qa-fab');
  await settle(send, page.sessionId, 1500);
  await shot(send, page.sessionId, 'bili-03-assistant');
  await biliClick('.bili-hub-fab');
  await settle(send, page.sessionId, 1800);
  await shot(send, page.sessionId, 'bili-04-hub');
  offRequest();
  await send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
}

/* ───────────────────────── 主流程 ───────────────────────── */
async function main() {
  if (!existsSync(EXT_DIR)) throw new Error('缺少 dev 构建，请先 npm run e2e:build');
  const server = await ensureMockServer();
  const profileDir = mkdtempSync(join(tmpdir(), 'hdu-promo-'));
  const { chrome, send, onEvent } = createCdp(findBrowser(), profileDir);
  try {
    const loaded = await send('Extensions.loadUnpacked', { path: EXT_DIR.replace(/\//g, '\\') });
    console.log('扩展加载:', loaded?.id);
    // 等 SW 注册完（避免首屏漏注入）
    let ready = false;
    for (let i = 0; i < 50 && !ready; i += 1) {
      const targets = await send('Target.getTargets').catch(() => null);
      ready = (targets?.targetInfos ?? []).some((t) => t.type === 'service_worker' && String(t.url ?? '').includes(String(loaded?.id ?? '')));
      if (!ready) await sleep(200);
    }
    console.log('扩展后台就绪:', ready);
    await seedDatabase(send, loaded.id);
    if (ONLY === 'all' || ONLY === 'hdu') await captureLearningCenter(send);
    if (ONLY === 'all' || ONLY === 'player') await capturePlayer(send);
    if (ONLY === 'all' || ONLY === 'bili') await captureBili(send, onEvent);
  } finally {
    chrome.kill();
    if (server) server.kill();
  }
  console.log('done');
}

main().catch((e) => { console.error(e); process.exit(1); });
