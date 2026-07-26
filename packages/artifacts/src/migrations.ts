import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { ArtifactDb } from "./db.js";
import { ARTIFACTS_SCHEMA } from "./schema.js";

// Own migration ledger, inside the package's own schema, so it never collides
// with the host's migration bookkeeping.
const LEDGER_TABLE = "migrations";
const LEDGER = sql`${sql.identifier(ARTIFACTS_SCHEMA)}.${sql.identifier(LEDGER_TABLE)}`;

export type Migration = { id: string; statements: SQL[] };

// Every statement is schema-qualified: this package owns the `artifacts`
// schema outright and never writes into the host's search_path. The tenant and
// principal columns are hard FKs into Interchange's control plane in `public`
// — the host's own migrations must have run first.
export const MIGRATIONS: Migration[] = [
  {
    id: "0001_artifacts",
    statements: [
      sql`
        CREATE TABLE IF NOT EXISTS "artifacts"."artifact" (
          "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
          "tenant_id" text REFERENCES "public"."tenant"("id") ON DELETE CASCADE,
          "principal_id" text REFERENCES "public"."principal"("id") ON DELETE SET NULL,
          "owner_principal_id" text REFERENCES "public"."principal"("id") ON DELETE SET NULL,
          "kind" text NOT NULL,
          "title" text NOT NULL,
          "content" text NOT NULL,
          "source" jsonb,
          "version" integer NOT NULL DEFAULT 1,
          "archived_at" timestamp,
          "created_at" timestamp NOT NULL DEFAULT now(),
          "updated_at" timestamp NOT NULL DEFAULT now()
        )
      `,
      // The list is a keyset scan ordered by (updated_at, id) — the id
      // tie-break must be IN the index or the cursor predicate degrades from
      // an Index Cond to a Filter plus a sort.
      sql`
        CREATE INDEX IF NOT EXISTS "artifact_tenant_updated_id_idx"
          ON "artifacts"."artifact" ("tenant_id", "updated_at", "id")
      `,
      // FK-support indexes, so ON DELETE CASCADE / SET NULL on the control
      // plane never seq-scans these tables.
      sql`
        CREATE INDEX IF NOT EXISTS "artifact_principal_idx"
          ON "artifacts"."artifact" ("principal_id")
      `,
      sql`
        CREATE INDEX IF NOT EXISTS "artifact_owner_principal_idx"
          ON "artifacts"."artifact" ("owner_principal_id")
      `,
      sql`
        CREATE TABLE IF NOT EXISTS "artifacts"."artifact_version" (
          "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
          "artifact_id" text NOT NULL REFERENCES "artifacts"."artifact"("id") ON DELETE CASCADE,
          "version" integer NOT NULL,
          "title" text NOT NULL,
          "content" text NOT NULL,
          "author_id" text NOT NULL,
          "created_at" timestamp NOT NULL DEFAULT now(),
          CONSTRAINT "artifact_version_artifact_id_version"
            UNIQUE ("artifact_id", "version")
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS "artifacts"."upload" (
          "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
          "tenant_id" text NOT NULL REFERENCES "public"."tenant"("id") ON DELETE CASCADE,
          "principal_id" text REFERENCES "public"."principal"("id") ON DELETE SET NULL,
          "filename" text NOT NULL,
          "mime_type" text NOT NULL,
          "content" bytea NOT NULL,
          "size" integer NOT NULL,
          "created_at" timestamp NOT NULL DEFAULT now()
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS "upload_tenant_idx"
          ON "artifacts"."upload" ("tenant_id")
      `,
      sql`
        CREATE INDEX IF NOT EXISTS "upload_principal_idx"
          ON "artifacts"."upload" ("principal_id")
      `,
      sql`
        CREATE TABLE IF NOT EXISTS "artifacts"."mail_attachment_ref" (
          "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
          "tenant_id" text NOT NULL REFERENCES "public"."tenant"("id") ON DELETE CASCADE,
          "principal_id" text REFERENCES "public"."principal"("id") ON DELETE SET NULL,
          "instance_id" text NOT NULL,
          "mail_id" text NOT NULL,
          "artifact_id" text NOT NULL,
          "name" text NOT NULL,
          "mime_type" text NOT NULL,
          "size" integer NOT NULL,
          "created_at" timestamp NOT NULL DEFAULT now(),
          CONSTRAINT "mail_attachment_ref_mail_id_artifact_id"
            UNIQUE ("mail_id", "artifact_id")
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS "mail_attachment_ref_instance_idx"
          ON "artifacts"."mail_attachment_ref" ("instance_id")
      `,
      sql`
        CREATE INDEX IF NOT EXISTS "mail_attachment_ref_tenant_idx"
          ON "artifacts"."mail_attachment_ref" ("tenant_id")
      `,
      sql`
        CREATE INDEX IF NOT EXISTS "mail_attachment_ref_principal_idx"
          ON "artifacts"."mail_attachment_ref" ("principal_id")
      `,
    ],
  },
];

// Advisory locks are namespaced by this integer alone; deliberately arbitrary
// and specific to @corbits/artifacts.
const LOCK_KEY = 0x0a27_1f04;

const DIALECT = new PgDialect();

/**
 * Checksum of a migration's BODY, rendered through the executing dialect, with
 * whitespace runs collapsed so reindenting is not a schema change. Editing a
 * shipped migration therefore fails loudly on the next boot instead of letting
 * existing and fresh databases diverge silently.
 */
export function migrationChecksum(migration: Migration): string {
  const rendered = migration.statements
    .map((statement) =>
      DIALECT.sqlToQuery(statement).sql.replace(/\s+/g, " ").trim(),
    )
    .join(";\n");
  return createHash("sha256").update(rendered).digest("hex");
}

export class MigrationChecksumError extends Error {
  constructor(id: string, recorded: string, current: string) {
    super(
      `Migration "${id}" has changed since it was applied to this database ` +
        `(recorded ${recorded}, now ${current}). A shipped migration must never ` +
        `be edited — add a new one instead.`,
    );
    this.name = "MigrationChecksumError";
  }
}

/**
 * Idempotent migration runner. Safe to call on every boot, from every
 * instance: the whole run is ONE transaction whose first act is taking a
 * TRANSACTION-scoped advisory lock, so concurrent cold starts serialize on the
 * same session and the lock releases on commit or rollback. `SET LOCAL
 * client_min_messages = warning` silences the re-boot NOTICE chatter from the
 * IF NOT EXISTS statements without muting real warnings. Each migration
 * applies inside a savepoint together with its ledger row, so it can never be
 * recorded as applied with only some statements run.
 */
export async function runArtifactMigrations(db: ArtifactDb): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL client_min_messages = warning`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);

    await tx.execute(
      sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(ARTIFACTS_SCHEMA)}`,
    );

    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS ${LEDGER} (
        "id" text PRIMARY KEY,
        "checksum" text NOT NULL,
        "applied_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = await tx.execute<{ id: string; checksum: string }>(
      sql`SELECT "id", "checksum" FROM ${LEDGER}`,
    );
    const appliedChecksums = new Map(applied.map((row) => [row.id, row.checksum]));

    for (const migration of MIGRATIONS) {
      const checksum = migrationChecksum(migration);
      const recorded = appliedChecksums.get(migration.id);
      if (recorded !== undefined) {
        if (recorded !== checksum) {
          throw new MigrationChecksumError(migration.id, recorded, checksum);
        }
        continue;
      }
      await tx.transaction(async (step) => {
        for (const statement of migration.statements) {
          await step.execute(statement);
        }
        await step.execute(sql`
          INSERT INTO ${LEDGER} ("id", "checksum")
          VALUES (${migration.id}, ${checksum})
        `);
      });
    }
  });
}
