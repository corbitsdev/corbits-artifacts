import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { runArtifactMigrations } from "../src/index.js";
import { createTestDb, seedActor, type TestDb } from "./lib/db-harness.js";

const TABLES = ["artifact", "artifact_version", "mail_attachment_ref", "upload"];

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.close();
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
});
