import { describe, expect, test } from "bun:test";
import { getTableName, is, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { PgTable } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { createArtifactDb } from "../src/db.js";
import {
  migrationChecksum,
  MigrationChecksumError,
  MIGRATIONS,
  runArtifactMigrations,
} from "../src/migrations.js";
import * as schema from "../src/schema.js";
import { DATABASE_URL } from "./helpers.js";

const LEDGER = "corbits_artifact_core_migrations";

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
      WHERE table_schema = 'public'
    `);
    const names = new Set(tables.map((t) => t.table_name));
    expect(DECLARED_TABLES.length).toBeGreaterThan(0);
    for (const table of [...DECLARED_TABLES, LEDGER]) {
      expect({ table, created: names.has(table) }).toEqual({ table, created: true });
    }

    const ledger = await db.execute<{ id: string }>(
      sql`SELECT "id" FROM ${sql.identifier(LEDGER)} ORDER BY "id"`,
    );
    expect(ledger.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));
  });

  test("re-running is a no-op: no duplicate ledger rows, no error", async () => {
    await runArtifactMigrations(db);
    await runArtifactMigrations(db);
    await runArtifactMigrations(db);

    const ledger = await db.execute<{ id: string }>(
      sql`SELECT "id" FROM ${sql.identifier(LEDGER)}`,
    );
    expect(ledger.length).toBe(MIGRATIONS.length);
  });

  // Four cold starts against a schema that does not contain a single one of
  // this package's tables — the real first-boot race. Without the advisory
  // lock this fails: `CREATE TABLE IF NOT EXISTS` checks the catalogue and
  // inserts into pg_type non-atomically, so the losers get a 23505 duplicate
  // key on pg_type_typname_nsp_index. It is the lock, not the IF NOT EXISTS,
  // that makes the runner safe to call from every instance at once.
  test("concurrent first boots against a fresh schema all succeed", async () => {
    const schema = `artifact_race_${Date.now()}`;
    await db.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`);
    // Each handle is its own pool, resolving unqualified names into the fresh
    // schema, so all four genuinely believe they are the first boot.
    const handles = [0, 1, 2, 3].map(() =>
      createArtifactDb(`${DATABASE_URL}?options=-c%20search_path%3D${schema}`),
    );
    try {
      await Promise.all(handles.map((h) => runArtifactMigrations(h.db)));

      const ledger = await handles[0]!.db.execute<{ id: string }>(
        sql`SELECT "id" FROM ${sql.identifier(schema)}.${sql.identifier(LEDGER)} ORDER BY "id"`,
      );
      expect(ledger.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));

      const tables = await db.execute<{ table_name: string }>(sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = ${schema}
      `);
      const names = new Set(tables.map((t) => t.table_name));
      for (const table of [...DECLARED_TABLES, LEDGER]) {
        expect({ table, created: names.has(table) }).toEqual({ table, created: true });
      }
    } finally {
      await Promise.all(handles.map((h) => h.close()));
      await db.execute(sql`DROP SCHEMA ${sql.identifier(schema)} CASCADE`);
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
        sql`UPDATE ${sql.identifier(LEDGER)} SET "checksum" = 'stale'
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
        sql`UPDATE ${sql.identifier(LEDGER)} SET "checksum" = ${migrationChecksum(MIGRATIONS[0]!)}
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

  test("uses its own ledger, not a shared or drizzle-managed journal", () => {
    expect(LEDGER).toBe("corbits_artifact_core_migrations");
    expect(LEDGER).not.toBe("corbits_mailbox_core_migrations");
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
      sql`SELECT "id", "checksum" FROM ${sql.identifier(LEDGER)} ORDER BY "id"`,
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
      sql`UPDATE ${sql.identifier(LEDGER)} SET "checksum" = 'stale' WHERE "id" = '0001_artifact_core'`,
    );
    await expect(runArtifactMigrations(db)).rejects.toThrow(MigrationChecksumError);

    // The advisory lock is released even on the failure path, so the next boot
    // can still run rather than hanging forever.
    await db.execute(
      sql`UPDATE ${sql.identifier(LEDGER)} SET "checksum" = ${migrationChecksum(MIGRATIONS[0]!)} WHERE "id" = '0001_artifact_core'`,
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
      .execute(sql`UPDATE ${sql.identifier(LEDGER)} SET "checksum" = NULL`)
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
      WHERE tablename = 'artifact'
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
    const isolated = `artifact_coverage_${Date.now()}`;
    await db.execute(sql`CREATE SCHEMA ${sql.identifier(isolated)}`);
    const handle = createArtifactDb(
      `${DATABASE_URL}?options=-c%20search_path%3D${isolated}`,
    );
    try {
      await runArtifactMigrations(handle.db);
      const tables = await db.execute<{ table_name: string }>(sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = ${isolated}
      `);
      const created = tables
        .map((t) => t.table_name)
        .filter((name) => name !== LEDGER)
        .sort();
      expect(created).toEqual(DECLARED_TABLES);
    } finally {
      await handle.close();
      await db.execute(sql`DROP SCHEMA ${sql.identifier(isolated)} CASCADE`);
    }
  });
});
