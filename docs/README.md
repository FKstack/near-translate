# 项目文档

首次使用从安装指南开始；参与开发时阅读架构和验证说明。带日期的报告记录当时的版本、测试条件和限制，当前行为以源码、首页及使用指南为准。

| 目录 | 内容 | 入口 |
| --- | --- | --- |
| `guides/` | 安装、隐私与发布准备 | [安装和使用](guides/INSTALL.md) · [篡改猴版](guides/USERSCRIPT.md) · [隐私说明](guides/PRIVACY.md) · [上传 GitHub](guides/GITHUB_PUBLISH.md) |
| `releases/` | 发行说明、安装包与升级方法 | [v0.11.4](releases/v0.11.4.md) · [v0.11.1](releases/v0.11.1.md) · [v0.11.0](releases/v0.11.0.md) |
| `store/` | 商店介绍、图片规格、权限与隐私披露 | [商店文案](store/LISTING.md) · [Edge 审核资料](store/EDGE_REVIEW.md) · [Edge 隐私](store/PRIVACY_EDGE.md) |
| `development/` | 模块职责、开发约定与质量核验 | [架构与实施记录](development/ARCHITECTURE.md) · [发布工作流](development/RELEASE_WORKFLOW.md) · [验证记录](development/VALIDATION.md) · [翻译质量样例](development/QUALITY_SAMPLES.md) |
| `reports/` | 竞品研究、功能设计、性能分析及历次验收 | [性能记录](reports/PERFORMANCE.md) · [轻量化与内存审计](reports/LIGHTWEIGHT_AUDIT_2026-10-23.md) |
| `design/` | 图标、界面设计、可编辑母版与视觉样例 | [品牌图标](design/near-translate/DESIGN.md) · [扩展页面](design/near-translate/EXTENSION_UI.md) · [项目介绍页](design/project-site/DESIGN.md) |
| `evidence/` | 测量摘要、安装哈希、截图和研究证据 | [证据说明](evidence/README.md) |

近期功能研究与验收：

- 阅读模式：[竞品研究](reports/READING_MODE_COMPETITIVE_ANALYSIS_2026-10-22.md)、[设计与验收](reports/READING_MODE_DESIGN_AND_VALIDATION_2026-10-22.md)。
- 阅读自定义：[首次使用体验](reports/READING_FIRST_USE_COMPETITORS_2026-10-23.md)、[竞品分析](reports/READING_CUSTOMIZATION_COMPETITIVE_ANALYSIS_2026-10-23.md)、[设计](reports/READING_CUSTOMIZATION_DESIGN_2026-10-23.md)、[验证](reports/READING_CUSTOMIZATION_VALIDATION_2026-10-23.md)。
- 翻译入口：[固定顶部工具栏](reports/READING_TRANSLATION_TOOLBAR_2026-10-23.md)、[DeepSeek 划词延迟定位](reports/DEEPSEEK_SELECTION_LATENCY_2026-10-23.md)。
- 文档转换：[功能、格式边界与验收](reports/PDF_CONVERSIONS_2026-10-23.md)。

文档链接使用仓库相对路径；本机临时测试文件不作为 GitHub 可访问链接。可运行 `npm run check:docs` 检查 Markdown 相对链接、图片和标题锚点。
