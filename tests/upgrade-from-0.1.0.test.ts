// A database migrated and written by the published 0.1.0 package upgrades in
// place under this version's runArtifactMigrations.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import * as v010 from "@corbits/artifacts-0.1.0";
import { runArtifactMigrations } from "../src/index.js";
import {
  artifactApp,
  connectionString,
  createTestDb,
  grant,
  seedActor,
  type Actor,
  type TestDb,
} from "./lib/db-harness.js";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0xff]);

let testDb: TestDb;
let actor: Actor;
let fileId: string;

beforeAll(async () => {
  testDb = await createTestDb(async (config) => {
    const legacy = v010.createArtifactDb(connectionString(config));
    try {
      await v010.runArtifactMigrations(legacy.db);
    } finally {
      await legacy.close();
    }
  });
  actor = await seedActor(testDb.db, "acme");
  await grant(testDb.db, actor, "artifact:*", "write");
  const scope = { tenantId: actor.tenant.id, principalId: actor.principal.id };

  const legacy = v010.createArtifactDb(connectionString(testDb.config));
  try {
    const file = await legacy.db.transaction((tx) =>
      v010.createFileArtifact(tx, v010.InlineContentStore, {
        scope,
        ownerPrincipalId: scope.principalId,
        filename: "deck.pdf",
        mimeType: "application/pdf",
        bytes: PDF,
        policy: v010.ARTIFACT_UPLOAD_POLICY,
      }),
    );
    fileId = file.id;
    await v010.saveMailAttachmentRefs(legacy.db, {
      scope,
      instanceId: "inst-1",
      body: {
        mailId: "mail-1",
        attachments: [
          { artifactId: file.id, name: "deck.pdf", type: "application/pdf", size: PDF.length },
        ],
      },
    });
  } finally {
    await legacy.close();
  }

  await runArtifactMigrations(testDb.config, { schema: "public" });
});

afterAll(async () => {
  await testDb?.close();
});

describe("upgrading a 0.1.0 database", () => {
  test("drops mail_attachment_ref and the 0.1.0 migration ledger", async () => {
    const rows = await testDb.db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'artifacts'
      ORDER BY table_name
    `);
    expect(rows.map((row) => row.table_name)).toEqual([
      "artifact",
      "artifact_version",
      "upload",
    ]);
  });

  test("a 0.1.0 upload still downloads its bytes", async () => {
    const res = await artifactApp(testDb.db, actor).request(`/api/artifacts/${fileId}/download`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
  });
});
