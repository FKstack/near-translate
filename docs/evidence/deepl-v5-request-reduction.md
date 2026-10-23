# DeepL 第五轮：匿名请求缩减与尾部装包的离线核验

核验日及修订日：2026-10-22。范围是近译源码、已归档官方 DeepL / OJBetter 产物、公开 Go 长文与已完成的真实记录。协议调研阶段只查询公开文档、惰性读取源码和运行离线计算；随后另获授权，已实施本页记录的尾部装包与内容无关指标。**本研究代理没有发送翻译请求、访问账号 / Cookie / Key或重放失败请求。** 实际服务实验由主线程独立执行，本次修订只读其已保存记录。完整验收与最终部署以 [V5主报告](../reports/DEEPL_PERFORMANCE_V5_2026-10-22.md)及 [V5数字证据](deepl-speed-v5-go-2026-10-22.json)为准。

结论：现有证据没有提供可直接用于匿名 OneShot、同时保留严格段落映射的大包 / 压缩 / 标签 / 流式捷径。小范围尾部填充现已落地，先通过真实session代码的 **38 → 37 包离线样例**，随后恢复30/12窗口后的首轮真实全文以 **37次200 / 251段 / 14.295秒**完成。但相同程序的新标签复测在第21个POST返回429，仅完成118段，**不能称为稳定成功或限流已解决**。少一包只有2.63%的请求数改善；两次V4成功记录的敏感性计算仍只是346ms / 0ms，不承诺全文10秒。

## 1. 本轮依据与不能混用的边界

- 源：`.output/deepl-speed/go-page-input.json`，251项、251个唯一原文、53,505个 UTF-16 单元，最大完整段落1,115单元。SHA256：`5c65015c55c525083d8cbf0047f66f6d83310abc59f49d74fcb8d4ecf8898407`。
- 当前入口：[`src/page/session.ts:235`](../../src/page/session.ts#L235) 的 `takeBatch()` 先按可见正文 / 距离排列候选，每四包使用最早等待组；首包另用软预算。通常按原候选顺序填充，已实施的小尾部例外见第4节。V4实际成功首包为原文ID24、137单元。[`src/providers/deepl-web.ts:283`](../../src/providers/deepl-web.ts#L283) 原样发送数组，整批数量 / 非空校验后才映射结果。
- 源码 [`translation-policy.ts`](../../src/shared/translation-policy.ts) 的预算仍为每包合计1,500单元、最多32项、64KiB序列化保护。**源码与实际安装最终均恢复8在途 / 100ms / 30启动每12秒，保留本轮尾部与指标改动。** 曾经无窗口8/100及30/10两候选都已运行并因429失败，不能再写成“未运行”或当前已部署配置。该窗口是本地保护，不是官方额度或无429保证；[最终部署证据](deepl-speed-v5-deployment-2026-10-22.json)记录同一安装程序的摘要。
- 历史V4成功 raw：`.output/go-page-deepl-v4-prepared-stable-b09df21c77bf928d791e9285bea1470c2887516e.json`、`.output/go-page-deepl-v4-prepared-confirm-842229641bb638fb1c2226a07cacb7ffff72c4d6.json`。各38次POST200 / 251项 / 53,505单元，另各1次OPTIONS204；全文14,748.8 / 14,931.1ms。汇总及raw摘要见 [V4证据](deepl-speed-v4-go-2026-10-22.json)。这些历史轮用于下文尾部时序核算，不充当V5复测成功。
- 官方 Firefox 扩展1.104.2：固定 [XPI](https://addons.mozilla.org/firefox/downloads/file/5138135/deepl_translate-1.104.2.xpi) SHA256 `50a5de57865c38ecd9057edb0aec5bb3379ad02c6bef3197fdae0038ddd42c16`；所读 `background.js` SHA256 `c6a4f06b0ca65f601737315c5f662218b60eba4a712d76ec4864f9287f3c08e8`。下文 offset 均为该JS零基UTF-16位置，不是字节或格式化行号。

`Fk@627112` 在适用 integration 下合计全部 `sourceTexts.length`；匿名服务取1,500。`Rx → Fk → wx → xx` 的已核验调用链不能通过后面的 `Cx@641106`（24,576序列化字节 / 100项）绕过。官方[浏览器整页功能要求Pro](https://support.deepl.com/hc/en-us/articles/4407580229522-Translate-with-the-browser-extensions)，不能借其授权路径扩大匿名能力。**1,500是已证实的官方客户端预算，不是本轮测得的服务器1501拒绝硬界。** 完整证据见 [预算调用链](deepl-anonymous-budget-v3-2026-10-22.md)。

按当前预算，纯字数下界为 `ceil(53505/1500)=36`；保留137单元独立首包后为 `1+ceil((53505-137)/1500)=37`。因此，满足现有首包要求时，37已经达到字数下界；不扩大预算就不存在30包或32包的完整方案。

## 2. 协议层候选：哪些有证据，哪些没有

| 候选 | 可复核事实 | 对当前匿名生产的判断 |
| --- | --- | --- |
| 请求体gzip / Brotli | 官方 `rx@630469` 直接 `JSON.stringify(e)`、JSON Content-Type、POST、200后`.json()`。本轮AST重新定位其定义区间为`[630469,631556)`。该路径未构造压缩体或Content-Encoding。 | 没有已验证的OneShot请求压缩协定。压缩字节也不会减少`Fk`统计的解压后原文长度或语义工作量；不能以压缩为由放进更多原文。 |
| bundle里的gzip命中 | `_tryToCompressBody@[420973,422162)` 检查Statsig的`enable_log_event_compression`、`logEventCompressionMode`、`isCompressable`，通过`IsGzipped`参数标记。 | 这是Statsig请求压缩代码，不能把同包存在`CompressionStream("gzip")`当成翻译端点支持gzip的证明。 |
| 多text减少 / 拼成一个raw | `wx@[640013,641043)` 直接使用 `text:e.sourceTexts`。当前JSON数组在每个响应位置保留对应源段；没有每段独立ID字段。 | 多text可能影响内部工作量，但现有证据没有测出成本函数。拼raw不减少源字符，双换行还增加预算；返回段数相等不能排除合段与拆段相互抵消。不能以可能更快替代映射可靠性。 |
| HTML / XML与段落ID | 本轮重读[官方XML文档](https://developers.deepl.com/docs/translate/translating-xml)和[HTML文档](https://developers.deepl.com/docs/translate/translating-html)：格式保留依赖显式`tag_handling`；示例是带API Key的`api.deepl.com/v2/translate`。 | 这是有授权REST API的能力。OneShot的已核验`wx`字段没有`tag_handling`、`tag_handling_version`、`split_sentences`或`preserve_formatting`，不能移植后宣称受支持；把HTML当普通文字也不是结构协议。 |
| SSE / 流式JSON | `rx`消费完整JSON；没有该路径的SSE事件格式或增量翻译序号。成功轮正文响应下载中位数仅约0.8ms，主要等待发生在响应前。 | 流式本地解析不能让上游提前产生译文；不为数毫秒下载改写复杂解析器，更不能声称降低TTFB。 |
| 低延迟模型 / context | [REST翻译文档](https://developers.deepl.com/api-reference/translate/request-translation)公开`model_type`等参数，且明确要求API Key。OneShot `wx`有条件使用`language_model:'next-gen'`，没有已证实的匿名低延迟字段。 | 没有可直接采用的匿名低延迟参数。不能假定REST和OneShot同名 / 相似字段可互换，也不能用context传正文而期待它被翻译。 |

没有在该固定包中找到`tag_handling`、`split_sentences`、`preserve_formatting`、`latency_optimized`、`text/event-stream`字面值；这是本次搜索范围内的负面结果，不证明未来服务端永远没有这些能力。当前最小body已经是 `{text:string[],target_lang:'zh-Hans'}`，无备选译文参数可继续降低。

此次按 REA技能（本机技能路径已脱敏：`C:/Users/<user>/.agents/skills/reverse-engineer-anything/SKILL.md`）尝试复用旧静态Evidence，但它已不在当前会话；新解析保留 `ev_126f4fe50a35a37cfcb2e049dc59b2bfe309097a89e92006dfa699c836354972`，摘要视图 `ev_7eb44955e478942e90141b0053e366b66180f87413e6cf5be26128e915850d77`。`background.js`语义分析在18秒期限中止，图不完整。因此上述窄范围函数及gzip归属另以TypeScript AST和原始片段复核，未执行bundle，不以图中缺失证明不存在功能。

### 压缩和减少数组包装实际能省多少

离线用同一份251项原文序列化原38包候选，共55,623 UTF-8字节；按最终“一包可放下则不排序”guard构造37包为55,589字节，只少**34字节**JSON固定包装。源总量与251个数组项没有减少。逐包gzip的离线样本为29,397 / 29,327字节，均不是实际网络请求或端点支持测试。早期尚无该guard的37包构造为29,320字节，不能与最终数组顺序混用。

即使服务支持gzip，约26KiB的上传字节差也没有被证明是目前14.7秒关键路径；本地已有响应等待中位数约1.9秒而下载中位数0.8ms。不能将传输压缩比例等同于推理延迟比例，或据此计划绕过逻辑输入预算。

## 3. 旧OJBetter大包失败没有显现可修复的协议字段错误

固定 OJBetter 提交 `860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46`，脚本SHA256 `ac54e910d52ff40df1e9f25173a79cb2046eb4b9a1849bc1dcf5b6e07d79aa26`。匿名函数 [L15911](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/atcoder-better.user.js#L15911) 为旧RPC单raw、`splitting:newlines`、`auto`、alts3；[L16055](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/atcoder-better.user.js#L16055)计算timestamp。原版完整TM记录 `.output/diagnosis-2/ojbetter-go-full-2026-10-21T15-44-07-681Z.json` 本轮重读得到：

| 项 | 原始记录 |
| --- | --- |
| 覆盖 | 251原段 / 53,505源单元；Markdown raw为54,049单元 |
| wire请求体 | 54,896字节，与Content-Length完全相同 |
| JSON-RPC | `2.0`，`LMT_handle_texts`，ID`197149000`，1个text，alts3，auto→ZH |
| timestamp | raw有3,049个小写i；`1792597477900 % 3050 === 0`，与原函数修正规则一致 |
| method空格 | 与该ID的原脚本分支一致 |
| 响应 | HTTP413，106字节HTML，明确Payload Too Large；不是RPC字段校验错误对象 |

这能排除“我们用简化body或错误timestamp复现，导致这份大包失败”的说法，**不能证明服务器具体大小阈值、处理阶段，或所有其它协议字段都已获服务端接受**。原脚本通用重试还留下两个已取消的重复尝试，不能把它们写成两个额外成功请求。

OJBetter另有 `tag_handling:'html'`，但位于 [API Free函数L15969](https://github.com/beijixiaohu/OJBetter/blob/860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46/script/release/atcoder-better.user.js#L15969) / API Pro分支，地址是`/v2/translate`，并发送`DeepL-Auth-Key`。名字中的Free指API方案，不能误读为默认无Key匿名RPC拥有HTML保留能力。其数字占位符策略仍依赖翻译服务原样保留标记；此前近译的字母标记实测已发生变形，不能将占位符作为OneShot结构保证。

本轮不以复制官方Origin / 设备身份、切换到旧路径自动回退、重放更大raw、变换编码规避拒绝来减少请求。有关旧RPC、小包成功和标记失败的边界见 [V4协议复核](deepl-v4-protocol-research.md)。

## 4. 最小可扩展改动：仅优化未发送的小尾部

**已在`src/page/session.ts`的现有`fill`策略内实施有界尾部填充**，没有增加helper、调度器、全页BFD计划、跨标签装包或长期规划状态：

1. `takeBatch()`照旧剔除失效DOM、排序候选，保留首包规则。正在加载 / 已完成 / 已失败的part不参与。
2. 仅在queued候选组不超过16、**每组总共只有一个part且该part为queued**、没有待处理可见正文、不是可见正文软首包时考虑尾部优化。16是本地CPU / 行为范围选择，不是上游限制。多part组即使只剩一片queued也回退，避免改动拆片路径。
3. 还有明确收益guard：**全部候选连同`separator × (n-1)`的长度大于本包容量，或者候选项数大于项数上限，才允许重排**。全部能一次放下时保留原数组顺序；没有为了零请求数收益改变短文payload。
4. **第一个anchor仍是原候选顺序首项**。所以每四包最早等待组的公平规则继续成立；其余候选按长度降序、原候选序作稳定平局填充，跳过放不下的项。
5. 沿原有装包循环检查容量 / 项数并将选中的part标为loading，构造同一个`Task[]`。wire数组位置仍是`Task[]`索引，不合并正文、不插标记、不改变provider响应契约。

实现核心（对应当前源码；变量名与已有session保持一致）：

```ts
// session.takeBatch(): candidates已按本轮优先级 / FIFO公平规则排序。
if (this.packing === 'fill' && !firstVisibleBatch && candidates.length <= 16
    && candidates.every(group => group.parts.length === 1 && group.parts[0]!.status === 'queued')
    && !candidates.some(group => this.groupPriority(group).visibleProse)
    && (candidates.length > maxItems
      || candidates.reduce((total, group) => total + group.parts[0]!.text.length, 0)
        + Math.max(0, candidates.length - 1) * this.batchSeparatorChars > targetChars)) {
  const fillers = candidates.slice(1).sort((a, b) => b.parts[0]!.text.length - a.parts[0]!.text.length);
  candidates.splice(1, fillers.length, ...fillers);
}
```

session继续拥有DOM、part状态、generation和取消，provider继续拥有协议，`RequestScheduler`继续拥有共享服务资源。这里没有新增配置或依赖，也没有将DOM依赖引入provider。

### 离线结果及身份限制

本轮读取已有 `go-pipeline-v3-offline-audit.json` 的冻结viewport代理计划，保留前33包不变，对15项尾部使用上述方法。**代理计划的前部并不逐包匹配真实raw，历史指标又没有source IDs / body hashes，因此下面是内容完整的离线候选，不是已确认的历史wire尾部重放。** 其最后五包项数 / 字数与两次真实成功的末五包完全一致，这足以定位可验证的小改动，不足以补齐内容身份缺口。

| 现有候选尾包 | 源ID（零基） | 单元 |
| --- | --- | ---: |
| 34 | 217,218,219,220 | 1,486 |
| 35 | 221,222,223 | 1,341 |
| 36 | 224,225,228,235 | 1,212 |
| 37 | 236,237,239 | 1,063 |
| 38 | 241 | 483 |

合计15项 / 5,585单元，容量下界是4包。保留各轮首选anchor后得到：

| 新候选尾包 | 源ID（零基，wire数组索引按此顺序） | 单元 |
| --- | --- | ---: |
| 34 | 217,223,235 | 1,487 |
| 35 | 218,222,241 | 1,414 |
| 36，FIFO公平包 | 219,239,236,224 | 1,467 |
| 37，全部已可一次装下，保留原顺序 | 220,221,225,228,237 | 1,217 |

离线断言通过：全251个源ID各一次、拼接的原文集合逐字保留、总53,505单元、首包仍ID24 / 137、前33包不变、每包≤32项 / 1,500单元 / 64KiB。这里没有新增拆段；应保留长段 / Unicode / 动态追加场景的原路径，不能为了这份Go数据改变通用约束。

可重算核心（仅本地读取，不生成翻译、无fetch）：

```js
const source = JSON.parse(readFileSync('.output/deepl-speed/go-page-input.json')).body;
const old = JSON.parse(readFileSync('.output/diagnosis-2/go-pipeline-v3-offline-audit.json'))
  .plans.frozenViewportProxySoftFillFair4.idsPerBin;
const bins = old.slice(0, 33).map(ids => [...ids]);
let pending = old.slice(33).flat();
while (pending.length) {
  const anchor = pending[0]; // 此离线尾部中，距离 / FIFO首项均按源序。
  const rest = pending.slice(1);
  const total = pending.reduce((n, id) => n + source[id].text.length, 0);
  // 此fixture为separator=0；生产guard还计入separator * (n-1)。
  if (pending.length > 32 || total > 1500)
    rest.sort((a, b) => source[b].text.length - source[a].text.length || a - b);
  const batch = [anchor];
  let chars = source[anchor].text.length;
  for (const id of rest) {
    if (batch.length < 32 && chars + source[id].text.length <= 1500) {
      batch.push(id); chars += source[id].text.length;
    }
  }
  const selected = new Set(batch);
  pending = pending.filter(id => !selected.has(id));
  bins.push(batch);
}
assert.equal(bins.length, 37);
assert.deepEqual(bins.slice(0, 33), old.slice(0, 33));
assert.deepEqual([...bins.flat()].sort((a, b) => a - b), source.map((_, id) => id));
assert.equal(bins.flat().reduce((n, id) => n + source[id].text.length, 0), 53505);
assert(bins.every(ids => ids.length <= 32
  && ids.reduce((n, id) => n + source[id].text.length, 0) <= 1500
  && Buffer.byteLength(JSON.stringify({text: ids.map(id => source[id].text), target_lang: 'zh-Hans'})) <= 65536));
```

这是构造 / 覆盖性验证，没有将原请求的译文挪到新分组上当作新成功结果。

## 5. 真实尾部时序：为什么不能将省一包写成省两秒

下表从两份最终成功raw读取，起止均相对点击；以fetch指标的响应头结束时点比较，未把它等同于DOM回填：

| 请求 | 首轮启动→结束（ms） | 复测启动→结束（ms） |
| --- | ---: | ---: |
| 34 | 12,380.3→14,206.3 | 12,368.1→14,195.1 |
| 35 | 12,482.3→14,396.3 | 12,468.1→14,923.1 |
| 36 | 12,583.3→14,344.3 | 12,569.1→14,224.1 |
| 37 | 12,684.3→14,272.3 | 12,671.1→14,622.1 |
| 38 | 12,785.3→14,742.3 | 12,772.1→14,819.1 |

首轮第38包是最后结束者，比其余请求的最晚结束晚346ms；复测的最后结束者已经是第35包，去掉38不会缩短该记录的结束时点。**仅在其余开始与耗时固定的敏感性计算中**，相应全文值为14,402.8 / 14,931.1ms；这不是新分组预测，因为34–37的正文、项数、服务等待和可能的流控都发生了变化。

未发送尾部压实可以少一次启动 / HTTP包装，稍降低累计工作管理开销，但不会删除任何原文字数，也不会减少服务必须翻译的251个语义项。最终源码及安装保留30/12本地窗口和共享OPTIONS预算；37包依旧跨窗口。后来真实运行的无窗口8/100和30/10候选均在第32请求收到429，不能用局部首屏表现代替全文。恢复30/12后的37包首轮完成，独立复测又在第21请求429，说明该本地保护也未获得稳定性保证。[V5主报告](../reports/DEEPL_PERFORMANCE_V5_2026-10-22.md)列出各轮范围、计时和失败数，本页不把历史敏感性计算当新网络预测。

## 6. 已实施指标、验证与剩余验收

尾部改动风险为 **R1，已有page装包职责内的局部选择策略**：不改变模块依赖、公共事件、数据所有权或资源生命周期，不增加服务请求种类 / 权限。`page-session.test.ts`实际40/40通过，包含251项 / 53,505单元冻结长度与优先级样例的真实session离线37包、各项恰好一次及结果索引映射；软首包、每第四包最早等待anchor、visible正文阻止重排、17项回退、多part及早一片仍loading、Unicode / separator预算、追加与取消不改在途任务。一包刚好604单元（含两个双换行separator）仍保留原顺序；字符可放下但项数超限时仍启用尾部填充。

另外已在 [`deepl-web-transport.ts`](../../src/platform/deepl-web-transport.ts) 的POST数值指标添加可选`maxTextChars`：与`textCount/charCount`共用原有JSON解析和一次数组遍历，取实际字符串项的最大JavaScript `.length`，空数组 / 无法解析shape默认为0；不改变发送body。返回指标副本可独立修改，不影响内部记录。OPTIONS准备行不添加该字段。

[`benchmark-installed-page.mjs`](../../scripts/benchmarks/benchmark-installed-page.mjs)仅保留有限安全整数`0..1500`的`maxTextChars`；旧记录缺失时省略，而不是伪造一个已测0。小数、负数、NaN / Infinity、字符串和越界值均省略，metadata行即使带入该字段也删除。合法值可通过delta、全导航指标和实际证据sink；不记录正文、hash、语言、账号或任意header。transport / benchmark两spec共47/47通过，覆盖UTF-16、malformed shape、克隆及脱敏。类型检查通过；模块边界检查已在初次尾部实现后通过。此次guard与指标没有新增依赖。

`maxTextChars`为检验“最长单项是否影响TTFB”提供实际发出body的数值佐证，**不是已证明的延迟原因，也不记录内部句子数**。主线程后来完成4对同文分句资格，8请求均200，但仅一对明显改善、其余接近，且存在局部译文差异；未将350单元主动拆句接入生产。[分句分析](deepl-v5-sentence-parts-analysis.md)

容量资格现已有结果：**第一包2项合计2,031单元返回HTTP400、有效译文0**，请求身份及输入body核验通过。错误只保存`type/title/status/errors/traceId/text_character_limit`等字段名，没有保存其值，不能补造`text_character_limit=1500`。计划中的2,382 / 3项因第一拒绝而**未发送**；实际只有1POST / 2,031单元。未扩大生产预算，也没有定位1,501–2,030区间的精确阈值。[容量资格证据与边界](deepl-v5-array-capacity-analysis.md)

### 恢复窗口后的一次完整成功与失败复测

两轮均为真实新前台标签、完整251源段、无扩展译文缓存，不运行warm；程序相同，复测没有reload。两次点击相隔94.004秒，约为首轮全文完成后79.709秒，**不是完成后又等94秒**。

| 项 | 恢复窗口后首轮 | 同程序独立复测 |
| --- | ---: | ---: |
| 首个初始可见正文DOM | 1.420秒 | 1.533秒 |
| 初始4段全部完成 | 1.863秒 | 2.247秒 |
| 全文 | 14.295秒，完整成功 | 未完成 |
| 完成 / 失败 / 待处理 | 251 / 0 / 0 | 118 / 7 / 126 |
| 正文POST | 37×200 | 23已发送：15×200、1×429、7次取消 |
| 拒绝包 | 无 | 第21POST，5项 / 1,497单元，最长项539 |
| 额外准备 | 1×OPTIONS204 | 1×OPTIONS204 |

首轮raw为`.output/go-page-deepl-v5-final-stable-424d402010d4a9df04f88beb71433e64f5f84680.json`，SHA256 `d9082e27ec1bed728bb5f21a46d38fa61e117ee62e54a82ca7eecd4dead70b91`；复测raw为`.output/go-page-deepl-v5-final-confirm-ed1e1f0ca1ad34fc9c672e6f772fa461151e5f2a.json`，SHA256 `d02b7220d565079970f1ec45428704581d15260be2d98e15f7ba914f8fd76549`。本修订重新计算两raw摘要，与[V5汇总](deepl-speed-v5-go-2026-10-22.json)一致。复测429约在点击后4.939秒返回，增强诊断只得到通用`rate-limit`，没有还原精确配额或窗口。

两轮点击前POST、迟到 / 完成后额外请求均为0，约2秒终态观察后POST / preparation active均为0。首轮证明这次真实装包确实以37次完成全部251 / 53,505；它不证明离线代理计划的每一source ID分组就是实际wire分组，也不能被当成重复使用稳定性证据。本次生产指标没有加入正文、source ID或body hash。尾部映射继续依赖既有`Task[]`与数组位置，不能把已提交但取消的原文当作完成。

本轮已交付局部尾部选择策略与内容无关数值诊断，并有一次37包完整真实结果；独立复测失败，**不宣称稳定、不宣称限流根因已修复**。全文10秒与稳定完整首屏2秒仍未达，服务内部工作计量与精确限流阈值仍未知。最终验收、测试与部署见 [V5主报告](../reports/DEEPL_PERFORMANCE_V5_2026-10-22.md)。
