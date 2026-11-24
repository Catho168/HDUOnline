# content/index.tsx 拆分方案（第 41 轮评估产出，供后续轮次实施）

> 评估对象：`src/entrypoints/content/index.tsx`（1732 行，HDU 侧内容脚本主控制器）。
> 口径：与第 40 轮 `ui/learning/`、第 41 轮 `ui/bili/` 相同的**纯搬移**纪律——逐行 diff 零差异（仅 import/导出/`this.`→`ctx.` 机械替换），任何行为修正另开一轮。

## 一、内聚块清单

| # | 块 | 行号 | 行数 | 职责 |
|---|----|------|------|------|
| A | 文件头注释 + import | 1–66 | 66 | 模块说明与全部导入 |
| B1 | `log` / `LIST_ROUTES` | 68, 70 | 3 | 日志器；列表页路由集合 |
| B2 | `CourseSyncResult` / `ScheduleSyncResult` 接口 | 72–85 | 14 | 站点同步结果类型 |
| B3 | `readSessionNumber` | 87–94 | 8 | sessionStorage 节流时间戳读取（纯函数） |
| B4 | `readPlayHeaderTextForObservation` | 96–103 | 8 | 读播放页顶栏文本（剔除注入 chip） |
| B5 | `parseTeacherNamesFromDom`（导出，被单测引用） | 105–116 | 12 | 顶栏教师名兜底解析 |
| C | `defineContentScript` 入口 | 118–146 | 29 | matches/runAt、main 装配 |
| D1 | 类字段 + 构造器 | 148–185 | 38 | 17 个可变状态字段 |
| D2 | `start` / `dispose` / `applySettings` | 187–234 | 48 | 生命周期与设置热更新 |
| D3 | `installGlobalListeners` + `listenPageMessages` | 236–342 | 107 | 全局监听接线 |
| D4 | `applyRoute` + `teardownPage` | 344–423 | 80 | 路由生命周期编排 |
| D5 | `syncSiteCache` / `fetchAllCourseWall` / `syncSchedule` | 425–675 | 251 | 站点只读同步（节流状态自包含） |
| D6 | `ensure/destroyPlayHeaderAnchor` + `ensure/destroyAnchorProbe` | 677–720 | 44 | 注入式 UI 锚点管理 |
| D7 | `initPlayPage` / `loadCandidates` / `resolveAndLoad` | 722–890 | 169 | 播放页初始化与会话识别编排（重入守卫） |
| D8 | `loadSession` / `fallbackMeta` / `loadRelated` | 892–981 | 90 | 会话数据装载（loadToken 竞态守卫） |
| D9 | `syncFromPlayer` / `stepOutline` / `updateRects` | 983–1072 | 90 | 播放器状态同步 + stats.tick |
| D10 | `freshAudio` / `followTick` / `flushStats` | 1074–1140 | 67 | 新鲜直链；ASR 窗口跟进；统计结算 |
| D11 | `currentCourId` / `handleEvent` | 1142–1277 | 136 | 后台事件分发（mediaKey 归属校验） |
| D12 | `sendPageContext` / `sendSessionMeta` / `buildOverview` | 1279–1320 | 42 | 页面→后台消息 |
| D13 | `readonly actions: UiActions` | 1322–1714 | 393 | uiStore 动作实现（耦合汇总点） |
| D14 | `sendPanelState` / `persistPanelPreference` | 1716–1731 | 16 | 面板状态上报与偏好落盘 |

## 二、目标结构（新增 `controller/` 目录）

```
src/entrypoints/content/
  index.tsx                  ← 入口 + ContentController 核心（≈370 行）
  controller/
    context.ts               ← ControllerContext 注入接口（仅类型，零运行时依赖，防循环 import）
    dom.ts                   ← B1/B2/B4/B5 纯 helper
    messaging.ts             ← D12 + D14
    siteSync.ts              ← D5（含 readSessionNumber、B2 接口）
    anchors.ts               ← D6
    playerSync.ts            ← D9 + flushStats
    asrFollow.ts             ← D10 的 freshAudio/followTick
    backgroundEvents.ts      ← D11
    playPage.ts              ← D7
    sessionData.ts           ← D8
    actions/
      index.ts               ← createActions(ctx) 组装
      panel.ts / session.ts / av.ts / notes.ts
```

依赖方向铁律：controller 子模块之间**只允许 import context.ts 的类型**与叶子模块（dom/shared/site/ui）；互调一律走 ctx 方法，防循环 import。

## 三、关键边界处理

- **this 语义不变**：搬出函数一律 `export function xxx(ctx: ControllerContext, ...)`，类内保留同签名一行转发桥接；内部互调点不变。
- **settings 活引用**：`this.settings` 有三处重赋值，ctx 必须暴露 `get settings()` 活读取，严禁搬出模块缓存快照。
- **lastInteractionAt**：5 处写入收口为 `ctx.markInteraction()`；`lastTickAt/lastSummaryAt` 仅 playerSync 用，随块同迁。
- **cleanup 归属**：anchors/observations 清理进 pageCleanups（随路由销毁）；chrome 监听注销进 globalCleanups。ctx 暴露 `registerPageCleanup/registerGlobalCleanup`，不交出裸数组。
- **识别竞态守卫**（R1）：`resolving/pendingResolve/loadToken` 留在 ctx 同一实现内，playPage/sessionData 只经 ctx 调用，禁止自行 `++loadToken`。

## 四、分批实施与回归口径

| 批次 | 内容 | 主文件行数 | 回归验证 |
|------|------|-----------|----------|
| 第 1 批（零风险） | context.ts + dom.ts + messaging.ts；测试导入改移 | → ~1620 | typecheck + 单测全绿；diff 逐字节审查 |
| 第 2 批（自包含状态） | siteSync.ts + anchors.ts | → ~1250 | 单测全绿 + e2e（列表页同步/课表页/播放页注入与 nativeAnchor 开关） |
| 第 3 批（事件与播放器） | playerSync.ts + asrFollow.ts + backgroundEvents.ts | → ~900 | 单测全绿 + e2e HDU 子集（字幕进度/问答流式/收藏此时刻/统计） |
| 第 4 批（深耦合核心） | playPage.ts + sessionData.ts + actions/ 四文件 | → ~370 | verify + 全量 70 项 e2e；手动矩阵（路由切换/媒体切换重识别/手动选课/转写/快捷键/面板偏好） |

通用门槛：typecheck 零错误；单测全量通过；搬移 diff 仅含 import/导出/`this.`→`ctx.` 机械替换。**不建议一批做完**——D7/D13 的重入守卫与 settings 活引用是最易错点，放最后批。

## 五、遗留注意

- `tests/unit/play-header-anchor.test.ts:22` 从 `@/entrypoints/content/index` 导入 `parseTeacherNamesFromDom`——按第 40 轮先例改测试导入到 `controller/dom`。
- 其他文件散文注释中以 "bilibili.content.tsx" 指称符号出处的（VideoFavCard BV 口径注、assistant.ts 历史记），属历史描述未触碰，后续顺手校正。
