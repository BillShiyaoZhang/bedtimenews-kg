# 2026-10-03 dependency maintenance

This is a dependency-only maintenance change based on
`fb3691b7578ca4960de2e00f039e23bd48afddfe`. It preserves Node **22.23.2**,
all accepted-release receipts and audit storage, generated data, ontology and
extraction code, the pinned source gitlink, workflow permissions, and release
validation gates. It does not accept a new data release or deploy a site.

## Changes

- Next and eslint-config-next: 16.2.11 → 16.3.8
- React, React DOM, and react-server-dom-webpack: 19.2.6 → 19.2.8
- Cloudflare Vite plugin: 1.46.0 → 1.62.5; Wrangler: 4.113.0 → 4.147.0
- Existing PostCSS override: 8.5.10 → 8.5.28; Sharp override: 0.35.0 → 0.35.5
- A **vinext-scoped** image-size override, 2.0.2 → 2.0.3, fixes the
  [ICNS](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) and
  [HEIF/JXL](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq) parser issues
  while retaining vinext 0.0.50 and its required `imageSize` API
- Compatible lockfile refreshes for brace-expansion, browserslist, fast-uri,
  js-yaml, nanoid, baseline-browser-mapping, and fflate

Cloudflare's released plugin and Wrangler explicitly select
`miniflare@5.20261001.0-alpha` and `workerd@1.20261001.1`; this is an upstream
pairing, not an independently forced Miniflare major. The pairing resolves
`undici@7.29.1` and requires Node >=22, satisfied by the existing exact pin.
The transitive alpha remains a compatibility consideration for local Worker
development. No application runtime or deployment target is changed.

## Reproducible audit result

Raw npm JSON reports and `toolchain-and-integrity.json` are retained here.
The latter records Node/npm/ICU/locale, source/base commits, capture times,
and SHA-256 hashes of both manifests and audit files. npm audit is time-sensitive;
these are point-in-time results from npm 10.9.8 on Linux x64, not a permanent
claim that the packages have no vulnerabilities.

| Audit | Before | After |
| --- | --- | --- |
| All dependencies | 26: 4 moderate, 21 high, 1 critical | 8 high |
| `--omit=dev` | 5: 1 moderate, 3 high, 1 critical | 0 |

The remaining eight package entries all trace to the single unpatched
[braces stack-exhaustion advisory GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
As of the capture, `braces@3.0.3` is the latest release and the advisory lists no
patched version. The entries are braces, micromatch, fast-glob,
@next/eslint-plugin-next, eslint-config-next, vite-plugin-dynamic-import,
vite-plugin-commonjs, and vinext. Do not interpret these as eight independent
root vulnerabilities. Do not run `npm audit fix --force`: its proposed old
ESLint/Next tooling or vinext major changes are outside this scoped update.

The published application is a GitHub Pages static export with unoptimized
images. Its public site does not run a Next server, server actions, ImageResponse,
or an image-optimization endpoint. The remaining known braces exposure is in
build/lint tooling, where attacker-controlled deeply nested glob patterns can
terminate the Node process. Current reviewed build patterns are fixed project
inputs, but untrusted contributions/build inputs still warrant review. A zero
`--omit=dev` audit does **not** prove that all bundled code or build tooling is
free of vulnerabilities.

## Verification

Using Node 22.23.2, npm 10.9.8, TZ=UTC and en_US.UTF-8:

- Clean `npm ci` and `npm ls --all`: passed, no invalid/missing required peers
- `npm run kg:release:validate`: accepted receipt/output bindings passed
- `npm run kg:validate`: pinned raw-source fragments and semantic projection
  passed (1,764 entities; 9,652 events; 8,141 relations; 2,079 source pages)
- `npm test`: **553/553 passed**, including all 552 required tests and the
  required semantic coverage test, followed by both production builds
- `npm run test:coverage`: required coverage **100%**
- `npm run lint` and `tsc --noEmit`: passed
- Worker/vinext and Next static Pages builds: passed
- `vinext start` HTTP smoke: home, graph, ontology, a JavaScript asset, and
  the ontology RSC response returned 200 with the expected content types
- `git diff --check`: passed

The supplemental `vinext dev`/Miniflare live smoke could not start in this
cloud sandbox because Node's `os.networkInterfaces()` returned
`uv_interface_addresses: Unknown system error 1`. The approved retry produced
the same environment error. This is a verification limit, not a passing
Worker-runtime smoke; the production Node server and both build paths were
checked separately.

The unchanged-receipt exact-base PR gate is run against the final committed
branch and again in GitHub Actions. It validates the accepted rendering and
exact base; its `freshSourceReplay: false` must not be described as a fresh
migration replay. The separate raw-source validation above checks the existing
pinned archive. Final commit CI results belong to the draft PR.
