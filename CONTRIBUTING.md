# Contributing

## Development

```sh
bun install
bun run check
```

`bun run check` runs typecheck, lint, format check and unit tests. `bun run format` rewrites the tree.

Contributors sign the [CLA](CLA.md) on their first PR; the CLA bot explains how.

`bun run test:e2e` and `bun run test:coverage` need Postgres. Start one with `docker run -d --name corbits-artifact-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=artifact_core postgres:16`, then run with `ARTIFACT_DATABASE_URL=postgres://postgres:postgres@localhost:5432/artifact_core ALLOW_DESTRUCTIVE_ARTIFACT_TESTS=1`. The harness truncates tables and drops schemas, so it refuses to run without that flag and an allowlisted database name (`artifact_core`, or any name ending in `_test`). Each e2e suite creates and drops its own `artifact_<random>_test` database. `bun run test:coverage` runs `src/` and `e2e/` and fails below the 80% per-file floor in `bunfig.toml`; CI runs it.

## Migrations

Migrations are SQL files under `migrations/`, applied in filename order on every boot, so every statement must be idempotent (`IF NOT EXISTS`, `IF EXISTS`). There is no ledger: a schema change is a new file whose statements are safe to re-run. A data backfill must be cheap once it has run. `schema.ts` and `migrations/` change together, in the same commit.

## Commit messages

Commit subjects and PR titles follow [Conventional Commits](https://www.conventionalcommits.org): `feat`, `fix`, `refactor`, `test`, `docs`, `build`, `ci`, `perf`, and `chore(release): x.y.z` for releases.
Add `!` only for public API breaks: removed or renamed exports, changed signatures, newly required params. Peer and dependency range changes are `build(deps):` with no `!`.
Keep subjects imperative, lowercase after the colon, 72 characters or less, and free of ticket IDs.
Every PR links its issue with a `Closes <issue id>` line in the PR body.

## Releasing

Releases are manual. On a clean, up-to-date `main`:

```sh
npm version <patch|minor> -m "chore(release): %s"
git push --follow-tags
gh release create "v$(node -p 'require("./package.json").version')" --generate-notes
npm publish
```

Bump minor only for breaking API changes; everything else is a patch. `prepack` builds `dist/` from the tagged commit.
