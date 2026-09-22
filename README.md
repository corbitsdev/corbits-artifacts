# @corbits/artifacts

Artifacts, versions, and file uploads as a mountable module for any Interchange host. Backend only — this package ships no UI. `mountArtifacts` adds routes to a Hono app you already have; the host owns the app, the database pool, and the session.

## Runtime support

Node >= 24 consumes built `dist/`. Bun loads TypeScript source via the `bun` export condition. Peer stack: `hono`, `hono-openapi`, `drizzle-orm`, `postgres`, `arktype`, `@intx/types`, `@intx/hub-api`, `@intx/agent` (minimum `@intx/*` **0.3.0**).

## Quickstart

```bash
npm add @corbits/artifacts
pnpm add @corbits/artifacts
yarn add @corbits/artifacts
bun add @corbits/artifacts
```

`mountArtifacts(api, opts)` adds the artifact routes to your app. Every field of `opts` is a host responsibility:

| `opts` | Type | What the host provides |
| --- | --- | --- |
| `db` | `ArtifactDb` | The host's existing drizzle/Postgres handle. Artifacts are stored there. |
| `contentStore` | `ContentStore` | Blob storage for file bytes. `InlineContentStore` fits a minimal host; bring your own store for object storage. |
| `requireGrant` | `RequireGrant` | The host's grant middleware factory (Interchange `createRequireGrant`). Mutating routes on a single artifact are guarded through it; this package implements no ownership or membership policy of its own. |
| `onArtifactCreated` | `(tx, row, scope) => Promise<void>` (optional) | Hook run inside the same transaction as artifact creation, once per row. Use it to provision whatever grants make the host's authorization model true (for example, a creator grant on the new row). Defaults to a no-op. |
| `decorate` | `(tenantId, rows) => Promise<void>` (optional) | Display-only decorator that may add fields to serialized rows. Defaults to a no-op. |
| `uploadPolicy` | `UploadPolicy` (optional) | Which files `POST /artifacts/upload` accepts. |

```ts
import { Hono } from "hono";
import { createRequireGrant, type TenantEnv } from "@intx/hub-api";
import {
  InlineContentStore,
  mountArtifacts,
  runArtifactMigrations,
} from "@corbits/artifacts";

await runArtifactMigrations(db);

const requireGrant = createRequireGrant({ grantStore, conditionRegistry });

const api = new Hono<TenantEnv>();
mountArtifacts(api, {
  db,
  contentStore: InlineContentStore,
  requireGrant,
});
app.route("/api", api);
```

`api` is a `Hono<TenantEnv>`. Host middleware places the Interchange `tenant` and `principal` on the context before these routes run.

`mountWorkflowArtifacts` is the parallel mount for workflow-run callers that carry a bearer token plus run address instead of a browser session:

```ts
import {
  InlineContentStore,
  mountWorkflowArtifacts,
  runArtifactMigrations,
} from "@corbits/artifacts";

await runArtifactMigrations(db);

mountWorkflowArtifacts(workflowApi, {
  db,
  contentStore: InlineContentStore,
  // Your existing sidecar/run authentication, wrapped to the scope shape.
  resolveRunScope: (bearerToken, runAddress) =>
    hostResolveWorkflowRun(bearerToken, runAddress),
});
app.route("/api/workflow-artifacts", workflowApi);
```

`resolveRunScope: (bearerToken, runAddress) => ResolvedWorkflowRunScope | null` authenticates the run caller the same way the host already authenticates its sidecar; this package trusts whatever it returns.

Agent tools live in `@corbits/artifacts/sidecar-bundle`.

## How it works

`mountArtifacts` registers tenant-session routes (list, import, upload, versions, download, archive) and authorizes through the host's `requireGrant`. `mountWorkflowArtifacts` is the parallel mount for sidecar/agent callers: a bearer plus run address, no browser session. Both persist rows in Postgres and blobs through a pluggable `ContentStore` (`InlineContentStore` for a minimal host). App creation, pooling, and auth stay with the host.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the data model and mount options.

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
