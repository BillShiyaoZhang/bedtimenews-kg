# 历史经纬 · Bedtime News Knowledge Atlas

一个面向 [`bedtimenews-archive-contents`](https://github.com/bedtimenews/bedtimenews-archive-contents) 的新闻阅读、检索与知识探索界面。原仓库的一个 Markdown 页面可以包含多条互不相关的新闻；本项目先把页面拆成独立新闻数据集，再以每条新闻为单位生成 KG。

- 首页默认展示最新新闻；「近 7 天」「近 30 天」「新实体」「议题标签」帮助选择阅读入口。近期范围按北京时间当前日计算，不把新收录的历史报道当成今天的新闻。没有版本新增实体或更新信息缺失时，提供近 30 天有报道关联的实体与议题，并明确标为「近期有新报道」。
- 搜索同时匹配多个关键词，也可叠加人物、地点、议题、领域与年份；高级描述筛选默认折叠。新闻每页 20 条，支持最新或相关度排序，检索条件保存在 URL 中。
- 点击新闻标题或摘要，在当前界面阅读；独立的 `/news/{newsId}/` 地址支持分享和新标签页。来源与证据放在正文之后，返回时保留检索与探索位置。
- 点击实体查看资料与相关新闻；在「探索关系」中继续展开节点，保留原有内容，可撤销、收起分支或明确选择新起点。手机优先显示新闻，图谱按需展开。

已读记录仅保存在当前浏览器；首次访问从最新新闻开始，回访提示按上次访问后出现的 ID 计算。「知识分类」页保留本体层级、类型、关系约束和覆盖率。设计与验收记录见 [每日阅读体验](docs/daily-reading-ux.md)。

截至本轮本地交付，正式接受版本仍为 candidate v3。站内完整正文已在独立、验签的本地预览中实现；正式 v3 页面会明确提示「此接受版本尚未收录正文」，并保留摘要与原始档案链接。此次界面交付不表示已经发布 v4。正式正文上线需要[两阶段接受迁移](docs/accepted-releases.md)。

## 数据结构

项目维护两个基础可发布数据产物；candidate v4 额外接受完整正文快照：

- `data/processed/news.json`：新闻级数据集，保存稳定新闻 ID、短摘要、原页面、精确行列范围、片段哈希和拆分方法；
- `data/generated/kg.json`：以 processed news 为输入的语义 KG。每个 `events[]` 记录通过 `newsId` 一对一投影一条独立新闻。
- `data/processed/news-content.json`：仅 v4 接受版本包含，保存验签的完整原文新闻片段及生命周期派生的新增、恢复和历史 ID 索引。canonical JSON 由接受 receipt 绑定，同一内容以 `news-content.json.gz` 保存在该版本的审计包中。

已接受 v4 站点仅凭上述 tracked JSON 和接受清单即可生成阅读资源，在上游源码不可用时重建正文页面；首次生成和新来源提取仍需验证固定的上游 Git 对象。v3 正式构建明确显示正文未收录；v4 缺少或篡改正文会拒绝构建。本轮真实语料验证、容量和两阶段迁移的具体绑定见 [正文迁移评审](docs/news-content-migration-review.md)。

全量生成分五步：

1. 读取 8 个上游内容栏目，过滤导航页和未发布页面；
2. 按编号标题、访谈话题引入语句、新闻分隔符或人工 override 把页面拆成独立新闻；
3. 固化每条新闻的原页面位置和 SHA-256，并把低置信页面写入拆分审查报告；
4. KG 逐条重新读取并验签原文片段，再抽取主体、地点、设施、政策、命名文献与受控主题；
5. 仅为共同涉及同一高置信实体、且日期不同的相邻新闻生成 `precedes` 时序关系。

`data/ontology-source.json` 是唯一的语义定义源，管理实体类、事件行动、议题层级、名称/别名、角色、关系和兼容映射；`data/extraction-patterns.json` 只维护引用稳定 ID 的抽取信号。`npm run ontology:compile` 生成供抽取器、校验器和前端共用的 `data/ontology.json` 与 `data/extraction-rules.json`，不要手改这两个产物。主题 `aliases` 只保存真正同义名称，`extractionTriggers` 只负责抽取，`event.topicEvidence` 只保存该条新闻片段实际命中词。维护方法见 [本体与编译流程](docs/ontology.md)。

首页主题条件支持 8 个一级领域和 27 个既有议题的父子筛选，结果说明直接关联或由下级归入。旧 `event.type` 保留为兼容报道领域；独立行动评估只启用有精确报道证据的司法、工程和同比/环比变化类，其余行动类仍为草案。支持记录的更正、撤回和恢复走审查候选与接受流程，不把报道描述等同于已核实的现实事件；完整边界见下方维护指南。

`data/review/news-segmentation.json` 报告拆分策略、每页新闻数、待审页面，以及正式节目期号时间轴中的日期插值和异常校正。标题中的期号越大，最终发布日期保证不会更早；原始观测日期及其来源仍保留在 processed dataset 中。语义覆盖质量写入 `data/review/ontology-candidates.json`，包括：

- 事件是否具有语义实体、具体事件类型、可追溯来源和可检索字段（四项必填覆盖必须都是 100%）；
- 主体、地点、主题和命名对象的 facet 覆盖率；
- 非兜底事件类型覆盖率；
- 每类实体与事件的数量；
- 仍需审查的无实体、兜底类型样本；
- 各可选 facet 的出现率。Facet 只在语义适用时出现，不再把“没有命名政策/设施”误报成覆盖缺口。

## 快速开始

使用 Node.js 22.23.2，与本仓库接受配方的运行时一致。

```bash
git submodule update --init --recursive
npm ci
npm run dev
```

打开终端显示的本地地址。`predev` 会自动构建按需读取的新闻与实体 JSON 资源；首页只加载检索和摘要所需的展示数据。默认使用正式接受数据，不会因为本地存在一个正文文件而自动启用预览。

如需查看已经独立验签的本地正文预览，在 PowerShell 中显式设置预览文件，再启动服务：

```powershell
$env:KG_CONTENT_PREVIEW_PATH = (Resolve-Path 'work/ux-review/news-content.json').Path
npm run dev
```

该文件是本地审查产物，不包含在仓库的正式接受清单中；没有此文件时使用上面的默认启动方式。读取器会验证新闻、KG、源提交与有效清单绑定，并在正文上显示预览提示。关闭预览时移除 `KG_CONTENT_PREVIEW_PATH` 后重新启动。Actions 拒绝发布预览输入。

构建后在本机运行生产产物：

```bash
npm run build
npm start
```

如果产物包含 `dist/server/wrangler.json`，`npm start` 使用 Wrangler `--local` 运行 Cloudflare Worker 及其静态资源绑定，默认地址为 `http://127.0.0.1:3000`。端口可通过 `PORT`、`-p` 或 `--port` 设置；主机可通过 `-H` 或 `--hostname` 设置，例如 `npm start -- --port 3001 --hostname 127.0.0.1`。Node 产物继续使用 `vinext start`。静态 Pages 使用 `npm run build:pages` 生成 `out/`，在静态服务中按构建时的 `PAGES_BASE_PATH` 访问。

Windows 的 Pages 构建默认使用 Next.js 官方生产 Webpack 模式，避免已实测的 Turbopack/PostCSS 子进程通信超时；Linux 发布构建保持框架默认模式。可通过 `npm run build:pages -- --turbopack` 显式选择 Turbopack，或传入 `--webpack` 固定 Webpack。

常规完整验证和两套生产构建：

```bash
npm test
```

界面定向测试和浏览器验收：

```bash
node --test tests/explorer-state.test.mjs tests/explorer-presentation.test.mjs tests/report-description-ui.test.mjs tests/reading-memory.test.mjs
npx playwright install chromium
npm run test:browser
```

浏览器测试默认连接已启动的 `http://127.0.0.1:3000`；可用 `PLAYWRIGHT_BASE_URL` 指定测试服务，`PLAYWRIGHT_BASE_PATH` 指定子路径。生产验收使用构建后的服务，截图保存在 `outputs/ux-review/`。静态 Pages 构建通过 `PAGES_BASE_PATH` 或 Actions 的仓库名设置子路径，新闻链接和阅读资源必须在该子路径下可访问。本轮静态验收地址为 `http://127.0.0.1:3100/bedtimenews-kg/`。受审查迁移中的代码与接受配置不一致时，应使用隔离候选验证流程，不修改接受清单来让检查通过。

## 当前维护模式

本仓库已在 2026-09-30 完成首个版本化接受，并保存 `data/accepted-release.json`。
[首次同步](https://github.com/BillShiyaoZhang/bedtimenews-kg/actions/runs/36788236991)、
[匹配接受提交的 Pages 部署](https://github.com/BillShiyaoZhang/bedtimenews-kg/actions/runs/36789775976)
均已成功。当前维护应使用下方的版本化接受与审查迁移流程；这些历史结果不代替后续运行检查。
已有 state4/接受清单时，旧 update、rebuild、bootstrap 命令会在写入前拒绝。

## 更新与重建（仅无接受清单的旧模式）

以下保留为旧模式说明，不适用于本仓库当前已接受状态。旧模式日常上游更新使用：

```bash
git -C sources/bedtimenews-archive-contents fetch origin main
git -C sources/bedtimenews-archive-contents checkout --detach origin/main
npm run kg:update
```

安全策略保持 append-only：

- 新文件自动追加；
- 已接受文件的修改先进入审查；每日任务可自主审查不改变既有新闻的目录、元数据和正文补充，在 `data/source-revisions.json` 记录精确旧、新哈希后由同步接受；
- 删除、疑似改名或重复复制继续保留待审；
- 增量更新不会静默重写既有事件或关系。

已审查的文件版本也必须重新核验全部新闻记录、日期、边界与片段哈希，以及除完整文件哈希外的全部页面元数据。任何一项变化都会拒绝应用该审查记录；完整来源校验不会跳过。具体流程见 `docs/source-revisions.md`。

修改本体定义或抽取模式时，显式更新对应版本，然后运行：

```bash
npm run ontology:compile
npm run kg:rebuild
npm run ontology:check
```

修改拆分逻辑、`data/news-overrides.json`、ontology 或抽取规则后，都必须执行显式重建。重建会先确认不存在未解决的上游修改、删除、改名或重复新增，然后才同时替换 processed news 和 KG。版本不一致时，`kg:update` 会拒绝继续，避免把数据边界或语义迁移伪装成普通增量。

## 离线全量候选与审计

`npm run kg:candidate -- --output work/candidates/review` 可生成隔离的完整候选、
抽取支持账本和稳定 ID 差异报告。`npm run kg:candidate:validate -- work/candidates/review`
从固定源重新拆分、验签并重放。账本压缩保存于候选目录，不进入 Git 历史或前端。
这套命令不会更新 accepted 数据，也不放开来源内容修改或删除；它是独立候选工具，
不能代替当前的 `kg:release:sync` 接受流程。完整契约见 [候选与支持账本](docs/candidate-lifecycle.md)。

## 版本化接受与恢复

[版本化发布操作指南](docs/accepted-releases.md) 提供完整候选重算、支持账本、
草稿审计包读回、原子接受和发布恢复。本仓库已完成获准后的首次接受与公开审计发布；
具体历史证据及仍需满足的开关见该指南。新部署仍需单独的存储与启用批准，
实现合并本身不是授权。不要因开关缺失而尝试用旧同步命令绕过已有接受清单。

启用后的日常来源更新由 Actions 运行 `kg:release:sync`；历史修改、删除或
撤回必须提供精确哈希绑定的审查。无变化时复用原版本。失败先核实远端状态，
不会盲目重传或重复提交。`kg:release:recover` 可在原始上游不可用时恢复已接受
版本的发布，但不声称重新完成来源抽取。

语义或运行时变更使用 `kg:release:migration:preview` 审查精确差异，再用一次
`kg:release:migration:prepare` 生成同时包含代码与数据的评审提交；仍需正常 PR
审批与保留提交历史的 merge。该命令不能推送 main。同一语义版本内的前向回滚
会保留较新身份和来源撤回记录。跨语义版本回滚、新闻边界身份映射和同一新闻内的
出现级身份拆分仍不支持，不能通过改哈希或跳过验证替代。经审查的新闻级实体归属
合并/拆分已接入同一迁移路径，见下方身份维护说明。

一旦存在 state4 或接受清单，旧 `kg:update`、`kg:rebuild`、`kg:bootstrap`
会在写入前拒绝运行；下方 append-only 与直接语义修复流程不再适用于该模式。

## 自动同步（旧模式）

`.github/workflows/sync-archive.yml` 每 6 小时检查一次上游，也支持手动触发与 `archive-updated` repository dispatch。检测到安全新增后会：

1. 更新 submodule；
2. 对 processed news 和 KG 运行 append-only 更新，并应用精确匹配的来源版本审查；
3. 校验原文片段哈希、page → news → KG 的一对一投影、ontology 和最小语义实体约束，再执行独立的覆盖检查；
4. 构建静态站；
5. 将通过完整验证的同步直接提交到 `main`，并显式触发 GitHub Pages 部署。

语义覆盖失败仍然是 advisory：同步任务只创建或复用带
`coverage-advisory` 标签的 issue，不派发额外 workflow，也不在 GitHub Actions
中调用大模型。Codex App 中每天运行的
`Daily ontology and KG remediation` scheduled task 是唯一的语义修复执行者。

同步的 checkout、安装、更新、必需验证、构建、推送或部署派发失败时，独立通知
job 会创建或更新 `sync-failure` issue。每日任务同时直接检查 `main` 的最新同步
Actions 运行和日志，即使没有 issue 也会发现故障；API 查询受阻不会被当作
“无事项”。它按最新已完成运行判断是否恢复，避免反复处理已被成功运行覆盖的
历史失败。GitHub 邮件不直接触发 Codex；当前 Windows 任务每天北京时间 09:00 检查。

每日任务使用 ChatGPT/Codex 订阅下的 `gpt-6-astra` 与 `max`
推理强度，系统审查 ontology、KG、抽取规则和搜索召回。它先确认本地 `main`
工作区干净，再读取固定审查提示词，仅允许修改受控的数据、应用、脚本、测试
和文档路径。只有完整 KG 校验、测试、lint 和两套生产构建全部通过后，修复才
会直接提交到 `main`；coverage advisory 可在验证后关闭，`sync-failure` 则必须
等修复后的 GitHub 同步成功才能关闭。若新增上游数据在提交前就被严格校验拒绝，
每日任务会用 `work/` 内独立的上游候选复现，避免只测试旧 KG 而误判已修复。
受跟踪 submodule 仍由同步工作流推进。具体排查和验证步骤见
[同步故障与每日修复](docs/sync-triage.md)。验证失败时不提交、不推送并保留 issue。
项目级 `.codex/rules/coverage-remediation.rules` 只为该本地任务放行读取最新
`origin/main` 和推送已验证 `HEAD:main` 所需的两个 Git 前缀；issue 的读取、
评论和关闭使用已连接的 GitHub 插件。首次配置或规则变化后需重启一次
ChatGPT/Codex App，且每日执行时电脑需开机、App 需保持运行。

用户已授权每日任务直接修复同类来源维护变更，无需逐次确认。任务会先审查上游
精确差异，再验证真实增量结果；通过全部检查后提交、推送并确认 GitHub 同步恢复。
授权不包括跳过校验或把新闻内容、日期、边界的变化伪装成文件哈希更新。

## 目录

```text
app/                         站点路由与界面
app/page.tsx                 最新新闻、关键词与组合筛选首页
app/news/[newsId]/page.tsx   可分享的独立新闻阅读页
app/graph/page.tsx           实体相关新闻与 KG 可视化
app/ontology/page.tsx        Ontology 类型、约束与覆盖率
data/ontology-source.json    唯一语义定义、层级与稳定 ID 映射
data/extraction-patterns.json  引用稳定 ID 的抽取模式
data/ontology.json           编译后的本体与层级索引（勿手改）
data/extraction-rules.json   编译后的运行时抽取规则（勿手改）
data/news-overrides.json     经审查的页面拆分修正
data/processed/news.json     页面拆分后的独立新闻数据集
data/processed/news-content.json  v4 接受版本的完整正文与更新索引
data/generated/kg.json       独立新闻的语义 KG 投影
data/archive-state.json      已接受上游文件的哈希基线
data/source-revisions.json   已审查且不改变既有新闻的精确文件版本转换
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
- 当前接受 v3 保存短摘要、出处、精确片段位置与哈希；本地正文预览只读取验签后的完整新闻片段。正式 v4 接受后才由版本绑定的片段快照提供正文，不归档完整上游文件；
- 一条 KG 事件投影必须精确对应一条 processed news；跨来源的同一事实应在未来建立事实簇，而不是把多页直接拼成一条新闻；
- 必填覆盖与可选 facet 分开报告：每条新闻必须有实体、具体事件类型、来源与检索入口；主体、地点、主题和命名对象只统计出现率，不为追求数字强造实体。
- 站点只通过 GitHub Pages 发布；本项目不使用 OpenAI Sites 部署。

### 新闻级实体身份审查

可通过 [`data/entity-identities.json`](data/entity-identities.json) 对明确选定的新闻实体分配做可逆合并、拆分和恢复原始身份；默认空表不改变现有实体。原始抽取 ID、每条新闻的支持与历史引用保持可追溯，页面使用经审查的身份视图并重新计算新闻日期关系。修改走同一套受审查语义迁移 PR；普通同步不会根据同名自动合并。详见 [实体身份维护](docs/entity-identities.md)。同一新闻内的同名多对象尚不能拆分，必须先实现实际 mention-span 区分。

### 报道行动与变化

独立于旧领域分类，逐条新闻记录司法、工程及同比/环比数量变化的保守证据分配。计划、预测、条件和否定有各自局部原文限定；未命中默认「尚未确定」，不证明现实发生。界面支持父类及限定筛选，审计账本保留精确支持和可逆撤回，规则变化仍走同一受审查语义迁移。详见 [行动评估与维护](docs/action-assessments.md)。

### 报道形式与数值描述（受审查迁移提案）

新增独立的经审查报道形式和原文数值描述契约。报道形式审查表保持为空；数值仅接受严格整句、明确期间与少量指标字面的同比/环比百分比变化。缺少记录、尚未确定和受支持描述分别展示，既不推断真实事实，也不汇总跨新闻指标。完整支持、撤回、恢复和证据重放随候选验证；正式接受仍需同一套完整迁移与发布审查。详见 [报道形式与数值描述](docs/report-descriptions.md)。
