/**
 * 站点导航（学习中心 → 站点页面）。
 *
 * 学习中心里点「去学习」需要把用户送回站点的播放页。站点是 hash 路由 SPA，
 * 因此这里只做 hash 构造 + 赋值，不涉及任何站点内部状态写入。
 *
 * 说明：`play-center` 是站点新播放页形态，其 URL 契约（是否接受 `courseId`）尚待真实站点复测；
 * 传入 `courseId` 不会破坏页面（站点会忽略未知参数），但若站点忽略了它，
 * 打开的会是默认课次——此时插件界面会显示“当前正在播放的课次”，不会张冠李戴。
 */

export interface LessonLinkInput {
  teclId?: number;
  teclCode?: string;
  subjId?: number;
  courId?: number;
  /** 目标播放页形态；默认 play-center（站点当前形态） */
  prefer?: 'play-center' | 'video-detail';
}

/** 构造播放页 hash（含前导 `#`） */
export function lessonHash(input: LessonLinkInput): string {
  const prefer = input.prefer ?? 'play-center';
  const params = new URLSearchParams();
  if (input.teclId !== undefined && input.teclId > 0) params.set('teclId', String(input.teclId));
  if (input.teclCode) params.set('teclCode', input.teclCode);
  if (input.subjId !== undefined && input.subjId > 0) params.set('subjId', String(input.subjId));
  if (input.courId !== undefined && input.courId > 0) params.set('courseId', String(input.courId));
  if (prefer === 'play-center') params.set('target', 'video');
  // 参数顺序固定（teclId 在前）便于日志与自动化断言
  return `#/${prefer}?${params.toString()}`;
}
