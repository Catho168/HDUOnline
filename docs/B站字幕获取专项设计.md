# B 站字幕获取专项设计（第 14 轮实施定稿）

> 第 11 轮巡检规划、第 12 轮落地的「B 站转写专项」于第 14 轮**方向变更**为字幕获取专项。
> 本文档全文重写，替代原《B 站转写专项设计.md》（git mv 改名，历史版本见 git log）。
> 所有引用均来自 main@7ffd9b7 真实代码；守护网基线：新增 39 例单测（3 文件）+ 既有全量回归。

## 0. 方向变更记录

- **2026-11-15 用户裁决**：「B 站转写无用，改为官方字幕获取，无字幕作罢」。B 站视频不再做本地 ASR 转写；改为拉取 B 站官方（UP 主 / AI）字幕，视频没有可用字幕时**直接作罢**（不抛错、不落库、UI 给中性提示而非错误样式）。
- **阶段 2（音频适配器）已剔除**：同轮前一任务删除了 `core/bili/audio.ts`、`entrypoints/background/biliReferer.ts`（DNR Referer 注入）与 `wxt.config.ts` 中的 `declarativeNetRequest` 权限及 `*.bilivideo.com` / `*.akamaized.net` host 授权，相关音频拉取/分片解码测试一并移除。原设计的 playurl 音轨、fMP4 探测、Referer 注入三条链路整体作废。
- **保留成果**：第 12 轮阶段 1 的 mediaKey 抽象与 DB v5 迁移（`core/shared/mediaRef.ts`、transcripts/aiResults/asrJobs 主键 mediaKey 化）原样保留——它正是本次「B 站字幕直接落 transcripts、被统一搜索/QA 链路复用」的前提。

## 0.1 后续轮次修订记录（第 15/16 轮，覆盖本文过时表述）

- **多 P 键（第 16 轮）**：mediaKey 语法扩展为 P1 裸键 `bili:<bvid>`（向后兼容）+ p≥2 分 P 键 `bili:<bvid>:p<N>`；`biliMediaKey(bvid, p?)` / `parseMediaKey` 同步扩展。§2.2 落库表的「mediaKey = `bili:<bvid>` 主键」应按此理解；cached/force 幂等按分 P 键天然隔离。
- **搜索跳转（第 15 轮）**：§1「B 站字幕命中可被搜到但点击不可跳」已过时——`search.all` op 层回查收藏补标题，unified 生成 `{type:'url'}` 站外跳转（`?t=` 锚点、`?p=` 分 P 兼容，经 `safeExternalUrl` 协议白名单）。
- **知识库入口（第 15 轮）**：Library 视频卡片新增「字幕已就绪」徽标与「查看字幕」入口（`transcript.keys` 键集合前缀匹配 + `BiliSubtitlePanel` external 模式）。
- **none 记忆（第 16 轮）**：无字幕作罢结果在 SW 内存记 10 分钟（不落库），重复点击不再打接口；force 穿透。
- **浮层增强（第 16 轮）**：当前播放行高亮（`currentTime` prop，500ms 节流）与「AI 生成」标记（`TranscriptEntity.aiSubtitle?`）。

## 1. 现状基线（复验仍有效的引用）

- **mediaKey 方案（已落地）**：`core/shared/mediaRef.ts` 的 `biliMediaKey(bvid) → 'bili:<bvid>'` 与 `parseMediaKey`（解析失败返回 null 契约）；`TranscriptEntity` 主键为 mediaKey，`courId` 仅 HDU 记录非空。
- **TranscriptEntity 字段语义**（`core/shared/types.ts`，本次落库口径的依据）：
  - `segments: { s, e, text }` —— **时间单位为秒**（unified search 的 `startSec`、QA 的 `anchorTime`、续看 `?t=` 均按秒消费；HDU 本地 ASR 亦直接落秒）；
  - `coverage` / `coveredSec` —— 「已实际处理过的音频区间并集」；对字幕场景取**字幕实际覆盖区间**（有文字的区间，非音频全程）；
  - `source` —— 原为单值 `'local-asr'`，本次扩展为 `'local-asr' | 'bili-official-subtitle'`（全库无读取方，扩展安全）；
  - `partial` / `window` / `pipelineVersion` / `threadId` 属转写管线概念，B 站字幕不适用（partial 固定 false，其余缺省）。
- **repo 层**：`getTranscript(mediaKey)` / `putTranscript(entity)`（`core/db/repo/content.ts`；写入自动补 `updatedAt`）；无独立 saveTranscript。
- **B 站请求底座（本次下沉）**：原 `background/bili.ts` 的 fetch 管线（credentials:'include'、`assertUrlAllowed` SSRF 校验、15s 超时、-352/-412/-799 风控码分类与可重试集合、wbi key 模块级缓存 1h、`toQuery`）下沉为 `core/bili/apiClient.ts`；`background/bili.ts` 收敛为收藏夹业务组装并 re-export `fetchBiliNav`。字幕适配器 `core/bili/subtitle.ts` 复用同一底座，`signWbiParams` 复用 `core/bili/wbi.ts`。
- **UI 宿主**：`bilibili.content.tsx` 已有 shadow root（`BILI_HOST_ID`）、FAB/续看 chip/收藏弹层注入模式、`bili-*` 类与 `core/bili/theme.ts` 的 `isBiliHostDark` 暗色判定（`data-theme` 已挂 `.bili-root`）；bvid 从 URL `/video/(BV[\w]+)` 提取；页内 seek 先例 = 续看 chip 的 `video.currentTime = positionSec`；`?t=` 续看链接先例 = `core/search/unified.ts` 的 `resumeUrlOf`。
- **op 注册模式**：`core/shared/ops.ts` OpMap 声明 + `entrypoints/background/ops.ts` handler 表；消息分发是泛型的（`dispatchOp(message.op, args)`），新增 op 无需改消息路由。
- **权限现状（`wxt.config.ts`）**：已有 `www.bilibili.com/*` 与 `api.bilibili.com/*`；`aisubtitle.hdslb.com` 原不在权限内（见 §5 host 决定）。
- **统一搜索**：`searchTranscriptsByCourse` cursor 全扫 transcripts，B 站记录自动入扫；`buildTranscriptEntry` 对 mediaKey-only（无 courId）记录标题兜底为 `课次 ${mediaKey}`（`search.all` op 层对 B 站记录不回查 sessions），条目无站内跳转——B 站字幕命中可被搜到但点击不可跳，属已知现状（下轮建议 §6）。

## 2. 字幕 API 链路设计

### 2.1 接口链路（`core/bili/subtitle.ts`）

```
pagelist    GET https://api.bilibili.com/x/player/pagelist?bvid=
            → data: [{ cid, duration, … }]（数组；p 从 1 计取对应分 P，缺省 P1，越界回退）
player      GET https://api.bilibili.com/x/player/wbi/v2?bvid=&cid=(&wts=&w_rid=)
            （wbi 签名复用 signWbiParams；credentials:'include'；15s 超时；SSRF 校验 assertUrlAllowed）
            → data.subtitle.subtitles[]：[{ lan, lan_doc, subtitle_url, ai_type, ai_status, … }]
subtitle    GET subtitle_url（协议相对 // 补 https；官方 CDN aisubtitle.hdslb.com）
            → { body: [{ from, to, content, … }] }（from/to 为秒）
```

- **无字幕作罢**：`subtitles[]` 为空 → 返回 `{ status:'none' }`（不抛错）；有轨但正文解析为 0 段 → 同样作罢。作罢不是错误：op 层不落库，UI 弹中性提示。
- **选轨口径**（`pickSubtitleTrack`，注释即规格）：
  1. **UP 主字幕优先于 AI 字幕**（`ai_type`：0=人工 / 1=AI 识别生成；`ai_type` 缺失时以 `ai_status === 1` 兜底判 AI——ai_status 的独立语义文档未明确，需真机验证）；
  2. **同为一级时 zh/中文优先**（lan 以 `zh` 开头，或 `lan_doc` 含「中文」）；
  3. 其余保持接口返回顺序（稳定排序兜底）。
- **segments 映射**：`body[].from/to/content` → `TranscriptSegment { s, e, text }`。B 站 from/to 与仓库 s/e **同为秒，直接映射不换算**；`to < from` 收口到 from；缺 content/时间的行跳过；按 from 升序排序。
- **coverage**：segments 的 `[from, to]` 区间并集（`mergeCoverage` 合并重叠/相接区间），`coveredSec` = 区间长度和。
- **错误分类**：全部走 `core/bili/apiClient.ts` 的 `BILI_API_FAILED` AppError——-352/-412/-799 可重试（风控/限流），-101 未登录等不可重试；HTTP 5xx/429 可重试；userMessage 带中文语义提示。

### 2.2 落库口径（op：`bili.subtitle.fetch`）

| 字段 | 值 | 说明 |
|---|---|---|
| mediaKey | `bili:<bvid>` | 主键 |
| courId | 不写 | B 站无课次 |
| segments | 映射结果 | 秒 |
| source | `bili-official-subtitle` | 非 ASR 产物的来源标记 |
| model | `bili-official-subtitle` | 无推理模型，占位标明来源 |
| lang / lanDoc | 轨的 `lan`（缺省 `'und'`）/ `lan_doc` | lanDoc 仅在结果里回传（toast 展示），不落库 |
| glossaryVersion | 0 | 未应用词表纠错 |
| coverage / coveredSec | 字幕实际覆盖区间 | 见 §1 语义 |
| durationSec | pagelist 的分 P duration | 缺失不写（QA 兜底链可用） |
| partial | false | 完整产物 |
| window / pipelineVersion / threadId | 不写 | 转写管线概念 |
| asrJobs | 不写 | 无转写作业 |

op 结果（可结构化克隆的小对象）：
- `{ status:'ok', cached:boolean, segments:number, lan, lanDoc }`；
- `{ status:'none' }`。

handler 行为：已有字幕且 `!force` → 幂等返回 cached（不拉接口）；否则拉取 → none 直接返回（**不落库**）→ ok 落库返回。force 重拉得到 none 时**保留旧字幕**（不删库）。

## 3. UI 设计（最小可用闭环）

- **入口**：主 FAB 上方一枚独立小按钮（`bili-sub-fab`，CC 图标）——不改变「单击 FAB 直达收藏弹层」的既有语义；续看 chip 从 bottom:158px 上移到 216px 让出槽位。
- **交互**：点击 → `bili.subtitle.fetch` → toast 三态：
  - ok/cached → 「字幕已就绪（N 条 · 语言）」并打开查看浮层；
  - none → 「该视频没有可用字幕」——中性深灰 toast（**非错误样式**，作罢语义）；
  - 失败 → 红底 `is-error` toast 透出 AppError.userMessage。
- **字幕查看浮层**（`entrypoints/content/ui/BiliSubtitlePanel.tsx`，渲染于 shadow root）：`transcript.get` 读 `bili:<bvid>` → 时间 + 文本列表；点击行 seek 到该句起点——页内直接设 `<video>.currentTime`（续看 chip 同路径，不整页刷新），无 `<video>` 元素时回退 `?t=<sec>` URL 跳转（`resumeUrlOf` 口径）。
- **暗色适配**：浮层复用 `bili-modal` 结构类，自有 `bili-sub-*` 样式类；暗色变量覆盖**作用域限定在 `.bili-sub-modal`**（收藏弹窗维持亮色的既有取舍不变），入口按钮单独适配暗色。
- **刻意不做**（列下轮建议）：问答面板、AI 字幕标注、字幕层实时 overlay、当前播放行高亮。

## 4. 分阶段实施

| 阶段 | 内容 | 状态 |
|---|---|---|
| **本轮（第 14 轮）** | `core/bili/apiClient.ts`（请求底座下沉）、`core/bili/subtitle.ts`（字幕适配器）、op `bili.subtitle.fetch`（shared/ops + background/ops）、UI（FAB 入口 + 查看浮层）、`wxt.config.ts` 加 `aisubtitle.hdslb.com` host、单测 39 例、文档改名重写 | **已完成** |
| 后续候选 | 统一搜索 B 站字幕条目的跳转（mediaKey → bvid URL ?t=）；B 站记录标题取收藏 snapshot（替代「课次 bili:xxx」兜底）；多 P 支持（UI 读 ?p 传参）；当前行播放位置高亮；AI 字幕标记展示；按需清理（transcript.clear 已按 mediaKey 前缀清 chunks，天然兼容） | 待做 |

每阶段独立可回归：本轮验收 = compile 0 错 + 全量单测绿（含既有回归）；不涉及 DB 迁移。

## 5. 真机验证项（无法离线验证，标注「需真机验证」）

1. **AI 字幕可见性**：登录态（SESSDATA）下 `player/wbi/v2` 是否返回 `ai_type=1` 的 AI 轨、未登录/无大会员时的差异；`ai_status` 的独立语义（当前仅作 ai_type 缺失时的兜底信号）。
2. **wbi 签名**：player/wbi/v2 对 `bvid+cid` 参数集的实际校验行为（签名算法复用收藏夹导入已验证的 `signWbiParams`，但该接口的参数集未真机打过）。
3. **subtitle_url 域**：官方字幕 JSON 是否固定在 `aisubtitle.hdslb.com`。**host_permissions 决定：已加 `https://aisubtitle.hdslb.com/*`**——SW 内直拉 subtitle_url 需要该 host 授权（否则跨域被 CORS 拦截）；替代方案（content-script 中继页面 fetch）依赖 CDN 对页面源的 ACAO 头、契约不可控，故按「只读、单一官方 CDN 域」的最小授权原则加白。若实测出现其他 hdslb 子域，需按同一原则增量加白。
4. **字幕 JSON 结构**：`body[].from/to/content` 字段名与秒单位（社区文档口径，代码已做防御式解析：非数值行跳过、to<from 收口）。
5. **无字幕视频的响应形状**：`subtitles` 为空数组还是字段缺失（两种都已按 none 处理，防御面已覆盖）。
6. **多 P**：UI 当前固定 P1（bvid 提取不含 ?p），适配器已支持 `p` 参数（pagelist 映射），多 P 网课场景待真机数据后再接 UI。

## 6. 不在本专项范围

- B 站本地 ASR 转写（方向已废弃；音频链路代码已剔除，如重启需重新立项）。
- 弹幕/评论抓取、AI 人物识别、任何形式的风控绕过；合规边界 = 用户已登录会话内、与播放器同一可见接口的只读拉取。
- 付费/充电专享、番剧/课程（cheese）字幕；B 站侧笔记/截图/统计并入站内 watchRecords（externalWatch 独立通道继续）。
- 字幕层实时 overlay、问答面板、AI 标注（见 §3 刻意不做清单，留作下轮候选）。
- 转写模型档位、多语言策略变更（站内 ASR 设置不受影响）。
