# @corbits/artifacts

Artifacts, versions, and file uploads as a mountable module for any Interchange host. Backend only — this package ships no UI. `mountArtifacts` and `mountWorkflowArtifacts` add routes to a Hono app you already have; the host owns the app, the database pool, the session, and the grant store.

## Runtime support

Node >= 24 consumes built `dist/`. Bun loads TypeScript source via the `bun` export condition. Peer stack: `hono`, `hono-openapi`, `drizzle-orm`, `postgres`, `arktype`, `@intx/types`, `@intx/hub-api`, `@intx/agent` (minimum `@intx/*` **0.4.0**).

## Quickstart

```bash
npm add @corbits/artifacts
pnpm add @corbits/artifacts
yarn add @corbits/artifacts
bun add @corbits/artifacts
```

There are three surfaces a host wires up, in the order a hub typically mounts them.

### 1. Hub-side, tenant-scoped: `mountArtifacts`

Mounted under the hub's tenant prefix, alongside a host's other session-authenticated routes. It reads `principal`/`tenant` off the Hono context (placed there by the host's own auth + tenant middleware) and authorizes mutations through the host's `requireGrant` — built from Interchange's `createRequireGrant` over the host's own `GrantStore` and `ConditionRegistry`.

| `opts` | Type | What the host provides |
| --- | --- | --- |
| `db` | `ArtifactDb` | Artifacts are stored there. `createArtifactDb` opens a handle for a host with none; a hub that already has one passes it through. |
| `contentStore` | `ContentStore` | Blob storage for file bytes. `InlineContentStore` (exported by this package) fits a minimal host; bring your own store for object storage. |
| `requireGrant` | `RequireGrant` | The host's grant middleware factory. This package implements no ownership or membership policy of its own — every mutating single-artifact route is gated through it. |
| `countSegments` | `ArtifactCountSegments` (optional) | Named predicates over `ArtifactListRow` for `GET /artifacts/counts` (e.g. bucket by `kind`). The taxonomy is entirely host-owned; omitted, the route still answers with the tenant-wide `all` total. |
| `onArtifactCreated`, `decorate`, `uploadPolicy` | — (optional) | See [ARCHITECTURE.md](./ARCHITECTURE.md) for the grant-provisioning hook, the display-only row decorator, and the upload policy. |

```ts
import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { createRequireGrant } from "@intx/hub-api";
import type { ConditionRegistry, GrantStore } from "@intx/types/authz";
import {
  InlineContentStore,
  mountArtifacts,
  type ArtifactDb,
  type ArtifactCountSegments,
} from "@corbits/artifacts";

export function mountArtifactRoutes(
  app: Hono<TenantEnv>,
  deps: {
    db: ArtifactDb;
    grantStore: GrantStore;
    conditionRegistry: ConditionRegistry;
    countSegments?: ArtifactCountSegments;
  },
): void {
  mountArtifacts(app, {
    db: deps.db,
    contentStore: InlineContentStore,
    requireGrant: createRequireGrant({
      grantStore: deps.grantStore,
      conditionRegistry: deps.conditionRegistry,
    }),
    ...(deps.countSegments !== undefined ? { countSegments: deps.countSegments } : {}),
  });
}
```

### 2. Hub-side, run-scoped: `mountWorkflowArtifacts`

A parallel mount for a workflow run, which has no browser session — only a bearer token and an `x-workflow-run-address` header. Mount it at its own path (`/api/workflow-artifacts` by convention; see the sidecar bundle below) rather than under the tenant prefix. `resolveRunScope` is the host's existing sidecar-token → run lookup; `agentToken` is a second, optional auth path so a deployed agent can present the bearer the hub minted for its own definition instead of the sidecar's token.

| `opts` | Type | What the host provides |
| --- | --- | --- |
| `db`, `contentStore` | `ArtifactDb`, `ContentStore` | Same as above. |
| `resolveRunScope` | `WorkflowRunResolver` | `(bearerToken, runAddress) => ResolvedWorkflowRunScope \| null`. Returning `null` answers 401 — this package makes no assumption about how a host issues or verifies its sidecar tokens. |
| `agentToken` | `AgentTokenAuth` (optional) | `{ verify(ctx), resolveRun(runAddress) }`. `verify` returns `undefined` for "not an agent token" (the sidecar path is tried instead) and refuses a bearer whose tenant doesn't match the resolved run's. |
| `uploadPolicy`, `maxBinaryBytes`, `maxContentChars` | — (optional) | Per-run ceilings; see [ARCHITECTURE.md](./ARCHITECTURE.md). |

```ts
import type { Hono } from "hono";
import {
  InlineContentStore,
  mountWorkflowArtifacts,
  type ArtifactDb,
  type WorkflowArtifactEnv,
  type WorkflowRunResolver,
  type AgentTokenAuth,
} from "@corbits/artifacts";

export function mountWorkflowArtifactRoutes(
  app: Hono<WorkflowArtifactEnv>,
  deps: {
    db: ArtifactDb;
    resolveRunScope: WorkflowRunResolver;
    agentToken?: AgentTokenAuth;
  },
): void {
  mountWorkflowArtifacts(app, {
    db: deps.db,
    contentStore: InlineContentStore,
    resolveRunScope: deps.resolveRunScope,
    ...(deps.agentToken !== undefined ? { agentToken: deps.agentToken } : {}),
  });
}
```

A host with no `ArtifactDb` yet opens one with `createArtifactDb(DATABASE_URL)` and applies this package's migrations at boot with `runArtifactMigrations(db)`, before either mount runs.

### 3. Agent/tool side: `@corbits/artifacts/sidecar-bundle`

A deployed agent doesn't write its own artifact client — it imports the tool factory this package ships and adds it to its tool list. The factory resolves a `hub` credential from the runtime capabilities the host injects and calls the run-scoped routes above through it; it holds no database handle and no secret of its own.

```ts
import { defineAgent, type InferencePreference } from "@intx/agent";
import { artifacts } from "@corbits/artifacts/sidecar-bundle";

export function buildAssistant(sources: readonly InferencePreference[]) {
  return defineAgent({
    id: "assistant",
    systemPrompt: "You help the team read and write shared artifacts.",
    capabilities: [],
    inference: { sources },
    tools: [artifacts],
  });
}
```

The host binds the agent's `hub` credential handle when it deploys the definition; wiring that binding is a deploy-time concern outside this package.

## How it works

`mountArtifacts` registers tenant-session routes (list, import, upload, versions, download, archive) and authorizes through the host's `requireGrant`. `mountWorkflowArtifacts` is the parallel mount for run-scoped callers: a bearer plus run address, no browser session. `@corbits/artifacts/sidecar-bundle` is the agent-side tool factory that calls the run-scoped routes over a mediated, credential-scoped fetch. All three persist rows in Postgres and blobs through a pluggable `ContentStore` (`InlineContentStore` for a minimal host). App creation, pooling, and auth stay with the host.

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
bun run test             # unit + integration
bun run build            # dist/ (JS + .d.ts)
bun run test:acceptance  # builds, then examples/reference-host
```

Tests expect `postgres://postgres:postgres@localhost:5457/artifact_core` (override with `ARTIFACT_DATABASE_URL`). Destructive tests require `ALLOW_DESTRUCTIVE_ARTIFACT_TESTS=1` and an allowlisted database name (`artifact_core`, or any name ending in `_test`). See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

LGPL-2.1-only. See [LICENSE](./LICENSE).
