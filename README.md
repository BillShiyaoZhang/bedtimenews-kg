# 历史经纬 · Bedtime News Knowledge Atlas

一个面向 [`bedtimenews-archive-contents`](https://github.com/bedtimenews/bedtimenews-archive-contents) 的静态新闻 ontology 与知识图谱。首页提供两种入口：

- 关键词搜索：同时检索事件标题、摘要、主体、地点、主题与原文标题；
- 按条件检索：组合事件类型、主体、地点、主题、命名对象和时间范围。

首页命中的实体会进入独立详情页，联合展示相关新闻时间线、可交互知识图谱和原文证据。Ontology 浏览页展示 facet、实体/事件/关系类型、实例数量和实时覆盖率。

## 数据结构

项目只有一个可发布 KG：`data/generated/kg.json`。旧的手工示例层和 seed 词表已经删除，避免少量示例覆盖或混入全量语义数据。

全量生成分四步：

1. 读取 8 个上游内容栏目，过滤导航页和未发布页面；
2. 日报按二级标题拆分，长文按新闻分隔符拆成事件；
3. 使用版本化规则抽取主体、地点、设施、政策、命名文献与受控主题；
4. 仅为共同涉及同一高置信实体、且日期不同的相邻事件生成 `precedes` 时序关系。

`data/ontology.json` 定义稳定的语义类型与首页 facet；`data/extraction-rules.json` 定义可复现的抽取规则。二者分开版本化。

当前覆盖质量写入 `data/review/ontology-candidates.json`，包括：

- 事件是否具有语义实体；
- 主体、地点、主题和命名对象的 facet 覆盖率；
- 非兜底事件类型覆盖率；
- 每类实体与事件的数量；
- 仍需审查的无实体、兜底类型样本。

## 快速开始

需要 Node.js 22 或更高版本。

```bash
git submodule update --init --recursive
npm install
npm run dev
```

完整验证：

```bash
npm test
```

## 更新与重建

日常上游更新使用：

```bash
git -C sources/bedtimenews-archive-contents fetch origin main
git -C sources/bedtimenews-archive-contents checkout --detach origin/main
npm run kg:update
```

安全策略保持 append-only：

- 新文件自动追加；
- 已接受文件的修改、删除、疑似改名或重复复制只进入审查报告；
- 增量更新不会静默重写既有事件或关系。

修改 ontology 或抽取规则后，必须显式运行：

```bash
npm run kg:rebuild
```

语义重建会先确认不存在未解决的上游修改、删除、改名或重复新增，然后才全量替换生成 KG。规则版本不一致时，`kg:update` 会拒绝继续，避免把语义迁移伪装成普通增量。

## 自动同步

`.github/workflows/sync-archive.yml` 每 6 小时检查一次上游，也支持手动触发与 `archive-updated` repository dispatch。检测到安全新增后会：

1. 更新 submodule；
2. 运行 append-only 更新；
3. 校验 ontology、KG 与覆盖阈值；
4. 构建静态站；
5. 创建或刷新审查 Pull Request。

自动化不会直接写入 `main`，也不会自动执行语义重建。

## 目录

```text
app/                         站点路由与界面
app/page.tsx                 关键词与条件检索首页
app/graph/page.tsx           实体相关新闻与 KG 可视化
app/ontology/page.tsx        Ontology 类型、约束与覆盖率
data/ontology.json           类型、关系与检索 facet
data/extraction-rules.json   版本化确定性抽取规则
data/generated/kg.json       唯一的全量可发布 KG
data/archive-state.json      已接受上游文件的哈希基线
data/review/                 上游风险与覆盖质量报告
scripts/build-kg.mjs         Markdown → 语义 KG
scripts/update-kg.mjs        append-only 更新与显式重建
sources/                     新闻原库 submodule
tests/                       数据、抽取、增量保护契约
.github/workflows/           自动审查与 Pages 部署
```

## 设计边界

- 自动关系只表达可验证时序，不推断因果；
- 低置信命名模式必须跨事件复现后才进入主体或设施 facet；
- 全文保留在上游仓库，本项目只保存检索所需的短摘要和出处；
- 任何覆盖率都是分维度报告，不用一个总数代替语义质量。
- 站点只通过 GitHub Pages 发布；本项目不使用 OpenAI Sites 部署。
