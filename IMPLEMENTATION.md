# @corbits/artifacts — Implementation

## Package

- Name: `@corbits/artifacts` `0.2.1`
- License: LGPL-2.1-only
- Node >= 24 consumes built `dist/` (`main` / default export).
- Bun loads TypeScript source via the `bun` export condition (`./src/index.ts`).
- These design docs live at the repository root. The npm tarball currently
  ships `dist/`, `src/` (tests excluded), `README.md`, and `LICENSE`.

## Runtime and peers

Minimum `@intx/*` **0.3.0**. Peer stack (must resolve to the host's copy):

`hono`, `hono-openapi`, `drizzle-orm`, `postgres`, `arktype`, `@intx/types`,
`@intx/hub-api`, `@intx/agent`.

Direct dependency: `@hono/standard-validator`. Postgres 13+ (`gen_random_uuid()`).

## Install

```sh
npm add @corbits/artifacts
pnpm add @corbits/artifacts
yarn add @corbits/artifacts
bun add @corbits/artifacts
```

## Public surface

From `@corbits/artifacts`:

- `runArtifactMigrations(db)` — idempotent boot DDL into schema `artifacts`.
- `mountArtifacts(app, opts)` — tenant-session routes on `Hono<TenantEnv>`.
- `mountWorkflowArtifacts(app, opts)` — run-scoped routes on
  `Hono<WorkflowArtifactEnv>`.
- `InlineContentStore`, `DataUrlContentStore`, and the `ContentStore` type.
- Domain helpers (`createArtifact`, `createFileArtifact`, list/get/archive,
  tools, web-site, mail-attachment refs) for hosts that call the store without
  HTTP.

From `@corbits/artifacts/sidecar-bundle`:

- `defineTool` factory pinned by an agent definition. Declares
  `requires: ["capabilities", "address"]`.
- `WORKFLOW_ARTIFACTS_BASE_PATH` — `"/api/workflow-artifacts"`. The bundle has
  no mount options; a host that wants the bundle to hit this package must
  nest `mountWorkflowArtifacts` under that prefix.

## `mountArtifacts`

Required opts: `db`, `contentStore`, `requireGrant`. Optional: `decorate`
(display-only, default no-op), `onArtifactCreated` (same transaction as
create, default no-op), `uploadPolicy` (default `ARTIFACT_UPLOAD_POLICY`),
`countSegments` (default `{}`).

Host middleware must place Interchange `tenant` and `principal` on the
context. No principal: collection reads answer empty 200; detail and
mutations answer 403.

Convention: nest the app at `/api` so paths match Interchange (`/api/me`,
`/api/tenants`). Routes are registered root-relative; the core takes no base
path.

| Method | Path | Role |
| --- | --- | --- |
| GET | `/artifacts` | List (keyset) |
| POST | `/artifacts` | Import `link` or `document` |
| POST | `/artifacts/upload` | Eager file artifact |
| GET | `/artifacts/counts` | Segment tallies |
| GET | `/artifacts/:id` | Detail |
| GET | `/artifacts/:id/preview` | Preview headers/body |
| GET | `/artifacts/:id/versions` | Version list |
| GET | `/artifacts/:id/versions/:version` | Pinned version |
| POST | `/artifacts/:id/versions` | Revise |
| POST | `/artifacts/:id/archive` | Soft hide |
| POST | `/artifacts/:id/unarchive` | Restore |
| GET | `/artifacts/:id/download` | Bytes |
| POST | `/instances/:instanceId/mail-attachments` | Save refs |
| GET | `/instances/:instanceId/mail-attachments` | List refs |

Single-artifact mutations authorize with
`requireGrant(idResource("artifact", "id"), <action>)`. Trust-boundary bodies
are arktype. Text bodies over `MAX_ARTIFACT_CONTENT_BYTES` (15 MiB) are 413.
A file over `MAX_UPLOAD_BYTES` (10 MiB) is 413; a refused MIME is 415.

## `mountWorkflowArtifacts`

Required opts: `db`, `contentStore`, `resolveRunScope`. Optional: `agentToken`
(tried before the sidecar path), `uploadPolicy`, `maxBinaryBytes` (default
`MAX_UPLOAD_BYTES`), `maxContentChars` (default `64_000`).

Every route runs behind bearer middleware. There is no unauthenticated
collection-read case.

Authentication:

- `Authorization: Bearer <token>`
- `x-workflow-run-address: <run address>`

`resolveRunScope(bearerToken, runAddress)` returns
`{ tenantId, principalId, runId }` or `null` (401). When `agentToken` is
set, `verify` then `resolveRun` run first. A token whose tenant is not the
resolved run's tenant is the same bare 401 as a missing run — no existence
oracle.

Create/revise stamp `source: { origin: "workflow", runId }` and `generatedBy`
from the resolved scope. A body field of either name is never read.
`ownerPrincipalId` is `null` on workflow creates.

| Method | Path | Role |
| --- | --- | --- |
| POST | `/artifacts` | Create text |
| POST | `/artifacts/binary` | Base64 file bytes |
| POST | `/artifacts/link-file` | Link a path |
| GET | `/artifacts` | List (`kind` / `limit`) |
| GET | `/artifacts/recent` | Recent (default 10, max 50) |
| GET | `/artifacts/find` | Exact title (`title` required) |
| PATCH | `/artifacts/:id` | Revise |
| GET | `/artifacts/:id` | Read-back |
| GET | `/artifacts/:id/read` | Budgeted tool read |
| GET | `/artifacts/:id/chunk` | Windowed tool read |

Together these cover `ARTIFACT_TOOL_DEFINITIONS`. A missing row, another
tenant's row, or `skill-draft` is 404 on detail/revise, same as
`mountArtifacts`. Text over `maxContentChars` and binary over
`maxBinaryBytes` are 413.

Per-run rate limiting is not implemented here. Wrap `resolveRunScope` or the
mounted app.

## Persistence

Schema `artifacts`: tables `artifact`, `artifact_version`, `upload`,
`mail_attachment_ref`, plus ledger `artifacts.migrations`. Hard FKs into
`public.tenant` and `public.principal`. `ContentStore.put` runs inside the
caller's transaction.

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

Tests expect `postgres://postgres:postgres@localhost:5457/artifact_core`
(override with `ARTIFACT_DATABASE_URL`). Destructive tests require
`ALLOW_DESTRUCTIVE_ARTIFACT_TESTS=1` and an allowlisted database name
(`artifact_core`, or any name ending in `_test`). See
[CONTRIBUTING.md](./CONTRIBUTING.md).
