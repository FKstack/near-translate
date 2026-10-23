# 第三方依赖与许可证

近译自身代码使用 [MIT 许可证](LICENSE)。依赖保留各自许可证：

| 依赖 | 许可证 | 发布包中的声明 |
| --- | --- | --- |
| React、React DOM、Scheduler | MIT | `licenses/react.txt`、`licenses/react-dom.txt`、`licenses/scheduler.txt` |
| PDF.js (`pdfjs-dist`) | Apache-2.0 | `licenses/pdfjs-dist.txt`、`pdfjs/LICENSE` |
| Mozilla Readability (`@mozilla/readability` 0.6.0) | Apache-2.0 | `licenses/mozilla-readability-NOTICE.txt`（上游版权声明）、`licenses/Apache-2.0.txt`（完整许可证） |
| OpenCC JavaScript (`opencc-js` 1.4.2) 及其内含 `opencc-data` 字典 | MIT AND Apache-2.0 | `licenses/opencc-js-MIT.txt`、`licenses/opencc-data-Apache-2.0.txt`、`licenses/opencc-js-THIRD_PARTY_LICENSES.md` |
| Marked (`marked` 18.1.1) | MIT | `licenses/marked.txt` |
| pdf-lib 1.17.1、`@pdf-lib/standard-fonts`、`@pdf-lib/upng` | MIT | `licenses/pdf-lib.txt`、`licenses/pdf-lib-standard-fonts.txt`、`licenses/pdf-lib-upng.txt` |
| `@pdf-lib/fontkit` 1.1.1 | MIT | `licenses/pdf-lib-fontkit.txt`、上游 `licenses/pdf-lib-fontkit-README.md` |
| Near Document Sans（Noto Sans SC 2.004 静态派生字体） | SIL OFL 1.1 | `licenses/NotoSansSC-OFL.txt`，来源和生成过程见 `fonts/README.md` |
| pako | MIT AND Zlib | `licenses/pako.txt` |
| tslib | 0BSD | `licenses/tslib.txt` |

构建前脚本从已安装依赖与 `third_party/licenses/` 复制完整许可证，同时将近译许可证复制为 `licenses/near-translate.txt`。生成目录 `public/licenses/` 不提交 Git；干净克隆后构建会重建全部声明。完整字体源以无损 gzip 保存在 [`third_party/fonts/`](third_party/fonts/README.md)，构建复制至发布包，导出 PDF 时才在本地解压。PDF.js 随附字体、图片及解码器的许可证保留在对应资源目录中。构建工具与测试依赖不打包进扩展，具体版本和依赖关系见 `package-lock.json`。

Readability 用于网页阅读模式的本地正文提取。其上游版权声明从已安装依赖复制，Apache-2.0 正文源保存在 `third_party/licenses/`，构建时随扩展分发；提取器的安全白名单、源位置映射和阅读界面由近译实现。

OpenCC 只在本地规范 DeepL 完整段落输出的简体/繁体字形；使用通用字形转换，不启用地区用语替换。字典随扩展分发，运行时不下载字典，不增加翻译请求；仅相关后台模块导入，源网页文字与代码保持原样。
