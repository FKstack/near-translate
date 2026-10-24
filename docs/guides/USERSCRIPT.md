# 近译篡改猴版：安装、更新与发布

篡改猴版提供网页双语翻译、划词翻译与阅读模式，复用近译的阅读、翻译界面和模型配置。原来的 Chrome / Edge 扩展继续保留；PDF 阅读器和文档转换仍使用扩展版。扩展版与篡改猴版的设置分别保存，不会自动迁移。

篡改猴版由本仓库的 `src/userscript/main.tsx` 及共用的网页、划词和阅读模块构建。安装文件是可直接执行的 JavaScript 成品，不是仓库内的 TypeScript / React 源文件。GitHub Release 对应的提交决定发布内容；只修改或推送功能分支不会改变用户已安装的脚本。安装、设置和[完整使用指南](https://fkstack.github.io/near-translate/userscript/guide.html)一同发布，更新文件使用固定地址。

## 安装

1. 安装 [Tampermonkey（篡改猴）](https://www.tampermonkey.net/) **5.4 或更新版本**，按它的提示允许浏览器运行用户脚本。Chrome / Edge 的要求见 [Tampermonkey 官方说明](https://www.tampermonkey.net/faq.php#Q209)。网络请求会校验管理器及版本，以保证匿名请求和拒绝重定向得到支持；旧版管理器仍可本地阅读，但不能发送翻译请求。
2. 打开 [Greasy Fork 上的近译](https://greasyfork.org/zh-CN/scripts/601973)，点击安装；也可选择 [GitHub 分发安装页](https://fkstack.github.io/near-translate/userscript/)。后续更新沿用所选渠道。
3. 在篡改猴的安装页核对名称、源地址和权限后确认安装。
4. 刷新需要阅读的文章页。从页面上的近译入口进入阅读模式或翻译网页；选中文字可显示划词翻译入口。

同一网站请只启用一种近译安装方式，避免扩展版与脚本版同时出现工具栏、划词卡片或重复发送翻译请求。浏览器内部页面、扩展商店、PDF 页面和内嵌框架不属于本版的处理范围。

## 配置翻译服务

从篡改猴的近译菜单打开设置，或访问专用的[近译设置页](https://fkstack.github.io/near-translate/userscript/settings.html)。设置界面由已安装的脚本在这个固定地址显示；未安装脚本时只显示静态说明。

- 无需模型 Key 的实验性 DeepL 免费翻译可在设置中启用；可能受上游限流影响。
- 使用自己的模型时，在设置页填写兼容 API 地址、模型和 Key，并设置独立的保护口令。Key 加密保存在篡改猴的脚本存储中，不会提交到 GitHub。
- 配置完成后返回文章页，从篡改猴菜单选择「解锁本页模型 Key」，在浏览器提示框中输入保护口令。模型解锁状态只留在当前页内存；新标签页、刷新后的页面均需重新解锁。
- 模型 Key 解锁需要浏览器提供安全加密环境，通常是 HTTPS 页面或本机地址。普通 HTTP 页面仍可本地阅读和使用免费翻译；无法安全解锁时会提示改用 HTTPS。
- 连接自定义域名时，篡改猴可能另行请求网络授权。请核对实际使用的服务地址再允许；拒绝授权后，请求不会成功。模型服务可能按自身规则计费。

模型 Key 只应在专用设置页输入。脚本在普通网页中显示阅读与翻译界面，普通网页上只通过浏览器提示框解锁口令。不要把 API Key 填进网站自己的表单或脚本反馈内容。

`@connect` 声明列出了预设服务及本机模型地址，同时保留 `*` 以支持用户自己的兼容 API。此声明允许篡改猴对新增域名提供授权选择；实际请求由用户配置和翻译操作决定。没有配置模型 Key 时，阅读模式仍可在本机使用。正文、选区和可选上下文只在使用翻译时发送至所选服务；GitHub 只提供公开脚本和版本文件，不是翻译代理。

## Greasy Fork 分发

Greasy Fork 使用独立的可阅读构建，业务代码不压缩，且限制在 2 MB 内。OpenCC 1.4.2 和 Mozilla Readability 0.6.0 通过固定版本、带 SHA-256 校验的官方 CDN 库加载；React 等需要共享模块状态的 CommonJS 库保留在包内并注明来源和许可证。

```sh
npm run build:greasyfork
npm run test:greasyfork
```

待上传脚本在 `.output/greasyfork/near-translate.user.js`，中文上架说明见 [GREASYFORK_LISTING.md](GREASYFORK_LISTING.md)。发布工作流也会同时提供以下固定同步源：

- 脚本：`https://fkstack.github.io/near-translate/greasyfork/near-translate.user.js`
- 说明：`https://fkstack.github.io/near-translate/greasyfork/description.md`

公开脚本为 [近译 · 网页阅读与翻译](https://greasyfork.org/zh-CN/scripts/601973)，已使用上述脚本与说明源配置平台自动同步。Release 发布流程构建并部署这些源，Greasy Fork 再按平台的同步时机拉取；两者之间可能有延迟。维护者可在 Greasy Fork 的「同步」页手动同步并核对公开版本。不要把压缩的 GitHub 版或 TypeScript 源文件用作同步源。通过 Greasy Fork 安装的版本由其改写更新地址并从 Greasy Fork 更新。

## 更新提醒与安装

从 0.11.4 起，主动翻译网页、划词翻译、重试翻译或进入阅读模式时，脚本会检查是否有新版；单纯加载网页不会发起版本检查。发现新版后弹出确认框：

- 取消：继续使用当前版本；下次主动使用近译时再次提醒，不会永久忽略这个版本。
- 确定：打开当前安装渠道的脚本安装页，暂停本次操作。请在篡改猴中确认更新，再刷新文章页使用新版。

版本信息跨页面缓存，每个安装渠道至多每天联网检查一次；失败也会缓存，网络不可用时继续使用当前功能。因此新版本发布或 Greasy Fork 完成同步后，提醒可能还需等待缓存到期。Greasy Fork 安装只检查 Greasy Fork 的版本，GitHub 安装只检查 Pages 的版本，不会因为两个渠道的同步时间不同而引导用户换渠道。每日检查上限遵循 [Greasy Fork 脚本规则](https://greasyfork.org/zh-CN/help/code-rules)。

**要每次升级都由自己选择，请在篡改猴中单独关闭近译的内建自动更新。** 近译的确认框不能阻止管理器自行安装更新；保留管理器自动更新时，它可能先完成升级。0.11.3 及更早的脚本没有此提醒功能，需先从原安装渠道手动更新一次，升级到 0.11.4 或更高版本后才会生效。

### 篡改猴的内建更新

篡改猴读取脚本头部的三个字段：

| 字段 | 固定值或来源 |
| --- | --- |
| `@version` | 仓库 `package.json` 的 `version` |
| `@updateURL` | `https://fkstack.github.io/near-translate/userscript/near-translate.meta.js` |
| `@downloadURL` | `https://fkstack.github.io/near-translate/userscript/near-translate.user.js` |

上表是 GitHub 安装渠道的字段。Greasy Fork 会将更新与下载地址改写为它自身的地址。篡改猴按照自身设置的周期检查版本，发现更高版本后从下载地址获取脚本；安装或权限变化时按其提示处理。用户也可以在篡改猴管理面板手动检查更新。具体行为见 [Tampermonkey 更新字段说明](https://www.tampermonkey.net/documentation.php?q=update_url)。

发布时必须提高 `package.json` 的版本（例如 `npm version patch --no-git-tag-version`，同时更新 lockfile），再一起发布 `.meta.js` 与 `.user.js`。只替换文件而不提高版本，不会向已安装用户提供版本升级。固定的脚本名称、命名空间与更新地址应保持稳定。

## 从源码构建

```sh
npm ci
npm run typecheck
npm test
npm run build:userscript
```

构建复用仓库已有的 Vite，不增加运行时 CDN 或 `@require` 依赖，也不准备 PDF、字体或文档转换资源。产物位于：

- `.output/userscript/near-translate.user.js`：完整安装脚本，内含运行代码、样式与第三方许可证。
- `.output/userscript/near-translate.meta.js`：与完整脚本相同的元数据头，供版本检查使用。
- `.output/userscript-site/`：可整体部署的 GitHub Pages 站点，其中 `userscript/` 包含上述脚本、安装说明 `index.html`、设置空壳 `settings.html` 和完整指南 `guide.html`。指南在构建时由本文件渲染为静态 HTML，不加载运行时 Markdown 解析器或外部 JavaScript。

本地安装可在篡改猴管理面板新建脚本，将 `.user.js` 全部内容粘贴进去保存。该构建仍指向正式 Pages 更新地址；需要锁定本地开发版时，在篡改猴中单独关闭该脚本的更新检查。自动更新的最终核验应使用正式 HTTPS 分发地址。

原扩展的 `npm run build`、`npm run build:edge` 和打包命令保持可用。普通 CI 同时构建两个扩展及篡改猴脚本，并把脚本作为 `near-translate-userscript` artifact 提供下载；用户分发由 Release 发布工作流执行。

`npm run test:userscript` 构建脚本并在独立 Chromium 中验证阅读、网页翻译、划词和设置入口；运行前用 `npx playwright install chromium` 准备测试浏览器。测试使用模拟的 GM API 与翻译响应，不访问个人浏览器配置或真实模型账户；篡改猴实际安装、网络授权和自动更新仍应在发布后的 HTTPS 地址做一次人工核验。

## 维护者发布流程

完成新特性后，通过 [功能分支发布流程](../development/RELEASE_WORKFLOW.md)提交、推送、创建 PR 并 squash 合并到 `main`。主分支保持线性历史；合并后自动创建 `v<版本号>` GitHub Release 和版本说明，再构建、验证并部署 GitHub Pages 分发源。原来的 Chrome / Edge 扩展继续构建并提供 ZIP。

普通功能分支 push 或 PR 不发布用户更新；`main` 合并后的 Release 才开始发行构建。历史 `userscript-v*` 标签保留，但不再作为新版本的发布入口。GitHub Release 已创建、Pages 已部署、Greasy Fork 已同步、用户已确认安装是不同阶段，维护者应分别核对。GitHub Actions 不保存 Greasy Fork 账号凭证；当前使用已配置的平台自动同步，不保证 Release 发布后立即更新 Greasy Fork。

仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**；`github-pages` environment 需允许新的 `v*` 标签部署。额外审批和分支保护仍由 GitHub 执行。失败后从 Actions 核对日志并重试原发布流程；已发布版本需要代码修复时使用更高版本，不移动旧标签。

GitHub Pages 的单次部署代表整个站点；这个流程的站点根目录由 `.output/userscript-site/` 提供。如果仓库以后增加其他 Pages 内容，应在这个构建目录合并后再发布。迁移仓库名或更换域名时，也需要设计旧更新地址的衔接，避免已安装用户失去更新来源。

工作流依据 [GitHub Pages 官方自定义工作流说明](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) 配置。脚本使用的 `@sandbox DOM` 及网络授权见 [Tampermonkey 沙箱说明](https://www.tampermonkey.net/documentation.php?q=sandbox)和[跨域连接说明](https://www.tampermonkey.net/documentation.php?q=connect)。
