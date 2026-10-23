# DeepL V4 可选网络准备：资格证据与设计边界

记录日期：2026-10-22。本文记录单次公开短段资格与当前源码设计，不宣称已完成本轮整页性能验收，也不把一次连接复用视为长期速度或服务支持承诺。本次整理只读取已有本地证据和源码，没有重新下载第三方产物、读取账号凭证或发送翻译请求。

## 结论及权限边界

在近译自身扩展 service worker（下文称 SW）、已获目标 host 权限的条件下，向固定 OneShot 地址发送一次不含正文的 OPTIONS，随后发送一次匿名公开短段 POST，实测可以复用同一条 HTTP/2 连接。这里的准备是**额外的真实 HTTP 请求**，不是纯本地提示、浏览器自动预检或免费的零网络预热。

[Chrome 官方跨源请求文档](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)区分了网页／content script 与拥有 host 权限的扩展 SW／扩展页面：后者可以执行相应跨源请求。因此，本实验 OPTIONS 的 204 响应没有 CORS 允许头，不构成该 SW 的 HTTP 拒绝或 Chrome host 权限拒绝。这个结论只适用于获授权的扩展上下文，不能外推到任意网页脚本。

[Fetch 标准的 CORS 预检流程](https://fetch.spec.whatwg.org/#cors-preflight-fetch)规定了普通网页跨源请求的预检和响应共享检查。本实验没有收到 `Access-Control-Allow-Origin`、`Access-Control-Allow-Methods`、`Access-Control-Allow-Headers`，因此**不能据此声称普通网页获得了跨源授权**。手动发送含 `Access-Control-Request-*` 字段的 OPTIONS，也不等于浏览器管理的 CORS preflight；本文不声称它填充了浏览器预检缓存。

上述两份规范解释浏览器权限与协议边界，不证明 DeepL 对第三方连接准备提供公开 SLA、稳定限额或长期兼容承诺。

## 已保存的真实资格

两次实验均使用同一自建匿名隔离 profile、同一诊断扩展路径与 ID `cpdfhfjfdjfibaogohckaljcbmoikdpc`。启动时重载自身诊断扩展并核验新 worker generation；只允许精确公开 Go 文章上下文。浏览器提供自身原生 `Origin` 和其他身份字段，没有修改 Origin、User-Agent、响应头或复制官方扩展身份。请求使用 `credentials: 'omit'`、`referrerPolicy: 'no-referrer'`、`cache: 'no-store'`，不读取 Cookie、Key 或账号 token。

| 项目 | 先前严格 CORS gate | 修正为 own-worker HTTP gate |
| --- | --- | --- |
| 原始记录 | proper-preflight JSON（本机历史文件 `.output/deepl-speed-v2/sw-proper-preflight-qualification-1792631278223-c9ba15af7643.json`，未随仓库归档） | own-worker JSON（本机历史文件 `.output/deepl-speed-v2/sw-own-worker-http-prepare-qualification-1792631502677-5581b364c2c4.json`，未随仓库归档） |
| 实际请求数 | 1 OPTIONS、0 POST | 1 OPTIONS、1 POST，无其他目标请求 |
| OPTIONS | HTTP 204，约 1.649 秒 | HTTP 204，约 2.606 秒 |
| 响应 CORS 允许字段 | 未观察到 | 未观察到，仅作诊断记录 |
| gate 结果 | 自设严格 CORS 检查未通过，主动 0 POST | HTTP 2xx 且 wire 验证自身 Origin 和两个 ACR 字段后才允许一次 POST |
| POST | 未发送 | 公开原文 429 个 UTF-16 单元；HTTP 200，响应内容／映射资格通过，约 1.996 秒 |
| 连接 | OPTIONS 为 h2、connection 155 | OPTIONS 与 POST 均为 h2、connection **132**；POST `connectionReused: true` |
| TLS | OPTIONS 约 0.942 秒 | OPTIONS 约 1.904 秒；POST 无新增 connect／TLS 阶段 |
| 准备消息到译文结果 | 无译文请求 | **4.635 秒**，包含准备等待 |
| 导航到译文结果 | 无译文请求 | **6.709 秒**，包含页面导航及准备，不只计算 POST |
| 清理 | 规则移除验证通过、原文件逐字节恢复 | 规则移除验证通过、原文件逐字节恢复 |

第一份记录的 `STRICT_PREFLIGHT_QUALIFICATION_FAILED` 是当时实验的保守 gate 失败，不能改写为服务 HTTP 拒绝。第二次只修正该 gate 的适用范围，保留第一份证据；没有篡改响应或绕过账号认证。

第二次 `navigationToPrepareMessageMs` 为 2073.5 ms，`navigationToDclMs` 为 4295.8 ms，准备完成后约 19.7 ms 才请求 POST；没有人工附加等待。它证明这一次连接确实复用，不能单独证明用户等待缩短多少：DNS／TLS 恢复、上游负载和缓存未受控，DevTools 挂接也可能影响 SW 生命周期。资格脚本只做一次 POST，不验证整页吞吐、并发上限或限流阈值。

诊断规则 ID 为 `120025`；下述生产规则 ID 为 `74002`，两者不是同一安装环境。诊断结束已关闭该浏览器会话并恢复 manifest／worker；原本不存在的临时 content 文件被移除。生产没有保留诊断监听器或新增 `webRequest` 权限。

## 当前实现的职责与数据所有权

| 层／源码 | 所有权与约束 |
| --- | --- |
| [`network-prepare.content.ts`](../../src/entrypoints/network-prepare.content.ts) | `document_start` 顶层可见 HTTP(S) 文档只发送准备消息与随机 request ID，不收集正文、选区或页面 URL 到消息载荷；PDF 不触发。`pagehide`／脚本失效发取消。 |
| [`web-access.ts`](../../src/platform/web-access.ts) | 仅在功能开启、DeepL 模式、网页及服务 host 权限和可选 DNR 权限均已存在时，动态注册准备脚本；条件失效时撤销注册。普通划词／整页 UI 的注册不依赖准备成功。 |
| [`background.ts`](../../src/entrypoints/background.ts) | 组合根只创建一个 DeepL provider 与 transport。以浏览器提供的 sender ID、顶层 frame、active tab、tab ID／document ID／request ID 确认准备所有者；再次检查设置及权限，不接受页面提供的任意目标 URL 或正文。切换服务、停用或权限撤销时取消准备。 |
| [`deepl-web-state.ts`](../../src/platform/deepl-web-state.ts) | `storage.session` 的可信扩展上下文保存全扩展共享的准备调度尝试时间戳；不保存正文或凭证。 |
| [`deepl-web.ts`](../../src/providers/deepl-web.ts) | provider 注入 `prepareTransport`／`reservePreparation`，不 import 浏览器平台。准备与翻译共用同一服务调度器、并发槽、启动窗口和冷却状态；只有一个尚未清理完的准备 owner。 |
| [`request-scheduler.ts`](../../src/providers/request-scheduler.ts) | 持有实际网络执行槽和队列生命周期。取消可以立即结束调用方等待，但必须等底层 transport 和响应清理真正结束才释放槽。 |
| [`deepl-web-transport.ts`](../../src/platform/deepl-web-transport.ts) | 平台负责固定地址、原生 fetch、host／DNR 权限、规则 generation 与独立数值指标。provider 不负责浏览器 header 操作。 |
| [`options/main.tsx`](../../src/entrypoints/options/main.tsx)／[`settings.ts`](../../src/platform/settings.ts) | 选项页显示并切换可选权限；保存／公开能力投影不改变模型 API profile、Key 或原有偏好。 |

准备不是单独建立的一条无预算旁路。`reservePreparation()` 在进入共享队列前写入 `deepl-web:prepare-at:v1`，使浏览器会话内各标签**至少间隔 30 秒才允许一次准备调度尝试**，不是每个标签每 30 秒一次，也不是承诺每次均会发出请求。排队取消、请求失败不会退还该次尝试；SW 休眠后时间戳仍在。非法存储或时钟状态使准备关闭，不强行发送。

准备调用从开始便有 **5 秒 deadline**，覆盖状态预留／排队等待。到期会 abort，并结束可选准备的对外等待；若 fetch 或响应取消尚未 settle，准备 owner 和共享网络槽仍然保留，不通过提前释放槽制造额外并发。准备 HTTP 429 使用与翻译相同的持久冷却、清退等待项和取消 peer 机制，不自动重试；其他准备失败不替代用户翻译，也不要求普通翻译等待该 Promise 成功。

## 可选规则与正常 POST 的隔离

`DeepLWebNetwork.prepare(signal): Promise<Response>` 只使用已同步就绪的规则。`synchronize(enabled)` 仅在启用 DeepL、拥有固定服务 host 权限且**已经拥有** `declarativeNetRequestWithHostAccess` 时安装 session rule `74002`；它不弹出权限申请。

生产 rule 的完整影响范围是：

- URL：大小写敏感、首尾锚定的精确 `https://oneshot-free.www.deepl.com/v1/translate`，不匹配其他路径、查询串或站点。
- initiator：`browser.runtime.id`，只限本扩展。
- 方法／类型：`options` ＋ `xmlhttprequest`。
- 唯一改动：设置请求字段 `Access-Control-Request-Method: POST` 与 `Access-Control-Request-Headers: authorization,content-type`。

不修改 Origin、Referer、User-Agent、Cookie、Authorization 或任何响应字段。旧 rule `74001` 仍只做尽力清理，不参与新协议。启用状态、host／DNR 权限、generation 的同步结果会缓存，普通 POST 不会每次重装规则。停用或撤权会使 prepare 立即失去资格并尝试清除规则；安装失败只关闭可选准备，不回退到无规则的准备请求，也不妨碍普通 POST。

每次 `prepare()` 都再次检查 abort、host 权限、可选权限、generation 及已同步规则；任何不满足均为**零准备网络**。实际 OPTIONS 使用原生 fetch：无 body、无 Authorization、无 Content-Type、`credentials: 'omit'`、`referrerPolicy: 'no-referrer'`、`redirect: 'error'`、`cache: 'no-store'`。两个 ACR 字段由上述精确规则设置。

**普通翻译 POST 无需 DNR 权限。** 它仍向固定端点发送 `{text: string[], target_lang: 'zh-Hans'}`，`Authorization: None` 只是匿名哨兵，不是 Key；正文只有在用户请求翻译时发送。此功能不新增依赖、不新增 required permission，不读取或使用模型服务的 Key。

## 用户选择与隐私披露

当前设计以可选 DNR 权限本身作为 opt-in 状态，没有另一个隐式启用标志。新用户可以在选项页点击“启用连接加速（可选）”授予权限，也可关闭并撤销该权限；不授予仍可正常翻译。**历史版本已拥有同一 legacy DNR grant 的用户会显示为已启用**，不是一次新的权限弹窗。选项页明确披露这点，并允许关闭。

启用并满足其他条件后，新打开的前台网页在尚未点击翻译时，**可能已向 DeepL 发送一次准备元数据请求**。请求不包含正文、选区、网页地址、Cookie、登录凭证或模型 Key；但它是对外网络访问，服务端仍可观察网络 IP、时间和浏览器原生扩展身份等常规连接元数据。内容脚本／后台会在本地使用 sender 文档信息判断所有权，这不等于把 URL 发给服务。30 秒是本客户端的调度策略，不是公开服务端限额，也不是隐私上的零联系承诺。

## 指标口径与后续验收

准备单独记录 `preparationCount`、`activePreparations`、最多 64 条 `preparations`。每条仅包含 sequence、起止时间、HTTP status 或固定 `ABORTED`／`NETWORK` 错误枚举，以及可选可信 ResourceTiming 数字。它们不混入翻译的 `requestCount`、POST `statusCounts`、原文字符数或 texts 数。

OPTIONS 与 POST 使用相同 URL，ResourceTiming 本身没有方法字段。匹配窗口重叠或资源条目不唯一时省略该次 timing，避免把准备的 TLS 阶段归给 POST，或将 POST 误报为无握手；不创建额外 observer／网络请求来补数字。transport 指标的 endedAt 表示 fetch 返回响应头或抛错，实际响应消费与槽释放仍由 provider／scheduler 负责，不能据此独立声称完整请求已经清理。

整页验收需要同时报告导航、准备开始／完成、翻译点击、首个合格可见正文、完整初始 viewport、全部源段完成，以及 OPTIONS 和 POST 的独立数量／状态。准备等待必须计入相应总耗时；正文未请求前的元数据访问也必须披露。本文不填入主线程尚未完成的整页速度结论，不用本次 POST 的 1.996 秒替代用户从导航或点击到结果的时间。

## SOURCE：已保存证据与源码快照

以下 SHA-256 来自本轮读取时已有文件；不重新下载。源码在并行开发中可能后续变化，哈希用于标识本文核对的快照，不表示最终构建版本。

| 本地 SOURCE | SHA-256 |
| --- | --- |
| `.output/deepl-speed-v2/sw-proper-preflight-qualification-1792631278223-c9ba15af7643.json` | `da694822b66a2f2b25070e2d924ef074c2f562a88d0e4248aefbd97e7ac2fbdf` |
| `.output/deepl-speed-v2/sw-own-worker-http-prepare-qualification-1792631502677-5581b364c2c4.json` | `b74051524df667a00d10e5685a3be7067ef5b27db5efb73d8fc9ba8f58611d89` |
| `.output/deepl-speed-v2/qualify-sw-proper-preflight.mjs` | `047b45685d1d1720b076364e45242c7bce6e164fa835dccc7768fbb86e9a027d` |
| `.output/deepl-speed-v2/qualify-own-worker-http-prepare.mjs` | `293984eafad4386c3e72abab990cde7615d9fa66569fead2f74cbbbb8ac44ed4` |
| `src/platform/deepl-web-transport.ts` | `213dc207254f80557eacdb82a295c529baed39143ae1bc613611cc44ef0ea8d8` |
| `src/providers/deepl-web.ts` | `ba1fae9c8d1ba813290d4ee0838007676e2e9341831bd901c67db3519183cf30` |
| `src/providers/request-scheduler.ts` | `7d040d346e03cb3ee945c19da8805be51c22708db63e50a96bea303fb89e9d54` |
| `src/platform/deepl-web-state.ts` | `f062de48f9b8d3d4e4ebd4eff0b99343df618341e666ad769f5bd13ae8aeed37` |
| `src/entrypoints/network-prepare.content.ts` | `80b984e448617efc045ce4f3de38832d0870f628f99b2ff877524534fe557f3a` |
| `src/platform/web-access.ts` | `d2548a7d3d73239cc6c6b828bc3e0450b9648742b0eff1033c9c1b87248c694d` |
| `src/entrypoints/background.ts` | `8b1dbb4e298f75cf7940c8eee753f25127599540f43bd52feaf584c5137df73d` |
| `src/entrypoints/options/main.tsx` | `083745b859b48110e80d7c662f35b3055efed753ed7d07dd7eaaf1aaf4699a2a` |
| `src/shared/translation-engine.ts` | `5f6d91914c3d1f231e16bff0c088fe2b13eacf140eaa1642b9099e30b70ce1b9` |

两次诊断原始记录均保存了恢复前后的相同 SHA-256：诊断 manifest `eee4bf8e59c9505edc3e5e6a5a89c3810e615982beb5bfd033d1ab0da1547703`，worker `54408165ed5f1639ab23a1038b4d4652c7b276ab7535dedf9e46580dd8d31b76`，content 原先为不存在且恢复后仍不存在。

匿名 OneShot 的官方产物来源沿用[已保存的官方静态证据](deepl-official-oneshot-2026-10-22.md)：Mozilla DeepL `1.104.2` XPI SHA-256 `50a5de57865c38ecd9057edb0aec5bb3379ad02c6bef3197fdae0038ddd42c16`，其 `background.js` SHA-256 `c6a4f06b0ca65f601737315c5f662218b60eba4a712d76ec4864f9287f3c08e8`。该证据支持端点与匿名文本协议来源；**不证明官方客户端使用或支持本文新增的 OPTIONS 准备策略**。
