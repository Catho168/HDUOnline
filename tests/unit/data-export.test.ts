/**
 * 全量数据导出纯函数测试（第 250 轮巡检，数据自主权域 / 备份视角）。
 *
 * 覆盖：
 *  - buildExportFilename：文件名格式（HDUOnline_全量备份_YYYY-MM-DD.json）、跨月补零、
 *    now 契约违约抛错；
 *  - assembleExportPayload：version / app / kind 标记、字段白名单（多余段剔除、
 *    settings 顶层键白名单挑选、秘密键不泄出）、脏数据清洗（非数组段置空、非对象
 *    行丢弃）、counts 汇总、空数据、exportedAt 由 now 派生；
 *  - 与导入通道的兼容性裁决：本导出的 app 标识 ≠ BACKUP_APP_ID，喂给
 *    import.parseBackupPayload 必须被拒绝（防止误当备份写回）。
 */

import { describe, expect, it } from 'vitest';
import { BACKUP_APP_ID } from '@/core/export/exporters';
import { parseBackupPayload } from '@/core/export/importer';
import {
  assembleExportPayload,
  buildExportFilename,
  DATA_EXPORT_APP_ID,
  DATA_EXPORT_VERSION,
  EXPORT_DATA_SEGMENTS,
  EXPORT_SETTINGS_KEYS,
  type DataExportPayload,
} from '@/core/export/dataExport';

/** 固定锚点：2026-11-21 09:30 本地时间 */
const NOW = new Date(2026, 10, 21, 9, 30, 0, 0).getTime();

describe('buildExportFilename（第 250 轮巡检）', () => {
  it('文件名格式：HDUOnline_全量备份_YYYY-MM-DD.json', () => {
    expect(buildExportFilename(NOW)).toBe('HDUOnline_全量备份_2026-11-21.json');
  });

  it('月 / 日补零（跨年边界取 1 月 5 日）', () => {
    expect(buildExportFilename(new Date(2027, 0, 5, 8, 0, 0, 0).getTime())).toBe('HDUOnline_全量备份_2027-01-05.json');
  });

  it('now 非有限 → 契约违约抛错（纯函数约定）', () => {
    expect(() => buildExportFilename(Number.NaN)).toThrow();
    expect(() => buildExportFilename(undefined as unknown as number)).toThrow();
  });
});

describe('assembleExportPayload（第 250 轮巡检）', () => {
  it('结构标记齐全：version=1 / app=data-export 专用 / kind=data-export / exportedAt 由 now 派生', () => {
    const payload = assembleExportPayload({ favorites: [], settings: {}, now: NOW });
    expect(payload.version).toBe(DATA_EXPORT_VERSION);
    expect(payload.app).toBe(DATA_EXPORT_APP_ID);
    expect(payload.kind).toBe('data-export');
    expect(payload.exportedAt).toBe(new Date(NOW).toISOString());
  });

  it('字段白名单：EXPORT_DATA_SEGMENTS 十段齐备、未知段（input 多给的）被剔除', () => {
    const payload = assembleExportPayload({
      favorites: [{ id: 'f1' }],
      trash: [{ key: 'x' }], // 未知段：白名单外，必须不出现在产物
      watchRecords: [{ id: 1 }], // 排除清单段：同上
      settings: {},
      now: NOW,
    } as never);
    const data = payload.data as unknown as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual([...EXPORT_DATA_SEGMENTS, 'settings'].sort());
    expect('trash' in data).toBe(false);
    expect('watchRecords' in data).toBe(false);
    expect(data.favorites).toEqual([{ id: 'f1' }]);
  });

  it('settings 顶层键白名单挑选：AppSettings 键保留、未知键不进产物', () => {
    const settings = {
      theme: 'dark',
      weeklyGoalHours: 6,
      dailyGoalMin: 30,
      shortcuts: { ask: 'q' },
      futureSecretKey: 'should-not-leak', // 白名单外：不导出
      apiKey: 'sk-nope', // 同上（纵深防御：即便有人塞进 settings 也不出）
    };
    const payload = assembleExportPayload({ settings, now: NOW });
    expect(payload.data.settings.theme).toBe('dark');
    expect(payload.data.settings.weeklyGoalHours).toBe(6);
    expect(payload.data.settings.shortcuts).toEqual({ ask: 'q' });
    expect('futureSecretKey' in payload.data.settings).toBe(false);
    expect('apiKey' in payload.data.settings).toBe(false);
  });

  it('settings 白名单键集与 AppSettings 全键一致（EXPORT_SETTINGS_KEYS 显式枚举守护）', () => {
    // 白名单必须覆盖 AppSettings 的全部顶层键（缺键 = 偏好丢失）；本断言锁定枚举非空
    expect(EXPORT_SETTINGS_KEYS.length).toBeGreaterThanOrEqual(16);
    expect(EXPORT_SETTINGS_KEYS).toContain('ui');
    expect(EXPORT_SETTINGS_KEYS).toContain('review');
    expect(EXPORT_SETTINGS_KEYS).toContain('asr');
    expect(EXPORT_SETTINGS_KEYS).toContain('shortcuts');
  });

  it('脏数据清洗：非数组段置空、非对象行丢弃、null / 数组行不进产物', () => {
    const payload = assembleExportPayload({
      favorites: [null, 42, { id: 'ok' }, ['nested'], { id: 'ok2' }],
      notes: 'not-array' as never,
      settings: null,
      now: NOW,
    });
    expect(payload.data.favorites).toEqual([{ id: 'ok' }, { id: 'ok2' }]);
    expect(payload.data.notes).toEqual([]);
    expect(payload.data.settings).toEqual({});
  });

  it('counts 汇总各段条目数（settings 记键数）', () => {
    const payload = assembleExportPayload({
      favorites: [{ id: 'a' }, { id: 'b' }],
      notes: [{ id: 'n' }],
      reviewJobs: [],
      settings: { theme: 'dark', ui: {} },
      now: NOW,
    });
    expect(payload.counts.favorites).toBe(2);
    expect(payload.counts.notes).toBe(1);
    expect(payload.counts.reviewJobs).toBe(0);
    expect(payload.counts.settings).toBe(2);
    for (const segment of EXPORT_DATA_SEGMENTS) {
      expect(typeof payload.counts[segment]).toBe('number');
    }
  });

  it('空数据 → 全段空数组、settings 空对象、counts 全 0', () => {
    const payload = assembleExportPayload({ now: NOW });
    for (const segment of EXPORT_DATA_SEGMENTS) {
      expect(payload.data[segment]).toEqual([]);
      expect(payload.counts[segment]).toBe(0);
    }
    expect(payload.data.settings).toEqual({});
    expect(payload.counts.settings).toBe(0);
  });

  it('now 非有限 → 契约违约抛错', () => {
    expect(() => assembleExportPayload({ now: Number.NaN })).toThrow();
  });
});

describe('导出与导入通道的兼容性裁决（第 250 轮巡检）', () => {
  it('本导出的 app 标识 ≠ 备份 BACKUP_APP_ID：喂给导入校验必须被拒绝（不用于写回）', () => {
    expect(DATA_EXPORT_APP_ID).not.toBe(BACKUP_APP_ID);
    const payload = assembleExportPayload({
      favorites: [{ id: 'f1' }],
      settings: { theme: 'dark' },
      now: NOW,
    });
    // 结构完全合法的导出文件，导入通道按 app 不匹配拒绝（防止 replace 模式误清派生库）
    expect(() => parseBackupPayload(JSON.stringify(payload))).toThrow(/这不是本插件的备份文件/);
  });

  it('payload 结构可作为 DataExportPayload 消费（json 往返一致）', () => {
    const payload = assembleExportPayload({
      favorites: [{ id: 'f1', tags: ['x'] }],
      settings: { theme: 'dark' },
      now: NOW,
    });
    const round = JSON.parse(JSON.stringify(payload)) as DataExportPayload;
    expect(round).toEqual(payload);
    expect(round.data.favorites).toHaveLength(1);
  });
});
