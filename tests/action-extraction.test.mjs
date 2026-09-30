import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  ACTION_NORMALIZATION_VERSION,
  assertActionExtractionConfig,
  createActionExtractionEngine,
  normalizeActionFragment,
  validateActionEvidence,
} from "../scripts/lib/action-extraction.mjs";
import { parseSourcePage, readNewsFragment } from "../scripts/lib/news.mjs";
import { validateActionAssessment } from "../app/lib/action-assessment.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const patterns = JSON.parse(await readFile(resolve(root, "data/extraction-patterns.json"), "utf8"));
const config = patterns.actionExtraction;
const engine = createActionExtractionEngine(config);
const dataset = JSON.parse(await readFile(resolve(root, "data/processed/news.json"), "utf8"));
const digest = (text) => createHash("sha256").update(text).digest("hex");
const evidence = (result) => result.assignments.flatMap((assignment) => assignment.evidence);
const signatures = (result) => result.assignments.map(({ conceptId, polarity, modality }) => `${conceptId}/${polarity}/${modality}`);
const annotated = (raw) => engine.assess(raw, { fragmentHash: digest(raw) });
async function corpus(newsId) {
  const news = dataset.news.find((item) => item.id === newsId);
  assert.ok(news, `Corpus news ${newsId} is present`);
  const page = dataset.pages.find((item) => item.id === news.pageId);
  const raw = await readFile(resolve(root, "sources/bedtimenews-archive-contents", page.repositoryPath), "utf8");
  return { news, fragment: readNewsFragment(raw, news.fragment) };
}
function assertSpans(raw, result) {
  const visible = normalizeActionFragment(raw);
  assert.equal(visible.length, raw.length);
  for (const item of evidence(result)) {
    for (const own of [item.predicate, item.scope, ...item.qualifiers]) {
      assert.equal(own.text, visible.slice(own.start, own.end));
      assert.ok(Number.isInteger(own.start) && own.start >= 0 && own.end <= raw.length && own.end > own.start);
      assert.ok(own.start >= item.scope.start && own.end <= item.scope.end);
    }
  }
}

// Fixture sources are read at their own immutable news hash and line range.
// No full raw archive page is duplicated into tests or generated fixtures.
test("action extraction annotates three supported classes in real own-fragment corpus", async () => {
  for (const [newsId, conceptId] of [["news-302705ece56f", "action-legal"], ["news-94014898821c", "action-engineering"], ["news-77dc3680c2d0", "change-quantitative"]]) {
    const { news, fragment } = await corpus(newsId);
    const result = engine.assess(fragment, { newsId, fragmentHash: news.fragment.contentHash });
    assert.equal(result.status, "applicable");
    assert.ok(result.assignments.some((assignment) => assignment.conceptId === conceptId));
    assertSpans(fragment, result);
    assert.deepEqual(engine.validate(result, fragment, { newsId, fragmentHash: news.fragment.contentHash }), []);
  }
});

test("mixed real forecast/history/construction fragment preserves occurrence-level modalities", async () => {
  const { fragment } = await corpus("news-efe8484ff667");
  const result = annotated(fragment);
  assert.ok(signatures(result).includes("change-quantitative/affirmative/predicted"));
  assert.ok(signatures(result).includes("change-quantitative/affirmative/reported"));
  assert.ok(signatures(result).some((value) => /^action-engineering\/affirmative\/(planned|predicted)$/u.test(value)));
  const forecast = result.assignments.find((assignment) => assignment.conceptId === "change-quantitative" && assignment.modality === "predicted");
  assert.deepEqual(forecast.evidence.map((item) => item.predicate.text), ["同比增长6.5%"]);
  assert.ok(forecast.evidence[0].qualifiers.some((qualifier) => qualifier.text === "预计"));
  assert.ok(result.assignments.find((assignment) => assignment.conceptId === "change-quantitative" && assignment.modality === "reported").evidence.every((item) => item.predicate.text.includes("下降")));
  assertSpans(fragment, result);
});

test("real CPI static observation is omitted without erasing neighboring directional changes", async () => {
  const { fragment } = await corpus("news-b26b186147b3");
  const result = annotated(fragment);
  assert.equal(result.status, "applicable");
  assert.ok(evidence(result).some((item) => item.predicate.text === "环比下降0.2%"));
  assert.ok(evidence(result).every((item) => !item.predicate.text.includes("持平")));
  assertSpans(fragment, result);
});

test("metaphor, prevention and unsupported denied acquisition do not become actions", async () => {
  const fixtures = [["business/40.md", 152, 152], ["daily/2023/01/18.md", 86, 99], ["daily/2023/05/26.md", 119, 130]];
  for (const [path, from, to] of fixtures) {
    const raw = await readFile(resolve(root, "sources/bedtimenews-archive-contents", path), "utf8");
    const fragment = raw.split(/\r?\n/u).slice(from - 1, to).join("\n");
    assert.equal(annotated(fragment).status, "undetermined", path);
  }
});

test("same trigger keeps independent planned, predicted, negated, conditional and reported scopes", () => {
  const raw = "甲铁路计划通车，乙铁路已正式通车，丙铁路尚未通车，丁铁路预计通车，若戊铁路通车则调整班次。";
  const result = annotated(raw);
  for (const suffix of ["affirmative/planned", "affirmative/reported", "negated/reported", "affirmative/predicted", "affirmative/conditional"]) assert.ok(signatures(result).includes(`action-engineering/${suffix}`), suffix);
  assert.equal(evidence(result).length, 5);
  assertSpans(raw, result);
});

test("negation and modality are orthogonal including negated plans and conditional forms", () => {
  for (const raw of ["甲项目未计划投产。", "甲项目没有投产计划。"] ) {
    const result = annotated(raw);
    assert.ok(signatures(result).includes("action-engineering/negated/planned"), raw);
    assertSpans(raw, result);
  }
  const conditional = annotated("如果甲铁路未通车则继续施工。");
  assert.ok(signatures(conditional).includes("action-engineering/negated/conditional"));
});

test("multiple own occurrences with identical class and qualifiers retain separate evidence", () => {
  const raw = "甲铁路正式通车。乙铁路正式通车。";
  const result = annotated(raw);
  assert.equal(result.assignments.length, 1);
  assert.equal(result.assignments[0].evidence.length, 2);
  assert.notEqual(result.assignments[0].evidence[0].predicate.start, result.assignments[0].evidence[1].predicate.start);
  assertSpans(raw, result);
});

test("a forecast qualifier cannot silently leak across another occurrence", () => {
  const raw = "天然气产量预计同比增长6%，环比下降2%。";
  const result = annotated(raw);
  assert.equal(evidence(result).length, 1);
  assert.equal(evidence(result)[0].predicate.text, "同比增长6%");
  assert.ok(signatures(result).includes("change-quantitative/affirmative/predicted"));
});

test("literal future and constant-price terms do not create negation", () => {
  for (const raw of ["甲项目未来计划正式投产。", "按不变价格计算，国内生产总值同比增长6.5%。"]) {
    const result = annotated(raw);
    assert.equal(result.status, "applicable");
    assert.ok(result.assignments.every((assignment) => assignment.polarity === "affirmative"));
  }
});

test("questions, unclear attribution and legal noun discussions abstain", () => {
  for (const raw of ["法院是否判处张某有期徒刑？", "传闻法院判处张某三年。", "甲项目是否投产。", "法院判决制度仍在讨论。", "如果说给工匠精神宣判死刑就是法院，那么这是比喻。"]) {
    assert.equal(annotated(raw).status, "undetermined", raw);
  }
});

test("numeric changes require metric, comparative frame, direction and nonzero measured amount", () => {
  for (const raw of ["全国居民消费价格同比持平。", "天然气产量同比增长0%。", "天然气产量同比下降0.00%。", "天然气产量2211亿立方米。", "天然气产量增长13%。", "今年同比下降13%。", "天然气产量同比增长-2%。", "天然气产量同比下降3月。", "报道表示宣布一项重大变化。"]) assert.equal(annotated(raw).status, "undetermined", raw);
  assert.equal(annotated("天然气产量同比下降0.2%。").status, "applicable");
});

test("comments, headings, URLs, image syntax, code and link titles cannot supply evidence", () => {
  for (const raw of [
    "## 法院判处张某三年\n\n正文只有背景材料。",
    "法院判处张某三年\n================\n\n正文只有背景材料。",
    "<!-- 法院判处张某三年 -->正文没有此事。",
    "<!-- 未闭合注释：法院判处张某三年",
    "![法院判处张某三年](https://example.invalid/image.png)",
    "![法院判处张某三年][photo]\n[photo]: https://example.invalid/image.png",
    "![未闭合图片法院判处张某三年",
    '[来源](https://example.invalid/news(a) "法院判处张某三年")',
    'https://example.invalid/法院判处张某三年',
    '<img src="anything" alt="法院判处张某三年">',
    '```md\n法院判处张某三年。\n```',
    '正文提及 `法院判处张某三年` 的示例。',
    '---\ntitle: 法院判处张某三年\n---\n普通正文。',
  ]) assert.equal(annotated(raw).status, "undetermined", raw);
  const visibleLink = "[北京市法院判处张某三年](https://example.invalid/报道)";
  assert.equal(annotated(visibleLink).status, "applicable");
});

test("masked context cannot support a visible predicate and UTF-16 offsets remain exact", () => {
  for (const raw of ["<!-- 法院 -->判处张某三年。", "![法院](x.png)判处张某三年。", "## 法院\n判处张某三年。", "法院。判处张某三年。"]) assert.equal(annotated(raw).status, "undetermined");
  const raw = "😀<!-- 法院判处 -->\n**北京市法院判处张某三年。**";
  const result = annotated(raw);
  assert.equal(result.status, "applicable");
  assert.equal(evidence(result)[0].predicate.start, raw.indexOf("判处", raw.indexOf("北京市")));
  assertSpans(raw, result);
});

test("a news fragment never borrows adjacent news, page title or topic evidence", () => {
  const raw = "---\ntitle: 法院判处张某三年\npublished: true\n---\n\n## 1. 甲铁路背景\n\n这条新闻只介绍背景资料，正文没有任何项目建设或司法活动。我们在这里补充材料的来历和阅读方法，向读者说明这次记录包含的内容，之后也可以查阅原文逐段核对。\n\n## 2. 开工新闻\n\n乙铁路正式开工，接下来将持续报道现场情况。原文同时介绍了这一事项的背景和整理过程，包含具体的说明和若干补充材料，方便读者理解本次报道所记录的信息。\n";
  const parsed = parseSourcePage("daily/2026/09/30.md", raw);
  assert.ok(parsed.news.length >= 2);
  const first = parsed.news[0];
  assert.equal(engine.assess(readNewsFragment(raw, first.fragment), { newsId: first.id, fragmentHash: first.fragment.contentHash }).status, "undetermined");
  assert.equal(engine.assess(readNewsFragment(raw, parsed.news[1].fragment)).status, "applicable");
});

test("reviewed not_applicable requires exact own news, hash and visible support span", () => {
  const raw = "全国居民消费价格同比持平。";
  const newsId = "news-000000000001";
  const review = { id: "review-static-cpi-v1", newsId, fragmentHash: digest(raw), status: "not_applicable", reviewedAt: "2026-09-30T00:00:00Z", reason: "Reviewed static observation has no supported action or directional change.", evidence: { start: 0, end: raw.length - 1, text: raw.slice(0, -1) } };
  const reviewedConfig = { ...structuredClone(config), reviewedAssessments: [review] };
  const reviewed = createActionExtractionEngine(reviewedConfig);
  assert.equal(reviewed.assess(raw, { newsId, fragmentHash: digest(raw) }).status, "not_applicable");
  assert.equal(reviewed.assess(raw, { newsId: "news-000000000002" }).status, "undetermined");
  assert.throws(() => reviewed.assess(`${raw}补充。`, { newsId }), /stale/u);
  assert.throws(() => reviewed.assess(raw, { newsId, fragmentHash: "0".repeat(64) }), /fragmentHash/u);
  const forged = structuredClone(reviewedConfig);
  forged.reviewedAssessments[0].evidence.text = "x".repeat(raw.length - 1);
  assert.throws(() => createActionExtractionEngine(forged).assess(raw, { newsId }), /exact/u);
  const hiddenRaw = "<!-- 全国居民消费价格同比持平。 -->";
  forged.reviewedAssessments[0].fragmentHash = digest(hiddenRaw);
  forged.reviewedAssessments[0].evidence = { start: 5, end: 5 + raw.length, text: raw };
  assert.throws(() => createActionExtractionEngine(forged).assess(hiddenRaw, { newsId }), /exact/u);
});

test("reviewed negatives cannot erase supported matches", () => {
  const raw = "甲铁路正式通车。";
  const reviewedConfig = { ...structuredClone(config), reviewedAssessments: [{ id: "review-conflict-v1", newsId: "news-000000000003", fragmentHash: digest(raw), status: "not_applicable", reviewedAt: "2026-09-30T00:00:00Z", reason: "A conflicting review must fail closed.", evidence: { start: 0, end: raw.length, text: raw } }] };
  assert.throws(() => createActionExtractionEngine(reviewedConfig).assess(raw, { newsId: "news-000000000003" }), /conflicts/u);
});

test("replay rejects malformed, forged, borrowed or silently dropped evidence", () => {
  const raw = "甲铁路计划通车。";
  const result = annotated(raw);
  assert.deepEqual(validateActionEvidence(result, raw, config), []);
  for (const mutate of [
    (copy) => { copy.assignments[0].evidence[0].predicate.start = -1; },
    (copy) => { copy.assignments[0].evidence[0].predicate.text = "投产"; },
    (copy) => { copy.assignments[0].evidence[0].scope.end = raw.length + 1; },
    (copy) => { copy.assignments[0].evidence[0].qualifiers[0].text = "已经"; },
    (copy) => { copy.assignments[0].modality = "reported"; },
    (copy) => { copy.assignments = []; },
    (copy) => { copy.occurrenceId = "fabricated"; },
  ]) {
    const forged = structuredClone(result);
    mutate(forged);
    assert.ok(validateActionEvidence(forged, raw, config).length > 0);
  }
  assert.ok(validateActionEvidence(result, "乙铁路计划通车。", config).length > 0);
});

test("config fails closed on unsupported regex shape, unknown values and duplicate IDs", () => {
  assert.equal(engine.version, config.version);
  assert.equal(engine.normalizationVersion, ACTION_NORMALIZATION_VERSION);
  for (const mutate of [
    (copy) => { copy.rules[0].pattern = ".*"; },
    (copy) => { copy.rules[0].template = "anything"; },
    (copy) => { copy.rules.push(structuredClone(copy.rules[0])); },
    (copy) => { copy.qualifierCues[0].id = copy.rules[0].id; },
    (copy) => { copy.qualifierCues[0].value = "verified"; },
    (copy) => { copy.rules[0].predicates.push(copy.rules[0].predicates[0]); },
    (copy) => { copy.normalizationVersion = "future"; },
  ]) {
    const invalid = structuredClone(config);
    mutate(invalid);
    assert.throws(() => assertActionExtractionConfig(invalid));
  }
  const immutable = structuredClone(config);
  const ownEngine = createActionExtractionEngine(immutable);
  immutable.rules.length = 0;
  assert.equal(ownEngine.assess("甲铁路正式通车。").status, "applicable");
});


test("same-clause new contexts reset qualifiers and postfix plans bind only their own predicate", () => {
  const raw = "甲铁路未通车而乙铁路通车，丙项目投产而丁项目计划投产。";
  const result = annotated(raw);
  const negative = result.assignments.find((item) => item.polarity === "negated");
  assert.equal(negative.evidence.length, 1);
  assert.ok(negative.evidence[0].scope.text.startsWith("甲铁路"));
  const planned = result.assignments.find((item) => item.modality === "planned");
  assert.equal(planned.evidence.length, 1);
  assert.ok(planned.evidence[0].scope.text.includes("丁项目"));
  assert.equal(result.assignments.find((item) => item.modality === "reported" && item.polarity === "affirmative").evidence.length, 2);
  assertSpans(raw, result);
});

test("double negatives, unverified postfix claims and detached conditions abstain", () => {
  for (const raw of ["甲项目不是没有投产。", "甲项目投产的消息未经证实。", "若交通条件改善，甲项目投产。"]) assert.equal(annotated(raw).status, "undetermined", raw);
  const result = annotated("甲项目投产的消息不实。");
  assert.ok(signatures(result).includes("action-engineering/negated/reported"));
});

test("court adjudication and procuratorate prosecution and arrest retain explicit institutional context", () => {
  for (const raw of ["北京市法院公开宣判张某诈骗案。", "北京市检察院依法提起公诉。", "北京市检察院批准逮捕张某。", "北京市检察院决定逮捕张某。"]) {
    assert.ok(signatures(annotated(raw)).includes("action-legal/affirmative/reported"), raw);
  }
  for (const raw of ["有网友宣判工匠精神死刑。", "有关方面决定逮捕张某。", "人民检察院讨论起诉条件。", "当事人计划向法院起诉。"]) assert.equal(annotated(raw).status, "undetermined", raw);
});


test("legal charges and adjacent non-appeal clauses cannot negate adjudication", async () => {
  for (const newsId of ["news-4f2ddb4393ac", "news-8292db53f05f", "news-52951b75acca", "news-a6720b4beff6", "news-c1ba40214bf6"]) {
    const { fragment } = await corpus(newsId);
    const result = annotated(fragment);
    assert.ok(result.assignments.some((item) => item.conceptId === "action-legal" && item.polarity === "affirmative"), newsId);
    assert.ok(!result.assignments.some((item) => item.conceptId === "action-legal" && item.polarity === "negated"), newsId);
  }
  for (const raw of ["法院依法判处张某巨额财产来源不明罪。", "法院因张某非法经营、不正当获利而公开宣判。"]) assert.ok(signatures(annotated(raw)).includes("action-legal/affirmative/reported"));
  for (const raw of ["双方未执行法院的判决。", "法院判决已生效。", "当事人没有履行法院判决。", "甲项目尚未在重要审批完成后投产。"]) assert.equal(annotated(raw).status, "undetermined", raw);
});


test("multiline image metadata, HTML headings and non-http URL paths stay masked", () => {
  for (const raw of [
    "![alt\n法院判处张某三年](image.png)",
    "[![法院判处张某三年](image.png)](https://example.invalid)",
    '[image](image.png\n "法院判处张某三年")',
    "<h2>法院判处张某三年</h2>\n普通正文。",
    "> ## 法院判处张某三年\n普通正文。",
    "www.example.invalid/法院判处张某三年",
    "ftp://example.invalid/法院判处张某三年",
    '[reference]: image.png\n  "法院判处张某三年"',
  ]) {
    assert.equal(normalizeActionFragment(raw).length, raw.length);
    assert.equal(annotated(raw).status, "undetermined", raw);
  }
});


test("book titles and object-disposal 将 cannot become occurrence evidence or future modality", async () => {
  assert.equal(annotated("法院的文章题目是《愿做没有判决的法庭》。").status, "undetermined");
  const { fragment } = await corpus("news-6ca44351dfa6");
  const result = annotated(fragment);
  assert.ok(!signatures(result).includes("action-legal/negated/planned"));
  assert.ok(signatures(result).includes("action-legal/negated/reported"));
  for (const raw of ["甲项目按计划投产。", "甲项目比计划推迟三年尚未投产。"]) assert.ok(annotated(raw).assignments.every((item) => item.modality === "reported"));
  assert.ok(signatures(annotated("甲项目将于2027年正式投产。")).includes("action-engineering/affirmative/planned"));
});


test("future time and ability alone abstain while explicit future plans retain independent polarity", () => {
  for (const raw of ["甲项目未来正式投产。", "甲项目可以投产。", "甲铁路能够通车。", "甲项目未来不会投产。"]) assert.equal(annotated(raw).status, "undetermined", raw);
  assert.ok(signatures(annotated("甲项目未来计划投产。")).includes("action-engineering/affirmative/planned"));
  assert.ok(signatures(annotated("甲项目预计未来投产。")).includes("action-engineering/affirmative/predicted"));
});

test("project-team token is not a project anchor but a separately named facility still is", async () => {
  for (const raw of ["项目组正式开工。", "有些项目组的研究对象是不会变的，比如地质考察，可以等过了年再开工。"]) assert.equal(annotated(raw).status, "undetermined", raw);
  const positive = annotated("项目组确认甲铁路正式开工。");
  assert.ok(signatures(positive).includes("action-engineering/affirmative/reported"));
  const { fragment } = await corpus("news-cf465e2f0587");
  const result = annotated(fragment);
  assert.ok(evidence(result).every((item) => !item.scope.text.includes("有些项目组的研究对象")));
});


test("post-predicate project context retains the current predicate and its governing qualifiers", async () => {
  for (const [raw, modality] of [["正式开工的甲铁路项目正在办理后续手续。", "reported"], ["预计将于2028年建成的射电望远镜项目备受关注。", "predicted"], ["甲项目正式投产而计划开工的乙铁路项目仍在筹备。", "planned"]]) {
    const result = annotated(raw);
    assert.ok(signatures(result).includes(`action-engineering/affirmative/${modality}`), raw);
    assertSpans(raw, result);
  }
  for (const newsId of ["news-820e0bb426a9", "news-031a4c02c914", "news-7c44112d5aa4"]) {
    const { fragment } = await corpus(newsId);
    assertSpans(fragment, annotated(fragment));
  }
  const { fragment } = await corpus("news-7c44112d5aa4");
  const predicted = annotated(fragment).assignments.find((assignment) => assignment.conceptId === "action-engineering" && assignment.modality === "predicted");
  assert.ok(predicted?.evidence.some((item) => item.predicate.text === "建成"));
});

test("ungrounded temporal completion clauses abstain without inventing completed actions or plans", () => {
  for (const raw of ["该项目建成后，可提供大量就业岗位。", "甲项目投产以后，产能将提高。", "甲铁路通车前安排车辆。", "甲铁路建成时举行仪式。", "已经获批的甲项目建成后，将安排生产。"]) assert.equal(annotated(raw).status, "undetermined", raw);
  assert.ok(signatures(annotated("甲项目已经建成后接受了检查。")).includes("action-engineering/affirmative/reported"));
  assert.ok(signatures(annotated("预计甲项目建成后，产量同比增长5%。")).includes("action-engineering/affirmative/predicted"));
});

test("every current-corpus action witness passes exact source-span and structural invariants", async () => {
  const ontology = JSON.parse(await readFile(resolve(root, "data/ontology.json"), "utf8"));
  const pages = new Map(dataset.pages.map((page) => [page.id, page]));
  const pageCache = new Map();
  const issues = [];
  for (const news of dataset.news) {
    const page = pages.get(news.pageId);
    if (!pageCache.has(page.id)) pageCache.set(page.id, await readFile(resolve(root, "sources/bedtimenews-archive-contents", page.repositoryPath), "utf8"));
    const fragment = readNewsFragment(pageCache.get(page.id), news.fragment);
    const result = engine.assess(fragment, { newsId: news.id, fragmentHash: news.fragment.contentHash });
    assertSpans(fragment, result);
    issues.push(...validateActionAssessment(result, ontology, news.id));
  }
  assert.deepEqual(issues, []);
});


test("expectation and plan nouns do not qualify separate reported actions", async () => {
  for (const [newsId, conceptId, forbiddenModality, retainedTrigger] of [
    ["news-e86cef14ae55", "change-quantitative", "predicted", "环比下降0.2%"],
    ["news-5341d5fee365", "action-legal", "planned", "裁定"],
    ["news-5a221453998a", "action-engineering", "predicted", "开工"],
    ["news-6007a2b88efc", "action-engineering", "planned", "开工"],
  ]) {
    const { fragment } = await corpus(newsId);
    const result = annotated(fragment);
    assert.ok(!result.assignments.some((item) => item.conceptId === conceptId && item.modality === forbiddenModality), newsId);
    assert.ok(result.assignments.some((item) => item.conceptId === conceptId && item.modality === "reported" && item.evidence.some((witness) => witness.predicate.text === retainedTrigger)), newsId);
    assertSpans(fragment, result);
  }
  for (const [newsId, anchor, trigger] of [
    ["news-e86cef14ae55", "涨幅符合市场预期，环比下降0.2%", "环比下降0.2%"],
    ["news-5341d5fee365", "重整计划获法院裁定批准", "裁定"],
    ["news-5a221453998a", "预期下开工的", "开工"],
    ["news-6007a2b88efc", "项目开工一年后", "开工"],
  ]) {
    const { fragment } = await corpus(newsId);
    const start = fragment.indexOf(anchor);
    assert.ok(start >= 0, newsId);
    const predicateStart = start + anchor.indexOf(trigger);
    assert.ok(annotated(fragment).assignments.some((item) => item.modality === "reported" && item.evidence.some((witness) => witness.predicate.start === predicateStart && witness.predicate.text === trigger)), newsId);
  }
  for (const raw of ["原油产量同比增长3%，符合市场预期，环比下降0.2%。", "甲项目是在平价上网的预期下开工的。", "重整计划获人民法院裁定批准。", "计划投资35亿元的甲项目开工一年后停建。"]) {
    const result = annotated(raw);
    assert.equal(result.status, "applicable", raw);
    assert.ok(result.assignments.every((item) => item.modality === "reported"), raw);
  }
});

test("irreducible planned-or-realized grouping abstains while distinct plans and forecasts survive", async () => {
  const { fragment } = await corpus("news-22fb182080d3");
  assert.ok(evidence(annotated(fragment)).every((item) => !item.scope.text.includes("多个计划或已经建成")));
  assert.equal(annotated("多个计划或已经建成的铁路项目全部叫停。").status, "undetermined");
  for (const [raw, expected] of [["甲项目计划明年开工。", "planned"], ["市场预期甲项目将于2028年开工。", "predicted"], ["法院计划明日公开裁定。", "planned"], ["甲铁路预计明年通车。", "predicted"]]) assert.ok(signatures(annotated(raw)).includes(`action-${raw.startsWith("法院") ? "legal" : "engineering"}/affirmative/${expected}`), raw);
});

test("continued transport service and readiness conditions are not openings", async () => {
  for (const raw of ["铁路公司愿意保持通车。", "甲铁路将继续维持正常通车。", "甲铁路计划明年6月具备通车条件。", "甲项目具备投产能力。", "甲项目达到开工标准。"]) assert.equal(annotated(raw).status, "undetermined", raw);
  const continued = await corpus("news-bf5f9be6a060");
  assert.ok(evidence(annotated(continued.fragment)).every((item) => !item.scope.text.includes("愿意保持通车")));
  const readiness = await corpus("news-83a247bac5e1");
  const result = annotated(readiness.fragment);
  assert.ok(evidence(result).some((item) => item.predicate.text === "开工"));
  assert.ok(evidence(result).every((item) => !item.scope.text.includes("具备通车条件")));
  assert.ok(signatures(annotated("甲铁路计划明年6月正式通车。")).includes("action-engineering/affirmative/planned"));
});


test("bounded default audit rejects generic, aspirational, hypothetical and lexical witnesses only", async () => {
  for (const [newsId, rejectedStarts, retainedStarts] of [
    ["news-ca60a2994791", [5383], [889, 917]],
    ["news-1e0cd392bd44", [267, 662], [285, 495, 569, 575]],
    ["news-dc83ead77640", [889], [532, 602, 679]],
    ["news-c1829c947be9", [5418], []],
    ["news-7f56b394b966", [6819], [5562]],
  ]) {
    const { fragment } = await corpus(newsId);
    const result = annotated(fragment);
    const starts = new Set(evidence(result).map((item) => item.predicate.start));
    for (const start of rejectedStarts) assert.ok(!starts.has(start), `${newsId} must reject ${start}`);
    for (const start of retainedStarts) assert.ok(starts.has(start), `${newsId} must retain ${start}`);
    assertSpans(fragment, result);
  }
  for (const raw of ["普通人认为法院判决慢也就算了。", "法院判决太快了。", "希望甲水电站早日投产。", "万一甲生产线建成了，后续还需检查。", "甲铁路力争年底开工。", "为明年10月甲铁路通车打下坚实基础。", "中国电建成建的甲电站项目日前并网成功。"]) assert.equal(annotated(raw).status, "undetermined", raw);
  for (const raw of ["法院判决快递公司赔偿损失。", "中国电建承建的甲电站已经建成。", "甲铁路今年正式开工。", "甲铁路通车，为区域发展打下基础。"]) assert.equal(annotated(raw).status, "applicable", raw);
});

test("semicolon earnings-forecast continuation cannot silently become a reported result", async () => {
  const { fragment } = await corpus("news-2bcc0ab303a6");
  const result = annotated(fragment);
  assert.ok(result.assignments.some((item) => item.modality === "predicted" && item.evidence.some((witness) => witness.predicate.start === 631)));
  assert.ok(!result.assignments.some((item) => item.modality === "reported" && item.evidence.some((witness) => witness.predicate.start === 661)));
  assertSpans(fragment, result);
  const forecast = annotated("中报业绩预告显示，预计净利润同比下降5%；收入同比下降3%。");
  assert.ok(forecast.assignments.every((item) => item.modality === "predicted"));
  assert.equal(evidence(forecast).length, 1);
  const historical = annotated("中报业绩预告显示，预计净利润同比下降5%；去年收入同比下降3%。");
  assert.ok(historical.assignments.some((item) => item.modality === "reported" && item.evidence.some((witness) => witness.predicate.text === "同比下降3%")));
  const separate = annotated("中报业绩预告显示，预计净利润同比下降5%。收入同比下降3%。");
  assert.ok(separate.assignments.some((item) => item.modality === "reported"));
});

test("governing wishes, requests and bans do not assert their embedded actions", async () => {
  for (const raw of [
    "卫生部门严格禁止工厂开工。",
    "要求法院判决通告无效。",
    "服务中心希望上海金融法院，先裁定本案适用集体诉讼规则。",
    "我还是希望国家能充分论证工程可行性和经济性再开工。",
    "总理视察甲铁路项目，要求确保2025年12月开工。",
  ]) assert.equal(annotated(raw).status, "undetermined", raw);
  for (const [newsId, rejectedStarts] of [
    ["news-58fc676b1a04", [2476]],
    ["news-783b7c746ac8", [5045]],
    ["news-aa8b97ec4754", [3652]],
    ["news-a153a0578f1a", [5955]],
    ["news-743f4cfb58e4", [111]],
  ]) {
    const { fragment } = await corpus(newsId);
    const result = annotated(fragment);
    for (const start of rejectedStarts) assert.ok(evidence(result).every((item) => item.predicate.start !== start), newsId);
    assertSpans(fragment, result);
  }
  const mixed = annotated("希望甲铁路尽早通车，乙铁路正式通车。禁止丙项目开工，丁项目已开工。");
  assert.deepEqual(evidence(mixed).map((item) => item.scope.text), ["乙铁路正式通车", "丁项目已开工"]);
  for (const raw of ["甲工厂按要求投产。", "甲工程满足要求后正式开工。", "法院判决被告赔偿损失。", "法院裁定要求被告立即履行义务。", "贺某诉至法院要求李某赔偿医疗费，最终判决李某赔偿1.9万多。"]) assert.equal(annotated(raw).status, "applicable", raw);
  const { fragment } = await corpus("news-aa8b97ec4754");
  const retained = new Set(evidence(annotated(fragment)).map((item) => item.predicate.start));
  for (const start of [442, 3495, 3708]) assert.ok(retained.has(start), `retain independent adjudication ${start}`);
  const { fragment: outcome } = await corpus("news-60c615472883");
  assert.ok(evidence(annotated(outcome)).some((item) => item.predicate.start === 781));
});

test("unqualified future dates and cross-comma future metrics cannot become reported occurrences", async () => {
  for (const raw of ["甲项目明年投产。", "甲铁路明天通车。", "顺利的话，工厂明年7、8月份就能投产。", "毕业生人数将达到1158万，同比增长82万人。"]) assert.equal(annotated(raw).status, "undetermined", raw);
  for (const newsId of ["news-805edb0f6e14", "news-89db9f851a38"]) {
    const { fragment } = await corpus(newsId);
    assert.equal(annotated(fragment).status, "undetermined", newsId);
  }
  const { fragment } = await corpus("news-2c1c037d355d");
  const result = annotated(fragment);
  assert.ok(evidence(result).every((item) => item.predicate.start !== 7809));
  for (const start of [3917, 7986]) assert.ok(evidence(result).some((item) => item.predicate.start === start));
  for (const [raw, modality] of [["甲项目计划明年投产。", "planned"], ["甲铁路预计明天通车。", "predicted"], ["甲项目已经投产，明年将扩建。", "reported"]]) assert.ok(signatures(annotated(raw)).includes(`action-engineering/affirmative/${modality}`), raw);
  assertSpans(fragment, result);
});

test("judgment nouns and generic construction descriptions are not occurrence witnesses", async () => {
  for (const raw of ["法院认为第一审判决认定的事实清楚。", "法院判决是有效的。", "项目开工意味着资金投入。", "为了完成项目开工数量考核，安排讨论。", "甲项目举行开工仪式。", "甲铁路的建成区正在扩张。"]) assert.equal(annotated(raw).status, "undetermined", raw);
  const { fragment: legal } = await corpus("news-7b6e631b0a18");
  assert.ok(evidence(annotated(legal)).every((item) => item.predicate.start !== 89));
  const { fragment: engineering } = await corpus("news-8ca91afa3e25");
  const result = annotated(engineering);
  for (const start of [568, 653, 739]) assert.ok(evidence(result).every((item) => item.predicate.start !== start));
  assertSpans(engineering, result);
  for (const raw of ["法院判决被告赔偿。", "甲项目已正式开工。", "甲铁路已经建成。", "项目开工，意味着更多就业机会。"]) assert.equal(annotated(raw).status, "applicable", raw);
});

test("ASCII sentence boundaries cannot lend context or qualifiers while decimal values remain exact", () => {
  for (const raw of ["法院. 判处张某三年。", "法院.判处张某三年。", "甲铁路.正式通车。", "产量已经公布.同比增长5%。"]) assert.equal(annotated(raw).status, "undetermined", raw);
  const raw = "甲铁路计划通车. 乙铁路已正式通车。";
  const result = annotated(raw);
  assert.deepEqual(signatures(result), ["action-engineering/affirmative/planned", "action-engineering/affirmative/reported"]);
  assertSpans(raw, result);
  for (const value of ["0.2%", "13.25%", ".5%", "+.2%", "约.5%"]) {
    const decimal = `产量同比增长${value}.`;
    const assessed = annotated(decimal);
    assert.equal(assessed.status, "applicable", decimal);
    assert.equal(evidence(assessed)[0].predicate.text, `同比增长${value}`);
    assertSpans(decimal, assessed);
  }
  const separate = annotated("产量同比增长0.2%. 收入同比下降1.5%.");
  assert.deepEqual(evidence(separate).map((item) => item.predicate.text), ["同比增长0.2%", "同比下降1.5%"]);
});

test("unmet and unasserted quantitative targets do not become observed changes", () => {
  for (const raw of [
    "产量同比增长5%的目标没有实现。",
    "产量同比增长5%的目标尚未完成。",
    "产量同比增长5%的目标没能实现。",
    "产量同比增长5%的目标。",
    "产量目标是同比增长5%。",
    "目标为产量同比增长5%。",
  ]) assert.equal(annotated(raw).status, "undetermined", raw);
  for (const raw of [
    "产量实际同比增长5%。",
    "产量已实现同比增长5%。",
    "产量同比增长5%，完成了目标。",
    "产量同比增长5%，没有达到10%的目标。",
    "产量已实现同比增长5%的目标。",
    "产量同比增长5%的目标已经实现。",
  ]) {
    const result = annotated(raw);
    assert.ok(signatures(result).includes("change-quantitative/affirmative/reported"), raw);
    assertSpans(raw, result);
  }
  const mixed = annotated("产量同比增长5%的目标没有实现。收入实际同比增长2.5%。");
  assert.deepEqual(evidence(mixed).map((item) => item.predicate.text), ["同比增长2.5%"]);
});

test("sampled judgment documents and direct inability cannot supply affirmative occurrence witnesses", async () => {
  for (const raw of ["有法院判决显示，企业曾向员工索赔。", "法院裁定载明了当事人诉求。", "现在中国还有大批的工厂没法开工。", "甲工厂无法正常投产。", "甲项目没能开工。", "甲铁路没通车。", "甲工厂难以如期投产。"]) assert.equal(annotated(raw).status, "undetermined", raw);
  for (const [newsId, start] of [["news-ff3feca6b0af", 2477], ["news-673d30cb3789", 1794]]) {
    const { fragment } = await corpus(newsId);
    const result = annotated(fragment);
    assert.ok(evidence(result).every((item) => item.predicate.start !== start), newsId);
    assert.equal(result.status, "undetermined", newsId);
    assertSpans(fragment, result);
  }
  for (const raw of ["有法院判决显示企业曾索赔。随后法院判处张某三年。", "甲项目无法按时验收，但已经正式投产。", "甲铁路没法通车，乙铁路已通车。"]) {
    const result = annotated(raw);
    assert.equal(evidence(result).length, 1, raw);
    assert.ok(result.assignments.every((item) => item.polarity === "affirmative" && item.modality === "reported"), raw);
    assertSpans(raw, result);
  }
});
