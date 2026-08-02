import { describe, expect, test } from "bun:test";
import { getTableName, is, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { PgTable } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { createArtifactDb } from "./db.js";
import {
  migrationChecksum,
  MigrationAdoptError,
  MigrationChecksumError,
  MIGRATIONS,
  runArtifactMigrations,
} from "./migrations.js";
import * as schema from "./schema.js";
import {
  assertDestructiveArtifactTestsAllowed,
  DATABASE_URL,
} from "./test-helpers.js";

const SCHEMA = "artifacts";
const LEDGER = "migrations";

/**
 * DERIVED FROM `schema.ts`, never restated. A hardcoded list is not a coverage
 * guard: adding a table to the schema without a migration would leave the list
 * describing the old world and the suite green, which is the precise failure
 * this test exists to catch. Reading the declarations back off the drizzle
 * objects means the guard grows itself the moment the schema does.
 */
const DECLARED_TABLES = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable))
  .map(getTableName)
  .sort();

// A shared handle for the assertions that only inspect catalogue state.
const { db } = createArtifactDb(DATABASE_URL);

describe("migrations", () => {
  test("creates every declared table and records each migration once", async () => {
    await runArtifactMigrations(db);

    const tables = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${SCHEMA}
    `);
    const names = new Set(tables.map((t) => t.table_name));
    expect(DECLARED_TABLES.length).toBeGreaterThan(0);
    for (const table of [...DECLARED_TABLES, LEDGER]) {
      expect({ table, created: names.has(table) }).toEqual({ table, created: true });
    }

    const ledger = await db.execute<{ id: string }>(
      sql`SELECT "id" FROM ${sql.identifier(SCHEMA)}.${sql.identifier(LEDGER)} ORDER BY "id"`,
    );
    expect(ledger.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));
  });

  test("re-running is a no-op: no duplicate ledger rows, no error", async () => {
    await runArtifactMigrations(db);
    await runArtifactMigrations(db);
    await runArtifactMigrations(db);

    const ledger = await db.execute<{ id: string }>(
      sql`SELECT "id" FROM ${sql.identifier(SCHEMA)}.${sql.identifier(LEDGER)}`,
    );
    expect(ledger.length).toBe(MIGRATIONS.length);
  });

  // Four cold starts against a database where the package schema does not
  // exist at all — the real first-boot race. Without the advisory lock this
  // fails: `CREATE SCHEMA/TABLE IF NOT EXISTS` checks the catalogue and
  // inserts non-atomically, so the losers get a 23505 duplicate key. It is
  // the lock, not the IF NOT EXISTS, that makes the runner safe to call from
  // every instance at once.
  test("concurrent first boots against a fresh database all succeed", async () => {
    assertDestructiveArtifactTestsAllowed(DATABASE_URL);
    await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(SCHEMA)} CASCADE`);
    // Each handle is its own pool, so all four genuinely believe they are the
    // first boot.
    const handles = [0, 1, 2, 3].map(() => createArtifactDb(DATABASE_URL));
    try {
      await Promise.all(handles.map((h) => runArtifactMigrations(h.db)));

      const ledger = await handles[0]!.db.execute<{ id: string }>(
        sql`SELECT "id" FROM ${sql.identifier(SCHEMA)}.${sql.identifier(LEDGER)} ORDER BY "id"`,
      );
      expect(ledger.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));

      const tables = await db.execute<{ table_name: string }>(sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = ${SCHEMA}
      `);
      const names = new Set(tables.map((t) => t.table_name));
      for (const table of [...DECLARED_TABLES, LEDGER]) {
        expect({ table, created: names.has(table) }).toEqual({ table, created: true });
      }
    } finally {
      await Promise.all(handles.map((h) => h.close()));
    }
  });

  // The lock is transaction-scoped, so a failed run releases it by rolling
  // back — there is no unlock statement that could be issued on a different
  // pooled connection, return false, and leak the lock forever.
  test("the advisory lock is not held after the run, success or failure", async () => {
    // pg_locks is cluster-wide, so this observes every backend, not just ours.
    const heldNow = async () => {
      const rows = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND objid = ${0x0a27_1f04}
      `);
      return rows[0]!.n;
    };

    const { db: handle, close } = createArtifactDb(DATABASE_URL);
    try {
      // SUCCESS path.
      await runArtifactMigrations(handle);
      expect({ path: "success", held: await heldNow() }).toEqual({
        path: "success",
        held: 0,
      });

      // FAILURE path — the half the name claimed and the body never ran. A
      // stale checksum makes the run throw AFTER the lock has been taken, which
      // is the only interesting case: a lock leaked here would block every
      // later boot forever, and it is exactly what the session-scoped
      // `pg_advisory_lock`/`pg_advisory_unlock` pair used to risk.
      await db.execute(
        sql`UPDATE ${sql.identifier(SCHEMA)}.${sql.identifier(LEDGER)} SET "checksum" = 'stale'
            WHERE "id" = ${MIGRATIONS[0]!.id}`,
      );
      await expect(runArtifactMigrations(handle)).rejects.toThrow(
        MigrationChecksumError,
      );
      expect({ path: "failure", held: await heldNow() }).toEqual({
        path: "failure",
        held: 0,
      });

      // And the proof that "released" means usable, not merely absent from
      // pg_locks: the very next run takes the lock again instead of hanging.
      await db.execute(
        sql`UPDATE ${sql.identifier(SCHEMA)}.${sql.identifier(LEDGER)} SET "checksum" = ${migrationChecksum(MIGRATIONS[0]!)}
            WHERE "id" = ${MIGRATIONS[0]!.id}`,
      );
      await runArtifactMigrations(handle);
      expect(await heldNow()).toBe(0);
    } finally {
      await close();
    }
  });

  test("the standalone handle can be closed, so a migration script exits", async () => {
    const { db: standalone, close } = createArtifactDb(DATABASE_URL);
    await runArtifactMigrations(standalone);
    await close();
    await expect(runArtifactMigrations(standalone)).rejects.toThrow();
  });

  // Every DDL in the runner is `IF NOT EXISTS`, so on the second and every
  // later boot Postgres answers each one with a NOTICE. postgres.js has no
  // notice handler by default and dumps the raw object to the console, so a
  // clean re-boot of a runner documented as "safe to call on every boot" read
  // as a wall of errors on every replica start.
  test("a re-run emits no NOTICE, on a handle this package did not construct", async () => {
    const notices: { severity?: string; code?: string; message?: string }[] = [];
    const client = postgres(DATABASE_URL, {
      onnotice: (notice) => notices.push(notice),
    });
    const handle = drizzle(client);
    try {
      // First run creates whatever is missing; second run is the boot that used
      // to be noisy — every object already exists.
      await runArtifactMigrations(handle);
      notices.length = 0;
      await runArtifactMigrations(handle);
      expect(notices).toEqual([]);
    } finally {
      await client.end();
    }
  });

  // The silencing must stop at NOTICE. A host that raises a WARNING on the same
  // connection still hears it — this is not a blanket mute.
  test("WARNING and above still reach the host", async () => {
    const notices: { severity?: string; message?: string }[] = [];
    const client = postgres(DATABASE_URL, {
      onnotice: (notice) => notices.push(notice),
    });
    const handle = drizzle(client);
    try {
      await runArtifactMigrations(handle);
      await handle.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL client_min_messages = warning`);
        await tx.execute(sql`DO $$ BEGIN RAISE NOTICE 'quiet'; END $$`);
        await tx.execute(sql`DO $$ BEGIN RAISE WARNING 'loud'; END $$`);
      });
      expect(notices.map((n) => n.severity)).toEqual(["WARNING"]);
      expect(notices[0]!.message).toBe("loud");
    } finally {
      await client.end();
    }
  });

  test("keeps its ledger inside its own schema, not a shared journal", async () => {
    await runArtifactMigrations(db);
    const rows = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = ${SCHEMA} AND table_name = ${LEDGER}
    `);
    expect(rows[0]!.n).toBe(1);
  });

  test("every migration id is unique and every migration has statements", () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const migration of MIGRATIONS) {
      expect(migration.statements.length).toBeGreaterThan(0);
    }
  });

  test("records a checksum of each migration BODY, not just its id", async () => {
    await runArtifactMigrations(db);
    const ledger = await db.execute<{ id: string; checksum: string | null }>(
      sql`SELECT "id", "checksum" FROM ${sql.identifier(SCHEMA)}.${sql.identifier(LEDGER)} ORDER BY "id"`,
    );
    for (const row of ledger) {
      const migration = MIGRATIONS.find((m) => m.id === row.id)!;
      expect(row.checksum).toBe(migrationChecksum(migration));
    }
  });

  test("an edited shipped migration fails loudly instead of silently diverging", async () => {
    await runArtifactMigrations(db);
    // Simulate the ledger having recorded a DIFFERENT body for 0001: exactly
    // what a deployed database looks like after someone edits a shipped
    // migration. Without a checksum this database would skip it forever while
    // a fresh one gets the new DDL, and nothing would notice.
    await db.execute(
      sql`UPDATE ${sql.identifier(SCHEMA)}.${sql.identifier(LEDGER)} SET "checksum" = 'stale' WHERE "id" = '0001_artifacts'`,
    );
    await expect(runArtifactMigrations(db)).rejects.toThrow(MigrationChecksumError);

    // The advisory lock is released even on the failure path, so the next boot
    // can still run rather than hanging forever.
    await db.execute(
      sql`UPDATE ${sql.identifier(SCHEMA)}.${sql.identifier(LEDGER)} SET "checksum" = ${migrationChecksum(MIGRATIONS[0]!)} WHERE "id" = '0001_artifacts'`,
    );
    await runArtifactMigrations(db);
  });

  test("the ledger has no nullable-checksum escape hatch", async () => {
    // The adopt-silently branch for "ledgers written before checksums existed"
    // is gone: 0.1.0 is the first public release, so no such ledger can exist,
    // and while the column was nullable the runner would accept exactly one
    // edit to a shipped migration without complaint. NOT NULL is what makes the
    // documented immutability guarantee unconditional.
    await runArtifactMigrations(db);
    // Drizzle wraps driver errors, so the NOT NULL violation is on `.cause`,
    // not on the message `toThrow` would match.
    const failure = await db
      .execute(sql`UPDATE ${sql.identifier(SCHEMA)}.${sql.identifier(LEDGER)} SET "checksum" = NULL`)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).not.toBeNull();
    expect(String((failure as { cause?: unknown }).cause)).toMatch(
      /null value in column "checksum"/,
    );
  });

  test("the keyset index carries the id tie-break", async () => {
    await runArtifactMigrations(db);
    const indexes = await db.execute<{ indexname: string; indexdef: string }>(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = ${SCHEMA} AND tablename = 'artifact'
    `);
    const keyset = indexes.find(
      (i) => i.indexname === "artifact_tenant_updated_id_idx",
    );
    expect(keyset?.indexdef).toContain("(tenant_id, updated_at, id)");
  });

  test("the (artifactId, version) uniqueness backstop is really in the database", async () => {
    await runArtifactMigrations(db);
    const constraints = await db.execute<{ conname: string }>(sql`
      SELECT conname FROM pg_constraint
      WHERE conname = 'artifact_version_artifact_id_version'
    `);
    expect(constraints.length).toBe(1);
  });

  /**
   * The coverage guard proper, and the reason it runs against a VIRGIN schema:
   * the shared `public` schema accumulates whatever else has ever been created
   * there, so it can only support a "created everything declared" check. On an
   * empty schema the migrations are the only writer, which makes the comparison
   * an EQUALITY — the guard then catches drift in both directions:
   *
   *  - a table added to `schema.ts` with no migration (nothing creates it), and
   *  - a table created by a migration that `schema.ts` never declares (dead
   *    schema no code can address).
   */
  test("the migrations create exactly the tables schema.ts declares, no more, no less", async () => {
    // The package schema is dropped and rebuilt from empty, so the migrations
    // are its only writer and the comparison is an EQUALITY.
    assertDestructiveArtifactTestsAllowed(DATABASE_URL);
    await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(SCHEMA)} CASCADE`);
    await runArtifactMigrations(db);
    const tables = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${SCHEMA}
    `);
    const created = tables
      .map((t) => t.table_name)
      .filter((name) => name !== LEDGER)
      .sort();
    expect(created).toEqual(DECLARED_TABLES);
  });

  /**
   * Empty ledger + pre-existing package objects is the AUDIT-013 footgun:
   * `CREATE IF NOT EXISTS` no-ops and a naive runner would still stamp the
   * current checksum, so boot "succeeds" while the live shape is wrong.
   * These three cases pin the adopt-or-fail contract.
   */
  test("clean install still migrates when the package schema is empty", async () => {
    assertDestructiveArtifactTestsAllowed(DATABASE_URL);
    await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(SCHEMA)} CASCADE`);
    await runArtifactMigrations(db);

    const ledger = await db.execute<{ id: string; checksum: string }>(
      sql`SELECT "id", "checksum" FROM ${sql.identifier(SCHEMA)}.${sql.identifier(LEDGER)} ORDER BY "id"`,
    );
    expect(ledger.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));
    for (const row of ledger) {
      const migration = MIGRATIONS.find((m) => m.id === row.id)!;
      expect(row.checksum).toBe(migrationChecksum(migration));
    }
  });

  test("empty ledger + wrong shape fails closed and does not write a checksum", async () => {
    assertDestructiveArtifactTestsAllowed(DATABASE_URL);
    await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(SCHEMA)} CASCADE`);
    // Partial / wrong object: schema + a table that is not the package shape.
    await db.execute(sql`CREATE SCHEMA ${sql.identifier(SCHEMA)}`);
    await db.execute(sql`
      CREATE TABLE ${sql.identifier(SCHEMA)}."artifact" (
        "id" text PRIMARY KEY,
        "not_the_real_shape" text
      )
    `);

    await expect(runArtifactMigrations(db)).rejects.toThrow(MigrationAdoptError);
    await expect(
      runArtifactMigrations(db, { adopt: true }),
    ).rejects.toThrow(MigrationAdoptError);

    // No ledger row may have been recorded — including a ledger that was
    // created mid-run and then rolled back with the failed transaction.
    const ledgerTables = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = ${SCHEMA} AND table_name = ${LEDGER}
    `);
    expect(ledgerTables[0]!.n).toBe(0);

    // And the wrong object is still the only package table — runner must not
    // have half-applied real DDL around it.
    const tables = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${SCHEMA}
    `);
    expect(tables.map((t) => t.table_name).sort()).toEqual(["artifact"]);
  });

  test("empty ledger + compatible shape requires explicit adopt; adopt records checksums without re-DDL", async () => {
    assertDestructiveArtifactTestsAllowed(DATABASE_URL);
    await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(SCHEMA)} CASCADE`);
    // Build a correct shape the honest way, then erase the ledger so the next
    // boot sees "objects present, ledger empty" — the adopt path's input.
    await runArtifactMigrations(db);
    await db.execute(
      sql`DROP TABLE ${sql.identifier(SCHEMA)}.${sql.identifier(LEDGER)}`,
    );

    // Without the flag: fail closed even though the shape is right. Silent
    // adoption is how a wrong-but-lucky shape used to get a checksum stamp.
    await expect(runArtifactMigrations(db)).rejects.toThrow(MigrationAdoptError);

    const stillEmpty = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = ${SCHEMA} AND table_name = ${LEDGER}
    `);
    expect(stillEmpty[0]!.n).toBe(0);

    // With the flag: shape validates, ledger is written, objects stay put.
    await runArtifactMigrations(db, { adopt: true });

    const ledger = await db.execute<{ id: string; checksum: string }>(
      sql`SELECT "id", "checksum" FROM ${sql.identifier(SCHEMA)}.${sql.identifier(LEDGER)} ORDER BY "id"`,
    );
    expect(ledger.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));
    for (const row of ledger) {
      const migration = MIGRATIONS.find((m) => m.id === row.id)!;
      expect(row.checksum).toBe(migrationChecksum(migration));
    }

    // Re-run (no adopt needed once ledgered) remains a quiet no-op.
    await runArtifactMigrations(db);
    const again = await db.execute<{ id: string }>(
      sql`SELECT "id" FROM ${sql.identifier(SCHEMA)}.${sql.identifier(LEDGER)}`,
    );
    expect(again.length).toBe(MIGRATIONS.length);
  });

  test("empty ledger + columns without 0003 CHECKs refuses adopt", async () => {
    assertDestructiveArtifactTestsAllowed(DATABASE_URL);
    await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(SCHEMA)} CASCADE`);
    // Honest migrate, drop ledger, then strip a row-local CHECK so columns and
    // types still match but 0003 invariants are gone — adopt must not stamp.
    await runArtifactMigrations(db);
    await db.execute(
      sql`DROP TABLE ${sql.identifier(SCHEMA)}.${sql.identifier(LEDGER)}`,
    );
    await db.execute(sql`
      ALTER TABLE ${sql.identifier(SCHEMA)}."artifact"
        DROP CONSTRAINT "artifact_version_gte_1"
    `);

    await expect(
      runArtifactMigrations(db, { adopt: true }),
    ).rejects.toThrow(MigrationAdoptError);
    await expect(
      runArtifactMigrations(db, { adopt: true }),
    ).rejects.toThrow(/artifact_version_gte_1/);

    const ledgerTables = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = ${SCHEMA} AND table_name = ${LEDGER}
    `);
    expect(ledgerTables[0]!.n).toBe(0);

    // Later tests call runArtifactMigrations without a reset; restore a
    // fully-ledgered schema so they are not stranded on an empty ledger.
    await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(SCHEMA)} CASCADE`);
    await runArtifactMigrations(db);
  });

  test("empty ledger + nullable tenant_id refuses adopt", async () => {
    assertDestructiveArtifactTestsAllowed(DATABASE_URL);
    await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(SCHEMA)} CASCADE`);
    await runArtifactMigrations(db);
    await db.execute(
      sql`DROP TABLE ${sql.identifier(SCHEMA)}.${sql.identifier(LEDGER)}`,
    );
    await db.execute(sql`
      ALTER TABLE ${sql.identifier(SCHEMA)}."artifact"
        ALTER COLUMN "tenant_id" DROP NOT NULL
    `);

    await expect(
      runArtifactMigrations(db, { adopt: true }),
    ).rejects.toThrow(MigrationAdoptError);
    await expect(
      runArtifactMigrations(db, { adopt: true }),
    ).rejects.toThrow(/tenant_id.*NOT NULL/i);

    const ledgerTables = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = ${SCHEMA} AND table_name = ${LEDGER}
    `);
    expect(ledgerTables[0]!.n).toBe(0);

    await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(SCHEMA)} CASCADE`);
    await runArtifactMigrations(db);
  });

  /**
   * DB invariants: tenant_id is required on every artifact row; version and size
   * stay non-negative. Principal↔tenant alignment is host middleware/context
   * (TenantEnv) — no multi-table trigger here.
   */
  test("null tenant_id on artifact is rejected after migrations", async () => {
    await runArtifactMigrations(db);
    const failure = await db
      .execute(sql`
        INSERT INTO "artifacts"."artifact"
          ("tenant_id", "kind", "title", "content", "version")
        VALUES (NULL, 'document', 'orphan', 'body', 1)
      `)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).not.toBeNull();
    expect(String((failure as { cause?: unknown }).cause)).toMatch(
      /null value in column "tenant_id"/,
    );
  });

  test("version and size CHECK constraints reject impossible values", async () => {
    await runArtifactMigrations(db);

    const badArtifactVersion = await db
      .execute(sql`
        INSERT INTO "artifacts"."artifact"
          ("tenant_id", "kind", "title", "content", "version")
        VALUES ('acme', 'document', 'bad-ver', 'body', 0)
      `)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(badArtifactVersion).not.toBeNull();
    expect(String((badArtifactVersion as { cause?: unknown }).cause)).toMatch(
      /artifact_version_gte_1|check constraint/i,
    );

    // A legal artifact so we can try a bad history row and a bad upload.
    const [row] = await db.execute<{ id: string }>(sql`
      INSERT INTO "artifacts"."artifact"
        ("tenant_id", "kind", "title", "content", "version")
      VALUES ('acme', 'document', 'ok', 'body', 1)
      RETURNING "id"
    `);

    const badHistory = await db
      .execute(sql`
        INSERT INTO "artifacts"."artifact_version"
          ("artifact_id", "version", "title", "content", "author_id")
        VALUES (${row!.id}, 0, 'ok', 'body', 'user-1')
      `)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(badHistory).not.toBeNull();
    expect(String((badHistory as { cause?: unknown }).cause)).toMatch(
      /artifact_version_version_gte_1|check constraint/i,
    );

    const badUpload = await db
      .execute(sql`
        INSERT INTO "artifacts"."upload"
          ("tenant_id", "filename", "mime_type", "content", "size")
        VALUES ('acme', 'x.bin', 'application/octet-stream', decode('00', 'hex'), -1)
      `)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(badUpload).not.toBeNull();
    expect(String((badUpload as { cause?: unknown }).cause)).toMatch(
      /upload_size_gte_0|check constraint/i,
    );

    const badRef = await db
      .execute(sql`
        INSERT INTO "artifacts"."mail_attachment_ref"
          ("tenant_id", "instance_id", "mail_id", "artifact_id",
           "name", "mime_type", "size")
        VALUES ('acme', 'inst', 'mail', ${row!.id}, 'a.bin',
                'application/octet-stream', -1)
      `)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(badRef).not.toBeNull();
    expect(String((badRef as { cause?: unknown }).cause)).toMatch(
      /mail_attachment_ref_size_gte_0|check constraint/i,
    );
  });

  test("migration fails clearly when null tenant_id rows already exist", async () => {
    assertDestructiveArtifactTestsAllowed(DATABASE_URL);
    await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(SCHEMA)} CASCADE`);

    // Apply only the baseline + timestamptz migrations so tenant_id is still
    // nullable, plant a null-tenant row, then attempt the full runner (which
    // must include the invariants migration).
    const preInvariant = MIGRATIONS.filter(
      (m) => m.id === "0001_artifacts" || m.id === "0002_timestamptz",
    );
    expect(preInvariant.length).toBe(2);
    expect(MIGRATIONS.some((m) => m.id === "0003_schema_invariants")).toBe(true);

    await db.transaction(async (tx) => {
      await tx.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(SCHEMA)}`);
      await tx.execute(sql`
        CREATE TABLE IF NOT EXISTS ${sql.identifier(SCHEMA)}.${sql.identifier(LEDGER)} (
          "id" text PRIMARY KEY,
          "checksum" text NOT NULL,
          "applied_at" timestamptz NOT NULL DEFAULT now()
        )
      `);
      for (const migration of preInvariant) {
        for (const statement of migration.statements) {
          await tx.execute(statement);
        }
        await tx.execute(sql`
          INSERT INTO ${sql.identifier(SCHEMA)}.${sql.identifier(LEDGER)}
            ("id", "checksum")
          VALUES (${migration.id}, ${migrationChecksum(migration)})
        `);
      }
    });

    await db.execute(sql`
      INSERT INTO "artifacts"."artifact"
        ("tenant_id", "kind", "title", "content", "version")
      VALUES (NULL, 'document', 'orphan', 'body', 1)
    `);

    const failure = await runArtifactMigrations(db).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).not.toBeNull();
    expect(String(failure)).toMatch(/null tenant_id/i);

    // The invariants migration must not be stamped when the guard fails.
    const ledger = await db.execute<{ id: string }>(
      sql`SELECT "id" FROM ${sql.identifier(SCHEMA)}.${sql.identifier(LEDGER)} ORDER BY "id"`,
    );
    expect(ledger.map((r) => r.id)).toEqual([
      "0001_artifacts",
      "0002_timestamptz",
    ]);

    // Full suite (and re-runs of this file) must not inherit null-tenant rows
    // and a half-applied ledger.
    await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(SCHEMA)} CASCADE`);
    await runArtifactMigrations(db);
  });
});
