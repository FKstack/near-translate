# 弹窗与设置页视觉统一

日期：2026-10-22。

## 设计与实施

- 弹窗替换旧「译」字蓝色图标，使用双叶 SVG；暖白纸面、青绿主操作、浅绿状态区和中性未就绪圆点。三个原有入口与文案名称保留。
- 设置页使用同一套图标、颜色、焦点与表单样式。桌面为配置主区和网页/PDF辅助区；820 px以下纵向布局，560 px以下辅助区也逐张堆叠。
- 将启用翻译、上下文和长句拆解归入阅读偏好；保留所有原有标签、控件卸载条件、保存/授权回调与加载禁用逻辑。统一旧「青色按钮」文案为「双叶按钮」。
- 页面反馈保留唯一 `role=status` 和错误 `role=alert`；网页授权反馈在表单外，不受字段组禁用影响。页签也使用新的图标。

生产修改范围：`src/ui/app.css`，`src/entrypoints/options/{main.tsx,index.html}`，`src/entrypoints/popup/{main.tsx,index.html}`。品牌资产复用已有 SVG/PNG，无新运行时依赖、权限或持久化格式。

## 验证

- 类型检查、模块边界、Chrome/Edge构建与diff格式检查通过。
- 4项现有Edge回归通过（11.7秒）：可选网页权限；服务切换和Key不回显；修改接口地址后旧凭证隔离；DeepL无需Key且保留模型配置。
- 隔离Edge 155.0.4283.62中检查弹窗就绪/未配置、模型/DeepL设置，以及360 px窄屏；无水平溢出、品牌资源失效或页面异常。键盘焦点使用2 px青绿轮廓。
- 弹窗3个入口均通过：设置、本地/链接阅读器、当前PDF阅读器；当前PDF使用本地拦截fixture，确认reader URL保留正确编码的来源，无真实外部请求。
- 真实构建截图：`popup-ui.png`、`popup-unconfigured-ui.png`、`options-ui.png`、`options-deepl-ui.png`、`options-narrow-ui.png`。截图采用隔离测试配置，无用户Key。

## 当前安装版更新

已在原目录 `artifacts/installed/near-translate-edge-v0.1.0` 原位更新并重新加载，保留扩展ID和0.7.0版本、原有配置。仅更新2个HTML入口和3个新的CSS/JS文件；其他程序文件一致。覆盖前备份位于 `.output/brand-design/installed-pages-backup-1792671527469`。

实际安装版已通过同源页面核验：设置页标题「翻译设置」、主区和2个辅助区、双叶图片成功加载、暖白底与青绿按钮均生效；弹窗360 px，三个原有操作均在。重新加载前后公开设置一致，没有读取或写入API Key。已打开新的设置页和真实工具栏弹窗供用户查看。

部署证据见 [extension-pages-deployment-2026-10-22.json](../../evidence/extension-pages-deployment-2026-10-22.json)。

架构影响：R1，展示职责仍由各入口与共享界面样式持有；未改变模块边界、公共契约、状态所有权或生命周期。
