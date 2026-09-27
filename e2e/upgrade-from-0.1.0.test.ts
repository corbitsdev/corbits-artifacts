// A database migrated and written by the published 0.1.0 package upgrades in
// place under this version's runArtifactMigrations.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema as intx } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { sql } from "drizzle-orm";
import * as v010 from "@corbits/artifacts-0.1.0";
import { runArtifactMigrations } from "../src/index.js";
import { grant, seedActor, type Actor } from "./fixtures.js";
import {
  artifactApp,
  connectionString,
  createTestDb,
  type TestDb,
} from "./helpers.js";

const PDF = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0xff,
]);

let testDb: TestDb;
let actor: Actor;
let fileId: string;
let newcomer: Actor;

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
  // 0.1.0 needed no create grant; the upgrade has to supply it.
  await testDb.db.execute(sql`DELETE FROM "grant" WHERE action = 'create'`);
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
    await v010.writeArtifactVersion(legacy.db, {
      scope,
      artifactId: file.id,
      title: "deck v2.pdf",
    });
    await v010.saveMailAttachmentRefs(legacy.db, {
      scope,
      instanceId: "inst-1",
      body: {
        mailId: "mail-1",
        attachments: [
          {
            artifactId: file.id,
            name: "deck.pdf",
            type: "application/pdf",
            size: PDF.length,
          },
        ],
      },
    });
  } finally {
    await legacy.close();
  }

  await runArtifactMigrations(testDb.config, { schema: "public" });
  const [principal] = await testDb.db
    .insert(intx.principal)
    .values({
      id: generateId("principal"),
      tenantId: actor.tenant.id,
      kind: "user",
      refId: "user-newcomer",
      status: "active",
    })
    .returning();
  newcomer = { tenant: actor.tenant, principal: principal! };
});

afterAll(async () => {
  await testDb?.close();
});

const createDoc = (as: Actor) =>
  artifactApp(testDb.db, as).request("/api/artifacts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "text",
      title: "After upgrade",
      content: "hi",
    }),
  });

describe("upgrading a 0.1.0 database", () => {
  test("a 0.1.0 creator keeps creating; a new principal needs the grant", async () => {
    expect((await createDoc(actor)).status).toBe(201);
    expect((await createDoc(newcomer)).status).toBe(403);
  });

  test("rerunning the migrations grants nothing new", async () => {
    const count = async () =>
      (
        await testDb.db.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM "grant"
          WHERE resource = 'artifact:*' AND action = 'create'
        `)
      )[0]!.n;
    const before = await count();
    await runArtifactMigrations(testDb.config, { schema: "public" });
    expect(await count()).toBe(before);
  });

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

  test("every version of a 0.1.0 upload downloads its bytes", async () => {
    const app = artifactApp(testDb.db, actor);
    for (const query of ["?version=1", "?version=2", ""]) {
      const res = await app.request(
        `/api/artifacts/${fileId}/download${query}`,
      );
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
    }
  });

  test("revising a 0.1.0 upload with new bytes keeps version 1's bytes", async () => {
    const app = artifactApp(testDb.db, actor);
    const revised = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x32]);
    const form = new FormData();
    form.append(
      "file",
      new File([revised], "deck.pdf", { type: "application/pdf" }),
    );
    const res = await app.request(`/api/artifacts/${fileId}/versions`, {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: 3 });

    const bytesOf = async (query: string) =>
      new Uint8Array(
        await (
          await app.request(`/api/artifacts/${fileId}/download${query}`)
        ).arrayBuffer(),
      );
    expect(await bytesOf("?version=1")).toEqual(PDF);
    expect(await bytesOf("?version=3")).toEqual(revised);
    expect(await bytesOf("")).toEqual(revised);
  });
});
