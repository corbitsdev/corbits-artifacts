# corbits-artifacts

Home of **[`@corbits/artifacts`](./packages/artifacts)** — artifacts, versions
and file uploads, mountable onto any Hono host on a shared or a separate database, with
a pluggable `ContentStore` for where the bytes live. Backend only; this package ships
no UI.

See the [package README](./packages/artifacts/README.md) for install, the mount
snippet and the mount options, and [ARCHITECTURE.md](./ARCHITECTURE.md) for the data model.

## Layout

| | |
| --- | --- |
| `packages/artifacts` | The published package. Owns `artifact`, `artifact_version`, `upload` and `mail_attachment_ref`. |
| `examples/reference-host` | Mounts it on a real `@intx/hub-api` app against a live Postgres and asserts the acceptance scenarios end to end. |

## Working on it

```sh
bun install
docker run -d --name corbits-artifact-pg -p 5457:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=artifact_core postgres:16

# The package suite TRUNCATEs tables and some migration tests DROP SCHEMA.
# Both refuse unless you opt in and the database name is allowlisted.
export ALLOW_DESTRUCTIVE_ARTIFACT_TESTS=1

bun run test:package     # dependency check, then unit + integration
bun run build            # dist/ (JS + .d.ts)
bun run test:acceptance  # builds, then the acceptance scenarios
bun run test             # both suites
```

`test:acceptance` builds first because the reference host consumes the built `dist` the
way a real consumer would — running it against stale output is how a green acceptance
run stops meaning anything.

Tests and the example expect
`postgres://postgres:postgres@localhost:5457/artifact_core`; override with
`ARTIFACT_DATABASE_URL`. Destructive package tests additionally require
`ALLOW_DESTRUCTIVE_ARTIFACT_TESTS=1` and an allowlisted database name
(`artifact_core`, or any name ending in `_test`). See the package README Development
section for the full gate contract.

## Conventions

Strict TypeScript, arktype at boundaries, drizzle for data access. The package owns
the `artifacts` Postgres schema — all four tables and the migration
ledger live there, so sibling cores and host tables never collide.
No `@workbench/*` imports anywhere — `scripts/check-deps.ts` fails the build on any
import of that unpublished scope (it runs in `pretest` and CI).

## License

LGPL-2.1-only. See [LICENSE](./LICENSE).
