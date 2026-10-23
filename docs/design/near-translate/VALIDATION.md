# 图标与阅读书签验证

日期：2026-10-22；版本：0.7.0；范围：本次图标资产与 `src/page/Bar.tsx` 的视觉调整。

| 项目 | 结果 |
| --- | --- |
| `node scripts/design/render-brand-assets.mjs` | 通过；导出透明 16/32/48/128/512/1024 px PNG，核对尺寸与透明通道 |
| 实际组件预览 | 通过；待命、运行、完成、失败重试；浅色与深色背景 |
| 悬停与键盘聚焦 | 通过；等待过渡结束后提示框 `opacity=1` |
| 窄屏与短视口独立评审 | 通过；1280×800、320×240、320×180、240×180 下检查按钮及多提示内容，最小视口未裁切 |
| `npm run typecheck` | 通过 |
| `npx vitest run tests/unit/page-bar-state.test.ts tests/unit/page-mount.test.ts` | 10/10 通过 |
| `npm run check:boundaries` | 通过 |
| `npm run build` / `npm run build:edge` | 均通过 |
| Chrome / Edge 清单检查 | 均含 `icon/16.png`、`32.png`、`48.png`、`128.png`；无新增权限 |
| `git diff --check -- src/page/Bar.tsx` | 通过 |

浏览器回归使用隔离 Edge 配置与模拟 API，不消耗用户服务额度。命令：

```powershell
$env:NEAR_BROWSER_CHANNEL = 'msedge'
npm run test:e2e -- tests/e2e/page-translation.spec.ts --grep 'the main|failed paragraph|missing API key|dark pages|stop cancels'
```

6/6 通过（11.9 秒）：深色页面与惰性文本输出；主按钮恢复与缓存重译；部分完成后恢复原文；停止取消且无迟到译文；仅重试失败段落；缺少 Key 时显示设置入口且不发送正文。

环境限制：默认捆绑 Chromium 首次运行在创建浏览器进程时出现 `spawn UNKNOWN`，测试尚未开始；切换本机 Edge 后以上六项全部通过。Chrome 已通过生产构建与图标清单检查，未完成该环境下的浏览器端到端验证。未更新工作区以外的已安装扩展目录。

架构影响：R1；只调整展示标记、顺序与样式。状态、回调、语义标签、诊断属性及生命周期保持，无新增运行时依赖。
