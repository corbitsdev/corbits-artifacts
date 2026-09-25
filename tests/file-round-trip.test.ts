import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { artifactApp, createTestDb, grant, seedActor, type TestDb } from "./lib/db-harness.js";
import { createFsContentStore } from "./lib/fs-content-store.js";

let testDb: TestDb;
let dir: string;
let app: Hono<TenantEnv>;

beforeAll(async () => {
  testDb = await createTestDb();
  dir = await mkdtemp(join(tmpdir(), "artifact-store-"));
  const actor = await seedActor(testDb.db, "acme");
  await grant(testDb.db, actor, "artifact:*", "write");
  app = artifactApp(testDb.db, actor, createFsContentStore(dir));
});

afterAll(async () => {
  await testDb?.close();
  await rm(dir, { recursive: true, force: true });
});

async function download(id: string, version?: number): Promise<Response> {
  const query = version === undefined ? "" : `?version=${version}`;
  return await app.request(`/api/artifacts/${id}/download${query}`);
}

describe("upload, version, download on a filesystem ContentStore", () => {
  test("the uploaded bytes come back unchanged across a new version", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10, 0x80]);
    const form = new FormData();
    form.append("files", new File([bytes], "report.pdf", { type: "application/pdf" }));
    const uploaded = await app.request("/api/artifacts/upload", { method: "POST", body: form });
    expect(uploaded.status).toBe(201);
    const { artifacts } = (await uploaded.json()) as { artifacts: { id: string }[] };
    const id = artifacts[0]!.id;

    const v1 = await download(id, 1);
    expect(v1.status).toBe(200);
    expect(new Uint8Array(await v1.arrayBuffer())).toEqual(bytes);

    const revised = await app.request(`/api/artifacts/${id}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "report (final).pdf" }),
    });
    expect(revised.status).toBe(200);

    const v2 = await download(id, 2);
    expect(v2.status).toBe(200);
    expect(new Uint8Array(await v2.arrayBuffer())).toEqual(bytes);

    // Uploaded bytes live in the store, not in version history, so an older
    // version of a stored file is refused rather than served as current bytes.
    expect((await download(id, 1)).status).toBe(400);
  });
});
