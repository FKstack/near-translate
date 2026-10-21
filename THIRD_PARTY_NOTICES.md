# 第三方依赖与许可证

近译自身代码使用 [MIT 许可证](LICENSE)。依赖保留各自许可证：

| 依赖 | 许可证 | 发布包中的声明 |
| --- | --- | --- |
| React、React DOM、Scheduler | MIT | `licenses/react.txt`、`licenses/react-dom.txt`、`licenses/scheduler.txt` |
| PDF.js (`pdfjs-dist`) | Apache-2.0 | `licenses/pdfjs-dist.txt`、`pdfjs/LICENSE` |

构建前脚本从已安装依赖复制完整许可证，同时将近译许可证复制为 `licenses/near-translate.txt`。PDF.js 随附字体、图片及解码器的许可证保留在对应资源目录中。构建工具与测试依赖不打包进扩展，具体版本和依赖关系见 `package-lock.json`。
