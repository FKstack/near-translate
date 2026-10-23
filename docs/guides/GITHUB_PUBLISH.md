# 上传 GitHub 前的准备

目录已按源码、测试、工具和文档分开，完整索引见[文档首页](../README.md)和[脚本索引](../../scripts/README.md)。本指南用于把当前源码提交到你选择的 GitHub 仓库；目录整理不会自动创建远程仓库、暂存、提交或推送。

## 上传内容

提交 `src/`、`tests/`、`scripts/`、`docs/`、`.github/`、`public/` 中的图标和品牌源、`third_party/`，以及根目录的许可证、说明、配置与 npm 锁文件。`third_party/fonts/` 的完整压缩字体是离线 PDF 构建所需源文件，应一并提交。

`.gitignore` 排除依赖、构建、安装备份、测试输出、环境文件，以及 `public/pdfjs/`、`public/fonts/`、`public/licenses/` 等生成目录。实际浏览器配置和已安装扩展位于忽略的本机目录，不通过整目录拖拽上传。使用 Git 候选文件可以保留这些边界。

文档中的历史证据保留当时版本、失败结果、工作区路径和扩展标识，用于解释测量边界。没有随仓库保存的 `.output` 历史文件已经标注为未归档。新增截图、报告或 Issue 时应使用公开例句，移除 Key、授权头、私人文章、账户资料和浏览器配置。

## 本地检查

从项目根目录执行：

```sh
npm ci
npm run check:repo
npm run check:docs
npm run typecheck
npm test
npm run check:boundaries
npm run build
npm run build:edge
```

`check:repo` 检查当前跟踪文件和未忽略候选的生成产物、文件大小及常见凭证形状，输出只包含文件名和问题类型；它不会读取忽略的浏览器配置，也不会暂存或推送。它检查当前候选，不扫描全部 Git 历史。提交前仍应审阅差异；如曾提交过真实凭证，应先撤销该凭证并处理历史，再公开仓库。

`check:docs` 检查文档内的仓库相对链接，避免只在本机可用的路径进入导航。模型服务与浏览器的运行方法见[贡献说明](../../CONTRIBUTING.md)。

## 首次推送

在 GitHub 新建一个空仓库，名称和可见性由你决定；本地已经有 README、许可证和忽略文件，创建远程时无需再生成这些文件。

确认候选与差异后执行：

```sh
git status --short
git add .
git diff --cached --stat
git diff --cached
git commit -m "Prepare Near Translate for GitHub"
```

审阅时确认源码新增模块、`third_party/` 和新目录都已包含，生成目录与本地配置未被暂存。当前项目已有 Git 历史，应保留它；无需重新执行 `git init`。

如果尚未配置 `origin`，替换以下地址中的账户和仓库名，再执行：

```sh
git remote add origin https://github.com/YOUR_ACCOUNT/YOUR_REPOSITORY.git
git push -u origin HEAD
```

如果已有远程，先检查其指向，按实际情况使用现有远程；不要覆盖未知配置或强制推送。推送后在 Actions 页面查看自动检查结果。新增工作流已在本地检查，但远程 Actions 是否成功以实际运行结果为准。

## 安装包与源码分开

构建和 ZIP 输出放在忽略的 `.output/` 中，按需执行 `npm run zip`、`npm run zip:edge`。确认 ZIP 包版本、文件和许可后，可作为 GitHub Release 附件上传；不把浏览器运行时、安装备份、依赖、测试配置或整个 `.output` 上传为源码。

`npm run package:release` 是更严格的历史验收打包工具，需要对应版本的单测与浏览器报告，具体输入见[脚本索引](../../scripts/README.md)。创建源码仓库不需要先运行它。
