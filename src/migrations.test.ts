import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { createArtifactDb } from "./db.js";
import { runArtifactMigrations } from "./migrations.js";
import * as schema from "./schema.js";
import {
  assertDestructiveArtifactTestsAllowed,
  databaseConfig,
  DATABASE_URL,
  ensureControlPlane,
} from "./test-helpers.js";

const SCHEMA = "artifacts";
const config = databaseConfig(DATABASE_URL);

/**
 * DERIVED FROM `schema.ts`, never restated, so a table added to the schema
 * without a migration (or the reverse) turns the equality check red.
 */
const DECLARED_TABLES = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable))
  .map(getTableName)
  .sort();

const { db, close } = createArtifactDb(DATABASE_URL);

async function packageTables(): Promise<string[]> {
  const rows = await db.execute<{ table_name: string }>(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = ${SCHEMA}
  `);
  return rows.map((r) => r.table_name).sort();
}

async function rejection(query: ReturnType<typeof sql>): Promise<string> {
  return await db.execute(query).then(
    () => "",
    (error: unknown) => String((error as { cause?: unknown }).cause),
  );
}

beforeAll(async () => {
  assertDestructiveArtifactTestsAllowed(DATABASE_URL);
  await ensureControlPlane(db);
});

afterAll(close);

describe("runArtifactMigrations", () => {
  test("creates exactly the tables schema.ts declares, and re-running is a no-op", async () => {
    await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(SCHEMA)} CASCADE`);
    await runArtifactMigrations(config, { schema: "public" });
    await runArtifactMigrations(config, { schema: "public" });

    expect(DECLARED_TABLES.length).toBeGreaterThan(0);
    expect(await packageTables()).toEqual(DECLARED_TABLES);
  });

  // It is the advisory lock, not IF NOT EXISTS, that makes concurrent cold
  // starts safe: the catalogue check and insert are not atomic.
  test("concurrent first boots against a fresh database all succeed", async () => {
    await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(SCHEMA)} CASCADE`);
    await Promise.all(
      [0, 1, 2, 3].map(() => runArtifactMigrations(config, { schema: "public" })),
    );
    expect(await packageTables()).toEqual(DECLARED_TABLES);
  });

  test("drops the migration ledger earlier releases kept", async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "artifacts"."migrations" ("id" text PRIMARY KEY)
    `);
    await runArtifactMigrations(config, { schema: "public" });
    expect(await packageTables()).toEqual(DECLARED_TABLES);
  });

  test("points the tenant and principal foreign keys at the host schema", async () => {
    const host = "artifact_host_test";
    await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(SCHEMA)} CASCADE`);
    await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(host)} CASCADE`);
    await db.execute(sql`CREATE SCHEMA ${sql.identifier(host)}`);
    await db.execute(sql`CREATE TABLE ${sql.identifier(host)}."tenant" ("id" text PRIMARY KEY)`);
    await db.execute(
      sql`CREATE TABLE ${sql.identifier(host)}."principal" ("id" text PRIMARY KEY)`,
    );
    try {
      await runArtifactMigrations(config, { schema: host });
      const targets = await db.execute<{ target: string }>(sql`
        SELECT DISTINCT tn.nspname AS target
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_class t ON t.oid = con.confrelid
        JOIN pg_namespace tn ON tn.oid = t.relnamespace
        WHERE con.contype = 'f' AND n.nspname = ${SCHEMA} AND t.relname IN ('tenant', 'principal')
      `);
      expect(targets.map((r) => r.target)).toEqual([host]);
    } finally {
      await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(SCHEMA)} CASCADE`);
      await db.execute(sql`DROP SCHEMA ${sql.identifier(host)} CASCADE`);
      await runArtifactMigrations(config, { schema: "public" });
    }
  });

  test("refuses an empty schema name", async () => {
    await expect(runArtifactMigrations(config, { schema: "" })).rejects.toThrow(
      "schema name must not be empty",
    );
  });

  test("the keyset index carries the id tie-break", async () => {
    const [keyset] = await db.execute<{ indexdef: string }>(sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = ${SCHEMA} AND indexname = 'artifact_tenant_updated_id_idx'
    `);
    expect(keyset?.indexdef).toContain("(tenant_id, updated_at, id)");
  });

  test("tenant_id NOT NULL and the version and size CHECKs are enforced", async () => {
    expect(
      await rejection(sql`
        INSERT INTO "artifacts"."artifact" ("tenant_id", "kind", "title", "content")
        VALUES (NULL, 'document', 'orphan', 'body')
      `),
    ).toMatch(/null value in column "tenant_id"/);
    expect(
      await rejection(sql`
        INSERT INTO "artifacts"."artifact" ("tenant_id", "kind", "title", "content", "version")
        VALUES ('acme', 'document', 'bad', 'body', 0)
      `),
    ).toMatch(/artifact_version_gte_1/);

    const [row] = await db.execute<{ id: string }>(sql`
      INSERT INTO "artifacts"."artifact" ("tenant_id", "kind", "title", "content")
      VALUES ('acme', 'document', 'ok', 'body')
      RETURNING "id"
    `);
    expect(
      await rejection(sql`
        INSERT INTO "artifacts"."artifact_version"
          ("artifact_id", "version", "title", "content", "author_id")
        VALUES (${row!.id}, 0, 'ok', 'body', 'user-1')
      `),
    ).toMatch(/artifact_version_version_gte_1/);
    expect(
      await rejection(sql`
        INSERT INTO "artifacts"."upload" ("tenant_id", "filename", "mime_type", "content", "size")
        VALUES ('acme', 'x.bin', 'application/octet-stream', decode('00', 'hex'), -1)
      `),
    ).toMatch(/upload_size_gte_0/);
    expect(
      await rejection(sql`
        INSERT INTO "artifacts"."mail_attachment_ref"
          ("tenant_id", "instance_id", "mail_id", "artifact_id", "name", "mime_type", "size")
        VALUES ('acme', 'inst', 'mail', ${row!.id}, 'a.bin', 'application/octet-stream', -1)
      `),
    ).toMatch(/mail_attachment_ref_size_gte_0/);
  });
});
