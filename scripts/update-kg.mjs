#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  appendNewRecords,
  classifyArchiveChanges,
} from "./lib/incremental.mjs";
import { validate } from "./lib/validate.mjs";

const execFile = promisify(execFileCallback);
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = parseArgs(process.argv.slice(2));
const bootstrap = Boolean(args.bootstrap);
const sourceRoot = resolve(
  projectRoot,
  args.source ??
    process.env.BEDTIMENEWS_ARCHIVE ??
    "sources/bedtimenews-archive-contents",
);
const includeRoots = String(
  args.include ??
    "main,daily,reference,opinion,business,commercial,livestream,shorts",
)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const generatedPath = resolve(projectRoot, "data/generated/kg.json");
const statePath = resolve(projectRoot, "data/archive-state.json");
const upstreamReportPath = resolve(
  projectRoot,
  "data/review/upstream-changes.json",
);
const ontologyReportPath = resolve(
  projectRoot,
  "data/review/ontology-candidates.json",
);

const [upstreamCommit, observedAt, currentFiles, ontology] = await Promise.all([
  gitOutput(["rev-parse", "HEAD"]),
  gitOutput(["show", "-s", "--format=%cI", "HEAD"]),
  buildFileManifest(sourceRoot, includeRoots),
  readJson(resolve(projectRoot, "data/ontology.json")),
]);

const tempRoot = await mkdtemp(resolve(tmpdir(), "bedtimenews-kg-"));
const candidatePath = resolve(tempRoot, "candidate.json");
let candidate;
try {
  await execFile(process.execPath, [
    resolve(projectRoot, "scripts/build-kg.mjs"),
    "--source",
    sourceRoot,
    "--include",
    includeRoots.join(","),
    "--generated-at",
    observedAt,
    "--output",
    candidatePath,
  ]);
  candidate = await readJson(candidatePath);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

if (bootstrap) {
  await assertBootstrapTargetIsEmpty();
  const issues = validate(candidate, ontology);
  if (issues.length) throwValidationError(issues);

  const state = {
    schemaVersion: 1,
    source: {
      name: "bedtimenews/bedtimenews-archive-contents",
      url: "https://github.com/bedtimenews/bedtimenews-archive-contents",
      submodulePath: relative(projectRoot, sourceRoot).replaceAll("\\", "/"),
    },
    includedRoots: includeRoots,
    initialImportCommit: upstreamCommit,
    lastObservedCommit: upstreamCommit,
    lastObservedAt: observedAt,
    acceptedFiles: currentFiles,
  };
  const report = buildUpstreamReport({
    bootstrap: true,
    observedAt,
    upstreamCommit,
    changes: emptyChanges(),
    ingestedPaths: Object.keys(currentFiles).sort(),
    appended: {
      sources: candidate.sources,
      events: candidate.events,
      entities: candidate.entities,
      eventRelations: candidate.eventRelations,
      entityRelations: candidate.entityRelations,
    },
  });

  await Promise.all([
    writeJson(generatedPath, candidate),
    writeJson(statePath, state),
    writeJson(upstreamReportPath, report),
    writeJson(
      ontologyReportPath,
      buildOntologyReport(candidate, candidate.events, upstreamCommit, observedAt),
    ),
  ]);
  printSummary("Bootstrapped", report, candidate);
  process.exit(0);
}

const [state, existing] = await Promise.all([
  readRequiredJson(
    statePath,
    "Archive state is missing. Run `npm run kg:bootstrap` once and review the full import.",
  ),
  readRequiredJson(
    generatedPath,
    "Generated KG is missing. Restore it from Git before running an incremental update.",
  ),
]);
if (JSON.stringify(state.includedRoots) !== JSON.stringify(includeRoots)) {
  throw new Error(
    "Included archive roots changed. Review the scope explicitly before updating data/archive-state.json.",
  );
}

const changes = classifyArchiveChanges(state.acceptedFiles, currentFiles);
const { kg, appended } = appendNewRecords(
  existing,
  candidate,
  changes.added,
  observedAt,
);
const issues = validate(kg, ontology);
if (issues.length) throwValidationError(issues);

const acceptedFiles = { ...state.acceptedFiles };
for (const path of changes.added) acceptedFiles[path] = currentFiles[path];
const nextState = {
  ...state,
  lastObservedCommit: upstreamCommit,
  lastObservedAt: observedAt,
  acceptedFiles: sortObject(acceptedFiles),
};
const report = buildUpstreamReport({
  bootstrap: false,
  observedAt,
  upstreamCommit,
  changes,
  ingestedPaths: changes.added,
  appended,
});
const generatedChanged =
  appended.sources.length ||
  appended.events.length ||
  appended.entities.length ||
  appended.eventRelations.length ||
  appended.entityRelations.length;
const stateChanged =
  upstreamCommit !== state.lastObservedCommit || changes.added.length > 0;
const reportChanged =
  stateChanged ||
  changes.modified.length ||
  changes.deleted.length ||
  changes.possibleRenames.length ||
  changes.duplicateAdditions.length;

const writes = [];
if (generatedChanged) writes.push(writeJson(generatedPath, kg));
if (stateChanged) writes.push(writeJson(statePath, nextState));
if (reportChanged) writes.push(writeJson(upstreamReportPath, report));
if (generatedChanged) {
  writes.push(
    writeJson(
      ontologyReportPath,
      buildOntologyReport(kg, appended.events, upstreamCommit, observedAt),
    ),
  );
}
await Promise.all(writes);
printSummary(writes.length ? "Updated" : "Already current", report, kg);

function buildUpstreamReport({
  bootstrap: isBootstrap,
  observedAt: timestamp,
  upstreamCommit: commit,
  changes,
  ingestedPaths,
  appended,
}) {
  return {
    schemaVersion: 1,
    policy: {
      additions: "append_automatically",
      modifications: "report_only_preserve_existing_records",
      deletions: "report_only_preserve_existing_records",
      renames: "report_only_preserve_existing_records",
      ontology: "report_candidates_only_never_mutate_automatically",
    },
    upstreamCommit: commit,
    observedAt: timestamp,
    bootstrap: isBootstrap,
    summary: {
      ingestedFiles: ingestedPaths.length,
      appendedSources: appended.sources.length,
      appendedEvents: appended.events.length,
      appendedEntities: appended.entities.length,
      appendedRelations:
        appended.eventRelations.length + appended.entityRelations.length,
      modifiedFilesAwaitingReview: changes.modified.length,
      deletedFilesAwaitingReview: changes.deleted.length,
      possibleRenamesAwaitingReview: changes.possibleRenames.length,
      duplicateAdditionsAwaitingReview: changes.duplicateAdditions.length,
    },
    ingestedPaths: isBootstrap ? [] : ingestedPaths,
    pendingReview: {
      modified: changes.modified,
      deleted: changes.deleted,
      possibleRenames: changes.possibleRenames,
      duplicateAdditions: changes.duplicateAdditions,
    },
  };
}

function buildOntologyReport(kg, newEvents, commit, timestamp) {
  const eventTypeCounts = Object.fromEntries(
    ontology.eventTypes.map((type) => [
      type.id,
      kg.events.filter((event) => event.type === type.id).length,
    ]),
  );
  const eventsWithoutKnownEntities = kg.events.filter(
    (event) => !event.entityIds?.length,
  );
  const newEventsWithoutKnownEntities = newEvents.filter(
    (event) => !event.entityIds?.length,
  );
  const fallbackEvents = newEvents.filter(
    (event) => event.type === "historical_milestone",
  );
  return {
    schemaVersion: 1,
    upstreamCommit: commit,
    observedAt: timestamp,
    policy:
      "Ontology and entity vocabulary changes require maintainer review; this report never edits data/ontology.json or existing entities.",
    coverage: {
      totalEvents: kg.events.length,
      totalKnownEntities: kg.entities.length,
      eventsWithKnownEntities:
        kg.events.length - eventsWithoutKnownEntities.length,
      eventsWithoutKnownEntities: eventsWithoutKnownEntities.length,
      entityCoveragePercent: percentage(
        kg.events.length - eventsWithoutKnownEntities.length,
        kg.events.length,
      ),
      eventTypeCounts,
    },
    currentIncrement: {
      newEvents: newEvents.length,
      newEventsWithoutKnownEntities: newEventsWithoutKnownEntities.length,
      fallbackTypeEvents: fallbackEvents.length,
      reviewSample: newEventsWithoutKnownEntities.slice(0, 100).map((event) => ({
        id: event.id,
        title: event.title,
        sourceIds: event.sourceIds,
      })),
    },
  };
}

async function buildFileManifest(root, roots) {
  const files = (
    await Promise.all(roots.map((folder) => walk(resolve(root, folder))))
  )
    .flat()
    .filter((path) => extname(path) === ".md")
    .sort();
  if (!files.length) {
    throw new Error(`No Markdown content found under ${root}.`);
  }
  const entries = await Promise.all(
    files.map(async (path) => {
      const content = await readFile(path);
      return [
        relative(root, path).replaceAll("\\", "/"),
        createHash("sha256").update(content).digest("hex"),
      ];
    }),
  );
  return Object.fromEntries(entries);
}

async function walk(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const nested = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory() ? walk(path) : [path];
      }),
  );
  return nested.flat();
}

async function gitOutput(values) {
  const { stdout } = await execFile("git", ["-C", sourceRoot, ...values]);
  return stdout.trim();
}

async function assertBootstrapTargetIsEmpty() {
  for (const path of [generatedPath, statePath]) {
    try {
      await readFile(path);
      throw new Error(
        `${relative(projectRoot, path)} already exists; bootstrap refuses to overwrite accepted data.`,
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const [key, inlineValue] = value.slice(2).split("=", 2);
    if (inlineValue !== undefined) parsed[key] = inlineValue;
    else if (values[index + 1] && !values[index + 1].startsWith("--")) {
      parsed[key] = values[++index];
    } else parsed[key] = true;
  }
  return parsed;
}

function emptyChanges() {
  return {
    added: [],
    modified: [],
    deleted: [],
    possibleRenames: [],
    duplicateAdditions: [],
  };
}

function sortObject(value) {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function percentage(numerator, denominator) {
  return denominator ? Number(((numerator / denominator) * 100).toFixed(2)) : 0;
}

function printSummary(verb, report, kg) {
  const summary = report.summary;
  console.log(
    `${verb}: ${summary.ingestedFiles} file(s) ingested, ` +
      `${summary.appendedEvents} event(s) and ${summary.appendedRelations} relation(s) appended.`,
  );
  console.log(
    `KG total: ${kg.sources.length} sources, ${kg.events.length} events, ` +
      `${kg.entities.length} entities.`,
  );
  const pending =
    summary.modifiedFilesAwaitingReview +
    summary.deletedFilesAwaitingReview +
    summary.possibleRenamesAwaitingReview +
    summary.duplicateAdditionsAwaitingReview;
  if (pending) {
    console.log(
      `${pending} upstream change(s) were preserved for manual review; no existing record was changed or deleted.`,
    );
  }
}

function throwValidationError(issues) {
  const summary = issues
    .slice(0, 20)
    .map((issue) => `[${issue.level}] ${issue.path}: ${issue.message}`)
    .join("\n");
  throw new Error(
    `Incremental KG failed validation with ${issues.length} issue(s):\n${summary}`,
  );
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readRequiredJson(path, message) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(message);
    throw error;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
