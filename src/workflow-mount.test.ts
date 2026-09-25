import { describe, expect, test } from "bun:test";
import {
  createWorkflowArtifactRoutes,
  type ResolvedWorkflowRunScope,
} from "./workflow-mount.js";
import { InlineContentStore } from "./content-store.js";
import { getArtifact } from "./artifacts.js";
import { seedArtifact, testDb } from "./test-helpers.js";
import type { ArtifactDb } from "./db.js";

const RUN_SCOPE: ResolvedWorkflowRunScope = {
  tenantId: "acme",
  principalId: "user-1",
  runId: "run-1",
};

const VALID_TOKEN = "sidecar-token";
const VALID_ADDRESS = "run-1@acme";

function host(db: ArtifactDb, opts: { resolves?: ResolvedWorkflowRunScope | null } = {}) {
  return createWorkflowArtifactRoutes({
    db,
    contentStore: InlineContentStore,
    resolveRunScope: (token, address) => {
      if (opts.resolves === undefined) {
        return token === VALID_TOKEN && address === VALID_ADDRESS ? RUN_SCOPE : null;
      }
      return opts.resolves;
    },
  });
}

const authed = { authorization: `Bearer ${VALID_TOKEN}`, "x-workflow-run-address": VALID_ADDRESS };

const json = (body: unknown, headers: Record<string, string> = authed) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const patchJson = (body: unknown, headers: Record<string, string> = authed) => ({
  method: "PATCH",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

describe("auth", () => {
  test("401s with no bearer token", async () => {
    const db = await testDb();
    const app = host(db);
    const res = await app.request("/artifacts/recent");
    expect(res.status).toBe(401);
  });

  test("401s when the resolver refuses the token/address pair", async () => {
    const db = await testDb();
    const app = host(db, { resolves: null });
    const res = await app.request("/artifacts/recent", { headers: authed });
    expect(res.status).toBe(401);
  });

  test("passes through on a resolved scope", async () => {
    const db = await testDb();
    const app = host(db);
    const res = await app.request("/artifacts/recent", { headers: authed });
    expect(res.status).toBe(200);
  });
});

describe("POST /artifacts", () => {
  test("creates a workflow-origin artifact scoped to the run's tenant", async () => {
    const db = await testDb();
    const app = host(db);
    const res = await app.request(
      "/artifacts",
      json({ title: "Brief", kind: "document", content: "hello" }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string; version: number } };
    expect(data.version).toBe(1);

    const row = await getArtifact(db, data.id);
    expect(row?.tenantId).toBe("acme");
    expect(row?.source).toEqual({ origin: "workflow", runId: "run-1" });
    // No human owner-member by default for a workflow-authored row.
    expect(row?.ownerPrincipalId).toBeNull();
  });

  test("rejects a body missing a required field", async () => {
    const db = await testDb();
    const app = host(db);
    const res = await app.request("/artifacts", json({ title: "Brief", kind: "document" }));
    expect(res.status).toBe(400);
  });

  test("stores an opaque metadata object on version 1", async () => {
    const db = await testDb();
    const app = host(db);
    const res = await app.request(
      "/artifacts",
      json({
        title: "Brief",
        kind: "document",
        content: "hello",
        metadata: { project: "acme-onboarding", stage: "draft" },
      }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string; version: number } };
    expect(data.version).toBe(1);

    const row = await getArtifact(db, data.id);
    expect(row?.metadata).toEqual({ project: "acme-onboarding", stage: "draft" });
  });

  test("rejects a metadata value that is not a JSON object", async () => {
    const db = await testDb();
    const app = host(db);
    for (const metadata of ["a string", 42, ["array"]]) {
      const res = await app.request(
        "/artifacts",
        json({ title: "Brief", kind: "document", content: "hello", metadata }),
      );
      expect(res.status).toBe(400);
    }
  });

  test("a body trying to smuggle source/runId is ignored: source stays server-stamped", async () => {
    const db = await testDb();
    const app = host(db);
    const res = await app.request(
      "/artifacts",
      json({
        title: "Brief",
        kind: "document",
        content: "hello",
        source: { origin: "manual" },
        runId: "attacker-run",
        generatedBy: "attacker",
      }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };

    const row = await getArtifact(db, data.id);
    expect(row?.source).toEqual({ origin: "workflow", runId: "run-1" });
  });

  test("413s content over the configured character ceiling", async () => {
    const db = await testDb();
    const app = createWorkflowArtifactRoutes({
      db,
      contentStore: InlineContentStore,
      resolveRunScope: () => RUN_SCOPE,
      maxContentChars: 10,
    });
    const res = await app.request(
      "/artifacts",
      json({ title: "Brief", kind: "document", content: "way too long for the ceiling" }),
    );
    expect(res.status).toBe(413);
  });
});

describe("GET /artifacts/recent", () => {
  test("lists only the run's own tenant, newest first", async () => {
    const db = await testDb();
    await seedArtifact(db, { tenantId: "acme", title: "A" });
    await seedArtifact(db, { tenantId: "other", title: "B" });
    const app = host(db);

    const res = await app.request("/artifacts/recent", { headers: authed });
    const { data } = (await res.json()) as { data: { title: string }[] };
    expect(data.map((a) => a.title)).toEqual(["A"]);
  });

  test("clamps an out-of-range limit rather than erroring", async () => {
    const db = await testDb();
    const app = host(db);
    const res = await app.request("/artifacts/recent?limit=9999", { headers: authed });
    expect(res.status).toBe(200);
  });
});

describe("GET /artifacts/:id", () => {
  test("reads back an artifact the run's own tenant owns", async () => {
    const db = await testDb();
    const seeded = await seedArtifact(db, { tenantId: "acme", content: "body text" });
    const app = host(db);

    const res = await app.request(`/artifacts/${seeded.id}`, { headers: authed });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { content: string } };
    expect(data.content).toBe("body text");
  });

  test("404s another tenant's artifact, same as a nonexistent id", async () => {
    const db = await testDb();
    const foreign = await seedArtifact(db, { tenantId: "other" });
    const app = host(db);

    const [foreignRes, ghostRes] = await Promise.all([
      app.request(`/artifacts/${foreign.id}`, { headers: authed }),
      app.request("/artifacts/does-not-exist", { headers: authed }),
    ]);
    expect(foreignRes.status).toBe(404);
    expect(ghostRes.status).toBe(404);
  });
});

describe("POST /artifacts/binary", () => {
  test("creates a file artifact from base64 bytes", async () => {
    const db = await testDb();
    const app = host(db);
    const contentBase64 = Buffer.from("<h1>rendered</h1>").toString("base64");

    const res = await app.request(
      "/artifacts/binary",
      json({ filename: "brief.html", mimeType: "text/html", contentBase64 }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };

    const row = await getArtifact(db, data.id);
    expect(row?.tenantId).toBe("acme");
    expect((row?.source as { generatedBy?: string })?.generatedBy).toBe("run-1");
  });

  test("stores an opaque metadata object on version 1", async () => {
    const db = await testDb();
    const app = host(db);
    const contentBase64 = Buffer.from("<h1>rendered</h1>").toString("base64");

    const res = await app.request(
      "/artifacts/binary",
      json({
        filename: "brief.html",
        mimeType: "text/html",
        contentBase64,
        metadata: { project: "acme-onboarding" },
      }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };

    const row = await getArtifact(db, data.id);
    expect(row?.metadata).toEqual({ project: "acme-onboarding" });
  });

  test("415s an unsupported file type", async () => {
    const db = await testDb();
    const app = host(db);
    const res = await app.request(
      "/artifacts/binary",
      json({
        filename: "payload.exe",
        mimeType: "application/x-msdownload",
        contentBase64: Buffer.from("x").toString("base64"),
      }),
    );
    expect(res.status).toBe(415);
  });

  test("413s bytes over the configured byte ceiling", async () => {
    const db = await testDb();
    const app = createWorkflowArtifactRoutes({
      db,
      contentStore: InlineContentStore,
      resolveRunScope: () => RUN_SCOPE,
      maxBinaryBytes: 4,
    });
    const res = await app.request(
      "/artifacts/binary",
      json({
        filename: "a.txt",
        mimeType: "text/plain",
        contentBase64: Buffer.from("way too big").toString("base64"),
      }),
    );
    expect(res.status).toBe(413);
  });
});

describe("PATCH /artifacts/:id", () => {
  test("sets metadata and returns it in the response", async () => {
    const db = await testDb();
    const app = host(db);
    const row = await seedArtifact(db, { tenantId: "acme", title: "Draft", content: "v1" });

    const res = await app.request(
      `/artifacts/${row.id}`,
      patchJson({ content: "v2", metadata: { stage: "review" } }),
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { version: number } };
    expect(data.version).toBe(2);

    const updated = await getArtifact(db, row.id);
    expect(updated?.metadata).toEqual({ stage: "review" });
  });

  test("omitting metadata carries the prior version's metadata forward", async () => {
    const db = await testDb();
    const app = host(db);
    const row = await seedArtifact(db, { tenantId: "acme", title: "Draft", content: "v1" });
    await app.request(`/artifacts/${row.id}`, patchJson({ metadata: { stage: "draft" } }));

    await app.request(`/artifacts/${row.id}`, patchJson({ content: "v3" }));

    const updated = await getArtifact(db, row.id);
    expect(updated?.metadata).toEqual({ stage: "draft" });
  });

  test("an explicit null metadata clears it", async () => {
    const db = await testDb();
    const app = host(db);
    const row = await seedArtifact(db, { tenantId: "acme", title: "Draft", content: "v1" });
    await app.request(`/artifacts/${row.id}`, patchJson({ metadata: { stage: "draft" } }));

    await app.request(`/artifacts/${row.id}`, patchJson({ metadata: null }));

    const updated = await getArtifact(db, row.id);
    expect(updated?.metadata).toBeNull();
  });

  test("rejects a metadata value that is not a JSON object", async () => {
    const db = await testDb();
    const app = host(db);
    const row = await seedArtifact(db, { tenantId: "acme" });

    const res = await app.request(`/artifacts/${row.id}`, patchJson({ metadata: "nope" }));
    expect(res.status).toBe(400);
  });

  test("rejects an empty body with no title, content, or metadata", async () => {
    const db = await testDb();
    const app = host(db);
    const row = await seedArtifact(db, { tenantId: "acme" });

    const res = await app.request(`/artifacts/${row.id}`, patchJson({}));
    expect(res.status).toBe(400);
  });
});
