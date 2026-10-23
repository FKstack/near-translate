# 开发脚本

所有命令从仓库根目录运行。脚本属于开发工具，不会随扩展发布；生成文件写入已忽略的 `.output/`、`artifacts/` 或指定的证据目录。

## 目录

| 位置 | 用途 |
| --- | --- |
| 顶层 | 构建准备、发行打包、仓库与边界检查，供 npm 和 CI 直接调用 |
| [`benchmarks/`](benchmarks/) | 扩展体积之外的内存测量、已安装扩展的全文翻译测速及浏览器探针 |
| [`diagnostics/`](diagnostics/) | 网络协议、模型耗时和已安装阅读功能的手动诊断 |
| [`experiments/`](experiments/) | 竞品协议复现与 DeepL OAuth 验证，保留历史研究代码 |
| [`design/`](design/) | 品牌图标与预览图导出 |

## 常用入口

优先使用 `package.json` 提供的稳定命令；目录调整不改变这些命令的名称。

| 命令 | 内容 |
| --- | --- |
| `npm run assets:pdf` | 从锁定依赖准备离线 PDF、字体与许可证资源 |
| `npm run check:boundaries` | 检查源码依赖边界 |
| `npm run check:repo` | 检查待上传文件中的本地产物、超大文件和常见凭证形态 |
| `npm run analyze:size` | 分析当前构建的文件大小 |
| `npm run benchmark:memory` | 隔离浏览器配置，测量扩展内存与生命周期；翻译网络使用模拟响应 |
| `npm run benchmark:installed` | 使用已安装扩展的当前服务配置，对公开文章进行实际翻译测速 |
| `npm run package:release` | 校验与当前版本匹配的测试证据和 ZIP，生成发行文件 |

`prepare-e2e.mjs` 由 `npm run test:e2e` 的前置步骤调用。文档位置和贡献流程见 [文档导航](../docs/README.md) 与 [贡献指南](../CONTRIBUTING.md)。

运行内存测量前，将 `NEAR_BROWSER_EXECUTABLE` 设为支持加载未打包扩展的测试浏览器绝对路径。工具会创建独立配置目录，不使用日常浏览器配置。

## 手动诊断

`benchmark:installed`、`diagnostics/diagnose-installed-model.mjs` 和 `diagnostics/verify-installed-reading-customization.mjs` 操作开发者指定的已安装扩展。运行前设置：

- `NEAR_INSTALLED_EXTENSION_DIR`：仓库内实际加载的扩展目录。
- `NEAR_INSTALLED_EXTENSION_ID`：浏览器扩展管理页显示的 ID。
- `NEAR_BROWSER_EXECUTABLE`：浏览器可执行文件的绝对路径。
- `NEAR_BROWSER_PROFILE_DIRECTORY`：可选，默认为 `Default`。

这些工具只在指定目录临时写入自己的辅助页面，结束时清理。模型诊断与已安装测速会翻译固定公开文本，使用当前服务时可能计费；阅读核验不发送翻译请求。工具不会读取或导出 API Key，也不会修改已保存的翻译或阅读设置。`--reload` 会重载目标扩展。

```sh
node scripts/diagnostics/diagnose-installed-model.mjs --word-only --label local
node scripts/diagnostics/verify-installed-reading-customization.mjs
```

其余 `probe-*`、`verify-native-fetch.mjs` 和 `experiments/` 可能访问公开服务或启动独立测试浏览器，不属于常规测试和 CI。历史报告保留当时的命令与证据；现在的可执行路径以此目录结构为准。

品牌资源可通过 `node scripts/design/render-brand-assets.mjs` 重导出，无需新增依赖。
