# 近译 · 英文划词翻译

Chrome / Edge 的网页与 PDF 划词翻译扩展，默认使用 DeepSeek `deepseek-flash`。

双击英文单词或拖选句段，点击附近的「译」按钮查看简体中文翻译。PDF 通过扩展自带阅读器打开后使用同样的交互。

## 安装与使用

完整步骤见 [中文安装说明](docs/INSTALL.md)。

1. Chrome 打开 `chrome://extensions`，Edge 打开 `edge://extensions`，开启开发者模式。
2. 点击「加载已解压的扩展程序」，选择 `.output/chrome-mv3` 或 `.output/edge-mv3` 文件夹（包含 `manifest.json`）。也可解压交付 ZIP 后选择其根目录。
3. 打开近译的「翻译设置」，填写自己的 DeepSeek API Key，保存；默认模型为 `deepseek-flash`，非思考模式。
4. 点击「启用网页划词」并授予网页访问权限，刷新此前打开的网页。
5. 双击英文单词，或拖选英文句段，点击旁边的「译」。

PDF：在在线 PDF 标签页点击扩展图标 →「用阅读器打开当前 PDF」；本地 PDF 在阅读器中点「打开本地 PDF」。选择文字后使用同样的「译」按钮。

## 功能

- 单词：中文词义、词性与简短语境解释；句段：流式中文译文、段落保留。
- 所在句 / 邻近一句上下文，最多 600 字符，可关闭；选中内容最多 12,000 字符，超限提示分段。
- 翻译卡片支持复制、Esc 关闭、重试；新选区会取消旧请求。
- 自带 PDF.js 阅读器支持本地/在线文字型 PDF、翻页、缩放、搜索和密码文件。
- API Key 保存在受信任扩展存储，内容脚本不能读取；不保存原文、译文或 PDF，也不自动发起翻译。

扫描件需要已有 OCR 文字层才能选词。浏览器内置 PDF 和设置页无法注入翻译按钮，PDF 使用自带阅读器。

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

PDF worker、CMaps、字体与解码器由构建前脚本从同一版本 `pdfjs-dist` 复制到本地，无需 CDN。

端到端测试使用隔离配置和模拟 API；仅测试复制品预先授予网页权限，生产安装包仍使用可选权限。可用 `$env:NEAR_BROWSER_CHANNEL='msedge'` 在已安装 Edge 中运行测试。

## 扩展与验证

架构与新增 provider 指南见 [架构说明](docs/ARCHITECTURE.md)，验收记录见 [验证说明](docs/VALIDATION.md)，真实翻译质量样例见 [质量验收表](docs/QUALITY_SAMPLES.md)。

Git 开发分支：`feat/selection-translation`，按骨架、网页翻译、PDF、验证与文档阶段提交。Key、依赖、构建产物及浏览器测试配置均不进入 Git。
