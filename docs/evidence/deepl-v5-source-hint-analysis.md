# DeepL 源语言提示与浏览器原生语言检测：第五轮资格分析

2026-10-22。本轮只分析已保存的真实记录，没有重新请求 DeepL、运行浏览器或修改生产代码。**8 次真实 HTTP200 证明该次 `source_lang: 'en'` 请求可用，但没有显示足以接入生产的提速收益。浏览器原生语言检测运行很快，也不能据此将短文本或混合语言可靠地强制成英文。** 本轮不接入生产 CLD／自动 source hint。

两个长文本项比九个短文本项慢，是值得做同原文配对实验的线索；当前各请求使用不同正文，顺序也不同，不能宣称拆句已经带来因果性的加速。全文低于 10 秒的目标没有因此达成。

## 原始记录与哈希

| 记录 | SHA256 | 范围 |
| --- | --- | --- |
| source-hint qualification（本机历史文件 `.output/deepl-speed-v5/source-hint-qualification-1792635728271-4ebeb9581d42.json`，未随仓库归档） | `e94d182f9a512cc42ff4b29572494674213e8df07fa1b9f366a278c0ff43b3eb` | 隔离 Edge MV3 worker，真实 8 个 POST、44 文本项、11,808 UTF-16 字符 |
| native-language（本机历史文件 `.output/deepl-speed-v5/native-language-891872ef9f1dd87cd763eacc.json`，未随仓库归档） | `14f55462d606498e3dac4b75907dca54ffb28208ab4a7558a147ee124a521ad6` | 已装扩展的临时本地检测页，251 原文加 6 个控制样本，翻译请求为 0 |
| 固定公开源数据（本机历史文件 `.output/deepl-speed/go-page-input.json`，未随仓库归档） | `5c65015c55c525083d8cbf0047f66f6d83310abc59f49d74fcb8d4ecf8898407` | Go 文章 251 项／53,505 字符 |

本轮离线复算了 raw 哈希、源文件哈希、语料哈希与全部 44 个片段 SHA，核对 8 次成功、同一连接及恢复前后文件哈希；没有运行资格脚本的联网入口。

## 八次 source hint 请求的真实边界

请求来自隔离诊断扩展 `cpdfhfjfdjfibaogohckaljcbmoikdpc` 的原生 worker fetch，并非生产整页 UI 的吞吐验收。端点固定为 `https://oneshot-free.www.deepl.com/v1/translate`：

```json
{"text":["固定公开英文片段"],"target_lang":"zh-Hans","source_lang":"en"}
```

`auto` 条件省略 `source_lang`；`en` 条件增加该字段。原生请求设置 `Content-Type: application/json`、`Authorization: None`、`credentials: omit`、`redirect: error`、`cache: no-store` 和 `referrerPolicy: no-referrer`，使用浏览器自身身份。未增加模型、地区或官方客户端身份字段；未使用 OPTIONS、HEAD 或 preconnect 暖连接。

固定目标端点的实际 wire 观察为 8 个 POST、0 个其它方法请求，均 HTTP200／h2、同一 `connectionId: 79`。首个请求建立连接，后七次 `connectionReused: true`；所有行 `fromDiskCache`、`fromServiceWorker` 均为 false。上游缓存和负载未受控，不能将这些标记扩大为“所有层都没有缓存”，也不能把只观察固定端点扩大为整个浏览器没有其它网络流量。

wire 记录核对了方法、状态、自身 Origin、JSON Content-Type、连接和 timing，未保存 postData 或 wire body SHA。字段组合来自固定诊断 worker 构造契约（本机历史文件 `.output/deepl-speed-v5/qualify-source-hint.mjs`，未随仓库归档）；`nativeWireQualified` 不能解释为已逐字节核验线上正文。

worker 返回数量严格匹配输入，44 项输出均非空且包含 Han；原始记录保留了每项输出字符数和 SHA。这个资格标准验证数量、非空与基本目标文字，不是人工译文质量评分，也不证明正文上下文或句义完全相同。

脚本使用种子 `source-hint-v5-2026-10-22`，预先固定次序为 **en／auto／auto／en，auto／en／en／auto**。前四次每包 2 项，后四次每包 9 项；每个形状各有 2 次 en、2 次 auto。每次结束后等 1,050 ms 再发下一次，串行、不重试。每包合计 1,469–1,480，始终低于当前采用的合计 1,500 限制。

语料由固定源中至少 80 字符、至少 12 个英文词的段落以双换行连接；语料 SHA 为 `f2078ffab4f64c10c65d9ffa946e7596789691cf847536720f331120343a084e`。44 个输入片段互不重复，raw 保留 `spans`、`sourceSha256`；相邻的 `pair` 只是试验编组，**不是同正文配对**。

记录显示未读取保存的 Key 或 Cookie、未更改权限／manifest、未替换真实 fetch、未读取或清除冷却、未人工提前等待连接。临时 worker 已恢复，`originalHashes` 与 `restoredHashes` 一致，`originalBytesRestored: true`，隔离浏览器会话已关闭。CDP 挂接可能影响 worker 生命周期，因此仍不是完全等价于用户日常后台生命周期的实测。

## 时延：TLS 与请求后等待分开

表中 TTFB 使用真实网络 timing 的 `receiveHeadersStart - sendEnd`，即请求发完后至首响应头，包含网络往返和服务等待，**不等于模型计算耗时**。fetch 响应头时间则是 worker 的 `headersAt - startedAt`，包括首次连接建立和浏览器调度。

| 请求序号（1 起） | hint | 项／字符 | fetch 到响应头 ms | 发完至首响应头 ms | 连接 |
| ---: | --- | --- | ---: | ---: | --- |
| 1 | en | 2／1,469 | 4,154.0 | 2,320.2 | 新建 |
| 2 | auto | 2／1,475 | 2,230.5 | 2,228.1 | 复用 |
| 3 | auto | 2／1,472 | 2,441.9 | 2,439.8 | 复用 |
| 4 | en | 2／1,479 | 2,507.7 | 2,505.1 | 复用 |
| 5 | auto | 9／1,477 | 1,659.9 | 1,657.5 | 复用 |
| 6 | en | 9／1,476 | 1,661.7 | 1,659.1 | 复用 |
| 7 | en | 9／1,480 | 1,782.4 | 1,779.9 | 复用 |
| 8 | auto | 9／1,480 | 1,795.1 | 1,792.5 | 复用 |

首请求连接建立 **1,829.1 ms**，其中 TLS **1,827.9 ms**；TLS 已包含在连接建立内，不能相加。首轮 en 的 fetch 4.154 秒不能直接与复用连接的 auto 2.231 秒比较，声称源语言提示多花近两秒；其发送后等待实际为 2.320 秒。

### 分层描述统计

以下均为发送完成后的 TTFB，不掺入首请求 TLS；每格只有两个不同正文样本。

| 包形状 | auto 均值 ms | en 均值 ms | en − auto 均值 ms | 样本数 |
| --- | ---: | ---: | ---: | --- |
| 2 个长项 | 2,334.0 | 2,412.7 | +78.7 | 各 2 |
| 9 个短项 | 1,725.0 | 1,719.5 | −5.4 | 各 2 |

四个相邻试验编组的 en − auto 描述差分别为 **+92.1、+65.3、+1.7、−12.5 ms**。它们不是相同原文的配对差，不能做成“加 hint 慢／快多少”的因果估计；本轮也没有足够样本支持显著性或尾延迟保证。可以成立的产品判断是：**没有观察到一致、足以承担额外语言决策与误判风险的收益。**

按项数合并，2 长项组 TTFB 为 **2,228.1–2,505.1 ms**，均值 **2,373.3 ms**；9 短项组为 **1,657.5–1,792.5 ms**，均值 **1,722.2 ms**。两组总字符接近，但原文不同，长项组全部先测，内容难度、内部拆句、输出长度、上游缓存和服务状态混杂。**不能由约 651 ms 均值差推导“拆句必然提速”或全文速度倍率。** 这也未验证第 20 包 429 的原因、并发吞吐或服务额度。

## 实际出现了哪些响应字段

八次响应顶层已观察字段只有 `translations`；顶层 `responseLanguages` 均为空。全部 44 个翻译项观察到：

```text
detected_source_language
text
is_language_detection_confident
```

44 个 `detected_source_language` 的实际值均为小写 `en`，既包含 auto 请求，也包含显式 en 请求。**这只说明服务在这些英文输入中返回了这个字段和值，不能证明显式 source_lang 跳过了内部识别或节省了某个处理阶段。**

`is_language_detection_confident` 仅保留字段名，未保留字段值，因此本记录不能宣称 44 项该布尔值都为 true，也不能将它与浏览器原生检测的 `isReliable`／`percentage` 混为一谈。

## 浏览器原生语言检测的覆盖与限制

本地检测脚本（本机历史文件 `.output/deepl-speed-v5/inspect-native-language.mjs`，未随仓库归档） 在扩展页串行调用 `chrome.i18n.detectLanguage`。raw 中 `reliable` 是 `isReliable === true` 的映射；每个返回语言保留 `language`、`percentage`，最多三项。`totalMs: 65` 覆盖这次 257 次调用和循环本身；结果回报到本机 127.0.0.1，`translationRequests: 0`。它不是 DeepL 请求耗时，也不是已验证的每台设备冷启动性能保证。

| Go 原文检测 | 项数 | 字符 | 说明 |
| --- | ---: | ---: | --- |
| `reliable: true` 且首语言 `en` | 171 | 52,027 | 占 68.13% 段数、97.24% 字符 |
| 其余 | 80 | 1,478 | 全部 `reliable: false`，长度 5–47 字符 |
| 合计 | 251 | 53,505 | 每项长度已与固定源逐项核对 |

80 个不可靠短项中，40 项首语言仍为 en，其余出现 ceb、zh、fil、fr 等；1 项没有语言结果。**79 项的首语言 `percentage` 为 100，却仍被 API 标记为不可靠。** 例如 “Rob Pike” 得 ceb／100、不可靠；“Google, Inc.” 得 zh／100、不可靠。不能把比例数值 100 直接当作判定正确的概率 100%。

六个额外控制样本：

| 样本 | 字符 | 首语言／percentage | reliable |
| --- | ---: | --- | --- |
| 明确英文段落 | 118 | en／100 | true |
| 明确德文段落 | 112 | de／100 | true |
| 明确法文段落 | 128 | fr／100 | true |
| 明确西班牙文段落 | 117 | es／100 | true |
| 含英文和德文的混合段落 | 126 | de／100 | true |
| “Gift” | 4 | no／100 | false |

混合段落有明确英文句子，却被汇总成 de／100、reliable true。这是单个反例，不是混合语言准确率测评，但足以说明：**percentage 不能当作“全文纯单语或识别正确的置信概率”；即便 reliable true，也不保证整个输入只含该语言。** 本轮没有给 CLD 做概率校准，也没有测量混合页、代码密集页和更多短标题的误提示率。

Go 是已知英文文章，不能凭它的可靠英文覆盖率就将未知网站整页写死成 `source_lang: en`，或将一包内的其它未可靠短项一并继承为英文。原生检测耗时低，并不能弥补本轮缺乏提速收益与混合语言边界证据的问题；生产继续保留自动源语言。

## 后续同原文配对：已完成

后续已完成 **8 个真实请求、全部 HTTP200** 的同文配对：仅一对发送后 TTFB 明显改善、其余三对近似，并有局部未译／限定变化，未采用生产拆句。详见[配对语义与时延分析](deepl-v5-sentence-parts-analysis.md)及[第五轮完整报告](../reports/DEEPL_PERFORMANCE_V5_2026-10-22.md)；本页前面的 2 项／9 项结果仍不是同文配对，不能替代后续证据。

最低验收条件是：四份固定原文分别各测两种表示；每对原文字符串保持完全相同，拆分后 `parts.join('') === original`，预算仍按合计 UTF-16 长度计算且不超过 1,500；不删除空白、标点，不加入标记。保持端点、目标语言、source hint、请求头、身份与请求间隔不变，交叉原样／分项顺序，并单独披露 TLS。记录原文 SHA、分项 SHA、项数、字符、HTTP、逐项有效映射和网络时序；同原文重复可能命中上游缓存，也仍须披露。

若这种配对支持拆句收益，还需另验取消、索引顺序、句间空白、短句上下文损失和实际全文吞吐；8 个串行资格请求本身不能替代 251 段整页完成。遇到第一个非 200／429 就停止，不自动重试、补样或清冷却。本轮没有为测试扩大匿名输入预算，没有加入生产 CLD 或 source hint。
