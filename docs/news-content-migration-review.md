# 新闻正文快照迁移评审

本记录对应 2026-10-14 的本地实现和真实语料验证。正文已完成验签、生命周期重放和容量测量；当前正式接受清单仍为 candidate v3。人类已明确授权后续发布，真实仓库 activation/storage 开关与合并 gates 已核实；两阶段的实际接受、审计资产读回和发布结果仍须按执行证据登记。本文的本地预览与 QA 不代替正式接受，也不生成审批记录。

## 已验证的接受基线

| 项目 | 精确值 |
| --- | --- |
| 仓库 | `BillShiyaoZhang/bedtimenews-kg` |
| 验证时 HEAD、origin/main、实际远端 main | `a6cf0492ab41dc86800920ab9a8ac859b310bec9` |
| 接受 releaseId | `0572505f7bf433af5b07ea16df1bd178d38098c761f57d56f8e4e3b8ac0eb94e` |
| 接受 bundleId | `31e3614660f097c9119ce71c1a1bcb1ae4ff391288f312261857c44600d669b2` |
| 接受 codeCommit | `c1acaf54fbe5bc963fccd281a66d4bd08bba74dc` |
| 上游 sourceCommit | `57709977ff0a3551194e4baae5ab8f0daa7e1870` |
| 保留的配方 generatedAt | `2026-10-12T14:36:53Z` |
| observed/effective inventory SHA-256 | `8fd0028fe9c8de5d5ea535b5d9ed068057c469e32e74c9121f1730220996c11b` |
| source-review SHA-256 | `38e0b9de817f645c4bec37c0d4a3e58baecccb040f5718dc069a72c7385a0bed` |

运行时保持接受配方：Node `22.23.2`、V8 `12.4.254.21-node.56`、ICU `78.2`、Unicode `17.0`、locale `en-US`、timezone `UTC`。完整 runtime SHA-256 为 `f39aeb8c3bb91c869ade559f4185ed8175de134f33b5e79119c49e3ad357dee3`。

通过现有 opaque Git checkpoint 验证权限读取接受基线，再从公开审计存储读回全部 7 个资产。文件名、字节数、SHA-256、候选 manifest 身份与接受 receipt 均验证通过；读回只使用 GET/HEAD，`rawSourceArchiveIncluded` 仍为 `false`。正式 receipt 和 6 个接受输出与 HEAD Git blob 精确相同，未修改接受语义。Windows 行尾统一为相同 LF 字节后，35 个语义绑定文件全部匹配最终 preview；Git clean filter 不再改变这些字节。

上游本地工作树有 4 个文件与接受 Git 对象不同，未覆盖这些修改。重放使用 `work/ux-review/accepted-source` 内固定在接受 sourceCommit 的隔离本地 Git checkout，并校验全部源文件 inventory；没有把上游当前修改混入正文。

冻结 origin 保留原始 3 个路径，不把新的正文路径塞入历史 origin：

| origin 项目 | 路径 | SHA-256 |
| --- | --- | --- |
| commit | — | `60ab4e57ea8fa3e0d231f4f6cf1452302dd2dd02` |
| acceptedKG | `data/generated/kg.json` | `a1fde88200bd7c2c4fac9693c28910df53e4210b2f9fd4fb623e02eb0800631a` |
| acceptedNews | `data/processed/news.json` | `ac6d02c727d25ec48d17e045e69b2a46370d8909a5c3e231141e1f59ab8032bd` |
| acceptedState | `data/archive-state.json` | `a3b2b9d771f9f378422c929c395c9f7abe04b385c3af219b7817fe28f32d705b` |

## 两阶段迁移

第一阶段安装兼容读取器和默认 v3 writer，并生成匹配新代码配置的 v3 接受候选。验证、下载、ZIP、生产计划和恢复路径同时支持精确 v3/v4 文件集合；当前 v3 配方不自动切换版本。此阶段需要完整代码与匹配接受数据的评审提交，不能只合并会让正式 receipt 配置校验失败的代码。

最终 LF 兼容 preview 在真实语料上完成全量生成和独立重放，用时 264,881 ms。KG diff：新增、改变、删除均 0，21,651 条记录不变；新闻与页面 diff：新增、改变、删除均 0，11,746 条记录不变。时间是本地测量，不能作为生产运行时保证。

| 第一阶段绑定 | SHA-256 |
| --- | --- |
| fromHash | `bd343daf29016cb2d41aaa9fff31be9ef896a133d3424c77da17575026663af3` |
| toHash | `867d6eeef676754824196d497b8d5120300a944700101ca03ed102cc7e66b476` |
| diffHash | `4e60201a39644f8c957a33a33bb0f651fedb28fc5506b49bbac584e301c2456c` |

第二阶段在第一阶段已经正式接受的 main 上，显式选择 `--content-protocol=v4` 和 schema 2 的生产计划。它增加接受绑定的 `data/processed/news-content.json` 和审计 `news-content.json.gz`，不改变新闻边界、KG 或冻结 origin。每阶段均要求精确 predecessor/configuration/runtime/diff 审查、草稿上传与读回、隔离验证及正常评审合并。提交后的 proposalCommit/codeCommit 必须是真实提交，不能用本地预览代替。

目前的 v4 preview 是从当前旧 v3 基线运行的可行性检查，用时 299,267 ms；KG/news diff 同样全部为 0。它的 toHash 为 `d5875876b2cbc4f14bb0bdbc7d2feb7dbfae219af0f60821f4bac8bce21496e5`，current-base diffHash 为 `a9ab994cb80323bff1fff5fee4716eb8483e318b11ed5fedab70f3ebb4e42f21`。**该 current-base 绑定不能复用于真正的第二阶段。** 第一阶段正式接受后，必须以新 release/bundle/codeCommit 重新生成完整 reviewBinding；预期轴由兼容 toHash 转向 v4 toHash，但新 predecessor 和差异须实际重算。

`.gitattributes` 只固定所列生成数据和脚本的 LF 行尾，不在配置文件或 35 个语义生成器绑定内。其加入未改变已测文件字节，因此不改变上述 semantic/diff 绑定；它仍由最终代码提交绑定。后续修改任何语义绑定文件、源文件、运行时、接受基线或差异输入，都必须重新生成受影响的 preview。

## 正文快照和更新索引

canonical JSON 为 35,617,408 bytes，包含 9,665 条完整原文新闻片段；整份 SHA-256 为 `0d15787e8279e11b6c34bf9fb59490287638038202b43e43f468c7add5078a07`。它绑定 sourceCommit、KG/news 精确字节哈希、有效 inventory 哈希、每条 `newsId`/`contentHash`/`markdown`，并验证新闻与正文一一对应。生成只读取已验证的 Git 原片段，不用摘要补造正文。

生命周期派生的初次更新索引将已有记录作为 baseline：`knownNewsIds` 9,665，`knownEntityIds` 1,764；added/restored/changed 各列表均为空。每日新增依据接受生命周期与稳定 ID 投影，不能用新闻日期推断收录时间。精确正文 hash 和完整更新索引均与最终独立 v4 replay 一致。

普通无变化操作复用整个已接受快照。撤回移除活跃正文、保留历史身份；恢复重新加入原片段。前向回滚保证正文 rows/fragment 与目标精确相同，同时依据当前生命周期重算本次发布 updates，保留较晚出现的 known IDs。目标原文相同不代表整个 snapshot JSON 字节相同；新的完整快照字节必须重新绑定。

v4 站点读取接受 receipt 绑定的 tracked JSON，无需上游源码或运行时仓库文件系统；构建把正文生成静态阅读资源，客户端按新闻加载。上游不可用时仍可重建已接受阅读页面；新提取和首次生成仍需要认证的上游 Git 对象。旧 v3 正式构建返回正文「未收录」，即使本地另有未接受文件也不将其视为正式正文。新 v4 缺正文或绑定不符会拒绝构建。显式本地 preview 会独立验证并显示预览提示，不能发布为接受版本。

## 容量预算

本地 preview API 没有保留完整 successor candidate bundle。以下压缩使用已精确验证的 snapshot bytes、Node 22.23.2 和现有生产编码 `gzip(level: 6)`，仅作容量测量；没有生成或接受新的审计资产。

| 测量/估算项 | bytes | 约 MiB |
| --- | ---: | ---: |
| 原始正文快照，实测 | 35,617,408 | 33.97 |
| 正文 gzip 追加容量，实测 | 16,138,953 | 15.39 |
| 已验签 v3 的 7 个审计资产，实测 | 88,675,672 | 84.57 |
| 已验签 v3 的 6 个 artifacts，不含 manifest，实测 | 88,656,162 | 84.55 |
| v3 全资产加正文 gzip，估算 | 104,814,625 | 99.96 |
| artifacts 加正文并以实际 v4 preview diff 替换旧 diff，估算 | 105,036,393 | 100.17 |

容量测量 gzip SHA-256 为 `ca77dada108744beb43a41baaf19fc7d7db292fea344f2e28cff2dec5e91a5e3`；它是非 acceptedasset 的测量结果。实际 v4 preview diff 为 252,704 bytes，旧 diff 为 11,426 bytes。总量估算沿用旧 provenance/lifecycle 等资产大小；新候选、review/transition 和 manifest 的完整精确尺寸仍须在 prepare 和草稿读回时测量，不能把该估算当作 successor 的资产绑定。

硬上限未放宽：正文解压 64 MiB、单个 compressed provenance/lifecycle 各 64 MiB、全部 candidate artifacts 128 MiB、审计 manifest 1 MiB、审计全资产 129 MiB。上述 artifact 估算距离 128 MiB 上限约 27.83 MiB。超限继续拒绝，不能丢弃正文或证据以通过检查。

## 待完成的正式操作

### 已完成的本地兼容候选与最终 QA

此前界面与 Windows Worker 启动修复已提交到隔离 checkout 的 `codex/ux-reading-compat`，本地 proposal commit 为 `928ad65682bddd5a6ee2ced5ae5bd792cfec81aa`。以下候选身份记录对应这一版；新增触控、访问提示及最终 QA 文档冻结后，最终提案必须重新绑定真实提交，不能沿用旧 proposal 身份作为最新发布证据。用户主 checkout 的 HEAD、接受凭据、六个正式输出和 source gitlink 在该本地记录阶段均未移动。

完整 candidate v3 已落盘并完成独立全量来源重放验证：bundle ID `84eafcb78d9036727ceed059c2f527c78e279c127d99613833339d65edb22c31`，manifest SHA-256 `6214fef969130881f30b9a8f8b1eef97b6bbebb2b1d6ad18b374b5dadd4b0f54`。六个 artifacts 共 86,213,947 bytes，manifest 19,264 bytes，七个完整审计资产共 **86,233,211 bytes**。KG/news 的精确字节仍等于当前接受版本，35 个语义生成器绑定及前述 diffHash 保持一致。重新派生的报告绑定新 bundle ID。

候选位置为 `work/ux-review/compat-proposal/work/accepted/ux-reading-compat-v3-final/`；完整校验结果为 `work/ux-review/compat-final-candidate-verification.json`。技术审查为真实 Codex 审查，不声称人工逐哈希批准；该版 review 的 SHA-256 为 `1d59565075c016c4f798560e2c04aa1aacabb3a2e58d29fcb5db5a7dfc0e50b7`。最新代码通过完整 **737 项 Linux 单元测试，零失败、零跳过**，包括 v4 prepare、续接和前向回滚 promotion 的严格协议白名单回归。最新界面的两套生产构建及 Pages/真实 Worker 浏览器验收证据见 [交互验收记录](daily-reading-ux.md) 与 `outputs/ux-review/final-qa.json`；最终 proposal/candidate 身份待这些输入冻结后重绑定。

最终发布前 UI 验收使用独立、物理缺少 `sources/` 和 `.git/` 的目录：Pages 依赖实际复制，Worker vendor 依赖 junction 仅指向已安装依赖。Next 静态 Pages 的四尺寸回归共 **112 项，108 通过、零失败、4 项按布局跳过**；真实本地 Wrangler Worker 共 **26 项，24 通过、零失败、2 项按布局跳过**。已验证正文、嵌套阅读返回、图谱扩展与 48px 触点，以及独立新闻/图谱阅读不自动请求重型导航 RSC。12 张首页、阅读与图谱截图的尺寸及 SHA-256 与报告、冻结 UI 输入一起记录在 `final-qa.json`；JSON 原始报告为 `browser-final.json` 与 `worker-browser-final.json`。

最新成功生产构建为 vinext Cloudflare 与 **Next Webpack**，后者在旧启动器中显式传入 `--webpack`。两次真实 Turbopack/PostCSS 子进程通信超时的诊断仍保留；后续 Windows Pages 默认 Webpack 修订只经过四种真实 CLI 分派及参数等价验证，记录为 `pages-cli-dispatch-proof.json` 与 `post-build-launcher-amendment.json`，不虚称旧产物由新启动器构建。正式 v4 接受后将用实际接受 Git 导出的正文、receipt 与绑定文件重建这两套无来源目录，移除 preview 环境，验证 `article.preview === false`、无本地预览提示、阅读资源前缀来自实际 receipt；相应实际提交和正式 QA 证据届时另行登记。当前 `final-qa.json` 仍准确标为 `accepted: false`、正式 candidate `3.0.0`。

此前容量表使用原接受审计资产作估算。以此次真实兼容候选为基数，附加已测正文 gzip 和 preliminary v4 的 diff 增量后，第二阶段 artifacts 约为 **102,599,208 bytes（97.85 MiB）**，仍是估算；真正第二阶段必须在兼容 main 实际接受后重新生成和测量。不得把当前 preliminary v4 或本地 v3 候选标为正式接受。

后续发布已获人类明确授权。真实 GitHub 仓库 activation/storage 开关、管理员 push 权限、普通 merge 支持与 main 的合并 gates 已核实；该核实不记录或输出凭据值。Linux 发布 operator 的 clean `npm ci` 已完成，最终提案在 UI、依赖锁与 QA 冻结后重新绑定。

正式操作仍需推送精确 proposal、草稿存储及读回，验证一致的代码和数据提交，再经过普通评审合并接受并保留 ancestry；第一阶段实际接受后重新生成第二阶段完整绑定。任何 receipt、接受 checkpoint 或授权开关均不能伪造。当前正式 v3 接受状态与本地 verified preview 保持区分，真正发布结果以执行证据登记。操作契约见 [接受发布指南](accepted-releases.md)。

ignored 本地证据位于 `work/ux-review/`：

- `migration-feasibility.json`：真实基线、两次重放和最后远端 main 检查；
- `compat-migration-preview.json`：完整第一阶段 reviewBinding；
- `content-migration-preview-current-base.json`：明确 preliminary 的 v4 reviewBinding；
- `news-content.lifecycle-verified.json` 与 `news-content-lifecycle-verification.json`：与独立 lifecycle replay 精确匹配的完整正文及验证记录；
- `news-content-capacity-estimate.json`：gzip 容量和总量估算；
- `accepted-audit/`：按现有 receipt 验签的 7 份公开资产。
- `compat-final-candidate-verification.json`、`compat-final-technical-review.json`：完整最终本地候选与真实技术审查；
- `compat-final-rendered-outputs/`：该候选独立验证后派生的正式格式输出，仍为本地未接受文件。

这些文件用于本地评审，未列入正式接受清单，也未代替两阶段迁移的发布结果。
