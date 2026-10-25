# 分析与历史报告

报告按任务保留版本、日期、测试条件和失败结果。最新使用方式见 [安装指南](../guides/INSTALL.md)，性能口径与历轮结果见 [性能记录](PERFORMANCE.md)。目录整理只更新可移植链接和当前脚本入口，不把历史验收改写为当前版本结果。

| 主题 | 报告 |
| --- | --- |
| 篡改猴 DeepL 连接与速度 | [2026-10-25 研究、失败候选与当前发布判定](USERSCRIPT_DEEPL_PERFORMANCE_2026-10-25.md)、[数字证据](../evidence/userscript-deepl-speed-2026-10-25.json) |
| 轻量化与内存 | [0.11.0 审计](LIGHTWEIGHT_AUDIT_2026-10-23.md) |
| 阅读模式 | [竞品分析](READING_MODE_COMPETITIVE_ANALYSIS_2026-10-22.md)、[设计与验收](READING_MODE_DESIGN_AND_VALIDATION_2026-10-22.md) |
| 阅读自定义 | [首次使用体验](READING_FIRST_USE_COMPETITORS_2026-10-23.md)、[竞品比较](READING_CUSTOMIZATION_COMPETITIVE_ANALYSIS_2026-10-23.md)、[设计](READING_CUSTOMIZATION_DESIGN_2026-10-23.md)、[验收](READING_CUSTOMIZATION_VALIDATION_2026-10-23.md) |
| 阅读翻译工具栏 | [布局调整与验收](READING_TRANSLATION_TOOLBAR_2026-10-23.md) |
| DeepSeek 划词 | [增量展示与延迟定位](DEEPSEEK_SELECTION_LATENCY_2026-10-23.md) |
| 文档转换 | [功能与质量边界](PDF_CONVERSIONS_2026-10-23.md) |
| 免费首译与多语言 | [第一阶段设计与实测](PHASE_ONE_FREE_SETUP_LANGUAGES_2026-10-22.md) |
| DeepL 性能 | [Go 长文初轮](DEEPL_GO_PAGE_FIX_AND_TEST_2026-10-21.md)、[第二轮](DEEPL_PERFORMANCE_V2_2026-10-22.md)、[第三轮](DEEPL_PERFORMANCE_V3_2026-10-22.md)、[第四轮](DEEPL_PERFORMANCE_V4_2026-10-22.md)、[第五轮](DEEPL_PERFORMANCE_V5_2026-10-22.md) |
| DeepL 协议与迁移 | [匿名协议诊断](DEEPL_ANONYMOUS_PROTOCOL_DIAGNOSIS_2026-10-22.md)、[OJBetter 无登录路线](OJBETTER_NO_LOGIN_DEEPL_2026-10-21.md)、[完整复现与设计](OJBETTER_FULL_REPRODUCTION_AND_DESIGN_2026-10-21.md)、[现场安装更新](INSTALLED_EXTENSION_UPDATE_2026-10-21.md) |
| 产品背景与竞品 | [多竞品背景](COMPETITIVE_ANALYSIS_2026-10-21.md)、[沉浸式翻译专项对比](IMMERSIVE_TRANSLATE_COMPARISON_2026-10-21.md)、[登录态可行性](NO_API_SESSION_TRANSLATION_FEASIBILITY_2026-10-21.md) |

证据文件继续保留在 [evidence](../evidence/README.md)。`.output/` 和 `artifacts/` 的本机历史路径不随仓库上传；原报告中这些未归档材料的引用已保留为文字说明，不能视为可公开复核的附件。部分源码行号和运行命令属于历史实现，运行诊断或实验前请阅读 [脚本说明](../../scripts/README.md)。
