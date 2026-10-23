# 近译：双叶对话与阅读书签

设计日期：2026-10-22。目标：清新、自然、克制，并与常见商业翻译扩展的贴边胶囊和叠字按钮形成独立识别。

## 同类图标观察

| 产品 | 观察 | 借鉴原则 |
| --- | --- | --- |
| [Google 翻译](https://chromewebstore.google.com/detail/google-translate/aapbdbdomjkkjkaonfhkkikfgjllcleb) | 蓝色 G 页片与中文页片叠合 | 两个元素直接表达两种语言 |
| [DeepL](https://chromewebstore.google.com/detail/deepl-translate-and-write/cofdbpoegempjloogbagkncekinflcnj) | 深蓝对话轮廓与连接节点 | 用紧凑轮廓表达沟通 |
| [沙拉查词](https://saladict.crimx.com/download) | 碗与彩色蔬果意象 | 自然意象能建立亲和的记忆点 |

以上为官方产品入口与图像搜索素材的视觉观察，并非品牌规范。共同点是核心图形大、主色有限、轮廓明确。借鉴语义与辨识原则，不复用竞品轮廓、字形或布局。

## 原创方案

两片叶子也是两个对话气泡，分别代表原文与译文。中间的透明留白保持两种语言各自清晰，也呼应「近译」的靠近之意。仅保留青绿 `#087F83` 与薄荷绿 `#66CC9E`，无文字、叶脉、渐变或阴影。

先通过内置 image_gen 生成并迭代概念，再将选定方向重新绘制为可编辑的双路径 SVG，统一平面填色和边缘。`concept-imagegen.png` 保留生成概念；实际扩展使用 SVG 导出的 PNG。提示词见 [PROMPTS.md](PROMPTS.md)。

浮栏采用完整的暖白书签面板，桌面距右边 16 px、窄屏 10 px；顶部双叶按钮为主操作，下方为原文与设置。用留白、细分隔线和低对比边框区分层次。运行时显示停止符号，已有译文时显示打开的书页，提示框使用同一套浅色纸面风格。所有功能入口始终可见，键盘焦点有明确轮廓。

## 文件与重导出

- `public/brand/near-translate.svg`：可编辑矢量母版。
- `public/icon/{16,32,48,128}.png`：扩展使用的透明 PNG，WXT 按约定自动写入构建清单。
- 本目录 `near-translate-{512,1024}.png`：大尺寸透明图标。
- 本目录 `preview.html` / `preview.png`：以实际 `PageBar` 组件渲染的设计预览，包含待命、翻译中、完成与重试状态。
- `node scripts/design/render-brand-assets.mjs`：使用现有 TypeScript 与 Playwright 开发依赖重导出，无新增依赖。修改品牌轮廓时同步更新 SVG 与 `Bar.tsx` 内联标记；内联标记避免网页图标另发资源请求。

尺寸依据：[Chrome 图标配置说明](https://developer.chrome.com/docs/extensions/develop/ui/configure-icons)。SVG 保留为母版，manifest 使用 PNG。

## 架构影响

R1：仅修改 `page/Bar.tsx` 的展示标记与样式，既有状态、回调、语义标签和诊断属性保持兼容。会话仍由 `page/mount` 持有，无新增网络、权限、依赖、共享状态、资源或生命周期。

## 验证

已验证图标尺寸与透明通道、实际组件预览、悬停及键盘提示可见性、类型检查、10 项相关单元测试和模块边界。构建及端到端验证结果见 [VALIDATION.md](VALIDATION.md)。
