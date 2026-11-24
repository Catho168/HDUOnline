/**
 * 演示数据集不变量测试（第 319 轮，演示域）。
 *
 * buildDemoDataset(now) 是纯函数：这里断言「喂给 UI 才能点亮」的各视图口径，
 * 与 e2e 的种子红线（快照非空、valid 流水、missed 判定、外键闭合）同源：
 *  1. 确定性：同一 now 两次构建 JSON 相等；
 *  2. 课程 / 课次：5 门课、三态齐全、courLabel 非空、ISO 时间串；
 *  3. 转写：coverage 与末段对齐、mediaKey 形态、B 站官方字幕源；
 *  4. 知识库：6 种收藏类型全覆盖、快照非空、外键（folder/tag/note/screenshot）闭合；
 *  5. 复习：三模板齐、逾期/今天/未来三档齐、favoriteId 全部存在；
 *  6. 统计：近 14 天流水全勤（连续天数口径）、valid 行日期不超前、今日流水非空；
 *  7. B 站线：周计划 bvids 与视频收藏 / 站外时长记录闭合；
 *  8. 补看：存在已结束超 24h 且 watchRatio < 0.9 的课次（MissedList 非空的前提）。
 */
import { describe, expect, it } from 'vitest';
import { buildDemoDataset } from '@/core/demo/data';
import { biliMediaKey, hduMediaKey } from '@/core/shared/mediaRef';
import { localDayKey } from '@/core/shared/utils';

const NOW = new Date('2026-11-20T12:30:00').getTime();

describe('buildDemoDataset 不变量（第 319 轮）', () => {
  it('确定性：同一 now 两次构建结果逐字段一致', () => {
    const a = buildDemoDataset(NOW);
    const b = buildDemoDataset(NOW);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('课程：5 门虚构课、两个学期、字段齐全', () => {
    const data = buildDemoDataset(NOW);
    expect(data.courses).toHaveLength(5);
    const semesters = new Set(data.courses.map((c) => c.semester));
    expect(semesters.size).toBe(2);
    for (const c of data.courses) {
      expect(c.subjName.length).toBeGreaterThan(0);
      expect(c.teacherNames.length).toBeGreaterThan(0);
      expect(c.teclCode).toMatch(/^TECL-\d+$/);
    }
  });

  it('课次：三态齐全；courLabel 非空；beginTime 为 ISO 串；补看候选存在（已结束超 24h 且 ratio<0.9）', () => {
    const data = buildDemoDataset(NOW);
    const states = new Set(data.sessions.map((s) => s.watchState));
    expect(states.has('finished')).toBe(true);
    expect(states.has('watching')).toBe(true);
    expect(states.has('unwatched')).toBe(true);
    for (const s of data.sessions) {
      expect(s.courLabel ?? '').not.toBe('');
      expect(s.beginTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(s.endTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    // missed 判定（settings.missDelayHours 默认 24 / finishThreshold 默认 0.9）
    const dayAgo = new Date(NOW - 24 * 3600_000);
    const missed = data.sessions.filter((s) => {
      if ((s.watchRatio ?? 0) >= 0.9) return false;
      return new Date(s.endTime) < dayAgo;
    });
    expect(missed.length).toBeGreaterThanOrEqual(3);
    // 「继续学习」主角：观看中课次有断点
    const watching = data.sessions.filter((s) => s.watchState === 'watching');
    expect(watching.length).toBeGreaterThanOrEqual(1);
    for (const s of watching) {
      expect(s.lastPositionSec ?? 0).toBeGreaterThan(0);
      expect((s.watchRatio ?? 0)).toBeGreaterThan(0);
    }
  });

  it('转写：coverage 与末段对齐；HDU 记录 courId/mediaKey 对齐；B 站记录用官方字幕源', () => {
    const data = buildDemoDataset(NOW);
    expect(data.transcripts.length).toBeGreaterThanOrEqual(5);
    for (const t of data.transcripts) {
      const last = t.segments[t.segments.length - 1];
      expect(last).toBeDefined();
      expect(t.coveredSec ?? 0).toBe((last?.e ?? 0));
      expect(t.segments.length).toBeGreaterThan(5);
      for (const seg of t.segments) {
        expect(seg.e).toBeGreaterThan(seg.s);
        expect(seg.text.length).toBeGreaterThan(0);
      }
    }
    const bili = data.transcripts.find((t) => t.mediaKey.startsWith('bili:'));
    expect(bili?.source).toBe('bili-official-subtitle');
    const ds = data.transcripts.find((t) => t.mediaKey === hduMediaKey(1227052));
    expect(ds?.courId).toBe(1227052);
  });

  it('AI 结果：topics 区间落在转写覆盖内；outline L2 带 parent 且区间闭合', () => {
    const data = buildDemoDataset(NOW);
    for (const ai of data.aiResults) {
      const transcript = data.transcripts.find((t) => t.mediaKey === ai.mediaKey);
      expect(transcript, `aiResults ${ai.mediaKey} 必须有同键转写`).toBeDefined();
      expect(ai.topics.length).toBeGreaterThan(0);
      for (const topic of ai.topics) {
        for (const [start, end] of topic.intervals) {
          expect(end).toBeGreaterThan(start);
          expect(end).toBeLessThanOrEqual((transcript?.coveredSec ?? 0) + 1);
        }
      }
      for (const node of ai.outline) {
        if (node.level === 2) expect(typeof node.parent).toBe('number');
        expect(node.end).toBeGreaterThan(node.start);
      }
    }
  });

  it('收藏：6 种类型全覆盖；快照非空；folder/tag/note/screenshot 外键闭合', () => {
    const data = buildDemoDataset(NOW);
    const types = new Set(data.favorites.map((f) => f.type));
    for (const t of ['time', 'ai', 'outline', 'screenshot', 'note', 'video']) {
      expect(types.has(t as never), `缺少收藏类型 ${t}`).toBe(true);
    }
    const folderIds = new Set(data.folders.map((f) => f.id));
    const noteIds = new Set([...data.notes, ...data.externalNotes].map((n) => n.id));
    const shotIds = new Set(data.screenshotMetas.map((s) => s.id));
    for (const f of data.favorites) {
      expect(f.snapshot.title.length).toBeGreaterThan(0);
      expect(f.snapshot.content.length).toBeGreaterThan(0);
      if (f.folderId != null) expect(folderIds.has(f.folderId), `folder ${f.folderId}`).toBe(true);
      for (const tag of f.tags) {
        expect(data.tags.some((t) => t.name === tag), `tag ${tag} 应有标签行`).toBe(true);
      }
      if (f.type === 'note') expect(noteIds.has(f.refId ?? ''), `note ${f.refId}`).toBe(true);
      if (f.type === 'screenshot') expect(shotIds.has(f.refId ?? ''), `screenshot ${f.refId}`).toBe(true);
      if (f.type === 'video') {
        expect((f.metadata?.url as string) ?? '').toMatch(/^https:\/\/www\.bilibili\.com\/video\//);
        expect(f.metadata?.watchedRatio).toBeTypeOf('number');
      }
    }
    // 至少一条置顶（置顶区演示）
    expect(data.favorites.some((f) => f.pinned)).toBe(true);
  });

  it('复习作业：三模板齐；逾期/今天/未来三档齐；favoriteId 全部存在', () => {
    const data = buildDemoDataset(NOW);
    const favIds = new Set(data.favorites.map((f) => f.id));
    const today = localDayKey(NOW);
    let overdue = 0;
    let dueToday = 0;
    let future = 0;
    const templates = new Set<string>();
    const statuses = new Set<string>();
    for (const j of data.reviewJobs) {
      expect(favIds.has(j.favoriteId), `作业 ${j.id} 引用的收藏存在`).toBe(true);
      templates.add(j.template);
      statuses.add(j.status);
      if (j.status !== 'pending') continue;
      if (j.dueDate < today) overdue += 1;
      else if (j.dueDate === today) dueToday += 1;
      else future += 1;
    }
    expect(overdue).toBeGreaterThanOrEqual(3);
    expect(dueToday).toBeGreaterThanOrEqual(3);
    expect(future).toBeGreaterThanOrEqual(5);
    for (const t of ['regular', 'exam', 'custom']) expect(templates.has(t)).toBe(true);
    for (const s of ['pending', 'done', 'skipped']) expect(statuses.has(s)).toBe(true);
  });

  it('站内流水：近 14 天全勤（连续天数）；valid 行日期不超前；今日流水非空', () => {
    const data = buildDemoDataset(NOW);
    const byDay = new Map<string, number>();
    for (const r of data.watchRecords) {
      if (!r.valid) continue;
      expect(r.date <= localDayKey(NOW), `流水日期 ${r.date} 不超前`).toBe(true);
      expect(r.endTs).toBeLessThanOrEqual(NOW);
      expect(r.durationSec).toBeGreaterThan(0);
      byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.durationSec);
    }
    for (let d = 0; d < 14; d += 1) {
      const day = localDayKey(NOW - d * 86_400_000);
      expect(byDay.get(day) ?? 0, `近 14 天 ${day} 应有有效流水`).toBeGreaterThan(0);
    }
    expect((byDay.get(localDayKey(NOW)) ?? 0)).toBeGreaterThan(0);
  });

  it('B 站线：周计划 bvids 与视频收藏 / 站外时长 / 进度闭合；今日站外时长非空', () => {
    const data = buildDemoDataset(NOW);
    const favBvids = new Set(data.favorites.filter((f) => f.type === 'video').map((f) => f.refId));
    const externalBvids = new Set(data.externalWatch.map((e) => e.bvid));
    const progressIds = new Set(data.videoProgress.map((v) => v.videoId));
    for (const plan of data.weeklyPlans) {
      expect(plan.bvids.length).toBeGreaterThan(0);
      for (const bvid of plan.bvids) {
        expect(favBvids.has(bvid) || externalBvids.has(bvid), `计划视频 ${bvid} 有收藏或时长`).toBe(true);
      }
    }
    for (const e of data.externalWatch) {
      expect(progressIds.has(e.bvid), `时长行 ${e.bvid} 有进度记录`).toBe(true);
      expect(e.title ?? '').not.toBe('');
    }
    expect(data.externalWatch.some((e) => e.date === localDayKey(NOW))).toBe(true);
    // 转写键与视频收藏同键
    expect(data.transcripts.some((t) => t.mediaKey === biliMediaKey('BV1DEMO7X4Kq'))).toBe(true);
  });

  it('问答与笔记：chat/notes 的 mediaKey/courId 均有转写或课次对应；复习考试模板有物理来源', () => {
    const data = buildDemoDataset(NOW);
    const transcriptKeys = new Set(data.transcripts.map((t) => t.mediaKey));
    const sessionIds = new Set(data.sessions.map((s) => s.courId));
    for (const c of data.chats) {
      expect(transcriptKeys.has(c.mediaKey), `chat ${c.id} mediaKey 有转写`).toBe(true);
      if (c.courId != null) expect(sessionIds.has(c.courId)).toBe(true);
    }
    for (const n of data.notes) {
      expect(sessionIds.has(n.courId), `note ${n.id} courId 有课次`).toBe(true);
    }
    for (const x of data.externalNotes) {
      expect(transcriptKeys.has(x.mediaKey), `外部笔记 ${x.id} mediaKey 有转写`).toBe(true);
    }
    // exam 模板作业都挂在物理（9103）相关收藏上（考试冲刺场景口径）
    const physFavs = new Set(data.favorites.filter((f) => f.courId === 1227063 || f.folderId === 'demo-folder-9103').map((f) => f.id));
    for (const j of data.reviewJobs.filter((x) => x.template === 'exam')) {
      expect(physFavs.has(j.favoriteId), `exam 作业 ${j.id} 来自物理课程`).toBe(true);
    }
  });

  it('课表：本周四门课的行齐全；kv 带 termYear；周计划存在且 perDay 合法', () => {
    const data = buildDemoDataset(NOW);
    expect(data.curriculum).toHaveLength(4);
    for (const item of data.curriculum) {
      expect(sessionIdsOf(data).has(item.courId), `课表行 ${item.courId} 有同 ID 课次`).toBe(true);
      expect(item.endTime).toBeGreaterThan(item.beginTime);
    }
    expect(data.kv.some((k) => k.key === 'schedule:termYear')).toBe(true);
    for (const plan of data.weeklyPlans) {
      expect(plan.perDay).toBeGreaterThanOrEqual(1);
      expect(plan.perDay).toBeLessThanOrEqual(20);
    }
  });
});

function sessionIdsOf(data: ReturnType<typeof buildDemoDataset>): Set<number> {
  return new Set(data.sessions.map((s) => s.courId));
}
