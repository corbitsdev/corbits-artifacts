# @corbits/artifacts

An artifact is a versioned document or file, stored in Postgres and served over HTTP to a tenant's users and to its workflow runs. This package adds those routes to an Interchange host's Hono app; the host owns the app, the database pool, the session, and the grant store. Backend only — it ships no UI.

## Quickstart

```bash
npm add @corbits/artifacts
```

Requires Node 24 or newer and `@intx/*` 0.4.0 or newer.

At boot, right after Interchange's `runMigrations`, apply this package's migrations with the same `config` and `schema`. The tables go in their own `artifacts` Postgres schema, with tenant and principal foreign keys pointing into `schema`. Then open a database handle for the routes; a host that already has a drizzle handle passes that instead of calling `createArtifactDb`.

```ts
import { runMigrations } from "@intx/db";
import { createArtifactDb, runArtifactMigrations } from "@corbits/artifacts";

// `config` is the host's `DBConfig` from `@intx/db`.
await runMigrations(config, { schema: "public" });
await runArtifactMigrations(config, { schema: "public" });

const { db, close } = createArtifactDb(process.env.DATABASE_URL!);

// on shutdown
await close();
```

### 1. Hub-side, tenant-scoped: `mountArtifacts`

Mounted under the hub's tenant prefix, alongside a host's other session-authenticated routes. It reads `principal`/`tenant` off the Hono context (placed there by the host's own auth + tenant middleware) and authorizes mutations through the host's `requireGrant` — built from Interchange's `createRequireGrant` over the host's own `GrantStore` and `ConditionRegistry`.

| `opts` | Type | What the host provides |
| --- | --- | --- |
| `db` | `ArtifactDb` | Artifacts are stored there. `createArtifactDb` opens a handle for a host with none; a hub that already has one passes it through. |
| `contentStore` | `ContentStore` | Blob storage for file bytes. `InlineContentStore` (exported by this package) fits a minimal host; bring your own store for object storage. |
| `requireGrant` | `RequireGrant` | The host's grant middleware factory. This package implements no ownership or membership policy of its own — every mutating single-artifact route is gated through it. |
| `countSegments` | `ArtifactCountSegments` (optional) | Named predicates over `ArtifactListRow` for `GET /artifacts/counts` (e.g. bucket by `kind`). The taxonomy is entirely host-owned; omitted, the route still answers with the tenant-wide `all` total. |
| `onArtifactCreated` | `(tx, row, scope) => Promise<void>` (optional) | Runs inside the transaction that creates each artifact. This is where the host mints grants for the new row, e.g. `write` and `archive` on `artifact:<id>` for its creator. The package mints none itself. |
| `decorate` | `(tenantId, rows) => Promise<void>` (optional) | Adds display-only fields to serialized rows on the way out (provenance labels, host joins). It must never change which rows are returned or who may see them. |
| `uploadPolicy` | `UploadPolicy` (optional) | Which MIME types `POST /artifacts/upload` accepts. Defaults to `ARTIFACT_UPLOAD_POLICY`. |

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

A parallel mount for a workflow run, which has no browser session — only a bearer token and an `x-workflow-run-address` header. Mount it at `/api/workflow-artifacts`, the path the sidecar bundle below calls, rather than under the tenant prefix. `resolveRunScope` is the host's existing sidecar-token → run lookup; `agentToken` is a second, optional auth path so a deployed agent can present the bearer the hub minted for its own definition instead of the sidecar's token.

| `opts` | Type | What the host provides |
| --- | --- | --- |
| `db`, `contentStore` | `ArtifactDb`, `ContentStore` | Same as above. |
| `resolveRunScope` | `WorkflowRunResolver` | `(bearerToken, runAddress) => ResolvedWorkflowRunScope \| null`. Returning `null` answers 401 — this package makes no assumption about how a host issues or verifies its sidecar tokens. |
| `agentToken` | `AgentTokenAuth` (optional) | `{ verify(ctx), resolveRun(runAddress) }`. `verify` returns `undefined` for "not an agent token" (the sidecar path is tried instead) and refuses a bearer whose tenant doesn't match the resolved run's. |
| `uploadPolicy` | `UploadPolicy` (optional) | Which MIME types `POST /artifacts/binary` accepts. Defaults to `ARTIFACT_UPLOAD_POLICY`. |
| `maxBinaryBytes` | `number` (optional) | Byte ceiling for `POST /artifacts/binary`. Defaults to `MAX_UPLOAD_BYTES`. |
| `maxContentChars` | `number` (optional) | Character ceiling for `content` on `POST /artifacts`. Defaults to 64,000. |

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

When the host deploys this agent definition, it must bind the agent's `hub` credential to the agent's hub token. The tools send every request through that credential, so without the binding they cannot reach the hub.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

LGPL-2.1-only. See [LICENSE](./LICENSE).
