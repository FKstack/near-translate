# 商店发布资料

当前文案与隐私页面向“Key 保存即可使用”的源码改动，正式候选版本须在重新构建和验收后填写。`edge-submission.json` 及下列 0.11.1／0.11.2 验收资料属于旧包，不可直接复用于新版。Chrome 的资料同时保留；材料准备、上传、提交审核和审核通过是不同状态，商店安装链接需在真实商店条目可访问后添加。

| 内容 | 文件 |
| --- | --- |
| 中英文商品介绍与搜索词 | [LISTING.md](LISTING.md) |
| 可供自动填写读取的公开资料 | [edge-submission.json](edge-submission.json) |
| Edge 权限、数据用途与审核测试步骤 | [EDGE_REVIEW.md](EDGE_REVIEW.md) |
| Edge 公开隐私页 | [PRIVACY_EDGE.md](PRIVACY_EDGE.md) |
| Chrome 初次核对与整改记录 | [CHROME_REVIEW.md](CHROME_REVIEW.md) |
| Chrome 公开隐私页 | [PRIVACY_CHROME.md](PRIVACY_CHROME.md) |
| 标准截图、图标、宣传图及来源 | [ASSETS.md](ASSETS.md) |
| 字体包装修复技术验收 | [edge-package-compatibility-2026-10-24.json](../evidence/edge-package-compatibility-2026-10-24.json) |
| 0.11.1 密钥库验收记录 | [store-readiness-2026-10-23.json](../evidence/store-readiness-2026-10-23.json) |
| 当前发行与手动安装 | [v0.11.2](../releases/v0.11.2.md) |

## 可供后台填写的地址

- 项目主页：<https://github.com/FKstack/near-translate>
- 支持与反馈：<https://github.com/FKstack/near-translate/issues>
- Edge 隐私：<https://github.com/FKstack/near-translate/blob/main/docs/store/PRIVACY_EDGE.md>
- Chrome 隐私：<https://github.com/FKstack/near-translate/blob/main/docs/store/PRIVACY_CHROME.md>

素材原件已归档到[当前商店图片目录](../assets/store/v0.11.1/)。5张功能截图为原生1280×800实际界面，译文为本地预置演示内容。图片不含发布者注册资料、真实 Key 或私人文档。v0.11.2 的可见界面未改变，复用 v0.11.1 实际截图；不将旧图描述成新版本重新截取的证据。

本机安装包位于被 Git 忽略的 `artifacts/releases/v0.11.2/`，只向商店上传对应浏览器的 `near-translate-*-v0.11.2.zip`。不要上传素材总目录、源码压缩包、测试配置或浏览器运行时。

开发者注册姓名、地址、电话、账户验证和协议状态不保存到公开仓库。注册及上架进度以实际控制台结果为准，不以准备文档代替回执。
