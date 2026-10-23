# 参与近译开发

## 本地运行

需要 Node.js 24+、npm 11+。在项目根目录执行：

```powershell
npm ci
npm run dev          # Chrome 开发模式
npm run dev:edge     # Edge 开发模式
```

安装与模型配置见 [安装说明](docs/guides/INSTALL.md)，职责与扩展方式见 [架构说明](docs/development/ARCHITECTURE.md)。

`src/` 存放扩展代码，`tests/` 存放单元与浏览器测试。`scripts/` 根目录保留常规构建与检查工具，性能测量、现场诊断、研究实验和品牌生成工具分别位于 `scripts/benchmarks/`、`scripts/diagnostics/`、`scripts/experiments/`、`scripts/design/`。用户指南位于 `docs/guides/`，开发约定位于 `docs/development/`，有日期的研究与验证记录位于 `docs/reports/`；截图、测量证据和设计材料分别保存在 `docs/evidence/`、`docs/design/`。

## 提交前检查

```powershell
npm run check:repo
npm run check:docs
npm run typecheck
npm test
npm run check:boundaries
npm run build
npm run build:edge
```

涉及浏览器交互、PDF、权限或消息传输时，再执行：

```powershell
npx playwright install chromium
npm run test:e2e
```

浏览器测试使用隔离 profile 与模拟 API；不要将测试代码指向个人浏览器 profile 或真实 Key。CI 执行 Git 候选检查、文档链接检查、类型检查、单元测试、模块边界和 Chrome / Edge 构建，浏览器 E2E 需在本地另行运行。`npm run zip` / `npm run zip:edge` 可生成本地安装 ZIP；`package:release` 是需要完整验证证据的发布辅助步骤。

`check:repo` 检查已跟踪文件和未被忽略的候选文件，不暂存或上传文件。其凭证检查覆盖常见格式，提交前仍应查看自己的差异。保留 `third_party/` 中的字体源和许可证；`public/pdfjs/`、`public/fonts/`、`public/licenses/` 由构建脚本生成，不提交 Git。

## 代码与 PR

- 保持 core、provider、平台存储、UI 的单向边界，凭证只能由受信任配置模块和后台管理。
- 新增兼容 API 预设优先修改 `src/shared/api-config.ts`，模型名与基址须可编辑；协议能力应有请求参数、错误、流式中断和凭证隔离测试。
- 不把网页消息变成任意网络请求接口，不向公开设置或内容脚本返回 Key、API 基址和全部 profile。
- PR 说明具体问题、改后行为和已执行验证；真实 API 未测试时明确说明。界面变化可附使用公开材料和模拟数据的截图。
- 不提交 `.env`、Key、私有文本/PDF、浏览器 profile、依赖、构建产物和测试报告。

功能问题请提供扩展版本、浏览器版本、复现步骤和脱敏后的错误信息。涉及凭证泄露的问题不要在公开 Issue 中附上秘密内容；如 Key 已泄露，先在对应服务控制台撤销或轮换。

## 历史性能工具

`scripts/benchmarks/benchmark-installed-page.mjs` 用于复现历史公开 Go 文章的现场测试，会调用已安装扩展的当前 API，可能产生费用。它会临时在指定安装目录写入辅助页面，并在退出时清理；不属于常规测试或 CI。使用前设置环境变量：

```powershell
$env:NEAR_INSTALLED_EXTENSION_DIR = '工作区内已加载扩展目录的绝对路径'
$env:NEAR_INSTALLED_EXTENSION_ID = '浏览器扩展管理页显示的扩展 ID'
$env:NEAR_BROWSER_EXECUTABLE = '浏览器可执行文件的绝对路径'
$env:NEAR_BROWSER_PROFILE_DIRECTORY = 'Default'
npm run benchmark:installed -- --label manual
```

使用该工具前确认目标是自己的安装、已配置的模型与计费账户，并按需刷新扩展页面。历史测量不代表当前模型、其他服务或任意网络条件下的速度。

## 许可证

本项目使用 [MIT 许可证](LICENSE)。提交贡献时请确保你有权按该许可证提供所提交的代码与材料。
