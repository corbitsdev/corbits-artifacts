# @corbits/artifacts

[![npm](https://img.shields.io/npm/v/@corbits/artifacts.svg)](https://www.npmjs.com/package/@corbits/artifacts) [![License: LGPL-2.1](https://img.shields.io/badge/license-LGPL--2.1-green.svg)](https://github.com/corbitsdev/corbits-artifacts/blob/main/LICENSE)

Versioned documents and files for Interchange agents and their users: a Corbits hub module that mounts grant-gated Hono routes on `@intx/hub-api`, keeps versions in Postgres and bytes in a pluggable `ContentStore`, and ships agent tools for the sidecar.

## Why @corbits/artifacts?

1. **Every version is kept.** Each revision of a document or uploaded file is a new version with its own content, bytes and SHA-256 digest. `expectedVersion` turns a revise into a compare-and-set.
2. **Mounts like any hub route.** `createArtifactRoutes` returns a `Hono<TenantEnv>` sub-app. Reads are confined to the caller's tenant, and writes run through the hub's `requireGrant`.
3. **Agents write through the same store.** A run-scoped route set and a sidecar tool pack let a workflow run create, read and revise the artifacts its users see.
4. **Migrations that replay safely.** Every SQL file is idempotent and runs on every boot under an advisory lock, so several replicas can start at once.

It ships no UI and no object store: the host renders artifacts and brings its own `ContentStore` for large files.

## Install

```bash
npm add @corbits/artifacts \
  @intx/db @intx/hub-api @intx/types drizzle-orm hono hono-openapi postgres
```

Add `@intx/agent` only if an agent uses the sidecar tools. Runs on Node >= 24.

## Quickstart

```ts
import { createDB, type DBConfig } from "@intx/db";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import type { Hono } from "hono";
import {
  createArtifactRoutes,
  InlineContentStore,
  runArtifactMigrations,
} from "@corbits/artifacts";

declare const app: Hono<TenantEnv>;
declare const dbConfig: DBConfig;
declare const requireGrant: RequireGrant;

await runArtifactMigrations(dbConfig, { schema: "public" });
const { db, close } = createDB(dbConfig);

app.route(
  "/api",
  createArtifactRoutes({ db, contentStore: InlineContentStore, requireGrant }),
);

process.once("SIGTERM", close);
```

A principal with `create` on `artifact:*` can now `POST /api/artifacts` with `{ "kind": "document", "title": "Notes", "content": "Hello" }`, and `GET /api/artifacts` returns it.

## Where it fits

[Interchange](https://github.com/faremeter/interchange) runs AI agents as principals: accounts with their own identity, permissions and credentials. Its hub is the multi-tenant control plane that holds tenants, principals and grants (permissions a principal holds on a resource); its sidecar is the agent runtime.

- **Runs in:** the hub, as routes on its Hono app and tables in its Postgres (`artifacts` schema).
- **Plugs into:** [`@intx/hub-api`](https://github.com/faremeter/interchange/tree/main/packages/hub-api) routes and grants, [`@intx/db`](https://github.com/faremeter/interchange/tree/main/packages/db) (its `DBConfig`, and its `tenant` and `principal` tables as FK targets), and [`@intx/agent`](https://github.com/faremeter/interchange/tree/main/packages/agent) tools on the sidecar.
- **Pairs with:** [`@corbits/mailbox`](https://github.com/corbitsdev/corbits-mailbox) and [`@corbits/memory`](https://github.com/corbitsdev/corbits-memory), the other Corbits hub modules, and [`@corbits/agent-token`](https://github.com/corbitsdev/corbits-agent-token) for agent bearer tokens.

## Reference

### `createArtifactRoutes(deps)`

| `deps`              | Type                                | What the host provides                                                                                               |
| ------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `db`                | `ArtifactDb`                        | The hub's drizzle handle, for example from `createDB`.                                                               |
| `contentStore`      | `ContentStore`                      | Where file bytes go. `InlineContentStore` keeps them in Postgres; implement the port for object storage.             |
| `requireGrant`      | `RequireGrant`                      | From `@intx/hub-api`'s `createRequireGrant`.                                                                         |
| `onArtifactCreated` | `(tx, row, scope) => Promise<void>` | Optional. Runs in the creating transaction; mint the creator's `write` and `archive` grants on `artifact:<id>` here. |
| `decorate`          | `(tenantId, rows) => Promise<void>` | Optional. Adds display-only fields to serialized rows. It must not change which rows are returned.                   |
| `uploadPolicy`      | `UploadPolicy`                      | Optional. MIME types `POST /artifacts/upload` accepts. Defaults to `ARTIFACT_UPLOAD_POLICY`.                         |
| `countSegments`     | `ArtifactCountSegments`             | Optional. Named predicates for `GET /artifacts/counts`.                                                              |

| Route                                      | Grant                        | Does                                                                  |
| ------------------------------------------ | ---------------------------- | --------------------------------------------------------------------- |
| `GET /artifacts`                           | none (tenant-scoped)         | Lists artifacts, paginated. Empty `200` with no principal.            |
| `GET /artifacts/counts`                    | none (tenant-scoped)         | Counts per `countSegments` bucket, plus `all`.                        |
| `POST /artifacts`                          | `create` on `artifact:*`     | Creates a text or URL artifact at version 1.                          |
| `POST /artifacts/upload`                   | `create` on `artifact:*`     | Uploads one or more files (`multipart/form-data`), one artifact each. |
| `GET /artifacts/:id`                       | none (tenant-scoped)         | The latest version.                                                   |
| `GET /artifacts/:id/versions`              | none (tenant-scoped)         | Version history.                                                      |
| `GET /artifacts/:id/versions/:version`     | none (tenant-scoped)         | One version, with its content.                                        |
| `POST /artifacts/:id/versions`             | `write` on `artifact:<id>`   | Adds a version from JSON, or from a new `file` for an uploaded file.  |
| `POST /artifacts/:id/archive`, `unarchive` | `archive` on `artifact:<id>` | Archives or restores.                                                 |
| `GET /artifacts/:id/download?version=N`    | none (tenant-scoped)         | The bytes of a version, latest by default.                            |
| `GET /artifacts/:id/preview`               | none (tenant-scoped)         | A `text/html` artifact under a sandboxing CSP; `415` otherwise.       |

With no principal, every route except the list and counts answers `403`. Another tenant's artifact, or an unknown id, answers `404`. Set a request-body limit on the host for the upload and file-revise routes; they buffer the body before checking `MAX_UPLOAD_BYTES`.

### `createWorkflowArtifactRoutes(deps)`

Run-scoped routes for a workflow run, which authenticates with a bearer token and an `x-workflow-run-address` header instead of a session.

| `deps`            | Type                  | What the host provides                                                                       |
| ----------------- | --------------------- | -------------------------------------------------------------------------------------------- |
| `db`              | `ArtifactDb`          | Same as above.                                                                               |
| `contentStore`    | `ContentStore`        | Same as above.                                                                               |
| `resolveRunScope` | `WorkflowRunResolver` | `(bearerToken, runAddress) => ResolvedWorkflowRunScope \| null`. `null` answers `401`.       |
| `agentToken`      | `AgentTokenAuth`      | Optional. Accepts an agent's own hub token as a second way in.                               |
| `uploadPolicy`    | `UploadPolicy`        | Optional. MIME types `POST /artifacts/binary` accepts. Defaults to `ARTIFACT_UPLOAD_POLICY`. |
| `maxBinaryBytes`  | `number`              | Optional. Byte ceiling for `POST /artifacts/binary`. Defaults to `MAX_UPLOAD_BYTES`.         |
| `maxContentChars` | `number`              | Optional. Character ceiling for `content` on `POST /artifacts`. Defaults to 64,000.          |

### `runArtifactMigrations(config, { schema })`

Takes the same `DBConfig` and `schema` as Interchange's `runMigrations`. `schema` holds the host's `tenant` and `principal` tables; this package's tables always go in `artifacts`.

### `@corbits/artifacts/sidecar-bundle`

`artifacts` is an `@intx/agent` tool pack: `artifact_create`, `artifact_write`, `artifact_read`, `artifact_read_chunk`, `artifact_list`, `artifact_find_by_title` and `artifact_link_file`. They call the run-scoped routes through the agent's `hub` credential.

## Using with Interchange

Run the migrations after Interchange's, mount both route sets, grant `create` on `artifact:*` to principals that create artifacts, and give agents the tool pack.

```ts
import { runMigrations, type DBConfig } from "@intx/db";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import type { Hono } from "hono";
import {
  createArtifactRoutes,
  createWorkflowArtifactRoutes,
  InlineContentStore,
  runArtifactMigrations,
  type ArtifactDb,
  type WorkflowRunResolver,
} from "@corbits/artifacts";

declare const app: Hono<TenantEnv>;
declare const dbConfig: DBConfig;
declare const db: ArtifactDb;
declare const requireGrant: RequireGrant;
declare const resolveRunScope: WorkflowRunResolver;

await runMigrations(dbConfig, { schema: "public" });
await runArtifactMigrations(dbConfig, { schema: "public" });

const contentStore = InlineContentStore;
app.route("/api", createArtifactRoutes({ db, contentStore, requireGrant }));
app.route(
  "/api/workflow-artifacts",
  createWorkflowArtifactRoutes({ db, contentStore, resolveRunScope }),
);
```

The sidecar tools call `/api/workflow-artifacts`. Add them to an agent and bind its `hub` credential to the agent's hub token when you deploy it:

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

## Upgrading from 0.1

- `mountArtifacts(app, opts)` is now `createArtifactRoutes(deps)`, and `mountWorkflowArtifacts(app, opts)` is now `createWorkflowArtifactRoutes(deps)`. Mount both with `app.route`.
- `POST /artifacts` and `POST /artifacts/upload` need `create` on `artifact:*`. Grant it to existing principals before upgrading, or they get `403`.
- `runArtifactMigrations(db)` is now `runArtifactMigrations(dbConfig, { schema })`. Existing 0.1.0 data upgrades in place on the first boot.
- That boot drops the 0.1.0 migration ledger. You cannot roll back to 0.1.0, and 0.1.0 and 0.2.0 replicas must not share a database.
- The drizzle tables, the `web_site` helpers, `SKILL_DRAFT_KIND`, `windowContent` and the mail-attachment routes and helpers are removed. The `mail_attachment_ref` table is dropped.
- Node 24 or newer is required.

See the [changelog](https://github.com/corbitsdev/corbits-artifacts/blob/main/CHANGELOG.md) for the full list.

## License

[LGPL-2.1-only](https://github.com/corbitsdev/corbits-artifacts/blob/main/LICENSE)
