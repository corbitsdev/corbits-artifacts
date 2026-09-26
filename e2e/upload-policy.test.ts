import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { MAX_UPLOAD_BYTES } from "../src/index.js";
import { seedActor } from "./fixtures.js";
import { artifactApp, createTestDb, type TestDb } from "./helpers.js";

let testDb: TestDb;
let app: Hono<TenantEnv>;

beforeAll(async () => {
  testDb = await createTestDb();
  app = artifactApp(testDb.db, await seedActor(testDb.db, "acme"));
});

afterAll(async () => {
  await testDb?.close();
});

async function upload(file: File): Promise<Response> {
  const form = new FormData();
  form.append("files", file);
  return await app.request("/api/artifacts/upload", {
    method: "POST",
    body: form,
  });
}

async function artifactCount(): Promise<number> {
  const res = await app.request("/api/artifacts?limit=100");
  return ((await res.json()) as { artifacts: unknown[] }).artifacts.length;
}

describe("upload policy through the mounted app", () => {
  test("an oversize file is 413 and stores nothing", async () => {
    const big = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "big.pdf", {
      type: "application/pdf",
    });
    expect((await upload(big)).status).toBe(413);
    expect(await artifactCount()).toBe(0);
  });

  test("a disallowed MIME type is 415 and stores nothing", async () => {
    const script = new File(["#!/bin/sh\n"], "run.sh", {
      type: "application/x-sh",
    });
    expect((await upload(script)).status).toBe(415);
    expect(await artifactCount()).toBe(0);
  });
});
