# OJBetter 完整复现、429 分析与近译接入设计

日期：2026-10-21。目标：大众通用翻译，不要求用户提供 API Key 或登录，不引入近译收费服务。

## 结论与证据层次

**真实 Tampermonkey + 原版 OJBetter 的单句、两段免登录翻译均已通过。** 共 3 个真实 DeepL 请求，全部 HTTP 200，返回中文译文并在原版 UI 正确显示。未读取用户浏览器配置、Cookie、Key 或账号令牌。

此前简化 MV3 请求收到的 429 是真实负响应，但不足以证明 OJBetter 路线不可用。本次完整复现纠正了这个测试方法上的缺口。**DeepL 当时究竟因哪个字段或哪项服务端策略返回 429，仍没有足够证据定因**；不能把成功直接解释成“某一个头修好了 429”，也不能把旧结果解释成“IP 被封”。

证据分三层分别验收：

1. 原版 OJBetter 完整链路：真实服务已通过，见 [原版复现证据](../evidence/ojbetter-full-reproduction-2026-10-21.json)。
2. 近译 MV3 等价传输：3/3 真实请求通过，单独验证平台迁移后的请求头与真实译文，不用它替代第 1 层。
3. 近译整页功能：生产代码的隔离测试副本通过真实 UI 验收，2/2 请求成功，重复段落复用，共显示 3 段译文。

## 原版复现环境与保真条件

| 项目 | 实际条件 |
| --- | --- |
| 系统/浏览器 | Windows，Microsoft Edge 155.0.4283.62，headless 隔离 profile |
| 用户脚本管理器 | 官方稳定版 CRX 中的 Tampermonkey **5.4.1**；解压加载，未修改 manifest 或扩展代码 |
| 浏览器开关 | 开发人员模式、允许用户脚本均开启 |
| OJBetter | AtCoder Better 1.25.1，固定 commit `860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46` |
| 原始脚本 SHA-256 | `ac54e910d52ff40df1e9f25173a79cb2046eb4b9a1849bc1dcf5b6e07d79aa26` |
| 安装方式 | 固定 GitHub raw URL，经 Tampermonkey 原生安装确认页面安装 |
| 完整性 | 安装后的源码逐字相同；CDP 读取的实际运行脚本包含完整原文，未经修改 |
| 页面 | [ABC350 A — Past ABCs](https://atcoder.jp/contests/abc350/tasks/abc350_a?lang=en) 的公开英文题面 |
| 配置 | DeepL / free / 简体中文；选段模式；关闭自动翻译、历史恢复和替换原文；原等待间隔 200 ms |
| 触发方式 | 单句点击原迷你翻译按钮；多段勾选两个段落，点击所属分区的“翻译选中” |
| 观测方式 | 页面只读调试断点 + Tampermonkey 后台/离屏 target 的 CDP Network；记录实际线上请求头和响应 |

官方离线包当时是 5.4.1，不能拿商店显示的 5.5.1 当成本机运行版本。[官方离线包说明](https://www.tampermonkey.net/faq.php?locale=en&q=Q406)

### 环境修复与明确限制

- 最初从编辑器粘贴保存时，Tampermonkey 自动去掉 495 个行尾空白字符。没有将它当作“原版完全一致”；改用固定 URL 安装后再次比较，完全一致。
- 原脚本声明的南科大镜像依赖加载失败，出现 `i18next is not defined`，翻译 UI 未初始化。这是启动依赖故障，与 DeepL 429 无关。
- 从 cdnjs 获取同版本的 11 个 JS 和 2 个 CSS，**13 个 SHA-512 均与脚本头声明一致**；由测试环境在原依赖 URL 返回这些原始字节，使真实 Tampermonkey 完成依赖加载。依赖 URL、来源、哈希和实际提供记录已保存到证据中。原脚本代码与翻译请求没有改写。
- 可选 Monaco 代码编辑器的 CDN 仍有 CORS 错误；实际翻译 UI 和链路已运行。这里只证明翻译链路完整通过，不声称 OJBetter 所有功能均在此环境通过。
- DeepL 的响应完全来自真实服务，没有 mock、响应替换、代理轮换或挑战处理。三个请求的 `fromDiskCache`、`fromServiceWorker` 均为 false。
- 第一次断点额外读取 `GM_info` 因调试作用域不可见失败，未取得该次 GM 参数对象；随后恢复执行，线上响应正常。后两次只读取 `requestOptions` 成功，逐字比对与线上请求 body 一致。该观测失败未修改用户脚本，也未因此重发单句。

## 真实测试结果

| 用例 | 入口及内容 | 结果 |
| --- | --- | --- |
| 单句 | “Determine if S is the abbreviation…”；原迷你翻译按钮 | HTTP 200；“确定 S 是否为本次比赛开始前在 AtCoder 上举行并结束的比赛的缩写。”；公式 S 还原 |
| 多段 1 | “You are given a string…” | HTTP 200；中文说明正确对应原段，S、6、ABC 恢复 |
| 多段 2 | “Note that ABC316 is not included.” | HTTP 200；“请注意，ABC316 不包括在内。” |

多段不是一个大字符串请求，也不是绕过 UI 直接调用函数：实际发出两个请求，第二次在第一次响应完成后 **337 ms** 开始，符合原队列完成后等待至少 200 ms 的策略；顺序与页面位置正确。实际调用栈包含：

```text
原版翻译按钮
  → executeTranslation / process（多段）
  → blockProcessing
  → TaskQueue.addTask / processNextTask
  → translateMain（Markdown、公式与代码保护）
  → translate_deepl
  → BaseTranslate
  → OJB_GMRequest
  → 原生 GM_xmlhttpRequest
  → DeepL JSON-RPC
  → 原版译文渲染与占位符恢复
```

请求使用 `source_lang_user_selected: auto`、`target_lang: ZH`、`requestAlternatives: 3`，保留原请求 ID、时间戳与 method 空格规则。实际 wire 中 Origin 为 `https://www.deepl.com`，Referer 为 `https://www.deepl.com/`，没有 Cookie、Authorization，关联 Cookie 数为 0。[原免费函数与时间戳](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/atcoder-better.user.js#L15911)、[原队列](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/atcoder-better.user.js#L7887)

## 429：已查清与未查清的部分

| 判断 | 证据强度 |
| --- | --- |
| 之前确实收到 HTTP 429 / `1042911 Too many requests` | 已证实；保留[旧探测记录](../evidence/deepl-anonymous-probe-2026-10-21.json) |
| 旧测试没有完整复现原版 | 已证实：普通 fetch、简化 ID/时间戳、不同 alternatives/source、标准 JSON 序列化，未复现 GM 请求头行为 |
| 原版必须读取账号 Cookie 才能成功 | 本轮无需此条件：匿名真实请求已成功 |
| 原版目前在本机不能翻译 | 被本轮 3 次真实成功结果否定 |
| 原版请求的哪个字段决定了之前的 429 | 未确定；请求体、传输、时间、文本存在多个差异，未做单变量消融 |
| IP 封禁、频率过高、风控或地区限制中的哪一项 | 未确定；服务未提供具体判定依据 |

工程上的结论是：以已测通的完整协议和传输实现接入，并单独对 429 做停止/冷却处理；不要把 429 全部解释成用户操作太快。一次小样本通过不证明长期免费、全地区可用或可承受大流量。[作者也明确提示免费接口可能限流](https://github.com/beijixiaohu/OJBetter/wiki/%E7%BF%BB%E8%AF%91)。

## 接入设计

### 用户流程

设置 → 翻译方式 → **DeepL 免费翻译（实验性，无需登录或 Key）** → 保存并授予服务权限 → 启用网页翻译 → 点击整页按钮。

原有“大模型 API”作为另一翻译方式，配置保持独立。界面明确说明内容发送到 DeepL，支持普通整页/划词/PDF 选文译文；词典解释与长难句拆解使用大模型。没有 OAuth、Cookie 读取、近译服务器或计费功能。

### 模块和数据流

```mermaid
flowchart LR
  A[整页 / 划词 / PDF] --> B[现有 Port 请求]
  B --> C[后台：校验设置、权限与请求归属]
  C --> D[DeepL provider 唯一实例]
  D --> E[可取消串行队列与冷却]
  E --> F[注入的平台 transport]
  F --> G[限本扩展与固定 endpoint 的 DNR 规则]
  G --> H[匿名 fetch 到 DeepL]
  H --> I[严格 JSON-RPC 结果校验]
  I --> J[现有 segment/result 回填]
```

- **设置所有权：** `platform/settings` 继续管理 schemaVersion 2，兼容增加 `translationEngine`，旧记录默认 model。DeepL 模式保存不改动模型 profile；切换 engine 增加连接修订号，取消旧请求并清理旧页面会话。
- **协议所有权：** `providers/deepl-web` 独立实现观察到的公开协议、结果校验、分段映射和排队；构造注入 transport，不导入浏览器或 UI。第三方脚本仅作为研究样本保留在忽略目录，没有作为生产运行依赖打包。
- **浏览器所有权：** `platform/deepl-web-transport` 处理权限、DNR 规则与 fetch。规则要求自身扩展 initiator、固定 HTTPS endpoint、POST、xmlhttprequest；只设置 Origin/Referer。Host 由浏览器按目标地址生成，不读取/注入 Cookie。DNR 初始化或权限失败时直接报错，不静默退回不等价请求。
- **生命周期：** 后台持有唯一 provider，网页、划词与 PDF 共用队列；设置切换、停止、撤权、Port 断开沿用 AbortController 与请求归属校验。规则在不需要或失去权限时移除。

### 整页调度与异常

- DeepL 每页单 worker、每个 Port 请求一个段落；后台所有来源共享单路队列，前次完成后至少等待 1 秒。避免原大模型的 32 路并发同时访问免费接口，也减少排队占满 90 秒请求窗口。
- 仍使用现有提取、同文去重、动态 DOM、segment 索引、纯文本渲染、恢复原文和手动重试逻辑。模型模式的原批处理参数保持。
- 429 或对应限流业务错误后停止发出队列后续请求，冷却至少 60 秒并尊重 Retry-After；不自动重试，不静默切换到其他文本接收方。`platform/deepl-web-state` 只将截止时间存入可信 `storage.session`，使后台休眠后恢复仍遵守冷却；读取或保存失败时停止发请求。
- 非 JSON、服务错误、空文本、数量或 ID 不匹配不得伪装成功；认证/拒绝错误不引导用户去填无关 API Key。
- 排队取消立即退出，在途 fetch 支持 AbortSignal，迟到响应不回填。成功段落保留，失败段落交给现有手动重试流程。
- DeepL 不支持句法分析；word 输入只返回普通 text 结果，不编造词性和多义项。公式与代码的原文 DOM 保持现有页面提取规则；本次没有把 OJBetter 特定题面预处理器移植进近译。

## 验证记录

| 验证层 | 结果 | 证据 |
| --- | --- | --- |
| 原版 OJBetter 完整链路 | 单句 1 + 两段 2，3/3 HTTP 200；还原公式与代码 | [原版证据](../evidence/ojbetter-full-reproduction-2026-10-21.json) |
| 原生 MV3 完整协议与 DNR | 单句 1 + 顺序短句 2，3/3 HTTP 200；实际 wire 头、顺序、无凭证均校验 | [MV3 证据](../evidence/deepl-mv3-equivalence-2026-10-21.json)、[可运行脚本](../../scripts/diagnostics/probe-deepl-mv3-equivalence.mjs) |
| 近译实际整页 UI | 2/2 HTTP 200，显示 3 段译文，重复仅请求一次；完成后间隔 1,004 ms；恢复原文不新增请求 | [整页真实证据](../evidence/near-deepl-page-live-2026-10-21.json) |
| 单元测试 | 437 项通过，含原功能回归、持久冷却、取消、畸形响应、权限与配置隔离 | `npm test` |
| 浏览器回归 | 首轮 52/54 通过，两个旧模型权限文案断言失败；恢复原文案并重建后，两项定向复测 2/2 通过。四个 DeepL 新用例全部通过 | `tests/e2e/deepl-translation.spec.ts` 及既有回归 |
| 静态与构建 | 类型检查、模块边界通过；Chrome / Edge 均已构建 | `npm run typecheck`、`npm run check:boundaries`、`build` / `build:edge` |

整页公开样例的真实译文为：“博物馆上午十点开放。”和“请妥善保管您的门票，直至参观结束。”测试还核验代码块、未提交输入框未变化。

产品测试副本预授予了可选的网页/DeepL/DNR 权限，以自动运行隔离浏览器；生产 manifest 仍由用户保存选择时申请权限。测试副本与生产构建的后台 JavaScript SHA-256 均为 `8e918ebab8703411e5e9bc218d69599db423dbdfd485fb02ef4ef03e18ac4f39`。没有将权限提示的人工确认过程声称为真实自动验收，也没有测试所有网站、长文章吞吐或长期服务稳定性。

本轮完成 Chrome 和 Edge 构建，目录分别为 `.output/chrome-mv3` 与 `.output/edge-mv3`。重新加载对应扩展，进入设置选择 DeepL 免费翻译即可使用；本次未发布版本或修改用户日常浏览器的已安装配置。

准备脚本：[prepare-ojbetter-reproduction.mjs](../../scripts/experiments/prepare-ojbetter-reproduction.mjs)。证据校验脚本：[summarize-ojbetter-reproduction.mjs](../../scripts/experiments/summarize-ojbetter-reproduction.mjs)。后者只读取归档并断言，不发网络请求。

最终 [集成验证统计与构建哈希](../evidence/deepl-integration-validation-2026-10-21.json) 已归档。

## 架构影响

风险等级 R2：增加翻译方式、平台传输与队列生命周期。依赖方向保持 UI/页面 → Port → 后台组合入口 → provider；浏览器功能通过 transport 注入。原模型 API profile、默认行为与消息契约兼容；无新增生产依赖。最终门禁及未验证范围以上述验收结果为准。
