# 商店图片素材 · v0.11.1

核对日期：2026-10-23。用于 Chrome Web Store 与 Microsoft Edge Add-ons 的简体中文首发条目。图片展示阅读、原文与译文对照、语境查词、PDF 选区翻译和 API Key 口令保护；不宣传扫描件 OCR、全文 PDF 翻译或未上线的能力。

## 官方规格

| 素材 | Chrome Web Store | Microsoft Edge Add-ons | 本次文件 |
| --- | --- | --- | --- |
| 商店图标 | 128 × 128 px；PNG | 每种语言必须提供 1:1 图标；推荐 300 × 300，至少 128 × 128 px | Chrome：`store-icon-128.png`；Edge：`store-icon-300.png` |
| 功能截图 | 1280 × 800 或 640 × 400 px，1–5 张 | 1280 × 800 或 640 × 480 px，最多 6 张 | 5 张，统一 1280 × 800 px |
| 小宣传图 | 440 × 280 px，PNG/JPEG | 440 × 280 px，可选 | `promo-small-440x280.png` |
| 大宣传图 | 1400 × 560 px，PNG/JPEG | 1400 × 560 px，PNG，可选 | `promo-marquee-1400x560.png` |

依据：[Chrome 图片说明](https://developer.chrome.com/docs/webstore/images)、[Chrome 条目配置](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)、[Edge 发布步骤 7](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension#step-7-enter-store-listing-details-for-each-language)。Chrome 的两个官方页面对小宣传图是否必需的表述存在差异，本次直接备齐。后台当时显示的字段和校验结果优先。

## 上传顺序

生成素材位于本机 `artifacts/store/v0.11.1/`。该目录被 Git 忽略，不是干净克隆自带的安装资源。

| 顺序 / 文件 | 画面与建议图注 |
| --- | --- |
| `01-reader-bilingual-1280x800.png` | **读原文，随时对照译文。** 阅读模式中的章节目录、英文原文与中文译文。 |
| `02-reader-appearance-1280x800.png` | **让阅读更合眼。** 实际显示设置面板，展示长读方案、主题和字体选择。字号等设置位于面板下方，正常滚动可见。 |
| `03-word-context-1280x800.png` | **在原句里理解一个词。** 选择 approach 后展示本句含义、参考原句和常见义项。英语语境释义需要已配置的大模型服务。 |
| `04-pdf-selection-1280x800.png` | **PDF 也能选中查词。** 自制文本 PDF 在真实阅读器中打开，选词后显示翻译卡片；适用于可选择文字的 PDF。 |
| `05-key-protection-1280x800.png` | **自己的 Key，用自己的口令保护。** 真实设置页面中已解锁的密钥库，以及手动锁定、更改口令入口；保存后的 Key 和口令输入已验证清空。显示的服务配置为演示配置。 |

五张图片均可用于两个商店。首张建议使用双语阅读图。宣传图只呈现原创双叶品牌图形和“近译 / 读外文，留在文章里。”，不冒充产品界面。

Chrome 图标上传 `store-icon-128.png`，在 128 px 透明画布中留出边距；Edge 上传推荐尺寸的 `store-icon-300.png`。两图均由矢量母版重新栅格化，没有放大旧 PNG。`extension-icon-128.png` 是当前扩展包内 128 px 图标的原样副本，供后台核对，无需替换已发布安装包。

## 真实性与素材来源

- 由当前 0.11.1 生产构建在独立、临时 Chrome 测试配置中实际操作并截屏。截图视口为原生 1280 × 800，设备比例 1，没有缩放旧截图、拼接产品界面或隐藏真实控件。
- 演示文章、PDF 和中文译文由本项目自行编写。翻译响应通过本地模拟返回；图片用于展示交互，不代表 DeepSeek 或其他服务的真实质量、耗时或价格。
- 页面来源显示 `127.0.0.1`，是本机演示网页。素材不含用户网页、账号、API Key、邮箱或日常浏览器配置。
- API Key 保护图使用可信 `options.html` 的生产消息接口创建密钥库，再通过真实表单保存假 Key。拍摄前验证持久存储中没有明文假 Key，所有口令和 Key 输入均为空；未直接向存储写入可用凭证或会话钥匙。
- 临时扩展副本仅预先授予网页来源权限，以便测试自动执行；UI、脚本和样式来自生产构建。发布 ZIP、源代码和日常安装均未改变。
- 品牌来自 [可编辑 SVG](../../public/brand/near-translate.svg)。已有 [README 图片](../assets/readme/) 为 1440 × 1000，内容可复用作介绍，但不直接上传到要求固定尺寸的商店字段。`docs/design/near-translate/` 中的部分旧图记录早期版本，不作为 0.11.1 条目截图。

## 生成与验收

本次独立生成脚本为本机 `.output/store-assets.mjs`，使用仓库已有 Playwright、pdf-lib 和 Chrome 测试运行时，无新增依赖。运行：

```powershell
node .output/store-assets.mjs
```

前提：已有当前 `.output/chrome-mv3` 生产构建，以及本机 `.output/chrome-runtime/chrome.exe` 测试运行时。脚本不调用付费翻译接口，不打开用户日常浏览器；结束后校验路径并删除本轮临时测试配置。脚本与素材均是此次发布的本机生成文件，未作为仓库的持久构建入口。

输出 `asset-verification.json` 记录版本、视口、密钥库演示边界、生产清单与后台/内容脚本指纹、文件大小及各 PNG 的 SHA-256。五张功能截图均通过真实界面断言，10 张 PNG 核对尺寸后逐张目视审阅；小宣传图 440 × 280，大宣传图 1400 × 560，图标分别为 128 × 128 和 300 × 300。

## v0.11.2 复用范围

v0.11.2 只调整商店字体包装和加载路径，可见阅读、翻译和设置界面未改变，因此继续使用本文件记录的 v0.11.1 原生截图。图片路径和原始版本指纹保持不变，不将其描述成 v0.11.2 的重新截屏证据。
