/**
 * 演示模式域（第 319 轮）：
 *  - index.ts   ：旗标判定（各写入口的统一 gate）与演示库键常量；
 *  - data.ts    ：buildDemoDataset —— 全场景虚构数据集（纯函数，相对 now 生成）；
 *  - seed.ts    ：SW 侧播种 / 清库（demo.enter / demo.exit / demo.reset 的实现体）。
 *
 * 数据安全：演示数据写入并行库 hdu-assistant-demo（见 core/db/index.ts 的动态库名），
 * 真实库零接触；退出即删演示库，无需快照/恢复。
 */

import { loadSettings } from '../shared/settings';

/** 播种幂等标记（kv，写在演示库内；demo.enter 时存在即跳过重播种） */
export const DEMO_SEEDED_KEY = 'demo:seededAt';

/** 当前是否处于演示模式（读不到设置时按未开启处理：宁可少演示，不可误伤真实数据） */
export async function isDemoActive(): Promise<boolean> {
  try {
    const settings = await loadSettings();
    return settings.demo?.enabled === true;
  } catch {
    return false;
  }
}
