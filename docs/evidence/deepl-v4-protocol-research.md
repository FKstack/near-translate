# DeepL 第四轮协议复核与“第32请求”证据

核验日：2026-10-22。本轮读取已有实测记录，查询第一方仓库与官方文档，惰性分析已归档产物；**没有发送真实翻译请求、读取凭证或执行第三方脚本**。生产改动仅另行授权的有界诊断增强，不据此宣称性能已经改善。

当前证据没有发现 OJBetter 或已审查匿名适配器中“累计第32请求”的特殊协议分支，也没有发现可以直接用于匿名 OneShot 的低延迟参数或更大合法批量入口。两次同位置429值得调查，但请求次数、累计文本量与固定内容相互混杂，尚不能确定服务端的具体阈值或唯一原因。

## 1. OJBetter 当前源码仍与原复现版本相同

通过 GitHub connector 读取第一方仓库 `beijixiaohu/OJBetter` 的当前默认分支 `main`：`script/release/atcoder-better.user.js` 自报 `1.25.1`，文件 blob 为 `1565e6f4d37c533a6f563bb1db5a733adf052aeb`。对本地固定 commit `860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46` 的归档运行只读 `git hash-object`，结果完全相同。这证明本次看到的默认分支文件与固定复现文件相同，不将动态 main 链接作为永久版本标识。

固定文件 SHA256 为 `ac54e910d52ff40df1e9f25173a79cb2046eb4b9a1849bc1dcf5b6e07d79aa26`，归档身份见 `.output/ojbetter-reproduction/source-manifest.json`。

| 固定源码位置 | 实际行为及意义 |
| --- | --- |
| [L941](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/atcoder-better.user.js#L941) | `deepl_type` 默认 `free`，与 `api` 配置分支分开。不能把其 DeepLX / API Key 配置当成默认匿名路径。 |
| [L15911](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/atcoder-better.user.js#L15911) | `translate_deepl` 发送旧 `www2.deepl.com/jsonrpc` 的 `LMT_handle_texts`；一次只有一个 raw text，`splitting:newlines`、source 为 `auto`、alternatives 为 `3`。没有 OneShot、context、SSE 或32项分组。 |
| [L15935](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/atcoder-better.user.js#L15935) | 声明 Content-Type、Host、DeepL Origin / Referer，`anonymous:true`、`nocache:true`；无 Authorization / Key。声明头与浏览器最终 wire 需分开判断，不能据此新增官方身份伪装。 |
| [L16055](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/atcoder-better.user.js#L16055) | timestamp 由整份 raw 内的小写 i 数量修正；ID 参与 method 空格格式选择。当前 OneShot 没有这些字段，不能将旧字段加到新协议中。 |
| [L9266](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/atcoder-better.user.js#L9266) | 一个被选中的 UI 区块先形成 Markdown，再作为一个翻译任务入队；不是将任意网页自动拆成32项发出。 |
| [L7887](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/atcoder-better.user.js#L7887)、[L929](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/atcoder-better.user.js#L929) | TaskQueue 按服务类型串行等待任务完成，随后才等待默认200ms再继续；只有 OpenAI 可走非队列分支。该对象不管理32路网络连接。 |
| [L11112](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/atcoder-better.user.js#L11112) | DeepL 的5000是脚本的超长提示，允许用户确认继续；不是官方匿名服务保证接受的预算。 |
| [L4086](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/atcoder-better.user.js#L4086)、[L17137](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/atcoder-better.user.js#L17137) | DeepL 使用普通 GM 请求，不传 `isStream=true`。BaseTranslate 会对抛出的异常作通用重试，默认尝试数3、重试间隔0；它没有按32次计数、持久冷却或精确解析服务限额的实现。近译不照搬该自动重试。 |

本次对 DeepL 执行链以及全脚本字面 `32` 做定向检查，32的其他命中为 SVG 数值、语言 ID 注释、AES key 长度等；没有找到与该 DeepL 请求序列相关的32分支。这是所检查源码的结论，不是服务端没有32相关策略的证明。

原版 TM 的完整 Go 内容测试已经确认251源段覆盖、54049字符的单 raw 请求收到413。该历史记录为 `.output/diagnosis-2/ojbetter-go-full-summary.json`；不能把此前少量短文成功推广成“原脚本能匿名快速翻译整篇53k文章”。

## 2. 沉浸式的可比较路径与本轮结论

既有审计分别锁定第一方仓库 commit `609114bcb337ecb968498bc1b917d55679f39e24` 的1.34.3产物及 Google 更新接口实际返回的1.34.2商店包。它们不能与当前任意用户安装版本混称，身份、哈希、REA覆盖范围详见 `.output/diagnosis-2/immersive/findings.md`。

- 匿名 `d` 为 Canary 路线，普通界面中的会员 DeepL / 自填 Key 路线不能用于推断匿名能力。[固定 userscript L5848](https://github.com/immersive-translate/immersive-translate/blob/609114bcb337ecb968498bc1b917d55679f39e24/dist/userscript/immersive-translate.user.js#L5848)
- 匿名实现仍是旧 JSON-RPC，默认每组3项、800字符，每项 alternatives3，`splitting:newlines`；逐项读取响应数组，不先将段落拼成 raw。上层 contextSnapshot 没有被该适配器消费。[L6269](https://github.com/immersive-translate/immersive-translate/blob/609114bcb337ecb968498bc1b917d55679f39e24/dist/userscript/immersive-translate.user.js#L6269)
- 其1050ms是后台预约启动节拍，网络可以重叠；并非完成后1050ms。近译已经实现独立的有界启动调度，不再缺少这项基本能力。[后台 L143](https://github.com/immersive-translate/immersive-translate/blob/609114bcb337ecb968498bc1b917d55679f39e24/dist/chrome/background.js#L143)
- 它的匿名规则移除 Cookie，并修改 DeepL Origin / Referer / DNT。当前 OneShot 资格已使用近译自身身份成功，不以复制这些旧请求头、设备身份或网页登录态作为优化方案。[规则 L35](https://github.com/immersive-translate/immersive-translate/blob/609114bcb337ecb968498bc1b917d55679f39e24/dist/chrome/request_modifier_rule.json#L35)

这两份匿名产物没有提供新 OneShot 的32次序列规则、公开额度或更快的匿名大批量实现。此前文档中有关近译旧JSON-RPC组包、串行状态的段落属于历史对照，不能当作当前生产实现。

## 3. 两次第32请求：证据能排除什么

下表仅离线重读已有 raw JSON，没有新增服务请求。`执行跨度`指第32次本地 fetch 开始相对第一次本地 fetch 开始，不是服务端到达窗口。

| 已有试验 | 第32包几何 | 前32包合计 | 第32次结果 | 执行跨度 |
| --- | --- | --- | --- | ---: |
| 8路 / 100ms | 5项 / 1471字符 | 230项 / 46508字符 | HTTP429，h2，约694ms | 8144ms |
| 8路 / 200ms | 5项 / 1471字符 | 230项 / 46508字符 | HTTP429，h2，约650ms | 8597ms |
| 30次 / 12秒窗口首轮 | 5项 / 1471字符 | 230项 / 46508字符 | HTTP200 | 第31次起受本地窗口约束 |
| 同窗口独立新标签复测 | 5项 / 1471字符 | 230项 / 46508字符 | HTTP200 | 第31次起受本地窗口约束 |

对应原始文件：

- `.output/go-page-deepl-v2-cold-a08cddd8158c85f5736287398d54e16a125e519b.json`
- `.output/go-page-deepl-v3-8x200-5a046fee23bf9cb47500c6d6266a4ba808d6b149.json`
- `.output/go-page-deepl-v3-window30x12-9f31e9db7ff7c91858868c20521bb8c2526b123f.json`
- `.output/go-page-deepl-v3-window-confirm-eb122c378b1fe05fec7f5da3229e35a729f029cc.json`

两次失败均最多8个在途，不是32个同时连接。相同包几何与累计量在两次成功轮都可越过第32次、完成38次200，排除了“客户端累计第32次必失败”及“5项 / 1471字符这一几何必超限”的解释。记录没有每包正文哈希，因此不宣称此处已独立验证逐字节相同输入。

两次失败中，次数、累计字符、累计条目及固定内容一起变化；只凭同序号失败，不能分离哪个维度被限制。冷TLS还可能让本地分散开始的请求在连接完成后集中发送。调整节拍后成功支持“发起模式与服务状态有关”这一工作假设，但不是服务端窗口的直接证据。

两份失败记录都只有 `bodyOutcome:json`，没有提取到安全整数错误码或 Retry-After。由于旧诊断只看嵌套数字 `error.code`，不能从字段缺失推断响应没有顶层code、字符串错误类别或说明，更不能把旧RPC的1042911当成此次OneShot响应码。

### 浏览器32连接限制不是现有解释

[HTTP/2 RFC9113 §5.1.2](https://www.rfc-editor.org/rfc/rfc9113#section-5.1.2)限制的是同时开放的流；超出对端并发设置对应流错误，不是累计发起32次就自动产生HTTP429。当前 [Chromium socket pool 源码](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/socket/client_socket_pool_manager.cc)也不能被解释为32项或32次的DeepL计数器；该源码是本次查询的main，不冒称实际Edge二进制的逐行证明。

实际失败已取得 HTTP429 状态和JSON正文，并报告协议h2，因此不能将它等同于浏览器本地排队、socket pool满或HTTP/2流号耗尽。[RFC6585 §4](https://www.rfc-editor.org/rfc/rfc6585#section-4)并不规定服务如何识别调用方或统计请求；具体DeepL服务窗口仍未知。不通过更换连接、身份或IP尝试重置它。

## 4. 当前官方协议的延迟选项与不可移植字段

固定官方 DeepL Firefox扩展1.104.2的XPI / JS身份及匿名长度调用链见[预算证据](deepl-anonymous-budget-v3-2026-10-22.md)，以下 offset 同为原 `background.js` 的0-based UTF-16位置。

| 候选能力 | 现有证据 | 结论 |
| --- | --- | --- |
| `source_lang:'en'` | `wx@640013` 明确可传 source_lang，不需要官方身份；近译已有小样本资格。 | 可作为来源可靠时的正常语言参数，但没有足够证据证明带来所需秒级收益。不能对多语页面盲填en。 |
| alternatives / context / splitting | OJBetter的alts3 / newlines属于旧RPC；官方OneShot `wx`不构造这些参数，也没有context字段。 | 不能把旧参数或REST同名字段移植后就宣称减少服务工作量。当前请求没有备选译文参数可进一步降为0。 |
| `model_type:latency_optimized` | [官方API文档](https://developers.deepl.com/api-reference/translate/request-translation)给出该值，但接口为有API Key授权的`/v2/translate`。OneShot构造只在定制配置中使用 `language_model:'next-gen'`。 | 没有匿名OneShot采用该低延迟参数的第一方证据；`language_model`与`model_type`不是已证明可互换的字段。 |
| 更大text数组 | OneShot `Cx@641106` 有24KiB/100项分组；此前 `Rx@639262 -> Fk@627112`先做匿名合计1500检查。 | 不是匿名扩大预算入口；32项是近译本地保护，不是“第32次”的来源。 |
| 增量OneShot响应 | `rx@630469` 对200调用`.json()`；未建立SSE / 流式翻译事件。实测多数下载只需数ms。 | 即便改增量JSON解析，也没有能省去上游TTFB的证据，不应引入复杂解析器谋求秒级改善。 |
| 官方持久翻译会话 | `VQ@1300210`创建ITA session；`WK@1251410`用protobuf `/v2/startSession`，`credentials:include`，再使用服务返回的SignalR信息。 | 这是另一套会话协议，不是给OneShot加一个stream参数。 |
| 匿名持久会话授权边界 | `wX@1205392`无token返回null；SDK `XK@1261265`包含SHIELD回调分支；`UQ@1299315`仍给匿名source1500。 | 没有证明它能以近译当前无Cookie / 无官方身份的约束提供更快全文或更大匿名预算，不绕过其挑战和认证。 |

官方[整页翻译帮助](https://support.deepl.com/hc/en-us/articles/4407580229522-Translate-with-the-browser-extensions)要求Pro。官方整页、API Key服务、旧匿名RPC、新匿名OneShot与持久会话不能混用能力或限额。本轮不复制官方app_information、客户端ID、令牌或授权配额。

### 已有source参数实验应怎样解读

`.output/deepl-speed-v2/source-hint-network.log`已包含同一235字符短文的暖连接结果：auto约1459.9ms，en约1295.9 / 1491.7ms；另一auto约8207.8ms，但其中新TLS约6760ms。该日志不能证明自动检测多花约7秒；暖连接的几个结果也不足以隔离缓存、顺序与服务负载。没有必要把已有冷连接差异重新当成新的参数发现。

## 5. 下一步只保留能获得新信息的检查

1. 优先在下一次本来就要运行的真实测试中使用增强后的安全诊断，不为复现429而额外发送大量探针。顶层 / 嵌套安全整数code、固定reason分类及纯数字RateLimit字段可能缩小假设范围；字段未提供时继续保留未知。
2. 将本地队列开始、实际wire send、响应headers / body完成与全文回填分开。累计请求数、字符、条目都按实际响应时间统计；不要用被取消但已提交的工作冒充成功量。
3. 若以后验证 source_lang 或装包策略，固定其余变量、保留1500合计边界及完整映射验收，记录连接是否复用；单次短文200只证明当次资格，不足以调整服务吞吐策略。现有source实验未提供足够依据优先改协议。
4. 保留已验证窗口作为本地保护，明确它使第31次最早12秒开始，因此不可能在38包条件下达成全文低于10秒。要改变该策略，应有新的合法能力或服务反馈证据，不能将继续升并发、切连接或重放失败请求称为已找到根因。

本轮诊断增强只保留安全整数和五个固定类别，不保存原始message、detail、任意正文、ID或Cookie。分类是上游已知错误字段的粗线索，不是已核定的服务端限制原因。现有8KiB / 1秒读取界限、429先暂停 / 清队列 / 取消同服务在途 / 保存冷却、取消后不回填及零自动重试保持。当前全文14.936 / 14.781秒、首屏2秒与全文10秒未达的结论不因本次静态研究改变。
