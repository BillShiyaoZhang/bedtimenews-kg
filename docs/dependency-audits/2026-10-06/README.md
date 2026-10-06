# 2026-10-06 source-map-js maintenance

This narrowly scoped dependency repair is based on
`3e19ce9797ccdcb313c2bf54634323ef5015e7d0`. The only dependency change is
the lockfile entry for **source-map-js 1.2.1 → 1.2.2**: version, registry
tarball URL, and integrity. Both existing parents, PostCSS 8.5.28 and
@tailwindcss/node 4.2.1, already accept `^1.2.1`; no override or manifest
change is needed. No other package is updated.

The fix addresses the high-severity
[GHSA-68fv-2mgg-jv7q / CVE-2026-93749](https://github.com/advisories/GHSA-68fv-2mgg-jv7q),
reviewed by GitHub on October 5. The affected range is `>=1.0.0 <1.2.2`.
[Upstream 1.2.2](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2)
validates indexed-map section offsets and accumulated nested offsets,
uses flat serialization for generated line gaps, and stops SourceNode's
line loop when the generated code is exhausted.

## Audit evidence

All four raw npm JSON reports and `toolchain-and-integrity.json` are retained
here. The metadata records capture times, exit codes, Node/npm/ICU/locale,
base and source commits, and SHA-256 hashes of manifests and reports. The
official Node 22.23.2 Linux x64 archive was checked against its published
SHA-256 checksum; its bundled npm is 10.9.8, matching the prior audit.

| Audit | Before | After |
| --- | --- | --- |
| All dependencies | 9 high | 8 high |
| `--omit=dev` | 1 high | 0 |

The new source-map-js finding disappears from both audits. The two after
reports are byte-identical to the corresponding October 3 after reports.
The remaining eight package entries still trace to the single unpatched
[braces advisory GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm),
with the same dependency paths and proposed fixes. They are not eight
independent root vulnerabilities. No `npm audit fix --force` was used.
Audit results are point-in-time registry observations, not a permanent
claim that dependencies are vulnerability-free.

The application remains a GitHub Pages static export. Production-classified
PostCSS makes source-map-js appear in `--omit=dev`; that classification alone
does not imply a public server endpoint accepting source maps. A zero
production audit does not cover every risk in bundled code or build inputs.

## Preservation and verification

Node 22.23.2, all accepted-release receipts and audit storage, generated data,
ontology and extraction inputs/code, the pinned source gitlink, workflow
permissions, and release validation gates remain unchanged. No new data
release is accepted by this repair.

Verification uses Node 22.23.2, npm 10.9.8, TZ=UTC and en_US.UTF-8:

- Clean `npm ci` and `npm ls --all`: passed, no invalid or missing required
  dependencies
- `npm run kg:validate`: passed against the pinned raw archive, with 1,764
  entities, 9,652 events, 8,141 relations and 2,079 source pages
- `npm test`: accepted-release validation, **553/553 tests**, and the
  Worker/vinext production build passed; the initial Pages build was
  interrupted as described below
- `CIRCLE_NODE_TOTAL=2 npm run build:pages`: passed using one static-export
  worker, with unchanged project configuration
- `npm run test:coverage`: required semantic coverage **100%**
- `npm run lint`, `tsc --noEmit`, and `git diff --check`: passed
- `vinext start` HTTP smoke: home, graph, ontology, a JavaScript asset, and
  the ontology RSC response returned 200 with the expected content types
- Supplemental bounded smoke: 12 source-map-js assertions passed for invalid
  and excessive offsets, nested-offset amplification, normal mapping, large
  line-gap serialization, and exhausted-code SourceNode handling

The initial aggregate `npm test` exited nonzero because a Next static-export
worker received SIGKILL during the six-worker Pages build. The unchanged build
passed on retry with Next's existing `CIRCLE_NODE_TOTAL=2` concurrency control,
which selects one worker. This is consistent with local resource pressure;
the exact cause of SIGKILL was not established. No configuration, workflow or
dependency workaround was committed. The ordinary unmodified Pages-build
command must also pass in final-commit CI.

The exact-base PR gate must run against the final committed branch and again
in Actions. Its unchanged-receipt result has `freshSourceReplay: false`; it
must not be described as a fresh migration replay. The separate raw-source
validation above checks the existing pinned archive. Final validation and CI
results are recorded on the PR.
