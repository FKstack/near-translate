# DeepL 匿名预算与整页调用链核验（2026-10-22）

本轮结论：固定官方扩展中的匿名 1,500 字符检查也覆盖本文追踪到的整页 OneShot 调用链。`Fk` 确实有 integration 条件，但整页入口没有通过该条件排除检查。`Cx` 的 24,576 字节 / 100 项是后续分组策略，不能作为匿名请求可以扩大预算的依据。

本轮仅公开下载、哈希校验、官方帮助页查询及惰性静态解析；未执行第三方扩展、读取用户 Cookie / token 或发送真实翻译请求。下述结论是产物中可见的客户端行为，不是 DeepL 对第三方匿名服务的公开支持合同，也没有证明服务端各路径具有统一硬上限。

## 固定来源与复核方式

DeepL [官方 Firefox 产品页](https://www.deepl.com/en/firefox-extension)链接到 [Mozilla 的 DeepL 扩展页面](https://addons.mozilla.org/en-US/firefox/addon/deepl-translate/)。本轮复核沿用前次锁定的官方版本，未把版本号相同视为跨浏览器二进制相同。

| 项目 | 固定值 |
| --- | --- |
| 版本 | `1.104.2`，MV3，Gecko id `firefox-extension@deepl.com` |
| 官方商店元数据 | <https://addons.mozilla.org/api/v5/addons/addon/deepl-translate/>；addon `2804910` / version `6594007` / file `5138135` |
| 版本创建时间 | `2026-10-19T07:12:09Z`；动态 API 后续可能指向其他版本 |
| 固定 XPI | <https://addons.mozilla.org/firefox/downloads/file/5138135/deepl_translate-1.104.2.xpi> |
| XPI 字节数 / SHA256 | `6,273,772` / `50a5de57865c38ecd9057edb0aec5bb3379ad02c6bef3197fdae0038ddd42c16` |
| `background.js` 大小 | `1,450,026` UTF-8 字节 / `1,450,010` JS UTF-16 单元 |
| `background.js` SHA256 | `c6a4f06b0ca65f601737315c5f662218b60eba4a712d76ec4864f9287f3c08e8` |
| 本地研究副本 | `.output/deepl-v3-research/official-1.104.2.xpi`、同目录 `background.js`、`manifest.json` |

身份依据为官网链接、官方商店分发和文件哈希；本轮未另做 XPI 签名密码学验证，也未取得同版本 Chrome CRX。不要将本文件表述为当前 Chrome 商店产物的完整运行审计。

下表位置均为固定 `background.js` 的 **0-based JS UTF-16 字符 offset**，不是 UTF-8 字节偏移或格式化后行号。可使用 TypeScript AST 将具名定义打印为可读片段，按原始 offset 复核；不得执行目标 bundle。研究副本的 `static-excerpts/` 内保留本轮抽取结果及原始位置清单。REA 静态解析记录为 `ev_33f0e03273f717affdcf033fe037a7243098f5c379b5670281999043b3c8da98`；它只解析所选 manifest / background，语义图有裁剪，不能以未出现的关系证明不存在其他路径。

## 匿名 1,500 的确切适用条件

| offset / 定义 | 可核验事实 |
| --- | --- |
| `9772`，`V` | 翻译预算常量为匿名 `1500`、登录免费 `5000`。附近另有 Write 的 `2000` 常量，不能混用。 |
| `14486`，`Un` | 值为 `DEFAULT`。 |
| `14541`，`$n` | 值为 `GMAIL`。 |
| `14552`，`Fn` | 值为 `GSLIDES`。 |
| `367046`，`gE`；`590561`，`jC` | 按登录状态与对应服务类型判断该服务的 Pro 状态；并非仅检查扩展是否安装。 |
| `590073`，`$C` | 根据账户与对应服务状态区分匿名、免费、Pro。 |
| `590227`，`FC` | Translator 读取 `V`，Write 读取自己的预算表；匿名分支返回该表 `notLoggedIn`。 |
| `627112`，`Fk` | integration 为 `DEFAULT` / `GMAIL` / `GSLIDES` 或缺省时，且 Translator / Write 并非同时 Pro，才进入后续字符检查。 |

`Fk` 先对所有 `sourceTexts` 的 JavaScript `.length` 求和，再取得本次服务的预算。匿名 Translator 状态下，总和超过预算便抛出 `Char limit exceeded (Translator Anon)`；免费账户与 Write 有各自错误分支。这里计数是 UTF-16 单元：补充平面字符通常计为两个单元，不能改称 UTF-8 字节或 Unicode 码点。

因此，这项检查的含义是**一次逻辑处理输入的合计预算**，并非给数组中每项分别提供 1,500。实际走到分组路径时，检查发生在分组前；不能通过增加 `text[]` 项数把匿名预算乘大。服务端是否还按时间、总工作量、账户、连接或其他因素限流，本检查不回答。

## 整页路径没有通过 integration 跳过检查

本次追踪到的整页请求路径如下，函数名以固定产物为准：

```text
Dx(payload.texts, payload.isFullPageTranslation)
  -> xx({ sourceTexts, isFullPageTranslation, ... })
  -> kx(sourceTexts) 选择 Ox 或 Nx
  -> Ox = Rx(input, Lx) / Nx = Rx(input, Cx)
  -> Rx: fb -> Fk(input) -> sx -> wx -> Lx/Cx -> Px -> rx
```

| offset / 定义 | 对适用范围的意义 |
| --- | --- |
| `641936`，`Dx` | 接收 `payload.texts` 与 `isFullPageTranslation`，把两者传入 `xx`。 |
| `641534`，`xx` | 接收该布尔值，但它只用于选择 `usageType`；传入 Ox / Nx 的对象中没有 `nicheIntegration`。 |
| `16484`，`Ao` | 整页对应 `usage_type` 值 `FullPageTranslation`。这个字段不是授权凭证。 |
| `638880` / `638895`，`Ox` / `Nx` | 两条处理路径均先进入同一个 `Rx`，只替换末端请求处理函数。 |
| `639262`，`Rx` | 明确先等待 `Fk(e)`，然后才构造与分组 / 发送请求。 |

由此可以核实：经本文所列 `Dx -> xx` 路径进入的整页输入，`Fk` 看到的 `nicheIntegration` 为缺省，满足其 integration 检查条件。不能将该条件解释成“BrowserExtension wholepage 自动豁免匿名 1,500”。本轮没有穷尽所有动态调用者，也不把公开导出的低层函数视为匿名产品入口或权限许可。

官方当前[浏览器扩展翻译帮助页的 Translate full pages 部分](https://support.deepl.com/hc/en-us/articles/4407580229522-Translate-with-the-browser-extensions)明确要求 DeepL Pro，并要求通过扩展登录。该帮助页于 2026-10-22 访问，没有据此推断最后更新时间。Pro 用户能进入的整页能力不能作为近译匿名请求扩大预算的证明；设置 `usage_type` 或复制官方 `app_information` 也不产生该授权。本轮不采用这些字段借用产品身份。

## Cx 的分组门槛与预算不是匿名升级证据

| offset / 定义 | 实际逻辑 |
| --- | --- |
| `641471`，`kx` | 输入项数大于 `100` 时选择 `Nx`；否则只有第二个谓词参数返回 true 才选择 `Nx`；该谓词缺省恒为 false，其余情况选 `Ox`。 |
| `641534`，`xx` 调用处 | 调用 `kx(e)`，没有传额外谓词。因此本文路径不是见到 24 KiB 就自动分组。 |
| `641106`，`Cx` | 使用 `FL(texts, 24576, JSON.stringify, 100)` 分组，单组调用 `Px`，多组通过 `Promise.all` 发送并按组序展平结果。 |
| `579714`，`FL` | 累计每项序列化字符串的 TextEncoder 字节数，或者达到项数条件时切组；它不把过大的单项继续拆开。 |
| `641337`，`Px` | 调用 OneShot 并读取顶层 `translations`。 |
| `640013`，`wx` | 请求体中的 `text` 直接来自 `sourceTexts`，没有先拼接标签、HTML 或双换行。 |

24,576 是这些序列化项的累计字节预算，不包含完整外层 JSON 的所有字段与分隔开销；100 是该客户端分组器的项数策略。两者都没有在这里声明为服务端所有账号的请求上限。`Cx` 的 `Promise.all` 只能证明该处可能并行发组，不能推出官方匿名允许固定并发数、固定 QPS 或任意全文吞吐。

该链顺序是先检查匿名逻辑总长度，再按需分组发送。因此不能以“公开产物含 24 KiB / 100 项”或“扩大请求偶然 HTTP200”直接修改近译当前匿名 1,500 预算。此前宽泛每项 `300000` 的检查同样不能替代此匿名分支。

## 当前产品策略与证据边界

- 近译保留 `1,500` UTF-16 单元合计预算；`32` 项、请求体 `64 KiB`、响应 `1,000,000` 字节则由本项目独立制定，不冒称全部来自官方匿名合同。
- `8` 个在途、至少 `100 ms` 启动间隔及滚动 `30` 次启动 / `12,000 ms` 是本地实验保护策略。30 / 12 不是官方公布额度；此前第 32 请求出现 429 也不能证明固定服务端窗口、唯一触发原因或封禁期限。
- 对当前 `53,505` 字符全文，1,500 容量下界为 `36` 包，现有实际批次为 `38`。本地 30 / 12 策略使第 31 包最早也只能在第 12 秒启动，因此该候选本身无法满足全文低于 10 秒；它首先验证稳定性与资源保护，不能报告成已实现速度目标。
- 固定产物 `rx`（`630469`）按 HTTP 状态处理错误，并没有公开精确的 OneShot 429 窗口；未在本文据旧 JSON-RPC 的 `1042911` 推导新接口额度。详情见[前次官方 OneShot 静态证据](deepl-official-oneshot-2026-10-22.md)。
- 本轮没有新增真实翻译测试，没有扩大匿名正文预算，没有采用 Cookie / Key / 官方身份，也没有尝试通过代理、区域轮换或清除冷却绕过限流。生产性能是否达标应由另行保存的真实新标签测试说明，本静态文档不替代该验收。
