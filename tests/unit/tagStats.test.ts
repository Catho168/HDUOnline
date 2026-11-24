/**
 * 标签维度统计单测（第 125/127 轮巡检）：buildTagStats——频次排序、复习中/完成分列、
 * 脏数据防御与 limit 截断；buildTagStatsCsv——CSV 转义与脏行跳过。
 */
import { describe, expect, it } from 'vitest';
import { buildTagStats, buildTagStatsCsv, computeTagTrend, countTagDoneInWindow, countStaleTags, lastTagDoneAt, listStaleTags, listTagDoneInWindow } from '@/core/shared/tagStats';

describe('buildTagStats（标签统计看板，第 125 轮）', () => {
  it('按收藏数降序；复习中/已完成按收藏去重分列', () => {
    const favorites = [
      { id: 'f1', tags: ['高数', '重点'] },
      { id: 'f2', tags: ['高数'] },
      { id: 'f3', tags: ['高数', '重点'] },
      { id: 'f4', tags: ['线代'] },
    ];
    const jobs = [
      { favoriteId: 'f1', status: 'pending' },
      { favoriteId: 'f1', status: 'done' },
      { favoriteId: 'f3', status: 'pending' },
      { favoriteId: 'f4', status: 'done' },
      { favoriteId: 'f4', status: 'done' },
      { favoriteId: '未知收藏', status: 'pending' },
    ];
    const rows = buildTagStats(favorites, jobs);
    expect(rows).toEqual([
      { tag: '高数', favorites: 3, reviewing: 2, done: 1 },
      { tag: '重点', favorites: 2, reviewing: 2, done: 1 },
      { tag: '线代', favorites: 1, reviewing: 0, done: 1 },
    ]);
  });

  it('同频按标签名字典序（码点序：丙<乙<甲）；limit 截断', () => {
    const favorites = [{ id: 'f1', tags: ['乙', '甲'] }, { id: 'f2', tags: ['丙'] }];
    expect(buildTagStats(favorites, []).map((r) => r.tag)).toEqual(['丙', '乙', '甲']);
    expect(buildTagStats(favorites, [], 2).map((r) => r.tag)).toEqual(['丙', '乙']);
  });

  it('脏数据防御：非数组/缺 tags/非法标签名/非法作业行均跳过', () => {
    expect(buildTagStats(null, undefined)).toEqual([]);
    const favorites = [{ id: 'f1', tags: ['', 42, '有效'] }, { tags: 'x' }, null];
    const jobs = [{ favoriteId: 7, status: 'pending' }, null, { favoriteId: 'f1' }];
    expect(buildTagStats(favorites, jobs)).toEqual([{ tag: '有效', favorites: 1, reviewing: 0, done: 0 }]);
  });
});

describe('buildTagStatsCsv（标签统计导出，第 127 轮）', () => {
  it('表头 + 数值行；含逗号/引号的标签按 RFC 4180 转义', () => {
    const csv = buildTagStatsCsv([
      { tag: '高数', favorites: 3, reviewing: 2, done: 1 },
      { tag: '重点,难点', favorites: 1, reviewing: 0, done: 0 },
      { tag: '带"引号"', favorites: 1, reviewing: 0, done: 0 },
    ]);
    expect(csv.split('\n')[0]).toContain('标签,收藏,复习中,已完成');
    expect(csv).toContain('高数,3,2,1,33%');
    expect(csv).toContain('"重点,难点",1,0,0,0%');
    expect(csv).toContain('"带""引号""",1,0,0,0%');
    expect(csv.endsWith('\n')).toBe(true);
  });

  it('脏行跳过、非法数值按 0；null 输入只剩表头', () => {
    const csv = buildTagStatsCsv([{ tag: '', favorites: 1, reviewing: 0, done: 0 }, null as never, { tag: 'ok', favorites: Number.NaN, reviewing: 2.7, done: -1 }]);
    expect(csv).toBe('标签,收藏,复习中,已完成,完成率\nok,0,2,0,0%\n');
    expect(buildTagStatsCsv(null)).toBe('标签,收藏,复习中,已完成,完成率\n');
  });
});

describe('countTagDoneInWindow（标签本周完成，第 129 轮）', () => {
  const favorites = [{ id: 'f1', tags: ['高数'] }, { id: 'f2', tags: ['高数', '重点'] }];
  const mk = (day: string) => new Date(`${day}T12:00:00`).getTime();
  it('窗口内 done 作业按标签计数；窗口外/非 done/无标签收藏不计', () => {
    const jobs = [
      { favoriteId: 'f1', status: 'done', updatedAt: mk('2026-11-17') },
      { favoriteId: 'f2', status: 'done', updatedAt: mk('2026-11-18') },
      { favoriteId: 'f2', status: 'pending', updatedAt: mk('2026-11-18') },
      { favoriteId: 'f2', status: 'done', updatedAt: mk('2026-11-10') },
      { favoriteId: 'f3', status: 'done', updatedAt: mk('2026-11-18') },
    ];
    expect(countTagDoneInWindow(jobs, favorites, '2026-11-16', '2026-11-22')).toEqual([
      { tag: '高数', done: 2 },
      { tag: '重点', done: 1 },
    ]);
  });
  it('脏数据与非法窗口防御', () => {
    expect(countTagDoneInWindow(null, null, '', '')).toEqual([]);
    expect(countTagDoneInWindow([null], [null], '2026-11-16', '2026-11-22')).toEqual([]);
  });
});

describe('buildTagStatsCsv 趋势列（第 132 轮）', () => {
  it('传趋势时表头与行尾追加 4 周完成数', () => {
    const csv = buildTagStatsCsv([{ tag: '高数', favorites: 3, reviewing: 1, done: 1 }], [
      [{ tag: '高数', done: 0 }],
      [{ tag: '高数', done: 2 }],
      [{ tag: '高数', done: 1 }],
      [{ tag: '高数', done: 3 }],
    ]);
    expect(csv).toBe('标签,收藏,复习中,已完成,完成率,3 周前,2 周前,上周,本周\n高数,3,1,1,33%,0,2,1,3\n');
  });
});

describe('listTagDoneInWindow（趋势柱点选明细，第 134 轮）', () => {
  const favorites = [
    { id: 'f1', tags: ['高数'], snapshot: { title: '线性代数要点' } },
    { id: 'f2', tags: ['重点'], snapshot: {} },
  ];
  const mk = (day: string) => new Date(`${day}T12:00:00`).getTime();
  const jobs = [
    { favoriteId: 'f1', status: 'done', updatedAt: mk('2026-11-17') },
    { favoriteId: 'f1', status: 'done', updatedAt: mk('2026-11-21') },
    { favoriteId: 'f1', status: 'pending', updatedAt: mk('2026-11-18') },
    { favoriteId: 'f2', status: 'done', updatedAt: mk('2026-11-19') },
    { favoriteId: 'f9', status: 'done', updatedAt: mk('2026-11-19') },
  ];

  it('按标签 + 窗口过滤，标题来自快照（缺失占位），完成时间降序', () => {
    const rows = listTagDoneInWindow(jobs, favorites, '高数', '2026-11-16', '2026-11-22');
    expect(rows.map((r) => r.title)).toEqual(['线性代数要点', '线性代数要点']);
    expect(rows[0]?.doneAt).toMatch(/11\/2[01] \d{2}:\d{2}/);
    expect(rows[0]?.ts ?? 0).toBeGreaterThanOrEqual(rows[1]?.ts ?? 0);
  });

  it('标签名空白 / 非法窗口 / 脏行防御', () => {
    expect(listTagDoneInWindow(jobs, favorites, '  ', '2026-11-16', '2026-11-22')).toEqual([]);
    expect(listTagDoneInWindow(jobs, favorites, '高数', '', '')).toEqual([]);
    expect(listTagDoneInWindow([null], [null], '高数', '2026-11-16', '2026-11-22')).toEqual([]);
    const rows = listTagDoneInWindow(jobs, favorites, '重点', '2026-11-16', '2026-11-22');
    expect(rows.map((r) => r.title)).toEqual(['（收藏已删除）']);
  });
});

describe('buildTagStatsCsv 健康度列（第 140 轮）', () => {
  it('传 staleTags 时表头与行尾追加健康度列', () => {
    const csv = buildTagStatsCsv(
      [{ tag: '高数', favorites: 3, reviewing: 1, done: 2 }, { tag: '线代', favorites: 1, reviewing: 0, done: 0 }],
      [[{ tag: '高数', done: 0 }, { tag: '线代', done: 0 }], [{ tag: '高数', done: 0 }, { tag: '线代', done: 0 }], [{ tag: '高数', done: 0 }, { tag: '线代', done: 0 }], [{ tag: '高数', done: 0 }, { tag: '线代', done: 0 }]],
      ['高数'],
    );
    expect(csv).toContain(',健康度\n');
    expect(csv).toContain('高数,3,1,2,67%,0,0,0,0,⚠ 零完成');
    expect(csv).toContain('线代,1,0,0,0%,0,0,0,0,正常');
  });
});

describe('buildTagStatsCsv 未打标行（第 151 轮）', () => {
  it('正整数时表尾追加未打标行：仅收藏列有值，复习中/已完成/完成率留空', () => {
    const csv = buildTagStatsCsv([{ tag: '高数', favorites: 3, reviewing: 1, done: 1 }], null, null, 2);
    expect(csv).toBe('标签,收藏,复习中,已完成,完成率\n高数,3,1,1,33%\n⚠ 未打标收藏,2,,,\n');
  });

  it('带趋势与健康度列时未打标行按列数补空对齐', () => {
    const trend = [[{ tag: '高数', done: 1 }], [{ tag: '高数', done: 0 }], [{ tag: '高数', done: 0 }], [{ tag: '高数', done: 0 }]];
    const csv = buildTagStatsCsv([{ tag: '高数', favorites: 3, reviewing: 1, done: 1 }], trend, ['高数'], 5);
    const rows = csv.trimEnd().split('\n');
    expect(rows[0]).toBe('标签,收藏,复习中,已完成,完成率,3 周前,2 周前,上周,本周,健康度');
    expect(rows[1]).toBe('高数,3,1,1,33%,1,0,0,0,⚠ 零完成');
    // 未打标行：收藏列 = 5，其余 8 列（复习中/已完成/完成率/4 周/健康度）留空
    expect(rows[2]).toBe('⚠ 未打标收藏,5,,,,,,,,');
  });

  it('0 / 负数 / NaN / 未传不追加未打标行', () => {
    const base = '标签,收藏,复习中,已完成,完成率\n';
    expect(buildTagStatsCsv(null, null, null, 0)).toBe(base);
    expect(buildTagStatsCsv(null, null, null, -3)).toBe(base);
    expect(buildTagStatsCsv(null, null, null, Number.NaN)).toBe(base);
    expect(buildTagStatsCsv(null)).toBe(base);
  });
});

describe('buildTagStatsCsv 覆盖率元信息行（第 152 轮）', () => {
  it('传 coverage 时首行附元信息行，位于表头之前', () => {
    const csv = buildTagStatsCsv([{ tag: '高数', favorites: 3, reviewing: 1, done: 1 }], null, null, 2, { tagged: 8, total: 10, pct: 80 });
    const rows = csv.trimEnd().split('\n');
    expect(rows[0]).toBe('标签覆盖率,8/10,80%');
    expect(rows[1]).toBe('标签,收藏,复习中,已完成,完成率');
    expect(rows[2]).toBe('高数,3,1,1,33%');
    expect(rows[3]).toBe('⚠ 未打标收藏,2,,,');
  });
  it('不传 / 脏 coverage（NaN 字段）不出现元信息行', () => {
    expect(buildTagStatsCsv(null, null, null, 0).startsWith('标签,')).toBe(true);
    expect(buildTagStatsCsv(null, null, null, 0, null).startsWith('标签,')).toBe(true);
    expect(buildTagStatsCsv(null, null, null, 0, { tagged: Number.NaN, total: 10, pct: 50 }).startsWith('标签,')).toBe(true);
  });
});

describe('buildTagStatsCsv 覆盖率目标状态列（第 153 轮）', () => {
  it('coverage.goal > 0 时首行附「目标 G%」与达标状态', () => {
    const csv = buildTagStatsCsv(null, null, null, 0, { tagged: 8, total: 10, pct: 80, goal: 80 });
    expect(csv.split('\n')[0]).toBe('标签覆盖率,8/10,80%,目标 80%,已达标');
    const csv2 = buildTagStatsCsv(null, null, null, 0, { tagged: 6, total: 10, pct: 60, goal: 80 });
    expect(csv2.split('\n')[0]).toBe('标签覆盖率,6/10,60%,目标 80%,未达标');
  });
  it('goal 为 0/缺省/脏值时不附目标列（第 152 轮口径不变）', () => {
    expect(buildTagStatsCsv(null, null, null, 0, { tagged: 8, total: 10, pct: 80 }).split('\n')[0]).toBe('标签覆盖率,8/10,80%');
    expect(buildTagStatsCsv(null, null, null, 0, { tagged: 8, total: 10, pct: 80, goal: 0 }).split('\n')[0]).toBe('标签覆盖率,8/10,80%');
    expect(buildTagStatsCsv(null, null, null, 0, { tagged: 8, total: 10, pct: 80, goal: Number.NaN }).split('\n')[0]).toBe('标签覆盖率,8/10,80%');
  });
});

describe('lastTagDoneAt 与 CSV 最近完成列（第 154 轮）', () => {
  const favorites = [{ id: 'f1', tags: ['高数', '重点'] }, { id: 'f2', tags: ['线代'] }];
  const mk = (day: string, h = 12) => new Date(`${day}T${String(h).padStart(2, '0')}:00:00`).getTime();
  it('lastTagDoneAt：每标签取最近 done 时间；非 done/脏行/无标签收藏不计', () => {
    const jobs = [
      { favoriteId: 'f1', status: 'done', updatedAt: mk('2026-11-10') },
      { favoriteId: 'f1', status: 'done', updatedAt: mk('2026-11-18') },
      { favoriteId: 'f1', status: 'pending', updatedAt: mk('2026-11-19') },
      { favoriteId: 'f2', status: 'done', updatedAt: mk('2026-11-12') },
      { favoriteId: 'f9', status: 'done', updatedAt: mk('2026-11-12') },
      { favoriteId: 'f1', status: 'done', updatedAt: Number.NaN },
    ];
    const map = lastTagDoneAt(jobs, favorites);
    expect(map.get('高数')).toBe(mk('2026-11-18'));
    expect(map.get('重点')).toBe(mk('2026-11-18'));
    expect(map.get('线代')).toBe(mk('2026-11-12'));
    expect(map.size).toBe(3);
    expect(lastTagDoneAt(null, null).size).toBe(0);
  });
  it('CSV 传 lastDone 时表头与每行附最近完成列；无记录显示 —', () => {
    const lastDone = new Map([['高数', mk('2026-11-18', 9)]]);
    const csv = buildTagStatsCsv([{ tag: '高数', favorites: 3, reviewing: 1, done: 1 }, { tag: '线代', favorites: 1, reviewing: 0, done: 0 }], null, null, 0, null, lastDone);
    const rows = csv.trimEnd().split('\n');
    expect(rows[0]).toBe('标签,收藏,复习中,已完成,完成率,最近完成');
    expect(rows[1]).toMatch(/^高数,3,1,1,33%,11\/18 09:00$/);
    expect(rows[2]).toBe('线代,1,0,0,0%,—');
  });
  it('CSV 未传 lastDone 时表头不带最近完成列（向后兼容）', () => {
    expect(buildTagStatsCsv([{ tag: '高数', favorites: 1, reviewing: 0, done: 0 }]).split('\n')[0]).toBe('标签,收藏,复习中,已完成,完成率');
  });
});

describe('buildTagStatsCsv 覆盖率导出时间戳（第 157 轮）', () => {
  it('coverage.exportedAt 非空时元信息行末尾附「导出于 …」', () => {
    const csv = buildTagStatsCsv(null, null, null, 0, { tagged: 8, total: 10, pct: 80, goal: 80, exportedAt: '2026-11-19 22:05' });
    expect(csv.split('\n')[0]).toBe('标签覆盖率,8/10,80%,目标 80%,已达标,导出于 2026-11-19 22:05');
  });
  it('不传 / 空白 exportedAt 不附该列（向后兼容）', () => {
    expect(buildTagStatsCsv(null, null, null, 0, { tagged: 8, total: 10, pct: 80 }).split('\n')[0]).toBe('标签覆盖率,8/10,80%');
    expect(buildTagStatsCsv(null, null, null, 0, { tagged: 8, total: 10, pct: 80, exportedAt: '  ' }).split('\n')[0]).toBe('标签覆盖率,8/10,80%');
  });
});

describe('listStaleTags（零完成标签清单，第 158 轮）', () => {
  const favorites = [{ id: 'f1', tags: ['高数'] }, { id: 'f2', tags: ['线代'] }, { id: 'f3', tags: ['英语'] }];
  const mk = (day: string) => new Date(`${day}T12:00:00`).getTime();
  it('有完成记录但窗口内零完成的标签，按最近完成升序（最久在前）', () => {
    const jobs = [
      { favoriteId: 'f1', status: 'done', updatedAt: mk('2026-10-01') }, // 高数：30 天前完成，窗口外
      { favoriteId: 'f2', status: 'done', updatedAt: mk('2026-11-10') }, // 线代：9 天前完成，窗口外
      { favoriteId: 'f3', status: 'done', updatedAt: mk('2026-11-18') }, // 英语：窗口内，不算零完成
    ];
    const now = mk('2026-11-19');
    // 高数最近完成 10-01 比线代 11-10 更早 → 更久未复习，排最前
    expect(listStaleTags(jobs, favorites, now, 7)).toEqual(['高数', '线代']);
    expect(countStaleTags(jobs, favorites, now, 7)).toBe(2);
    // 60 天窗口覆盖全部完成记录（最早 10-01）→ 无零完成
    expect(listStaleTags(jobs, favorites, now, 60)).toEqual([]);
    expect(listStaleTags(null, null, now, 7)).toEqual([]);
  });
});

describe('buildTagStatsCsv 统计口径行（第 162 轮）', () => {
  it('meta.sort / meta.filter 非空时附「统计口径」行', () => {
    const csv = buildTagStatsCsv(null, null, null, 0, null, null, { sort: '按最近完成', filter: '只看零完成' });
    // 无 coverage 时统计口径行位于首行，其后为表头
    expect(csv.split('\n')[0]).toBe('统计口径,排序 按最近完成,筛选 只看零完成');
    expect(csv.split('\n')[1]).toBe('标签,收藏,复习中,已完成,完成率');
  });
  it('meta.goal 非空时口径行附目标档位（第 163 轮）', () => {
    const csv = buildTagStatsCsv(null, null, null, 0, null, null, { sort: '按收藏', filter: '全部', goal: '目标 80%' });
    expect(csv.split('\n')[0]).toBe('统计口径,排序 按收藏,筛选 全部,目标 80%');
    const csv2 = buildTagStatsCsv(null, null, null, 0, null, null, { goal: '未设目标' });
    expect(csv2.split('\n')[0]).toBe('统计口径,未设目标');
  });
  it('meta 缺失 / 全空白不附口径行（向后兼容）', () => {
    expect(buildTagStatsCsv(null, null, null, 0, null, null, null).split('\n')[0]).toBe('标签,收藏,复习中,已完成,完成率');
    expect(buildTagStatsCsv(null, null, null, 0, null, null, { sort: '  ', filter: '' }).split('\n')[0]).toBe('标签,收藏,复习中,已完成,完成率');
  });
});

describe('computeTagTrend（近 N 周趋势，第 144 轮）', () => {
  const favorites = [{ id: 'f1', tags: ['高数'] }];
  const mk = (day: string) => new Date(`${day}T12:00:00`).getTime();
  it('按周滚动统计（旧 → 新），每周为该标签完成数', () => {
    const jobs = [
      { favoriteId: 'f1', status: 'done', updatedAt: mk('2026-11-05') },
      { favoriteId: 'f1', status: 'done', updatedAt: mk('2026-11-19') },
    ];
    // 2026-11-19 为周四；本周一 = 11-16，上一周一 = 11-09，再往前 = 11-02
    // 窗口：11-02~11-08 含 11-05 的完成；11-16~11-22 含 11-19 的完成
    // 零完成周返回空数组（调用方按 find ?? 0 兜底）
    const trend = computeTagTrend(jobs, favorites, mk('2026-11-19'), 3);
    expect(trend).toEqual([
      [{ tag: '高数', done: 1 }],
      [],
      [{ tag: '高数', done: 1 }],
    ]);
  });
  it('周数 clamp 1..24；非法回退 4', () => {
    const jobs = [{ favoriteId: 'f1', status: 'done', updatedAt: mk('2026-11-19') }];
    expect(computeTagTrend(jobs, favorites, mk('2026-11-19'), 1).length).toBe(1);
    expect(computeTagTrend(jobs, favorites, mk('2026-11-19'), 99).length).toBe(24);
    expect(computeTagTrend(jobs, favorites, mk('2026-11-19'), Number.NaN).length).toBe(4);
  });
});
