# 2026-10-22 Next.js security maintenance

Based on accepted main `6e17b9d5ac25846e267df08f80e593451fba1590`.
Next.js and eslint-config-next move from 16.3.8 to **16.4.1**, with matching
@next/env, @next/eslint-plugin-next and platform SWC packages. No unrelated
package versions change. npm's unrelated peer-metadata churn was omitted.
The existing sharp 0.35.5 override and Node 22.23.2 pin remain unchanged.

## Attribution and exposure

The installed-tree audit reports one critical **package entry**, `next`, with
three direct advisories, all affecting `>=16.0.0 <=16.4.0` and fixed in 16.4.1:

- Critical [GHSA-673q-mjm6-r5xr](https://github.com/advisories/GHSA-673q-mjm6-r5xr):
  RCE in App Router Cache Components with `use cache` functions returning multiple
  typed arrays. Neither `cacheComponents` nor `use cache` occurs in application
  code/configuration.
- Critical [GHSA-2464-fhr4-w9xw](https://github.com/advisories/GHSA-2464-fhr4-w9xw):
  upstream image-processing RCE involving SVG on glibc Linux. Image optimization
  is disabled (`images.unoptimized: true`); the installed sharp 0.35.5 already
  meets the advisory's documented workaround.
- High [GHSA-p3m5-59mp-jv5r](https://github.com/advisories/GHSA-p3m5-59mp-jv5r):
  CPU denial of service in App Router applications with a Server Action.
  No `use server` directive occurs in application code.

[The 16.4.1 release](https://github.com/vercel/next.js/releases/tag/v16.4.1)
identifies these three security fixes. Pages builds use Next's static export,
so production Pages has no Next request server; the Worker build uses vinext.
These repository observations do not establish exploitable exposure and do not
claim proof of deployed runtime configuration. Upgrade removes the vulnerable
Next version despite the absent attack prerequisites.

## Audit evidence

All four JSON reports were captured on 2026-10-22 using Node 22.23.2 and npm
10.9.8, after clean installs of the exact base and proposed lockfiles. The base
install was isolated under `/tmp`; it did not modify the proposed checkout.

| Installed-tree audit | Before | After |
| --- | --- | --- |
| All dependencies | 9 high, 1 critical | 9 high |
| `--omit=dev` | 1 critical | 0 |

The three Next advisories disappear. Remaining high package entries are
`braces`, `micromatch`, `fast-glob`, `@next/eslint-plugin-next`,
`eslint-config-next`, `vite-plugin-dynamic-import`, `vite-plugin-commonjs`,
`vinext`, and `vite`. These are not nine independent high advisories:

- Eight entries trace to [braces GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
- Vite 8.1.5 has five direct advisory records: GHSA-698v-4r3x-3vcv (moderate),
  GHSA-r825-w8mm-5pxw (moderate), GHSA-587h-7wmj-h5pm (high),
  GHSA-9jrq-w75r-8gcw (low), and GHSA-rq7h-c2jc-7f22 (moderate).

Vite and braces are unchanged and need separate triage. No forced audit fix
was used. The initial audit before installing node_modules reported 10 high,
1 critical and 5 low entries; the clean installed-tree comparison above avoids
mistaking npm's different transitive attribution for additional remediation.
Audit reports are point-in-time registry observations.

## Release boundaries

No accepted data, receipts, semantic-generator files, source gitlink, Node
runtime, workflow, permissions or release storage changes. This dependency
repair requires no semantic/runtime migration. The unchanged-receipt PR gate
must still pass against exact current main, and does not claim fresh replay.
No release acceptance, merge, deployment or publication is part of this repair.

## Validation

Local and final-commit Actions results are recorded in the draft PR. Commands
follow `.github/workflows/validate.yml`: accepted-release and exact-base PR
validation, required tests, advisory coverage, lint, Worker build and Pages
build. Clean install, `npm ls --all`, TypeScript and diff checks supplement them.
The initial install failed because the environment's default npm cache path
was unavailable; using a writable cache under `/tmp` resolved it without a
repository change or integrity bypass.
