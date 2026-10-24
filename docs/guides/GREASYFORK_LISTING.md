近译的篡改猴版，支持网页双语翻译、划词翻译和阅读模式。

- **网页翻译**：译文显示在原文下面，可以停止翻译或恢复原文。
- **划词翻译**：选中文字后点“译”。模型模式下可查英语词义、看长句拆解。
- **阅读模式**：提取正文，保留目录、代码、表格和图片。可调整主题、字号、行距，切换原文、双语或仅译文。

![双语阅读](https://fkstack.github.io/near-translate/assets/reader-bilingual.png)

![划词词卡](https://fkstack.github.io/near-translate/assets/word-context.png)

*截图使用示例文章和预置响应。*

### 使用

需要 Tampermonkey 5.4 或更新版本。安装后刷新文章页，从近译浮动按钮操作，或按 `Alt+Shift+R` 打开阅读模式。

在篡改猴菜单里打开[翻译设置](https://fkstack.github.io/near-translate/userscript/settings.html)。可以使用实验性 DeepL 免费翻译，也可以填自己的模型 API 或本机模型接口。免费服务可能限流，模型服务按所选服务计费。

词典和长句拆解需要模型 API：词典支持英译简／繁中文，长句拆解支持英译简体中文。Key 保存后，各网页可直接翻译。具体配置见[使用指南](https://fkstack.github.io/near-translate/userscript/guide.html)。

发现新版会提示，取消后下次使用再提醒。若想每次升级都自己确认，请关闭篡改猴对近译的内建自动更新。

### 扩展版

同一项目还有 [Chrome / Edge 扩展](https://github.com/FKstack/near-translate/releases/latest)，另外提供文字型 PDF 阅读和选区翻译，以及 Markdown／文本／HTML 转 PDF、PDF 合并、拆分和重排。本页脚本不含这些功能。

两版设置独立保存，同一网站只启用一种即可。

MIT 开源。[项目主页](https://fkstack.github.io/near-translate/) · [源码](https://github.com/FKstack/near-translate) · [反馈](https://github.com/FKstack/near-translate/issues) · [隐私说明](https://github.com/FKstack/near-translate/blob/main/docs/guides/PRIVACY.md)
