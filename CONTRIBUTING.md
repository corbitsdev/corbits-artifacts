# Contributing

A small, deliberately boring codebase: strict TypeScript, arktype at the boundaries,
drizzle for data access, no magic.

Setup and the commands are in the [README](./README.md#working-on-it). `bun run
typecheck` must be clean — it is its own CI step, and `any` is not a way past it. The
few escapes in the tree each carry a comment explaining why the type system leaves no
alternative; new ones need the same.

## Most of the suite needs a real Postgres

Nothing is mocked at the database boundary. Migrations, indexes, keyset cursors, the
version-bump race and tenant scoping are asserted against a live server, because that is
the only place they are true.

## The reference host is the acceptance suite, not a demo

`examples/reference-host` mounts the package on a real `@intx/hub-api` app against a
live Postgres and asserts the end-to-end scenarios, consuming the package through the
built `dist/` — the same artifact a consumer installs. That is why `test:acceptance`
builds first: running it against stale output is how a green acceptance run stops
meaning anything.

If you change the mount seam, a port, or anything about how a host wires this up, the
reference host is where that change has to be shown working.

## Dependency rule

No `@workbench/*` imports anywhere — it is an unpublished scope, and importing it would
make this package uninstallable outside the project that defines it. Checked by
`scripts/check-deps.ts`, which runs as `pretest` and again in CI.

## Tests

- **Red first.** A bug fix starts with a test that fails for the reason you believe, and
  you should watch it fail. A test that was green before the fix proved nothing.
- **Coverage floor is 80% of lines and functions**, set by `coverageThreshold` in the
  package's `bunfig.toml` and applied by Bun **per file** — one badly covered new file
  fails the run even when the average looks fine. It is a floor, not a target.
- Assert **behavior a consumer can observe** — a status code, a returned shape, a row in
  the database — over internal call shapes.
- A new `ContentStore` implementation is expected to pass the same suite the two shipped
  ones do. If it needs a special case in a test, that is a signal about the port, not
  about the test.

## Migrations

Shipped migrations are immutable. Each ledger row records a checksum of the migration's
rendered SQL, so editing one that has already been applied fails with
`MigrationChecksumError` on the next boot rather than letting fresh and existing
databases diverge. Add a new migration instead.

`schema.ts` and `migrations.ts` must agree — the drizzle table objects are public
exports, and a test asserts the migrations create exactly the tables `schema.ts`
declares, no more and no less. Change one, change the other, in the same commit.

## Pull requests

- Keep commits focused, and keep the diff to the change you are describing.
- Explain *why* in the commit message; the code already says what.
- CI must be green: dependency check, typecheck, unit + integration, build, reference-host
  acceptance, and a Node consumer smoke test that installs the packed tarball.
- Contributions are accepted under the repository's LGPL-2.1-only licence.
