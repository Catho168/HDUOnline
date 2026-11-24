/**
 * 媒体主键抽象（B 站转写专项设计 §2，方案 b）。
 *
 * 转写链路（transcripts / aiResults / asrJobs / asrChunks / chats）的存储主键
 * 从 `courId: number` 换成 `mediaKey: string`，单键空间同时容纳两类来源：
 *  - 站内课次：`hdu:<courId>`（由 `hduMediaKey` 构造）；
 *  - B 站视频：`bili:<bvid>`（由 `biliMediaKey` 构造；阶段 2/3 接入，本阶段不会出现在库中）。
 *
 * B 站多 P（第 16 轮）：P1 保持裸键 `bili:<bvid>`（向后兼容既有落库记录），
 * p≥2 为分 P 键 `bili:<bvid>:p<N>`。bvid 本体不含 `:`，后缀无歧义；
 * 多 P 各自独立落库，cached 幂等按 mediaKey 天然分 P 隔离，互不覆盖。
 *
 * 契约：
 *  - `hduMediaKey` / `biliMediaKey` 是纯字符串拼接，输入合法即可逆
 *    （`parseMediaKey(hduMediaKey(n))` 恒等于 `{ kind: 'hdu', courId: n }`；
 *    `parseMediaKey(biliMediaKey(bvid, p))` 恒等于 p≥2 时的 `{ kind:'bili', bvid, p }`）；
 *  - `parseMediaKey` 对任何不匹配两种格式的输入返回 `null`（解析失败契约）：
 *    调用方必须显式处理 `null`，不允许假设键一定能解析；
 *  - HDU 实体记录体内保留 `courId` 字段且 HDU 记录非空（备份双向兼容：
 *    旧版本扩展导入新版备份仍可按 courId 字段使用）；`courId` 仅对
 *    `kind === 'hdu'` 的键存在，B 站记录 `courId` 缺省。
 */

/** 媒体主键：站内 `hdu:<courId>`，B 站 `bili:<bvid>` */
export type MediaKey = string;

/** 站内课次的媒体主键 */
export function hduMediaKey(courId: number): MediaKey {
  return `hdu:${courId}`;
}

/**
 * B 站视频的媒体主键（bvid，如 `BV1xx411c7mD`）。
 * p 为 1 或缺省 → 裸键 `bili:<bvid>`（P1 口径，兼容既有落库记录）；
 * p≥2 整数 → 分 P 键 `bili:<bvid>:p<N>`（bvid 不含 ':'，后缀无歧义）。
 */
export function biliMediaKey(bvid: string, p?: number): MediaKey {
  if (typeof p === 'number' && Number.isInteger(p) && p >= 2) {
    return `bili:${bvid}:p${p}`;
  }
  return `bili:${bvid}`;
}

export type ParsedMediaKey =
  | { kind: 'hdu'; courId: number }
  | { kind: 'bili'; bvid: string; /** 分 P 序号；仅 p≥2 的分 P 键存在（P1 裸键缺省） */ p?: number };

/**
 * 解析媒体主键；两种格式之外的输入（空串、未知前缀、数字不合法、bvid 为空、
 * bili 键带非法 `:p<N>` 后缀）一律返回 null，由调用方决定降级行为。
 */
export function parseMediaKey(key: MediaKey): ParsedMediaKey | null {
  if (typeof key !== 'string') return null;
  if (key.startsWith('hdu:')) {
    const courId = Number(key.slice(4));
    // Number('') === 0，会把 'hdu:' 误判为合法键：必须要求剩余部分非空且为有限数值
    if (key.length === 4 || !Number.isFinite(courId)) return null;
    return { kind: 'hdu', courId };
  }
  if (key.startsWith('bili:')) {
    const rest = key.slice(5);
    if (rest.length === 0) return null;
    // 可选分 P 后缀 `:p<N>`：N≥2 整数才认（P1 是裸键，biliMediaKey 永不产出 :p1）；
    // 非法后缀（:p0/:p1/非数字）与 bvid 本体再含 ':'（后缀形不像分 P）整体返回 null，
    // 不做静默降级——键格式由构造方保证，解析端只认两种合法形状。
    const suffix = /^(.*):p(\d+)$/.exec(rest);
    if (!suffix) {
      // 无分 P 后缀：bvid 本体不允许再出现 ':'（前缀以第一个 ':' 分隔的旧契约保留）
      if (rest.includes(':')) return null;
      return { kind: 'bili', bvid: rest };
    }
    const bvid = suffix[1] ?? '';
    if (bvid.length === 0 || bvid.includes(':')) return null;
    const p = Number(suffix[2]);
    if (!Number.isInteger(p) || p < 2) return null;
    return { kind: 'bili', bvid, p };
  }
  return null;
}

/** 便捷方法：取 HDU 键里的课次 ID；非 HDU 键（或非法键）返回 undefined。 */
export function hduCourIdOf(key: MediaKey): number | undefined {
  const parsed = parseMediaKey(key);
  return parsed?.kind === 'hdu' ? parsed.courId : undefined;
}

/**
 * transcripts 主键集合里是否已有该 bvid 的字幕（读侧前缀匹配，第 36 轮巡检抽为共享助手）：
 * P1 裸键 `bili:<bvid>` 或 p≥2 分 P 键 `bili:<bvid>:p<N>`（与 biliMediaKey 的键形状对应）。
 * 前缀必须带 `:p` 后缀边界，否则 `bili:BV1abc` 会误匹配相邻 bvid `bili:BV1abcd` 的键。
 * 纯字符串判定，不涉及存储访问：调用方经 `transcript.keys` 一次取全库主键（仅键不载
 * 正文），再对列表里各 bvid 逐一比对；点开「查看字幕」时由 BiliSubtitlePanel 自行经
 * `transcript.get` 拉正文。
 * （原为 LearningCenter 的本地读侧助手，第 36 轮起 B 站学习中心面板 BiliHubPanel
 * 复用同一口径，消除两处各自拼前缀的漂移风险。）
 */
export function hasBiliTranscriptKey(keys: readonly string[], bvid: string): boolean {
  const base = `bili:${bvid}`;
  return keys.some((key) => key === base || key.startsWith(`${base}:p`));
}
