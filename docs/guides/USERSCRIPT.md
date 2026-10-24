# 近译篡改猴版：安装、更新与发布

篡改猴版提供网页双语翻译、划词翻译与阅读模式，复用近译的阅读、翻译界面和模型配置。原来的 Chrome / Edge 扩展继续保留；PDF 阅读器和文档转换仍使用扩展版。两种安装方式的设置分别保存，不会自动迁移。

本功能分支提供可构建的脚本和 GitHub Pages 发布流程。安装、设置和[完整使用指南](https://fkstack.github.io/near-translate/userscript/guide.html)一同发布，更新文件使用固定地址。

## 安装

1. 安装 [Tampermonkey（篡改猴）](https://www.tampermonkey.net/) **5.4 或更新版本**，按它的提示允许浏览器运行用户脚本。Chrome / Edge 的要求见 [Tampermonkey 官方说明](https://www.tampermonkey.net/faq.php#Q209)。网络请求会校验管理器及版本，以保证匿名请求和拒绝重定向得到支持；旧版管理器仍可本地阅读，但不能发送翻译请求。
2. 打开[近译篡改猴安装页](https://fkstack.github.io/near-translate/userscript/)，点击「安装近译」；也可直接打开 [near-translate.user.js](https://fkstack.github.io/near-translate/userscript/near-translate.user.js)。
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

## 自动更新

篡改猴读取脚本头部的三个字段：

| 字段 | 固定值或来源 |
| --- | --- |
| `@version` | 仓库 `package.json` 的 `version` |
| `@updateURL` | `https://fkstack.github.io/near-translate/userscript/near-translate.meta.js` |
| `@downloadURL` | `https://fkstack.github.io/near-translate/userscript/near-translate.user.js` |

篡改猴按照自身设置的周期检查版本，发现更高版本后从下载地址获取脚本；安装或权限变化时按其提示处理。用户也可以在篡改猴管理面板手动检查更新。具体行为见 [Tampermonkey 更新字段说明](https://www.tampermonkey.net/documentation.php?q=update_url)。

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

原扩展的 `npm run build`、`npm run build:edge` 和打包命令保持可用。CI 同时构建两个扩展及篡改猴脚本，并把脚本作为 `near-translate-userscript` artifact 提供下载；CI 本身不会发布更新。

`npm run test:userscript` 构建脚本并在独立 Chromium 中验证阅读、网页翻译、划词和设置入口；运行前用 `npx playwright install chromium` 准备测试浏览器。测试使用模拟的 GM API 与翻译响应，不访问个人浏览器配置或真实模型账户；篡改猴实际安装、网络授权和自动更新仍应在发布后的 HTTPS 地址做一次人工核验。

## 首次启用 GitHub 分发

1. 提交并推送已审阅的功能分支；首版使用 `codex/feature-tampermonkey`。标签触发的工作流从标签所指向的提交读取，不要求先合并到默认分支。
2. 仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**；将 `github-pages` environment 的部署规则设为允许 `userscript-v*` 标签。后续从默认分支手动发布时，也可允许 `main` 分支。若另有审批规则，由维护者在 GitHub 完成审批。
3. 核对 `package.json` 和 `package-lock.json` 的版本一致，完成验证后，从该提交创建并推送 `userscript-v<版本号>` 标签。首版为 `userscript-v0.11.2`：

   ```sh
   git tag userscript-v0.11.2
   git push origin userscript-v0.11.2
   ```

4. 标签推送触发 **Actions → Publish userscript**。工作流要求标签中的版本严格等于 `package.json` 的版本，并完成仓库检查、文档检查、类型检查、单元测试、模块边界检查、脚本构建和篡改猴浏览器测试后，上传站点并通过 `github-pages` environment 发布。
5. 确认安装页、设置页、完整指南、`.user.js` 和 `.meta.js` 均可通过上面的固定地址访问，再在篡改猴安装页核对版本并完成一次安装/手动更新验证。

后续更新重复「提高版本及 lockfile → 验证并提交 → 创建并推送对应的新发布标签」。普通分支 push 与 pull request 不会发布站点；推送 `userscript-v*` 标签会触发发布。已发布标签保持不变，修复后使用更高版本的新标签。

工作流也保留手动触发支持。工作流文件进入默认分支后，GitHub 才会显示 **Run workflow** 入口；手动运行仍须选择 environment 允许部署的发布引用。当前标签发布流程无需该入口。

GitHub Pages 的单次部署代表整个站点；这个流程的站点根目录由 `.output/userscript-site/` 提供。如果仓库以后增加其他 Pages 内容，应在这个构建目录合并后再发布。迁移仓库名或更换域名时，也需要设计旧更新地址的衔接，避免已安装用户失去更新来源。

工作流依据 [GitHub Pages 官方自定义工作流说明](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) 配置。脚本使用的 `@sandbox DOM` 及网络授权见 [Tampermonkey 沙箱说明](https://www.tampermonkey.net/documentation.php?q=sandbox)和[跨域连接说明](https://www.tampermonkey.net/documentation.php?q=connect)。
