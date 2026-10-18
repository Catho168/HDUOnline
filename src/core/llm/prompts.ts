/**
 * 提示词模板（技术文档附录 C 逐字使用）。
 *
 * 规则（§6.5）：修改提示词必须升 `PROMPT_VERSION`（触发 aiResults 缓存失效）；
 * 提示词变更属于产品行为变更，需在 PR 中说明。
 */

import { PROMPT_VERSION } from '../shared/constants';
import type { TranscriptSegment } from '../shared/types';
import { formatClock } from '../shared/utils';

export { PROMPT_VERSION };

/** C-1 标注 + 大纲（system） */
export const TOPICS_SYSTEM_PROMPT = `你是一名严谨的大学课程内容分析助手。用户会给你一节课堂录像的语音转写文本，
每段以 [mm:ss] 开头表示该段在视频中的起始时间，文本可能有语音识别错误。

请你：
1) 提取 3–30 个"知识点"，每个知识点给出：
   - name：与课程术语一致的简短名称
   - summary：一句话客观摘要（转述，不延伸、不评价）
   - intervals：该知识点讲解的起止时间区间数组（秒，允许 1 个或多个）
   - confidence：high/medium/low（文本含糊、识别错误多、内容不完整时给 low）
   - 粒度：一个完整知识点自引入至收尾；教师重复回看旧知识点按独立条目处理
2) 生成两级大纲（L1 主题、L2 子点，合计 4–40 个节点），每个节点必须有起止时间（秒）

硬性要求：
- 只依据给定文本，禁止编造文本中不存在的内容；
- 时间必须落在文本覆盖范围内，且 start < end；
- 只输出一个 JSON 对象，不要输出任何解释、Markdown 代码块标记或多余文本；
- JSON 结构如下：{"topics":[{"name":"","summary":"","confidence":"high","intervals":[[0,0]]}],
  "outline":[{"level":1,"title":"","start":0,"end":0},{"level":2,"title":"","start":0,"end":0,"parent":0}]}`;

/** C-2 时间点问答（system；`{锚点}` 运行时替换） */
export const QA_SYSTEM_PROMPT = `你是一名课程答疑助手。下面是某节课堂录像在时间点 {锚点} 附近的语音转写（每段 [mm:ss]）。
请只依据这些内容回答用户的问题。

要求：
- 若提供的文本足以回答：给出简明、准确的中文回答，并给出你实际依据的时间范围（秒）；
- 若文本不足以回答：answer 置为空字符串，insufficient 置 true，不要猜测；
- 只输出一个 JSON 对象：{"answer":"","evidence":{"start":0,"end":0},"insufficient":false}`;

export function buildQaSystemPrompt(anchorSec: number): string {
  return QA_SYSTEM_PROMPT.replace('{锚点}', formatClock(anchorSec));
}

/**
 * 标注 + 大纲的 user 输入：转写文本按 10 分钟分块标注时间戳，附课次总时长（§6.4①）。
 */
export function buildTopicsUserPrompt(segments: TranscriptSegment[], durationSec: number, blockSec = 600): string {
  if (segments.length === 0) return '（无转写内容）';
  // 时长缺失时以转写覆盖末端兜底，避免提示词中出现“总时长 0 秒”。
  const totalSec = durationSec > 0 ? durationSec : Math.ceil(segments[segments.length - 1]?.e ?? 0);
  const lines: string[] = [];
  let currentBlock = -1;
  for (const seg of segments) {
    const block = Math.floor(seg.s / blockSec);
    if (block !== currentBlock) {
      currentBlock = block;
      const end = Math.min(totalSec, (block + 1) * blockSec);
      lines.push(`\n【第 ${block + 1} 块：${formatClock(block * blockSec)} – ${formatClock(end)}】`);
    }
    lines.push(`[${formatClock(seg.s)}] ${seg.text}`);
  }
  const header = `课次总时长：${Math.floor(totalSec)} 秒（${formatClock(totalSec)}）。以下为按时间顺序的转写文本：\n`;
  return `${header}${lines.join('\n')}`;
}

/** 问答的 user 输入：窗口内的 [mm:ss] 文本 + 追问历史。 */
export function buildQaUserPrompt(opts: {
  segments: TranscriptSegment[];
  question: string;
  anchorSec: number;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  windowRange: [number, number];
}): string {
  const context = opts.segments
    .map((seg) => `[${formatClock(seg.s)}] ${seg.text}`)
    .join('\n');
  const historyText =
    opts.history && opts.history.length > 0
      ? `\n\n最近对话（供参考，token 上限约 2000）：\n${opts.history
          .slice(-6)
          .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content.slice(0, 400)}`)
          .join('\n')}`
      : '';
  return `上下文时间范围为 ${Math.floor(opts.windowRange[0])}–${Math.floor(opts.windowRange[1])} 秒（锚点 ${Math.floor(opts.anchorSec)} 秒）。

转写内容：
${context}${historyText}

用户问题：${opts.question}`;
}

/** 校验失败后的纠错重试指令（§6.4①：追加纠错指令后原样重试 1 次）。 */
export const JSON_RETRY_INSTRUCTION = `上一次输出不符合要求：{错误}。
请重新输出**纯 JSON 对象**（不要 Markdown 代码块、不要解释文字），并确保所有时间字段为 0 到课次时长之间的数字、且 start < end。`;

export function buildRetryInstruction(errorSummary: string): string {
  return JSON_RETRY_INSTRUCTION.replace('{错误}', errorSummary);
}

/** 从模型输出中提取 JSON（容错：剥离 Markdown 代码块与前后缀文本）。 */
export function extractJson(text: string): string {
  let out = text.trim();
  const fence = out.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) out = fence[1].trim();
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  if (start >= 0 && end > start) out = out.slice(start, end + 1);
  return out;
}
