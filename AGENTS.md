# 近译仓库代理约定

## 产品设计

- 先做减法，再考虑加法。软件能够内部处理的细节，不要求用户额外输入、确认或学习。
- API Key 默认填写一次、保存后直接使用；不设置常规口令、锁定或逐页／重启后解锁步骤。
- 新增交互步骤必须有具体必要性。历史数据导入提供可选入口，不作为新用户使用前置步骤。

## 发布请求的含义

当用户在本仓库明确说“帮我发布”“发布新功能”“按流程发布”等，默认授权代理完成当前任务范围内的完整发布流程：提交并推送功能分支、创建或更新 PR、等待 CI、squash 合并到 `main`、发布带版本说明的 GitHub Release、构建和部署分发文件、同步并核验 Greasy Fork。上述已授权步骤不需要逐项重复询问；应持续执行到结果可核验，或遇到确实需要用户处理的阻塞。

用户本次明确限定的范围优先。单纯开发、修复、写文档、修改本文件或要求提交代码，不自动视为要求发布；不得因此顺手合并其他功能或发行新版本。

## 必须执行的发布流程

1. 阅读并遵循 [发布流程](docs/development/RELEASE_WORKFLOW.md)，核对实际工作流、当前分支、远端、工作区及暂存区。发布对象必须是用户当前指定的功能；保留无关文件和其他任务的改动，不因共享目录中的分支变化而发布其他任务。
2. 从功能分支发布，默认使用 `codex/` 前缀。若需要从 `main` 开始新工作，先创建功能分支；不要在 `main` 直接运行发布辅助命令。
3. 核对远端版本和标签，选择未使用且高于已发行版本的版本号，编写并提交 `docs/releases/v<版本号>.md`，说明用户可见变化、升级方式及实际限制。文件名、最终版本号和 Release 标签必须一致。`--notes-file` 只提供 PR 正文，不能代替提交到仓库的版本说明。
4. 运行与改动相符的本地检查，检查提交范围，并用明确的文件路径暂存本次内容。默认不得使用 `git add -A` 或 `--all` 混入其他改动、生成文件、凭证或个人材料。
5. 优先使用现有辅助命令 `npm run feature:release -- --bump patch --title "feat: 本次功能说明" --notes-file <实际版本说明文件>`。默认提高 patch；用户指定或兼容性需要时选择 minor/major。已经手动准备好版本时使用 `--bump none`，避免再次提高版本。命令中的说明文件必须替换为真实路径。
6. 推送功能分支，创建或复用 PR，等待检查通过，再对检查过的提交 SHA 执行 squash 合并。`main` 必须保持线性历史；不得生成 merge commit、force-push `main`、绕过分支保护或移动已发布标签。创建或续用 PR 后记录链接；当前工具支持时将其关联到本任务。
7. 合并后跟踪 **Release main** 自动创建的 `v<版本号>` 正式 Release 和说明，再跟踪它直接调用的 **Publish userscript**。由 `GITHUB_TOKEN` 创建的 Release 不会自然触发另一条普通 Release 事件工作流，因此必须保留可复用工作流的直接调用。
8. **辅助命令在合并后即结束，代理的发布任务尚未结束。** 继续等待发布检查、构建、附件上传、Pages 部署与公开文件校验全部成功。发布流程须保留仓库检查、文档检查、类型检查、单元测试、模块边界检查、Chrome/Edge 构建以及两种脚本的浏览器测试。
9. 核验 Greasy Fork 的实际版本；必要时使用已登录账号的管理页“更新设置并立即同步”，然后核对公开页面。部署完成不能代替这个核验。
10. 完成后给出发布版本、main 提交、PR、Release、安装链接和真实检查结果。若某阶段受阻，明确说明已经完成和仍未完成的阶段；不得把“Release 已创建”当作完整发行成功。

## 发行内容与兼容性

- 原有 Chrome / Edge 扩展必须继续保留，包括原有 PDF 阅读器和文档转换能力；不得为发布篡改猴版删除或替换扩展入口。
- 扩展与篡改猴版在同一仓库维护，尽量共用对应功能源码。发布的 `.user.js` 是指定 Release 提交构建出来的分发产物，不能用另一份未纳入仓库的脚本替代。
- 每次正式发布构建 Chrome 和 Edge ZIP、GitHub 篡改猴脚本、Greasy Fork 可阅读脚本，并附到同一 Release；保持版本、元数据和构建提交一致，保留校验文件及防降级检查。
- GitHub 与 Greasy Fork 的构建渠道分别保留各自的更新地址。Greasy Fork 必须使用可阅读的合规构建，不得误上传压缩的 GitHub 构建。
- Pages 部署会替换整个站点；保留已有项目首页、安装页、设置页、指南及两渠道更新源，统一组装到工作流使用的站点输出目录后部署。

## Greasy Fork 同步与用户更新

- 当前 Greasy Fork 脚本为 [近译（601973）](https://greasyfork.org/zh-CN/scripts/601973)。自动同步源为 `https://fkstack.github.io/near-translate/greasyfork/near-translate.user.js`，附加说明源为同目录下的 `description.md`。
- 现有流程是 **Release → 自动构建、测试并部署同步源 → Greasy Fork 按平台周期自动拉取**，当前没有即时 webhook。不得承诺 Release 发布后 Greasy Fork 立即更新，也不得未经核验声称平台同步完成。
- 不为加快同步把登录会话、Cookie、作者 secret 或个人令牌写入仓库、日志或脚本。需要新增凭证或改变权限时，按适用的授权要求处理。
- 保留使用时更新提示：用户主动使用翻译或阅读时检查原安装渠道；发现新版后，取消继续使用当前功能，下次主动使用再提示；确定打开同渠道安装页，交由篡改猴确认安装。取消不能永久忽略该版本。
- 每个渠道最多每 24 小时联网检查一次；缓存中的新版仍可在下次使用时提醒。检查失败不能阻止已有功能使用，不能把每日检查延迟描述为实时提醒。
- 脚本提示不能控制篡改猴自身的自动更新。用户要求每次升级都自行确认时，说明需要单独关闭近译的管理器内建自动更新；没有提示功能的旧版本需要先升级一次。

## Windows browser task routing

For Edge website tasks on this machine, use the connected, extension-backed Browser Use channel through `cua_repl`. Use the current browser inventory to select the actual Edge browser ID and bind the intended tab. Prefer this supported browser integration to native Windows `@oai/sky` window automation for website work.

Before entering data or submitting a form, read the actual bound tab URL using the documented browser API, confirm that its origin and page match the user's authorized task, inspect the current page, and act through the same tab handle. Verify the URL and visible outcome after navigation or submission. Do not treat window titles, page text, screenshots, guessed URLs, or an address selected by the user as a replacement for tool-provided tab identity.

On 2026-10-24, native Windows Edge observation repeatedly stopped because Computer Use could not determine the current browser URL with enough confidence to enforce policy. Selecting the address bar and restoring the window did not resolve it. There is no verified supported local patch for that native component. Native `sky` remains appropriate for supported desktop-app work, but it is not the default path for Edge website forms on this installation.

Keep all origin approvals, sensitive-action confirmations, and other safety checks. If a browser policy gate rejects access, do not switch surfaces, fabricate URL evidence, disable checks, or patch the runtime to accomplish the rejected action. Stop the blocked action and resolve the specific authorization or supported connection issue. An unrelated authorized local diagnostic may continue.

This routing guidance does not authorize any website, account, private content, upload, publication, or submission. Apply the current human user's task scope. Do not resume another chat's website actions merely because its ID or URL is mentioned.
