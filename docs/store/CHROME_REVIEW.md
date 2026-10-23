# Chrome Web Store 上架准备：近译 0.11.0

核对日期：2026-10-23。本文是上架材料与源码核对记录，不代表已注册开发者、已上传、已提交审核或已获准发布。账号与控制台状态须在实际页面确认。

## 初次核对的历史包（不是本次商店提交候选）

- 文件：`artifacts/releases/v0.11.0/near-translate-chrome-v0.11.0.zip`。
- 大小：10,400,512 字节；333 个文件；`manifest.json` 位于 ZIP 根目录。
- 版本：`0.11.0`；Manifest V3；名称：`近译 · 阅读与翻译`。
- 摘要：`本地阅读模式、双语网页与划词翻译、PDF 文字选择翻译，也支持自定义模型 API。`，41 字符，低于 132 字符限制。
- SHA-256：`362df8251e8a8395b9d893f4bcc907a044cbaf14e30a7f1156845412c01c3ac9`，与 Release 校验表一致。
- 包内有 `icon/128.png`，没有 node_modules、浏览器运行时或测试结果目录。

上传规则见 [Prepare your extension](https://developer.chrome.com/docs/webstore/prepare)。已发布的同版本 ZIP 不应因文案调整被悄悄替换；如需改代码或 manifest，应另发递增版本。

## 0.11.1 整改后候选

后续商店版已改为用户口令加密密钥库，并去除必选 API 主机权限；旧版包和本页的初次问题记录保留，不能用旧摘要代替新候选。实际密码学、迁移、首装零权限、完整浏览器重启及最终包哈希，以[本轮验证](../evidence/store-readiness-2026-10-23.json)为准。

Chrome 暂缓提交：发布者当前优先处理 Edge，尚未提供 Google 开发者账号。商品资料已备齐；只有实际登录、注册并提交后才能填写商店 ID 和审核状态。当前公开隐私页使用[Chrome 专用说明](PRIVACY_CHROME.md)。

## 账号与发布前置条件

1. 使用发布者自己的 Google 账号登录 [开发者控制台](https://chrome.google.com/webstore/devconsole)，核对姓名、邮箱和发布者，不沿用 GitHub 登录身份推断 Google 身份。
2. 如未注册，完成开发者注册及一次性费用。Google 的 2026 官方更新仍提及 $5 注册费；实际应付金额、币种及税费以结账页为准。[注册说明](https://developer.chrome.com/docs/webstore/register)、[2026 官方更新](https://developer.chrome.com/docs/extensions/whats-new?hl=en)。
3. 开启 Google 账号两步验证，验证商店联系邮箱，并设置发布者名称。[政策](https://developer.chrome.com/docs/webstore/program-policies/policies/)、[账号设置](https://developer.chrome.com/docs/webstore/set-up-account)。
4. 按实际身份申报 Trader / Non-Trader。免费、MIT、个人项目不自动决定法律身份；不能替用户编造。Trader 可能需真实法定名称、电话、地址及验证材料，部分资料会公开。[Trader FAQ](https://developer.chrome.com/docs/webstore/program-policies/trader-verification-faq)。
5. 若遇密码、验证码、付款、身份材料或未经提供的真实联系方式，需要账号所有者完成相应步骤；这些不是代码缺陷，也不能以假资料绕过。

## 商店页面建议

- 默认语言：简体中文；类别优先选择控制台中适用的生产力／阅读相关项。
- 网站：`https://github.com/FKstack/near-translate`。
- 支持：`https://github.com/FKstack/near-translate/issues`。
- 隐私政策候选地址：`https://github.com/FKstack/near-translate/blob/main/docs/guides/PRIVACY.md`。须先发布最新政策，并以未登录访问实际验证可读；不能仅凭本地文件存在断言有效。

可直接使用的详细介绍：

> 读外文，留在文章里。近译把网页双语、语境查词与专注阅读放在同一个阅读过程中。
>
> 阅读外文文章时，在段落下方查看译文，随时对照原句；遇到生词，选中文字就地查；需要专注长读时，打开阅读模式，调整主题、字号、行距和栏宽，保存自己的阅读样式。
>
> 主要功能：
> • 网页与阅读模式支持原文、双语和仅译文，翻译由你主动点击开始。
> • 划词翻译可按需附带附近句子；模型模式提供英语到简／繁中文的语境词典，以及英语到简体中文的长句拆解。
> • 内置 PDF 阅读器，支持文字型 PDF 的搜索、缩放与选文翻译；扫描件需要已有 OCR 文字层。
> • 本地文档工具可导出 PDF，以及合并、拆分和重排 PDF，作为文档阅读的辅助功能。
>
> 翻译服务由你选择：可试用实验性 DeepL 免费服务，或配置自己的 OpenAI 兼容模型 API。免费服务可能限流或调整；模型服务需要自己的账户／Key，并按所选服务规则计费。近译不隶属于这些服务商。
>
> 本地阅读无需近译账号或 API Key。点击翻译后，相关正文、选中文字及可选上下文直接发送至你选择的服务；API Key 保存在本机扩展存储，不使用浏览器同步。项目不设翻译中转服务器，不上传使用统计。可选 DeepL 连接加速会提前联系其服务，但不发送正文、网页地址或登录凭证。原文章图片和在线 PDF 的来源网站仍可能收到正常加载请求。
>
> 近译以 MIT 许可证开源。完整使用方法、数据处理说明与反馈入口见项目主页。

不应承诺永久免费、无限量、固定秒数、离线翻译、完整 PDF 自动翻译或扫描件 OCR；这些不是当前版本保证的能力。

## Single purpose 字段

建议填写：

> 帮助用户在浏览器中阅读和理解外文网页及文档。用户可以在当前文章中查看双语、查询选中文字、进入可调排版的阅读模式，并在内置 PDF 阅读器中翻译选中文字；本地文档转换与整理是文档阅读的辅助步骤。

这是对现有产品的实际归纳。独立的文档转换、合并、拆分功能与阅读翻译的关联仍可能被审核员质疑，不能用文案保证通过。应如实列出并说明联系；若审核要求收窄范围，再开发递增版本，不能藏匿功能。[单一用途说明](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines-faq)、[隐私表单说明](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)。

## 各项权限说明

| 权限／域名 | 可填写的真实用途 |
| --- | --- |
| `storage` | 在本机保存用户主动配置的翻译服务、API Key、语言和阅读版式。存储限可信扩展上下文，不使用同步存储；正文、译文和 PDF 不因此持久化。DeepL 冷却仅保存临时会话截止时间。 |
| `activeTab` | 用户点击扩展入口后，检查当前标签并在该页打开本地阅读模式；也用于识别用户要打开的当前在线 PDF。不会查询完整浏览历史。 |
| `scripting` | 用户主动打开阅读模式时注入随包脚本；用户授予网页权限后，注册随包内容脚本，为网页提供划词、双语与阅读界面。暂停或撤权后停止相应会话及后续注入。 |
| `https://api.deepseek.com/*`（必选） | 用户选择 DeepSeek 并点击翻译时，后台直接调用该 API；仅用于翻译请求及鉴权。默认免费模式不使用或向此处发送模型 Key。此权限目前随安装声明，存在最小权限审核风险；“兼容旧版”本身不是充分的最小权限理由。 |
| `http://*/*`、`https://*/*`（可选） | 网页翻译支持用户自行选择的网站；启用网页功能时才申请。配置自定义 API 时申请对应域名，在线 PDF 申请其来源域名。远程模型 API 仅接受 HTTPS；HTTP 模型基址只允许本机回环。权限按浏览器域名粒度，不能声称仅限一个路径。 |
| `declarativeNetRequestWithHostAccess`（可选） | 用户另行开启 DeepL 连接加速后，仅为本扩展发往固定 DeepL 翻译地址的 OPTIONS 请求设置两个标准协商头；不修改网页流量、Origin、Cookie、POST 或响应。普通翻译无需此权限；也用于清理已有会话规则。 |

依据：`wxt.config.ts`、`src/platform/settings.ts`、`src/platform/web-access.ts`、`src/platform/deepl-web-transport.ts` 和 `src/entrypoints/popup/main.tsx`。权限说明应与所上传 ZIP 一致，不为已有 ZIP 声称权限已删除。[最小权限要求](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)。

## 数据用途表单

Google 将本地采集、使用、保存和传输均视为处理数据；“没有自有服务器”或“没有遥测”不能据此勾选“不处理数据”。[官方 User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)。下表是依据实际代码的填写建议，最终逐项核对控制台当前英文定义。

| 分类 | 建议 | 实际处理及边界 |
| --- | --- | --- |
| Website content | 勾选 | 提取网页正文、标题、作者和图片链接供本地阅读；主动翻译时将相应正文／选文及可选上下文发往选定服务；打开的本地文档在本机解析。 |
| Authentication information | 勾选 | 处理用户自己填写的模型 API Key，并仅作为该配置接口的鉴权凭证发送。PDF 打开密码也在本机处理。不读取网站登录 Cookie；在线 PDF 下载仍可随浏览器正常向来源站点附带其认证 Cookie。 |
| Web history | 建议勾选 | 当前标签 URL、文章 sourceUrl、在线 PDF URL 均在实际功能中使用。Google FAQ 对浏览活动的定义包含用户交互的域名和 URL，因此不能因没有 `history` 权限而直接否认。无完整历史记录列表、无跨文档阅读档案、无 URL 遥测；翻译正文请求不附加文章 URL。 |
| User activity | 控制台定义需确认；若涵盖本地交互处理，勾选并限定用途 | 阅读模式处理选区、可见段落、滚动位置与进度，以定位词卡、目录和当前文档位置；整页队列用可视位置安排先后。没有点击／鼠标／滚动分析日志，也不上传行为轨迹。若控制台仅问监控／记录活动，不能把普通点击响应等同分析追踪；将这段真实用途提供给审核，不作“完全不处理交互”的绝对陈述。 |
| Personally identifiable information | 未发现独立收集用户身份字段；不能承诺正文不含个人资料 | 扩展没有账号、姓名、邮箱、电话号码表单或用户身份档案，但网页作者、用户主动选取的文章／文件可能有个人资料。应在政策中明确敏感文本也按上述内容规则处理；若控制台定义要求把自由文本中的个人资料同时分类，应勾选。不要为通过审核省略正文中的个人资料，也不要仅因任意文本可能含健康、金融信息就宣称产品会主动采集全部敏感类别。 |
| Financial and payment information、Health information、Personal communications | 无专门采集能力；按控制台定义核对自由文本范围 | 无付款、医疗档案或通信账户读取功能；用户可主动选择这些类别的文字。应如实披露用户所选内容会发送给当前翻译服务，并提示不要提交不愿提供给该服务的敏感内容。 |
| Location | 不勾选专门定位采集 | 无定位 API、GPS 或位置档案；服务提供方会因普通联网看到连接 IP，应在隐私说明区分这种网络处理。 |

必须如实认证：数据不用作出售、广告或与阅读翻译无关的用途，不用于信用评估；仅为已披露功能发送给用户选择的翻译服务。不应声称所有第三方提供方均不留存、不训练或永不读取，因为其政策不由本项目控制。

## 提交前源码整改项：API Key 静态存储

当前 `src/platform/settings.ts` 把 `ApiProfile.apiKey` 作为字符串保存在 `browser.storage.local` 的 `settings:v1` 中，没有应用层静态加密。`TRUSTED_CONTEXTS` 限制内容脚本读取，属于访问控制，不能表述为 AES／RSA 加密；设置页不回显 Key 也不改变磁盘上的保存方式。

[User Data FAQ 第 9 项](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) 要求用户数据安全传输并在静态保存时使用强加密。[当前 MV3 Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage) 对敏感数据推荐 `storage.session`，该区域只在内存保留，重启浏览器等情况清除。[Protect user privacy](https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy) 说明扩展存储未加密，提醒避免客户端保留敏感数据。本次没有找到将 `storage.local` 加上 `TRUSTED_CONTEXTS` 视为静态加密合规例外的官方依据。

因此，应在正式提交前处理，不只依靠隐私文案解释，也不能认证“已加密保存”。可选实现方向：

- 仅会话保存 Key：迁移至可信 `storage.session`，明确告知浏览器重启后需重填；删除旧 `storage.local` 中所有活动与非活动 profile 的 Key。凭证读写、状态投影、切换服务、后台休眠及旧配置迁移需回归验证。
- 若要跨重启保存，另行设计实际的强加密及独立钥匙／用户解锁机制；把明文解密钥匙和密文并存在同一个扩展存储中，不能当成充分的静态保护说明。

上述是依据官方文字和源码发现的提交前整改判断，最终是否通过仍由商店审核决定。整改会改变运行行为，须递增版本重新构建及验证，不能覆盖已有 Release 的 0.11.0 ZIP，也不能继续把该旧包描述为已完成整改。

## 远程代码与 WASM

建议 Remote code 选择“No, I am not using remote code”，并在审核补充信息中说明：所有执行逻辑、PDF.js worker、字体与解码 WASM 均随 ZIP 分发；远程接口只返回翻译数据，以文本显示，不执行模型返回的 HTML 或脚本。`cMapUrl`、`standardFontDataUrl`、`wasmUrl` 和 `iccUrl` 均指向扩展自身资源。

包内四个 WASM：`jbig2.wasm`、`openjpeg.wasm`、`qcms_bg.wasm`、`quickjs-eval.wasm`，均为 PDF.js 随包资源。不要隐瞒 `quickjs-eval.wasm`，也不要仅凭文件名判断远程代码违规。CSP 的 `'wasm-unsafe-eval'` 用于本地 PDF 支持，属于 Chrome 允许的 MV3 CSP 值；它不允许远程 JS。此为源码与资源路径核对，不代替商店扫描。[远程代码说明](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)、[CSP 说明](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)。

## 图片与待完成项

当前 [listing 官方页](https://developer.chrome.com/docs/webstore/cws-dashboard-listing) 明确要求 128×128 图标及至少一张 1280×800 截图，最多五张；440×280 小宣传图和 1400×560 大宣传图可选。较早的 [images 页面](https://developer.chrome.com/docs/webstore/images) 仍写小宣传图必需，存在文档差异，应以当前控制台字段为准。制作一张小宣传图可避免缺项。

- 现有 README 截图为 1440×1000，须另备标准 1280×800 商店截图，展示真实当前界面。
- 优先展示双语阅读、自定义排版、语境词卡和 PDF 选文；示例译文如为预置响应，应明确其为界面演示，避免冒充真实模型效果保证。
- 发布前补齐 0.11.0 隐私政策的版本、有限用途、删除方法、联系方式，并验证公开 URL。
- 登录、开发者注册、两步验证、邮箱／身份验证、表单保存、ZIP 上传、实际提交和审核状态均需控制台证据；准备好文件不等于已完成这些步骤。
