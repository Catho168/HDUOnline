/**
 * 收藏卡「复习状态徽标」纯函数（第 244 轮巡检，知识库域 / 反馈视角）。
 *
 * 选型说明（数据可得性研判后定为 B：仅当前状态）：ReviewJobEntity 只有当前
 * status（pending/done/skipped）+ updatedAt（done 作业的完成时间），无逐轮
 * 结果历史——知识库卡片此前只有「复习中」（review.due，仅今日到期，第 102 轮）
 * 与「上次复习 MM/DD」（done 最近一次，第 224 轮）两枚孤岛 chip，看不到
 * 「复习中但还有几天到期」「已逾期多久」。本函数把单个 pending 作业的状态
 * 映射为一枚分色徽标（与知识库筛选口径 reviewAnyIds 第 229 轮同源：全量
 * pending 作业按 favoriteId 归属）：
 *  - 逾期（dueDate < today）→ danger「复习中 · 已逾期」
 *  - 今日到期（dueDate === today）→ jade「复习中 · 今日到期」
 *  - 未来（dueDate > today）→ accent「复习中 · M月D日到期」
 *  - 无作业（null/undefined）→ default「未入计划」（与「未入计划」筛选计数同口径）
 * done/skipped 作业返回 null（卡片由既有「上次复习 MM/DD」chip 承接反馈视角，
 * 不叠加重复标注）；脏 dueDate 不标（与 7 日预测跳过脏数据同口径）。
 *
 * 语义色遵循第 243 轮速查表：danger=风险/逾期、jade=今日到期（正向行动）、
 * accent=强调/进行中、default=中性元信息。
 */
import { localDayKey } from '@/core/shared/utils';

export type ReviewBadgeTone = 'danger' | 'jade' | 'accent' | 'default';

export interface ReviewBadge {
  tone: ReviewBadgeTone;
  label: string;
  /** hover/读屏口径说明（克制标注：徽标本体只留短文案，口径进 title） */
  title: string;
}

/** 徽标入参：只读作业的两个状态字段（ReviewJobEntity 的最小面） */
export interface ReviewBadgeJobInput {
  status?: unknown;
  dueDate?: unknown;
}

const DAY_MS = 86_400_000;
const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'] as const;

function parseDayKey(key: unknown): [number, number, number] | null {
  if (typeof key !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  // round-trip 校验：拒绝语义溢出（2026-13-40 之类；Date 构造会把溢出滚动归一）
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return [y, mo, d];
}

function monthDayLabel(dateKey: string): string {
  const parts = parseDayKey(dateKey);
  if (!parts) return dateKey;
  return `${parts[1]}月${parts[2]}日`;
}

function weekdayLabel(dateKey: string): string {
  const parts = parseDayKey(dateKey);
  if (!parts) return '';
  const day = new Date(parts[0], parts[1] - 1, parts[2]).getDay();
  return WEEKDAY_LABELS[day] ?? '';
}

/** 两个日键的自然日差（a - b，跨月/跨年按日历日计） */
function dayKeyDiff(a: string, b: string): number {
  const pa = parseDayKey(a);
  const pb = parseDayKey(b);
  if (!pa || !pb) return 0;
  const ta = new Date(pa[0], pa[1] - 1, pa[2]).getTime();
  const tb = new Date(pb[0], pb[1] - 1, pb[2]).getTime();
  return Math.round((ta - tb) / DAY_MS);
}

/** 未入计划徽标（无任何复习作业；与「未入计划」筛选计数同口径） */
const UNPLANNED: ReviewBadge = {
  tone: 'default',
  label: '未入计划',
  title: '该收藏还没有加入复习计划；点卡片操作里的「加入复习」即可按遗忘曲线排期',
};

/**
 * 复习状态徽标映射（详见文件头注释）。
 * @param job   pending 复习作业（最少 status + dueDate）；null/undefined = 未入计划
 * @param today 本地今日日键（缺省取 localDayKey()，单测注入固定值）
 * @returns 徽标；done/skipped 或脏 dueDate 返回 null（调用方不渲染，卡片保留
 *          既有「上次复习」chip 承接完成反馈）
 */
export function reviewBadgeForJob(job: ReviewBadgeJobInput | null | undefined, today: string = localDayKey()): ReviewBadge | null {
  if (!job || typeof job !== 'object') return UNPLANNED;
  if (job.status !== 'pending') return null;
  const due = typeof job.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(job.dueDate) ? job.dueDate : null;
  if (!due || !parseDayKey(today)) return null;
  const diff = dayKeyDiff(due, today);
  const dueText = `${monthDayLabel(due)}（周${weekdayLabel(due)}）`;
  if (diff < 0) {
    return {
      tone: 'danger',
      label: '复习中 · 已逾期',
      title: `${dueText} 到期，已逾期 ${-diff} 天；到复习计划完成或顺延`,
    };
  }
  if (diff === 0) {
    return {
      tone: 'jade',
      label: '复习中 · 今日到期',
      title: '今日到期，到复习计划（或今日待办）完成这一轮',
    };
  }
  return {
    tone: 'accent',
    label: `复习中 · ${monthDayLabel(due)}到期`,
    title: `${dueText} 到期，还有 ${diff} 天`,
  };
}
