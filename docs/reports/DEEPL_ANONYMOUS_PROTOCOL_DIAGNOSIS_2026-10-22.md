# DeepL 匿名整页翻译：继续诊断记录

最新性能时点见[第三轮研究](DEEPL_PERFORMANCE_V3_2026-10-22.md)：8路/100ms加累计启动窗口，两次新标签全文14.936/14.781秒；10秒全文与稳定2秒首屏未达。以下协议迁移记录保留其各历史阶段的配置与结果。

此记录保留协议迁移第一版的原因、设计与真实验收：251/251 段、0 失败，全文29.330秒，缓存重译118ms且0网络请求。**后续框架与速度优化已安装并两轮通过：全文18.146/18.429秒，均为新前台标签页、38次200且无扩展译文缓存**；当前6路/350ms及首屏优先设计见[第二轮验收](DEEPL_PERFORMANCE_V2_2026-10-22.md)。本记录下面的4路/500ms及首屏7.704秒保留为第一版历史时点。保持免登录、无需 API Key，不切换至已有模型 API；临时诊断权限已经撤销。

## 已取得的实际实现与运行证据

- OJBetter 固定 commit `860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46`，原版 AtCoder Better 1.25.1，Tampermonkey 5.4.1。原脚本 SHA256 `ac54e910d52ff40df1e9f25173a79cb2046eb4b9a1849bc1dcf5b6e07d79aa26`；原始文件、安装页面与运行时均核验，未改第三方函数。
- 原版 TM 的完整界面链路处理全部 251 段 Go 原文，Markdown 去转义后覆盖 251/251 段。其单 `text` 为 54,049 字符、alternatives=3，收到 **HTTP 413**，正文为 `413 Payload Too Large`。原版界面先明确提示 5,000 字符上限；测试接受继续以验证结果。只放行一次，随后原版尝试的重试被测试预算阻止。
- 沉浸式官方仓库固定产物为 1.34.3；Google 官方更新接口以 Chrome 155 条件实际返回的 CRX 为 **1.34.2**，已分别检查。CRX SHA256 `74f185565516c24840c7ea0c07ff17f5d580e74c0d840b1230abdeb4db0a642f`，不将其称为所有用户全局最新版本。
- 两份沉浸式产物的匿名实验通路都使用多个 `texts`，默认分组为 3 项/800 字符，按启动 tick 调度；它没有先把整篇拼成 raw。匿名规则明确移除 Cookie、设置 Origin/Referer/DNT。普通会员或自填 Key 的 DeepL 通路不能与匿名通路混称。
- 历史成功 TM 与隔离 MV3 的最终非敏感请求头一致。本文末的临时授权诊断已进一步捕获实际日常 Edge 的一次失败请求：预期 Origin/Referer 等头正确，无 Cookie/Authorization；该短句仍返回 429，不能仅凭请求头判断服务可用。

原版与商店审计材料在 `.output/diagnosis-2/`，不将第三方发布包纳入本产品源码。

## 历史组包实验：未作为最终方案保留

| 实验 | 真实结果 | 能支持的结论 |
| --- | --- | --- |
| 无标记、32 段合为一个 text，共 2,650 字符，隔离 Edge | 200，2.262 秒，完整还原 32 段 | 此输入下单文本空行组包可行，不能证明整篇可用 |
| 同类内容插入自定义段落标记 | 200，但部分标记改大小写，且出现重复数字等额外文本 | 标记方案不合格，未接入产品 |
| 原版 OJBetter 全文 54,049 字符单 text | 413 | 不能直接以整篇单请求照搬原版；需受限分组 |
| 新组包候选，实际已安装 Edge，Go 网页 | 首包 1,792 ms 返回429；0/251 完成 | 尚未修好；本轮不能报告全文成功或完成耗时 |

最后一项首次保留了错误体诊断：JSON-RPC 错误码 **1042911**，未提供 Retry-After。请求为一个 text、2,650 字符。请求后立即停止，未自动重试。先前几何相同的输入在隔离 Edge 中成功，但测试时间、浏览器配置和服务端累计状态不同，**不是已经控制所有变量的 A/B 对照**。

因此，固定单次字数、数组项数或发送间隔均不足以独立解释全部结果；也没有证据认定某个 IP 被封禁。随后实际浏览器临时观察排除了预期 Origin/Referer 缺失，旧通路的具体服务端限流条件仍未公开。

以下组包候选曾实现并测试，实际首包失败后已被新协议替换：

1. 仅无内部换行的整页源段落，以双换行合成一个 wire text；最多 32 个逻辑段、4,800 字符，分隔符计入预算。普通选区和有内部换行的输入保持原结构。
2. 响应必须仅一个非空 text，严格还原相同段数且每段非空后才回填。缺段或多段整批失败，不猜序、不拆单自动补发。不使用标记或假定 REST 的 HTML 参数适用。
3. 全局仍串行；至少 1,050 ms 的**启动间隔**，慢响应后不再多等完整一秒。取消不重置 tick。
4. 429 先停止队列并启动原冷却持久化，再读取最多 8 KiB/1 秒错误体；仅记录数字错误码、读取状态、时间及解析后的 Retry-After。无正文或凭证遥测。

该历史候选当时通过 **524 项单元测试、22 项 Edge 浏览器定向回归**、类型与模块边界检查及 Chrome/Edge 构建。浏览器回归使用模拟网络，不替代真实验收。它的实际首包仍失败，不能将这些数字当作最终新协议的测试结果。

## 已授权并完成的实际浏览器临时诊断

用户已明确授权一次临时、只读的 `webRequest` 观察，并在实际 Edge Default 配置的诊断页允许临时权限。范围仅为近译自己发往固定 DeepL endpoint 的一次公开短句请求：记录非敏感请求头、HTTP 状态和地址族，不读取 Cookie 值、Authorization 值、API Key 或其他网页内容，不修改或拦截请求。

2026-10-22（UTC+8）真实执行结果：

- 仅发送公开短句 `The library opens at nine in the morning.`，**41 字符、1 个 text、1 次请求**；网络计时 **1,640 ms** 收到 **HTTP 429**，JSON 错误体代码为 **1042911**，未提供 Retry-After。请求后停止，未自动重试。
- `onSendHeaders` 捕获的请求头为预期的 `Origin: https://www.deepl.com`、`Referer: https://www.deepl.com/`、`Content-Type: application/json`、`Accept: */*`、`Sec-Fetch-Site: none`、`Sec-Fetch-Mode: cors`；`cookiePresent:false`、`authorizationPresent:false`。本次地址族为 IPv4。
- 后台指标与观察记录均为一次请求，`isolatedOwnRequest:true`、`counterReset:false`、`requestRowsTruncated:false`。诊断流程完成不代表翻译成功，翻译结果仍为 `RATE_LIMIT`。
- 结束后确认 `permissionRemoved:true`、`permissionPresentAfter:false`，原 manifest 已恢复，`manifestRestored:true`。本次正常结束路径的权限撤销和文件恢复均有实际证据。

原始证据：installed-network-deca185d1ed47a8a6ffa0200817cad54acbbefc8.json（本机历史文件 `.output/diagnosis-2/installed-network-deca185d1ed47a8a6ffa0200817cad54acbbefc8.json`，未随仓库归档）。该证据只支持上述单次公开短句结果，不能证明具体服务端限流策略或 IP 封禁原因。此时旧协议尚未通过全文验收，后续结果见下一节。

## 新协议定位与设计

实际问题是近译继续依赖 `www2.deepl.com/jsonrpc` 的旧匿名通路：即便头部正确、仅一次 41 字符请求，上游仍返回 429/1042911。OJBetter 的旧实现可以复现成功的小输入，却不能保证当前长文连续调用；其原版全文请求本轮又实际收到 413。沉浸式所审查匿名代码仍是实验通路，不能将普通会员 DeepL 的可用性归到免登录接口。

补查找到 DeepLX 的[协议迁移提交](https://github.com/OwO-Network/DLX/commit/98918dd9f6af0c255cbb19a10b7de4c212c68cda)，维护者报告相同错误码。该报告是线索，不是我们服务端错误的权威解释。随后独立检查 DeepL 官网背书的 Mozilla 分发扩展 **1.104.2**，核对下载字节和 SHA256 与 Mozilla 元数据一致；其实际发布代码确认 OneShot free fallback、文本数组协议、中文语言映射及匿名合计 1,500 字符限制。未把 Firefox 包冒称 Chrome/Edge 包；细节、固定下载链接和源码 offset 见[官方产物证据](../evidence/deepl-official-oneshot-2026-10-22.md)。

独立小测试直接使用近译自身扩展 Origin 与真实浏览器网络栈。旧 `ZH/EN` 参数在新接口返回 HTTP200 但仍是英文，严格资格检查拒绝了这个假成功。更正目标为 `zh-Hans` 后，单句和三段原文均返回对应中文；省略 source 的三段自动检测测试也通过。不读取或预热 Cookie，不使用保存的模型 Key、OAuth、设备身份、官方扩展 ID 或第三方代理。

正式请求固定为：

```http
POST https://oneshot-free.www.deepl.com/v1/translate
Content-Type: application/json
Authorization: None
```

```json
{"text":["The library opens at nine in the morning."],"target_lang":"zh-Hans"}
```

`None` 是匿名标记，不是凭证。传输使用 `credentials:omit`、`redirect:error`、`cache:no-store`，不修改 Origin/Referer。source 不传以自动检测。网页只能提交有界的翻译输入，不能指定地址、头部或服务凭证。没有旧 JSON-RPC 自动回退，也不会换用用户保存的收费模型 Key。

职责与具体约束：

1. `providers/deepl-web` 保持纯协议与队列：每批最多 32 项、合计 1,500 个 UTF-16 单元、请求不超过 64 KiB、响应不超过 1,000,000 字节；长段在空白/句边界无损分片并保留 Unicode 和边界空白。不拼 raw、不插标记，不依赖模型保留标签。
2. 返回顶层 `translations[]` 必须与输入数量相同、全部 `text` 非空，整批通过后才按本地段落/分片索引回填。不猜测缺失位置，不因响应不完整自动拆单补发。正文抽查和正确目标语言参数避免把 HTTP200 本身当成成功；代码名等合法专名不强求包含汉字。
3. 后台唯一 provider 为全扩展共享队列，最多 4 个在途请求，相邻启动至少 500 ms；同页最多 4 个既有 worker 供给任务，不一次灌入全部请求。该值是客户端策略，不是 DeepL 公布的服务端速率。不同调用不合并正文，乱序完成仍由各自 Port/requestId/generation 回填。
4. 每个请求有私有 AbortController。取消立即终结调用方等待，但底层请求、响应读取或取消尚未真正完成时仍占槽；取消、重译不清启动 tick。429 先启动全局冷却、拒绝排队并终结/取消同服务的其他在途任务，再做有界错误体诊断及持久化；迟到响应不能回填，不自动重发。冷却至少 60 秒，接受更长 Retry-After，MV3 休眠与切引擎不清零。
5. `platform` 唯一拥有固定网络目的地和 host 权限；正式路径不需要 webRequest 或 DNR。已授予旧 DNR 的安装只尽力移除本扩展旧规则 `74001`，不撤销其他权限/规则。模型 profiles、Key、连接配置原位保留，DeepL 模式不使用它们。
6. 整页仍采集唯一可见 article/main 正文，保留英文原文、代码、图片和编辑区域；不以少翻段落换速度。当前文档缓存最多 1,500 项/约 2 MiB，恢复原文保留缓存，导航/连接变化/撤权等清理；缓存重译单独计时，不能冒充首次网络翻译速度。

## 验收范围

目标固定为用户给定的 [Go 文章](https://go.dev/talks/2012/splash.article?utm_source=chatgpt.com)，实际日常 Edge Default，原扩展 ID `dbdooijmbinjmnbmgglajigaoiinolnc`。新标签页不使用扩展译文缓存，完整性要求为 **251/251 段、53,505 原文字符、失败 0、待处理 0、实际回填 251**；随后恢复原文再译，要求输出一致且网络请求 0。上游缓存/负载不受测试控制，抽查正文不等于全文人工语言审校。

| 真实测试 | 首屏正文 | 全文完成 | 段落 / 失败 / 待处理 | 网络 |
| --- | ---: | ---: | --- | --- |
| 串行基线 | 7.892 秒 | 95.686 秒 | 251 / 0 / 0 | 42 次200，53,505字符 |
| 最终流水线，新标签页无扩展缓存 | **7.704 秒** | **29.330 秒** | **251 / 0 / 0** | **42 次200，53,505字符** |
| 最终方案恢复原文后重译 | 118 ms | **118 ms** | **251 / 0 / 0** | **0次，输出一致** |

第一次并发轮虽完成251段/32.352秒，但后台额外151字符活动请求使缓存阶段中止，整轮标为不合格且保留证据；来源没有确定。相同程序未reload或改配置，新标签页独立复测才完整通过。最终计时不是保证后续所有请求相同速度，上游缓存/负载未受控。

最终 **541/541 单元测试、23/23 Edge 定向浏览器回归**、类型/模块边界/差异检查和 Chrome/Edge 构建通过。回归网络为模拟，与上述实际服务计时分开。实际DOM再次核验唯一翻译栏、251译文；5个非汉字结果均为品牌/域名保留，28个pre和176个code内均无译文节点。截图因浏览器缺少有效activeTab权限未生成，未为此增加权限。

实际程序仍在原安装路径，保留原扩展ID、配置及模型Key，DeepL翻译请求不携带或使用该Key；诊断和测试工具未读取或导出Key。安装程序哈希见[部署证据](../evidence/deepl-oneshot-deployment-2026-10-22.json)；请求时序与三轮完整计数见[真实验收数据](../evidence/deepl-oneshot-go-2026-10-22.json)与[性能记录](PERFORMANCE.md)。本轮未重新发布历史ZIP，实际安装及当前源码构建已更新。

Chrome 官方说明 `webRequest` 需在 manifest 声明并具有对应 host 访问权限，Origin 等头还需要 `extraHeaders` 观察选项：[API 文档](https://developer.chrome.com/docs/extensions/reference/api/webRequest)。

来源：[OJBetter 固定实现](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/atcoder-better.user.js#L15911)，[沉浸式匿名适配器](https://github.com/immersive-translate/immersive-translate/blob/609114bcb337ecb968498bc1b917d55679f39e24/dist/userscript/immersive-translate.user.js#L6269)，[沉浸式规则](https://github.com/immersive-translate/immersive-translate/blob/609114bcb337ecb968498bc1b917d55679f39e24/dist/chrome/request_modifier_rule.json#L35)。
