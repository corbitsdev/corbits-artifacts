import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { ArtifactDb } from "./db.js";
import { assertExpectedColumnTypes } from "./schema-check.js";

// Own migration ledger — never shared with any host table, so this package can
// be mounted onto a host schema without colliding with (or depending on) the
// host's own migration bookkeeping.
const LEDGER_TABLE = "corbits_artifact_core_migrations";

export type Migration = { id: string; statements: SQL[] };

export const MIGRATIONS: Migration[] = [
  {
    id: "0001_artifact_core",
    statements: [
      sql`
        CREATE TABLE IF NOT EXISTS "artifact" (
          "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
          "tenant_id" text,
          "principal_id" text,
          "owner_principal_id" text,
          "creator_kind" text NOT NULL,
          "parent_id" text REFERENCES "artifact"("id") ON DELETE CASCADE,
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
      // The list is a keyset scan ordered by (updated_at, id) — the id is the
      // tie-break, and without it in the index the row-value cursor predicate
      // degrades from an Index Cond to a Filter plus an Incremental Sort,
      // re-walking every entry in a large tie group on every page.
      sql`
        CREATE INDEX IF NOT EXISTS "artifact_tenant_updated_id_idx"
          ON "artifact" ("tenant_id", "updated_at", "id")
      `,
      sql`
        CREATE TABLE IF NOT EXISTS "artifact_version" (
          "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
          "artifact_id" text NOT NULL REFERENCES "artifact"("id") ON DELETE CASCADE,
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
        CREATE TABLE IF NOT EXISTS "upload" (
          "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
          "tenant_id" text NOT NULL,
          "principal_id" text NOT NULL,
          "filename" text NOT NULL,
          "mime_type" text NOT NULL,
          "content" bytea NOT NULL,
          "size" integer NOT NULL,
          "created_at" timestamp NOT NULL DEFAULT now()
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS "mail_attachment_ref" (
          "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
          "tenant_id" text NOT NULL,
          "principal_id" text NOT NULL,
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
          ON "mail_attachment_ref" ("instance_id")
      `,
    ],
  },
];

// A fixed advisory-lock key for this package, so several app instances booting
// at once serialize here instead of racing the same CREATE TABLE. Advisory
// locks are namespaced by this integer alone, so it is deliberately arbitrary
// and specific to @corbits/artifact-core.
const LOCK_KEY = 0x0a27_1f04;

const DIALECT = new PgDialect();

/**
 * The identity of a migration's BODY, not just its id. Rendered through the
 * same dialect that will execute it, so the checksum covers exactly the text
 * Postgres receives.
 *
 * Without this the ledger records only "0001 ran", and editing a shipped
 * migration is undetectable: every existing database skips it forever while
 * every fresh one gets the new DDL, and the two schemas diverge silently.
 *
 * Runs of whitespace are collapsed before hashing, so reindenting a template
 * literal is not a schema change and does not lock every deployed host out on
 * its next boot. Identical, character for character, to
 * `@corbits/analytics-core`'s: two sibling packages must not disagree about
 * what "the same migration" means.
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
 * Idempotent migration runner. Safe to call on every boot, from every instance.
 *
 * The whole run happens inside ONE transaction, and the first thing that
 * transaction does is take a TRANSACTION-scoped advisory lock. Both halves of
 * that matter:
 *
 *  - A transaction pins a single pooled connection, so the lock, the ledger
 *    read, and the DDL are guaranteed to be the same session. The session-scoped
 *    `pg_advisory_lock` this used to call could be taken on one pooled
 *    connection while the migrations ran on another — protecting nothing — and
 *    the matching `pg_advisory_unlock` could be issued on a connection that
 *    never held it, returning false and LEAKING the lock until that backend
 *    died. Every later boot would then block on it forever.
 *  - `pg_advisory_xact_lock` releases on commit or rollback, so there is no
 *    unlock call left to get lost or skipped on the error path.
 *
 * `CREATE TABLE IF NOT EXISTS` is not itself race-safe — the existence check
 * and the catalogue insert are not atomic, so concurrent cold starts hit a
 * duplicate-key error on pg_type — so the lock, not the IF NOT EXISTS, is what
 * makes this safe.
 *
 * The run also lowers `client_min_messages` to `warning` for the duration of
 * the transaction. Every DDL statement here is deliberately `IF NOT EXISTS` /
 * `ADD COLUMN IF NOT EXISTS`, and on the second and every later boot Postgres
 * answers each one with a NOTICE (`relation "…" already exists, skipping`).
 * postgres.js has no notice handler by default, so it dumps the raw notice
 * object to the console — meaning a perfectly clean re-boot of a runner
 * documented as "safe to call on every boot" looked like a stack of errors on
 * every replica start. `SET LOCAL` scopes the change to this transaction and
 * stops at NOTICE: WARNING and above — a genuinely deprecated cast, a
 * truncated identifier — still reach the host untouched. It is set on the
 * connection rather than via a client option so it holds for ANY handle a host
 * hands in, including one this package did not construct.
 *
 * Each migration still applies inside its own nested transaction (a savepoint
 * under the outer one), so a migration is all-or-nothing with its ledger row
 * and can never be recorded as applied with only some of its statements run.
 */
export async function runArtifactMigrations(db: ArtifactDb): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL client_min_messages = warning`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);

    // `checksum` is NOT NULL from the first migration this package ever ships.
    // There is no such thing as a ledger written before checksums existed —
    // 0.1.0 is the first public release and it carries a single squashed
    // `0001` — so there is no pre-checksum row to adopt and the column needs no
    // backfilling ALTER. That keeps immutability enforcement unconditional:
    // every recorded row has a checksum, so every edit to a shipped migration
    // is caught, with no adopt-silently path that lets exactly one through.
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS ${sql.identifier(LEDGER_TABLE)} (
        "id" text PRIMARY KEY,
        "checksum" text NOT NULL,
        "applied_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = await tx.execute<{ id: string; checksum: string }>(
      sql`SELECT "id", "checksum" FROM ${sql.identifier(LEDGER_TABLE)}`,
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
          INSERT INTO ${sql.identifier(LEDGER_TABLE)} ("id", "checksum")
          VALUES (${migration.id}, ${checksum})
        `);
      });
    }

    // Last, on the same transaction, so it sees exactly the schema the DDL
    // above just produced — and so a host whose pre-existing tables shadow ours
    // fails the boot instead of silently reading its columns through our codec.
    // See schema-check.ts.
    await assertExpectedColumnTypes(tx);
  });
}
