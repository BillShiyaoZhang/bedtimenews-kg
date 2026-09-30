import { canonicalJson, sha256 } from "./candidate-bundle.mjs";
import { buildSegmentationReport } from "./news.mjs";

const bytes = (value) => Buffer.from(`${canonicalJson(value)}\n`);
const must = (value, message) => { if (!value) throw new Error(`Accepted reports: ${message}`); };
export const ACCEPTED_REPORT_PATHS = Object.freeze([
  "data/review/news-segmentation.json", "data/review/ontology-candidates.json", "data/review/upstream-changes.json",
]);

/** Recompute all tracked quality/review reports from the exact candidate.
 * Reports carry no wall-clock time and never reuse a previous coverage result. */
export function buildAcceptedReports({ candidateManifest, artifacts, previousKG = null, ontology }) {
  const kg = artifacts["kg.json"], news = artifacts["news.json"], lifecycle = artifacts["lifecycle.json.gz"], diff = artifacts["diff.json"];
  must(kg && news && lifecycle && diff && candidateManifest?.bundleId && ontology, "complete candidate and ontology are required");
  const recipe = candidateManifest.inputs.recipe;
  must(kg.schemaVersion === ontology.version, "candidate ontology mismatch");
  for (const [name, value] of [["kg.json", kg], ["news.json", news], ["diff.json", diff]]) {
    const content = bytes(value), binding = candidateManifest.artifacts?.[name];
    must(binding?.bytes === content.length && binding.sha256 === sha256(content), `candidate artifact mismatch: ${name}`);
  }
  const previousIds = new Set((previousKG?.events ?? []).map((event) => event.id));
  const newEvents = kg.events.filter((event) => !previousIds.has(event.id));
  const coverage = buildAcceptedOntologyReport({ kg, ontology, newEvents, commit: recipe.archiveCommit, timestamp: recipe.generatedAt });
  coverage.currentIncrementSemantics = "Newly materialized news projections relative to the accepted predecessor, including restorations; not newly occurring real-world events.";
  const upstream = {
    schemaVersion: 4,
    materialization: "full-candidate",
    candidateBundleId: candidateManifest.bundleId,
    upstreamCommit: recipe.archiveCommit,
    observedAt: recipe.generatedAt,
    epistemicScope: "extraction_assignment",
    source: { observedFiles: Object.keys(lifecycle.observedInventory).length,
      effectiveFiles: Object.keys(lifecycle.effectiveInventory).length,
      withdrawnPaths: Object.keys(lifecycle.sourceStates).length },
    reviewedDecisions: lifecycle.decisions,
    graphDiff: diff.graph.summary,
    newsDiff: diff.news.summary,
    diffSha256: sha256(`${canonicalJson(diff)}\n`),
    note: "Changes withdraw or restore extraction support. Source removal is not proof of fact falsity. Full deterministic details are in the bound candidate audit bundle.",
  };
  return new Map([
    [ACCEPTED_REPORT_PATHS[0], bytes(buildSegmentationReport(news))],
    [ACCEPTED_REPORT_PATHS[1], bytes(coverage)],
    [ACCEPTED_REPORT_PATHS[2], bytes(upstream)],
  ]);
}

export function buildAcceptedOntologyReport({ kg, ontology, newEvents, commit, timestamp }) {
  const entitiesById = new Map(
    kg.entities.map((entity) => [entity.id, entity]),
  );
  const eventTypeCounts = Object.fromEntries(
    ontology.eventTypes.map((type) => [
      type.id,
      kg.events.filter((event) => event.type === type.id).length,
    ]),
  );
  const entityTypeCounts = Object.fromEntries(
    ontology.entityTypes.map((type) => [
      type.id,
      kg.entities.filter((entity) => entity.type === type.id).length,
    ]),
  );
  const eventsWithoutKnownEntities = kg.events.filter(
    (event) => !event.entityIds?.length,
  );
  const newEventsWithoutKnownEntities = newEvents.filter(
    (event) => !event.entityIds?.length,
  );
  const otherEvents = newEvents.filter((event) => event.type === "other");
  const facetPresence = Object.fromEntries(
    ontology.facets
      .filter((facet) => facet.entityTypes)
      .map((facet) => {
        const types = new Set(facet.entityTypes);
        const matching = kg.events.filter((event) =>
          event.entityIds.some((id) => types.has(entitiesById.get(id)?.type)),
        ).length;
        return [
          facet.id,
          {
            news: matching,
            percent: percentage(matching, kg.events.length),
          },
        ];
      }),
  );
  return {
    schemaVersion: 4,
    upstreamCommit: commit,
    observedAt: timestamp,
    ontologyVersion: ontology.version,
    newsDatasetSchemaVersion: kg.source.newsDatasetSchemaVersion,
    segmentationVersion: kg.source.segmentationVersion,
    extractionVersion: kg.source.extractionVersion,
    policy:
      "Coverage describes the complete accepted extraction projection. Sources are acquired separately; every accepted candidate fully rematerializes the graph. Topic assignments and legacy event domains are extraction annotations, not independent claims that real-world events occurred.",
    coverage: {
      totalNews: kg.events.length,
      totalKnownEntities: kg.entities.length,
      newsWithKnownEntities:
        kg.events.length - eventsWithoutKnownEntities.length,
      newsWithoutKnownEntities: eventsWithoutKnownEntities.length,
      entityCoveragePercent: percentage(
        kg.events.length - eventsWithoutKnownEntities.length,
        kg.events.length,
      ),
      specificallyClassifiedNews:
        kg.events.length - eventTypeCounts.other,
      eventTypeCoveragePercent: percentage(
        kg.events.length - eventTypeCounts.other,
        kg.events.length,
      ),
      averageEntitiesPerNews: Number(
        (
          kg.events.reduce(
            (total, event) => total + event.entityIds.length,
            0,
          ) / (kg.events.length || 1)
        ).toFixed(2),
      ),
      requiredCoverage: {
        semanticEntity: coverageMetric(
          kg.events.length - eventsWithoutKnownEntities.length,
          kg.events.length,
        ),
        specificEventType: coverageMetric(
          kg.events.length - eventTypeCounts.other,
          kg.events.length,
        ),
        sourceTraceability: coverageMetric(
          kg.events.filter(
            (event) =>
              event.sourceIds.length === 1 &&
              kg.sources.some((source) => source.id === event.sourceIds[0]),
          ).length,
          kg.events.length,
        ),
        searchability: coverageMetric(
          kg.events.filter(
            (event) =>
              event.title?.trim() ||
              event.summary?.trim() ||
              event.entityIds.length,
          ).length,
          kg.events.length,
        ),
      },
      facetPresence,
      entityTypeCounts,
      eventTypeCounts,
    },
    currentIncrement: {
      newNews: newEvents.length,
      newNewsWithoutKnownEntities: newEventsWithoutKnownEntities.length,
      otherTypeNews: otherEvents.length,
      untypedReviewSample: otherEvents.slice(0, 100).map((event) => ({
        id: event.id,
        newsId: event.newsId,
        title: event.title,
        pageId: event.sourceIds[0],
      })),
      entityGapReviewSample: newEventsWithoutKnownEntities
        .slice(0, 100)
        .map((event) => ({
          id: event.id,
          newsId: event.newsId,
          title: event.title,
          pageId: event.sourceIds[0],
        })),
    },
  };
}


function percentage(numerator, denominator) {
  return denominator ? Number(((numerator / denominator) * 100).toFixed(2)) : 0;
}

function coverageMetric(covered, total) {
  return {
    covered,
    total,
    percent: percentage(covered, total),
  };
}
