# 离线 KG 候选与支持账本（阶段 C）

本阶段提供可运行的全量候选重算、可重放的抽取支持账本和稳定 ID 差异报告。
后续新增的[离线来源生命周期](reviewed-source-lifecycle.md)在独立命令中提供受审查的候选撤回与历史重放。
本页描述的 C 命令仍不改变普通 `kg:update` 的接受方式，也不提供 accepted source 的撤回、实体
合并/拆分或版本发布指针。这些操作仍需后续迁移。

## 使用

```bash
npm run kg:candidate -- --output work/candidates/review
npm run kg:candidate:validate -- work/candidates/review
```

可选 `--source PATH`、`--include roots`、`--generated-at ISO`；scope 必须与当前
archive state 一致。默认时间来自固定来源 Git commit，不能使用运行时钟；显示的
运行耗时和 RAM 只写到命令输出，不进入候选身份。来源内容由逐文件 SHA-256 绑定，
不能仅靠 Git commit 推断工作目录内容。

比较前一个候选：

```bash
npm run kg:candidate -- --baseline work/candidates/review --output work/candidates/next
npm run kg:candidate:validate -- work/candidates/next --baseline work/candidates/review
```

目标是新的离线目录。不能覆盖不同候选、源仓库、代码目录或 `data/`。同一完整
候选在同一路径重跑是幂等操作；损坏、残缺、额外文件、符号链接及输入失配都会
拒绝，不通过删除旧目录来重试。部分写入留在临时同级目录，只有全部校验成功才
原子改名为候选目录；这不等于多文件 accepted 数据或生产发布已具备原子事务。

## 包内容与边界

- `news.json`：重新运行当前拆分器生成的完整新闻候选
- `kg.json`：共享构建器生成的完整语义投影，包含旧版兼容类型和 topicEvidence
- `provenance.json.gz`：gzip 压缩的标准 JSON 审计账本，独立于前端
- `diff.json`：按稳定 ID 比较实体、新闻、关系、来源、断言及支持，不按数组位置比较
- `manifest.json`：精确输入、运行环境、版本及每个产物字节的哈希/大小

不要提交候选包或账本到 Git，也不要把它们 import 到应用。默认输出在忽略跟踪的
`work/candidates/`，PR 只提交构建器、测试与文档。日志只包含阶段、ID 和计数。
`provenance.json.gz` 可用常规 gzip 工具展开检查；不保存完整原始页或完整新闻正文。

manifest 绑定本体源与编译结果、抽取模式与编译结果、news overrides、所有实际
生成/验证模块的源码哈希、源文件清单、accepted baseline 以及 Node/ICU/Unicode/V8。
独立验证要求这些固定输入仍可读取；若代码或规则已变化，应恢复原固定版本后验证，
不能绕过 mismatch。先前候选作为 diff baseline 时校验其文件完整性；新候选仍必须
从当前固定源完整重放，diff 本身不是对旧候选的事实背书。

## 账本的含义

所有初始断言明确标记 `extraction_assignment`：

- 新闻投影 `assigned_entity` → 实体
- 新闻投影 `assigned_legacy_domain` → 兼容报道领域
- 新闻投影 `news_date_precedes` → 新闻投影

它们是抽取/检索/旧版新闻日期字段排序的结果，不是事实为真、因果关系、现实事件同一性
或已发生行动的判定。支持数不是独立来源数或事实置信度。

规范化记录链：

1. SourceRevision：来源逻辑身份、路径和完整文件哈希；包括不产生新闻的源文件
2. NewsRevision：现有 news ID、完整记录哈希、SourceRevision 与拆分配置绑定
3. Input / Evidence：实际消费的输入种类、规范化版本、输入哈希和可重放的精确见证
4. Observation / Retention：每个新闻/候选/方法/规则的识别结果，以及保留实体的前置条件
5. Assertion / Support / AssertionRevision：稳定语句身份、实际支持与当前物化状态
6. Classification / DateDerivation / ChronologyGroup：分类评分、日期来源和全局时序依赖

`title_summary`、`title_summary_fragment`、原片段、全局 `cleanText` 重扫必须区分。
正文以外的标题/摘要信号是派生新闻字段证据，不能伪装为原文片段坐标。
见证坐标采用指定规范化输入上的 UTF-16 `[start,end)`，不是原页字节坐标。
它通过 NewsRevision 回到 `news.json` 中的原页位置和片段哈希。

同一输入、同一词面重复出现只保存最早精确见证与出现次数；同新闻同规则的多次
命中合并为一个 Observation。不同规则、别名、来源新闻、人工审查链接和全局重扫
仍保留不同支持。重放重新运行完整匹配/评分，核实计数和见证，不靠首个位置猜测分数。
受审查链接没有文字命中时保存配置引用，不制造不存在的文字证据。

所有账本引用都在同一个候选 bundle 内解释。SourceRevision/NewsRevision 是内容身份；Retention 等逻辑节点有稳定 ID 和单独的修订标识。不能直接合并多个快照的表，再用新 Retention 解释旧支持。后续历史/撤回必须保留原 bundle 作用域或固定前置修订。拆分和 overrides 指纹规范化保存于账本级绑定，不在每条支持上重复。

原有候选保留门槛只计直接识别的不同新闻，不能由全局重扫链接反向自举。
最终 `eventCount` 仍计物化后的全部关联。拒绝的候选也记录下来，因而能解释新增
第二条直接报道后，为什么较早新闻突然获得某个实体。重复片段分组明确标记独立性
未建立；旧算法的“不同新闻计数”不能被解释成“独立来源计数”。

时序支持保留每个合格 via-entity，引用前后两个新闻、两个实体关联、两个日期推导
和整个实体提及集合。来源页日期未知而正文给出日期时，明确记录片段日期回退、其精确见证和 NewsRevision，不能把该回退当作已确认的发布日期。兼容 KG 仍只显示每对新闻的一条关系。地点 90 次、其他实体
250 次上限，相邻关系、同日/未知日期过滤及全库日期锚点都可能影响旧关系。

## 验证与维护

- 构建前完整比对 `acceptedFiles`；修改、删除、疑似改名、复制新增均拒绝
- 两个新增文件互相重复也拒绝；既有 `preserve_news` 审查应先由原 updater 严格接受
- 新闻重新拆分，完整页和片段重新验签，再调用共享 KG 构建器
- 每一条实体关联、领域分类、时序关系都必须有支持，支持与物化结果双向相符
- 第一次写入前从源完整重放；读回字节与已验证 manifest 完全一致才暴露候选目录
- 写入期间重新核对源、规则、代码和 accepted baseline，发现变化立即拒绝
- 独立 verifier 再次拆分源并重放，不能通过手改 news/KG/账本后更新一个哈希混过检查
- 第一次对比旧 accepted KG 时明确说明没有旧账本，不能把新记账的支持称作新知识

## 存储与保留

本账本是独立离线审计产物。保留策略建议为当前需要复核的候选和其一个比较基线；
工具不自动删除历史目录。先确认没有审查/回滚引用，再由维护者清理不再需要的候选。
同一输入重跑复用确定性目录，避免按当前时间生成无穷份副本。

当前预算：账本 gzip 不超过 64 MiB，完整候选产物不超过 128 MiB；超出即拒绝
暴露候选目录。gzip 解码另有 512 MiB 上限。预算是已绑定配方的一部分，不能通过
删支持或跳校验压低数字；需要扩容时应审查分区/规范化方案。

约 9,638 条新闻的验收快照：2,107 个源文件、176,525 个证据记录、108,723 个
抽取断言和 166,637 个支持。原先逐次词命中的原型账本约 428.6 MB / gzip 102.2 MB；
合并同输入同规则的重复派生后约 196.1 MB / gzip 43.4 MB，完整候选约 69.2 MB。
包含完整语义重放与暂存读回的实测约 90.3 秒，进程峰值 RSS 约 2.53 GiB，未提高
Node 默认堆上限。同一候选第二遍约 89.3 秒且 bundle ID 完全相同；独立验签约 51.3 秒、峰值 RSS 约 2.25 GiB。不同机器和数据规模会变化，命令每次输出实际耗时、峰值 RSS 和
产物总字节。主要剩余开销是按新闻、规则和身份区分的证据/支持引用，不是原文副本。

当前采用完整候选重算。后续增量优化必须先证明与该完整候选的等价性。

## 本离线候选工具之外的实现

后续已实现受审查来源生命周期、生产原子接受和新闻级身份合并/拆分，分别见
[来源维护](reviewed-source-lifecycle.md)、[接受流程](accepted-releases.md)与
[身份维护](entity-identities.md)。以下是本页所述早期离线阶段自身不承担的职责：

- 对已接受来源内容变更/删除做支持撤回，保留仍受其他支持的断言与休眠身份
- 可逆实体合并、拆分及 mention 身份历史
- 将 accepted 新闻、KG、索引和来源基线作为一个版本原子接受/发布/回滚
- 基于真实行动证据的行动抽取与跨新闻现实事件聚合

候选中删掉一条规则后剩余支持继续成立的测试，是候选重算契约；不授权 updater
接受来源删除，也不表示生产已有上述撤回生命周期。
