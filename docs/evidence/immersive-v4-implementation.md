# 沉浸式实际匿名 DeepL 实现复核（2026-10-22）

本文件名中的 v4 是本轮性能调查标识，**不是沉浸式产品版本**。本轮只读取已保存的官方分发产物、配置与代码；未安装/执行沉浸式、未发送翻译请求、未读取账号 Cookie/Key、未修改近译生产代码。结论是静态观察，不证明某个安装环境实际启用了对应服务，也不声明这些快照是所有渠道当前最新版本。

结论：两个固定产物内的匿名适配器 `d` 仍使用旧 `www2.deepl.com/jsonrpc`，采用小数组、800 字符总预算和 1050ms 启动预约。未发现可直接用于近译当前匿名 OneShot 路线的新端点、低延迟参数、整篇合并协议或特殊“第32次429”解释。普通 UI 中的 `deepl` 会员/自填 Key 路径不能计作匿名性能证据。

## 产物身份和证据边界

| 产物 | 本地路径 | 身份摘要 |
| --- | --- | --- |
| Google 官方更新接口取得的 Chrome 包 | `.output/diagnosis-2/immersive/store.crx` | v1.34.2 / MV3；13,741,903 bytes；SHA256 `74f185565516c24840c7ea0c07ff17f5d580e74c0d840b1230abdeb4db0a642f` |
| 上述包的背景脚本 | `store-unpacked/background.js` | 1,672,497 bytes；SHA256 `92d37ab9cb3e3178b89571fa74c5dc9743e06b67025cbc0c731a4b049bcefe21` |
| 上述包的内容脚本 | `store-unpacked/content_main.js` | 4,274,220 bytes；SHA256 `10f6ec883d76f38ae269d297a20b44551a88894fbc168a06db0c07065e0777a6` |
| 官方仓库固定提交的背景脚本 | `background.609114bcb337ecb968498bc1b917d55679f39e24.js` | 产物自报 v1.34.3；SHA256 `cb55242525931b606ff5db03091578848c826cff5d5419a1ecb01c8f3a3f1d7e` |
| 同提交完整 userscript | `immersive-translate.609114bcb337ecb968498bc1b917d55679f39e24.user.js` | 5,588,642 bytes；SHA256 `e5361a8e2e0d3bd3b2ff2d9a8b286caa97205927d339beceb13a3c69dc65db2d` |

除表中第一个路径外，其余路径均相对 `.output/diagnosis-2/immersive/`。本轮重新计算上述四个 JS 的摘要，与已保存身份记录一致。原获取时间为 2026-10-21；来源说明见该目录 `store-identity.json`、`artifacts.json`。

主来源：[官方安装页](https://immersivetranslate.com/zh-Hans/docs/installation/)、[官方 Chrome 商店条目](https://chromewebstore.google.com/detail/immersive-translate/bpoadfkcbjbfhfodiogcnhhhpibjhbnh)、[固定提交](https://github.com/immersive-translate/immersive-translate/tree/609114bcb337ecb968498bc1b917d55679f39e24)。实际商店包与仓库包分别核验，不能用后者的行号冒充前者的代码身份；本轮未额外验证 CRX 签名。

REA 按所读 reverse-engineer-anything 技能（本机技能路径已脱敏：`C:/Users/<user>/.agents/skills/reverse-engineer-anything/SKILL.md`） 对真实商店包选取 manifest、规则、配置、背景脚本进行惰性静态分析。保留 Evidence `ev_1df1d663a9b4e0683efff7130f041e26ade04ee63576ecada6590fca2006a05c`，摘要视图 `ev_5d6435f3240acf8c4f67df850906a6271d49f6daae6067d20802f8cd8e141838`。背景脚本成功解析，但语义分析在 12 秒上限中止，图不完整，51 个其他文件未进入该次 REA 分析。因此，下列函数关系还用本地 TypeScript parser 将原始 JS 作为文本独立定位、读取；未执行包的 bootstrap。缺失的图关系不能作为“功能不存在”证据。

## 服务与完整发送链

商店背景 `background.js` 的精确锚点如下。offset 是 **0-based JS UTF-16 单元**，line 是 1-based 原始行号；格式化片段并非上游未压缩源码。

| 位置 | 静态观察 |
| --- | --- |
| offset `86289`，L21，`deepl` 服务元信息 | 普通 DeepL 的 providers 为 `pro`、`custom`；custom 的 `authKey` 为 required/password/sensitive。不能把此路径作为无 Key 匿名实现。 |
| offset `107163` 附近，L21，`d/dpro` | `canary:true`；实际 `default_config.json` 为 `canary:false`、默认服务为 `bing`。`d` 无批量/窗口覆写；`dpro.apiUrl` 为 `https://api.deepl.com/jsonrpc`。隐藏配置/覆盖仍可能启用，不能断言彻底废弃。 |
| offset `1531671` 附近，类注册 | `d:wu,dpro:wu`；普通 `deepl:ku` 是另一个类。 |
| offset `1320190`，L878，`vy` | 匿名默认 URL：`https://www2.deepl.com/jsonrpc`。 |
| offset `1322641`，L878，`wu` | 最大数组项 3，最大单项及组累计预算默认 800；`getDefaultRateLimit()` 返回 `{limit:1,interval:1050}`。 |
| offset `1321555`，L878，`RZ` | `LMT_handle_texts`、`splitting:'newlines'`。 |
| offset `1321756`，L878，`_Z` | 输入数组每个成员分别构造 `{text,requestAlternatives:3}`；没有先拼成单个 raw。返回逐项读取 `result.texts[].text`。请求设置 `retry:2`。 |
| offset `1077297`，L142，`Nm` | 按服务 key 维护预约 ticks；若下一 tick 未到，返回延迟。它控制启动时间，不是完成后再等待。ticks 可写入本地存储；不是服务端配额声明。 |
| offset `788002` / `788528`，L53，`Dl/rC` | 通用重试包装及原生 fetch。非成功 HTTP 读取错误文本，保留 HTTP status；业务码只检查顶层 `payload.code`。 |

实际商店内容脚本也有独立对应实现：`content_main.js:5899`、offset `1627349` 的 `th` 同为 3/800/1次1050ms；`1625913/1626115` 的 `DBe/LBe` 同样逐项组装旧 RPC。

仓库 v1.34.3 的对应主来源是 [userscript L6269](https://github.com/immersive-translate/immersive-translate/blob/609114bcb337ecb968498bc1b917d55679f39e24/dist/userscript/immersive-translate.user.js#L6269)、[背景启动预约 L143](https://github.com/immersive-translate/immersive-translate/blob/609114bcb337ecb968498bc1b917d55679f39e24/dist/chrome/background.js#L143)。两个版本的关键策略分别读取确认，变量名不同。

## 分片、调度、缓存及首屏口径

- `content_main.js` offset `1348624` / L5634 的 `INe` 按换行拆临时文本项，保存原 index、partIndex、prefix/suffix；长行再拆分。短于预算的多句行不会强制一自然句一项。自然句数量、数组项数、HTTP 请求数不能混称。
- 同文件 offset `1347623` / L5634 的 `Q$` 按语言方向归组，以累计 `.text.length` 和数组项数同时限组。匿名默认预算来自 `th`，不是普通 DeepL 配置中的 1800/50。
- offset `1595618` / L5890 的 `iBe` 每批先 `await zm(...)` 取得背景 `getDelay`，再等待该延迟，随后才启动该批并放入 promises；末尾 `Promise.allSettled` 不表示无限制立即发送。
- offset `1599729` / L5890 的 `hBe` 使用 `getConcurrencyLimit()`，通过背景 `acquirePermit/releasePermit` 包围实际请求。基类 `Bt` 的默认许可上限为 200，可被配置改写，但匿名路径依旧受 1050ms 启动预约约束；200 不能解释成安全 QPS 或已实测在途数。
- offset `1600764` / L5890 的 `yBe` 有按 fingerprint 合并/缓存请求的分支；`fBe` 又把它限制为没有 signal、非 forceSingle 操作的条件。此处不证明跨标签持久译文缓存。无论如何，缓存/重复合并收益不能计入“251项唯一原文、新标签无译文缓存”的目标。
- 实际默认配置为 `translationStartMode:'dynamic'`、`immediateTranslationTextCount:4999`、`immediateTranslationScrollLimitScreens:1`。它支持优先首屏与动态翻译，但不能据普通浏览体验推断 53,505 字符已全部完成。普通 `deepl` 另有 `immediateTranslationTextCountForImmersiveDeepl:50000`，这不属于已确认的匿名 d 路线。

这条匿名默认路径不支持“把251段拼一个raw”的推论。若**条件性地**把同样251个请求项、53,505字符全交给 3/800 默认策略，项数下界84批、字符下界67批；前者会使启动跨度至少87.15秒。实际沉浸式 DOM 采集、过滤和配置可能不同，不能把这个算术下界说成其整页实测结果；它只是说明已观察的匿名默认策略没有藏着一个全文10秒方案。

## 身份、错误与第32次429

实际商店 `request_modifier_rule.json` 的 id2（L35 起）只匹配 www2/jsonrpc、自身 extension initiator/xhr，设置 `Origin/Referer` 为 DeepL 网站、`DNT:1`，并主动删除 Cookie。[固定提交规则](https://github.com/immersive-translate/immersive-translate/blob/609114bcb337ecb968498bc1b917d55679f39e24/dist/chrome/request_modifier_rule.json#L35) 的摘要相同：`fd71548797415abf1a7d4ce529df1086421fcb9b6dab89794f291d5beaddfca7`。

匿名 `_Z` 的请求构造没有网页登录 Cookie、Authorization、设备 ID、session/token、上下文数组。背景 `fo/HU` 给受管沉浸式域名补 credentials 的分支并不匹配普通 www2 域名。这是固定静态路径的事实，不能冒充最终 wire 观察；也不能据此补账号 Cookie、复制网站身份或官方扩展身份到近译当前 OneShot 请求。

通用 `uT` 对超时、部分订阅错误和401停止，但没有专门排除429。匿名请求写 `retry:2`，经 `Dl` 变成 `maxAttempts:2`；这不等于初次请求之外还重试两次。此策略可能增加受限请求数量，不应代替近译当前429立即停止、取消同伴和持久冷却的行为。

在重新读取的四个完整主 JS 中，`1042911`、`LMT_handle_jobs`、`LMT_split`、`oneshot`、`language_model`、`preconnect` 的字面计数均为0。这个负面搜索只覆盖这四个文件；不覆盖所有远程配置、动态代码或后端。旧 RPC 的1042911与当前 OneShot 的HTTP429也不能当成同一已公开限额。

因此，“第32次”尚不能解释为固定32次额度、32文本限制或某一明确服务器窗口；沉浸式匿名代码没有提供这样的定义。不能把静态 Promise 聚合、DNR 头对象或重试次数当作绕开429的证据。

## 对近译本轮目标的直接约束

本次读取的近译策略仍为32项/合计1500 UTF-16预算、最多8在途、至少100ms启动间隔，以及**每12,000ms最多启动30次**。53,505字符即使完美装填也至少36个POST；因此第31次不可能在首请求12秒内启动。保留这个客户端窗口时，全文低于10秒在数学上不成立；这不是上游公布的限制，也不能由预连接或DOM优化消除。

可取的设计是独立管理服务级启动预约、真实在途许可、逐项映射及首屏调度；这些近译现已具备。未找到仍缺失、且在同样匿名/完整范围/无缓存条件下有证据能带来剩余约5秒收益的机制。改变自身窗口只会改变候选，不能证明上游允许；应由统一的真实资格和全文验收决定，429后不自动重试或改换身份。

本轮连接准备已由主线程实测：扩展页 preconnect 可把 TLS 等待前移但总耗时没有明显下降；公开内容页 hint 未给 SW 复用；HEAD401、OPTIONS405 未接生产。本文件不把拒绝响应当部署优化，也没有发起额外实验。主线程报告的两轮窗口策略全文14.936/14.781秒仍未达到10秒，不能通过更换计时起点、只算首屏、遗漏后续段或命中缓存宣称达标。
