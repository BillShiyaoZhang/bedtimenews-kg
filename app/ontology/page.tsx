import type { Metadata } from "next";
import Link from "next/link";
import knowledgeBaseData from "../../data/generated/kg.json";
import ontologyData from "../../data/ontology.json";
import type { KnowledgeBase, Ontology } from "../lib/kg";
import type { CSSProperties } from "react";

export const metadata: Metadata = {
  title: "Ontology 浏览器｜历史经纬",
  description: "浏览以独立新闻为单位的知识本体、实体类型、事件类型、关系约束与覆盖率。",
};

const knowledgeBase = knowledgeBaseData as unknown as KnowledgeBase;
const ontology = ontologyData as unknown as Ontology;

const FACET_ENTITY_TYPES = {
  subject: ["person", "organization"],
  place: ["place"],
  topic: ["topic"],
  named_object: ["facility", "policy", "document"],
} as const;

function percentage(matched: number, total: number) {
  return total ? (matched / total) * 100 : 0;
}

function typeLabel(id: string) {
  if (id === "event") return "事件";
  return ontology.entityTypes.find((type) => type.id === id)?.label ?? id;
}

export default function OntologyPage() {
  const entityCounts = new Map<string, number>();
  const entityTypeById = new Map<string, string>();
  const eventCounts = new Map<string, number>();
  const relationCounts = new Map<string, number>();

  for (const entity of knowledgeBase.entities) {
    entityCounts.set(entity.type, (entityCounts.get(entity.type) ?? 0) + 1);
    entityTypeById.set(entity.id, entity.type);
  }
  for (const event of knowledgeBase.events) {
    eventCounts.set(event.type, (eventCounts.get(event.type) ?? 0) + 1);
  }
  for (const relation of [
    ...knowledgeBase.eventRelations,
    ...knowledgeBase.entityRelations,
  ]) {
    relationCounts.set(
      relation.type,
      (relationCounts.get(relation.type) ?? 0) + 1,
    );
  }

  const coverage = [
    {
      id: "entity",
      label: "实体",
      description: "新闻至少关联一个语义实体",
      matched: knowledgeBase.events.filter((event) => event.entityIds.length)
        .length,
    },
    {
      id: "event",
      label: "具体事件类型",
      description: "新闻已归入“其他事件”之外的类型",
      matched: knowledgeBase.events.filter((event) => event.type !== "other")
        .length,
    },
    {
      id: "source",
      label: "来源追溯",
      description: "事件精确引用一个仍存在的原始页面",
      matched: knowledgeBase.events.filter(
        (event) =>
          event.sourceIds.length === 1 &&
          knowledgeBase.sources.some(
            (source) => source.id === event.sourceIds[0],
          ),
      ).length,
    },
    {
      id: "search",
      label: "可检索",
      description: "新闻具有标题、摘要或语义实体可进入检索索引",
      matched: knowledgeBase.events.filter(
        (event) =>
          event.title.trim() || event.summary.trim() || event.entityIds.length,
      ).length,
    },
  ];
  const facetPresence = Object.entries(FACET_ENTITY_TYPES).map(
    ([id, types]) => ({
      id,
      label: ontology.facets.find((facet) => facet.id === id)?.label ?? id,
      description:
        ontology.facets.find((facet) => facet.id === id)?.description ?? "",
      matched: knowledgeBase.events.filter((event) =>
        event.entityIds.some((entityId) =>
          (types as readonly string[]).includes(
            entityTypeById.get(entityId) ?? "",
          ),
        ),
      ).length,
    }),
  );

  return (
    <main className="ontology-page">
      <header className="site-header detail-header">
        <Link className="brand" href="/" aria-label="返回历史经纬首页">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>
            <strong>历史经纬</strong>
            <small>Ontology Browser</small>
          </span>
        </Link>
        <nav aria-label="主要导航">
          <Link href="/">返回检索</Link>
          <Link href="/graph">知识图谱</Link>
        </nav>
      </header>

      <section className="ontology-hero">
        <span className="eyebrow">Ontology {ontology.version}</span>
        <h1>{ontology.label}</h1>
        <p>{ontology.description}</p>
        <dl>
          <div>
            <dt>基本单位</dt>
            <dd>{ontology.recordUnit.label}</dd>
          </div>
          <div>
            <dt>检索维度</dt>
            <dd>{ontology.facets.length}</dd>
          </div>
          <div>
            <dt>实体类型</dt>
            <dd>{ontology.entityTypes.length}</dd>
          </div>
          <div>
            <dt>事件类型</dt>
            <dd>{ontology.eventTypes.length}</dd>
          </div>
          <div>
            <dt>关系类型</dt>
            <dd>{ontology.relationTypes.length}</dd>
          </div>
        </dl>
      </section>

      <section className="ontology-section coverage-section">
        <div className="ontology-section-heading">
          <div>
            <span className="eyebrow">Coverage</span>
            <h2>全库覆盖率</h2>
          </div>
          <p>
            以 {knowledgeBase.events.length.toLocaleString("zh-CN")}{" "}
            条独立新闻为分母；必填语义、类型、来源与检索字段均必须完整。
          </p>
        </div>
        <div className="coverage-grid">
          {coverage.map((item) => {
            const value = percentage(item.matched, knowledgeBase.events.length);
            return (
              <article key={item.id}>
                <div>
                  <strong>{item.label}</strong>
                  <span>{value.toFixed(2)}%</span>
                </div>
                <div
                  className="coverage-bar"
                  role="meter"
                  aria-label={`${item.label}覆盖率`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Number(value.toFixed(2))}
                >
                  <i
                    style={
                      { "--coverage": `${value}%` } as CSSProperties
                    }
                  />
                </div>
                <p>
                  {item.matched.toLocaleString("zh-CN")} /{" "}
                  {knowledgeBase.events.length.toLocaleString("zh-CN")} ·{" "}
                  {item.description}
                </p>
              </article>
            );
          })}
        </div>
      </section>

      <section className="ontology-section coverage-section">
        <div className="ontology-section-heading">
          <div>
            <span className="eyebrow">Facet presence</span>
            <h2>可选维度出现率</h2>
          </div>
          <p>
            Facet 只在原文具有相应语义时出现；这里描述数据分布，不把“不适用”误报为覆盖缺口。
          </p>
        </div>
        <div className="coverage-grid">
          {facetPresence.map((item) => {
            const value = percentage(item.matched, knowledgeBase.events.length);
            return (
              <article key={item.id}>
                <div>
                  <strong>{item.label}</strong>
                  <span>{value.toFixed(2)}%</span>
                </div>
                <div
                  className="coverage-bar"
                  role="meter"
                  aria-label={`${item.label}出现率`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Number(value.toFixed(2))}
                >
                  <i
                    style={
                      { "--coverage": `${value}%` } as CSSProperties
                    }
                  />
                </div>
                <p>
                  {item.matched.toLocaleString("zh-CN")} /{" "}
                  {knowledgeBase.events.length.toLocaleString("zh-CN")} ·{" "}
                  {item.description}
                </p>
              </article>
            );
          })}
        </div>
      </section>

      <section className="ontology-section">
        <div className="ontology-section-heading">
          <div>
            <span className="eyebrow">Search facets</span>
            <h2>首页检索维度</h2>
          </div>
          <p>Facet 是用户入口；类型是数据约束。两者分层维护。</p>
        </div>
        <div className="facet-grid">
          {ontology.facets.map((facet, index) => (
            <article key={facet.id}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <h3>{facet.label}</h3>
              <p>{facet.description}</p>
              <div>
                {facet.eventTypes?.map((type) => (
                  <i key={type}>{type === "*" ? "全部事件类型" : type}</i>
                ))}
                {facet.entityTypes?.map((type) => (
                  <i key={type}>{typeLabel(type)}</i>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="ontology-section">
        <div className="ontology-section-heading">
          <div>
            <span className="eyebrow">Entity classes</span>
            <h2>实体类型</h2>
          </div>
          <p>
            当前发布{" "}
            {knowledgeBase.entities.length.toLocaleString("zh-CN")} 个实体。
          </p>
        </div>
        <div className="type-grid">
          {ontology.entityTypes.map((type) => (
            <article key={type.id}>
              <div>
                <i style={{ background: type.color }} />
                <span>{type.id}</span>
                <strong>
                  {(entityCounts.get(type.id) ?? 0).toLocaleString("zh-CN")}
                </strong>
              </div>
              <h3>{type.label}</h3>
              <p>{type.description}</p>
              <Link
                href={{
                  pathname: "/graph",
                  query: { type: type.id },
                }}
              >
                浏览此类实体 →
              </Link>
            </article>
          ))}
        </div>
      </section>

      <section className="ontology-section">
        <div className="ontology-section-heading">
          <div>
            <span className="eyebrow">Event classes</span>
            <h2>事件类型</h2>
          </div>
          <p>事件类型描述每条独立新闻中发生了什么，而非原页面或稿件栏目名称。</p>
        </div>
        <div className="type-grid event-type-grid">
          {ontology.eventTypes.map((type) => (
            <article key={type.id}>
              <div>
                <i style={{ background: type.color }} />
                <span>{type.id}</span>
                <strong>
                  {(eventCounts.get(type.id) ?? 0).toLocaleString("zh-CN")}
                </strong>
              </div>
              <h3>{type.label}</h3>
              <p>{type.description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="ontology-section relation-section">
        <div className="ontology-section-heading">
          <div>
            <span className="eyebrow">Relations</span>
            <h2>关系与约束</h2>
          </div>
          <p>自动发布关系必须有端点约束、证据说明和来源。</p>
        </div>
        <div className="relation-table">
          {ontology.relationTypes.map((relation) => (
            <article key={relation.id}>
              <div>
                <strong>{relation.label}</strong>
                <code>{relation.id}</code>
              </div>
              <p>{relation.description}</p>
              <div className="relation-signature">
                <span>{relation.from.map(typeLabel).join(" / ")}</span>
                <i>{relation.directed ? "→" : "↔"}</i>
                <span>{relation.to.map(typeLabel).join(" / ")}</span>
              </div>
              <small>
                当前实例{" "}
                {(relationCounts.get(relation.id) ?? 0).toLocaleString("zh-CN")}{" "}
                条
              </small>
            </article>
          ))}
        </div>
      </section>

      <section className="ontology-method">
        <div>
          <span className="eyebrow">Provenance</span>
          <h2>可复现，而不是手工维护</h2>
        </div>
        <p>
          当前 KG 由上游 Markdown、独立新闻数据集、Ontology 与版本化抽取规则生成。
          每个事件投影必须通过 newsId 对应一条独立新闻，并通过 pageId
          与片段哈希回到原始页面。每次构建执行 schema、新闻投影与引用完整性校验。
        </p>
        <dl>
          <div>
            <dt>抽取规则</dt>
            <dd>{knowledgeBase.source.extractionVersion}</dd>
          </div>
          <div>
            <dt>原始页面</dt>
            <dd>{knowledgeBase.sources.length.toLocaleString("zh-CN")}</dd>
          </div>
          <div>
            <dt>关系实例</dt>
            <dd>
              {(
                knowledgeBase.eventRelations.length +
                knowledgeBase.entityRelations.length
              ).toLocaleString("zh-CN")}
            </dd>
          </div>
        </dl>
      </section>

      <footer>
        <span>Ontology 与抽取规则独立版本化</span>
        <Link href="/">回到首页检索</Link>
      </footer>
    </main>
  );
}
