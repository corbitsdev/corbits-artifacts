import { sql } from "drizzle-orm";
import { createArtifactDb, type ArtifactDb } from "../src/db.js";
import { runArtifactMigrations } from "../src/migrations.js";
import { createArtifact } from "../src/artifacts.js";
import type { ArtifactRow } from "../src/schema.js";
import type { Identity } from "../src/ports.js";

export const DATABASE_URL =
  process.env.ARTIFACT_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5457/artifact_core";

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

/** A directory that answers exactly what a test wires into it, nothing more. */
export function fakeIdentity(overrides: Partial<Identity> = {}): Identity {
  return {
    ownerNames: async () => new Map(),
    ownerMemberPrincipalId: async () => null,
    principalIdsByKind: async () => [],
    ownerIsMemberOfTenant: async () => false,
    ...overrides,
  };
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
