/**
 * 演示模式播种 / 清库行为测试（第 319 轮，演示域）。
 *
 * fake-indexeddb 真跑 demo.enter / demo.exit / demo.reset / demo.status 全链路：
 *  1. enter：旗标写 settings、切到并行演示库、幂等播种（二次 enter 不重播）、规模如实；
 *  2. 真实库零接触：进演示前在真实库埋金丝雀 → enter/exit 后金丝雀仍在；
 *  3. exit：旗标复位、演示库删除（databases() 不再列出）；
 *  4. reset：删库重播，seededAt 更新；
 *  5. node 环境（无 OffscreenCanvas）：截图整组跳过、引用它们的收藏/复习作业一并剔除，
 *     其余收藏照常入库（优雅降级路径）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enterDemo, exitDemo, demoStatus, resetDemo, type DemoStatusPayload } from '@/core/demo/seed';
import { DEMO_SEEDED_KEY, isDemoActive } from '@/core/demo';
import { closeDb, getDb } from '@/core/db';
import { extStorage } from '@/core/shared/storage';
import { loadSettings } from '@/core/shared/settings';
import { DB_NAME, DB_NAME_DEMO } from '@/core/shared/constants';
import type { CourseEntity } from '@/core/shared/types';

async function deleteDbByName(name: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

async function listedDatabases(): Promise<string[]> {
  const g = globalThis as { indexedDB?: { databases?: () => Promise<Array<{ name?: string }>> } };
  if (!g.indexedDB?.databases) return [];
  const list = await g.indexedDB.databases();
  return list.map((d) => d.name ?? '');
}

/** 反复轮询直到演示库从 databases() 消失（deleteDatabase 需要连接全部释放） */
async function waitForDbGone(name: string, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const names = await listedDatabases();
    if (!names.includes(name)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !(await listedDatabases()).includes(name);
}

const CANARY: CourseEntity = {
  teclId: 888888,
  subjName: '金丝雀课程（真实库）',
  teacherNames: ['金丝雀'],
  semester: '2026-2027-1',
  updatedAt: 1_700_000_000_000,
};

beforeEach(async () => {
  await closeDb();
  extStorage.__resetMemory();
  await deleteDbByName(DB_NAME);
  await deleteDbByName(DB_NAME_DEMO);
});

afterEach(async () => {
  await closeDb();
  extStorage.__resetMemory();
  await deleteDbByName(DB_NAME);
  await deleteDbByName(DB_NAME_DEMO);
});

describe('演示模式播种全链路（第 319 轮）', () => {
  it('enter：旗标开启 + 演示库播种 + isDemoActive 为真；二次 enter 幂等（不重播）', async () => {
    const first: DemoStatusPayload = await enterDemo();
    expect(first.enabled).toBe(true);
    expect(first.enteredAt).toBeGreaterThan(0);
    expect(first.seededAt).toBeGreaterThan(0);
    expect(first.counts?.courses).toBe(5);
    expect((first.counts?.sessions ?? 0)).toBeGreaterThan(35);
    expect((first.counts?.favorites ?? 0)).toBeGreaterThan(15);
    expect((first.counts?.transcripts ?? 0)).toBeGreaterThanOrEqual(5);
    expect((first.counts?.watchRecords ?? 0)).toBeGreaterThan(40);
    expect(await isDemoActive()).toBe(true);
    expect((await loadSettings()).demo?.enabled).toBe(true);

    // 幂等：再次 enter 不重播（seededAt 不变、数量不变）
    const second = await enterDemo();
    expect(second.seededAt).toBe(first.seededAt);
    expect(second.counts?.courses).toBe(first.counts?.courses);
  });

  it('node 无 OffscreenCanvas：截图整组跳过、关联收藏与复习作业一并剔除，其余外键闭合', async () => {
    const status = await enterDemo();
    expect(status.counts?.screenshots).toBe(0);
    const db = await getDb();
    const favs = await db.getAll('favorites');
    expect(favs.some((f) => f.type === 'screenshot')).toBe(false);
    // 收藏 id 前缀全部 demo-（与真实数据可肉眼区分）
    for (const f of favs) expect(f.id.startsWith('demo-')).toBe(true);
    const jobs = await db.getAll('reviewJobs');
    const favIds = new Set(favs.map((f) => f.id));
    for (const j of jobs) expect(favIds.has(j.favoriteId), `作业 ${j.id} 外键闭合`).toBe(true);
    // 播种标记在演示库 kv
    expect((await db.get('kv', DEMO_SEEDED_KEY))?.value).toBeGreaterThan(0);
  });

  it('真实库零接触：金丝雀在 enter/exit 后原样健在', async () => {
    // 真实库埋金丝雀
    const realDb = await getDb();
    await realDb.put('courses', CANARY);
    expect((await realDb.get('courses', CANARY.teclId))?.subjName).toBe(CANARY.subjName);
    await closeDb();

    await enterDemo();
    // 演示库里没有金丝雀（5 门虚构课，不含 888888）
    const demoDb = await getDb();
    expect(await demoDb.get('courses', CANARY.teclId)).toBeUndefined();
    await closeDb();

    await exitDemo();
    const backDb = await getDb();
    const canary = await backDb.get('courses', CANARY.teclId);
    expect(canary?.subjName).toBe(CANARY.subjName);
    expect(canary?.updatedAt).toBe(CANARY.updatedAt);
    expect(await isDemoActive()).toBe(false);
  });

  it('exit：旗标复位、演示库删除', async () => {
    await enterDemo();
    expect(await waitForDbGone(DB_NAME_DEMO, 50)).toBe(false); // 演示库确实存在过
    await exitDemo();
    const status = await demoStatus();
    expect(status.enabled).toBe(false);
    expect(status.counts).toBeNull();
    expect((await loadSettings()).demo?.enabled).toBe(false);
    expect(await waitForDbGone(DB_NAME_DEMO)).toBe(true);
  });

  it('reset：删库重播，seededAt 更新且规模一致', async () => {
    const first = await enterDemo();
    expect(first.seededAt).toBeGreaterThan(0);
    // 演示库里做点改动模拟用户操作
    const db = await getDb();
    await db.put('courses', { ...CANARY, subjName: '演示期间误入的数据' });
    await closeDb();

    const reset = await resetDemo();
    expect(reset.enabled).toBe(true);
    expect((reset.seededAt ?? 0)).toBeGreaterThan(first.seededAt ?? 0);
    const freshDb = await getDb();
    // 重播后演示库回到纯净状态（误入数据被清掉）
    expect(await freshDb.get('courses', CANARY.teclId)).toBeUndefined();
    expect((await freshDb.count('courses'))).toBe(5);
  });

  it('未开启时 status 如实返回 disabled 且不创建演示库', async () => {
    const status = await demoStatus();
    expect(status.enabled).toBe(false);
    expect(status.seededAt).toBeNull();
    expect(status.counts).toBeNull();
  });
});
