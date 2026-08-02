import { sql } from "drizzle-orm";
import { createArtifactDb, type ArtifactDb } from "../src/db.js";
import { runArtifactMigrations } from "../src/migrations.js";
import { createArtifact } from "../src/artifacts.js";
import type { ArtifactRow } from "../src/schema.js";

export const DATABASE_URL =
  process.env.ARTIFACT_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5457/artifact_core";

/**
 * Explicit opt-in required before the harness runs TRUNCATE or DROP SCHEMA.
 * Must be the string `"1"` — any other value (including `"true"`) is refused.
 */
export const ALLOW_DESTRUCTIVE_ARTIFACT_TESTS = "ALLOW_DESTRUCTIVE_ARTIFACT_TESTS";

type EnvMap = { readonly [key: string]: string | undefined };

/**
 * Database name segment of a Postgres connection string.
 * Pure URL parsing so the refuse path is unit-testable without a live server.
 */
export function databaseNameFromConnectionString(connectionString: string): string {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error(
      `Invalid ARTIFACT_DATABASE_URL (not a URL): ${JSON.stringify(connectionString)}`,
    );
  }
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, "").split("/")[0] ?? "");
  if (!name) {
    throw new Error(
      `ARTIFACT_DATABASE_URL has no database name (path is empty): ${JSON.stringify(connectionString)}`,
    );
  }
  return name;
}

/**
 * Ephemeral-name allowlist for destructive artifact tests:
 * - exact: `artifact_core` (the documented local docker default)
 * - suffix: any name ending in `_test` (covers `artifacts_test`, `foo_test`, …)
 *
 * Everything else — production-looking names included — is refused.
 */
export function isAllowlistedArtifactTestDatabase(name: string): boolean {
  if (name === "artifact_core") return true;
  if (name.endsWith("_test")) return true;
  return false;
}

/**
 * Fail closed before TRUNCATE / DROP SCHEMA: require both the opt-in env flag
 * and an allowlisted database name. Pure (URL + env only) so CI without PG
 * can still prove the refuse path.
 */
export function assertDestructiveArtifactTestsAllowed(
  connectionString: string,
  env: EnvMap = process.env,
): void {
  const optedIn = env[ALLOW_DESTRUCTIVE_ARTIFACT_TESTS] === "1";
  let name: string | undefined;
  try {
    name = databaseNameFromConnectionString(connectionString);
  } catch (err) {
    // Surface parse failures as gate failures with the same requirements list.
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Refusing destructive artifact test operations (TRUNCATE/DROP). ${detail} ` +
        `Set ${ALLOW_DESTRUCTIVE_ARTIFACT_TESTS}=1 and point ARTIFACT_DATABASE_URL ` +
        `at an allowlisted ephemeral database (name must be "artifact_core" or end with "_test").`,
    );
  }
  const allowlisted = isAllowlistedArtifactTestDatabase(name);
  if (optedIn && allowlisted) return;

  const reasons: string[] = [];
  if (!optedIn) {
    reasons.push(
      `${ALLOW_DESTRUCTIVE_ARTIFACT_TESTS} is not "1" (got ${JSON.stringify(env[ALLOW_DESTRUCTIVE_ARTIFACT_TESTS] ?? null)})`,
    );
  }
  if (!allowlisted) {
    reasons.push(
      `database name ${JSON.stringify(name)} is not allowlisted (need "artifact_core" or a name ending in "_test")`,
    );
  }
  throw new Error(
    `Refusing destructive artifact test operations (TRUNCATE/DROP). ${reasons.join("; ")}. ` +
      `Set ${ALLOW_DESTRUCTIVE_ARTIFACT_TESTS}=1 and point ARTIFACT_DATABASE_URL ` +
      `at an allowlisted ephemeral database (name must be "artifact_core" or end with "_test").`,
  );
}

// One pool for the whole suite. Opening a fresh one per test leaked a
// connection pool per call and eventually hit `too many clients already`.
let shared: ArtifactDb | undefined;

/**
 * The FK targets in the host control plane. The package's migrations REFERENCE
 * `public.tenant` / `public.principal`, so the unit suite stands up id-only
 * stand-ins (a real host brings the full Interchange tables) and seeds every
 * tenant and principal id the tests mint rows for.
 */
export async function ensureControlPlane(db: ArtifactDb): Promise<void> {
  await db.execute(
    sql`CREATE TABLE IF NOT EXISTS "public"."tenant" ("id" text PRIMARY KEY)`,
  );
  await db.execute(
    sql`CREATE TABLE IF NOT EXISTS "public"."principal" ("id" text PRIMARY KEY)`,
  );
  // A shared dev database may carry the REAL Interchange tables from an
  // acceptance run, whose NOT NULL columns reject id-only rows — detect by
  // shape and satisfy them.
  const [real] = await db.execute<{ present: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tenant' AND column_name = 'slug'
    ) AS present
  `);
  for (const tenant of ["acme", "other"]) {
    await db.execute(
      real?.present
        ? sql`INSERT INTO "public"."tenant" ("id", "name", "slug", "domain")
              VALUES (${tenant}, ${tenant}, ${tenant}, ${`${tenant}.example`})
              ON CONFLICT DO NOTHING`
        : sql`INSERT INTO "public"."tenant" ("id") VALUES (${tenant})
              ON CONFLICT DO NOTHING`,
    );
  }
  for (const principal of ["user-1", "someone-else", "agent-9"]) {
    await db.execute(
      real?.present
        ? sql`INSERT INTO "public"."principal" ("id", "tenant_id", "kind", "ref_id", "status")
              VALUES (${principal}, 'acme', 'user', ${principal}, 'active')
              ON CONFLICT DO NOTHING`
        : sql`INSERT INTO "public"."principal" ("id") VALUES (${principal})
              ON CONFLICT DO NOTHING`,
    );
  }
}

export async function testDb(): Promise<ArtifactDb> {
  // Gate before any pool open or TRUNCATE — a mispointed URL must never wipe.
  assertDestructiveArtifactTestsAllowed(DATABASE_URL);
  let db = shared;
  if (!db) {
    db = createArtifactDb(DATABASE_URL).db;
    shared = db;
    await ensureControlPlane(db);
    await runArtifactMigrations(db);
  }
  await db.execute(
    sql`TRUNCATE TABLE "artifacts"."artifact", "artifacts"."artifact_version", "artifacts"."upload", "artifacts"."mail_attachment_ref" CASCADE`,
  );
  return db;
}

export const SCOPE = { tenantId: "acme", principalId: "user-1" };

export async function seedArtifact(
  db: ArtifactDb,
  overrides: Partial<{
    kind: string;
    title: string;
    content: string;
    source: Record<string, unknown>;
    ownerPrincipalId: string | null;
    tenantId: string;
  }> = {},
): Promise<ArtifactRow> {
  const scope = { ...SCOPE, ...(overrides.tenantId ? { tenantId: overrides.tenantId } : {}) };
  return await db.transaction((tx) =>
    createArtifact(tx, {
      scope,
      ownerPrincipalId:
        overrides.ownerPrincipalId === undefined
          ? scope.principalId
          : overrides.ownerPrincipalId,
      kind: overrides.kind ?? "document",
      title: overrides.title ?? "Untitled",
      content: overrides.content ?? "body",
      source: overrides.source ?? { origin: "manual" },
    }),
  );
}

/** Bypasses `createArtifact` so a test can plant a kind the module refuses to mint. */
export async function seedSkillDraft(db: ArtifactDb, title: string): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO "artifacts"."artifact" ("tenant_id", "principal_id", "owner_principal_id",
      "kind", "title", "content", "source", "version")
    VALUES (${SCOPE.tenantId}, ${SCOPE.principalId}, ${SCOPE.principalId},
      'skill-draft', ${title}, 'draft body', '{"origin":"agent"}'::jsonb, 1)
    RETURNING "id"
  `);
  return rows[0]!.id;
}
