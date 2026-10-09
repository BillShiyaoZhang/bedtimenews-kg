const must = (v) => { if (!v) throw new Error("Actions upload protocol rejected"); };
export function boundedUploadFailure(error) {
  return { state: "unknown", code: ["UNCERTAIN_MUTATION", "JOURNAL_ERROR", "IMMUTABLE_CONFLICT", "READBACK_MISMATCH", "HTTP_ERROR"].includes(error.code) ? error.code : "ADAPTER_REJECTED",
    ...([400, 401, 403, 404, 408, 422, 429, 500, 502, 503, 504].includes(error.requestStatus ?? error.status) ? { requestStatus: error.requestStatus ?? error.status } : {}),
    ...(["api.github.com", "uploads.github.com"].includes(error.requestHost) ? { requestHost: error.requestHost } : {}),
    ...(["GET", "POST"].includes(error.requestMethod) ? { requestMethod: error.requestMethod } : {}),
    ...(typeof error.githubRequestId === "string" && /^[A-Fa-f0-9]{1,16}(?::[A-Fa-f0-9]{1,16}){4}$/u.test(error.githubRequestId) ? { githubRequestId: error.githubRequestId } : {}) };
}

export function createObservedUploadTransport({ scope, fetchImpl = globalThis.fetch }) {
  let failure;
  const assertHealthy = () => { if (failure) throw failure; };
  const fetchObserved = async (url, options = {}) => {
    const target = new URL(url), method = options.method ?? "GET";
    if (method !== "POST") { must(["GET", "HEAD"].includes(method)); return fetchImpl(url, options); }
    assertHealthy();
    const name = target.searchParams.get("name");
    must(target.protocol === "https:" && target.hostname === "uploads.github.com" && !target.port
      && target.pathname === `/repos/${scope.repository}/releases/${scope.releaseId}/assets`
      && Object.entries(scope.files).some(([file, binding]) => name === `${binding.sha256}-${file}`));
    try {
      const response = await fetchImpl(url, options);
      const permittedManifestRace = response.status === 422 && name === `${scope.files["manifest.json"].sha256}-manifest.json`;
      if (!response.ok && !permittedManifestRace) {
        failure = Object.assign(new Error("Upload response requires operator review"), { code: "HTTP_ERROR", requestStatus: response.status,
          requestHost: target.hostname, requestMethod: method, githubRequestId: response.headers.get("x-github-request-id") });
      }
      return response;
    } catch {
      failure = Object.assign(new Error("Upload response uncertain"), { code: "UNCERTAIN_MUTATION", requestHost: target.hostname, requestMethod: method });
      throw failure;
    }
  };
  return { fetchImpl: fetchObserved, assertHealthy };
}

export async function runActionsAuditUpload({ scope, priorApproval, journal, bundleDir, checkFrozen, fence, createStore, assertHealthy = () => {} }) {
  const reservations = new Map();
  const allowed = new Set(Object.entries(scope.files).filter(([name]) => name !== "manifest.json").map(([name, binding]) => `kg-audit-${scope.bundleId}:upload:${binding.sha256}-${name}`));
  const store = createStore({ pendingOperations: journal.pendingOperations,
    onMutationIntent: async (operation) => {
      assertHealthy(); must(allowed.has(operation.operation)); await checkFrozen();
      const reservation = await fence.reserve(operation.operation.split(":upload:")[1]);
      reservations.set(operation.operation, { reservation, outcomeAttempted: false });
      await checkFrozen();
    },
    onMutationReconciled: async (operation) => {
      assertHealthy();
      if (operation.operation === priorApproval.operation) return;
      const saved = reservations.get(operation.operation); must(saved && !saved.outcomeAttempted);
      saved.outcomeAttempted = true;
      await saved.reservation.recordOutcome({ state: "verified-by-release-store", operation: operation.operation });
    },
  });
  const result = await store.recoverPendingUpload({ bundleDir, targetCommit: scope.proposalCommit, approval: priorApproval,
    reserveAttempt: async () => { await checkFrozen(); const reservation = await fence.reserve(priorApproval.asset.name); await checkFrozen(); return reservation; } });
  must(result.state === "verified");
  assertHealthy();
  await store.reconcilePending({ bundleDir, targetCommit: scope.proposalCommit });
  await checkFrozen();
  try {
    const receipt = await store.stageBundle({ bundleDir, targetCommit: scope.proposalCommit });
    assertHealthy();
    await checkFrozen();
    must(receipt.releaseId === scope.releaseId && receipt.readbackVerified && receipt.visibilityAtReadback === "draft");
    return receipt;
  } catch (error) {
    try { assertHealthy(); } catch (observed) { error = observed; }
    for (const [operation, saved] of reservations) {
      if (saved.outcomeAttempted) continue;
      saved.outcomeAttempted = true;
      await saved.reservation.recordOutcome({ ...boundedUploadFailure(error), operation });
    }
    throw error;
  }
}
