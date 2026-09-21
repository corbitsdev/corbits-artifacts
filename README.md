# @corbits/artifacts

Artifacts, versions, and file uploads as a mountable module for any Interchange host. Backend only — this package ships no UI. `mountArtifacts` adds routes to a Hono app you already have; the host owns the app, the pool, and the session.

## Runtime support

Node >= 24 consumes built `dist/`. Bun loads TypeScript source via the `bun` export condition. Peer stack: `hono`, `hono-openapi`, `drizzle-orm`, `postgres`, `arktype`, `@intx/types`, `@intx/hub-api`, `@intx/agent` (minimum `@intx/*` **0.3.0**).

## Quickstart

```bash
npm add @corbits/artifacts
pnpm add @corbits/artifacts
yarn add @corbits/artifacts
bun add @corbits/artifacts
```

```ts
import {
  InlineContentStore,
  mountArtifacts,
  runArtifactMigrations,
} from "@corbits/artifacts";

await runArtifactMigrations(hub.db);
mountArtifacts(api, {
  db: hub.db,
  contentStore: InlineContentStore,
  requireGrant,
});
```

`api` is a `Hono<TenantEnv>`. Host middleware must place Interchange `tenant` and `principal` on the context before these routes run.

```ts
import { Hono } from "hono";
import { createRequireGrant, type TenantEnv } from "@intx/hub-api";
import {
  InlineContentStore,
  mountArtifacts,
  mountWorkflowArtifacts,
  runArtifactMigrations,
} from "@corbits/artifacts";

await runArtifactMigrations(hub.db);

const requireGrant = createRequireGrant({ grantStore, conditionRegistry });

const api = new Hono<TenantEnv>();
mountArtifacts(api, {
  db: hub.db,
  contentStore: InlineContentStore,
  requireGrant,
});
app.route("/api", api);

const workflowApi = new Hono();
mountWorkflowArtifacts(workflowApi, {
  db: hub.db,
  contentStore: InlineContentStore,
  resolveRunScope: (bearerToken, runAddress) =>
    hub.resolveWorkflowRun(bearerToken, runAddress),
});
app.route("/api/workflow-artifacts", workflowApi);
```

Agent tools live in `@corbits/artifacts/sidecar-bundle`. `examples/reference-host` is a complete `@intx/hub-api` host with this module mounted.

## How it works

`mountArtifacts` registers tenant-session routes (list, import, upload, versions, download, archive) and authorizes through the host's `requireGrant`. `mountWorkflowArtifacts` is the parallel mount for sidecar/agent callers: a bearer plus run address, no browser session. Both persist rows in Postgres and blobs through a pluggable `ContentStore` (`InlineContentStore` for a minimal host). The host never shares app creation, pooling, or auth with this package.

See [PRODUCT.md](./PRODUCT.md) for intent, [ARCHITECTURE.md](./ARCHITECTURE.md)
for the data model and mount options, and
[IMPLEMENTATION.md](./IMPLEMENTATION.md) for routes, headers, and ceilings.

## Development

```sh
git clone https://github.com/corbitsdev/corbits-artifacts.git
cd corbits-artifacts
bun install
docker run -d --name corbits-artifact-pg -p 5457:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=artifact_core postgres:16
export ALLOW_DESTRUCTIVE_ARTIFACT_TESTS=1

bun run typecheck
bun run test             # pretest dependency check, then unit + integration
bun run build            # dist/ (JS + .d.ts)
bun run test:acceptance  # builds, then examples/reference-host
```

Tests expect `postgres://postgres:postgres@localhost:5457/artifact_core` (override with `ARTIFACT_DATABASE_URL`). Destructive tests require `ALLOW_DESTRUCTIVE_ARTIFACT_TESTS=1` and an allowlisted database name (`artifact_core`, or any name ending in `_test`). See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

LGPL-2.1-only. See [LICENSE](./LICENSE).
