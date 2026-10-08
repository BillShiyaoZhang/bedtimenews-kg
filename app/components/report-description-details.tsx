import type { Event, Ontology, ReportDescriptionSpan } from "../lib/kg";
import { reportingFormLabel } from "../lib/report-description-assessment.mjs";

const formStatus = {
  applicable: "已有审查标签",
  undetermined: "尚未确定",
  not_applicable: "经审查不适用",
};
const numericStatus = { applicable: "已有受支持描述", undetermined: "尚未确定" };
const comparisonLabel = {
  year_over_year: "同比（与上年同期比较）",
  month_over_month: "环比（与上一期比较）",
};

function EvidenceSpan({ label, span }: { label: string; span: ReportDescriptionSpan }) {
  return <li><span>{label}：{span.text}</span><small>UTF-16 [{span.start}, {span.end})</small></li>;
}

// Each card is a description from exactly one source occurrence. We deliberately
// do not combine repeated/conflicting claims or normalize their literal periods.
export function ReportDescriptionDetails({ ontology, event, expanded = false }: { ontology: Ontology; event: Event; expanded?: boolean }) {
  const form = event.reportingFormAssessment;
  const numeric = event.numericObservationAssessment;
  return <div className="report-description-details">
    <section aria-label="报道形式（经审查）" className="report-description-section">
      <h4>报道形式（经审查）</h4>
      <p className="report-description-status">{form ? formStatus[form.status] : "此版本未记录"}</p>
      {form && <small>仅记录对本条新闻片段的明确审查；未审查不等于不适用。</small>}
      {form?.assignments.map((assignment) => <details key={assignment.conceptId} open={expanded || undefined}>
        <summary>{reportingFormLabel(ontology.reportingForm, assignment.conceptId)}</summary>
        <ul className="report-evidence-spans">{assignment.evidence.map((span) => <EvidenceSpan key={`${span.start}:${span.end}`} label="审查原文" span={span} />)}</ul>
        <small>坐标版本：{assignment.evidence[0]?.normalizationVersion}</small>
      </details>)}
      {form?.review && <details open={expanded || undefined}>
        <summary>查看审查记录</summary>
        <p>{form.review.reason}</p>
        <small>{form.review.reviewedAt} · 审查 {form.review.id}</small>
        <ul className="report-evidence-spans">{form.review.evidence.map((span) => <EvidenceSpan key={`${span.start}:${span.end}`} label="审查范围" span={span} />)}</ul>
      </details>}
    </section>
    <section aria-label="报道中的数值描述" className="report-description-section">
      <h4>报道中的数值描述</h4>
      <p className="report-description-status">{numeric ? numericStatus[numeric.status] : "此版本未记录"}</p>
      {numeric && <small>仅描述原文的局部文字，不代表独立核实，也不表示已涵盖全部数值。尚未确定不等于原文没有数值。</small>}
      {numeric?.observations.map((observation) => <details className="reported-numeric-observation" key={observation.id} open={expanded || undefined}>
        <summary>{observation.metric.text} · {observation.value.direction === "increase" ? "增加" : "减少"} {observation.value.decimal}% · {observation.comparison === "year_over_year" ? "同比" : "环比"}</summary>
        <dl className="report-description-fields">
          <div><dt>原文指标</dt><dd>{observation.metric.text}</dd></div>
          <div><dt>报道中的相对变化</dt><dd>{observation.value.direction === "increase" ? "增加" : "减少"} {observation.value.decimal}%（原文：{observation.value.raw}{observation.evidence.unit.text}）</dd></div>
          <div><dt>比较基准</dt><dd>{comparisonLabel[observation.comparison]}</dd></div>
          <div><dt>原文参照期间</dt><dd>{observation.referencePeriod?.text ?? "原文未明确"}</dd></div>
        </dl>
        <p className="report-source-clause">原文范围：{observation.evidence.scope.text}</p>
        <small>UTF-16 [{observation.evidence.scope.start}, {observation.evidence.scope.end}) · {observation.evidence.normalizationVersion}</small>
        <ul className="report-evidence-spans">
          <EvidenceSpan label="指标" span={observation.evidence.metric} />
          <EvidenceSpan label="比较" span={observation.evidence.comparison} />
          <EvidenceSpan label="方向" span={observation.evidence.direction} />
          <EvidenceSpan label="数值" span={observation.evidence.value} />
          <EvidenceSpan label="单位" span={observation.evidence.unit} />
          {observation.evidence.referencePeriod && <EvidenceSpan label="期间" span={observation.evidence.referencePeriod} />}
        </ul>
        <small>支持规则：{observation.ruleIds.join("、")}</small>
      </details>)}
    </section>
  </div>;
}
