import { SELECTORS } from '@/core/shared/constants';
import { createLogger } from '@/core/shared/logger';

export const log = createLogger('content');

export const LIST_ROUTES = new Set(['home', 'list-video', 'list-live']);

export interface CourseSyncResult {
  ok: boolean;
  skipped?: boolean;
  courses: number;
  sessions: number;
  error?: string;
}

export interface ScheduleSyncResult {
  ok: boolean;
  count: number;
  skipped?: boolean;
  error?: string;
}

/** 读取播放页顶栏文本（剔除本扩展注入的受控节点：注入内容不得进入课次识别证据链） */
function readPlayHeaderTextForObservation(): string {
  const root = document.querySelector(SELECTORS.playHeader);
  if (!root) return '';
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[data-hdu-anchor-chip]').forEach((el) => el.remove());
  return clone.textContent ?? '';
}

/** 从播放页顶栏读取教师名（站点接口偶尔不返回教师字段，但顶栏仍会展示） */
export function parseTeacherNamesFromDom(): string[] {
  const text = readPlayHeaderTextForObservation();
  const matched = text.match(/(?:教\s*师|老\s*师)[：:]\s*([^·|｜/]+)/);
  if (!matched?.[1]) return [];
  const names = matched[1]
    .split(/[、，,；;/|]+/)
    .map((item) => item.trim())
    // 顶栏可能写成“教师：张三 第5周”，把后面的周次/节次片段剔除
    .filter((item) => item.length > 0 && item.length <= 30 && !/^第?\d+(?:[-–~至]\d+)?\s*[周节]/.test(item));
  return [...new Set(names)];
}
