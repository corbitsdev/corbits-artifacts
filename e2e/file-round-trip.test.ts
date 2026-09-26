import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { grant, seedActor } from "./fixtures.js";
import {
  artifactApp,
  createTestDb,
  type TestDb,
  createFsContentStore,
} from "./helpers.js";

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
  test("each version downloads its own bytes", async () => {
    const v1Bytes = new Uint8Array([
      0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10, 0x80,
    ]);
    const v3Bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x01, 0x02]);
    const form = new FormData();
    form.append(
      "files",
      new File([v1Bytes], "report.pdf", { type: "application/pdf" }),
    );
    const uploaded = await app.request("/api/artifacts/upload", {
      method: "POST",
      body: form,
    });
    expect(uploaded.status).toBe(201);
    const { artifacts } = (await uploaded.json()) as {
      artifacts: { id: string }[];
    };
    const id = artifacts[0]!.id;

    const renamed = await app.request(`/api/artifacts/${id}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "report (final).pdf" }),
    });
    expect(renamed.status).toBe(200);

    const revise = new FormData();
    revise.append(
      "file",
      new File([v3Bytes], "report.pdf", { type: "application/pdf" }),
    );
    const revised = await app.request(`/api/artifacts/${id}/versions`, {
      method: "POST",
      body: revise,
    });
    expect(revised.status).toBe(200);
    expect(await revised.json()).toMatchObject({ version: 3 });

    for (const [version, bytes] of [
      [1, v1Bytes],
      [2, v1Bytes],
      [3, v3Bytes],
      [undefined, v3Bytes],
    ] as const) {
      const res = await download(id, version);
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    }

    const sources = [];
    for (const version of [1, 3]) {
      const res = await app.request(`/api/artifacts/${id}/versions/${version}`);
      expect(res.status).toBe(200);
      sources.push(
        ((await res.json()) as { artifact: { source: unknown } }).artifact
          .source,
      );
    }
    expect(sources[0]).toMatchObject({ upload: { size: v1Bytes.length } });
    expect(sources[1]).toMatchObject({ upload: { size: v3Bytes.length } });

    const storedFiles = async () =>
      (await readdir(dir, { recursive: true })).length;
    const before = await storedFiles();
    const stale = new FormData();
    stale.append(
      "file",
      new File([v3Bytes], "report.pdf", { type: "application/pdf" }),
    );
    stale.append("expectedVersion", "1");
    const conflict = await app.request(`/api/artifacts/${id}/versions`, {
      method: "POST",
      body: stale,
    });
    expect(conflict.status).toBe(409);
    expect(await storedFiles()).toBe(before);
  });
});
