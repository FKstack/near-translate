# 近译本地文档转换

## 日常入口与用途

扩展菜单和 PDF 阅读器提供“文档转换”入口，打开独立标签页。无需登录、Key 或翻译服务，所选文件在本机处理。

| 工具 | 常见用途 | 导出 |
| --- | --- | --- |
| Markdown / 文本 / HTML → PDF | 整理笔记、代码与表格，分享文档 | 点击“下载 PDF”后本机直接生成并自动下载；可另存 HTML 或展开 HTML 预览 |
| PDF → Markdown / TXT | 提取可编辑文字，整理阅读笔记 | `.md` / `.txt`，支持预览复制 |
| PDF → 图片 | 按页发图、归档或插入其他文档 | PNG / JPG，ZIP 下载 |
| 图片 → PDF | 多张截图合成文档 | PNG / JPG / WebP 排序合并，A4 或原图比例 |
| 合并与整理 PDF | 多文件合并、提取指定页、调换页序、统一旋转 | 保留文字和矢量内容的 PDF |
| 拆分 PDF | 单页分发、只保留指定页 | 每页一份 PDF，ZIP 下载 |

页码从 1 开始。留空表示全部；`1-3,5` 选择区间，`3,1,2` 调整顺序，`3-1` 倒序，重复页码会保留。多文件列表可上移、下移和移除。

## 转换质量与边界

- PDF 文字提取基于文字层、字体及页面坐标，尽力恢复标题、段落、列表、简单表格、代码和链接。双栏、公式、复杂表格及特殊字体仍需人工核对；不宣称恢复原始 Markdown。
- 扫描件和纯图片 PDF 没有可提取文字，需要先做 OCR。本轮不包含 OCR、Word / Excel / PPT 转换。
- PDF → 文字 / 图片可输入打开密码，密码仅留在当前页内存。加密 PDF 的合并或拆分明确拒绝，需先在原应用中解密另存。
- PDF 整理复制页面内容，不保证完整保留文档级书签、交互表单、附件或签名。图片合成会以白底 JPEG 重新编码，不用于无损图片归档。
- 文档排版支持 GFM 表格、列表、任务项、链接、代码和中文本机字体。图片按本地附件文件名匹配；外链图片不自动请求。下载的 HTML 内嵌附件，关闭转换页后仍可查看和打印。
- Markdown → PDF 使用扩展内置中文字体和原生文字 / 矢量排版，直接生成 PDF，不经过打印窗口，不把文档转换成整页截图。中文、英文和常用符号保留文字层；超出内置字体覆盖的字符（例如部分 emoji、生僻字）会显示警告并在 PDF 中以 □ 标示。纸张、横竖方向、边距和字号可调整。
- 直接 PDF 导出一次最多支持 30 万 UTF-16 字符和 500 页。代码与高表格单元格可跨页；短表格行、图片及标题尽量避免截断。可折叠的预览是 HTML 排版参考，字体与分页以下载后的 PDF 为准。

单文件最大 100 MB，合计 200 MB，最多 50 个文件。文字文档最大 5 MB，图片附件合计 32 MB。单次最多处理 500 页，PDF 图片导出最多 100 页；单张位图或渲染面最多 1600 万像素。文件及 ZIP 输出合计上限 128 MB，HTML 排版上限 64 MB。取消后不发布迟到结果，关闭页面清除输入、密码及临时下载链接。

## 实现与并发约定

变更级别 R2：新增独立功能模块与扩展页面，复用已有本地 PDF.js 资源；不修改翻译协议、设置 schema 或后台生命周期。

`src/conversion` 拥有转换状态、页码语义、HTML 清理、文字布局、PDF 写入及 ZIP。`src/entrypoints/convert` 只组合页面，popup / reader 仅添加导航入口。底层转换函数接收 `AbortSignal` 和进度回调，不依赖翻译服务、浏览器存储或 API Key。PDF.js loading task、渲染任务、canvas 和 Blob URL 均由创建者释放。

直接下载由 `document-pdf.ts` 拥有：使用本地静态 TrueType 字体进行 DOM 行宽测量，再绘制 PDF 文字、表格边框、背景、列表标记、任务框、超链接和本地图片；自动分页与字体子集嵌入均在扩展页内完成。只读缓存成功加载的字体字节；每次操作独立拥有临时布局 iframe、PDF 文档和图片编码 canvas，取消 / 异常 / 成功均收束释放。UI 只在当前任务有效时触发一次下载，并保留手动下载链接。

字体为 Noto Sans SC 2.004 的 OFL 静态派生字体 Near Document Sans，随扩展分发，不下载远程字体。使用 `@pdf-lib/fontkit` 1.1.1 子集嵌入，避免每份 PDF 带入完整字体。来源、哈希和四字节 `glyf` 对齐的兼容说明见 [字体记录](../../third_party/fonts/README.md)。

为避免与同仓库的多语言 / 免费翻译工作交叉，新增功能先在 `.output/conversion-staging` 独立编写；确认另一任务释放依赖、构建与部署锁后，再串行接入及验收。现有工作区未提交的改动全部保留。

## 设计依据

常见工具覆盖合并、拆分、图片与 PDF 的互转，参考 [iLovePDF 官方工具说明](https://www.ilovepdf.com/help/documentation)。浏览器打印行为依据 [MDN `window.print()`](https://developer.mozilla.org/en-US/docs/Web/API/Window/print) 与 [打印样式说明](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Media_queries/Printing)。Markdown 解析使用 [Marked](https://marked.js.org/using_advanced)，输出另做 HTML 白名单清理；页面复制与图片合成使用 [pdf-lib](https://pdf-lib.js.org/docs/api/classes/pdfdocument)。所有运行时依赖随扩展本地分发。

## 验收记录

### 最新：直接下载

类型、依赖边界、Chrome / Edge 构建通过，46 个单测文件共 **1,128 项通过**。原有 74 项阅读 / 翻译 Edge 回归通过；最后一次基线修正后，全部 **25 项转换 Edge 验收通过**。首次整体验收的 98 成功 / 1 混合代码基线失败及后续修正保留在记录中，没有将失败轮记为全通过。

真实下载的 PDF 验证了 A4 / Letter、横竖方向、0 / 40mm 边距、8 / 24pt 字号、中文文字层、40 行表格、60 行代码、8 段正文完整性；还覆盖 HTML 合并单元格、链接、透明 PNG / JPG / WebP 共享图片、超高单元格、长代码、多页文字边界、取消字体加载和缺字提示。对实际 PDF 进行栅格目视检查，确认字体可见、斜体基线水平，混合中文代码与 ASCII 的基线差为 0pt。

已原 ID / 原目录重新加载实际 Edge 扩展：更新 8 个差异文件，**333 个程序文件哈希一致**。安装后在拥有的临时隐藏页中真实生成 13,136 字节 PDF，核验自动下载意图且不调用打印，并抑制该测试样例落入用户 Downloads；新工作台已打开供用户使用。原公开配置、Key 保存状态和权限集合全部一致，未写浏览器存储，未读取 Key 值。临时更新文件已清除。

[直接下载验收](../evidence/direct-pdf-validation-2026-10-23.json) · [安装核验](../evidence/direct-pdf-deployment-2026-10-23.json) · [直接下载示例](../design/conversion-workbench/direct-download-sample.pdf)

### 首次转换上线（历史打印路径）

以下记录验证的是当时的浏览器打印路径，保留用于追溯。

类型检查、模块边界检查与 Chrome / Edge 生产构建通过；最终 45 个单测文件共 1,123 项通过（其中转换相关 72 项）。新增 20 项真实 Edge 转换测试通过，覆盖文件下载内容、ZIP UTF-8 文件名与 CRC、图片实际像素、页序与重复页、旋转 / CropBox / UserUnit、中文 CMap、密码纠正、空白页提示、取消后重试、HTML 清理与窄屏布局。

实际 Markdown 经 HTML 打印生成 5 页 A4 PDF（97,515 字节），再通过扩展提取 Markdown：中文标题、首末段、40 行表格、60 行代码、8 段正文起止与 24 次正文句均完整。合并回归另验证 12 页共用一张真实图片时，重复选页后仍只嵌入 1 份图片资源，13 个页面字典各自独立。

桌面与窄屏预览保存在 `docs/design/conversion-workbench/`。`npm run test:conversion:e2e` 可构建并单独运行转换验收；无本地 HTTP 测试服务器依赖，使用独立临时 Edge 配置，不操作日常浏览器数据。

最终最新构建的全量 Edge 回归 **94 / 94 通过**，包含原有 74 项及新增 20 项转换测试，耗时约 4.2 分钟。测试副本与当前 Chrome 构建的 328 个文件核对一致，仅测试 manifest 预授予权限；生产 Chrome / Edge manifest 与原安装版本完全相同。

已更新日常 Edge 中原 ID `dbdooijmbinjmnbmgglajigaoiinolnc`、原目录 `artifacts/installed/near-translate-edge-v0.1.0`：复制 20 个差异文件，328 个生产文件最终哈希全部一致；更新前备份到 `.output/conversion-installed-backup-1792686253159`。重新加载后核验六个工具、真实本地排版、打印就绪、菜单与阅读器入口，并打开工作台标签页。全部公开设置（包括模型、语言、上下文、长句分析、连接版本与 Key 保存状态）及权限集合前后一致；未写浏览器存储、未读取 Key 值，未关闭原用户测试分组，临时更新页和脚本已清除。

安装证据：[pdf-conversions-deployment-2026-10-23.json](../evidence/pdf-conversions-deployment-2026-10-23.json)。
