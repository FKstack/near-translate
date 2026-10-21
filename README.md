# 近译 · 整页与划词翻译

Chrome / Edge 的网页中英对照与网页 / PDF 划词翻译扩展，支持多个模型服务的 OpenAI 兼容 API，默认使用 DeepSeek `deepseek-flash`。

点击网页右侧青色翻译按钮，在英文标题和段落下方显示简体中文，保留原文、代码块和图片。双击单词或拖选句段仍可使用附近的「译」按钮；PDF 继续使用扩展自带阅读器划词翻译。

## 安装与使用

完整步骤见 [中文安装说明](docs/INSTALL.md)。

当前版本 **0.7.0**。从源码构建后加载扩展，步骤见下方「开发」。已有安装保留原加载目录，更新程序文件后在扩展管理页重新加载并刷新网页；原 DeepSeek Key、模型和开关会兼容保留。

1. Chrome 打开 `chrome://extensions`，Edge 打开 `edge://extensions`，开启开发者模式。
2. 点击「加载已解压的扩展程序」，选择本机构建的 `.output/chrome-mv3` 或 `.output/edge-mv3` 文件夹（包含 `manifest.json`）。本机生成的 ZIP 需先解压。
3. 打开近译的「翻译设置」，选择服务商，核对 API Base URL 和模型名，填写该服务的 API Key 后保存，并接受该 API 域名的访问请求。默认 DeepSeek 使用 `deepseek-flash`、非思考模式；本地 Ollama 可不填 Key。
4. 点击「启用网页划词」并授予网页访问权限，刷新此前打开的网页。
5. 点击网页右侧青色翻译按钮，查看中英对照；翻译完成后再次点击同一个青色按钮即可恢复英文原文，不会重新请求 API。翻译过程中点击可停止，文档按钮「显示原文」也可移除译文。也可双击英文单词或拖选句段，点击旁边的「译」。

PDF：在在线 PDF 标签页点击扩展图标 →「用阅读器打开当前 PDF」；本地 PDF 在阅读器中点「打开本地 PDF」。选择文字后使用同样的「译」按钮。

## 功能

- 长难句拆解：选中单个英文句子翻译后，在同一张卡片的译文下方展示句子主干、分块阅读和阅读顺序。卡片原句按语法成分彩色标注：主语蓝、谓语红、宾语橙、从句紫、修饰青绿；点击原句片段或对应分块可双向定位，也支持 Tab 聚焦后按 Enter / 空格。原句文字、空白和标点精确保留，不修改网页 DOM 或原选区。颜色与拆解共用原来的「长难句拆解」开关，关闭后不显示任何彩色标记。译文先显示，拆解随后通过独立请求补充，失败可单独重试；彩色标注复用同次分析结果，不增加 API 请求。
- 整页：标题、段落、列表和表格逐段中英对照，跟随页面颜色和字号；保留链接、强调、代码与图片，跳过代码块、编辑器、输入区域、隐藏内容和主要为中文的段落，不做图片 OCR。
- 点击后将短段落合并成批，最多 32 路并发，逐段流式回填；支持进度、停止、恢复原文、手动重试、同文复用和动态新增内容。每次最多 1,500 个段落，超长段落并行分块后按原序合并。
- 单词：本句含义、词性与语境解释；默认展开按词性分组的常见义项，可查看参考原句并完整复制。句段保持流式中文译文和段落结构。
- 所在句 / 邻近一句上下文，最多 600 字符，可关闭；选中内容最多 12,000 字符，超限提示分段。
- 翻译卡片支持复制、Esc 关闭、重试；新选区会取消旧请求。
- 自带 PDF.js 阅读器支持本地/在线文字型 PDF、翻页、缩放、搜索和密码文件。
- 各服务商分别保存模型、API 基址、JSON 模式和 Key，切换服务不会混用 Key。Key 保存在受信任扩展存储，内容脚本不能读取；原文、译文和 PDF 不持久化。整页模式开启后会继续翻译动态新增的英文段落，停止或显示原文后结束。数据流与权限见 [隐私说明](docs/PRIVACY.md)。

整页翻译作用于当前网页主文档，嵌入的 iframe 保留原样，iframe 内仍可独立划词。扫描件需要已有 OCR 文字层才能选词。浏览器内置 PDF 和设置页无法注入翻译按钮，PDF 使用自带阅读器。

## 模型与 API

内置 DeepSeek、OpenAI、Google Gemini、通义千问（百炼）、Kimi / Moonshot、硅基流动、OpenRouter、Ollama 和自定义接口预设。每项预设都可以修改模型名和 API Base URL；预设不代表账户已获模型访问权限，也不代表每个服务都已进行真实连通测试。

使用 **OpenAI Chat Completions 流式 SSE 协议**。Gemini 通过 Google 官方 OpenAI 兼容接口接入；Claude 可经 OpenRouter 或兼容网关使用。原生 Anthropic Messages、OpenAI Responses 接口尚未实现。自定义网关须提供相同的 Chat Completions 流式协议。

Base URL 填服务的接口根路径，例如 DeepSeek 的 `https://api.deepseek.com` 或 OpenAI 的 `https://api.openai.com/v1`，程序追加 `/chat/completions`。远程接口须使用 HTTPS；HTTP 仅允许本机回环地址。服务不支持 `response_format: json_object` 时关闭「JSON 模式」，词典和句法结果仍按结构校验。详情见 [API 配置说明](docs/INSTALL.md#配置模型与-api)。

## 开发

要求 Node.js 24+、npm 11+、当前桌面版 Chrome 或 Edge。

```powershell
npm ci
npm run dev          # Chrome 开发模式
npm run dev:edge     # Edge 开发模式
npm run typecheck
npm test
npm run check:boundaries
npm run build
npx playwright install chromium
npm run test:e2e
npm run build:edge
npm run zip
npm run zip:edge
```

`build` / `build:edge` 分别生成 `.output/chrome-mv3` / `.output/edge-mv3`；`zip` / `zip:edge` 在 `.output` 下生成可解压安装的 ZIP。构建产物不提交 Git。GitHub Actions 使用 Node.js 24 执行类型检查、单元测试、模块边界和两个浏览器目标的构建。

PDF worker、CMaps、字体与解码器由构建前脚本从同一版本 `pdfjs-dist` 复制到本地，无需 CDN。

端到端测试使用隔离配置和模拟 API；仅测试复制品预先授予网页权限，生产安装包仍使用可选权限。可用 `$env:NEAR_BROWSER_CHANNEL='msedge'` 在已安装 Edge 中运行测试。

0.7.0 的多服务协议验证使用模拟响应，不代表这些服务已逐一真实连通。模型可用性、额度、限流和输出质量需结合自己的服务账户验证。

## 扩展与验证

0.4.0 在指定 Go 长文的真实 DeepSeek API 测试中，314 段全文从 115.4 秒降到 3.8 / 3.9 秒，两次均无失败、无本地译文缓存命中。具体条件、首段时间和限制见 [性能实测](docs/PERFORMANCE.md)；该结果是本机两次测量，不保证所有文章或服务时段的耗时。

架构与新增 provider 指南见 [架构说明](docs/ARCHITECTURE.md)，验收记录见 [验证说明](docs/VALIDATION.md)，真实翻译质量样例见 [质量验收表](docs/QUALITY_SAMPLES.md)。

贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。请勿提交 API Key、环境文件、浏览器配置、测试报告或构建产物。本项目使用 [MIT 许可证](LICENSE)，依赖说明见 [第三方许可](THIRD_PARTY_NOTICES.md)。
