# 历史经纬 · Bedtime News Knowledge Atlas

一个面向 [`bedtimenews-archive-contents`](https://github.com/bedtimenews/bedtimenews-archive-contents) 的静态新闻知识图谱：从人物、组织、地点、产业或议题进入，在时间线上查看相关事件，并沿有证据的关系追踪事件前后关联。

> 一条新闻，放回时间里看。

## 能做什么

- 按实体名称和别名检索新闻事件；
- 用统一时间线阅读同一议题跨越数十年的变化；
- 显示事件之间的“先于、促成、回应、延续、对照”等关系；
- 每个事件和关系都保留原始 Markdown 路径与存档链接；
- 在浏览器里检查、修改 ontology、事件和关系证据；
- 实时检查悬空引用、未知类型、重复 ID、缺失证据与非法日期；
- 导入/导出完整 JSON 工作区，通过 Pull Request 回写；
- 完全静态，可直接部署到 GitHub Pages。

当前仓库的数据分成两层：

1. `data/generated/kg.json` 是从 8 个上游内容栏目建立的全量、确定性事件索引；
2. `data/kg.json` 是人工校订层，目前包含沿江铁路和能源安全两条示例链。

网页会合并两层数据：自动层保证原文覆盖，人工层补充实体消歧、历史事件和有证据的解释关系。自动抽取不等同于完整语义标注，覆盖缺口会写入审查报告。

## 快速开始

需要 Node.js 22 或更高版本。

```bash
git submodule update --init --recursive
npm install
npm run dev
```

本地打开开发服务器输出的地址。常用检查：

```bash
npm run kg:validate
npm test
npm run build:pages
```

`npm run build:pages` 在 `out/` 生成可直接托管的静态站点。

## 更新新闻索引

新闻原库固定为 Git submodule：

```bash
git submodule update --init --recursive
git -C sources/bedtimenews-archive-contents fetch origin main
git -C sources/bedtimenews-archive-contents checkout --detach origin/main
npm run kg:update
```

`kg:update` 默认覆盖 `main`、`daily`、`reference`、`opinion`、`business`、`commercial`、`livestream`、`shorts` 八个内容目录。更新策略是：

- 上游新增文件：自动解析并只追加新来源、事件和时间关系；
- 上游既有文件被修改：保留已接受记录，只写审查报告；
- 上游文件被删除、改名或重复复制：同样不自动删除、不自动迁移；
- ontology 与实体词典：只生成覆盖缺口，不自动改写。

第一次建立全量基线时才使用 `npm run kg:bootstrap`。该命令在基线文件已经存在时会拒绝覆盖，避免误把增量更新变成全量重建。

生成流程是确定性的：

1. 解析 Wiki.js 风格 front matter；
2. 每日新闻按二级标题拆为事件，其他节目和栏目按篇建立事件；
3. 使用 `data/seeds/entities.json` 的名称与别名匹配实体；
4. 仅自动生成同一实体相邻事件的时间先后关系，不自动声称因果；
5. 生成后立即执行完整引用校验。

`data/archive-state.json` 保存已接受文件的内容哈希，`data/review/upstream-changes.json` 保存需要人工处理的上游变更，`data/review/ontology-candidates.json` 保存实体与事件类型覆盖缺口。详细约束见 [数据模型](docs/data-model.md) 和 [本体设计](docs/ontology.md)。

## 自动同步

`.github/workflows/sync-archive.yml` 每 6 小时检查一次上游，也支持手动运行和 `archive-updated` repository dispatch。发现变化后会更新 submodule、执行保守增量更新、跑完校验和静态构建，并创建或刷新一个审查 Pull Request；不会直接写入 `main`。

要实现近实时触发，可以在上游 webhook 或另一个可信工作流中向本仓库发送 `archive-updated` repository dispatch。没有额外凭据时，定时轮询仍会自动发现新内容。

## 维护流程

### 在网页中校订

1. 打开“维护工作台”；
2. 修改本体类型、事件记录或关系证据；
3. 观察底部实时校验结果；
4. 点击“导出 JSON”；
5. 将导出文件中的 `ontology` 与 `kg` 分别更新到 `data/ontology.json` 和 `data/kg.json`；
6. 运行 `npm test` 并发起 Pull Request。

网页改动默认保存在浏览器 `localStorage`，不会直接写 GitHub，也不会上传任何内容。

### 数据审查原则

- `precedes` 只表示时间先后，不表示因果；
- `enables` 和 `responds_to` 必须在 `evidence` 中说明判断依据；
- 一个事件至少引用一个原文来源；
- 一个实体 ID 应跨时间保持稳定，别名变化不创建新 ID；
- 摘要只保存检索所需信息，完整内容留在原仓库；
- 争议性解释应降低 `confidence`，并保留可复核的原文出处。

## GitHub Pages 部署

仓库已包含 `.github/workflows/pages.yml`。推送到 `main` 后：

1. 在 GitHub 仓库的 **Settings → Pages** 中，将 Source 设为 **GitHub Actions**；
2. 重新运行 `Deploy GitHub Pages` workflow；
3. 站点会自动适配 `https://<owner>.github.io/<repo>/` 子路径。

Pull Request 与其他分支会运行数据、测试和静态构建检查，但不会部署。

## 目录

```text
app/                         检索、时间线、图谱与维护界面
data/ontology.json           本体类型与关系约束
data/kg.json                 人工校订层
data/generated/kg.json       全量自动事件索引（append-only）
data/archive-state.json      已接受上游文件的哈希基线
data/review/                 上游风险变更与 ontology 覆盖报告
data/seeds/                  确定性实体与关系种子
scripts/build-kg.mjs         Markdown → KG 生成器
scripts/update-kg.mjs        保守增量更新器
scripts/validate-kg.mjs      命令行校验器
sources/                     新闻原库 submodule
tests/                       数据契约与证据检查
.github/workflows/           PR 检查与 Pages 部署
```

## 设计边界

这是一个静态、可审查的研究工具，不是自动给新闻下结论的系统。Ontology 约束“可以怎样描述”，KG 记录“目前基于哪些来源作了怎样的判断”。二者都应允许版本化、讨论和回滚。

原文来自睡前消息存档仓库；本仓库只保存结构化索引、短摘要和出处链接。原文版权与使用条款以原仓库为准。
