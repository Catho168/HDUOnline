# WASM 体积治理评估（第 46 轮产出，供发布裁决）

> 背景：CHANGELOG「未发布 · 1.1.0」标注安装包约 88MB，以本地转写 wasm 运行时资源为主。
> 本文档量化构成、解释为何如此大、给出三条治理路线与推荐，**不改动任何默认行为**；是否实施需用户裁决。
>
> **实施进展（第 47 轮）**：路线 A 已落地——`scripts/copy-wasm.mjs` 改为仅复制 JSEP 变体。实测依据：本包运行时的两条 ORT 引用（主入口 `ort.mjs` 与 transformers.js v3 的 `ort.bundle.min.mjs`）在构建期均已常量折叠为仅引用 `ort-wasm-simd-threaded.jsep.*`，jspi/asyncify/simd-threaded 三个变体在当前依赖图**零引用**。因此裁剪比本文初稿的「先裁 jspi」更彻底：一次裁掉三个变体。**安装包 88.65MB → 30.74MB（−65%）**；`copy-wasm.mjs` 同时改为先清空 `public/wasm/` 再复制（幂等清理历史变体）。回归：tsc 0 错误、单测全量通过、e2e 70/70。风险边界：ORT/transformers 升级若改变变体引用，ASR 初始化会显性报错（易发现），届时同步 `copy-wasm.mjs` 的 `keepVariant` 即可。

## 一、现状量化（npm run build，2026-11-18）

| 产物 | 体积 | 说明 |
|---|---|---|
| `wasm/ort-wasm-simd-threaded.jsep.wasm` | 28.31 MB | JSEP 变体（WebGPU/WebNN 执行路径） |
| `wasm/ort-wasm-simd-threaded.asyncify.wasm` | 26.78 MB | Asyncify 变体（挂起/恢复控制流） |
| `wasm/ort-wasm-simd-threaded.jspi.wasm` | 16.76 MB | JSPI 变体（实验性 Promise Integration） |
| `wasm/ort-wasm-simd-threaded.wasm` | 14.24 MB | 基础 SIMD+多线程变体（WASM EP 兜底） |
| **wasm 小计** | **86.09 MB** | 占总包 **97.2%** |
| 全部 JS/图标/清单等其余产物 | ≈2.56 MB | 含 content/background/offscreen 等 chunk 与 204KB 样式 |
| **总计** | **88.65 MB** | |

模型文件（whisper base/small/large-v3-turbo 的 onnx 权重）**不在包内**——按 ASR 模型档位从 hf-mirror 按需下载。即 88MB 全部是 onnxruntime-web 1.30.0 的 4 个 wasm 运行时变体。

## 二、为什么有四个变体

onnxruntime-web 按浏览器能力在运行时**动态选择其一**加载：

- 支持 WebGPU/WebNN → `jsep`（我们的 WebGPU 推荐路径，见技术文档 §5.4 与记忆条目「ASR WebGPU 必须用 q4」）；
- 支持 JSPI（实验性）→ `jspi`；
- 需要 asyncify 控制流的场景 → `asyncify`；
- 其余 → 基础 `simd-threaded`（WASM EP，弱机器兜底，配合 q8 档）。

四者全打包是为了「任何浏览器能力组合下 ASR 都能跑」，属保守全量分发。运行时实际只用其中一个。

## 三、治理路线对比

| 路线 | 做法 | 体积收益 | 主要风险 / 代价 | 工作量 |
|---|---|---|---|---|
| **A. 变体裁剪（推荐先试）** | 改 `scripts/copy-wasm.mjs`，仅复制实际会用到的变体（至少 `simd-threaded` + `jsep`；能否去掉 `asyncify`/`jspi` 需真机验证 ORT 的选择逻辑） | −43.5MB（去 jspi+asyncify）→ **~45MB**；若只留 jsep+simd 同上；激进只留一档可再降 | ORT 内部按 capability 选变体，裁掉被选中的变体会直接导致 ASR 不可用；必须覆盖「WebGPU 可用 / 仅 WASM」两类真机 + e2e 的 ASR 链路验证 | 小（脚本 + 验证） |
| **B. 按需下载 + 本地缓存** | 包内不含 wasm；首次进入转写时从自托管/镜像下载对应变体，存 OPFS/IndexedDB，`wasmPaths` 指向本地blob/挂载路径 | 包体 → **~2.6MB**（−97%） | 首次使用必须联网（课堂场景可能不可接受）；需处理下载完整性（校验和）、版本升级、CSP/`wasm-unsafe-eval` 与本地缓存失效；实现面涉及 asr-worker 初始化链路 | 中—大 |
| **C. 维持现状** | 不治理，发布说明标注体积现状 | 0 | 无风险；88MB 对企业内网/本地安装可接受，但对商店分发与弱网更新不友好 | 0 |

补充说明：

- 路线 A 与 B 可叠加（先 A 后 B）。
- 路线 A 的验证口径：`npm run build` 后，分别在「WebGPU 可用」与「仅 WASM」环境跑 `tests/.local/webgpu-check.mjs` / `probe-asr*.mjs` 探针 + 70 项 e2e 的 ASR 相关子集；任一变体被裁后 ORT 选中缺失变体会直接抛加载错误，属显性失败、易发现。
- 路线 B 需要自托管下载源（内网可达），并同步更新 `wasmPaths` 的装配方式（当前是构建期复制到 `public/wasm/` 的静态路径）。

## 四、建议

1. **短期（下一功能轮可做）**：实施路线 A 的第一步——仅裁 `jspi`（JSPI 目前仍属实验特性，Chromium 默认未全量开放），收益 −16.76MB → ~72MB，风险最低；`asyncify` 是否可裁需真机双环境验证后再定。
2. **中期（需裁决）**：路线 B 按需下载。适合商店分发场景；若用户主要内网安装，收益有限。
3. 无论哪条路线，均在 CHANGELOG「现状说明」同步更新体积数字与取舍。
