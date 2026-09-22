import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createExtractionEngine } from "../scripts/lib/extraction.mjs";
import {
  createEventSearchDocument,
  matchesSearchDocument,
  parseSearchQuery,
} from "../app/lib/search.mjs";

const rules = JSON.parse(
  await readFile(new URL("../data/extraction-rules.json", import.meta.url), "utf8"),
);
const extractor = createExtractionEngine(rules);
const ontology = JSON.parse(
  await readFile(new URL("../data/ontology.json", import.meta.url), "utf8"),
);

// Description fragments at upstream 2736b82773744dcc7a0906c59f5b67854833b2dd.

function labels(text) {
  return new Set(extractor.extractCandidates(text, text).map((item) => item.label));
}

test("reference 648 transport addition has a semantic topic and specific event type", () => {
  const text = "东北多个火车站更为旅客乘降所，不再办理售票，旅客直接上车买票";
  assert.equal(extractor.classifyEvent(text, text), "infrastructure_transport");
  assert.ok(labels(text).has("交通与基础设施"));
});

test("reference 649 mental-health statistic has healthcare semantics", () => {
  const text = "内地精神障碍患病人数30年近乎翻倍";
  assert.equal(extractor.classifyEvent(text, text), "public_health");
  assert.ok(labels(text).has("医疗健康"));
});

test("reference 650 hiring preserves labor semantics and its named employer", () => {
  const employeePolicy = "胖东来称再招员工都是学员，合同四年、不续签、走向社会";
  assert.ok(labels(employeePolicy).has("胖东来"));
  assert.ok(labels(employeePolicy).has("就业与劳动"));
  assert.equal(extractor.classifyEvent(employeePolicy, employeePolicy), "society_livelihood");
});

test("reference 650 profit award identifies the source-named company", () => {
  const profit = "比亚迪今年利润奖还没有动静";
  assert.ok(labels(profit).has("比亚迪"));
  assert.equal(extractor.classifyEvent(profit, profit), "economy_business");
});

test("reference 650 discussion focuses on employee treatment after the fire", () => {
  const discussion = "星宇事件、China GT起火事件激发善待员工大讨论";
  assert.ok(labels(discussion).has("就业与劳动"));
  assert.equal(extractor.classifyEvent(discussion, discussion), "society_livelihood");
  assert.equal(labels(discussion).has("星宇股份"), false);
});

test("reference 651 inspections retain their explicitly named place", () => {
  const inspection = "菏泽某烧烤园店主网络实名举报文物遗失后，被5个部门检查15次";
  assert.ok(labels(inspection).has("菏泽市"));
  assert.equal(extractor.classifyEvent(inspection, inspection), "policy_governance");
});

test("reference 651 austerity notice has governance semantics", () => {
  const university = "北大过紧日子通知要求不到21个景区开会，并非北大严选";
  assert.ok(labels(university).has("公共治理"));
  assert.equal(extractor.classifyEvent(university, university), "policy_governance");
});

test("reference 649 tobacco-control policy is not left as other", () => {
  const text = "香港控烟更严，要求香烟外包装统一设计";
  assert.equal(extractor.classifyEvent(text, text), "policy_governance");
});

test("reviewed phrases do not capture unrelated staff, crimes, fires or place names", () => {
  for (const text of ["员工参加合影", "员工乘车", "美丽星宇"]) {
    assert.equal(labels(text).has("就业与劳动"), false, text);
  }
  for (const text of ["北大西洋公约组织", "东北大学", "河北大城", "湖北大学"]) {
    assert.equal(labels(text).has("北京大学"), false, text);
  }
  const crime = "男子有精神障碍，法院判处死刑";
  assert.equal(extractor.classifyEvent(crime, crime), "law_justice");
  const fire = "上海赛车场CHINA GT赛事发生碰撞起火事故，救援不利";
  assert.equal(extractor.classifyEvent(fire, fire), "disaster_accident");
  const accusation = "实名举报教师性骚扰，警方调查案件";
  assert.equal(extractor.classifyEvent(accusation, accusation), "law_justice");
});

test("new sync fragments support title, topic, canonical place and type searches", () => {
  for (const [title, queries] of [
    ["东北火车站改为旅客乘降所", ["乘降所", "交通与基础设施", "基建与交通"]],
    ["内地精神障碍患病人数30年翻倍", ["精神障碍", "医疗健康", "公共卫生"]],
    ["胖东来称再招员工都是学员", ["胖东来", "就业与劳动"]],
    ["比亚迪今年利润奖还没有动静", ["比亚迪", "利润奖", "经济与商业"]],
    ["China GT起火事件激发善待员工大讨论", ["China GT", "善待员工", "社会与民生"]],
    ["菏泽店主网络实名举报文物遗失", ["菏泽市", "文物遗失", "政策与治理"]],
    ["北大过紧日子通知要求不到景区开会", ["北大", "公共治理"]],
    ["香港控烟更严，香烟外包装统一设计", ["香港特别行政区", "政策与治理"]],
  ]) {
    const type = extractor.classifyEvent(title, title);
    const document = createEventSearchDocument({
      event: { title, summary: title, type, date: "2026-09-20" },
      entities: extractor.extractCandidates(title, title),
      eventType: ontology.eventTypes.find((item) => item.id === type),
    });
    for (const query of queries) {
      assert.equal(matchesSearchDocument(document, parseSearchQuery(query)), true, `${query}: ${title}`);
    }
  }
});
