/**
 * 演示模式播种 / 清库（第 319 轮，演示域）—— demo.enter / demo.exit / demo.reset /
 * demo.status 的实现体，仅在 SW（ops 分发表）内调用。
 *
 * 流程（enter）：写旗标 → switchDbTarget（关真实库连接）→ getDb（打开/创建演示库）
 *   → kv 幂等标记已存在则跳过 → 单事务写入全部 store → 截图 blob 由 OffscreenCanvas
 *   现场渲染（环境不支持则对应收藏一并跳过，避免空引用）。
 * 流程（exit）：关旗标 → 关连接 → 删除演示库（被其他上下文阻塞时放行，删除延后到
 *   连接释放自然完成；下次 enter/reset 会兜底重建）。
 */

import { closeDb, getDb, switchDbTarget } from '../db';
import { loadSettings, saveSettings } from '../shared/settings';
import { createLogger } from '../shared/logger';
import { DB_NAME_DEMO } from '../shared/constants';
import type { NoteEntity, ScreenshotEntity } from '../shared/types';
import { buildDemoDataset } from './data';
import { DEMO_SEEDED_KEY } from './index';

const log = createLogger('demo');

/** demo.status / demo.enter / demo.exit 的统一返回形状（ops.ts 里的 DemoStatusResult） */
export interface DemoStatusPayload {
  enabled: boolean;
  enteredAt: number;
  seededAt: number | null;
  /** 演示库各 store 行数（未开启 / 未播种时为 null） */
  counts: Record<string, number> | null;
}

const COUNT_STORES = [
  'courses',
  'sessions',
  'transcripts',
  'aiResults',
  'chats',
  'favorites',
  'notes',
  'watchRecords',
  'externalWatch',
  'reviewJobs',
  'screenshots',
] as const;

// ───────────────────────── 截图渲染（SW 内 OffscreenCanvas） ─────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

const SHOT_PALETTES: Array<[string, string]> = [
  ['#2c3a52', '#4f6b8f'],
  ['#4a2c3a', '#8f4f6b'],
  ['#2c4a3a', '#4f8f6b'],
  ['#4a3a2c', '#8f6b4f'],
];

/** 生成演示截图的正图与缩略图；环境不支持 OffscreenCanvas 时返回 null */
async function renderScreenshot(
  meta: { meta: { courseName: string; courLabel: string; anchorTime: number } },
  index: number,
): Promise<{ blob: Blob; thumb: string } | null> {
  const g = globalThis as { OffscreenCanvas?: typeof OffscreenCanvas };
  if (!g.OffscreenCanvas) return null;
  try {
    const palette: [string, string] = SHOT_PALETTES[index % SHOT_PALETTES.length] ?? ['#2c3a52', '#4f6b8f'];
    const draw = (w: number, h: number, scale: number) => {
      const canvas = new g.OffscreenCanvas!(w, h);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const [c1, c2] = palette;
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, c1);
      grad.addColorStop(1, c2);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      // 课程名 / 课次 / 时间点
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.textBaseline = 'top';
      ctx.font = `600 ${Math.round(22 * scale)}px sans-serif`;
      ctx.fillText(meta.meta.courseName, 24 * scale, 30 * scale);
      ctx.font = `${Math.round(14 * scale)}px sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillText(meta.meta.courLabel, 24 * scale, (30 + 30 * scale) * scale);
      const anchor = meta.meta.anchorTime;
      const mm = String(Math.floor(anchor / 60)).padStart(2, '0');
      const ss = String(Math.round(anchor % 60)).padStart(2, '0');
      ctx.font = `${Math.round(13 * scale)}px sans-serif`;
      ctx.fillText(`${mm}:${ss}`, 24 * scale, (30 + 56 * scale) * scale);
      // 角标水印
      ctx.font = `${Math.round(11 * scale)}px sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      const tag = '演示数据 · 智慧课堂助手';
      const tw = ctx.measureText(tag).width;
      ctx.fillText(tag, w - tw - 18 * scale, h - 26 * scale);
      return canvas;
    };
    const main = draw(640, 360, 1);
    if (!main) return null;
    const blob = await main.convertToBlob({ type: 'image/png' });
    const thumbCanvas = draw(160, 90, 0.25);
    if (!thumbCanvas) return null;
    const thumbBlob = await thumbCanvas.convertToBlob({ type: 'image/png' });
    const thumb = `data:image/png;base64,${bytesToBase64(new Uint8Array(await thumbBlob.arrayBuffer()))}`;
    return { blob, thumb };
  } catch (err) {
    log.warn('演示截图渲染失败，跳过该截图', { err: String(err) });
    return null;
  }
}

// ───────────────────────── 播种与清库 ─────────────────────────

/** 向当前连接的演示库单事务写入全部演示数据（幂等标记由调用方写） */
async function writeDemoData(now: number): Promise<void> {
  const data = buildDemoDataset(now);
  const db = await getDb();

  // 截图：先在事务外逐张渲染（异步），失败则跳过；引用缺失截图的收藏一并剔除
  const screenshots: ScreenshotEntity[] = [];
  let shotIndex = 0;
  for (const shotMeta of data.screenshotMetas) {
    const rendered = await renderScreenshot(shotMeta, shotIndex);
    shotIndex += 1;
    if (rendered) {
      screenshots.push({ ...shotMeta, blob: rendered.blob, thumbDataUrl: rendered.thumb });
    }
  }
  const screenshotIds = new Set(screenshots.map((s) => s.id));
  const droppedFavoriteIds = new Set<string>();
  const favorites = data.favorites.filter((f) => {
    if (f.type !== 'screenshot') return true;
    if (typeof f.refId === 'string' && screenshotIds.has(f.refId)) return true;
    droppedFavoriteIds.add(f.id);
    return false;
  });
  // 引用被剔除收藏的复习作业一并剔除（保持外键闭合；正常环境 OffscreenCanvas 可用，不会走到）
  const reviewJobs = data.reviewJobs.filter((j) => !droppedFavoriteIds.has(j.favoriteId));

  const tx = db.transaction(
    [
      'courses',
      'sessions',
      'transcripts',
      'aiResults',
      'chats',
      'favorites',
      'folders',
      'tags',
      'notes',
      'watchRecords',
      'screenshots',
      'reviewJobs',
      'curriculum',
      'videoProgress',
      'externalWatch',
      'weeklyPlans',
      'kv',
    ],
    'readwrite',
  );
  for (const row of data.courses) void tx.objectStore('courses').put(row);
  for (const row of data.sessions) void tx.objectStore('sessions').put(row);
  for (const row of data.transcripts) void tx.objectStore('transcripts').put(row);
  for (const row of data.aiResults) void tx.objectStore('aiResults').put(row);
  for (const row of data.chats) void tx.objectStore('chats').put(row);
  for (const row of favorites) void tx.objectStore('favorites').put(row);
  for (const row of data.folders) void tx.objectStore('folders').put(row);
  for (const row of data.tags) void tx.objectStore('tags').put(row);
  for (const row of data.notes) void tx.objectStore('notes').put(row);
  // ExternalNoteEntity 与 NoteEntity 同 store（schema 类型只标站内形态）：运行时合法，此处窄化
  for (const row of data.externalNotes) void tx.objectStore('notes').put(row as unknown as NoteEntity);
  for (const row of screenshots) void tx.objectStore('screenshots').put(row);
  for (const row of data.watchRecords) void tx.objectStore('watchRecords').put(row);
  for (const row of reviewJobs) void tx.objectStore('reviewJobs').put(row);
  for (const row of data.curriculum) {
    void tx.objectStore('curriculum').put({ ...row, termYear: '2026-2027-1', updatedAt: now });
  }
  for (const row of data.videoProgress) void tx.objectStore('videoProgress').put(row);
  for (const row of data.externalWatch) void tx.objectStore('externalWatch').put(row);
  for (const row of data.weeklyPlans) void tx.objectStore('weeklyPlans').put(row);
  for (const row of data.kv) void tx.objectStore('kv').put({ key: row.key, value: row.value, updatedAt: now });
  void tx.objectStore('kv').put({ key: DEMO_SEEDED_KEY, value: now, updatedAt: now });
  await tx.done;
  log.info('演示数据播种完成', {
    courses: data.courses.length,
    sessions: data.sessions.length,
    favorites: favorites.length,
    screenshots: screenshots.length,
  });
}

async function readStatus(): Promise<DemoStatusPayload> {
  const settings = await loadSettings();
  const enabled = settings.demo?.enabled === true;
  const enteredAt = settings.demo?.enteredAt ?? 0;
  if (!enabled) return { enabled: false, enteredAt, seededAt: null, counts: null };
  try {
    const db = await getDb();
    const seededAt = ((await db.get('kv', DEMO_SEEDED_KEY))?.value as number | undefined) ?? null;
    const counts: Record<string, number> = {};
    for (const store of COUNT_STORES) {
      counts[store] = await db.count(store);
    }
    return { enabled: true, enteredAt, seededAt, counts };
  } catch (err) {
    log.warn('演示状态读取失败', { err: String(err) });
    return { enabled: true, enteredAt, seededAt: null, counts: null };
  }
}

/** 删除演示库（阻塞时放行：等待占连接的上下文释放后由浏览器完成删除） */
function deleteDemoDatabase(): Promise<void> {
  return new Promise((resolve) => {
    const g = globalThis as { indexedDB?: IDBFactory };
    if (!g.indexedDB) return resolve();
    let req: IDBOpenDBRequest;
    try {
      req = g.indexedDB.deleteDatabase(DB_NAME_DEMO);
    } catch {
      return resolve();
    }
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

async function ensureEnabled(): Promise<void> {
  const settings = await loadSettings();
  if (settings.demo?.enabled === true) return;
  await saveSettings({ demo: { enabled: true, enteredAt: Date.now() } });
  await switchDbTarget();
}

/** 进入演示模式（幂等：已播种则不重播） */
export async function enterDemo(): Promise<DemoStatusPayload> {
  const before = await loadSettings();
  const alreadyEnabled = before.demo?.enabled === true;
  await ensureEnabled();
  if (!alreadyEnabled) {
    await switchDbTarget();
  }
  const db = await getDb();
  const seededAt = ((await db.get('kv', DEMO_SEEDED_KEY))?.value as number | undefined) ?? null;
  if (seededAt == null) {
    await writeDemoData(Date.now());
    log.info('演示模式已开启');
  }
  return readStatus();
}

/** 退出演示模式（真实数据零接触，演示库删除） */
export async function exitDemo(): Promise<DemoStatusPayload> {
  await saveSettings({ demo: { enabled: false, enteredAt: 0 } });
  await closeDb();
  await deleteDemoDatabase();
  log.info('演示模式已退出，演示库已删除');
  return { enabled: false, enteredAt: 0, seededAt: null, counts: null };
}

/** 重新生成演示数据（删库重播；如未开启先开启） */
export async function resetDemo(): Promise<DemoStatusPayload> {
  await ensureEnabled();
  await closeDb();
  await deleteDemoDatabase();
  await switchDbTarget();
  await getDb(); // 重新创建空演示库（全新 schema）
  await writeDemoData(Date.now());
  log.info('演示数据已重新生成');
  return readStatus();
}

/** 查询演示模式状态 */
export async function demoStatus(): Promise<DemoStatusPayload> {
  return readStatus();
}
