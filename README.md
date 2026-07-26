# corbits-artifacts

Home of **[`@corbits/artifact-core`](./packages/artifact-core)** — artifacts, versions
and file uploads, mountable onto any Hono host on a shared or a separate database, with
a pluggable `ContentStore` for where the bytes live. Backend only; this package ships
no UI.

See the [package README](./packages/artifact-core/README.md) for install, the mount
snippet and the seams, and [ARCHITECTURE.md](./ARCHITECTURE.md) for the data model.

## Layout

| | |
| --- | --- |
| `packages/artifact-core` | The published package. Owns `artifact`, `artifact_version`, `upload` and `mail_attachment_ref`. |
| `examples/reference-host` | Mounts it on a real `@intx/hub-api` app against a live Postgres and asserts the acceptance scenarios end to end. |

## Working on it

```sh
bun install
docker run -d --name corbits-artifact-pg -p 5457:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=artifact_core postgres:16

bun run test:package     # dep-guard, then unit + integration
bun run build            # dist/ (JS + .d.ts)
bun run test:acceptance  # builds, then the acceptance scenarios
bun run test             # both suites
```

`test:acceptance` builds first because the reference host consumes the built `dist` the
way a real consumer would — running it against stale output is how a green acceptance
run stops meaning anything.

Tests and the example expect
`postgres://postgres:postgres@localhost:5457/artifact_core`; override with
`ARTIFACT_DATABASE_URL`.

## Conventions

Strict TypeScript, arktype at boundaries, drizzle for data access. The migration ledger
is namespaced (`corbits_artifact_core_migrations`) so sibling cores never share one.
Dependencies come from public `@intx/*` on npm only — a dep-guard script fails the build
on an import of any unpublished scope, on `@intx/db`, or on a host workflow table.

## License

LGPL-2.1-only. See [LICENSE](./LICENSE).
