# 学习 AtCoder Better / Codeforces Better 的免登录 DeepL 实现

> 后续更新：本文件第 4 节记录的是早先的简化 MV3 失败探测，不能作为当前方案不可用的结论。随后使用真实 Tampermonkey 和原版 OJBetter 完整运行，单句及两段均返回真实译文。最新证据、429 分析和集成设计见 [完整复现与设计](OJBETTER_FULL_REPRODUCTION_AND_DESIGN_2026-10-21.md)。

核验日期：2026-10-21。目标仍是近译免费、用户尽量无需 API Key。根据用户补充，本轮先核对这两个插件的实际实现，暂不继续账号授权流程。

**结论：用户观察正确。两者默认采用 DeepL 免费模式，匿名请求 DeepL 的网页 JSON-RPC 接口，不需要登录，也不是读取浏览器 Cookie。它与官方 REST API、DeepLX、OAuth MCP 是不同的接入路线。**

前一份分析对官方 API 和 OAuth 的区分成立，但对“免登录的非官方网页接口实现”覆盖不足；不能把“REST 必须有 Key”扩展成“任何 DeepL 翻译都必须登录或有 Key”。本报告补齐这条路线，并明确源码证据与实测结果的边界。

**1. 找到的是哪个项目**

两个脚本同属作者“北极小狐”的 [beijixiaohu/OJBetter](https://github.com/beijixiaohu/OJBetter)。README 的安装表分别链接 Codeforces Better 与 AtCoder Better 的 Greasy Fork 页面。

本次固定检查 commit `860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46`（2026-09-24）；其中 release 目录脚本版本为 Codeforces Better 1.87.1、AtCoder Better 1.25.1。以下代码链接固定到该提交，避免 main 后续变化导致行号失效。[提交记录](https://github.com/beijixiaohu/OJBetter/commit/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46)

**2. 为什么它们不要求登录**

| 事实 | 源码依据 |
| --- | --- |
| Codeforces 默认引擎是 DeepL、默认类型是 free | [引擎默认值](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/codeforces-better.user.js#L1043)、[模式默认值](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/codeforces-better.user.js#L1100) |
| AtCoder 采用同样默认设置 | [默认配置](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/atcoder-better.user.js#L921) |
| 免费路径直接 POST 到 `https://www2.deepl.com/jsonrpc` | [CF 请求函数](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/codeforces-better.user.js#L19937) |
| 使用 JSON-RPC 方法 `LMT_handle_texts`，带源/目标语言与文本 | [请求构造](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/codeforces-better.user.js#L19941) |
| 请求明确设置 `anonymous: true` | [CF 匿名请求](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/codeforces-better.user.js#L19974)、[AtCoder 对应实现](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/atcoder-better.user.js#L15946) |
| 请求通过 Tampermonkey 的 `GM_xmlhttpRequest` 发出 | [请求封装](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/codeforces-better.user.js#L5058) |

因此，默认免费分支没有 API Key、OAuth Token 或用户 Cookie 获取步骤，也没有先发送到作者的翻译服务器。它利用的是无需用户登录的网页客户端接口。

这个请求还包含特定的请求 ID、时间戳处理、序列化格式以及站点相关请求头。它不是一个已经公开承诺长期稳定的官方开发者协议；也不能把 Tampermonkey 的特权请求能力与原生 MV3 `fetch` 当作完全相同。迁移到近译需要实际验证请求限制与浏览器行为，不能只复制 URL。

**3. 四条 DeepL 路线应分别表示**

| 路线 | 登录 / Key | 请求目的地 | 当前判断 |
| --- | --- | --- | --- |
| OJBetter 默认免费模式 | 不需登录或 Key；匿名 | DeepL 网页 JSON-RPC | 源码确认存在；本轮普通 MV3 基础探测未得到译文 |
| 官方 REST API | 用户 Key | DeepL REST 服务 | 正式开发者协议；不等于普通网页免费权益 |
| DeepLX | 取决于所选部署；可能要代理自己的 Key | 用户选择的 DeepLX 服务 | 独立可选路线；公共代理不能假定永久免费或可用 |
| 官方 OAuth MCP | 用户登录并授权；不手填 Key | DeepL 官方 MCP | 官方免 Key 候选；本轮已完成测试客户端注册，真实授权/翻译未完成 |

OJBetter 的 REST 分支才读取用户配置的 Key 并设置 `DeepL-Auth-Key`；DeepLX 使用用户代理地址或其默认地址。两者都不是默认 free 分支的隐藏实现。[官方 API 分支](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/codeforces-better.user.js#L20001)、[DeepLX 分支](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/codeforces-better.user.js#L20074)

作者 Wiki 本身将免费 DeepL 标为模拟接口，并说明可能出现 Too many requests；其中旧 API 套餐和代理额度信息不能直接当成 2026 年当前承诺。[作者翻译说明](https://github.com/beijixiaohu/OJBetter/wiki/%E7%BF%BB%E8%AF%91)

**4. 本轮补做的单次匿名探测**

为确认近译的原生 MV3 请求基础是否可用，创建了新的隔离 Edge 测试 profile 和只有目标 host 权限的测试扩展。发送一次公开短句：

> The library is open from nine to five.

请求不带 Cookie、Key 或 OAuth Token，没有设置伪装站点身份的请求头，不重试、不轮换代理、不处理挑战。使用标准 JSON 序列化和普通请求 ID/时间戳，**没有原样复现 OJBetter 的全部请求构造细节**。

| 项目 | 结果 |
| --- | --- |
| 浏览器 | Edge 155.0.4283.62 |
| 请求次数 | 1 |
| HTTP 状态 | **429** |
| 服务响应 | `Too many requests`，错误码 `1042911` |
| 网络调用耗时 | 7,608 ms |
| 是否得到译文 | **否** |
| 是否使用用户凭证 | 否 |
| 是否证明 OJBetter 当前必然失效 | **否**：这不是原脚本完整运行测试 |

准确结论是：**源码证明免登录方案存在；本机这次普通 MV3 请求收到限流响应，未达到“真实翻译测试通过”的接入条件。** 429 的具体触发原因未被验证，不能仅凭一次响应判断是本次请求过多、网络出口限制还是请求特征判定，也不能推广为所有用户都会失败。

可复现脚本：[probe-deepl-anonymous.mjs](../../scripts/diagnostics/probe-deepl-anonymous.mjs)。原始结果：[匿名请求证据](../evidence/deepl-anonymous-probe-2026-10-21.json)。本轮没有执行下载的 OJBetter 脚本，没有重试被限制的请求。

**5. 近译应当具体学习什么**

| OJBetter 做法 | 对近译的适用改进 |
| --- | --- |
| 普通翻译器独立构造请求与解析纯文本 | 新增传统翻译 provider 时不强迫它返回词典/句法 JSON；能力不足时显示普通译文 |
| 同服务任务顺序执行，完成后有可配置间隔 | 低配额服务使用全扩展共享串行或低并发队列；不能直接沿用每页 32 并发 |
| 翻译前保护公式和代码、之后恢复 | 为通用翻译器设计可校验的占位符，必须检测缺失/重复/错位，失败时保留原文 |
| 题目翻译缓存与历史恢复 | 首先让同页原文/双语切换复用结果；持久化缓存作为用户可选项，保留清除入口 |
| 选段/分段/区域模式 | 增加正文范围和按需翻译，减少未阅读内容的请求量 |
| 针对 Too many requests 的明确提示 | 限流后暂停并保留成功段落，不循环立即重试；让用户知道当前服务不可用 |

依据：[统一翻译适配](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/codeforces-better.user.js#L21247)、[队列](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/codeforces-better.user.js#L9236)、[内容保护](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/codeforces-better.user.js#L13531)、[缓存](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/codeforces-better.user.js#L13988)

另一个需要区分的体验：脚本有混合服务选项，某些自动评论翻译可以随机选用不同引擎。因此“页面自动出现译文”不一定每次都是 DeepL 成功。[AtCoder 混合服务默认项](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/atcoder-better.user.js#L924)

近译应显示实际使用的服务，切换到另一文本接收方应有明确选择，不照搬静默随机路由。仓库是 GPL-3.0，本轮学习其结构与公开协议，不把成段源码复制进当前 MIT 生产代码；如果将来复用源码，需要单独处理许可要求。[项目许可](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/LICENSE)

**6. 当前任务状态与下一道门槛**

- OAuth 隔离验证扩展已经编写，官方元数据读取和公开客户端注册成功，并进入过官方授权窗口。
- 本轮尚未获得 OAuth 访问令牌、完成工具发现或真实翻译；用户要求先学习免登录插件后，已停止该测试进程，不把未完成的授权当成成功。
- OJBetter 免登录路径已确认；普通 MV3 单次匿名探测未通过翻译验收。
- 生产整页翻译代码、权限与用户设置没有修改，保留“真实测试通过后再接入”的门槛。

接入前仍需验证：真实单段与多段结果、原生扩展请求方式、频率/额度边界、取消与迟到结果、失败恢复。若考虑网页内部接口作为长期产品能力，还需处理其非官方契约和服务使用条件；DeepL 免费服务条款对内部 API 使用有明确限制，开源脚本存在不能替代上游支持。[DeepL 条款](https://www.deepl.com/en/terms-of-use)

本轮修正的是技术判断：**免登录 DeepL 不是不存在，它在 OJBetter 中确实有独立实现；当前还没有足够的真实测试证据把该实现直接作为近译的默认整页翻译服务。**
