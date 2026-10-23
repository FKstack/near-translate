# DeepL V5：匿名文本数组合计容量资格

2026-10-22。本次只实际发送了 **1 个固定公开请求：2 项合计 2,031 个 UTF-16 单元，返回 HTTP 400**。请求的固定 body／source SHA 与计划一致，原生自身扩展 Origin 核验通过；响应没有有效译文，资格立即停止，第二个计划请求没有发送。它是这个具体载荷在当次匿名路径被拒绝的直接证据，**不是服务端精确 1,500 硬边界的证明**。

本轮整理只读取既有记录，仅新增本文，没有重发请求、改变资格脚本／生产源码／预算或修改旧证据文档。

## 固定证据与实际发送量

| 项目 | 已保存事实 |
| --- | --- |
| 原始记录 | array-capacity qualification（本机历史文件 `.output/deepl-speed-v5/array-capacity-qualification-1792637549572-27db2e1a74ca.json`，未随仓库归档） |
| 记录 SHA-256 | `0de2e8454013dc023f1478ad6a30a364fdd02cd89f78b67b60e2b5d7111e678f` |
| 固定脚本 | qualify-array-capacity.mjs（本机历史文件 `.output/deepl-speed-v5/qualify-array-capacity.mjs`，未随仓库归档），SHA-256 `3123f4fac1959b2314367a5842482a2e83b96c6c1f6f08f695d00395da73db1a` |
| 固定公开输入 | `.output/deepl-speed/go-page-input.json`；SHA-256 `5c65015c55c525083d8cbf0047f66f6d83310abc59f49d74fcb8d4ecf8898407` |
| 地址／协议 | 固定 `https://oneshot-free.www.deepl.com/v1/translate`，POST JSON：`text:string[]`、`target_lang:'zh-Hans'`，省略来源语言 |
| 身份与凭证 | 原诊断扩展 ID `cpdfhfjfdjfibaogohckaljcbmoikdpc`，同路径／匿名 profile，fresh worker generation 核验；原生自身 Origin，`Authorization: None`，`credentials:omit`、`no-referrer`、`no-store` |
| 实际第一包 | 完整自然段 source 62（1,115）＋182（916），合计 **2,031**；每项均小于 1,500；UTF-8 JSON body 为 **2,077 字节** |
| 第一包 body SHA-256 | `754e5364a757bbded85b9d9a3336bd3d36e7b746380da9e75afe639023b9974c` |
| 两个原文 SHA-256 | 62：`df06e412ca367483671f0a7e81d1c160b695d8e83d22a1d3f1894ac988ba0ca2`；182：`29ecbb882f4606dd1215743776065b7dc60344082af55842140cdb76bc98875f` |
| 实际结果 | **HTTP 400**，JSON 错误响应，`translationCount:0`、`qualified:false`、`nativeWireQualified:true` |
| 第二包 | 计划加入 source 26（351），合计 2,382／3 项；**未发送、未测试** |
| 实际总量 | **1 POST、2 项、2,031 单元**；其他目标请求 0。4,413 是两步计划总上限，不是实际提交量 |

worker 在发送前对随后传给原生 fetch 的同一 body 字符串计算 SHA，并核对逐项 source SHA；结果与计划相同。CDP 另核验固定地址、POST、原生自身 Origin 和 JSON Content-Type。没有把本地 body 哈希表述为另行保存了完整 wire 请求体；诊断未记录凭证值或任意其他页面流量。

这次 `bodyMappingQualified:false` 表示未得到满足 2 项契约的译文响应，不表示预先固定的输入 body 被改坏。报告中 body／source 哈希及逐项长度都匹配，实际服务返回 400，因此后续资格不得继续。

## 错误响应能说明什么

安全投影只保留了顶层字段名：`type`、`title`、`status`、`errors`、`traceId`、`text_character_limit`。**这些字段的值没有保存**，包括 `text_character_limit` 的数字、`errors` 的内容和 trace ID；本报告不得补写其值为 1,500，或补造具体服务错误说明。

字段名提供了可能与请求校验／文字长度有关的线索，但不足以还原准确拒绝条件。记录未提取到已知安全错误类别／数字码或支持格式的数字 Retry-After；这表示该投影没有保留相应信息，不证明响应中不存在其他说明或数值。HTTP 400 也不能自动改称 413、429 或登录要求。

已知官方 `Fk` 的 1,500 是[固定客户端的逻辑输入合计规则](deepl-anonymous-budget-v3-2026-10-22.md)。本次增加了一个网络层的实际拒绝样本，两者应分别记录：官方客户端检查不是对所有匿名服务端路径的硬边界声明；2,031 被拒绝，也没有定位 1,501 至 2,030 区间的精确边界。不能由此声称“每项小于 1,500 就能乘数组项数扩大总量”。当前没有形成扩大生产预算的合格成功证据。

## 停止、计时与恢复

worker 在收到非 200 响应头时即锁定停止；最终状态为 `nextIndex:1`、`stopped:true`、`firstQualified:false`、`attemptedChars:2031`。driver 的失败分支也阻止第二项。既没有将 400 自动拆包重发，也没有重试、换身份／账号／地区／连接或清除冷却；网络观察确认只有一次 POST。

该请求为 h2、connection ID `79`，新建连接：connect 约 **1,921.502 ms**，其中 TLS **1,920.221 ms**；发送结束至响应头开始约 **669.586 ms**，完整 fetch 到错误 body 读取结束约 **2,596 ms**。connect 已包含 TLS，不能再相加；这些是拒绝响应的耗时，不能作为成功翻译延迟或吞吐量。

诊断会话已关闭，`originalBytesRestored:true`，恢复前后 SHA-256 一致：worker `54408165ed5f1639ab23a1038b4d4652c7b276ab7535dedf9e46580dd8d31b76`；manifest `eee4bf8e59c9505edc3e5e6a5a89c3810e615982beb5bfd033d1ab0da1547703`；helper `d7a9dcecd1e865ecd8747ecdf68a34f1d99e8f64db29eb2df989987faaeddf5e`。没有读取用户 Key／Cookie，未改变权限、服务能力字段或生产安装。

## 当前预算下的请求数下界

近译当前保留每请求合计 **1,500 UTF-16 单元**的客户端预算。给定相同、完整且无扩展译文缓存命中的 Go 原文 **53,505 单元**，即使理想装包也至少需要：

`ceil(53,505 / 1,500) = 36` 次正文请求。

因此，仅重新排序或填满现有包，不能把同样原文压到 30 包或更少，更不能减至 30 以下；每批项数上限、首包优先及保留自然段等约束只可能让实际包数更高。既有完整实测为 38 包；若另保留 137 单元独立首包，剩余部分在同预算下至少 36 包，总数至少 37，这是附加条件下的下界。

只按字数算，要容纳 30 包需每包容量至少 1,784；要少于 30 包，即最多 29 包，则至少 1,845。本次 2,031 被拒绝没有逐一测试这些数值，也不允许据此填入它们可用或不可用的结论。记录只支持：**本轮没有找到可采用的更大合计容量，当前 1,500 预算下的 36 包下界仍然成立。**

这是请求数量的算术下界，不是整页耗时下界，也不证明在其他合法协议能力或网络条件下永远无法达到某个速度目标。它不提供提高并发、撤销保护策略或继续枚举边界的服务端授权／稳定性依据。本轮资格已按第一包拒绝结束。
