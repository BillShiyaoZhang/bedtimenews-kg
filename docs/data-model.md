# 数据模型

数据链路是：

```text
ontology
   ↓ 约束类型与关系
semantic KG event projection
   ↓ events[].newsId（一对一）
processed news
   ↓ news[].pageId + fragment
referenced page in the upstream repository
```

原始页面只是来源容器，不是 KG 的基本新闻单位。一个页面可以被拆成零条、一条或多条新闻；一条 processed news 当前只引用一个页面。跨来源的同一事实以后应进入独立的事实聚合层，不能通过合并页面破坏新闻边界。

## Processed news dataset

`data/processed/news.json` 是可审查的数据边界层。

```text
ProcessedNewsDataset
├── source                  上游仓库与版权说明
├── segmentation            拆分器、override 版本
├── pages[]                 原始 Markdown 页面
└── news[]                  独立新闻
```

### News

```json
{
  "id": "news-…",
  "title": "银川四所民办初中改为随机录取",
  "date": "2019-07-12",
  "datePrecision": "day",
  "summary": "用于检索的短摘要",
  "pageId": "page-…",
  "fragment": {
    "strategy": "manual_markers",
    "ordinal": 1,
    "sourceField": "body",
    "startLine": 33,
    "endLine": 64,
    "marker": "昨天的消息，银川市…",
    "contentHash": "sha256…"
  }
}
```

新闻 ID 来自“上游路径 + 拆分策略 + 稳定边界标记”，不再来自页面序号。`title` 来自对应新闻片段；若上游标题带有 `【睡前消息N】`、`【参考信息N】` 等页面栏目与期号前缀，processed news 会移除前缀，只保留具体新闻主题。`fragment` 精确指向构建时读取的原文片段；KG 构建前必须重新计算 SHA-256，位置或内容不匹配就停止。

`date` 表示该条新闻所属日报或节目的发布日期。正文中回顾的历史年份不会覆盖发布日期；只有页面日期完全未知时，才从新闻片段提取明确日期作为回退。

正式标题 `【睡前消息N】` 中的 `N`（包括 `13.5` 这样的加更编号）还构成节目时间轴约束：期号越大，`publishedAt` 不得更早。构建器优先使用路径、标题或节目开场白中的日期作为可信锚点，对归档导入时间、缺失日期和破坏期号顺序的正文笔误进行插值或外推。`【睡前消息2023暑假版第一期】` 一类特别版标题中的年份不会被误识别为期号。

部分上游页面只有 front matter 的多句 description、没有正文。这类新闻使用 `sourceField: "frontmatter.description"` 和精确行列范围，进入人工审查报告。

### Page

Page 保存：

- `archiveUrl`：可读存档页；
- `repositoryPath`、`repositoryUrl`：可审查 Git 历史的路径和链接；
- `publishedAt`、`kind`：时间与栏目；
- `dateProvenance`：原始观测日期、来源和期号时间轴校正方式；
- `episode`：从正式节目标题解析出的系列及数值期号（非节目页面没有此字段）；
- `contentHash`：完整页面哈希；
- `segmentation`：拆分策略、新闻数、置信度和审查原因。

## Knowledge graph

`data/generated/kg.json` 只消费 processed news：

```text
KnowledgeBase
├── source              数据集、拆分器与语义抽取版本
├── entities[]          主体、地点、主题与命名对象
├── events[]            每条独立新闻的一对一语义投影
├── eventRelations[]    有证据的新闻时序关系
├── entityRelations[]   预留的实体结构关系
└── sources[]           pages[] 的发布投影
```

### Event projection

```json
{
  "id": "event-…",
  "newsId": "news-…",
  "title": "独立新闻标题",
  "date": "2020-12-20",
  "datePrecision": "day",
  "type": "policy_governance",
  "summary": "用于检索的事实摘要",
  "entityIds": ["entity-organization-…", "entity-place-…"],
  "sourceIds": ["page-…"],
  "significance": ""
}
```

`events[]` 是 ontology 对独立新闻的语义投影，而不是原始页面。验证器强制：

- `events[].newsId` 全局唯一；
- processed news 与 event projection 数量相同；
- 标题、日期、摘要必须完全一致；
- `sourceIds` 必须只有一个，且等于新闻的 `pageId`。

### Entity

```json
{
  "id": "entity-organization-…",
  "label": "中国人民银行",
  "type": "organization",
  "aliases": [],
  "description": "由组织名称后缀规则识别的主体；在多条独立新闻中出现。",
  "extraction": {
    "method": "organization_suffix",
    "confidence": 0.84,
    "eventCount": 12
  }
}
```

实体 ID 由“类型 + 规范化名称”的哈希生成，跨次构建稳定。`eventCount` 为兼容现有 KG schema 保留，语义上表示关联的独立新闻数。

### Relation

```json
{
  "id": "relation-…",
  "from": "event-earlier",
  "to": "event-later",
  "type": "precedes",
  "viaEntityId": "entity-organization-…",
  "confidence": 1,
  "evidence": "两条新闻涉及同一实体且日期可确认先后；不表达因果。",
  "sourceId": "page-later"
}
```

同一新闻对只保留一条自动时序关系，避免热门地点或主题制造重复边。

## 拆分策略与人工修正

确定性拆分器依次使用：

1. 日报和参考信息中的编号标题；
2. 睡前消息访谈中的新话题引入语句；
3. Markdown 新闻分隔符；
4. 上游 description 的逐句元数据拆分；
5. 无可靠边界时整页回退，并进入审查队列。

`data/news-overrides.json` 可以按仓库路径声明 `boundaryMarkers`、强制单条新闻或排除页面。人工修正不会写进生成脚本，因而可独立评审和版本化。

## 增量状态

`data/archive-state.json` 保存文件 SHA-256、上游 commit、栏目范围、拆分器版本、override 版本和抽取规则版本。

新路径可以同时追加 page、news 和 KG 投影；既有路径内容变化、删除、疑似改名或重复复制只进入 `data/review/upstream-changes.json`。拆分或语义版本变化必须显式全量重建。
