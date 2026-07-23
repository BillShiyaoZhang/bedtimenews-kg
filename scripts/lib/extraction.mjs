import { createHash } from "node:crypto";

const GENERIC_LABELS = new Set([
  "中国",
  "我国",
  "国内",
  "公司",
  "集团",
  "政府",
  "当地政府",
  "有关部门",
  "相关部门",
  "委员会",
  "大学",
  "学院",
  "医院",
  "研究院",
  "研究所",
  "银行",
  "基金会",
  "交易所",
  "协会",
  "合作社",
  "电视台",
  "通讯社",
  "报社",
  "工作室",
  "中心",
  "管理局",
  "开发区",
  "工业园",
  "产业园",
  "铁路",
  "高铁",
  "公路",
  "大桥",
  "机场",
  "港口",
  "地铁",
  "多地法院",
  "改革委员会",
  "集团有限公司",
  "既得利益集团",
  "急救中心",
  "加沙医院",
  "全球最大医院",
  "三甲医院",
  "商业银行",
  "社区卫生服务中心",
  "送往医院",
  "新任国防部",
  "中小银行",
  "另一个犯罪集团",
  "城际铁路",
  "第二条城际高速铁路",
  "黑海港口",
  "英国铁路",
  "这个水库",
  "中国国家铁路",
  "中国铁路",
  "重载铁路",
]);

const PERSON_STOP_LABELS = new Set([
  "国家",
  "中国",
  "美国",
  "俄罗斯",
  "韩国",
  "日本",
  "法国",
  "德国",
  "英国",
  "政府",
  "记者",
  "提问",
  "职务",
  "会议",
  "国家安全",
  "外交部",
  "国防部",
  "商务部",
  "财政部",
  "国务院",
  "委员会",
  "公司",
  "集团",
  "宝座",
  "被打",
  "被双开",
  "常委",
  "大家好",
  "当地时间",
  "董事长兼",
  "访谈",
  "候选人",
  "会简史",
  "会上",
  "将于",
  "据报道",
  "了解到",
  "梳理发现",
  "选举",
  "选举结果",
  "邀请",
  "证实",
  "助理",
  "注意到",
  "梳理",
  "从西藏林芝市",
  "董事长",
  "级会议",
  "日前",
  "提出",
]);

const TOPIC_EVENT_TYPES = {
  "topic-macroeconomy": "economy_business",
  "topic-public-finance": "policy_governance",
  "topic-finance": "economy_business",
  "topic-housing": "society_livelihood",
  "topic-manufacturing": "economy_business",
  "topic-digital-economy": "science_technology",
  "topic-ai": "science_technology",
  "topic-semiconductor": "science_technology",
  "topic-energy": "environment_energy",
  "topic-environment": "environment_energy",
  "topic-transport": "infrastructure_transport",
  "topic-agriculture": "society_livelihood",
  "topic-healthcare": "society_livelihood",
  "topic-public-health": "public_health",
  "topic-education": "education_culture",
  "topic-science": "science_technology",
  "topic-population": "society_livelihood",
  "topic-labor": "society_livelihood",
  "topic-social-security": "society_livelihood",
  "topic-governance": "policy_governance",
  "topic-law": "law_justice",
  "topic-public-safety": "disaster_accident",
  "topic-international": "international_relations",
  "topic-defense": "conflict_security",
  "topic-culture": "education_culture",
  "topic-consumption": "economy_business",
  "topic-sports": "education_culture",
};

const POLICY_SUFFIXES =
  "法|条例|办法|规定|规划|方案|通知|意见|纲要|决定|公约|协议";
const DOCUMENT_SUFFIXES = "报告|白皮书|年鉴|标准";

const CONTEXT_BREAKERS = [
  "报道称",
  "发布消息",
  "消息称",
  "调查显示",
  "研究显示",
  "宣布",
  "表示",
  "认为",
  "指出",
  "要求",
  "允许",
  "禁止",
  "投资",
  "收购",
  "成立",
  "未经",
  "发生",
  "遭到",
  "遭",
  "加入",
  "担任",
  "收到",
  "送到",
  "送往",
  "拉到",
  "回击",
  "举报",
  "列入",
  "设立",
  "召开",
  "移交",
  "毕业于",
  "考入",
  "报考",
  "支持",
  "比如说",
  "比如",
  "之前",
  "说",
  "把",
  "包括",
  "以及",
  "其中",
  "记者",
  "根据",
  "目前",
  "已经",
  "将由",
  "被",
  "由",
  "向",
  "从",
  "在",
  "对",
  "与",
  "和",
  "及",
  "为",
  "是",
  "的",
];

const PERSON_TRAILING_WORDS = [
  "主持例行",
  "签署",
  "宣布",
  "表示",
  "指出",
  "认为",
  "提问",
  "邀请",
  "注意到",
  "了解到",
  "证实",
  "发现",
  "选举",
  "称",
  "说",
  "将",
  "在",
  "于",
  "已",
  "与",
  "和",
  "的",
];

export function createExtractionEngine(rules) {
  const places = buildPlaceGazetteer(rules);
  const aliasToPlace = new Map();
  for (const place of places) {
    for (const alias of [place.label, ...place.aliases]) {
      if (alias.length >= 2 && !aliasToPlace.has(alias)) {
        aliasToPlace.set(alias, place);
      }
    }
  }
  const placeAliases = [...aliasToPlace.keys()].sort(
    (left, right) => right.length - left.length,
  );
  const knownPlacePattern = new RegExp(
    placeAliases.map(escapeRegExp).join("|"),
    "gu",
  );
  const knownPlaceNames = new Set(placeAliases);

  const organizationSuffixPattern = alternativesPattern(
    rules.organizationSuffixes,
  );
  const facilitySuffixPattern = alternativesPattern(rules.facilitySuffixes);
  const rolePattern = alternativesPattern(rules.personRoles);
  const organizationPattern = new RegExp(
    `([\\p{Script=Han}A-Za-z0-9·&（）()《》“”_-]{2,32}(?:${organizationSuffixPattern}))`,
    "gu",
  );
  const facilityPattern = new RegExp(
    `([\\p{Script=Han}A-Za-z0-9·（）()_-]{2,28}(?:${facilitySuffixPattern}))`,
    "gu",
  );
  const policyPattern = new RegExp(
    `《([^》\\n]{2,48}(?:${POLICY_SUFFIXES}))》`,
    "gu",
  );
  const documentPattern = new RegExp(
    `《([^》\\n]{2,48}(?:${DOCUMENT_SUFFIXES}))》`,
    "gu",
  );
  const personAfterRolePattern = new RegExp(
    `(?:${rolePattern})[：:、，,\\s“”]{0,3}([\\p{Script=Han}·]{2,12}?|[A-Z][A-Za-z .·'-]{1,36}?)(?=在|于|向|与|和|将|已|曾|的|表示|指出|认为|宣布|强调|称|说|访问|会见|出席|主持|签署|邀请|抵达|离开|[，。；：、,;\\s]|$)`,
    "gu",
  );

  const topicCandidates = rules.topics.map((topic) => ({
    key: entityKey("topic", topic.label),
    type: "topic",
    label: topic.label,
    aliases: unique(topic.keywords),
    method: "controlled_vocabulary",
    confidence: 1,
    topic,
  }));

  function extractCandidates(text, prominentText = "") {
    const normalizedText = normalizeText(text);
    const normalizedProminent = normalizeText(prominentText);
    const normalizedNamedText = normalizedProminent || normalizedText;
    const candidates = new Map();
    const add = (candidate) => {
      if (!candidate || GENERIC_LABELS.has(candidate.label)) return;
      const existing = candidates.get(candidate.key);
      if (!existing || candidate.confidence > existing.confidence) {
        candidates.set(candidate.key, {
          ...candidate,
          prominent:
            candidate.prominent ??
            [candidate.label, ...(candidate.aliases ?? [])].some((alias) =>
              normalizedProminent.includes(alias),
            ),
        });
      } else if (
        !existing.prominent &&
        [candidate.label, ...(candidate.aliases ?? [])].some((alias) =>
          normalizedProminent.includes(alias),
        )
      ) {
        existing.prominent = true;
      }
    };

    knownPlacePattern.lastIndex = 0;
    for (const match of normalizedText.matchAll(knownPlacePattern)) {
      const place = aliasToPlace.get(match[0]);
      if (!place) continue;
      add({
        key: entityKey("place", place.label),
        type: "place",
        label: place.label,
        aliases: place.aliases,
        method: "gazetteer",
        confidence: 1,
      });
    }

    organizationPattern.lastIndex = 0;
    for (const match of normalizedNamedText.matchAll(organizationPattern)) {
      const label = cleanNamedLabel(match[1], 24);
      if (!isUsefulOrganizationLabel(label, rules.organizationSuffixes)) continue;
      add({
        key: entityKey("organization", label),
        type: "organization",
        label,
        aliases: [],
        method: "organization_suffix",
        confidence: 0.84,
      });
    }

    facilityPattern.lastIndex = 0;
    for (const match of normalizedNamedText.matchAll(facilityPattern)) {
      const label = cleanNamedLabel(match[1], 22);
      if (!isUsefulFacilityLabel(label, rules.facilitySuffixes)) continue;
      add({
        key: entityKey("facility", label),
        type: "facility",
        label,
        aliases: [],
        method: "facility_suffix",
        confidence: 0.84,
      });
    }

    policyPattern.lastIndex = 0;
    for (const match of normalizedText.matchAll(policyPattern)) {
      const label = `《${normalizeText(match[1])}》`;
      if (label.length > 52) continue;
      add({
        key: entityKey("policy", label),
        type: "policy",
        label,
        aliases: [],
        method: "document_title",
        confidence: 0.98,
      });
    }

    documentPattern.lastIndex = 0;
    for (const match of normalizedText.matchAll(documentPattern)) {
      const label = `《${normalizeText(match[1])}》`;
      if (label.length > 52) continue;
      add({
        key: entityKey("document", label),
        type: "document",
        label,
        aliases: [],
        method: "named_document",
        confidence: 0.98,
      });
    }

    for (const [pattern, method, confidence] of [
      [personAfterRolePattern, "role_after", 0.86],
    ]) {
      pattern.lastIndex = 0;
      for (const match of normalizedNamedText.matchAll(pattern)) {
        const label = cleanPersonLabel(match[1]);
        if (
          !label ||
          knownPlaceNames.has(label) ||
          PERSON_STOP_LABELS.has(label) ||
          rules.personRoles.some((role) => label.includes(role))
        ) {
          continue;
        }
        add({
          key: entityKey("person", label),
          type: "person",
          label,
          aliases: [],
          method,
          confidence,
        });
      }
    }

    for (const candidate of topicCandidates) {
      if (
        candidate.topic.keywords.some((keyword) =>
          normalizedText.includes(keyword),
        )
      ) {
        add(candidate);
      }
    }
    return [...candidates.values()];
  }

  function classifyEvent(text) {
    const normalized = normalizeText(text);
    const scores = rules.eventClassification.map((definition, index) => ({
      id: definition.id,
      index,
      score: definition.keywords.reduce(
        (total, keyword) => total + countOccurrences(normalized, keyword),
        0,
      ),
    }));
    scores.sort(
      (left, right) => right.score - left.score || left.index - right.index,
    );
    if (scores[0]?.score) return scores[0].id;
    for (const topic of rules.topics) {
      if (
        topic.keywords.some((keyword) => normalized.includes(keyword)) &&
        TOPIC_EVENT_TYPES[topic.id]
      ) {
        return TOPIC_EVENT_TYPES[topic.id];
      }
    }
    return "other";
  }

  return {
    version: rules.version,
    extractCandidates,
    classifyEvent,
  };
}

export function shouldKeepCandidate(stat) {
  if (stat.method === "controlled_vocabulary" || stat.method === "gazetteer") {
    return true;
  }
  if (["document_title", "named_document"].includes(stat.method)) return true;
  if (["person", "organization", "facility"].includes(stat.type)) {
    return stat.eventCount >= 2;
  }
  return stat.prominent || stat.eventCount >= 2;
}

export function materializeEntity(stat) {
  const descriptions = {
    controlled_vocabulary: `受控主题词；由 ${stat.eventCount} 条独立新闻的关键词规则命中。`,
    gazetteer: `标准地名；在 ${stat.eventCount} 条独立新闻中出现。`,
    administrative_suffix: `由行政区划后缀规则识别的地点；在 ${stat.eventCount} 条独立新闻中出现。`,
    organization_suffix: `由组织名称后缀规则识别的主体；在 ${stat.eventCount} 条独立新闻中出现。`,
    facility_suffix: `由设施名称后缀规则识别的命名对象；在 ${stat.eventCount} 条独立新闻中出现。`,
    document_title: `由书名号与文件类型后缀识别的政策文件；在 ${stat.eventCount} 条独立新闻中出现。`,
    named_document: `由书名号与文献类型后缀识别的报告或文献；在 ${stat.eventCount} 条独立新闻中出现。`,
    role_after: `由职务后的姓名上下文识别的人物；在 ${stat.eventCount} 条独立新闻中出现。`,
    role_before: `由姓名后的职务上下文识别的人物；在 ${stat.eventCount} 条独立新闻中出现。`,
  };
  return {
    id: entityId(stat.type, stat.label),
    label: stat.label,
    type: stat.type,
    aliases: unique(stat.aliases ?? []).filter((alias) => alias !== stat.label),
    description: descriptions[stat.method] ?? "由确定性规则从存档中识别。",
    extraction: {
      method: stat.method,
      confidence: stat.confidence,
      eventCount: stat.eventCount,
    },
  };
}

export function entityKey(type, label) {
  return `${type}:${normalizeIdentifier(label)}`;
}

export function entityId(type, label) {
  return `entity-${type}-${createHash("sha1")
    .update(`${type}:${normalizeIdentifier(label)}`)
    .digest("hex")
    .slice(0, 12)}`;
}

function buildPlaceGazetteer(rules) {
  const entries = new Map();
  for (const item of rules.placeAliases) {
    entries.set(item.label, {
      label: item.label,
      aliases: unique(item.aliases ?? []),
    });
  }
  const displayNames = new Intl.DisplayNames(["zh-CN"], { type: "region" });
  const specialCodes = new Set(["CN", "HK", "MO", "TW"]);
  for (const code of rules.isoRegionCodes.split(/\s+/u)) {
    if (!code || specialCodes.has(code)) continue;
    const label = displayNames.of(code);
    if (!label || label === code || entries.has(label)) continue;
    entries.set(label, { label, aliases: [] });
  }
  return [...entries.values()];
}

function cleanNamedLabel(value, maxLength) {
  let label = normalizeText(value)
    .replace(/^[《》“”"'(（)）]+|[《》“”"'(（)）]+$/gu, "")
    .replace(
      /^(?:(?:18|19|20)?\d{1,4}(?:年|月|日|时|分|个|家|所|名|亿元|万元|岁|届|条|艘|人|—|-|\.|、)?)+/u,
      "",
    )
    .replace(/^(?:据|由|被|向|从|在|对|与|和|及|为|是|该|这家|一家|多家|当地|相关|有关)+/gu, "");
  let lastBoundary = -1;
  let boundaryLength = 0;
  for (const token of CONTEXT_BREAKERS) {
    const index = label.lastIndexOf(token);
    if (index >= lastBoundary && index + token.length < label.length) {
      lastBoundary = index;
      boundaryLength = token.length;
    }
  }
  if (lastBoundary >= 0) label = label.slice(lastBoundary + boundaryLength);
  label = label.replace(/^[《》“”"'(（)）]+|[《》“”"'(（)）]+$/gu, "");
  if (label.length > maxLength) label = label.slice(-maxLength);
  return label.trim();
}

function cleanPersonLabel(value) {
  let label = normalizeText(value)
    .replace(/^[《“"'（(]+|[》”"'）)]+$/gu, "")
    .trim();
  for (const word of PERSON_TRAILING_WORDS) {
    if (label.endsWith(word) && label.length > word.length + 1) {
      label = label.slice(0, -word.length);
    }
  }
  label = label.replace(/^(?:前|原|现任|时任|候任)+/u, "");
  if (
    /^(?:的|等|各|该|本|农业|教育|项目|职务|会议)/u.test(label) ||
    /(?:公司|集团|政府|大学|学院|银行|委员会|项目|产业|农业|教育)$/u.test(
      label,
    )
  ) {
    return "";
  }
  if (
    /(?:被查|被抓|被捕|被判|免职|辞职|下台|访华|访美|访问|会面|会晤|握手|建议|回应|发文|落马|去世|出席|调研|投票|签署|宣布|表示|指出|认为|主持|参加|获胜|当选|任命|受贿|起诉|公诉|通缉|绑架|弹劾|取消|敦促|祝贺|介绍|指导|工作|活动|项目|职务)/u.test(
      label,
    )
  ) {
    return "";
  }
  if (label.includes("·")) {
    return /^[\p{Script=Han}A-Za-z·]{3,24}$/u.test(label) ? label : "";
  }
  if (/^[A-Z][A-Za-z .'-]{1,36}$/u.test(label)) return label.trim();
  return /^[\p{Script=Han}]{2,6}$/u.test(label) ? label : "";
}

function isUsefulNamedLabel(label) {
  return (
    Boolean(label) &&
    label.length >= 3 &&
    !GENERIC_LABELS.has(label) &&
    !/^(?:相关|有关|当地|某个|一家|多家|各地|全国|本地)/u.test(label) &&
    !/(?:表示|宣布|认为|指出|接受|负责|成为|已经|目前|希望|可能|应该)/u.test(
      label,
    )
  );
}

function isUsefulOrganizationLabel(label, suffixes) {
  if (!isUsefulNamedLabel(label)) return false;
  if (
    /^(?:地方|当地|相关|有关|各级|各地|各个|公立|私立|外资|外商|全球主要|多家|一家|会不会|能不能|是否|为什么|如何|建立|抓紧|请问|送往|按照|按|保护|帮助|包含|绑架|办公室|比全世界|本级|本省|之前|取消)/u.test(
      label,
    )
  ) {
    return false;
  }
  if (
    /[《》“”"]|(?:\d{1,4}年|\d{1,2}月|\d{1,2}日|\d+名|\d+家|\d+所|\d+人|\d+岁)|(?:发生|爆炸|回升|回击|举报|遭|送到|移交|召开|毕业于|考入|报考|列入|设立|支持|解决)/u.test(
      label,
    )
  ) {
    return false;
  }
  const suffix = [...suffixes]
    .sort((left, right) => right.length - left.length)
    .find((candidate) => label.endsWith(candidate));
  if (!suffix) return false;
  const prefix = label.slice(0, -suffix.length);
  return prefix.length >= 2 && !/^(?:主要|有关|相关|当地|地方)$/u.test(prefix);
}

function isUsefulFacilityLabel(label, suffixes) {
  if (!isUsefulNamedLabel(label)) return false;
  if (
    /^(?:全国|国内|现有|部分|多个|多地|几条|一条|一座|几座|第二条|建设|新建|修建|乘坐|抵达|飞往|途经|关于|通过|恢复|调整|投入|规划|用于|敌方|俄方|中方|美方|政府|公司|董事长|股东|但是|不过|直到|没有|保护|标志|称|当前|当晚|第一|调查|多位|避免|反思|否|国家|都给|把)/u.test(
      label,
    ) ||
    /(?:几条|多条|一座|几座|部分|现有|这座|另一条|全国|国内)$/u.test(label)
  ) {
    return false;
  }
  const suffix = [...suffixes]
    .sort((left, right) => right.length - left.length)
    .find((candidate) => label.endsWith(candidate));
  if (!suffix) return false;
  const prefix = label.slice(0, -suffix.length);
  return prefix.length >= 2 && !/\d+(?:条|座|个|年|公里|兆瓦|城市)$/u.test(prefix);
}

function normalizeIdentifier(value) {
  return normalizeText(value)
    .toLocaleLowerCase("zh-CN")
    .replace(/[《》“”"'（）()\s_-]/gu, "");
}

function normalizeText(value = "") {
  return String(value).replace(/\s+/gu, " ").trim();
}

function countOccurrences(text, keyword) {
  if (!keyword) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(keyword, offset)) !== -1) {
    count += 1;
    offset += keyword.length;
  }
  return count;
}

function alternativesPattern(values) {
  return [...values]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join("|");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
