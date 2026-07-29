# 历史经纬 · Bedtime News Knowledge Atlas

一个面向 [`bedtimenews-archive-contents`](https://github.com/bedtimenews/bedtimenews-archive-contents) 的静态新闻 ontology 与知识图谱。原仓库的一个 Markdown 页面可以包含多条互不相关的新闻；本项目先把页面拆成独立新闻数据集，再以每条新闻为单位生成 KG。首页提供两种入口：

- 关键词搜索：同时检索事件标题、摘要、事件类型、实体名称与别名、来源元数据；统一处理中英文大小写、全半角、标点、行政区简称和经审查的缩写/同义词；
- 按条件检索：组合事件类型、主体、地点、主题、命名对象和时间范围。

首页命中的实体会进入独立详情页，联合展示相关新闻时间线、可交互知识图谱和原文证据。Ontology 浏览页展示 facet、实体/事件/关系类型、实例数量和实时覆盖率。

## 数据结构

项目维护两个可发布数据产物：

- `data/processed/news.json`：新闻级数据集，保存稳定新闻 ID、短摘要、原页面、精确行列范围、片段哈希和拆分方法；
- `data/generated/kg.json`：以 processed news 为输入的语义 KG。每个 `events[]` 记录通过 `newsId` 一对一投影一条独立新闻。

全量生成分五步：

1. 读取 8 个上游内容栏目，过滤导航页和未发布页面；
2. 按编号标题、访谈话题引入语句、新闻分隔符或人工 override 把页面拆成独立新闻；
3. 固化每条新闻的原页面位置和 SHA-256，并把低置信页面写入拆分审查报告；
4. KG 逐条重新读取并验签原文片段，再抽取主体、地点、设施、政策、命名文献与受控主题；
5. 仅为共同涉及同一高置信实体、且日期不同的相邻新闻生成 `precedes` 时序关系。

`data/ontology.json` 定义稳定的语义类型与首页 facet；`data/extraction-rules.json` 定义可复现的语义抽取规则；`data/news-overrides.json` 保存经人工审查的页面拆分修正。三者分开版本化。

`data/review/news-segmentation.json` 报告拆分策略、每页新闻数、待审页面，以及正式节目期号时间轴中的日期插值和异常校正。标题中的期号越大，最终发布日期保证不会更早；原始观测日期及其来源仍保留在 processed dataset 中。语义覆盖质量写入 `data/review/ontology-candidates.json`，包括：

- 事件是否具有语义实体、具体事件类型、可追溯来源和可检索字段（四项必填覆盖必须都是 100%）；
- 主体、地点、主题和命名对象的 facet 覆盖率；
- 非兜底事件类型覆盖率；
- 每类实体与事件的数量；
- 仍需审查的无实体、兜底类型样本；
- 各可选 facet 的出现率。Facet 只在语义适用时出现，不再把“没有命名政策/设施”误报成覆盖缺口。

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

修改拆分逻辑、`data/news-overrides.json`、ontology 或抽取规则后，都必须执行显式重建。重建会先确认不存在未解决的上游修改、删除、改名或重复新增，然后才同时替换 processed news 和 KG。版本不一致时，`kg:update` 会拒绝继续，避免把数据边界或语义迁移伪装成普通增量。

## 自动同步

`.github/workflows/sync-archive.yml` 每 6 小时检查一次上游，也支持手动触发与 `archive-updated` repository dispatch。检测到安全新增后会：

1. 更新 submodule；
2. 对 processed news 和 KG 运行 append-only 更新；
3. 校验原文片段哈希、page → news → KG 的一对一投影、ontology 与 100% 必填语义覆盖；
4. 构建静态站；
5. 将通过完整验证的同步直接提交到 `main`，并显式触发 GitHub Pages 部署。

语义覆盖失败仍然是 advisory：同步任务会创建或复用带
`coverage-advisory` 标签的 issue，并显式派发
`.github/workflows/remediate-coverage.yml` 做即时分诊。该 workflow 不调用模型，
也不需要 API key：若覆盖已经恢复，它会验证并关闭 issue；若仍然失败，就保持
issue 打开，交给 Codex App 中每天运行的 `Daily ontology and KG remediation`
scheduled task。

每日任务使用 ChatGPT/Codex 订阅下的 `gpt-5.6-sol` 与 `xhigh`（Extra High）
推理强度，系统审查 ontology、KG、抽取规则和搜索召回。它先确认本地 `main`
工作区干净，再读取固定审查提示词，仅允许修改受控的数据、应用、脚本、测试
和文档路径。只有完整 KG 校验、测试、lint 和两套生产构建全部通过后，修复才
会直接提交到 `main` 并关闭 issue；否则不提交、不推送并保留 issue。

由 `GITHUB_TOKEN` 创建 issue 不会再次触发普通 `issues` 事件，因此通知脚本会
用 `workflow_dispatch` 显式启动无模型分诊；人工创建、重新打开或添加该标签
仍会通过 `issues` 事件启动相同流程。

## 目录

```text
app/                         站点路由与界面
app/page.tsx                 关键词与条件检索首页
app/graph/page.tsx           实体相关新闻与 KG 可视化
app/ontology/page.tsx        Ontology 类型、约束与覆盖率
data/ontology.json           类型、关系与检索 facet
data/extraction-rules.json   版本化确定性抽取规则
data/news-overrides.json     经审查的页面拆分修正
data/processed/news.json     页面拆分后的独立新闻数据集
data/generated/kg.json       独立新闻的语义 KG 投影
data/archive-state.json      已接受上游文件的哈希基线
data/review/                 上游风险与覆盖质量报告
scripts/build-news.mjs       Markdown 页面 → 独立新闻
scripts/build-kg.mjs         独立新闻 → 语义 KG
scripts/update-kg.mjs        append-only 更新与显式重建
sources/                     新闻原库 submodule
tests/                       数据、抽取、增量保护契约
.github/workflows/           自动审查与 Pages 部署
```

## 设计边界

- 自动关系只表达可验证时序，不推断因果；
- 低置信命名模式必须跨事件复现后才进入主体或设施 facet；
- 全文保留在上游仓库，本项目只保存短摘要、出处、精确片段位置与哈希；
- 一条 KG 事件投影必须精确对应一条 processed news；跨来源的同一事实应在未来建立事实簇，而不是把多页直接拼成一条新闻；
- 必填覆盖与可选 facet 分开报告：每条新闻必须有实体、具体事件类型、来源与检索入口；主体、地点、主题和命名对象只统计出现率，不为追求数字强造实体。
- 站点只通过 GitHub Pages 发布；本项目不使用 OpenAI Sites 部署。
