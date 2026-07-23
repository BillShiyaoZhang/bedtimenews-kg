# 数据模型

`data/kg.json` 是浏览器直接载入的静态知识图谱。所有 ID 都应稳定、可读，并在合并前通过 `npm run kg:validate`。

## 顶层结构

```text
KnowledgeBase
├── source              数据来源与生成模式
├── entities[]          可跨事件复用的实体
├── events[]            发生在时间轴上的事实单元
├── eventRelations[]    事件之间的解释性关系
├── entityRelations[]   实体之间的结构关系
└── sources[]           原文与仓库出处
```

## Entity

```json
{
  "id": "org-yangtze-rail",
  "label": "长江沿岸铁路集团",
  "type": "organization",
  "aliases": ["沿江铁路公司"],
  "description": "用于消歧和解释实体边界的短说明"
}
```

- `id`：稳定主键，不因改名改变；
- `type`：必须存在于 `ontology.entityTypes`；
- `aliases`：用于检索与确定性匹配；
- `description`：说明“这个实体是谁/是什么”，避免同名混淆。

## Event

```json
{
  "id": "event-2020-yangtze-company",
  "title": "长江沿岸铁路集团挂牌成立",
  "date": "2020-12-20",
  "datePrecision": "day",
  "type": "infrastructure",
  "summary": "可检索的事实摘要",
  "entityIds": ["org-yangtze-rail", "concept-yangtze-rail"],
  "sourceIds": ["source-main-214"],
  "significance": "这件事在长期路径中的意义"
}
```

`date` 始终写为 `YYYY-MM-DD`。如果原文只确认年份或月份，用 `datePrecision` 声明精度，并用 `01` 补足未知部分。

`summary` 应尽量陈述原文事实；`significance` 可以给出历史解释，但应与关系证据相互支持。

## Relation

```json
{
  "id": "rel-6",
  "from": "event-2014-huhanrong",
  "to": "event-2020-yangtze-company",
  "type": "responds_to",
  "confidence": 0.88,
  "evidence": "说明关系为什么成立，以及依据来自哪里",
  "sourceId": "source-main-214"
}
```

- `from` / `to`：必须引用存在的同类节点；
- `type`：必须存在于 `ontology.relationTypes`；
- `confidence`：`0` 到 `1`；不是统计概率，而是维护者对关系证据完整度的记录；
- `evidence`：必填。应能让另一位维护者复核关系；
- `sourceId`：证据依赖的主要出处。

## Source

来源同时保留：

- 可读的存档站地址 `archiveUrl`；
- 原始 Markdown 的 `repositoryPath`；
- 可直接审查版本历史的 `repositoryUrl`。

这使 KG 中的每个结论都能回到原始文本与 Git 历史。
