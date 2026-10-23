# 真实翻译质量验收样例

这些样例用于配置真实 DeepSeek Key 后进行人工验收。自动化模拟 API 只验证交互和协议，不能证明真实翻译质量。

默认配置：`deepseek-flash`、非思考模式、简体中文、上下文开启。建议对比开启与关闭上下文时的多义词结果。每例记录中文译文、首内容等待时间、总耗时与判断。

## 技术与编程（5 例）

| 选中内容 | 上下文或验收重点 |
| --- | --- |
| `race` | “The race occurs when two threads update the same counter.” 应理解为竞争条件，而非赛跑。 |
| `The pointer is valid until the owning object is destroyed.` | 明确对象销毁后指针不再有效，保留生命周期含义。 |
| `A cache miss does not necessarily imply a network request.` | 不丢失 “does not necessarily” 的非必然关系。 |
| `Keep std::unique_ptr<T> unchanged and release the lock before invoking the callback.` | 保留代码标识符；先释放锁再调用回调。 |
| `The time complexity is O(n log n).\nThe algorithm uses 128 MB of auxiliary memory.` | 按两段测试，保留复杂度、128 MB 和段落。 |

## 日常与新闻（5 例）

| 选中内容 | 上下文或验收重点 |
| --- | --- |
| `bank` | “They rested on the bank of the river.” 应解释河岸，而非银行。 |
| `The proposal is still on the table.` | 语境应为仍在考虑中的提案，而非字面放在桌上。 |
| `Revenue rose by 12%, while profit fell by 3%.` | 不交换增长/下降、营收/利润或数字。 |
| `The company denied that it had reached an agreement.` | 保留否认达成协议，不误译为已达成。 |
| `The new policy will take effect next month.\nExisting applications will continue under the previous rules.` | 保留新旧申请的条件区别与两段结构。 |

## 学术资料（5 例）

| 选中内容 | 上下文或验收重点 |
| --- | --- |
| `significant` | “The difference was statistically significant (p < 0.05).” 应体现统计显著性。 |
| `Correlation does not establish causation.` | 相关不意味着因果，不能删掉否定。 |
| `The null hypothesis could not be rejected at the 5% level.` | 不能将无法拒绝原假设翻译为已证明原假设正确。 |
| `The results suggest, but do not prove, that the intervention is effective.` | 保留证据强度区别。 |
| `For x > 0, the function f(x) = ln(x) is strictly increasing.\nHowever, the estimate may be biased in small samples.` | 保留公式、条件、转折和小样本偏差。 |

## 通过标准

每例应忠实、中文通顺，关键术语、数字、公式和否定/条件关系正确，未添加原文不存在的事实；单词释义符合上下文。发现误译后记录具体例子并调整提示词或模型设置，再复核三类样例。

0.1.1完成JavaScript真实调用；0.2.0又完成description、河岸语境bank、动词语境record的真实词典调用，确认同时返回当前句义与其他常见词性/义项。Key未读取或导出。上述15个质量样例仍未全部执行，需要另外记录译文与延迟。

词义核对参考出版方词典：[Cambridge description](https://dictionary.cambridge.org/dictionary/english/description)、[of every description](https://dictionary.cambridge.org/dictionary/english/of-every-description)、[bank](https://dictionary.cambridge.org/dictionary/english/bank)。这些是验收参考，扩展运行时仍只调用已配置的DeepSeek，不发送内容到词典网站。
