## 近译：读外文，留在文章里。

遇到生词，就地查；遇到长句，看拆解；需要理解整篇文章时，打开双语对照，再按自己的节奏读下去。

**近译是面向 Chrome、Edge 与篡改猴的开源阅读翻译项目**，把网页双语、语境查词和专注阅读放在一起，还通过扩展版提供 PDF 阅读与本地文档工具。

**本页安装的是篡改猴网页阅读版。** 网页翻译、划词与阅读模式可以直接使用；PDF 阅读器和文档转换需要安装 Chrome / Edge 扩展。

[项目主页](https://fkstack.github.io/near-translate/) · [GitHub 源码](https://github.com/FKstack/near-translate) · [安装与使用指南](https://fkstack.github.io/near-translate/userscript/guide.html) · [Chrome / Edge 扩展下载](https://github.com/FKstack/near-translate/releases/latest)

![近译双语阅读：正文、目录、原文译文与阅读排版](https://fkstack.github.io/near-translate/assets/reader-bilingual.png)

*近译阅读模式界面示例。截图中的文章、译文与下方词卡响应为预置示例内容。*

## 先选适合你的安装方式

| 能力 | 本页篡改猴版 | Chrome / Edge 扩展版 |
| --- | --- | --- |
| 网页逐段双语翻译、停止与恢复原文 | 支持 | 支持 |
| 网页划词翻译、模型语境词典与长句拆解 | 支持 | 支持 |
| 阅读模式、目录、主题与排版设置 | 支持 | 支持 |
| 自选兼容模型 API 与本机模型接口 | 支持 | 支持 |
| 本地或在线 PDF 阅读、选中文字翻译 | 不包含 | 支持 |
| Markdown／文本／HTML 转 PDF，PDF 合并、拆分与重排 | 不包含 | 支持 |

两种版本来自同一个仓库，共用对应的网页阅读与翻译模块。**设置分别保存，不会自动迁移；同一网页请只启用一种近译安装方式。**

## 保留原文，逐段理解网页

阅读技术文档、产品文章和外文长文时，在原段落下方查看译文，随时回看原句、术语与代码。点击“翻译正文”才开始翻译，过程中可以停止，或恢复原文。

进入阅读模式后，可以在**原文、双语、仅译文**之间切换。先读原文，需要帮助时再翻译，已完成的内容留在当前页面继续阅读。

## 查这个句子里的意思，再往下读

选中单词或句段，在阅读的位置查看翻译。模型模式下，开启上下文后，英语词卡可以展示本句含义、词性、解释和常见义项；符合条件的英文长句可以查看句子主干、语法标注和分块阅读提示。

![近译语境词卡：单词的本句含义、参考原句与常见义项](https://fkstack.github.io/near-translate/assets/word-context.png)

*语境词典支持英语到简体／繁体中文；长句拆解目前支持英语到简体中文，针对选中的单个长句。两者需要模型 API，其他语言方向仍可使用普通文本翻译。*

## 把长文章调成喜欢的样子

在本机提取正文，配合目录和阅读进度，减少页面上的干扰。从**舒适长读、技术文档、夜间阅读**开始，再调整主题、字号、行距与栏宽；喜欢的排版可以保存为“我的样式”，下篇文章继续使用。

代码、表格、图片与列表保留在阅读内容中。需要回到原网站时，可以返回对应段落；按 `Esc` 退出阅读模式。**本地阅读本身无需近译账号或 API Key。**

## PDF 与本地文档工具：由扩展版提供

Chrome / Edge 扩展可以打开本地或在线文字型 PDF，翻页、搜索、缩放，并选中文字使用翻译卡片。PDF 翻译针对所选文字，当前不提供整份 PDF 自动翻译或 OCR；扫描件需先有可选择的文字层。

![近译扩展版 PDF 阅读器：在 PDF 中选中单词并查看语境词卡](https://fkstack.github.io/near-translate/assets/pdf-selection.png)

*上图为扩展版 PDF 界面，使用示例文档和预置词卡响应；本页篡改猴脚本不含此阅读器。*

扩展还提供本地文档工具：把 Markdown、文本或 HTML 导出为带文字层的 PDF，以及 PDF 合并、拆分和重排。这些文档转换在本机完成。

需要这些能力时，请从 [GitHub 最新 Release](https://github.com/FKstack/near-translate/releases/latest) 下载对应浏览器 ZIP，解压到固定目录，在 `chrome://extensions` 或 `edge://extensions` 中开启开发者模式并加载已解压目录。完整步骤见[扩展安装指南](https://github.com/FKstack/near-translate/blob/main/docs/guides/INSTALL.md)。

## 开始使用篡改猴版

1. 安装 **[Tampermonkey 5.4 或更新版本](https://www.tampermonkey.net/)**，按管理器提示允许浏览器运行用户脚本。
2. 点击本页上方的“安装此脚本”，在篡改猴中核对名称和权限，确认安装后刷新文章页。
3. 从网页浮动入口或篡改猴菜单进入阅读模式，也可按 `Alt+Shift+R`。需要翻译时点击“翻译正文”，或选中文字后点击“译”。
4. 从篡改猴的近译菜单打开[翻译设置](https://fkstack.github.io/near-translate/userscript/settings.html)，选择翻译服务。

脚本适用于 HTTP(S) 顶层网页，浏览器内部页面、扩展商店、PDF 页面和内嵌框架不属于本版的处理范围。

## 翻译服务，由你选择

- **先试试免费翻译**：可在设置中启用实验性 DeepL 服务，无需 API Key；可能限流、调整或暂时不可用。
- **使用自己的模型**：填写兼容 OpenAI Chat Completions 的 API 地址、模型名称和 Key，也可连接已部署的 Ollama 等本机兼容接口。模型服务可能需要账号、API Key 和付费额度，费用由所选服务收取。
- **只阅读也可以**：不配置翻译服务，仍可使用本地阅读、目录和排版。

篡改猴版的模型 Key 只在专用设置页输入，使用独立口令加密保存在脚本存储中。回到文章页后，从篡改猴菜单选择“解锁本页模型 Key”；刷新或新开页面需要重新解锁。原生口令提示框中的文字可见；普通 HTTP 页面可能无法安全解锁，可改用 HTTPS 页面，或继续使用本地阅读与免费翻译。

## 数据与权限

主动翻译时，正文、选中文字和可选上下文直接发送给你选择的翻译服务。近译没有自有翻译中转服务器，不提供广告或遥测；第三方服务仍按各自政策处理收到的内容。阅读正文在本机提取，文章中的图片可能仍从原网站加载。

脚本的跨域连接由篡改猴授权。自定义 API 使用 `@connect *`，请核对实际目标域名后授权；模型 Key 和口令不会发送到 GitHub Pages 或 Greasy Fork。扩展版与脚本版的密钥解锁范围不同，完整说明见[隐私与数据处理](https://github.com/FKstack/near-translate/blob/main/docs/guides/PRIVACY.md)。

安装或更新 Greasy Fork 版时，篡改猴会从 jsDelivr 下载固定版本、带 SHA-256 校验的 OpenCC 与 Mozilla Readability 库。近译业务代码在本脚本中提供。

## 更新提醒与反馈

通过本页安装的脚本沿用 Greasy Fork 更新渠道。含更新提示功能的版本在主动使用翻译或阅读时发现新版，会弹出确认框：

- **取消**：继续当前功能，下次主动使用再提醒，不会永久忽略该版本。
- **确定**：打开同渠道安装页，由篡改猴确认更新；完成后刷新文章页。

联网检查最多每 24 小时一次，检查失败不影响原有功能。项目发布后，Greasy Fork 自动拉取同步源可能有延迟，本地检查缓存也可能推迟提醒。

**希望每次更新都自己决定，请单独关闭篡改猴对近译的内建自动更新。** 脚本确认框不能阻止管理器自行升级；0.11.3 及更早版本没有此提醒，需要先手动升级一次。

近译以 **MIT 许可证**开源。欢迎反馈具体网页、复现步骤和期望表现；提交截图或日志前请遮盖私人内容、API Key 和口令。

[项目主页](https://fkstack.github.io/near-translate/) · [源码与许可证](https://github.com/FKstack/near-translate) · [问题反馈](https://github.com/FKstack/near-translate/issues) · [篡改猴使用指南](https://fkstack.github.io/near-translate/userscript/guide.html)
