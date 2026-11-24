# HDUOnline 演示视频 · 设计 spec（video-shotcraft 自主自由创作）

## 阶段 0 · 产品简报

- **产品**：HDUOnline — 杭电智慧课堂学习助手（Chrome MV3 扩展，WXT + React）。
- **定位**：把 `course.hdu.edu.cn` 智慧课堂改造成个人学习中心；本地转写 + AI 知识标注 + 学习统计，数据只在本机。
- **用途**：产品演示/宣传片，尽可能全地展示特色功能；画面数据全部为本地 fixture 假数据。
- **受众**：在校学生对"学习工具"的实用期待 + 开源/产品发布场景的完整功能巡礼。
- **画幅/帧率**：1920×1080 @ 30fps。
- **时长**：约 60s（功能多，按"低能开场 → 功能段与呼吸位交替 → 高能收尾"排布）。
- **语言**：中文；无配音，关键字幕卡 + BGM + SFX。
- **核心卖点（必须展示）**：
  1. 站点级**学习中心**接管（总览/我的课程/课表与补看/知识库/学习统计 + 一键切回站点原页面）；
  2. 播放页**本节助手**（本地转写字幕、AI 标注 + 两级大纲、时间点问答、时间戳笔记、收藏、字幕搜索、板书截图）；
  3. **B 站学习助手**（四悬浮入口、字幕搜索、收藏此时刻、AI 标注 + 播放器时间轴标记条、知识库/今日复习/统计、复习回跳）；
  4. **本地转写**（WebGPU Whisper，片段流式，音频不出本机）；
  5. **学习统计**（有效观看口径、完看度、连续天数、补看清单）；
  6. **隐私主张**（数据只在本机、不写站点接口、可导出）。

## 需求 → 执行决策表

| 决策项 | 结论 | 依据/取舍 |
|---|---|---|
| 片种 | 产品功能宣传片（镜头卡体系） | "尽可能展示所有特色功能"= 多镜头清单式巡礼，镜头卡结构最合适 |
| 时长 | ~60s（1800 帧 @30fps） | 9 个镜头段 × 平均 5-7s，功能全覆盖且留呼吸位 |
| 画幅 | 1920×1080 横屏 | 桌面端扩展产品，场景以浏览器页面为主 |
| 配音 | 无 | 中文 TTS 链路不可靠；宣传片惯例 BGM+字幕卡 |
| 字幕 | 关键字幕卡（每镜 ≤1 句） | 保证静音观看也能读懂卖点 |
| BGM | 自主选型，从 assets/audio/bgm 备选中试听选定 | 用户未指定；选轻快知性、非强鼓点，降低卡拍刚性 |
| SFX | Freesound CC0，动作拟音（whoosh/impact/click/sparkle） | 按 sound-design 句式，少量关键拍 |
| 数据口径 | 全部假数据：fixture 站点 + evalInExtPage 预置 IndexedDB | README 截图同源（"本地模拟站点与占位数据"）；不碰真实账号/课程 |
| 素材路线 | 真实截图：dev 构建 + fixture + headless Chrome 加载扩展后截取 | 符合核心理念"复刻既有页面必须用真实截图" |
| 视觉方向 | 「纸面课堂」— 从产品 UI 提取暖纸/墨黑/琥珀 tokens | 见阶段 1 |

## 阶段 1 · 视觉方向与 styleframe（已定案）

**三个候选方向**：
1. **纸面课堂**（选定）：暖纸底 + 墨字 + 琥珀强调 + 衬线大字；动效隐喻 = 批注/誊写/盖章/翻页——与"笔记/标注/收藏"功能语义一一对应。
2. 时间轴主线：以播放器进度轴为全片脊柱，功能是轴上长出的标记。→ 吸收为 B 站段的具体动效（AI 时间轴标记条本是产品功能）。
3. 双屏对话：站点原页面 vs 学习中心分屏对照。→ 弃，信息密度低、叙事割裂。

**产品设计 tokens（提取自 src/entrypoints/content/ui/styles.ts）**：
- 亮色主题：paper `#f5f1e8` / paper-2 `#fffdf8` / ink `#171a1d` / muted `#8c877c` / accent `#a4551b` / accent-2 `#dfa05a` / accent-soft `#f1e2cc` / line `#e2d9c8` / line-strong `#cfc3ad` / red `#f08a82`
- 字体：serif = Noto Serif SC / Songti（显示标题）；sans = PingFang SC / Microsoft YaHei（正文）；mono = Cascadia/Consolas（时间戳、数字）
- 材质：细颗粒纸纹、1px 暖线边框、大圆角卡片、柔和投影

**动效性格 tokens**（教育=平静关怀 与 亲和友好 之间取中）：
- 主时长 ~30f；入场 easing `cubic-bezier(0.25,0.46,0.45,0.94)`；过冲 ≤1.04；squash ≤0.06
- 相机：慢推近/横移为主，无手持 shake；批量入场靠运动不靠群发光效
- hold：每镜落定 ≥0.6s（18f），字标 hold ≥1.2s（36f），开场主体动作 ≥3s

**styleframe**：`promo/styleframe/index.html`（A 开场 hook / B 播放页助手 / C 字标），截图验收通过：色板、字体层级、构图、信息密度均达标。

## 阶段 2 · 功能到镜头映射（卡名已按 shots-index.json 校验存在）

| # | 产品功能 | 镜头卡（首选） | 备选 | 选择依据 |
|---|---|---|---|---|
| S01 | 站点页 → 学习中心接管 | `transition/print-texture-transitions`（ink-bleed-reveal） | `ui-entrance/neon-frame-orbit-drop` | 墨渗"吃掉旧景揭出新页"= 接管语义 + 纸质视觉 |
| S02 | 学习中心 5 页签巡礼 + 一键切回 | `camera/cursor-flyover` | `ui-entrance/page-waterfall-wall` | 光标先导、逐区特写，天然的多页签巡游语法 |
| S03 | 本地转写 → 字幕逐段落库 | `ui-entrance/row-embed` | `interaction/glass-pill-dictation-typing` | 字幕行"从空中落进面板嵌入"= 转写落库；配波形活性 |
| S04 | AI 标注 + 两级大纲 | `effects/scanline-annotate-focus` | `effects/scanline-assemble-flyin` | 扫描线掠过→取景框对准→贴出标签，字面意义的"标注" |
| S05 | 时间点问答（锚定播放位置） | `interaction/glass-pill-dictation-typing` | `typography/blur-slide` | 打字提问的胶囊 + 回答逐词显影（blur-slide 作答句揭示） |
| S06 | 时间戳笔记 / 收藏 / 截图 | `ui-entrance/element-body-moves`（contact-shadow-lift） | `ui-entrance/list-stack-press` | 纸片离桌抬起 = 笔记；盖章式落库 = 收藏（impact 元素级） |
| S07 | 呼吸位：进入 B 站篇 | `typography/paper-title-card` | — | 一句话压印上纸，隔开两幕 |
| S08 | B 站四入口 + 字幕搜索 + 收藏此时刻 | `interaction/type-and-filter` | `ui-entrance/list-reveal` | 真实 UI 打字搜索、结果收敛；四 FAB 用 list-reveal 落定 |
| S09 | B 站 AI 时间轴标记条 + 复习回跳 | `data/timeline-travel` | `transition/line-carry-transition` | 沿时间轴急刹逐格弹立 = 标记条；"去复习"回跳时间点 |
| S10 | 学习统计（完看度/连续天数） | `data/chart-live-moves`（unit-dot-swarm-regroup） | `data/gauge-readout-moves` | 点群迁徙聚成数字，统计数字有"生长感" |
| S11 | 隐私主张：数据只在本机 | `typography/paper-title-card` | `effects/scan-bracket-sweep` | 安静一拍，把最重的承诺读清楚 |
| S12 | 结尾字标 | `outro/logo-shrink-wordmark-lockup` | `outro/ui-strip-away-outro` | 收束成 学 印章 + HDUOnline lockup + 标语 |

全片主线（carry）：**一条琥珀色进度线**——S02 从总览长出，S03 变成转写覆盖条，S04 载着标注扫过，S05 是它的锚点脉冲，S09 在 B 站时间轴上显形，S10 汇成统计数字，S12 收进字标下划线。片名"把进度握在手里"由这条线 physically 说出。

## 阶段 3 · 分镜与帧级时间轴（30fps，总长 1974f ≈ 65.8s，自行放行）

| shot | from | dur | 内容与页面状态 | 卡/变体 | 字幕卡 | 转场/SFX |
|---|---|---|---|---|---|---|
| S01 | 0 | 240f | fixture 站点原页（真实截图）→ 墨渗洇开 → 学习中心总览（真实截图）→ 主标题落版+马克笔划线 | print-texture ink-bleed + marker-underline | 把课堂留下，把进度握在手里。 | ink-bleed 洇开声（低频 riser→soft impact） |
| S02 | 240 | 285f | 学习中心：光标飞到 总览→我的课程→课表与补看→知识库→学习统计 四站特写，末尾点「站点原页面」切回 | cursor-flyover | 学习中心：总览 · 课程 · 课表 · 知识库 · 统计 | whoosh×4 + 点击 click；末站 click 回切 |
| S03 | 525 | 180f | 播放页（真实截图）：「生成字幕」→ 波形起 → 字幕行逐条嵌入面板，覆盖条走满 | row-embed + 波形元素 | 本地 Whisper · 音频不出本机 | typing/纸落声，覆盖条走满 soft tick |
| S04 | 705 | 195f | 扫描线掠过面板，3 个知识点卡依次被取景框对准贴标；大纲树两级展开 | scanline-annotate-focus | AI 标注 · 大纲 · 点击跳转时间点 | scan 匀速 hum + 每次贴标 stamp hit |
| S05 | 900 | 210f | 播放位置锚点脉冲 → 玻璃胶囊打出问题「特征值是什么？」→ 回答逐词显影 + 依据时间戳 chip | glass-pill-dictation-typing + blur-slide | 问答 · 只依据附近字幕 · 支持 Claude/OpenAI/本地模型 | 键击细声 + 回答显影 sparkle（单点） |
| S06 | 1110 | 135f | 笔记卡离桌抬起（接触阴影）→ 盖「藏」章飞入知识库摞，计数 +1；截图缩略卡片贴入 | element-body-moves（contact-shadow-lift）+ list-stack-press 元素 | 笔记 · 收藏 · 截图，统统进知识库 | 纸抬 whoosh + 盖章 impact |
| S07 | 1245 | 54f | 呼吸位：B 站也能学 | paper-title-card | — | 一声纸翻 |
| S08 | 1299 | 150f | B 站页（真实截图）：四枚 FAB 依次落定 → 字幕搜索打字「交换律」→ 命中 1 条高亮 → 收藏此时刻红章 | type-and-filter + list-reveal | B 站学习助手 · 字幕搜索 · 收藏此时刻 | FAB 落定 pop×4 + 打字 + 收藏 impact |
| S09 | 1449 | 165f | 播放器时间轴横移急刹，AI 标记条逐格弹立铺满；「去复习」回跳对应时间点 | timeline-travel | AI 时间轴标记 · 复习直接回跳 | 轴上滑行 riser + 急刹 brake hit |
| S10 | 1614 | 135f | 统计页（真实截图底）：点群游走聚成「96%」完看度，再聚「12 天」连续学习 | chart-live unit-dot-swarm-regroup | 完看度 · 连续天数 · 补看清单 | 点群沙沙声 + 聚成数字 soft impact×2 |
| S11 | 1749 | 75f | 呼吸位：数据只在本机。 | paper-title-card | — | 静，只留 BGM |
| S12 | 1824 | 150f | 学印章收束 → HDUOnline 字母逐个滑入 → 标语 + 进度线收成下划线，hold ≥1.2s | logo-shrink-wordmark-lockup | HDUOnline · 智慧课堂学习助手 | 收束 whoosh + 落定 impact + 尾音 |

**呼吸位预算**：S01 落定 hold 30f；S02 每站停留 24f；批量入场（S04 贴标、S08 FAB、S09 标记）收尾各留 ≥15f 静止；S12 字标 hold 36f。镜头时长 1.8s–9.5s，最大/最小 ≈ 5.3×，无等长节拍。

**素材清单（阶段 4 采集目标，全部 fixture 假数据）**：
1. `home-overview` 学习中心总览整页（2x）+ 顶栏/hero 卡/统计卡 cutout
2. `courses` 我的课程页整页；`schedule` 课表与补看整页；`library` 知识库整页；`stats` 学习统计整页
3. `player` 播放页整页（含助手面板速览态）+ 播放器区 cutout + 面板 cutout
4. `bili` B 站模拟页整页（含四 FAB + 助手面板）+ 播放器区 cutout
5. 上述页面关键元素的 layout.json 坐标表；空 backplate（隐藏面板后的播放页）

- **假数据边界**：仅使用 `tests/fixtures/`（模拟站点 + 占位接口）与脚本预置进扩展 IndexedDB 的虚构数据（transcripts/aiResults/favorites/reviewJobs/chats）；课程名沿用 fixture 的"线性代数（模拟课程）"等占位名；不出现真实账号、真实直链、真实课程内容。
- **音频**：BGM 用仓库内已授权备选（ATTRIBUTION.md）或用户后续指定；SFX 走 Freesound CC0，下载失败不静默替代。

## 阶段 5 · 实现记录

- 工程：`promo/video/`（Remotion，1920×1080@30fps，系统 Chrome 渲染，Noto Serif SC 本地打包离线可用）。
- 素材：`public/textures/` = 阶段 4 的 13 张 2x 真实截图（fixture 假数据 + 预置 IndexedDB）。
- 静帧自检：`out/qa/` 按帧号归档；已修 S01 品牌字幕 chip、S02 相机表/光标、S03 覆盖线锚位、S04 取景框 bbox/扫描线收尾、S05 锚点冗余、S08 双列 FAB 补丁/搜索框对位、S10 字号、S12 lockup 对位。
- 动效工作台清单：`src/workbench.ts`（shots/sfx 轨，SHOTS 单一事实源）。

## 阶段 6 · 声音设计（定案）

- **BGM**：`g-eazy-nba-type`（Arulo，Mixkit Stock Music Free License，免署名可商用；五首备选中选型依据：86.67BPM 的从容嘻哈律动贴合"学习工具"调性，避开 club house）。librosa 实测 **BPM=86.67、T=0.69231s、残差 ±16ms**；原曲前 12.9s 无鼓点，故音频自 **12.6s 起切**入片（beat 0 ≈ 片内第 10 帧）。
- **卡点**：12 个镜头边界全部微调至拍点网格（偏差 ≤4f；S03→529、S04→716、S05→902、S06→1111、S07→1236、S08→1298、S09→1444、S10→1609、S11→1755、S12→1817，总长 1976f）。大 slam 只留 2–3 处（墨渗落定、时间轴急停、字标落定）。
- **SFX**：Freesound CC0 共 9 枚（whoosh/impact/click/typing/stamp/paper/riser/sparkle/pop），许可与来源记录在 `promo/video/public/audio/sfx/`（audio-manifest.json + FREESOUND-CREDITS.md）。中央钉帧表在 `src/AudioTrack.tsx`（SFX_CUES，绝对帧号由 SHOTS 派生），音量按各素材实测 sample_peak 设定；连发（标注×4、FAB×4）音量递减防机枪感。
- **交付版本**：带 BGM 版 `out/promo.mp4` + 无 BGM 版 `out/promo-nobgm.mp4`（`bgm` inputProp 从同一时间线渲出）。

### 终检修复记录（2026-11-18，独立 subagent 审查后）

1. **Q11 字号**：全部底字幕升级为「主 56px + 辅 32px」双段式（S01–S10、S12；S12 副行 21→32、标语 34→56；S07/S11 字卡副行 24→32）。
2. **S02 切回站点**：俯瞰拉远加宽（s 0.34），光标飞往页 1 右上「站点原页面」按钮点击（涟漪）+ 白闪交棒进 S03（站点播放页），字幕主张获得画面支撑。
3. **A9 音轨偏移实测**：对 nobgm 版逐帧能量包络测量孤立打击型 cue（impact×4、click、sparkle）的峰值帧 − cue 帧 = **0～+1f（n=6），无系统性偏移，无需补偿**；审查报告中的"-8～-15f"为前一音效长尾与测量窗口边缘效应。印章音源（traditional stamp）起振偏晚约 +15f，两处盖章 cue 已前移对齐落章帧（1204→1200、1414→1410）。
4. **S01**：落定帧缓推 1.06→1.03、cy 545，页首 logo 完整；底部字卡副行改为"本地转写 × AI 标注 × 学习统计"，消除与 hero 卡同句重复。
5. **S06**：盖章时新增「收藏 +1」计数胶囊画面化。
