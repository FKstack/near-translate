# DeepL 官方扩展 OneShot 静态证据（2026-10-22）

本记录支持近译独立实现的协议选择，不是第三方 API 支持承诺或全文性能结论。本轮仅公开 GET 与内存静态解析，没有执行 DeepL 扩展、读取凭证或发送翻译请求，也未将完整第三方包加入仓库。

## 官方来源与固定产物

DeepL [官方帮助页](https://support.deepl.com/hc/en-us/articles/4407516019218-Get-started-DeepL-browser-extensions)与 [Firefox 产品页](https://www.deepl.com/en/firefox-extension)链接到 [Mozilla 商店中的 DeepL 扩展](https://addons.mozilla.org/en-US/firefox/addon/deepl-translate/)。

| 项目 | 核验值 |
| --- | --- |
| Mozilla 元数据 API | <https://addons.mozilla.org/api/v5/addons/addon/deepl-translate/> |
| 开发者 | DeepL，author id `17965010` |
| addon / version / file id | `2804910` / `6594007` / `5138135` |
| 版本与创建时间 | `1.104.2`；`2026-10-19T07:12:09Z` |
| 固定下载 URL | <https://addons.mozilla.org/firefox/downloads/file/5138135/deepl_translate-1.104.2.xpi> |
| 下载字节数 | `6273772` |
| API SHA256 与实际下载 SHA256 | 一致：`50a5de57865c38ecd9057edb0aec5bb3379ad02c6bef3197fdae0038ddd42c16` |
| manifest | MV3；Gecko id `firefox-extension@deepl.com`；background `background.js` |
| `background.js` | `1450026` UTF-8 bytes；`1450010` UTF-16 单元 |
| 该 JS 的 SHA256 | `c6a4f06b0ca65f601737315c5f662218b60eba4a712d76ec4864f9287f3c08e8` |

身份依据为官网链接及官方商店分发，下载 hash 与 API 一致；未另做 XPI 签名密码学验证。Chrome 商店同日显示 [1.104.2](https://chromewebstore.google.com/detail/deepl-translate-and-write/cofdbpoegempjloogbagkncekinflcnj)，但本次未取得 Chrome CRX，不能称已证明各浏览器产物相同。复核应使用固定文件 URL/hash，动态 API 的 current_version 后续可能变化。

## 关键代码位置

下列位置为固定 `background.js` 的 **0-based JS UTF-16 字符 offset**，不是字节偏移或格式化后的行号。

| offset / 搜索锚点 | 事实 |
| --- | --- |
| 约 `622178`，`case Ok.OneShot` | 模板 `https://oneshot.{cell}.{tier}.deepl.com/v1`；匿名 fallback 为 `https://oneshot-free.www.deepl.com/v1`。 |
| 约 `630415`，`nx` | 翻译追加 `/translate`，写作追加 `/write`。 |
| `630469`，`rx` | POST JSON、`Content-Type: application/json`、`omitCookies:true`；200 解析 JSON。 |
| `601147`，`NP` | 公共 fetch 包装把 omitCookies 转为 credentials omit；无 access token 时使用 `Authorization: None`，不是 Cookie 或 Key。 |
| `640822`，`request:{text:e.sourceTexts` | body 的 `text` 为字符串数组；目标语言先转换；source_lang 等字段可为 undefined。官方 app_information 不能作为近译身份复制。 |
| 约 `641350`，`Px` | 结果读取顶层 `.translations`；下游逐项取 `.text`、`.detected_source_language`。 |
| `8939` / `9013` 附近语言表 | `ZH`→`zh-Hans`，`ZH-HANT`→`zh-Hant`。 |
| `9570` 及 `6656` / `6752` 附近 | `EN`→`en`；`EN-GB`/`EN-US`→`en-GB`/`en-US`。 |
| 约 `366000`，`tE` | 目标语言使用 langCodeForIta；source direction 的简体中文为 zh，未知来源 fallback 为 autodetect。不能沿用旧 RPC 的语言枚举。 |

协议锚点短片段：

```js
request:{text:e.sourceTexts,target_lang:o,...,source_lang:e.sourceLang,...}
return(yield rx(e,t,"translate")).translations
{langCode:"ZH",langCodeForSpeech:"zh-CN",langCodeForIta:"zh-Hans"}
```

近译采用固定端点与 `{text:string[],target_lang:'zh-Hans'}`，省略 source 语言，不发送 app_information，不复制官方扩展 User-Agent、设备或身份。HTTP200 本身不保证已经翻译，仍需校验数组、数量、非空文本并做目标语言与语义验收。

## 预算与错误边界

- `9772`：翻译常量 `V={notLoggedIn:1500,loggedInFree:5e3}`；`590227` 的 FC 按账号状态取值；`627112` 的 Fk 以 sourceTexts 中所有字符串 `.length` 合计，匿名超额报 Translator Anon 字符超限。这支持每请求合计最多1500个 UTF-16 单元；它不是无429保证，也不能泛化为服务端全部路径的硬上限。
- `631557`：另有每 text 默认300000单元的宽泛保护，不能替代匿名合计1500预算。
- `579714` 的 FL 用 TextEncoder 计序列化内容字节；`641106` 的 Cx 以24576字节/最多100项分组。它不拆过大单项，且外层选择条件并非每次都启用分组。这是客户端策略，不是已确认的服务端合同。
- Cx 使用 Promise.all 并行发送组，未在该处给出全局稳定并发/QPS限制。近译的并发预算与启动间隔由自身调度器拥有，不照搬其并行行为。
- OneShot rx 明确处理413（payload过大）与451（地区相关错误）；其他非200是带状态的通用错误。未发现415的语言错误特殊分支，也未找到1042911的公开官方定义，不能据它猜测固定额度、IP封禁时长或需要Cookie。

旧协议失败、匿名 OneShot 真实测试和全文验收状态分别记录在 [当前诊断](../reports/DEEPL_ANONYMOUS_PROTOCOL_DIAGNOSIS_2026-10-22.md)、[性能记录](../reports/PERFORMANCE.md)及[验证说明](../development/VALIDATION.md)。本静态证据不替代这些运行结果。
