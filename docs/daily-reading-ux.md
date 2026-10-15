# 每日新闻阅读体验：交付与验收记录

记录日期：2026-10-14。本文记录最终界面实现、生产构建、真实浏览器验收与截图。正式接受版本仍为 v3，正文使用明确标识的本地评审预览。

## 使用意图与已实现体验

产品围绕「打开看看有什么新内容 → 找到关心的报道 → 阅读 → 沿着实体继续探索」组织界面。品牌介绍保持简短，搜索和新闻优先；来源、审查和结构化证据在需要时展开。

| 场景 | 当前实现 | 验收重点 |
| --- | --- | --- |
| 每日打开 | 默认最新新闻，近 7/30 天、新实体与议题入口；统计使用次要字号 | 首屏可见搜索和真实新闻，空时间范围提供明确说明 |
| 有问题要查 | AND 关键词与常用条件共同生效，高级筛选折叠，20 条分页与显式排序 | 查询、筛选、排序和页码可从 URL 恢复，无旧 60/80 条截断 |
| 进入阅读 | 标题、摘要与阅读按钮进入共享阅读器，新闻有独立地址；相关新闻与实体资料可连续打开 | 加载、重试、未知 ID、独立页面、逐层返回与内部滚动恢复 |
| 查看实体 | 资料面板展示相关新闻；图谱点击在当前工作台扩展 | A → B → C 后 A/B 保留，节点去重，坐标和视口不突然重置 |
| 控制探索 | 撤销、收起分支、继续展开、重置与明确的新起点 | 120 节点上限提示；每次最多增加 10 条新闻、6 个关联实体 |
| 手机上阅读 | 新闻先于图谱，图谱默认折叠；阅读器为完整阅读层，触控目标至少 44px，正文及元信息保持可读字号 | 320px 无水平溢出，关闭后回到原位置，图谱提示不推动操作按钮 |
| 键盘使用 | 真正的链接、按钮和可聚焦 SVG 节点；Enter/Space 激活，Escape 关闭阅读层或返回图谱焦点 | 焦点可见；移动阅读层限制背景交互，Tab 只经过当前可见控件 |
| 回访 | 浏览器本机已读记录，按上次访问后的新增 ID 提示 | 首访不声称已经读完，日期较老的新收录仍可提示 |

新闻和实体 ID 没有因界面改造而更换。按时间排序表达报道先后，图谱关系不表达因果；报道中的行动、形式和数值描述不等于现实事实已被独立证实。

近期范围统一按北京时间当前日计算。版本更新索引确实没有新增/恢复实体时，明确提示后展示近 30 天有报道关联的实体与议题；索引缺失则保留「本版本更新信息未记录」提示并提供同样的近期入口。该列表每页 20 项，使用「近期有新报道」标签，不把已有实体重新标为新增；如果近 30 天没有报道，诚实显示空状态并提供全部议题目录。

阅读面板打开相关新闻时，从新文章标题开始；逐层「返回」恢复上一条新闻的内部滚动位置。实体资料中的相关新闻每页 20 条，页码写入 `inspectPage`；阅读其中新闻再返回时，恢复原实体、页码与列表滚动。关闭阅读层保留底层搜索、分页、图谱坐标和视口，并将焦点交还原入口或当前探索位置。

小于 1100px 的阅读层使用模态交互，背景不可操作；Tab 焦点环排除关闭的 `details` 内控件。图谱悬停/聚焦提示保留固定高度，长标签省略并保留完整提示，避免 320px 窄屏上提示换行使分支按钮在点击过程中移动。

图谱节点使用随屏幕缩放计算的 48px 透明触控区域，缩放与窗口改变后仍保持可点范围；密集区域按距离最近的可见节点决定点击对象，键盘仍可指定节点。四尺寸独立触控回归已验证图形外缘点击、重复展开不增加历史条目、A → B → C 后收起共享分支保留独立上下文，以及新闻触点打开阅读。

## 正文与正式接受状态

当前 `data/accepted-release.json` 的 candidate 版本仍为 **3.0.0**，release ID 为 `0572505f7bf433af5b07ea16df1bd178d38098c761f57d56f8e4e3b8ac0eb94e`。本轮没有把本地预览文件加入该接受版本，也没有声称正式发布了 v4。

- 默认 v3 读取不到正式正文快照时，显示「此接受版本尚未收录正文」、已有摘要与原始档案入口。
- 本地 `KG_CONTENT_PREVIEW_PATH` 显式指定独立审查快照；读取器验证固定源提交、有效文件清单、新闻/KG 绑定和每条片段哈希。正文显示「本地评审预览」提示。
- 原始片段保留完整 Markdown；阅读时支持段落、标题、列表、表格、链接与图片，并清理危险 HTML。归档仅有 frontmatter 摘要时明确标注。图片沿用来源 URL，失败时提供原图入口。
- 归档片段仅有 iframe 视频时，明确显示「当前归档片段仅保存视频，没有文字正文」，提供安全的原平台链接；页面不执行归档 iframe。文字与视频并存时保留正文及视频入口。
- 阅读展示清理源站 `Tabs`、`B站`、`YouTube` 等视频导航和空标题，视频链接集中提供。这只改变展示文本；原始正文快照、片段哈希和接受绑定仍保留完整内容。
- 阅读器按需加载新闻与实体资源，首页不下发所有正文。首页卡片只提供来源与完整证据入口，不对裁剪后的展示对象报告「零证据」或「未知评估」。

正式正文上线按 [accepted-releases.md](accepted-releases.md) 的两阶段流程执行：先审查并接受使用 v3 输出的兼容基础设施迁移，让严格读取、审计下载和校验工具认识 v4；该接受基线部署之后，再固定源提交和生成时间，使用 `--content-protocol=v4` 预览、准备并审查完整正文快照迁移。两阶段各自绑定精确前置版本、配置、运行时和差异，经过审计包读回、隔离检查与正常评审合并。本地构建和预览不替代接受或发布。

## 性能与链接契约

首页和图谱使用独立的 UI presentation 传输：重复文本前缀与 ID 引用可逆编码，搜索文本、实体、主题触发词和筛选分配保持等价。该对象带 `presentationOnly` 标记，不可用于语义校验、抽取或版本接受；完整来源证据由阅读器单独读取。

当前数据的 JSON 字节数（不包含 HTTP/RSC 包装、静态脚本或图片）：

| 输入/展示 | 字节数 |
| --- | ---: |
| 原始身份投影 | 20,387,675 |
| 首页 presentation | 5,746,180 |
| 图谱 presentation | 5,782,281 |

默认最新浏览不构建全文搜索索引；首次关键词检索后复用索引，分页和返回不重复扫描生成文档。新闻链接使用独立 `/news/{newsId}/` 地址，全站 Next Link 显式设置 `prefetch={false}`，独立新闻页不会因导航进入视口或悬停而自动请求首页、图谱和分类的重型 RSC 数据。普通点击打开共享阅读器，修饰键点击保留标准新标签页行为。Pages 的 `basePath` 同时覆盖新闻地址、静态资源和版本化阅读 JSON；本轮生产预览使用 `/bedtimenews-kg` 子路径，真实浏览器结果在下方登记。

首页导航和图谱导航创建自己的历史条目时清除阅读器 ownership 标记。阅读器参数不进入搜索表单的重建 key，未提交的搜索草稿不会因为打开或关闭阅读器而丢失。

## 构建、测试与浏览器验收记录

已完成的定向测试覆盖 URL 状态与阅读器历史边界、完整搜索字段及召回/排序等价、行动/报道形式/数值筛选等价、图谱扩展节点/边/位置等价、历史缺项和原始身份名称保留、完整证据组件与阅读入口。presentation 构建前后的原始数据哈希一致。TypeScript 与相应 ESLint 检查通过。

本轮最终触控、访问提示与预取修复在**没有 `sources/` 和 `.git/` 的独立目录**重新验证 vinext Worker 与 Next 静态 Pages（Webpack）生产构建：Pages 依赖实际复制；Worker vendor 依赖通过 junction 指向已安装的 `node_modules`，不读取原项目源码。正文输入为显式指定、经过哈希验证的本地预览，接受凭据仍为 v3；生成 9,665 个独立新闻页。最终构建证据见 `outputs/ux-review/source-free-build.json`、`pages-final-webpack-build.log` 与 `worker-final-build.log`。此前构建记录与本轮两次 Turbopack 失败分别保留，不计入最终通过结果。

本轮 Pages 实际构建使用旧启动器显式传入 `--webpack`，构建已经启动后同步了启动器的 Windows 默认选择修订；运行中的编译仍由旧启动器发起。新启动器仅在 Windows Pages 构建且没有显式 `--webpack`、`--turbopack` 或 `--turbo` 时选择 Webpack；三个显式选择均保留，Linux 默认保持 Turbopack。`pages-cli-dispatch-proof.json` 验证真实 CLI 的四种分派，`post-build-launcher-amendment.json` 记录构建时旧哈希、后续新哈希与参数等价；该证明不声称新启动器已经重新构建生产产物。实际 v4 接受后的必要重建将使用新启动器默认路径。

Windows 测试 fixture 仅调整临时 Git 仓库的 LF 配置、workflow 文本断言的换行规范化，以及目录 junction / Git mode symlink 构造。只有主机无法创建实体文件 symlink 时，能力探测才明确跳过该单项；硬链接与 symbolic ZIP 拒绝测试继续执行，最终测试的实际跳过数在下表登记。这些调整不改变正式数据、生产 workflow 或绑定校验。

| 验证 | 最终结果 | 证据 |
| --- | --- | --- |
| 全套 Node 单元测试 | 737 项全部通过，零失败、零跳过；Linux 原生临时文件系统，Node 22.23.2 | `outputs/ux-review/linux-unit-final.xml`、`outputs/ux-review/linux-unit-final.log`、`outputs/ux-review/linux-runtime.json` |
| 四尺寸 Playwright 浏览器测试 | 112 项：108 通过、零失败、4 项按布局跳过 | `outputs/ux-review/browser-final.json`、`browser-final.log`、`pages-playwright-report/` |
| 本地 Worker 生产预览复核 | `http://127.0.0.1:3103`；26 项：24 通过、零失败、2 项按布局跳过 | `outputs/ux-review/worker-browser-final.json`、`worker-browser-final.log`、`worker-playwright-report/` |
| 无源 checkout 的生产构建 | vinext Cloudflare 与 Next Webpack 静态 Pages 通过 | `outputs/ux-review/source-free-build.json` |
| 最终输入、报告与截图绑定 | 两套隔离目录来源/`.git` 缺席、构建输入哈希、报告哈希、12 张 PNG 尺寸与哈希均验证通过 | `outputs/ux-review/final-qa.json` |

浏览器连接**构建后的静态 Pages 服务** `http://127.0.0.1:3100/bedtimenews-kg/`。以下 12 张截图来自固定四尺寸：首页与阅读为首屏，图谱记录完整探索面板。已实际检查布局和交互，并修正了 320px 首条标题被首屏裁切、图谱提示换行使按钮移动、折叠证据干扰焦点环，以及源站导航占据阅读首屏的问题。

| 视口/项目 | 首页截图 | 阅读截图 | 图谱截图 | 验收结论 |
| --- | --- | --- | --- | --- |
| 1440 × 900 / desktop | `outputs/ux-review/home-desktop.png` | `outputs/ux-review/reading-desktop.png` | `outputs/ux-review/graph-desktop.png` | 搜索与首条标题可见；侧边阅读、背景探索及关闭恢复通过 |
| 768 × 1024 / tablet | `outputs/ux-review/home-tablet.png` | `outputs/ux-review/reading-tablet.png` | `outputs/ux-review/graph-tablet.png` | 完整阅读层、键盘焦点限制与显式图谱入口通过 |
| 390 × 844 / phone | `outputs/ux-review/home-phone.png` | `outputs/ux-review/reading-phone.png` | `outputs/ux-review/graph-phone.png` | 首屏阅读入口、背景锁定、阅读返回与无水平溢出通过 |
| 320 × 760 / small-phone | `outputs/ux-review/home-small-phone.png` | `outputs/ux-review/reading-small-phone.png` | `outputs/ux-review/graph-small-phone.png` | 首条标题完整可见；快捷标签横向浏览、图谱扩展与分支收起通过 |

已执行的交互与内容检查：

1. 四尺寸首屏、字体、触控目标、阅读与图谱无裁切；控制台/网络异常及截图路径。
2. 搜索后分页与返回、未提交草稿、浏览器 Back/Forward、关闭后的 URL/焦点/滚动位置；相关新闻嵌套返回与实体 `inspectPage`、内部滚动恢复。
3. 所有新闻 Link 禁止自动预取，独立新闻页和 Pages 子路径直接打开；加载失败可重试，非法 ID 不请求无关资源。
4. A → B → C 扩展与撤销、收起共享分支、120 节点限制、键盘与缩放；手机默认阅读优先，320px 图谱提示不会移动按钮，移动焦点环排除折叠内容。
5. Markdown 表格、来源图片失败入口、隐藏备注/脚本/危险链接处理；视频档案显示无文字正文及原平台链接；分别记录 v3 缺正文和 verified local preview。
6. 首访、回访、新增/恢复、内容哈希变化、禁用存储与清除已读记录；首次访问不显示虚构新增数量。

本次静态生产服务：在构建输出所在目录运行本地验收辅助脚本 `work/ux-review/serve-pages.mjs`，设置 `PAGES_BASE_PATH=/bedtimenews-kg`；地址为 `http://127.0.0.1:3100/bedtimenews-kg/`。浏览器设置 `PLAYWRIGHT_BASE_URL=http://127.0.0.1:3100`、`PLAYWRIGHT_BASE_PATH=/bedtimenews-kg`。3 个小屏项目跳过「在侧边阅读开启时修改背景图谱」：完整阅读层按设计禁止背景交互；桌面跳过只针对手机/平板的显式图谱入口测试。Worker 验证 desktop 与 small-phone，分别跳过上述仅针对小屏的入口案例和模态阅读时编辑背景案例。所有跳过及理由逐项写入 `final-qa.json`。

最初 Windows 全套执行暴露了真实目录 fsync 能力限制及换行、文件 symlink 和旧占位版本夹具问题。修正夹具后在 Linux 原生文件系统完成全部 737 项检查；生产目录同步和未知协议拒绝保护未放宽。新增检查覆盖精确 v3/v4 协议下的 v4 prepare、续接与前向回滚 promotion，版本名单严格拒绝其他值。最终 KG 验证通过：1,764 实体、9,665 新闻、8,141 关系、2,081 来源页，所有片段与固定源提交匹配。整仓 ESLint、TypeScript、本体编译检查通过。

Worker 检查发现 `vinext start` 的 Windows 静态缓存使用反斜杠 URL 键，导致资源 404。本项目启动器对 Cloudflare 产物改为使用生成的 Wrangler 配置和真实 assets binding，未修改依赖库。最终真实 Worker 浏览器回归通过，并实测 `-p`、`-H` 短参数；早期 Node 启动诊断与失败日志留作问题证据，不作为最终通过结果。

最终预取修复前的完整 Pages 回归为 108 项（104 通过、4 项按布局跳过），Worker 为 24 项（21 通过、2 项按布局跳过、1 项手机正文加载超时）。超时单项在原 15 秒断言阈值下独立复查通过；trace 同时确认正文请求与三个自动 RSC 预取竞争。修复关闭了 24 处缺失的预取属性，并加入真正生产服务上的独立新闻与图谱阅读网络检查：新闻元信息实际加载、导航悬停、网络空闲之后，没有重型导航 RSC 请求，测试没有拦截、取消请求或放宽超时。修复前的构建、报告、trace、单项复查与 12 张截图在 `outputs/ux-review/before-prefetch/` 独立保留哈希，不合并成最终通过结果。

隔离 Pages 的两次 Turbopack 构建均在 PostCSS 子进程通信处出现 deadline 超时。第一次之后补回隔离目录缺失的项目 `.gitignore`，没有创建 `.git` 或修改生产 CSS；[Tailwind 自动检测规则](https://tailwindcss.com/docs/detecting-classes-in-source-files) 会排除 `.gitignore` 中列出的文件。安装版本的扫描实测 130 个文件、42,300 个候选、生成目录文件 0 个、323ms，但第二次构建仍出现相同通信超时，因此不能声称排除规则已解决该失败。独立运行相同 PostCSS/CSS 输入在 3,636ms 内完成；随后使用 Next 官方支持的生产 `--webpack` 构建通过，未放宽超时或修改依赖库。两次失败分别保留在 `outputs/ux-review/pages-turbopack-postcss-timeout.log` 与 `pages-turbopack-postcss-timeout-after-ignore.log`；扫描与独立处理证据为 `pages-css-scan-diagnostic.json`、`pages-postcss-direct-diagnostic.json`。

Worker 生产预览使用 `npm run build` 后的 `npm start`。启动器发现 `dist/server/wrangler.json` 时，使用 Wrangler `--local` 及生成的静态资源绑定，默认监听 `127.0.0.1:3000`；支持 `PORT`、`-p` / `--port` 和 `-H` / `--hostname`，例如 `npm start -- --port 3001 --hostname 127.0.0.1`。Node 产物保持 `vinext start`。这两种启动方式均运行本地产物，不执行正式部署。

正式部署/接受状态：**当前正式接受版本仍为 v3**；发布已获人类授权，实际两阶段接受与部署结果由发布执行证据另行登记。本地正文预览不能作为已正式收录或发布的证明。
