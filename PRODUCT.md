# @corbits/artifacts — Product

## What it is

Persistent artifacts, versions, and file uploads as a mountable module for any
Interchange host. Backend only — this package ships no UI.

A host keeps the things agents and people make: text, links, uploaded files,
and the version history of each. `mountArtifacts` is the tenant-session
surface. `mountWorkflowArtifacts` is the parallel surface for a workflow run
that has no browser session. Both write the same rows.

## Why it exists

Agents produce files, drafts, and links that disappear unless the host stores
them. Every host that wants that store should not reimplement versions,
uploads, and tenant scoping. This package is the drop-in: mount it, run its
migrations, keep the bytes.

Two caller kinds exist and must not share one auth convention. A browser
session has Interchange `tenant` / `principal` and grants. A sidecar or
deployed agent has a bearer token and a run address. Mixing those into one
mount would make each harder to reason about, so the product is two mounts
over one store.

## Who it is for

- Interchange host operators who already have a Hono app, a Postgres pool, and
  `RequireGrant`.
- Workflow hosts that authenticate sidecar or agent callers and need those
  runs to create and read artifacts in the same tenant.
- Agent authors who pin `@corbits/artifacts/sidecar-bundle` so no agent owns
  artifact client code.

There is nothing here for an end-user UI. Clients consume the HTTP surface the
host mounted.

## What users can do

- Persist an artifact with append-only versions, list and download it, and
  soft-archive it without destroying history.
- Upload files through a pluggable `ContentStore` (inline Postgres bytes for a
  minimal host; another backend without a rewrite).
- Authorize tenant-session mutations through the host's Interchange grants —
  this package invents no owner, membership, or admin policy.
- Let a workflow run create, revise, find, and budget-read artifacts using
  the host's sidecar (or agent-token) resolver.
- Grant agents the sidecar bundle so tool calls hit the run-scoped routes
  through the hub credential handle.

## What it is not

- Not a service. It creates no app, opens no pool, and starts no background
  work.
- Not a UI, directory, or session library.
- Not an authorization product. Grants are the host's. The workflow mount
  trusts whatever `resolveRunScope` (and optional `agentToken`) returns.
- Not a parser. No PDF, spreadsheet, or text extractor lives here or is
  planned.
- Not a rate limiter for runs. Per-run quota stays host-side.

## Goals

1. One store for tenant-session and workflow-run callers.
2. Host-owned app, pool, session, and grants.
3. Two mounts, two auth conventions, no mix.
4. Bytes and artifact row atomic on write; tenant-scoped on read.
5. Honest public docs: README for install and the mount snippet;
   this file for intent; `ARCHITECTURE.md` for structure;
   `IMPLEMENTATION.md` for wire and config.

## License

LGPL-2.1-only.
