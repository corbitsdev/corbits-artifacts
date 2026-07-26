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

export async function testDb(): Promise<ArtifactDb> {
  let db = shared;
  if (!db) {
    db = createArtifactDb(DATABASE_URL).db;
    shared = db;
    await runArtifactMigrations(db);
  }
  await db.execute(
    sql`TRUNCATE TABLE "artifact", "artifact_version", "upload", "mail_attachment_ref" CASCADE`,
  );
  return db;
}

export const SCOPE = { tenant: "acme", principal: "user-1" };

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
  const scope = { ...SCOPE, ...(overrides.tenantId ? { tenant: overrides.tenantId } : {}) };
  return await db.transaction((tx) =>
    createArtifact(tx, {
      scope,
      ownerPrincipalId:
        overrides.ownerPrincipalId === undefined
          ? scope.principal
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
    INSERT INTO "artifact" ("tenant_id", "principal_id", "owner_principal_id",
      "kind", "title", "content", "source", "version")
    VALUES (${SCOPE.tenant}, ${SCOPE.principal}, ${SCOPE.principal},
      'skill-draft', ${title}, 'draft body', '{"origin":"agent"}'::jsonb, 1)
    RETURNING "id"
  `);
  return rows[0]!.id;
}
