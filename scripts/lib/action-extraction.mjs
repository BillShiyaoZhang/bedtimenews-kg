import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertActionExtractionConfig } from "./extraction-rules.mjs";

export { assertActionExtractionConfig } from "./extraction-rules.mjs";
export const ACTION_NORMALIZATION_VERSION = "visible-fragment-v1";

// These are description annotations, not occurrence IDs, verified facts, actors,
// or facts combined across news items. Every offset is a UTF-16 offset into the
// versioned visible fragment; masking leaves offsets identical to raw input.
const spaces = (text) => text.replace(/[^\r\n]/g, " ");
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alternatives = (terms) => [...terms].sort((a, b) => b.length - a.length || a.localeCompare(b, "en")).map(escape).join("|");
const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const span = (text, start, end) => ({ start, end, text: text.slice(start, end) });

/** No title, page, URL, image alt text, or comment is an extraction input. */
export function normalizeActionFragment(raw) {
  if (typeof raw !== "string") throw new Error("Action fragment must be a string");
  let text = raw
    .replace(/<!--[\s\S]*?(?:-->|$)/g, spaces)
    .replace(/^(?:\uFEFF)?---[^\S\r\n]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[^\S\r\n]*(?:\r?\n|$)/u, spaces)
    .replace(/^[ \t]*(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*(?:`{3,}|~{3,})[^\n]*(?:\n|$)|(?![\s\S]))/gmu, spaces)
    .replace(/<(script|style|h[1-6]|title)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/giu, spaces)
    .replace(/<(?:"[^"]*"|'[^']*'|[^'">])*(?:>|$)/gu, spaces);

  // Balanced destinations prevent nested URL parentheses or a quoted title from
  // leaking action words. Malformed image/link destinations are masked to fragment end.
  const chars = text.split("");
  function mask(start, end) {
    for (let at = start; at < end; at += 1) if (chars[at] !== "\n" && chars[at] !== "\r") chars[at] = " ";
  }
  for (let at = 0; at < text.length; at += 1) {
    const image = text[at] === "!" && text[at + 1] === "[";
    if (!image && text[at] !== "[") continue;
    const open = at + (image ? 1 : 0);
    const lineEnd = text.length; // Image labels and destinations may span lines.
    // Bracket nesting is bounded by this exact fragment.
    let close = open + 1;
    let labelDepth = 1;
    for (; close < lineEnd; close += 1) {
      if (text[close] === "\\") { close += 1; continue; }
      if (text[close] === "[") labelDepth += 1;
      if (text[close] === "]") { labelDepth -= 1; if (!labelDepth) break; }
    }
    if (close >= lineEnd) { if (image) mask(at, lineEnd); continue; }
    let end = close + 1;
    if (text[end] === "(" || text[end] === "[") {
      const opener = text[end];
      const closer = opener === "(" ? ")" : "]";
      let depth = 1;
      end += 1;
      for (; end < lineEnd; end += 1) {
        if (text[end] === "\\") { end += 1; continue; }
        if (text[end] === opener) depth += 1;
        if (text[end] === closer) { depth -= 1; if (!depth) { end += 1; break; } }
      }
      if (image) mask(at, end);
      else { mask(open, open + 1); mask(close, end); }
    } else if (image) mask(at, end);
    if (image) at = Math.max(at, end - 1);
  }
  text = chars.join("")
    .replace(/^[ \t]{0,3}\[[^\]\r\n]+\]:[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/gmu, spaces)
    .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>]+/giu, spaces)
    .replace(/^[ \t]*(?:>[ \t]*)*#{1,6}(?:[ \t]+|$)[^\r\n]*/gmu, spaces)
    .replace(/^[^\r\n]+\r?\n[ \t]*(?:={3,}|-{3,})[ \t]*(?=\r?$)/gmu, spaces)
    .replace(/《[^》]*(?:》|$)/gu, spaces)
    .replace(/`+[^`\r\n]*`+/gu, spaces)
    .replace(/[*_~`]/gu, spaces);
  if (text.length !== raw.length) throw new Error("Action normalization must preserve UTF-16 offsets");
  return text;
}

// ASCII periods are sentence boundaries too. Keep ordinary decimal dots and
// the explicitly supported comparative forms “同比增长.5% / 环比下降+.2%”.
function sentences(text, config) {
  const directions = config.rules.filter((rule) => rule.template === "quantitative_change").flatMap((rule) => rule.predicates);
  const decimalLead = directions.length ? new RegExp(`(?:同比|环比)[ \\t]*(?:${alternatives(directions)})[ \\t]*(?:了|约|近|达|超过|逾)?[ \\t]*[+-]?$`, "u") : null;
  const result = [];
  let start = 0;
  function append(end) {
    if (end > start) result.push(span(text, start, end));
  }
  for (let at = 0; at < text.length; at += 1) {
    if (/[\r\n]/u.test(text[at])) {
      append(at);
      start = at + 1;
    } else if (/[。！？!?；;]/u.test(text[at]) || text[at] === "." && !(
      /[0-9]/u.test(text[at + 1] ?? "") && (/[0-9]/u.test(text[at - 1] ?? "") || decimalLead?.test(text.slice(start, at)))
    )) {
      append(at + 1);
      start = at + 1;
    }
  }
  append(text.length);
  return result;
}

function literalMatches(text, terms, start = 0, end = text.length) {
  if (!terms.length) return [];
  return [...text.slice(start, end).matchAll(new RegExp(alternatives(terms), "gu"))].map((match) => ({
    start: start + match.index, end: start + match.index + match[0].length, text: match[0],
  }));
}

function clauseStart(text, minimum, at) {
  for (let index = at - 1; index >= minimum; index -= 1) if (/[，,：:]/u.test(text[index])) return index + 1;
  return minimum;
}
function clauseEnd(text, at, maximum) {
  for (let index = at; index < maximum; index += 1) if (/[，,。！？!?；;]/u.test(text[index])) return index;
  return maximum;
}
function trimmedSpan(text, start, end) {
  while (start < end && /\s/u.test(text[start])) start += 1;
  while (end > start && /\s/u.test(text[end - 1])) end -= 1;
  return span(text, start, end);
}

function candidates(text, sentence, rule) {
  if (rule.template !== "quantitative_change") return literalMatches(text, rule.predicates, sentence.start, sentence.end);
  // Explicit comparative direction + non-zero measurement, never a static
  // figure, a zero change, an unqualified headline number, or a guessed delta.
  const pattern = new RegExp(`(?:同比|环比)[ \\t]*(?:${alternatives(rule.predicates)})[ \\t]*(?:了|约|近|达|超过|逾)?[ \\t]*([+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+))[ \\t]*(?:个百分点|%|％|(?:万|亿|千|百)?(?:立方米|千瓦时|千瓦|公里|公顷|元|吨|人|户|个|辆|架|艘|台|件|套|座|米|瓦|亩))`, "gu");
  return [...sentence.text.matchAll(pattern)]
    .filter((match) => Number(match[1]) > 0 && Number.isFinite(Number(match[1])))
    .map((match) => span(text, sentence.start + match.index, sentence.start + match.index + match[0].length));
}

function selectContext(text, sentence, predicate, rule) {
  const contexts = literalMatches(text, rule.contextTerms, sentence.start, sentence.end)
    .filter((context) => !(context.text === "项目" && text[context.end] === "组"));
  // No source-page/topic borrowing, cross-sentence anaphora, or arbitrary remote
  // context. Metric carry-over is allowed only inside this explicit sentence.
  const before = contexts.filter((context) => context.end <= predicate.start && predicate.start - context.end <= 160).at(-1);
  if (before) return before;
  if (rule.template === "quantitative_change") return null;
  const end = clauseEnd(text, predicate.end, sentence.end);
  return contexts.find((context) => context.start >= predicate.end && context.end <= end && context.start - predicate.end <= 60) ?? null;
}

function isLexicalCue(text, cue) {
  // Single characters are not substring classifiers: 未来 and 不变价格 are
  // neither negation nor scope-level modality.
  if (cue.text === "未" && /^(?:来|知|成年)/u.test(text.slice(cue.end))) return false;
  if (cue.text === "不" && /^(?:变|仅|只|但|少|断|同|错|足|明|法|正|良|动产|安全|满|限)/u.test(text.slice(cue.end))) return false;
  if (cue.text === "无" && /^(?:锡|论|数|比|限|偿)/u.test(text.slice(cue.end))) return false;
  if (cue.text === "将" && /^(?:军|领)/u.test(text.slice(cue.end))) return false;
  if (cue.text === "计划" && /(?:比|按|按照|依照)$/u.test(text.slice(0, cue.start))) return false;
  // Expectation can be a comparison/background noun rather than a forecast
  // operator. Retain verb uses such as 市场预期该项目明年开工.
  if (cue.text === "预期" && (
    /(?:符合|低于|高于|超过|超出|不及|达到|落后于|好于|弱于|强于|逊于)[^，,。；;\r\n]{0,12}$/u.test(text.slice(0, cue.start)) ||
    /^(?:之下|之中|下|中)/u.test(text.slice(cue.end))
  )) return false;
  // A plan approved by a court is the object being adjudicated, not a plan
  // to adjudicate. The institutional action remains explicitly reported.
  if (cue.text === "计划" && /^(?:已经|已)?获(?:得)?[\p{Script=Han}]{0,12}(?:法院|法庭)/u.test(text.slice(cue.end))) return false;
  return true;
}

function qualifierEvidence(text, scope, predicate, config, allPredicates) {
  const cues = config.qualifierCues.flatMap((cue) => literalMatches(text, cue.terms, scope.start, scope.end)
    .filter((hit) => isLexicalCue(text, hit))
    .map((hit) => ({ kind: cue.kind, value: cue.value, ...hit })));
  // Longer lexical cues beat contained substrings, independent of rule order.
  const hits = cues.filter((hit) => !cues.some((other) => other !== hit && other.kind === hit.kind && other.start <= hit.start && other.end >= hit.end && other.end - other.start > hit.end - hit.start));
  const localStart = clauseStart(text, scope.start, predicate.start);
  const preceding = allPredicates.filter((other) => other.start >= scope.start && other.end <= predicate.start);
  const local = hits.filter((cue) => cue.start >= localStart);
  const inherited = hits.filter((cue) => cue.start < localStart);
  // A qualifier separated from this predicate by a different occurrence is
  // ambiguous, unless this clause provides its own qualifier of that kind.
  const ambiguous = inherited.some((cue) => preceding.some((other) => other.start >= cue.end) && !local.some((other) => other.kind === cue.kind));
  let unclearAttachment = false;
  const applicable = hits.filter((cue) => {
    if (cue.start <= predicate.start) {
      const gap = text.slice(cue.end, predicate.start);
      if (cue.kind === "modality" && cue.value === "planned" && /(?:或(?:者)?|还是)[^，,。；;]{0,8}(?:已经|已)[^，,。；;]{0,8}$/u.test(gap)) {
        unclearAttachment = true;
        return false;
      }
      // In 计划投资35亿元的项目开工, the investment is planned; the
      // separate opening predicate is not governed by that relative clause.
      if (cue.kind === "modality" && cue.text === "计划" && /^(?:投资|投入|融资|出资|贷款|拨款)[^，,。；;]{1,80}的/u.test(gap)) return false;
      if (cue.kind === "modality" && cue.text === "将") {
        // 把字式 “将医院告上法庭” is not future modality of a later 宣判.
        if (/[，,：:]/u.test(gap)) return false;
        if (!/^(?:(?:[ \t]|依法|公开|正式|如期|按期|全面|完全|被|予以|进行|在|于)|[0-9年月日年底初上下旬季度至一二三四五六七八九十])*$/u.test(gap)) { unclearAttachment = true; return false; }
      }
      if (cue.kind !== "polarity" || cue.value !== "negated") return true;
      // Negation modifies a local predicate or its auxiliaries, not a charge,
      // object adjective, previous sentence or unrelated neighboring clause.
      if (/[，,：:]/u.test(gap)) return false;
      if (/^(?:(?:[ \t]|已经|曾经|依法|公开|正式|计划|预计|准备|立即|如期|按期|全面|完全|实际|真正|能够|可能|再|曾|能|会|将|被|予以|进行|决定|批准|提出|拟|一审|二审)|(?:于|在)[0-9年月日年底初上下旬季度至一二三四五六七八九十]{1,20}|对[^，,。；;]{1,30})*$/u.test(gap)) return true;
      if (cue.text === "否认" && gap.length <= 40) return true;
      unclearAttachment = true;
      return false;
    }
    const gap = text.slice(predicate.end, cue.start);
    if (/^(?:计划|预期|预测|安排|与否)$/u.test(cue.text)) return /^[ \t的]*$/u.test(gap);
    if (/^(?:不实|不属实|被否认|尚未证实|未经证实)$/u.test(cue.text)) return !allPredicates.some((other) => other.start >= predicate.end && other.end <= cue.start);
    return false;
  });
  const selected = [];
  for (const kind of ["polarity", "modality"]) {
    const own = applicable.filter((cue) => cue.kind === kind && cue.start >= localStart);
    const choices = own.length ? own : applicable.filter((cue) => cue.kind === kind);
    if (!choices.length) continue;
    const values = new Set(choices.map((cue) => cue.value));
    if (kind === "modality" && values.has("conditional")) {
      selected.push(...choices.filter((cue) => cue.value === "conditional"));
    } else if (kind === "modality") {
      // Planned construction and expected commissioning may occur together.
      // The nearest explicit cue, within this occurrence scope, governs it.
      // In 预计将于2028年建成, 将于 is the future auxiliary of 预计,
      // not a separate plan that can overrule the explicit forecast.
      const substantive = choices.some((cue) => cue.value === "predicted")
        ? choices.filter((cue) => !(cue.value === "planned" && /^(?:将|将于)$/u.test(cue.text)))
        : choices;
      const nearest = substantive.reduce((best, cue) => Math.abs(predicate.start - cue.start) < Math.abs(predicate.start - best.start) ? cue : best);
      selected.push(...substantive.filter((cue) => cue.value === nearest.value));
    } else selected.push(...choices);
  }
  selected.sort((a, b) => a.start - b.start || a.end - b.end || a.kind.localeCompare(b.kind, "en"));
  return {
    ambiguous: ambiguous || unclearAttachment || selected.filter((cue) => cue.kind === "polarity" && cue.value === "negated").length > 1 || selected.some((cue) => cue.value === "undetermined") || new Set(selected.filter((cue) => cue.kind === "polarity").map((cue) => cue.value)).size > 1,
    polarity: selected.find((cue) => cue.kind === "polarity")?.value ?? "affirmative",
    modality: selected.find((cue) => cue.kind === "modality")?.value ?? "reported",
    qualifiers: selected,
  };
}


// A semicolon does not end an explicitly introduced earnings forecast. We
// abstain on a later unqualified metric instead of borrowing an earlier fact or
// silently treating the reset sentence as a realized financial result.
function financialForecastContinuation(text, sentence, predicate, config) {
  if (!/[；;]/u.test(text[sentence.start - 1] ?? "")) return false;
  let start = sentence.start - 1;
  while (start > 0 && !/[。！？!?\r\n]/u.test(text[start - 1])) start -= 1;
  const preceding = text.slice(start, sentence.start);
  if (!/(?:业绩预告|盈利预告)/u.test(preceding)) return false;
  const historical = /^(?:[ \t]|而|但|其中)*(?:去年|上年|此前|历年)|(?:已经公布|实际录得|实际实现)/u.test(text.slice(sentence.start, predicate.start));
  const predictionTerms = config.qualifierCues.filter((cue) => cue.kind === "modality" && cue.value === "predicted").flatMap((cue) => cue.terms);
  return !historical && literalMatches(preceding, predictionTerms).length > 0;
}

// A request, wish or prohibition does not assert its embedded action. These
// operators have no supported modality yet, so retain neither an affirmative
// occurrence nor a guessed plan. The independently selected scope prevents
// a request about one project from suppressing a later, separately named one.
function unsupportedGoverningOperator(text, scope, predicate) {
  const prefix = text.slice(scope.start, predicate.start);
  const operators = [...prefix.matchAll(/希望|期望|期盼|盼望|请求|呼吁|建议|敦促|禁止|严禁|阻止|避免|要求/gu)];
  return operators.some((operator) => {
    const after = prefix.slice(operator.index + operator[0].length);
    // A separately asserted outcome closes a prior request: “诉至法院要求
    // 赔偿，最终判决…”. Without that explicit transition, abstain.
    if (/[，,](?:而|但)?(?:最终|随后|后来|实际|已经|已)[^，,。；;]*$/u.test(after)) return false;
    if (operator[0] !== "要求") return true;
    // “按要求投产” and “满足要求后正式开工” use the noun, not a
    // directive to perform the extracted action.
    const before = prefix.slice(0, operator.index);
    return !/(?:按|按照|依照|根据|满足|符合|达到)[^，,。；;]{0,8}$/u.test(before) && !/^(?:的|后|以后|之后|并|均|都)/u.test(after);
  });
}

function unqualifiedFutureDescription(text, scope, predicate, rule) {
  const prefix = text.slice(scope.start, predicate.start);
  if (scope.text.includes("未来") || /(?:明年|明日|明天|后年|后天|下(?:一)?(?:年|月|周|星期|季度))/u.test(prefix)) return true;
  // 将 may introduce a future metric before a comma. It cannot be treated as
  // object disposal and silently discarded from “人数将达到…，同比增长…”.
  return rule.template === "quantitative_change" && /将(?:达(?:到)?|有|为|实现|增至|降至)[^。；;]{0,100}$/u.test(prefix);
}

function unsupportedQuantitativeTarget(text, scope, predicate) {
  const prefix = text.slice(scope.start, predicate.start);
  const suffix = text.slice(predicate.end, scope.end);
  if (/^[ \t的]*目标/u.test(suffix)) {
    // A target amount alone, especially an unmet target, is not an observed
    // change. Only a direct, explicit completed attainment supports it.
    const achievedBefore = /(?:已经|已)(?:实现|达到|达成|完成)(?:了)?[ \t]*$/u.test(prefix);
    const achievedAfter = /^[ \t的]*目标(?:已经|已)(?:实现|达到|达成|完成)(?:了)?[ \t。.!！]*$/u.test(suffix);
    return !achievedBefore && !achievedAfter;
  }
  return /目标(?:是|为|定为|设为)[^，,。；;]{0,40}$/u.test(prefix);
}

// Broken scope construction is a programming error, never a reason to drop an
// otherwise supported predicate. Fail the build rather than emit bad evidence.
function assertOccurrenceSpans(evidence, text) {
  const { scope, predicate, qualifiers } = evidence;
  for (const value of [scope, predicate, ...qualifiers]) {
    if (!Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end) || value.start < 0 || value.end <= value.start || value.end > text.length || !value.text.trim() || text.slice(value.start, value.end) !== value.text || value.start < scope.start || value.end > scope.end) {
      throw new Error(`Action evidence scope invariant failed for ${evidence.ruleId} at ${predicate.start}-${predicate.end}`);
    }
  }
}

function validateReviewSpan(evidence, text) {
  if (!evidence || !Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end) || evidence.start < 0 || evidence.end <= evidence.start || evidence.end > text.length || text.slice(evidence.start, evidence.end) !== evidence.text || !evidence.text.trim()) {
    throw new Error("Reviewed action assessment evidence must be an exact nonempty visible-fragment UTF-16 span");
  }
}

export function createActionExtractionEngine(config) {
  assertActionExtractionConfig(config);
  // Snapshot to avoid post-validation mutation or stale cached regex behavior.
  config = structuredClone(config);
  function assess(raw, context = {}) {
    if (typeof raw !== "string") throw new Error("Action fragment must be a string");
    const fragmentHash = hash(raw);
    if (context.fragmentHash !== undefined && context.fragmentHash !== fragmentHash) throw new Error("Action fragmentHash does not match the exact UTF-8 news fragment");
    const text = normalizeActionFragment(raw);
    const assignments = [];
    const groups = new Map();
    const rejected = new Set();
    for (const sentence of sentences(text, config)) {
      const occurrences = config.rules.flatMap((rule) => candidates(text, sentence, rule).map((predicate) => ({ rule, predicate })));
      for (const { rule, predicate } of occurrences) {
        if (/[？?]/u.test(sentence.text) || /(?:是否|能否|会不会|据传|传闻|谣言|假设|万一|打比方|比喻)/u.test(sentence.text)) { rejected.add("ambiguous_scope"); continue; }
        const ownContext = selectContext(text, sentence, predicate, rule);
        if (!ownContext) { rejected.add("insufficient_context"); continue; }
        let start = clauseStart(text, sentence.start, Math.min(ownContext.start, predicate.start));
        // A new explicit context after a previous predicate opens a new local
        // attribution, even without a comma: 甲铁路未通车而乙铁路通车.
        const previous = occurrences.map(({ predicate: hit }) => hit).filter((hit) => hit.end <= Math.min(ownContext.start, predicate.start) && hit.start >= start).sort((a, b) => a.end - b.end).at(-1);
        // Context can follow the predicate (正式开工的铁路项目). The
        // current occurrence and any later occurrence are never predecessors.
        if (previous) start = previous.end;
        const scope = trimmedSpan(text, start, clauseEnd(text, Math.max(ownContext.end, predicate.end), sentence.end));
        // Do not turn a consequent into a reported event when its governing
        // condition is outside the narrow, independently attributable scope.
        const conditionalTerms = config.qualifierCues.filter((cue) => cue.kind === "modality" && cue.value === "conditional").flatMap((cue) => cue.terms);
        if (literalMatches(text, conditionalTerms, sentence.start, scope.start).length) { rejected.add("ambiguous_scope"); continue; }
        if (rule.exclusions.some((term) => scope.text.includes(term))) { rejected.add("excluded_context"); continue; }
        if (rule.template === "engineering_lifecycle" && (
          /^(?:条件|能力|标准|要求|资格|数量|数目|总数|考核|仪式|典礼|意味着|意味著)/u.test(text.slice(predicate.end)) ||
          predicate.text === "通车" && /(?:保持|维持|保障|确保|保证)[^，,。；;]{0,16}$/u.test(text.slice(scope.start, predicate.start)) ||
          predicate.text === "建成" && /^(?:建|区)/u.test(text.slice(predicate.end))
        )) { rejected.add("excluded_context"); continue; }
        // Prevent noun phrases such as 法院判决制度 from looking like acts.
        if (rule.template.startsWith("legal_") && (
          /^(?:书|制度|程序|标准|原则|机制|规则|研究|结果|效率|的|已生效|生效)/u.test(text.slice(predicate.end)) ||
          (predicate.text === "判决" || predicate.text === "裁定") && /^(?:认定的|是|显示|表明|记载|载明|披露|写道|现已生效|仍(?:然)?(?:有效|适用|生效)|被(?:撤销|维持|执行))/u.test(text.slice(predicate.end)) ||
          predicate.text === "判决" && /^(?:(?:很|太|非常|特别|比较)?(?:慢|快)|缓慢|迟缓)(?=[，,。；;！？!?\s]|也|的|得|了|是|而|但|则|$)/u.test(text.slice(predicate.end)) ||
          (predicate.text === "判决" || predicate.text === "裁定") && /(?:的|执行|履行|依据|遵守|服从|零|这份|该份)$/u.test(text.slice(scope.start, predicate.start))
        )) { rejected.add("ambiguous_scope"); continue; }
        const localPrefix = text.slice(clauseStart(text, scope.start, predicate.start), predicate.start);
        const suffix = text.slice(predicate.end, scope.end);
        // Unsupported colloquial negation/inability must not fall through to
        // affirmative. Limit this check to a directly governing local prefix;
        // an inability mentioned in another clause cannot erase a later act.
        if (/(?:没法|没办法|无法|无从|没能|难以|难于)[^，,。；;.]{0,20}$|没(?:(?:正式|如期|按期|全面|完全|正常|实际|真正)|[ \t])*$/u.test(localPrefix)) { rejected.add("ambiguous_scope"); continue; }
        if (unsupportedGoverningOperator(text, scope, predicate)) { rejected.add("ambiguous_scope"); continue; }
        if (rule.template === "quantitative_change" && unsupportedQuantitativeTarget(text, scope, predicate)) { rejected.add("ambiguous_scope"); continue; }
        if (rule.template === "engineering_lifecycle" && /为[^，,。；;]{0,32}$/u.test(localPrefix) && /^(?:打下|奠定)[^，,。；;]{0,8}基础/u.test(suffix)) { rejected.add("ambiguous_scope"); continue; }
        const qualifiers = qualifierEvidence(text, scope, predicate, config, occurrences.map(({ predicate: hit }) => hit).filter((hit) => hit.start !== predicate.start || hit.end !== predicate.end));
        const temporalSubordinate = /^(?:以后|之后|以前|之前|后|前|时)/u.test(text.slice(predicate.end));
        const explicitCompletion = /(?:已经|已)(?:(?:正式|全面|完全|如期|按期)|[ \t]|于[0-9年月日年底初上下旬季度至去年一二三四五六七八九十]{1,20})*$/u.test(text.slice(scope.start, predicate.start));
        const aspiration = rule.template === "engineering_lifecycle" && /(?:(?:早日|尽早)(?:正式|全面|完全)?|(?:力争|争取)[^，,。；;]{0,24})$/u.test(localPrefix);
        const forecastContinuation = rule.template === "quantitative_change" && financialForecastContinuation(text, sentence, predicate, config);
        if (qualifiers.ambiguous || (qualifiers.modality === "reported" && (unqualifiedFutureDescription(text, scope, predicate, rule) || aspiration || forecastContinuation || temporalSubordinate && !explicitCompletion))) { rejected.add("ambiguous_scope"); continue; }
        const witness = { ruleId: rule.id, predicate, scope, qualifiers: qualifiers.qualifiers };
        assertOccurrenceSpans(witness, text);
        const key = JSON.stringify([rule.conceptId, qualifiers.polarity, qualifiers.modality]);
        let assignment = groups.get(key);
        if (!assignment) {
          assignment = { conceptId: rule.conceptId, polarity: qualifiers.polarity, modality: qualifiers.modality, evidence: [] };
          groups.set(key, assignment);
          assignments.push(assignment);
        }
        assignment.evidence.push(witness);
      }
    }
    for (const assignment of assignments) assignment.evidence.sort((a, b) => a.predicate.start - b.predicate.start || a.predicate.end - b.predicate.end || a.ruleId.localeCompare(b.ruleId, "en"));
    assignments.sort((a, b) => a.conceptId.localeCompare(b.conceptId, "en") || a.polarity.localeCompare(b.polarity, "en") || a.modality.localeCompare(b.modality, "en"));
    const reviews = config.reviewedAssessments.filter((review) => review.newsId === context.newsId);
    if (reviews.length) {
      const review = reviews.find((item) => item.fragmentHash === fragmentHash);
      if (!review) throw new Error(`Reviewed action assessment fragmentHash is stale for ${context.newsId}`);
      validateReviewSpan(review.evidence, text);
      if (assignments.length) throw new Error(`Reviewed not_applicable assessment ${review.id} conflicts with supported action evidence`);
      return { status: "not_applicable", reasonCode: "reviewed_not_applicable", assignments: [], review: { id: review.id, reviewedAt: review.reviewedAt, reason: review.reason, evidence: structuredClone(review.evidence) } };
    }
    const reasonCode = assignments.length ? "supported_description" : !text.trim() ? "no_visible_body" : ["ambiguous_scope", "excluded_context", "insufficient_context"].find((reason) => rejected.has(reason)) ?? "no_supported_rule";
    return { status: assignments.length ? "applicable" : "undetermined", reasonCode, assignments, review: null };
  }
  return { version: config.version, normalizationVersion: config.normalizationVersion, assess, matchActionEvidence: assess, validate: (result, fragment, context) => validateAgainst(result, () => assess(fragment, context)) };
}

function validateAgainst(result, expected) {
  try {
    if (isDeepStrictEqual(result, expected())) return [];
    return [{ level: "error", path: "actionAssessment", message: "Action assessment differs from exact rule, qualifier, scope and review replay in its own verified news fragment" }];
  } catch (cause) {
    return [{ level: "error", path: "actionAssessment", message: cause.message }];
  }
}

export function validateActionEvidence(result, fragment, config, context = {}) {
  return validateAgainst(result, () => createActionExtractionEngine(config).assess(fragment, context));
}
