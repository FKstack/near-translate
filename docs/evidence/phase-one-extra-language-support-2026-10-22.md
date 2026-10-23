# 第一阶段新增四语：DeepL 官方支持静态证据（2026-10-22）

本记录核对印地语 `hi`、印尼语 `id`、土耳其语 `tr`、越南语 `vi` 的官方产品资料及先前已下载的官方扩展。**静态支持证据不等于匿名 OneShot 实测成功**，也不保证任一语言对、地区或时刻的可用性。本轮没有调用翻译端点、使用 API Key 或 Cookie、启动浏览器或修改生产代码。

## 官方产品资料

- [DeepL Translator languages](https://support.deepl.com/hc/en-us/articles/360019925219-DeepL-Translator-languages)：当前官方 Translator 语言表包含 Hindi、Indonesian、Turkish、Vietnamese。这是产品支持说明，不是匿名 OneShot 的公开接口合同。
- [Vietnamese、Thai、Hebrew 发布公告](https://www.deepl.com/en/blog/vietnamese-thai-hebrew-launch)：2025-06-25 公告明确越南语与希伯来语覆盖所有版本的 DeepL Translator；公告中泰语当时另有分阶段推出安排，不能把泰语限制套用到越南语。
- [70 多种新语言的推出说明](https://www.deepl.com/en/blog/how-we-launched-70-new-languages-on-deepl)：2026-01-12 官方工程回顾说明语言扩展以及跨平台基础设施。该说明本身没有逐一证明每种语言的匿名接口可用性。

没有把有 Key 的 DeepL API 语言目录当作匿名翻译实测证据。

## 已下载官方扩展的静态核对

产物身份、下载和原始协议定位沿用[官方 OneShot 静态证据](deepl-official-oneshot-2026-10-22.md)。官方站点链接的 Mozilla 商店分发产物为 DeepL **1.104.2**，固定 [XPI 下载地址](https://addons.mozilla.org/firefox/downloads/file/5138135/deepl_translate-1.104.2.xpi)。

- XPI SHA256（既有下载核验）：`50a5de57865c38ecd9057edb0aec5bb3379ad02c6bef3197fdae0038ddd42c16`。
- 本地核对文件：`.output/deepl-v3-research/background.js`。
- 本轮重新核对的 `background.js` SHA256：`c6a4f06b0ca65f601737315c5f662218b60eba4a712d76ec4864f9287f3c08e8`，与既有记录一致。
- 下列 offset 是该文件的 **0-based JavaScript UTF-16 字符位置**，不是行号或字节偏移。

| 语种 | 静态位置 | 观察结果 |
| --- | --- | --- |
| 印尼语 `id` | `7521` | 常规语言表 `E` 中 `langCode:"ID"`，对应 `langCodeForIta:"id"`。 |
| 土耳其语 `tr` | `8700` | 常规语言表 `E` 中 `langCode:"TR"`，对应 `langCodeForIta:"tr"`。 |
| 越南语 `vi` | `8824` | 常规语言表 `E` 中 `langCode:"VI"`，对应 `langCodeForIta:"vi"`。 |
| 印地语 `hi` | `9166` | `hi` 在扩展语言数组 `I` 中，不在原有常规表 `E` 中。 |

`PU` 函数从 offset `667546` 开始：先无条件把数组 `I` 的代码映射为大写 `langCode` 和原样小写 `langCodeForIta`，再与常规表 `E` 一并保存到 `translationLanguages`。只有独立数组 `S=["th"]` 的加入受 `gE(account, nr.TRANSLATOR)` 检查限制；`hi` 不走这个付费检查分支，`id/tr/vi` 也不在该分支中。

既有协议定位还显示：匿名 fallback 使用 `https://oneshot-free.www.deepl.com/v1`，翻译路径追加 `/translate`，请求体为字符串数组 `text`、经 `langCodeForIta` 映射的 `target_lang` 和可选 `source_lang`。因此 `hi/id/tr/vi` 有同一官方客户端和 OneShot 参数构造路径的静态依据，无需新增接口或仿造官方身份字段。

以上足以支持把四语列为第一阶段候选语言；**没有新增四语的真实请求、响应、翻译质量或匿名限额验证结果**。目标语言菜单和参数映射的静态存在，也不能单独证明所有显式源语言组合已通过服务端验收。

## 16 语种真实网页样本

机器可读清单位于工作区 `.output/phase-one/real-pages.json`，每项仅含 `sourceLanguage`、`targetLanguage`、`label`、`url`、`script`：

- 简体中文目标为英语，繁体中文目标为简体中文，其余目标均为简体中文。
- `label` 中地区仅说明该语言的主要使用地区，不表示该 URL 的发布国家、内容所述国家，或该 locale 能覆盖这些地区的所有语言变体。
- `script` 为可使用 Unicode 模式编译的正则字符串，仅检查文字系统，不能独立证明语种或翻译质量。拉丁文字语言统一使用 `\p{Script=Latin}`。
- 链接沿用本轮前序只读研究中已经打开并核对正文语言的原地址；生成本文件和清单时没有再次访问网页。
- MDN 的印尼语与越南语 `Glossary/HTML` 路径实际重定向英语，未纳入样本。四种新增语言使用 Mozilla 官方 Cookie 说明。MDN 公共导航存在英语，语言验收应以文章正文为准。

四语优先样本均无需账号，正文人工粗估每篇约 2–5 千字符：印地语为天城文，印尼语、土耳其语和越南语为拉丁文字；土耳其语含特殊字母，越南语含丰富重音。清单链接的可读取性核对不等于扩展真实页面翻译已经通过。
