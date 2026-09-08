import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createExtractionEngine } from "../scripts/lib/extraction.mjs";

const rules = JSON.parse(
  await readFile(new URL("../data/extraction-rules.json", import.meta.url)),
);
const extractor = createExtractionEngine(rules);

test("extractor separates subjects, places, policies, documents, and topics", () => {
  const text =
    "美国总统拜登在北京市表示，中国人民银行将依据《金融稳定法》推进改革，《金融稳定报告》同时发布，人工智能产业也受到关注。";
  const values = extractor.extractCandidates(text, text);
  const identities = new Set(
    values.map((value) => `${value.type}:${value.label}`),
  );

  assert.ok(identities.has("person:拜登"));
  assert.ok(identities.has("place:美国"));
  assert.ok(identities.has("place:北京市"));
  assert.ok(identities.has("organization:中国人民银行"));
  assert.ok(identities.has("policy:《金融稳定法》"));
  assert.ok(identities.has("document:《金融稳定报告》"));
  assert.ok(identities.has("topic:人工智能"));
});

test("event classification uses reviewed universal categories", () => {
  assert.equal(
    extractor.classifyEvent("某地铁路正式开工建设"),
    "infrastructure_transport",
  );
  assert.equal(
    extractor.classifyEvent("法院对案件作出判决"),
    "law_justice",
  );
  assert.equal(
    extractor.classifyEvent("新一轮疫情防控与疫苗接种"),
    "public_health",
  );
  assert.equal(
    extractor.classifyEvent(
      "地区局势出现新变化",
      "多国将提供战机和军援，相关武装仍在交火",
    ),
    "conflict_security",
  );
  assert.equal(
    extractor.classifyEvent(
      "日本男子因看动漫被打断勒死父母",
      "法院以杀人和弃尸罪判处有期徒刑",
    ),
    "law_justice",
  );
  assert.equal(
    extractor.classifyEvent(
      "中国大陆男网选手首进巡回赛单打决赛",
      "国际男子网球协会公布赛果",
    ),
    "education_culture",
  );
  assert.equal(
    extractor.classifyEvent("宋涛出任中央台办、国台办主任"),
    "policy_governance",
  );
});

test("reviewed vocabulary gives long-tail news a semantic entity", () => {
  for (const title of [
    "巴菲特再卖比亚迪并继续减持",
    "C919大型客机获颁生产许可证",
    "超级大乐透和双色球调整规则",
    "中国6岁女童接受基因编辑试验后死亡",
  ]) {
    assert.ok(
      extractor.extractCandidates(title, title).length > 0,
      `expected a semantic entity for: ${title}`,
    );
  }
});

test("new archive headlines map to reviewed semantic topics", () => {
  for (const { title, topic, eventType } of [
    {
      title:
        "今年首轮投档未能录满、需要征集志愿的本科专业，财经、外语和一些热门工科专业排在前列",
      topic: "教育",
      eventType: "education_culture",
    },
    {
      title: "打击电诈误伤带来新难题，不知情第三方卷入，也会被冻结账户",
      topic: "法律与司法",
      eventType: "law_justice",
    },
  ]) {
    const candidates = extractor.extractCandidates(title, title);

    assert.ok(
      candidates.some(
        (candidate) =>
          candidate.type === "topic" && candidate.label === topic,
      ),
      `expected ${topic} topic for: ${title}`,
    );
    assert.equal(extractor.classifyEvent(title, title), eventType);
  }
});

test("incremental policy phrase maps to the reviewed macroeconomic topic", () => {
  const title = "最高层会议提出及时谋划出台务实管用的增量政策";
  const candidates = extractor.extractCandidates(title, title);

  assert.ok(
    candidates.some(
      (candidate) =>
        candidate.type === "topic" && candidate.label === "宏观经济",
    ),
  );
});

// Reviewed against reference/601-700/{636,637,639,641,643,646}.md at
// upstream fed7fdb5e3703d03c947252302b6f4a202610e9c.
test("late-summer archive vocabulary supplies evidence-backed semantic topics", () => {
  for (const [title, topic] of [
    [
      "多地查处严重超载面包车，都是暑假到父母工作地探望父母的“小候鸟”",
      "公共安全",
    ],
    ["暑假儿童被单独放在图书馆一天，现在成了问题", "文化与传媒"],
    [
      "涨价也没救成茅台，净利润开始下滑，甚至中央汇金、证金公司清仓退出前十大股东",
      "金融与资本市场",
    ],
    ["今年法拍房市场明显放量，前七个月成交量相当于去年全年近八成", "住房与土地"],
    [
      "国内一个月被曝三起IIT试验死亡事件，曾让中国生物制药企业获得成本和速度优势的模式受到考验",
      "医疗健康",
    ],
    ["又见村医造假虚报精神病，但是纠错难", "医疗健康"],
    ["我国与热浪相关的过早死亡有多少", "环境与气候"],
    ["1991年前出生的人，不能新办理40年期个人房贷吗", "住房与土地"],
    ["“年龄＋期限”不超过75岁的规则会松动吗", "金融与资本市场"],
  ]) {
    assert.ok(
      extractor.extractCandidates(title, title).some(
        (candidate) => candidate.type === "topic" && candidate.label === topic,
      ),
      `expected ${topic} topic for: ${title}`,
    );
  }
});

test("new archive event types follow the specific reported action", () => {
  for (const [title, eventType] of [
    ["多地查处严重超载面包车", "law_justice"],
    ["陕西房主反抗强拆导致强拆人员死亡案宣判，属于正当防卫", "law_justice"],
    ["我国与热浪相关的过早死亡有多少", "environment_energy"],
    ["四川雷波县让老师和“耻辱”合影", "education_culture"],
    ["华芯科技与海特高新抢公章还有前传", "economy_business"],
    ["1991年前出生的人，不能新办理40年期个人房贷吗", "society_livelihood"],
    ["“年龄＋期限”不超过75岁的规则会松动吗", "economy_business"],
    ["其实还有接力贷、子孙贷，南宁一楼盘曾宣传贷款年龄最长达100岁", "economy_business"],
  ]) {
    assert.equal(extractor.classifyEvent(title, title), eventType, title);
  }
});

test("company dispute aliases preserve both source-named organizations", () => {
  // The full name occurs in reference/640; reference/644 uses its short name.
  for (const title of [
    "成都海威华芯科技与大股东海特高新的公司治理纠纷再次升级，再度爆发抢公章大战",
    "华芯科技与海特高新抢公章还有前传",
  ]) {
    const organizations = extractor.extractCandidates(title, title)
      .filter((candidate) => candidate.type === "organization");
    const labels = new Set(organizations.map((candidate) => candidate.label));
    assert.ok(labels.has("成都海威华芯科技"));
    assert.ok(labels.has("海特高新"));
    assert.equal(labels.has("华芯科技"), false);
    assert.equal(labels.has("华为"), false);
  }
});

test("reviewed health and loan vocabulary does not generalize to unrelated words", () => {
  const titles = [
    "试验结束后，所有设备停止运行",
    "年龄增长，期限延长，调整规则",
    "死亡事件仍有疑问",
  ];
  for (const title of titles) {
    const topics = extractor.extractCandidates(title, title)
      .filter((candidate) => candidate.type === "topic")
      .map((candidate) => candidate.label);
    for (const unwanted of ["医疗健康", "金融与资本市场", "住房与土地", "环境与气候"]) {
      assert.equal(topics.includes(unwanted), false, title);
    }
  }
});

test("development zone consolidation maps to public governance", () => {
  const title = "5个考核评价靠后国家级经开区被摘帽，地方撤并经开区";
  const candidates = extractor.extractCandidates(title, title);

  assert.ok(
    candidates.some(
      (candidate) =>
        candidate.type === "topic" && candidate.label === "公共治理",
    ),
  );
  assert.equal(extractor.classifyEvent(title, title), "policy_governance");
});

test("coverage advisory headlines map to evidence-backed event types", () => {
  for (const { title, eventType } of [
    {
      title: "江苏多地“处”改回“科”，“科”改回“股”",
      eventType: "policy_governance",
    },
    {
      title: "辽宁鞍山频现“鬼火少年”飙车炸街，一次性抓捕103人",
      eventType: "law_justice",
    },
    {
      title: "这个夏天的知了叫好像特别响，多地多人因蝉鸣听力受损",
      eventType: "public_health",
    },
  ]) {
    assert.equal(extractor.classifyEvent(title, title), eventType);
  }
});

test("HTML comments cannot invent entities or override the visible event type", () => {
  const text = `<!-- 华为发布《虚假条例》，法院判决涉及犯罪、起诉、逮捕、抓捕、违法与执法。

这里仍然是模板注释，不是新闻事实。
-->
人工智能技术研发取得进展，研究团队公布实验结果。`;
  const candidates = extractor.extractCandidates(text, text);
  assert.equal(extractor.classifyEvent(text, text), "science_technology");
  assert.ok(candidates.some((candidate) => candidate.label === "人工智能"));
  assert.equal(
    candidates.some((candidate) =>
      ["华为", "《虚假条例》", "法律与司法"].includes(candidate.label),
    ),
    false,
  );
});

test("cicada hearing-loss news uses healthcare semantics without borrowing Huawei", () => {
  const title = "这个夏天的知了叫好像特别响，多地多人因蝉鸣听力受损";
  const candidates = extractor.extractCandidates(title, title, {
    newsId: "news-e2fbb834e13e",
  });

  assert.ok(
    candidates.some(
      (candidate) =>
        candidate.type === "topic" && candidate.label === "医疗健康",
    ),
  );
  assert.equal(
    candidates.some(
      (candidate) =>
        candidate.type === "organization" && candidate.label === "华为",
    ),
    false,
  );
});

test("reviewed entity filters reject recurring grammatical false positives", () => {
  const text =
    "记者采访后表示，省级政府会见有关团队，这条铁路仍在讨论中。";
  const labels = new Set(
    extractor.extractCandidates(text, text).map((candidate) => candidate.label),
  );
  for (const label of ["采访", "省级政府", "会见", "团队", "这条铁路"]) {
    assert.equal(labels.has(label), false, `unexpected entity: ${label}`);
  }
});

test("reviewed organization aliases resolve to one canonical identity", () => {
  const text =
    "中国人民银行与人民银行均被提及，国铁集团发布消息，人民大学参与研究，华为公布进展。";
  const organizations = extractor
    .extractCandidates(text, text)
    .filter((candidate) => candidate.type === "organization");
  const byLabel = new Map(
    organizations.map((candidate) => [candidate.label, candidate]),
  );
  assert.ok(byLabel.has("中国人民银行"));
  assert.ok(byLabel.get("中国人民银行").aliases.includes("人民银行"));
  assert.ok(byLabel.has("中国国家铁路集团有限公司"));
  assert.ok(byLabel.has("中国人民大学"));
  assert.ok(byLabel.has("华为"));
});
