import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createArtifactDb, runArtifactMigrations } from "../src/index.js";
import { seedActor } from "./fixtures.js";
import { connectionString, createTestDb, type TestDb } from "./helpers.js";

const TABLES = ["artifact", "artifact_version", "upload"];

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb?.close();
});

async function packageTables(): Promise<string[]> {
  const rows = await testDb.db.execute<{ table_name: string }>(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'artifacts'
    ORDER BY table_name
  `);
  return rows.map((row) => row.table_name);
}

describe("runArtifactMigrations", () => {
  test("creates the artifacts schema and its tables", async () => {
    expect(await packageTables()).toEqual(TABLES);
  });

  test("applying twice changes nothing and keeps existing rows", async () => {
    const { tenant } = await seedActor(testDb.db, "acme");
    await testDb.db.execute(sql`
      INSERT INTO "artifacts"."artifact" ("tenant_id", "kind", "title", "content")
      VALUES (${tenant.id}, 'document', 'kept', 'body')
    `);

    await runArtifactMigrations(testDb.config, { schema: "public" });
    await runArtifactMigrations(testDb.config, { schema: "public" });

    expect(await packageTables()).toEqual(TABLES);
    const rows = await testDb.db.execute<{ title: string }>(
      sql`SELECT "title" FROM "artifacts"."artifact"`,
    );
    expect(rows.map((row) => row.title)).toEqual(["kept"]);
  });

  test("brings a database from before 0.1.0 up to 0.1.0's columns", async () => {
    await testDb.db.execute(sql`
      ALTER TABLE "artifacts"."artifact"
        DROP COLUMN "metadata", DROP COLUMN "content_sha256",
        ALTER COLUMN "created_at" TYPE timestamp
    `);
    await testDb.db.execute(sql`
      ALTER TABLE "artifacts"."artifact_version"
        DROP COLUMN "metadata", DROP COLUMN "parent_version_ids", DROP COLUMN "content_sha256"
    `);
    await runArtifactMigrations(testDb.config, { schema: "public" });
    const columns = await testDb.db.execute<{
      column: string;
      type: string;
    }>(sql`
      SELECT table_name || '.' || column_name AS column, udt_name AS type
      FROM information_schema.columns
      WHERE table_schema = 'artifacts'
        AND column_name IN ('metadata', 'parent_version_ids', 'content_sha256', 'created_at')
        AND table_name IN ('artifact', 'artifact_version')
      ORDER BY 1
    `);
    expect(columns.map((c) => `${c.column} ${c.type}`)).toEqual([
      "artifact.content_sha256 text",
      "artifact.created_at timestamptz",
      "artifact.metadata jsonb",
      "artifact_version.content_sha256 text",
      "artifact_version.created_at timestamptz",
      "artifact_version.metadata jsonb",
      "artifact_version.parent_version_ids _text",
    ]);
  });

  const invariants = async () => {
    const checks = await testDb.db.execute<{ conname: string }>(sql`
      SELECT conname FROM pg_constraint
      WHERE conname IN ('artifact_version_gte_1', 'artifact_version_version_gte_1', 'upload_size_gte_0')
      ORDER BY conname
    `);
    const [tenant] = await testDb.db.execute<{ is_nullable: string }>(sql`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'artifacts' AND table_name = 'artifact' AND column_name = 'tenant_id'
    `);
    return {
      checks: checks.map((row) => row.conname),
      tenantNullable: tenant?.is_nullable,
    };
  };

  test("restores 0.1.0's CHECK constraints and tenant_id NOT NULL", async () => {
    await testDb.db.execute(sql`
      ALTER TABLE "artifacts"."artifact"
        DROP CONSTRAINT "artifact_version_gte_1",
        ALTER COLUMN "tenant_id" DROP NOT NULL
    `);
    await testDb.db.execute(sql`
      ALTER TABLE "artifacts"."artifact_version" DROP CONSTRAINT "artifact_version_version_gte_1"
    `);
    await testDb.db.execute(sql`
      ALTER TABLE "artifacts"."upload" DROP CONSTRAINT "upload_size_gte_0"
    `);
    await runArtifactMigrations(testDb.config, { schema: "public" });
    expect(await invariants()).toEqual({
      checks: [
        "artifact_version_gte_1",
        "artifact_version_version_gte_1",
        "upload_size_gte_0",
      ],
      tenantNullable: "NO",
    });
  });

  test("leaves tenant_id nullable and warns while null tenants remain", async () => {
    await testDb.db.execute(sql`
      ALTER TABLE "artifacts"."artifact" ALTER COLUMN "tenant_id" DROP NOT NULL
    `);
    await testDb.db.execute(sql`
      INSERT INTO "artifacts"."artifact" ("tenant_id", "kind", "title", "content")
      VALUES (NULL, 'document', 'orphan', 'body')
    `);
    const warnings: unknown[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args[0]);
    try {
      await runArtifactMigrations(testDb.config, { schema: "public" });
    } finally {
      console.warn = warn;
    }
    expect((await invariants()).tenantNullable).toBe("YES");
    expect(String(warnings[0])).toContain("null tenant_id");

    await testDb.db.execute(
      sql`DELETE FROM "artifacts"."artifact" WHERE "tenant_id" IS NULL`,
    );
    await runArtifactMigrations(testDb.config, { schema: "public" });
    expect((await invariants()).tenantNullable).toBe("NO");
  });

  test("a host boots with createArtifactDb after migrating, and close releases it", async () => {
    const { db, close } = createArtifactDb(connectionString(testDb.config));
    try {
      const rows = await db.execute<{ table_name: string }>(sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'artifacts'
        ORDER BY table_name
      `);
      expect(rows.map((row) => row.table_name)).toEqual(TABLES);
    } finally {
      await close();
    }
  });
});
