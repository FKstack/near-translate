# 功能分支、线性合并与发布

近译使用同一个仓库维护 Chrome / Edge 扩展和篡改猴版。日常开发在功能分支进行，通过 squash 合并让 `main` 保持线性历史；`main` 更新后自动创建 GitHub Release，再构建安装包与脚本分发源。

## 完成一个功能

本地需要 Node.js 24+、npm 11+、Git 和已登录的 GitHub CLI（`gh`）。Git 推送和 `gh` 均需具有本仓库写权限；仓库检查及分支保护仍会执行。

1. 在 `codex/` 功能分支完成代码和验证，不在 `main` 上运行发布辅助命令。
2. 确定下一个版本，并编写 `docs/releases/v<版本号>.md`。说明用户可见的变化、升级步骤和限制；不要放入 Key、私有材料或测试账户信息。
3. 用 `git diff` / `git status` 核对范围，再用 `git add` 明确暂存本次文件，包括版本说明。不要把本地产物或无关修改一起提交。
4. 从仓库根目录运行，例如当前版本为 0.11.4、下一个补丁版本为 0.11.5 时：

   ```sh
   npm run feature:release -- --bump patch --title "feat: 新功能说明" --notes-file docs/releases/v0.11.5.md
   ```

辅助命令提高 `package.json` / `package-lock.json` 的版本，提交已暂存的修改及版本文件，推送当前分支，创建或复用以 `main` 为目标的 PR。`--notes-file` 用作 PR 正文；Release 说明来自提交到仓库的对应版本 Markdown，不会自动复制外部文件。

命令等待 PR 检查完成，再用 squash 合并，并核对合并时的分支提交仍与检查的提交一致。不会绕过分支保护，也不会删除功能分支。检查失败、合并冲突或保护规则拒绝时，先修复同一分支，再继续原 PR。

### 参数与提交范围

| 参数 | 用途 |
| --- | --- |
| `--bump patch` | 提高补丁版本；默认选择 |
| `--bump minor` / `--bump major` | 按功能与兼容性范围提高版本 |
| `--bump none` | 已手动提高版本时使用；版本必须高于 `origin/main` 且尚未被发布标签占用 |
| `--title "说明"` | 提交与 PR 的标题，描述最终用户可见变化 |
| `--notes-file 路径` | PR 正文文件；推荐使用对应版本的发行说明 |
| `--dry-run` | 只读取本地状态并展示计划，不 fetch、不改版本、不暂存、不提交或推送 |
| `--all` | 明确将全部未忽略候选文件纳入本次提交，使用前核对范围 |

默认不执行 `git add -A`。已跟踪文件存在未暂存修改时会停止，避免暂存内容与实际发布内容不同；请先明确暂存需要的文件。干净工作区也可以仅提高版本后发布已有提交。

## main 合并后发生什么

1. **Release main** 在 `main` 更新后读取版本。若版本已被其他提交发布，补丁版本会继续递增，并以普通线性提交更新版本文件；不会改写旧提交或移动已发布标签。
2. 创建与版本一致的 `v<版本号>` 标签及 GitHub Release。优先使用 `docs/releases/v<版本号>.md`；缺少该文件时由 GitHub 生成说明。
3. 直接调用可复用的 **Publish userscript** 工作流：检查仓库、文档、类型、单元测试和模块边界，构建 Chrome / Edge ZIP、GitHub 脚本及 Greasy Fork 脚本，运行两种脚本的隔离浏览器测试，添加 Release 附件并部署 Pages。
4. Greasy Fork 从已配置的公开 Pages 同步源按平台时机拉取新版。核对其公开页面版本后，才表示该渠道已能安装新版。

由 `GITHUB_TOKEN` 创建 Release 通常不会再次触发另一个 Actions 工作流，所以自动发布链直接调用可复用工作流；不依赖额外 PAT。手动发布正式 Release 的 `published` 事件也可触发相同构建。相关行为见 [GitHub 工作流触发说明](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow)。

普通功能分支 push / PR 不向用户发行更新。新流程使用 `v<版本号>` Release；历史 `userscript-v*` 标签继续保留，但仅推送标签不再触发发行部署。Release 出现早于构建结束，需等待 **Publish userscript** 成功后再把安装地址作为可用新版发给用户。

### 仅发行 Chrome / Edge 扩展

用户明确限定只发布浏览器扩展时，在本次版本对应的 `docs/releases/v<版本号>.md` 中单独写一行 `<!-- release-scope: extensions-only -->`。发布工作流从精确 Release 标签的版本说明读取此标记；缺少标记时仍执行完整发行，标记只作用于对应版本。

仅扩展发行仍执行仓库、文档、类型、单元测试、模块边界、两种扩展构建和两种脚本浏览器检查。Release 仅上传 Chrome / Edge ZIP、发行清单及校验文件；跳过脚本附件、脚本发行产物上传及 Pages 部署。已有官网、脚本安装文件与两渠道更新源保持原版本，Greasy Fork 同步源不会因这次发行而变化。

## Greasy Fork 同步的边界

当前公开脚本：[近译 · 网页阅读与翻译（601973）](https://greasyfork.org/zh-CN/scripts/601973)。平台自动同步源为：

- 脚本：`https://fkstack.github.io/near-translate/greasyfork/near-translate.user.js`
- 说明：`https://fkstack.github.io/near-translate/greasyfork/description.md`

Actions 自动构建和部署源文件，Greasy Fork 负责后续拉取；当前没有配置即时 webhook，不能保证 Release 发布后立刻同步完成。需要加快某次发布时，作者可在 Greasy Fork 的「同步」页手动同步，再核对公开版本。CI 不保存 Greasy Fork 的登录会话或作者凭证。

Greasy Fork 官方 GitHub webhook 要求作者专属 secret，并匹配其支持的 GitHub raw 或 Release 附件同步地址；当前 Pages 地址不属于这些格式。它只处理 Release 的 `published` 事件，附件须在正式发布时已存在，发布后再上传附件不会自动补同步。若未来启用，需要单独设计同步源迁移、凭证配置和 Release 资产上传时序。依据为 [Greasy Fork 官方 webhook 说明源码](https://github.com/greasyfork-org/greasyfork/blob/main/app/views/users/webhook_info.html.erb)、[签名与事件处理](https://github.com/greasyfork-org/greasyfork/blob/main/app/controllers/concerns/webhooks.rb)及[附件匹配实现](https://github.com/greasyfork-org/greasyfork/blob/main/lib/github.rb)。

## 仓库设置与核验

仓库需允许 squash 合并；主分支应要求线性历史，并保留适合本项目的检查和审阅规则。发布命令遵循这些规则，不能保证绕过待审批的 PR。工作流需具有写入 Release 和部署 Pages 的权限。

Pages 的 Source 选择 **GitHub Actions**，`github-pages` environment 允许 `v*` 标签部署；配置额外审批时，维护者按 GitHub 提示批准。Pages 每次部署替换整个站点，新增其他站点内容时应先合并到 `.output/userscript-site/`。

发布后分别核对：

- GitHub Release 的标签、提交、说明与附件版本一致。
- Actions 构建和 Pages 部署成功，GitHub `.user.js` / `.meta.js` 以及 Greasy Fork 同步源均显示目标版本。
- Greasy Fork 公开页面和安装脚本已显示目标版本。
- 在篡改猴确认安装后刷新网页，再验证阅读、网页翻译和划词；真实模型未实测时在交付说明中明确标注。

构建失败时从 Actions 运行记录核对失败步骤并重试；修复涉及代码时发布更高版本。不要移动已经提供给用户的旧标签。GitHub Release 完成、Pages 部署完成、Greasy Fork 同步完成和用户完成安装是独立状态。

## 用户如何收到更新

0.11.4 起的脚本在用户主动使用阅读或翻译时检查当前安装渠道的版本，每个渠道至多每天联网检查一次。缓存中发现新版后，每次主动使用都会确认：取消继续当前功能，下次使用继续提醒；确定打开同渠道安装页，由篡改猴完成确认，更新后刷新文章。

提醒不会替代管理器的更新策略。要保证每次更新都由用户选择，用户需单独关闭近译的篡改猴内建自动更新。0.11.3 及更早版本需先手动升级一次；GF 平台同步与本地检查缓存都可能延迟提醒。安装和详细限制见[篡改猴版指南](../guides/USERSCRIPT.md#更新提醒与安装)。
