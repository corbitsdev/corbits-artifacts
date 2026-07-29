import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { ArtifactDb, ArtifactTx } from "./db.js";

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
  {
    // Zoneless `timestamp` stores a wall clock. Absolute instants written through
    // a non-UTC session TimeZone land as session-local walls, so list cursors
    // (which stamp a literal Z) and date filters compare the wrong instant.
    // `timestamptz` keeps absolute time; existing walls are treated as UTC — the
    // package always documented these columns as UTC wall clocks.
    id: "0002_timestamptz",
    statements: [
      sql`
        ALTER TABLE "artifacts"."artifact"
          ALTER COLUMN "archived_at" TYPE timestamptz
            USING "archived_at" AT TIME ZONE 'UTC',
          ALTER COLUMN "created_at" TYPE timestamptz
            USING "created_at" AT TIME ZONE 'UTC',
          ALTER COLUMN "updated_at" TYPE timestamptz
            USING "updated_at" AT TIME ZONE 'UTC'
      `,
      sql`
        ALTER TABLE "artifacts"."artifact_version"
          ALTER COLUMN "created_at" TYPE timestamptz
            USING "created_at" AT TIME ZONE 'UTC'
      `,
      sql`
        ALTER TABLE "artifacts"."upload"
          ALTER COLUMN "created_at" TYPE timestamptz
            USING "created_at" AT TIME ZONE 'UTC'
      `,
      sql`
        ALTER TABLE "artifacts"."mail_attachment_ref"
          ALTER COLUMN "created_at" TYPE timestamptz
            USING "created_at" AT TIME ZONE 'UTC'
      `,
    ],
  },
  {
    // Cheap row-local invariants. tenant_id was nullable in 0001 so a restored
    // dump can still hold orphans; refuse to SET NOT NULL over them and tell the
    // operator to assign a tenant or delete the rows first. Version/size CHECKs
    // are single-column and free at write time. Principal↔tenant alignment is
    // deliberately host-owned (resolvePrincipal) — a multi-table trigger into
    // public.principal is out of scope and would couple write path latency to
    // the control plane.
    id: "0003_schema_invariants",
    statements: [
      sql`
        DO $guard$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM "artifacts"."artifact" WHERE "tenant_id" IS NULL
          ) THEN
            RAISE EXCEPTION
              'Cannot apply 0003_schema_invariants: artifacts.artifact has rows with null tenant_id. Assign a valid tenant or delete those rows, then re-run migrations.';
          END IF;
        END
        $guard$
      `,
      sql`
        ALTER TABLE "artifacts"."artifact"
          ALTER COLUMN "tenant_id" SET NOT NULL
      `,
      sql`
        ALTER TABLE "artifacts"."artifact"
          ADD CONSTRAINT "artifact_version_gte_1" CHECK ("version" >= 1)
      `,
      sql`
        ALTER TABLE "artifacts"."artifact_version"
          ADD CONSTRAINT "artifact_version_version_gte_1" CHECK ("version" >= 1)
      `,
      sql`
        ALTER TABLE "artifacts"."upload"
          ADD CONSTRAINT "upload_size_gte_0" CHECK ("size" >= 0)
      `,
      sql`
        ALTER TABLE "artifacts"."mail_attachment_ref"
          ADD CONSTRAINT "mail_attachment_ref_size_gte_0" CHECK ("size" >= 0)
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
 * Thrown when the migration ledger is empty but package-owned objects already
 * exist in the `artifacts` schema. Without an explicit `{ adopt: true }`, the
 * runner fails closed rather than letting `CREATE IF NOT EXISTS` no-op and
 * stamp a checksum over a shape it never verified. With `adopt: true`, the
 * same error is thrown when the live shape does not match what the migrations
 * would create.
 */
export class MigrationAdoptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationAdoptError";
  }
}

/**
 * Options for {@link runArtifactMigrations}.
 *
 * `adopt` is an operator escape hatch for the rare case where package tables
 * already exist (restored dump, manual DDL, ledger dropped) and the operator
 * has confirmed they match the expected shape. It is never set by default and
 * must not be passed on ordinary boots. Adopt validates tables, column types,
 * required nullability (`artifact.tenant_id`), and the named CHECK constraints
 * from `0003_schema_invariants` before writing ledger rows — it does not
 * re-run DDL.
 */
export type RunArtifactMigrationsOptions = {
  adopt?: boolean;
};

/** Package-owned tables (excluding the ledger) and the columns each must have. */
type ExpectedColumn = {
  name: string;
  udt: string;
  /** When set, live `is_nullable` must be `NO`. */
  notNull?: true;
};

const EXPECTED_OWNED_SHAPE: Readonly<Record<string, readonly ExpectedColumn[]>> =
  {
    artifact: [
      { name: "id", udt: "text" },
      { name: "tenant_id", udt: "text", notNull: true },
      { name: "principal_id", udt: "text" },
      { name: "owner_principal_id", udt: "text" },
      { name: "kind", udt: "text" },
      { name: "title", udt: "text" },
      { name: "content", udt: "text" },
      { name: "source", udt: "jsonb" },
      { name: "version", udt: "int4" },
      { name: "archived_at", udt: "timestamptz" },
      { name: "created_at", udt: "timestamptz" },
      { name: "updated_at", udt: "timestamptz" },
    ],
    artifact_version: [
      { name: "id", udt: "text" },
      { name: "artifact_id", udt: "text" },
      { name: "version", udt: "int4" },
      { name: "title", udt: "text" },
      { name: "content", udt: "text" },
      { name: "author_id", udt: "text" },
      { name: "created_at", udt: "timestamptz" },
    ],
    upload: [
      { name: "id", udt: "text" },
      { name: "tenant_id", udt: "text" },
      { name: "principal_id", udt: "text" },
      { name: "filename", udt: "text" },
      { name: "mime_type", udt: "text" },
      { name: "content", udt: "bytea" },
      { name: "size", udt: "int4" },
      { name: "created_at", udt: "timestamptz" },
    ],
    mail_attachment_ref: [
      { name: "id", udt: "text" },
      { name: "tenant_id", udt: "text" },
      { name: "principal_id", udt: "text" },
      { name: "instance_id", udt: "text" },
      { name: "mail_id", udt: "text" },
      { name: "artifact_id", udt: "text" },
      { name: "name", udt: "text" },
      { name: "mime_type", udt: "text" },
      { name: "size", udt: "int4" },
      { name: "created_at", udt: "timestamptz" },
    ],
  };

/**
 * Row-local CHECKs applied by `0003_schema_invariants`. Adopt must see these
 * names so stamping 0003 without the constraints cannot pass shape validation.
 */
const EXPECTED_CHECK_CONSTRAINTS: ReadonlyArray<{
  table: string;
  name: string;
}> = [
  { table: "artifact", name: "artifact_version_gte_1" },
  { table: "artifact_version", name: "artifact_version_version_gte_1" },
  { table: "upload", name: "upload_size_gte_0" },
  { table: "mail_attachment_ref", name: "mail_attachment_ref_size_gte_0" },
];

async function listOwnedTables(tx: ArtifactTx): Promise<string[]> {
  const rows = await tx.execute<{ table_name: string }>(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = ${ARTIFACTS_SCHEMA}
      AND table_type = 'BASE TABLE'
      AND table_name <> ${LEDGER_TABLE}
    ORDER BY table_name
  `);
  return rows.map((row) => row.table_name);
}

/**
 * Compare live catalogue against the shape the migrations create: tables,
 * column types, required nullability, and named CHECK constraints. Returns a
 * human-readable mismatch list (empty when compatible).
 */
async function shapeMismatches(tx: ArtifactTx): Promise<string[]> {
  const owned = await listOwnedTables(tx);
  const expectedTables = Object.keys(EXPECTED_OWNED_SHAPE).sort();
  const mismatches: string[] = [];

  const ownedSet = new Set(owned);
  const expectedSet = new Set(expectedTables);
  for (const table of expectedTables) {
    if (!ownedSet.has(table)) {
      mismatches.push(`missing table ${ARTIFACTS_SCHEMA}.${table}`);
    }
  }
  for (const table of owned) {
    if (!expectedSet.has(table)) {
      mismatches.push(`unexpected table ${ARTIFACTS_SCHEMA}.${table}`);
    }
  }

  if (mismatches.length > 0) return mismatches;

  const columns = await tx.execute<{
    table_name: string;
    column_name: string;
    udt_name: string;
    is_nullable: string;
  }>(sql`
    SELECT table_name, column_name, udt_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = ${ARTIFACTS_SCHEMA}
      AND table_name <> ${LEDGER_TABLE}
  `);

  const byTable = new Map<string, Map<string, { udt: string; nullable: string }>>();
  for (const col of columns) {
    let cols = byTable.get(col.table_name);
    if (!cols) {
      cols = new Map();
      byTable.set(col.table_name, cols);
    }
    cols.set(col.column_name, {
      udt: col.udt_name,
      nullable: col.is_nullable,
    });
  }

  for (const table of expectedTables) {
    const expectedCols = EXPECTED_OWNED_SHAPE[table]!;
    const live = byTable.get(table) ?? new Map();
    for (const expected of expectedCols) {
      const liveCol = live.get(expected.name);
      if (liveCol === undefined) {
        mismatches.push(
          `missing column ${ARTIFACTS_SCHEMA}.${table}.${expected.name}`,
        );
      } else if (liveCol.udt !== expected.udt) {
        mismatches.push(
          `column ${ARTIFACTS_SCHEMA}.${table}.${expected.name} has type ${liveCol.udt}, expected ${expected.udt}`,
        );
      } else if (expected.notNull && liveCol.nullable !== "NO") {
        mismatches.push(
          `column ${ARTIFACTS_SCHEMA}.${table}.${expected.name} is nullable, expected NOT NULL`,
        );
      }
    }
  }

  if (mismatches.length > 0) return mismatches;

  // Named CHECKs from 0003 — without these, adopt would stamp the ledger over a
  // schema that never gained the row-local invariants.
  const checks = await tx.execute<{ table_name: string; constraint_name: string }>(
    sql`
      SELECT c.relname AS table_name, con.conname AS constraint_name
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${ARTIFACTS_SCHEMA}
        AND con.contype = 'c'
    `,
  );
  const checkByTable = new Map<string, Set<string>>();
  for (const row of checks) {
    let names = checkByTable.get(row.table_name);
    if (!names) {
      names = new Set();
      checkByTable.set(row.table_name, names);
    }
    names.add(row.constraint_name);
  }
  for (const { table, name } of EXPECTED_CHECK_CONSTRAINTS) {
    const live = checkByTable.get(table);
    if (!live?.has(name)) {
      mismatches.push(
        `missing CHECK constraint ${name} on ${ARTIFACTS_SCHEMA}.${table}`,
      );
    }
  }

  return mismatches;
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
 *
 * When the ledger is empty but package-owned objects already exist, the runner
 * fails closed with {@link MigrationAdoptError} unless `{ adopt: true }` is
 * passed and the live shape matches what the migrations would create (tables,
 * column types, required nullability, and named CHECK constraints). That path
 * records checksums without re-running DDL. Ledger checksum drift still throws
 * {@link MigrationChecksumError}.
 */
export async function runArtifactMigrations(
  db: ArtifactDb,
  options: RunArtifactMigrationsOptions = {},
): Promise<void> {
  const adopt = options.adopt === true;

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

    // Empty ledger + pre-existing owned objects: never let IF NOT EXISTS no-op
    // and stamp a checksum. Fail closed, or adopt only after shape validation.
    if (appliedChecksums.size === 0) {
      const owned = await listOwnedTables(tx);
      if (owned.length > 0) {
        const mismatches = await shapeMismatches(tx);
        if (mismatches.length > 0) {
          throw new MigrationAdoptError(
            `Package schema ${ARTIFACTS_SCHEMA} already has objects but the ` +
              `migration ledger is empty, and the live shape is incompatible: ` +
              `${mismatches.join("; ")}. Refusing to record a checksum over an ` +
              `unverified schema. Drop the incompatible objects and re-run, or ` +
              `repair the shape to match the package migrations before adopting.`,
          );
        }
        if (!adopt) {
          throw new MigrationAdoptError(
            `Package schema ${ARTIFACTS_SCHEMA} already has objects ` +
              `(${owned.join(", ")}) but the migration ledger is empty. ` +
              `Refusing to silently adopt them. Re-run with ` +
              `{ adopt: true } only after confirming the live shape matches ` +
              `what the package migrations create, or drop the schema and let ` +
              `the runner create it cleanly.`,
          );
        }
        // Compatible shape + explicit adopt: record every migration checksum
        // without re-running DDL (IF NOT EXISTS would only hide drift).
        for (const migration of MIGRATIONS) {
          const checksum = migrationChecksum(migration);
          await tx.execute(sql`
            INSERT INTO ${LEDGER} ("id", "checksum")
            VALUES (${migration.id}, ${checksum})
          `);
        }
        return;
      }
    }

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
