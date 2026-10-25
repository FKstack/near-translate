# 篡改猴 DeepL 完整性与速度研究（2026-10-25）

当前状态：**用户接受当前约 15.3 秒后的 v0.11.16 产品发布验收通过；原 15,000ms 研究目标仍未通过**。同一实际安装版本的五篇真实后台冷文档全部完整、零失败／待处理，长文为 15,294.7ms，其余四篇为 3.0783–3.8256 秒。没有混用 v0.11.15 成绩。停止继续优化，进入已授权发布工作流；CI、合并和公开发行仍待完成，不能称已经发布。

本报告与[数字证据](../evidence/userscript-deepl-speed-2026-10-25.json)保留失败候选。原研究目标覆盖多篇不同长度公开文章，每篇冻结的生产原文集合全部回填、失败与待处理均为 0、全文从点击到完成不超过 15,000ms；其中长文对照为同一公开 Go 文章、251 个唯一原文／53,505 个 UTF-16 单元。按未取整的时钟判定，不能通过四舍五入跨过门槛。缓存重译、局部输出、本机固定 JSON、短句服务资格与单篇短文成功均不能代替完整验收。

文档时钟按显示精度排版，未取整的原始浮点值、阈值判断及文件哈希均保留在数字证据 JSON；15.2947 秒约为 15.3 秒，仍超过原 15 秒目标。

## 当前验收环境

用户需要继续使用浏览器，无法固定翻译标签在前台。按此实际约束，自 v0.11.15 起的五篇统一测量改为**独立后台测试标签、有效 1280×900 视口**，不再要求用户保持目标标签前台。仍使用真实 DeepL 服务、冷文档且不复用脚本译文缓存，每篇全部冻结原文完成、失败与待处理为 0，保留原始 fullDoneMs；原研究的 ≤15,000ms 判定继续留档，当前发布速度依据为用户明确接受本版约 15.3 秒的观察值。尺寸为 0 的运行仍无效。

每轮分别记录管理／控制层的 tab active、window focused 与页内 visibility／focus／实际尺寸，保留它们之间的区别。最终成绩只可标为**后台环境实测**，不能冒称操作系统前台实测；前台性能状态为“未测”。后台环境调整本身没有改变研究门槛；用户后续另明确接受当前观察速度并要求发布，见下文判定变更。v0.11.15 后台五篇原研究目标失败，v0.11.16 的原 15 秒目标同样未通过；当前同版本五篇补测已完成，用户接受速度后的产品判定通过，发布工作流尚未完成。

## 历史对照和计时口径

[第五轮历史报告](DEEPL_PERFORMANCE_V5_2026-10-22.md)记录过扩展版 37 次 POST 全部 HTTP 200、251／251 段、首个可见正文 1.420 秒、全文 14.295 秒。但同程序约 94.004 秒后的独立新标签复测在第 21 请求收到 429，只完成 118／251 段；这是一轮成功成绩，不能当作稳定服务保证，也不能写成这次篡改猴版已经达标。

本轮使用日常 Edge 中实际安装的脚本，每轮是没有脚本译文缓存的新文档；长文精确网址为[公开 Go 文章](https://go.dev/talks/2012/splash.article?utm_source=chatgpt.com)，另补测 [Rust 1.85.1 短文](https://blog.rust-lang.org/2025/03/18/Rust-1.85.1/)。[PageBenchmarkProbe](../../scripts/benchmarks/page-probe.ts)复用生产正文采集和视口资格规则，在真实翻译按钮的点击路径开始前用页内 `performance.now()` 记起点，以 MutationObserver 记录合格正文及全文回填，工具调用耗时不参与翻译计时。

Go 长文要求工具栏终态为 done、251／0／0，且冻结的 251 项原文分别映射到 251 个非空 done 译文节点；短文按其各自冻结集合判定。下表保留的六轮均 sourceChanged=false、mappingConflicts=0、unexpectedTranslations=0、visibilityFailures=0；输出仅保留 SHA-256 指纹，不保存文章译文、请求正文或凭证。下一 RAF 是近似帧时点，不等于操作系统绘制时间。

| 实际安装程序 | 首个初始可见正文 DOM | 初始可见正文全部完成 | 初始可见正文数 | 全文完成 | 完成／失败／待处理 | 速度门槛 |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| v0.11.10，完整 JSON 文本读取、应用层串行 | 2.6008 秒 | 4.8665 秒 | 4 | 74.2293 秒 | 251／0／0 | 未通过 |
| v0.11.11 本机候选，解除应用层两处串行 | 2.7826 秒 | 6.3031 秒 | 6 | 77.2911 秒 | 251／0／0 | 未通过 |
| v0.11.12 本机候选，固定 query lane；Go 长文 | 2.8196 秒 | 3.3403 秒 | 6 | 15.0246 秒 | 251／0／0 | 未通过，超出 24.6ms |
| v0.11.13 本机候选，精简文本回调；Go 长文 | 2.6463 秒 | 3.2355 秒 | 4 | 15.0521 秒 | 251／0／0 | 未通过，超出 52.1ms |
| v0.11.13 同候选；Rust 1.85.1 短文 | 2.2842 秒 | 3.0592 秒 | 5 | 3.0640 秒 | 17／0／0 | 仅该样本通过 |
| v0.11.14 本机候选；Go 1280×900，控制层标签未激活／窗口未聚焦 | 3.2486 秒 | 3.8241 秒 | 4 | 15.6326 秒 | 251／0／0 | 未通过，超时 |

各轮视口不同，不能把“初始可见正文全部完成”当作公平的同视口速度对照。五轮 Go 的原文集合和字数相同，均未以少翻段落提速。Rust 短文冻结集合为 17 个唯一原文／1,352 个 UTF-16 单元，完整渲染 17 个译文；这是生产选择器的源文本计量，不是按自然语言单词统计。v0.11.13 的 Go 与 Rust 两轮 protectedCodeTranslations 均为 0，没有在受保护代码块内插入译文。导航到点击包含工具准备、版本核验等等待，已与点击后耗时分别保留：最初两轮约 149.705／347.704 秒，随后三轮约 49.553／50.529／383.946 秒，有效尺寸 v0.11.14 一轮约 160.591 秒。各轮没有记录每次真实服务请求的 HTTP 时序或日常浏览器／管理器精确版本，不能从隔离测试版本补写这些信息。

## 两层应用串行与管理器等待

最初的脚本版把整个翻译任务放进 1 路／200ms 外层队列，DeepL provider 又覆盖为 1 路。v0.11.11 候选让 DeepL 使用既有 provider 的 8 个在途、100ms 最小启动间隔、滚动 12 秒最多 30 次启动；模型保留原串行队列和流式读取。每批获得调度槽后、发包前还复验设置、任务归属与取消信号。

真实全文仍需 77.291 秒，说明仅解除应用层串行不足以完成目标。原封 Tampermonkey 5.4.1 隔离材料的静态核对发现：`redirect:error` 和 `manual` 都进入 QA，按 method 加 exact URL 等待前一个请求，并在响应头到达后释放。该等待会把多个请求到响应头的网络等待叠加，与候选仍约 77 秒的现象一致；下一节用受控延迟响应头实验单独验证管理器层的串行机制。

关键材料 SHA-256：

- `background.js`：`0514363b47446a60cb7e4ac83dc2e64ab8219c1f73ea55d81aa092de6bb38596`。
- `page.js`：`1bcb0b697c71be07e026e07c54a50d8fae29ac76b7d8cf300453d4203fc34128`。

该包 `background.js` 的 QA 位于 952–956 行，1092 行将 Ki 绑定到 QA；469–471 行进入 error／manual 请求路径并在响应头后释放；331–332 行的 Hn／Wn 规范化保留 query。这里只记录定位与哈希，不提交第三方完整代码，也没有修改管理器或浏览器安全检查。[Tampermonkey 官方 GM 请求文档](https://www.tampermonkey.net/documentation.php?locale=en&q=GM_xmlhttpRequest)说明 redirect 支持 follow、error、manual，并使用 fetch；文档没有承诺同地址并发语义。本结论限定于已核对的 5.4.1 包及下面的实际本地对照。

## 原封管理器、本机延迟服务对照

测试使用独立 Chrome-for-Testing 156.0.8078.4 profile、原封 Tampermonkey 5.4.1、固定 JSON 服务；每个请求在返回响应头前等待 500ms。没有模拟 GM API，外网流量被拒绝，正文是本机合成材料。下表是机制实验，不是真实 DeepL 性能成绩。

| 一批 8 次请求 | 批次约耗时 | 服务器最大在途 | 结果 |
| --- | ---: | ---: | --- |
| 原生 GM，完全相同 URL，error／anonymous／text | 4.301 秒 | 1 | 8 次 HTTP 200，实际串行 |
| 当前 adapter，完全相同 URL，error／anonymous／text | 4.278 秒 | 1 | 8 个完整合法 JSON，实际串行 |
| 原生 GM，完全相同 URL，manual／text | 4.269 秒 | 1 | 8 次 HTTP 200，仍串行，否决提速方案 |
| 同 path、固定 query lane 0–7，error／anonymous／text | 1.161 秒 | 6 | 8 次 HTTP 200，逐 lane 正文／响应头标识全部匹配 |

adapter 的原始 trace 没有独立 batch-end，其约 4.278 秒使用紧随其后的 manual 批次起点作为结束标记，具体来源保留在数字证据中。固定 lane 一轮观察到的是服务器最多 6 个并发，符合本机 HTTP/1.1 同源连接池限制；它证明消除了 exact-URL 单路等待，**不能冒称服务器同时收到 8 次请求，也不能由此推算真实全文已经低于 15 秒**。

同一实验对固定 lane 并行发出 8 次混合 302／307／308 响应，`redirect:error` 全部以 TypeError 拒绝，目标 sink 请求数为 0。manual 的三个独立重定向资格也没有触达 sink，但由于它仍串行，未采用。没有改成 follow 后再验 finalUrl，因为这不能防止 307／308 已经转发正文。

原始本机结果文件的字节数和 SHA-256、无正文的请求／回调时序、lane 对应断言及 sink=0 保存在数字证据；不复制浏览器其他外联尝试列表或完整第三方分发包。

## 文本回调精简的本机资格对照

另用同一原封 Tampermonkey 5.4.1 隔离环境，复制两份当前 adapter：baseline 恢复 onloadstart／onprogress，minimal 不注册这两个 DeepL text 无用回调。只记录元数据的 wrapper 将请求和回调原样转发给真实 GM，没有模拟响应。localhost 服务先 flush 响应头，约 100ms 后发送完整中文和 emoji JSON；保留 onreadystatechange 的早响应头处理与 onload 的完整文本结算。

单次各 8 个请求，baseline 观察到 40 次回调，minimal 为 24 次；两者均保留 16 次 state 回调和 8 次 load，各自 8 份正文全部完整，正文回调比响应头晚 77–96ms。批次为 347ms／341ms，只有本机单次 6ms 差值，不能外推到 Go 或 DeepL。精简版本的 302／307／308 全部以 TypeError 拒绝，sink=0。原始 `tm-text-callbacks-Fik3Id/result-flushed.json` 的哈希和归一化断言保留在数字证据。真实 Go 的 v0.11.13 仍为 15,052.1ms，未满足速度门槛。

## 真实端点资格与方案边界

主代理另用 Node fetch 对固定 DeepL path 加 `near_translate_lane=0` 做了**一次**固定公开短句资格请求：匿名标记 `Authorization: None`、credentials omit、redirect error，HTTP 200、合法中文，1,290ms，未自动重试。这个结果仅支持该时点服务接受此 query；它不是篡改猴端到端测试，也不是全文速度成绩，没有独立原始文件哈希可补写。

候选设计是 DeepL 专用的 8 个固定 query URL，参数只含 0–7，不含正文、页面地址或用户标识；内部选择空闲 lane，并在完整文本请求结束或取消后释放。每条实际 lane 仍须校验精确 finalUrl，服务若拒绝 query 就停止，不能自动重发 canonical URL。只使用一个 provider 的既有 8／100ms／30 次每 12 秒预算，不为每条 lane 各开一个 provider，不提高匿名 1,500 字符／32 项限制，不换账号、Origin、身份或更新渠道。

脚本 provider 属于当前文档；跨标签共享冷却不等于全浏览器共享 8 路预算。模型 API 保持原 URL、串行和 stream。上述是方案边界；最终源码及回归测试仍应以实际审查结果为准。

## CPU 机制计数与零尺寸视口排除

v0.11.14 在单次 source snapshot 内用 WeakMap 复用隐藏祖先的可见性判定，不跨 snapshot 或文档缓存。离线 VM 使用实际旧、新 viewport 源码分别转译执行，fixture 为 251 段、每段 2 个原始 Text 节点、共用 html／body／article。样式读取由 3,012 次降为 254 次，减少 2,758 次（91.57%）；502 个原始 Text Range 仍全部测量，所有优先级值一致。这是确定性的调用计数，不能换算成真实页面毫秒收益；该数字来自诊断代理的执行结果，当前没有独立数值 artifact 哈希可补写。[现有 viewport 单测](../../tests/unit/page-viewport.test.ts)中的 “reads each shared ancestor once across 251 paragraphs and their original text ranges” 断言新程序的 254 次样式读取及 502 个 Range；旧程序 3,012 次读数仅保留在实际旧函数的 VM 工具输出中。

首次真实 v0.11.14 Go 运行记录在 `deepl-v14-go-long.json`，全文时钟 15,011.1ms、完成 251／251 段、失败与待处理为 0，但记录的 viewport 为 **width=0、height=0**，viewportTargets=0、首个可见正文和首屏时钟为 null；截图也明确报 `Cannot take screenshot with 0 width`。因此单列为 **invalid-viewport**，不进入正常性能对照或最终验收。即使产物中的 visible=true、focused=true、visibilityFailures=0，也不能代替有效尺寸。该时钟本身同样超过 15,000ms，不能据此宣称速度达标。

主代理随后用受支持的 viewport capability 恢复并统一为 1280×900，Playwright 读数为 inner=1280×900、document client=1265×900。后续五篇最终实测采用此尺寸，并计划在结束后 reset；v0.11.15 的后续五篇已作为独立候选组记录，不回填为既有样本的条件。零尺寸运行与恢复后的运行不能当作同条件 CPU 收益对照。

另有一次 Page.bringToFront 工具调用异常阻塞约 24 分钟；主代理已停止使用该命令。这个工具等待不是翻译耗时，不能计入点击后的全文时钟。恢复尺寸、截图错误和阻塞事件目前只保留主代理工具观察说明，不伪造独立 artifact。

## 有效尺寸失败候选与纯 DOM 诊断

`deepl-v14-go-normal-1.json` 是恢复尺寸后的真实 v0.11.14 Go 运行：inner=1280×900、document client=1265×900，完整 251／251 段／53,505 UTF-16、失败与待处理 0，代码区域译文 0。原始全文时钟为 **15,632.6ms**，严格超过 15,000ms，因此仍失败。该轮控制层观察到 tab active=false、window focused=false，与页内记录 visible=true／focused=true 不同；控制层观察来自主代理工具结果，未伪装成原始 JSON 字段。本轮保留为有效尺寸的中间失败候选，不能代表 OS 前台实测，也不据此推断 CPU 改动的同条件收益。新的后台验收协议不改变它超时失败的事实。

`deepl-dom-cpu-diagnostic.json` 单独记录 1280×900 下的纯 DOM 操作，translationRequests=0、mockedNetwork=false：采集 251 段／53,505 UTF-16 用时 44.4ms、567 次 getComputedStyle；连续 8 轮各验证 251 段，每轮 39.3–54.5ms、1,676 次 getComputedStyle；viewport snapshot 为 9.5ms、529 次 getComputedStyle。它只定位本机 CPU 工作，与上节离线共用祖先的 fixture 也不是同一负载。没有发出翻译请求，不能将这些毫秒或调用数写成网络提速收益，不能用来通过 15 秒全文门槛。

session 验证路径的源码优化已通过审查，并已在 v0.11.15 候选完成五篇实测；该组完整但长文超时。当前最终验收允许后台标签；每轮仍须记录控制层 active／focused 与页内可见／焦点及非零统一尺寸，不能把页内布尔值当作 OS 前台证据。

## v0.11.15 session 调度机制对照

`deepl-session-cpu-planning-2026-10-25.json` 对照实际旧 HEAD／新 session 源码，用合成文本保留已保存 Go 的 251 段／53,505 UTF-16 长度和冻结视口优先级代理，networkRequests=0。它没有恢复历史真实请求正文。辅助重算脚本为 `session-startup-planning-comparison.mjs`，两者字节数、SHA-256 及所比较源码哈希保留在数字证据，不复制合成请求正文或完整脚本。

append 的 current 检查由 502 次降至 251 次；冷启动首 8 路的 initialCurrentCalls 由 2,302 次降至 465 次，前 8 包合成内容／顺序数组 SHA-256 均为 `f95e7742250414731489160583faa16125a03f7e8df658947c17ea3e40d01163`。另以串行完成整个代理规划，旧／新均 37 包、fixture 状态为 251 done／0 failed／0 pending，全部合成包内容／顺序数组 SHA-256 均为 `4aca23bf225d9ad18548e61946ada167f04e1d32946d282500ed5b9f45d998e1`。

这里的原始字段名 wireSha256 仅指该合成 fixture 的数组哈希，不能称为真实 wire 复原或真实服务完成。新 session 保留拟发送组的完整资格复验及 generation／发包前检查，减少的是全体等待组的重复扫描；数字包含新程序的安全复验。该对照只证明此代理负载内的调用次数下降及包内容顺序一致，不提供真实页面、网络或毫秒提速成绩。

此前的前台准备方案已被用户继续使用浏览器的实际约束取代。同一 v0.11.15 候选的五篇真实测量已完成，逐轮实际环境、尺寸及失败组结果见下节。

## v0.11.15 五篇真实后台候选组：未通过

五轮均为同一 verifiedVersion=0.11.15、真实 DeepL、新文档、不复用脚本译文缓存。原始文件逐轮记录 tabActive=false、windowFocused=true，页内 visible=true／focused=true；视口均为 inner 1280×900，实际 document clientWidth 分别为 1,265 或 Python 页的 1,272。它们是后台样本，不能写作 OS 前台性能。

| 文章 | UTF-16／段数／唯一原文 | 首个初始可见正文 DOM | 全文时钟（ms，显示值） | 完成／失败／待处理 | 单篇硬门槛 |
| --- | --- | ---: | ---: | --- | --- |
| [Rust 1.85.1](https://blog.rust-lang.org/2025/03/18/Rust-1.85.1/) | 1,352／17／17 | 2,503.0ms | 2,858.1 | 17／0／0 | 通过该样本 |
| [Go：Errors are values](https://go.dev/blog/errors-are-values) | 6,797／35／35 | 3,161.9ms | 3,870.1 | 35／0／0 | 通过该样本 |
| [Python 3.14.0 final](https://blog.python.org/2025/10/python-3140-final-is-here/) | 4,428／96／92 | 无初始合格正文目标 | 4,017.4 | 96／0／0 | 通过该样本 |
| [Rust 1.85.0 实际 canonical URL](https://blog.rust-lang.org/2025/02/20/Rust-1.85.0/) | 7,869／66／66 | 3,068.6ms | 3,957.7 | 66／0／0 | 通过该样本 |
| [Go SPLASH](https://go.dev/talks/2012/splash.article?utm_source=chatgpt.com) | 53,505／251／251 | 3,153.3ms | 15,226.6 | 251／0／0 | **失败，超过 15,000ms** |

五篇均 renderedSegments=sourceSegments、mappingConflicts=0、unexpectedTranslations=0、sourceChanged=false、protectedCodeTranslations=0。Python 的 96 个原文节点含 92 个唯一文本，不能把唯一数当作只完成了 92 段。其初始首屏为 hero 区，viewportTargets=0，故可见正文／首屏时钟为 null；实际尺寸有效，这与早期 width=0／height=0 无效诊断不同，也不使用一般 firstMs=2,612.7ms 填补不存在的初始可见正文时钟。

Go 长文另记录一次 294ms long task；这只能作为该轮观察，不能由此推出完整因果或保证下一版快多少。五份原始文件的 SHA-256、全部时钟和环境元数据保存在数字证据的 candidateCohorts 中。对应可阅读构建 `deepl-v15-readable.user.js` 为 1,031,725 字节、SHA-256=`37894d4ca0281add61f11f6e223d225c42ff644ceb9d2314d790a4859f53efa7`；本报告只保存关联元数据。主代理通过实际安装脚本的 Debugger 源码核对 @version=0.11.15 及 validateDispatch／near_translate_lane 标记，诊断代理确认构建后 session 源码未变。安装源带有 Tampermonkey wrapper、比 bundle 大，不声称二者字节或整源哈希相同。**该组四篇通过、五篇完整，整体仍未通过**；它们全部保留为 v0.11.15 历史候选，finalRealRuns 仍为空。

## v0.11.16 renderer 机制与本地候选检查

`deepl-render-frame-mechanism-2026-10-25.json` 使用合成 DOM，复用 Go 长度／冻结优先级规划代理的首 8 包 ID，共 71 个新 loading host，networkRequests=0。旧程序在同步冷路径读样式／插入为 71／71，新程序为 0／0，安排一个 RAF 后先读再写；首个插入之后的读取 70→0，读写类型转换 141→1。**资格检查仍保留**，总读取反而由 71→355，不能把同步 0 读误称为全程不读取。

全 251 个 host 的合成对照同样为同步读／插入 251／251→0／0，帧内总读取 251→1,255，读写转换 501→1，最终 host 数与原文不变。这只证明读写分离和从 cold 路径移除同步写入，不提供毫秒提速，不是实际 Tampermonkey 每次 POST 观察数；37 包仍只属于未改变策略的离线规划。机制 JSON、重算 helper `renderer-frame-mechanism.mjs` 及旧／新 renderer 源码哈希只以元数据关联。

v0.11.16 可阅读构建 `deepl-v16-readable.user.js` 已核验为 1,034,813 字节、SHA-256=`b993d4ded078efe90f0902badcdbea00372a409cf2cfcf54537ca6f32f57d2a9`。主代理通过安装脚本的 Debugger 源码核对 @version=0.11.16、flushLoading／validateDispatch／near_translate_lane；不声称带管理器 wrapper 的整源与 bundle 字节或哈希相同。产品源码已冻结，未加入连接预热，也未改变请求预算。

主代理报告：原断言和原 timeout 不变，`--maxWorkers=2` 的完整单测为 1,566／1,566 通过。默认 64 worker 一轮为 1,565 通过、1 个真实 Git dry-run 在原 5 秒阈值超时；该单项按原阈值重跑为 1 通过／10 跳过；默认一轮的实际超时为 5,095ms，失败日志及原阈值重跑日志均保留字节数与 SHA-256，不能删去失败尝试或将它写成默认并发全绿。render／mount／session 定向 103／103、类型、仓库、文档、模块边界、Chrome／Edge 双扩展和两渠道脚本构建通过。随后两渠道各 22／22 浏览器场景均通过；它们使用独立无头 Chrome、模拟 GM transport，真实 DeepL 请求为 0，不能代替实际安装的服务测速。汇总 `deepl-v16-local-validation.json`、两份机器结果及三份单测日志均只保留元数据与 SHA-256；另保留 Chrome 首次 sandbox EPERM 构建日志，对应构建重跑通过。源码在这些检查中未改，重 CPU 检查已结束，默认 Linux CI 仍待后续。

v0.11.16 首篇真实后台长文曾按原 15 秒目标被拒；随后用户接受该观察速度并要求发布，同版另外四篇已补齐，见最终矩阵。本地机制不替代真实样本，也未沿用 v0.11.15 成功短文。

## v0.11.16 首篇真实长文：超时被拒

`deepl-v16-go-long-1.json` 核验安装版本为 0.11.16，真实 DeepL、新冷文档、后台标签 tabActive=false／windowFocused=true；页内 visible=true／focused=true、inner=1280×900、document client=1265×900。原文为 251 段／53,505 UTF-16，完成 251／251、失败／待处理 0，映射冲突、意外译文、原文变化及代码区域译文均为 0。

首个初始可见正文 DOM 为 3,066.5ms，下一 RAF 为 3,109.5ms，初始可见正文全部完成为 3,453.1ms；全文原始 fullDoneMs 为 **15,294.7ms**，严格超过 15,000ms，因此按当时的 15 秒研究门槛被拒；用户后续明确接受该速度，发布判定见下节。该轮另记录 long task 283／65／183／61／53ms，只作为观察，不能相加当作可直接节省的时间或据此推定网络瓶颈。

首篇阶段此记录单列 candidateRuns，当时尚未完成五篇组；用户改变发布速度判定后，已用同一 v0.11.16 补齐另外四篇，未借用 v0.11.15 成绩。用户随后要求停止继续优化并发布当前版本；Profiler.enable 未受支持，未采集 CPU profile，不把离线机制计数或 long task 当作 Profiler 采样。

## 用户接受当前速度与发布判定变更

主代理报告的当前长文为 15,294.7ms 后，用户明确说“当前速度我想了想可以接收”，随后要求“现在将当前代码合并发布，采用工作流”。因此停止继续优化，选择当前 v0.11.16，原 ≤15,000ms 不再作为本次发布的强制门槛。数字证据在 userDecisionChange／releaseGate 中分别保存指示来源和新判定，**原 acceptance.passed=false 及严格目标失败记录不变**；这不是把 15.2947 秒取整成 15 秒，也不是保证所有文章或所有时段同样快。

## v0.11.16 同版本五篇最终产品验证

五轮均为实际安装的 v0.11.16、真实 DeepL、新冷文档、不复用脚本译文缓存、后台标签 tabActive=false／windowFocused=true。页内 visible=true／focused=true 另行保留；inner 均为 1280×900，document client 为 1265×900，Python 页为 1272×900。前台性能未测。

| 文章 | UTF-16／原文段数／唯一文本 | 全文时钟（ms，显示值） | 完成／失败／待处理 | 原 15,000ms 研究门槛 |
| --- | --- | ---: | --- | --- |
| [Rust 1.85.1](https://blog.rust-lang.org/2025/03/18/Rust-1.85.1/) | 1,352／17／17 | 3,078.3 | 17／0／0 | 该样本通过 |
| [Go：Errors are values](https://go.dev/blog/errors-are-values) | 6,797／35／35 | 3,825.6 | 35／0／0 | 该样本通过 |
| [Python 3.14.0 final](https://blog.python.org/2025/10/python-3140-final-is-here/) | 4,428／96／92 | 3,385.5 | 96／0／0 | 该样本通过 |
| [Rust 1.85.0 canonical 页面](https://blog.rust-lang.org/2025/02/20/Rust-1.85.0/) | 7,869／66／66 | 3,637.8 | 66／0／0 | 该样本通过 |
| [Go SPLASH](https://go.dev/talks/2012/splash.article?utm_source=chatgpt.com) | 53,505／251／251 | **15,294.7** | 251／0／0 | **未通过，用户接受该观察速度** |

五篇均 renderedSegments=sourceSegments、mappingConflicts=0、unexpectedTranslations=0、sourceChanged=false、protectedCodeTranslations=0。Python 有效首屏为 hero 区，没有初始合格正文目标，故相关时钟为 null，不伪造首屏成绩；96 个节点含 92 个唯一文本，也不表示少翻了 4 段。逐轮首段、首屏、全文、原文集合、指纹和尺寸均保存在数字证据的独立 v0.11.16 cohort，没有借用 v0.11.15 的结果。

Rust 短文保存器首次把宿主闭包中的旧字符串 0.11.15 写入 verifiedVersion；实际安装脚本在计时前已经由 Debugger 独立核验 @version=0.11.16／flushLoading。原始元数据文件和更正文件均保留字节数及 SHA-256，逐字段核对 result 与 browserContext 完全一致，未改变任何计时、原文集合或完成字段；这是宿主版本标签更正，不是脚本降级或混入旧版实测。后续保存改用显式版本参数。

CPU Profiler 的 Profiler.enable 返回 method not found，未取得 CPU profile，未编造 profile 结果；用户接受速度后停止优化。已有离线机制计数和 long task 观察保留，但不冒充 CPU Profiler 采样或真实速度收益。

## 产品验收与发行状态

用户接受当前观察速度，加上同版五篇全部完整／零失败，故 **releaseGate.passed=true**。其范围是产品验证，CI、固定提交的合并、Release、Pages 及 Greasy Fork 公开版本核验另由 publicationWorkflow 跟踪，当前仍待完成；不能把产品验收通过当作已经发行。原严格研究的 acceptance.passed=false、maxFullDoneMs=15000、历史失败原数继续保留，原 strict finalRealRuns 为空。

本地检查为 1,566／1,566（2 workers）及两渠道模拟 GM 浏览器各 22／22，其他检查与失败重跑条件见上文。使用时从原安装渠道更新并刷新文章，保留 Chrome／Edge 扩展、PDF 阅读器和文档转换能力。免费上游的网络、缓存、负载与限流不受控，本轮五篇成功不是后续所有时刻的速度或可用性保证。
