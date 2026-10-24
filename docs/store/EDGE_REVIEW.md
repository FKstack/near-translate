# Edge Add-ons 提交与审核资料

准备日期：2026-10-25。适用于当前源码候选包的提交准备，版本和测试结果须以最终验收包填写；实际账户、上传、提交和审核状态应以 Partner Center 为准。本文件不包含密码、API Key 或身份资料。新版 API Key 保存后直接可用，不再设置日常口令或锁定步骤；旧版密钥库与字体包装的验收记录属于对应旧包，不能直接作为新版验收结论。

## 官方入口与当前要求

| 项目 | 官方要求／准备值 |
| --- | --- |
| 控制台登录入口 | https://partner.microsoft.com/dashboard/microsoftedge/public/login |
| 注册 | Microsoft Edge program 无注册费；使用个人 Microsoft account，可经 GitHub 登录关联创建；不能直接用工作／学校账户注册 |
| 需本人确定 | 真实账户国家／地区、Individual 或 Company、发布者显示名（最多 50 字符）、联系信息；国家／地区和账户类型注册后不可改 |
| 公司账户附加 | 注册公司名与公司审批人姓名、邮箱、电话；可能要求公司材料核验 |

注册事实来源：[Register as a Microsoft Edge extension developer](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/create-dev-account)。不要根据电脑时区、GitHub 用户名或文件路径推断国籍、法定姓名、地址、企业关系或用于公开展示的身份。

发布包为 ZIP，根目录应直接包含 `manifest.json`。公开可发现性选 Public。建议分类 Productivity；最终按控制台选项匹配。当前包没有 manifest 国际化，名称和短描述为中文；若语言页受限，不把英文文案视作已国际化的证据。

素材与字段：

| 内容 | 当前官方规格 |
| --- | --- |
| 每种语言长描述 | 250–10,000 字符 |
| Logo | 1:1，至少 128×128，建议 300×300 |
| 截图 | 640×480 或 1280×800，最多 6 张 |
| 小推广图 | 可选，440×280 |
| 大推广图 | 可选 PNG，1400×560 |
| 搜索词 | 最多 7 项，每项最多 30 字符，总计最多 21 个词 |

包内名称／短描述取自 manifest；提交后先进入认证，不能把上传完成当作已在商店可安装。来源：[Publish a Microsoft Edge extension](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)。

## 发布资料

可直接复制的中英文介绍、搜索词和链接见 [LISTING.md](LISTING.md)。默认选择简体中文介绍；英文语言页如可添加，再使用英文介绍，并保留界面主要为简体中文的说明。

隐私 URL：<https://github.com/FKstack/near-translate/blob/main/docs/store/PRIVACY_EDGE.md>。提交前确认该版本已推送、公开可读并与安装包一致。本页专门说明 Microsoft Edge 中的处理行为。政策依据：[Microsoft Edge 开发者政策 1.5](https://learn.microsoft.com/en-us/legal/microsoft-edge/extensions/developer-policies)。

## Single purpose（英文可直接粘贴）

Help users read and understand webpage articles and text-based PDF documents in their preferred layout and language, through local reader mode, bilingual article translation, and on-demand text translation. Local document preparation and PDF export tools support the same document-reading workflow.

说明：这段文字陈述现有产品定位。当前包还包含本地 PDF 合并、拆分等工具，不能向审核方隐瞒；单一目的是否满足仍由商店审核决定。

## 权限逐项说明（英文可直接粘贴）

| Manifest 权限 | Justification |
| --- | --- |
| `storage` | Save translation settings, user-provided API credentials, language choices, and reader appearance on the device. Local storage is restricted to trusted extension contexts. Source articles, translations, and PDFs are not stored as persistent reading history. |
| `scripting` | Inject the packaged selection-translation and reader UI into webpages after the user enables the feature or invokes the reader. It also registers and removes the packaged content scripts as optional website access changes. No remotely hosted scripts are injected. |
| `activeTab` | Let the user open reader mode for the currently active webpage from the extension popup without first granting access to every website. It also identifies the current page or PDF for the user's explicit open action. |
| API 主机权限（全部可选） | No API host access is required at installation. When the user chooses and saves an API service, including DeepSeek, the extension requests optional access to that service origin. Translation sends the requested text and the user's API credential only to the configured endpoint. Installation does not start translation. |
| Optional `http://*/*`, `https://*/*` | Support reader/translation features across user-selected HTTP(S) webpages, downloading an online PDF chosen by the user, and user-configured API endpoints. Website access is requested when the user enables webpage translation. API host access is requested when configuring a service. A host grant alone does not start article translation. Only loopback API endpoints may use HTTP; other configured APIs require HTTPS. |
| Optional `declarativeNetRequestWithHostAccess` | An optional connection-preparation feature for the DeepL endpoint. A narrowly scoped session rule adds Access-Control-Request-Method and Access-Control-Request-Headers to the extension's fixed OPTIONS preparation request only. It does not modify Origin, User-Agent, translation POST bodies, or responses. Preparation may contact DeepL without article text after the user has granted the optional feature and host permissions. Translation works without this optional permission. |

依据当前 `wxt.config.ts`、实际 `.output/edge-mv3/manifest.json` 及 `src/platform` 中的实现填写。若包的权限有变化，应同步更改本表，不能照抄旧版本。

## Remote code

选择 **No, I am not using remote code**。可填写补充说明：

All executable JavaScript, PDF.js workers, WebAssembly resources, fonts, and dictionaries are packaged with the extension. Translation APIs return text/data, which is rendered as text rather than executed. Reader extraction rebuilds allowed content and excludes page scripts and event handlers. The extension does not fetch and execute remotely hosted scripts.

`wasm-unsafe-eval` 用于包内 PDF 处理资源，不等于下载远程代码。不要将翻译 API 请求误填成远程可执行代码，也不能把远程返回文本交给动态代码执行。

## 数据使用披露

逐项依据控制台实际字段定义填写；不能因为没有开发者自有服务器就统一选择“不访问／传输任何用户数据”。

| 数据／场景 | 真实处理 |
| --- | --- |
| Website content / 网页内容 | 会访问。阅读模式在本机提取正文；用户主动翻译时，将相应正文／选区发送到所选服务。模型可选上下文额外发送有限相邻文字。 |
| User-provided text / 用户输入内容 | 会处理。包括选中的 PDF 文字、本地转换文档和用户粘贴文字；只有用户另行调用翻译时才将相应文字发到翻译服务。 |
| Authentication information / 鉴权信息 | 可选。用户自行配置的模型 API Key 在本机保存，并只用于向所配置服务鉴权。不收集浏览器登录密码或网站 Cookie 作为翻译鉴权。 |
| Browsing activity / 浏览活动 | 访问当前用户操作页面或在线 PDF 的 URL 以显示阅读器或下载文档；不读取 `history` 数据库，不记录／上传浏览历史，不做跨站跟踪。若控制台把当前网页 URL 也纳入该类别，应如实勾选并说明本机用途。 |
| Local files / 本地文件 | 只读取用户通过文件选择器提供的 PDF、文档或图片。转换、PDF 文件与 PDF 密码不上传到开发者服务器；所选 PDF 文字单独翻译时适用翻译服务规则。 |
| Telemetry / 广告 | 无开发者遥测、广告或数据买卖。诊断为有界的本机内存数值，不上传正文、Key 或 Cookie。 |

在线 PDF 的下载可能使用来源网站的正常 Cookie；这与翻译 API 的 `credentials: omit` 不同。不得把“翻译 API 不读取 Cookie”扩写成“任何请求都不带 Cookie”。阅读视图中的原站图片也可能向其来源发起正常网络请求。

建议的数据用途为明确用户功能；没有广告、信用判断、数据经纪或与阅读翻译无关的分析用途。第三方翻译服务对数据的留存、计费和训练用途由用户选择服务的条款决定；不能替这些服务作“永不留存／永不训练”的保证。

审核页的 Limited Use 等认证勾选必须与公开政策及实际行为一致。应用代码和当前隐私文档可以支持事实核验，不能代替本人确认其对外承诺。

## Notes for certification（英文可复制）

Near Translate is a Manifest V3 reading and translation extension; fill in the exact candidate version after package validation. Its interface is primarily in Simplified Chinese. No Near Translate account is required. No developer API key or test password is embedded in the package. All API host permissions are optional.

1. Local reader: open a normal public article, for example https://go.dev/doc/effective_go . Open the extension popup and select 阅读当前网页. The article should open in reader mode without an API key. Change theme, text size, line spacing, and width; test the table of contents and the original/bilingual/translation-only view selector. Switching view alone should not send translation requests. Press Escape to leave reader mode.

2. Free translation: open the extension settings, select or keep DeepL 免费翻译, and click 启用免费翻译. Grant the requested website and service permissions. Translation does not start merely from enabling it. The independent 测试免费翻译 button sends only a fixed public example. On a public English article, select text and click 译, or enter reader mode and click 翻译正文. Completed translated paragraphs should remain if translation is stopped. This third-party experimental endpoint may be rate-limited; the UI exposes a cooldown and manual retry. It does not silently switch to a paid model service.

3. Optional model mode: switch to 大模型 API in settings. Configure a compatible service's base URL, model, and a valid API key belonging to the tester. Save and grant optional access to that API origin, then translate without creating a passphrase or unlocking. Verify that the saved configuration works across tabs, background suspension, and a full browser restart. Keys are persisted in private extension storage restricted to trusted contexts, without extra passphrase encryption; settings and public messages do not return the saved key. Existing encrypted records have an optional one-time import using the old passphrase, or the tester can enter the key again. Choose English as source and Simplified Chinese as target for contextual dictionary or eligible sentence analysis. These optional services may require a paid account; credits are not included.

4. PDF reader: open PDF 阅读器 from the popup, choose a local text-based PDF, and test page navigation, text search, zoom, and selection. Selecting text followed by 译 uses the configured translation service. The PDF file and PDF password are not uploaded for translation. Scanned PDFs without a text layer do not support selection translation, and OCR or whole-document PDF translation is not included.

5. Local document tools: open 文档转换, paste a small Markdown/text sample, and export a PDF. Reopen it in the PDF reader and check that text is selectable. Test merge, split, and reorder with simple local PDFs as needed. Conversion is local and does not require a translation API key or a Near Translate login.

6. Privacy/permissions: local reader mode is available without enabling translation. Optional website permission enables selection translation on permitted webpages. Model requests send only translation text, limited optional context, protocol fields, and the user-configured API credential to the selected endpoint. All scripts and PDF resources are bundled. Optional connection acceleration, if enabled, uses a fixed content-free OPTIONS request to the DeepL endpoint. It does not upload article text before the user asks to translate. There is no developer telemetry or translation proxy.

If third-party model access is needed for certification, contact the publisher through the listed support page. Do not place a personal or reusable API key in public listing text, screenshots, source files, or this document.

## 需要本人提供或完成的准确字段

- 登录密码、通行密钥、验证码、双重验证或恢复凭证：本人在官方页面直接输入。
- 开发者账户国家／地区，Individual／Company，合法发布者显示名。
- 注册表单实际要求的法定姓名、地址（街道、城市、省州、邮编）、联系邮箱与电话；不从开发机信息推断。
- 公司账户的注册公司资料、审批人、验证材料（仅选择公司账户时）。
- 开发者协议和对外数据承诺：本人应能查看实际条款；不要冒用身份、凭空编写信息，或把通用的代操作授权当作身份事实。
- 如审核实际要求专用第三方服务测试凭证，须由发布者提供受限的测试方式；现有个人 Key 不应复制到公开材料中。

这些是账号和身份依赖；其余文案、素材、包检查、可见性、分类、链接和审核说明可以先完成。截图、当前表单状态和审核结果应作为实际进度依据保存，不能把本准备文件当作提交回执。
