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
    "中国人民银行与人民银行均被提及，国铁集团发布消息，人民大学参与研究。";
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
});
