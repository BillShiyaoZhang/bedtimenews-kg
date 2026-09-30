import assert from "node:assert/strict";
import test from "node:test";
import {
  createExtractionEngine,
  entityKey,
  normalizeExtractionText,
} from "../scripts/lib/extraction.mjs";

function fixtureRules() {
  return {
    version: "1.0.0",
    placeAliases: [{ label: "示例市", aliases: ["示例"] }],
    isoRegionCodes: "US",
    organizationAliases: [{ label: "星河集团", aliases: ["星河"] }],
    organizationSuffixes: ["集团", "大学"],
    facilitySuffixes: ["大桥", "铁路"],
    personRoles: ["总统", "教授"],
    topics: [
      {
        id: "topic-first",
        conceptId: "concept-first",
        entityId: "entity-topic-abcdef123456",
        label: "演示主题",
        aliases: ["主题别名"],
        extractionTriggers: ["主题触发", "第二触发"],
      },
      {
        id: "topic-second",
        conceptId: "concept-second",
        entityId: "entity-topic-fedcba654321",
        label: "备选主题",
        aliases: [],
        extractionTriggers: ["备选触发"],
      },
    ],
    topicEventTypes: {
      "topic-first": "first_event",
      "topic-second": "second_event",
    },
    eventClassification: [
      { id: "first_event", keywords: ["甲乙", "aa"] },
      { id: "second_event", keywords: ["丙丁", "较长词"] },
    ],
  };
}

function assertEvidenceReplays(records, inputs) {
  for (const record of records) {
    assert.equal(typeof record.ruleRef, "string");
    assert.ok(record.ruleRef.length > 0);
    for (const evidence of record.evidence) {
      assert.equal(evidence.normalizationId, "extraction-normalized-v1");
      assert.ok(Object.hasOwn(inputs, evidence.input), evidence.input);
      assert.ok(Number.isInteger(evidence.start));
      assert.ok(Number.isInteger(evidence.end));
      assert.ok(evidence.start >= 0 && evidence.end > evidence.start);
      const normalized = normalizeExtractionText(inputs[evidence.input]);
      assert.equal(normalized.slice(evidence.start, evidence.end), evidence.text);
    }
  }
}

test("candidate decisions preserve legacy candidate shape, order, identity and best method", () => {
  const rules = fixtureRules();
  const engine = createExtractionEngine(rules);
  const text = "😀 示例，示例市。星河集团，星河。落日大桥。总统张三表示：《示范管理法》《示范报告》。主题触发，第二触发，主题触发。";
  const result = engine.extractCandidateDecisions(text, text);
  const expected = [
    { type: "place", label: "示例市", aliases: ["示例"], method: "gazetteer", confidence: 1 },
    { type: "organization", label: "星河集团", aliases: ["星河"], method: "organization_suffix", confidence: 0.84 },
    { type: "facility", label: "落日大桥", aliases: [], method: "facility_suffix", confidence: 0.84 },
    { type: "policy", label: "《示范管理法》", aliases: [], method: "document_title", confidence: 0.98 },
    { type: "document", label: "《示范报告》", aliases: [], method: "named_document", confidence: 0.98 },
    { type: "person", label: "张三", aliases: [], method: "role_after", confidence: 0.86 },
  ].map((candidate) => ({ key: entityKey(candidate.type, candidate.label), ...candidate, prominent: true }));
  expected.push({
    key: "topic:concept-first", type: "topic", entityId: rules.topics[0].entityId,
    label: "演示主题", aliases: ["主题别名"], method: "controlled_vocabulary",
    confidence: 1, topic: rules.topics[0], prominent: false,
  });
  assert.deepEqual(result.candidates, expected);
  assert.deepEqual(engine.extractCandidates(text, text), expected);
  assert.deepEqual(result, engine.extractCandidateDecisions(text, text));
  assertEvidenceReplays(result.observations, { text, prominent: text });
});

test("all trigger, name and alias derivations survive candidate-key deduplication", () => {
  const engine = createExtractionEngine(fixtureRules());
  const text = "示例，示例市。星河集团，星河。主题触发，第二触发，主题触发。";
  const { candidates, observations } = engine.extractCandidateDecisions(text);
  assert.equal(candidates.length, 3);
  const topics = observations.filter((item) => item.candidateKey === "topic:concept-first");
  assert.equal(topics.length, 3);
  assert.deepEqual(topics.map((item) => item.ruleRef), [
    "topics[0].extractionTriggers[0]",
    "topics[0].extractionTriggers[0]",
    "topics[0].extractionTriggers[1]",
  ]);
  assert.deepEqual(topics.map((item) => item.evidence[0].text), ["主题触发", "主题触发", "第二触发"]);
  const places = observations.filter((item) => item.type === "place");
  assert.deepEqual(places.map((item) => [item.ruleRef, item.evidence[0].text]), [
    ["placeAliases[0].aliases[0]", "示例"],
    ["placeAliases[0].label", "示例市"],
  ]);
  const organizations = observations.filter((item) => item.type === "organization");
  assert.deepEqual(organizations.map((item) => [item.method, item.ruleRef, item.evidence[0].text]), [
    ["organization_suffix", "patterns.organizationPattern", "星河集团"],
    ["organization_alias", "organizationAliases[0].label", "星河集团"],
    ["organization_alias", "organizationAliases[0].aliases[0]", "星河"],
  ]);
  assertEvidenceReplays(observations, { text });
});

test("regex witnesses retain the full matched span and use normalized UTF-16 offsets", () => {
  const engine = createExtractionEngine(fixtureRules());
  const text = "\n 😀\t在星河集团。\n总统张三表示《示范\t管理法》。";
  const normalized = normalizeExtractionText(text);
  assert.equal(normalized, "😀 在星河集团。 总统张三表示《示范 管理法》。");
  const result = engine.extractCandidateDecisions(text);
  const organization = result.observations.find((item) => item.method === "organization_suffix");
  assert.equal(organization.label, "星河集团");
  assert.deepEqual(organization.evidence, [{
    input: "text", normalizationId: "extraction-normalized-v1",
    start: 3, end: 8, text: "在星河集团",
  }]);
  const person = result.observations.find((item) => item.type === "person");
  assert.equal(person.label, "张三");
  assert.equal(person.evidence[0].text, "总统张三");
  const policy = result.observations.find((item) => item.type === "policy");
  assert.equal(policy.evidence[0].text, "《示范 管理法》");
  assertEvidenceReplays(result.observations, { text });
});

test("prominent-only recognition stays distinct from body-only and fragment topic evidence", () => {
  const engine = createExtractionEngine(fixtureRules());
  const fragment = "正文只有备选触发，没有具名主体。";
  const prominent = "星河集团报道主题触发";
  const text = `${prominent}\n${fragment}`;
  const result = engine.extractCandidateDecisions(text, prominent);
  const organization = result.observations.filter((item) => item.type === "organization");
  assert.ok(organization.length > 0);
  assert.ok(organization.every((item) => item.input === "prominent"));
  assert.ok(organization.every((item) => item.evidence.every((evidence) => evidence.input === "prominent")));
  assert.ok(result.observations.some((item) => item.candidateKey === "topic:concept-first"));
  assert.deepEqual(engine.matchTopicEvidence(fragment), [{ entityId: "entity-topic-fedcba654321", terms: ["备选触发"] }]);
  assertEvidenceReplays(result.observations, { text, prominent });

  const split = engine.extractCandidateDecisions(fragment, "星河集团");
  assert.ok(split.observations.some((item) => item.type === "organization" && item.input === "prominent"));
  assert.ok(split.observations.some((item) => item.type === "topic" && item.input === "text"));
  const bodyOnly = engine.extractCandidateDecisions("星河集团", "普通标题");
  assert.equal(bodyOnly.candidates.some((item) => item.type === "organization"), false);
});

test("comments and unmatched terms cannot supply extraction or classification evidence", () => {
  const engine = createExtractionEngine(fixtureRules());
  const text = "<!-- 星河集团 主题触发 甲乙 -->\n😀 普通文字\t<!-- 第二触发 --> 备选触发";
  const result = engine.extractCandidateDecisions(text, text);
  assert.deepEqual(result.candidates.map((item) => item.key), ["topic:concept-second"]);
  assert.deepEqual(result.observations.map((item) => item.evidence[0].text), ["备选触发"]);
  const decision = engine.classifyEventDecision(text);
  assert.equal(decision.type, "second_event");
  assert.equal(decision.steps[0].stage, "topic_fallback");
  assert.ok(decision.steps[0].scores.every((item) => item.score === 0));
  assert.deepEqual(decision.steps[0].evidence.map((item) => item.text), ["备选触发"]);
  assertEvidenceReplays(result.observations, { text, prominent: text });
  assertEvidenceReplays(decision.steps, { primary: text });
  assert.deepEqual(engine.extractCandidateDecisions("没有匹配项").observations, []);
});

test("reviewed topic links preserve pinned identity and never fabricate text mentions", () => {
  const rules = fixtureRules();
  const newsId = "news-fixture";
  const topic = rules.topics[0];
  rules.reviewedNewsEntityLinks = {
    [newsId]: [{ type: "topic", conceptId: topic.conceptId, entityId: topic.entityId, label: topic.label, aliases: topic.aliases }],
  };
  const engine = createExtractionEngine(rules);
  const result = engine.extractCandidateDecisions("没有触发词", "", { newsId });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].entityId, topic.entityId);
  assert.deepEqual(result.observations, [{
    candidateKey: "topic:concept-first", entityId: topic.entityId,
    type: "topic", label: topic.label, method: "reviewed_news_link", confidence: 1,
    prominent: true, input: "none", ruleRef: 'reviewedNewsEntityLinks["news-fixture"][0]', evidence: [],
  }]);
  const triggered = engine.extractCandidateDecisions("主题触发", "", { newsId });
  assert.deepEqual(triggered.observations.map((item) => item.method), ["controlled_vocabulary", "reviewed_news_link"]);
  assert.ok(triggered.observations.every((item) => item.entityId === topic.entityId));
  assert.equal(triggered.candidates[0].method, "controlled_vocabulary");
  // Equal-confidence deduplication deliberately keeps the legacy winner's prominence.
  assert.equal(triggered.candidates[0].prominent, false);
  assert.equal(triggered.observations[1].prominent, true);
  assert.deepEqual(engine.matchTopicEvidence("没有触发词"), []);
});

test("weighted classification preserves frequency, UTF-16 weights and configured tie order", () => {
  const engine = createExtractionEngine(fixtureRules());
  const tie = engine.classifyEventDecision("😀 丙丁，甲乙", "较长词较长词");
  assert.equal(tie.type, "first_event");
  assert.equal(tie.selectedInput, "primary");
  assert.equal(tie.steps.length, 1);
  assert.deepEqual(tie.steps[0].scores, [
    { id: "first_event", index: 0, score: 2 },
    { id: "second_event", index: 1, score: 2 },
  ]);
  assert.equal(tie.steps[0].winner, "first_event");
  assert.equal(tie.steps[0].stage, "weighted_keywords");
  assert.equal(tie.steps[0].ruleRef, "eventClassification[0]");
  assertEvidenceReplays(tie.steps, { primary: "😀 丙丁，甲乙" });
  const repeated = engine.classifyEventDecision("甲乙 丙丁丙丁");
  assert.deepEqual(repeated.steps[0].scores, [
    { id: "second_event", index: 1, score: 4 },
    { id: "first_event", index: 0, score: 2 },
  ]);
  assert.equal(repeated.steps[0].evidence.length, 3);
  const nonOverlapping = engine.classifyEventDecision("aaa");
  assert.equal(nonOverlapping.steps[0].scores[0].score, 2);
  assert.equal(nonOverlapping.steps[0].evidence.length, 1);
  const astralRules = fixtureRules();
  astralRules.eventClassification = [
    { id: "emoji", keywords: ["😀"] },
    { id: "single", keywords: ["甲"] },
  ];
  const astral = createExtractionEngine(astralRules).classifyEventDecision("😀甲");
  assert.equal(astral.type, "emoji");
  assert.deepEqual(astral.steps[0].scores.map((item) => item.score), [2, 1]);
  assertEvidenceReplays(astral.steps, { primary: "😀甲" });
  for (const text of ["😀 丙丁，甲乙", "甲乙 丙丁丙丁", "aaa"]) {
    assert.equal(engine.classifyEvent(text), engine.classifyEventDecision(text).type);
  }
});

test("classification records first topic fallback, other and context fallback stages", () => {
  const engine = createExtractionEngine(fixtureRules());
  const firstTopic = engine.classifyEventDecision("备选触发，主题触发，第二触发", "丙丁");
  assert.equal(firstTopic.type, "first_event");
  assert.equal(firstTopic.selectedInput, "primary");
  assert.equal(firstTopic.steps.length, 1);
  assert.equal(firstTopic.steps[0].stage, "topic_fallback");
  assert.equal(firstTopic.steps[0].ruleRef, 'topicEventTypes["topic-first"]');
  assert.deepEqual(firstTopic.steps[0].evidence.map((item) => item.text), ["主题触发", "第二触发"]);
  for (const [context, stage] of [["丙丁", "weighted_keywords"], ["备选触发", "topic_fallback"], ["普通文字", "other"]]) {
    const decision = engine.classifyEventDecision("没有匹配项", context);
    assert.equal(decision.selectedInput, "context");
    assert.deepEqual(decision.steps.map((item) => item.input), ["primary", "context"]);
    assert.equal(decision.steps[0].stage, "other");
    assert.equal(decision.steps[0].winner, "other");
    assert.deepEqual(decision.steps[0].evidence, []);
    assert.equal(decision.steps[1].stage, stage);
    assert.equal(decision.type, stage === "other" ? "other" : "second_event");
    assertEvidenceReplays(decision.steps, { primary: "没有匹配项", context });
    assert.equal(engine.classifyEvent("没有匹配项", context), decision.type);
  }
  const noContext = engine.classifyEventDecision("没有匹配项");
  assert.equal(noContext.steps.length, 1);
  assert.equal(noContext.selectedInput, "primary");
  assert.equal(noContext.type, "other");
});
