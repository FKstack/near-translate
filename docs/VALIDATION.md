# 验证记录

## 本次结果

| 检查 | 结果 |
| --- | --- |
| TypeScript 严格类型检查 | 通过 |
| Vitest 单元测试 | 90 / 90 通过（6 个文件） |
| 模块依赖边界 | 通过；同时检查别名与相对路径 |
| Chrome for Testing 156.0.8078.4 | 15 / 15 端到端测试通过，23.1 秒 |
| 本机 Edge 155.0.4283.45 | 15 / 15 端到端测试通过，23.2 秒 |
| 实际浏览器 PDF.js 本地 worker、字体与文字层 | 两个浏览器通过 |
| 真实 DeepSeek API 及翻译质量 | 尚未执行；未提供真实 API Key |

## 自动化覆盖

单元测试覆盖：输入与上下文上限、提示词策略、单词字段校验、SSE分块/UTF-8/CRLF/心跳、空或截断响应、401/402/429/5xx、断网、25秒首响应与30秒数据空闲期限、AbortSignal/reader清理；选区分类、600字符句子边界、浮层几何、Port心跳、过期结果、95秒前台保护与重连；PDF地址策略、会话失效、权限请求的用户手势、旧文件异步读取、密码与取消、无文字检测、HTTP失败及幂等销毁。

每个浏览器执行15项集成场景：

1. 生产安装包保留可选网页权限，未新增 tabs 权限。
2. 双击单词、点击后才请求、词义/词性/解释、复制与关闭。
3. 句段流式输出与换段保留。
4. 上下文开关与默认 deepseek-flash/非思考配置。
5. 总开关暂停注入和交互。
6. 网页权限撤回广播停止旧页面，PDF仍可独立使用。
7. iframe中的选择与页面请求隔离。
8. 无Key时显示配置入口。
9. 新选择取消旧请求，迟到译文不能覆盖新内容。
10. 模型返回的HTML保持纯文本，服务失败后用户重试。
11. 可编辑区域、屏幕边缘定位与超长选择提示。
12. 本地PDF、跨页选择、页码跳转、缩放和搜索。
13. 损坏PDF、无文字页面提示与恢复。
14. 密码错误、正确密码、取消与替换文件。
15. 在线PDF与服务器拒绝后的本地文件后备流程。

## 测试隔离与复现

后台fetch在隔离测试进程中替换为SSE模拟接口，并配置真实API请求阻断；没有使用真实Key，也没有产生DeepSeek调用费用。测试副本位于 `.output/e2e-extension`，只有该副本预先授予HTTP(S)权限以避开浏览器原生确认对话框。复制脚本断言生产manifest保持不变。

```powershell
npm run typecheck
npm test
npm run check:boundaries
npm run build
$env:NEAR_BROWSER_CHANNEL = 'msedge'
npm run test:e2e
```

Chrome可用默认Playwright安装；如需要指定可执行文件：

```powershell
$env:NEAR_BROWSER_CHANNEL = 'chromium'
$env:NEAR_BROWSER_EXECUTABLE = '浏览器可执行文件的绝对路径'
npm run test:e2e
```

本机Playwright原缓存目录出现Windows SideBySide激活错误。将浏览器原样复制到工作区隔离目录后启动成功，EXE与manifest的SHA256保持一致；没有修改系统设置、安全策略或程序集。此问题属于测试环境，生产扩展不依赖该目录。

## 证据与未验证范围

交付目录 `artifacts` 包含Chrome/Edge截图、测试HTML报告和安装包SHA256。截图的译文由模拟接口产生，只用于证明布局和交互。

真实模型准确性与网络延迟需要在本机配置用户Key后按 [15个质量样例](QUALITY_SAMPLES.md) 检查；目前不能用模拟结果宣称真实翻译质量已验证。浏览器原生权限确认由用户在安装后点击接受，自动化模拟其授权后的运行状态。无OCR文字层扫描件不在首版范围内。
