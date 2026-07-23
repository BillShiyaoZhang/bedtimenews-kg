# 数据模型

`data/generated/kg.json` 是唯一可发布知识图谱。所有记录都由上游存档、ontology 与版本化抽取规则确定性生成。

```text
KnowledgeBase
├── source              来源、生成模式与规则版本
├── entities[]          主体、地点、主题与命名对象
├── events[]            可检索事件
├── eventRelations[]    有证据的事件时序关系
├── entityRelations[]   预留的实体结构关系
└── sources[]           原文与仓库出处
```

## Entity

```json
{
  "id": "entity-organization-…",
  "label": "中国人民银行",
  "type": "organization",
  "aliases": [],
  "description": "由组织名称后缀规则识别的主体；在多条存档事件中出现。",
  "extraction": {
    "method": "organization_suffix",
    "confidence": 0.84,
    "eventCount": 12
  }
}
```

ID 由“类型 + 规范化名称”的哈希生成，跨次构建稳定。`extraction` 说明方法、规则置信度和进入候选表时的事件数。

## Event

```json
{
  "id": "event-…",
  "title": "事件标题",
  "date": "2020-12-20",
  "datePrecision": "day",
  "type": "policy_governance",
  "summary": "用于检索的事实摘要",
  "entityIds": ["entity-organization-…", "entity-place-…"],
  "sourceIds": ["source-…"],
  "significance": ""
}
```

日报按二级标题拆分；其他长文按新闻分隔符拆分。事件 ID 来自“上游路径 + 段落序号 + 标题”。日期统一为 `YYYY-MM-DD`，未知月日用 `01` 补足并在 `datePrecision` 标记。

## Relation

```json
{
  "id": "relation-…",
  "from": "event-earlier",
  "to": "event-later",
  "type": "precedes",
  "viaEntityId": "entity-organization-…",
  "confidence": 1,
  "evidence": "两事件均明确涉及同一实体，且日期可确认先后；不表达因果。",
  "sourceId": "source-later"
}
```

同一事件对只保留一条自动时序关系，避免热门地点或主题制造重复边。

## Source

来源同时保存：

- `archiveUrl`：可读存档页；
- `repositoryPath`：原始 Markdown 路径；
- `repositoryUrl`：可审查 Git 历史的链接；
- `publishedAt` 与 `kind`：时间和栏目。

## 增量状态

`data/archive-state.json` 保存：

- 已接受文件的 SHA-256；
- 上游 commit；
- 纳入的栏目目录；
- 当前抽取规则版本。

新路径可以追加；既有路径内容变化、删除、疑似改名或重复复制只进入 `data/review/upstream-changes.json`。
