import { describe, expect, test } from "bun:test";
import {
  createWorkflowArtifactRoutes,
  type ResolvedWorkflowRunScope,
} from "../src/workflow-mount.js";
import { InlineContentStore } from "../src/content-store.js";
import { getArtifact, setArtifactArchived } from "../src/artifacts.js";
import { seedArtifact } from "./fixtures.js";
import { testDb } from "./helpers.js";
import type { ArtifactDb } from "../src/db.js";

const RUN_SCOPE: ResolvedWorkflowRunScope = {
  tenantId: "acme",
  principalId: "user-1",
  runId: "run-1",
};

const VALID_TOKEN = "sidecar-token";
const VALID_ADDRESS = "run-1@acme";

function host(
  db: ArtifactDb,
  opts: {
    resolves?: ResolvedWorkflowRunScope | null;
    maxContentChars?: number;
  } = {},
) {
  return createWorkflowArtifactRoutes({
    db,
    contentStore: InlineContentStore,
    ...(opts.maxContentChars !== undefined
      ? { maxContentChars: opts.maxContentChars }
      : {}),
    resolveRunScope: (token, address) => {
      if (opts.resolves === undefined) {
        return token === VALID_TOKEN && address === VALID_ADDRESS
          ? RUN_SCOPE
          : null;
      }
      return opts.resolves;
    },
  });
}

const authed = {
  authorization: `Bearer ${VALID_TOKEN}`,
  "x-workflow-run-address": VALID_ADDRESS,
};

const json = (body: unknown, headers: Record<string, string> = authed) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const patchJson = (
  body: unknown,
  headers: Record<string, string> = authed,
) => ({
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
  test("an oversized title is 400", async () => {
    const res = await host(await testDb()).request(
      "/artifacts",
      json({ title: "t".repeat(600), kind: "document", content: "hello" }),
    );
    expect(res.status).toBe(400);
  });

  test("creates a workflow-origin artifact scoped to the run's tenant", async () => {
    const db = await testDb();
    const app = host(db);
    const res = await app.request(
      "/artifacts",
      json({ title: "Brief", kind: "document", content: "hello" }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as {
      data: { id: string; version: number };
    };
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
    const res = await app.request(
      "/artifacts",
      json({ title: "Brief", kind: "document" }),
    );
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
    const { data } = (await res.json()) as {
      data: { id: string; version: number };
    };
    expect(data.version).toBe(1);

    const row = await getArtifact(db, data.id);
    expect(row?.metadata).toEqual({
      project: "acme-onboarding",
      stage: "draft",
    });
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
      json({
        title: "Brief",
        kind: "document",
        content: "way too long for the ceiling",
      }),
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
    const res = await app.request("/artifacts/recent?limit=9999", {
      headers: authed,
    });
    expect(res.status).toBe(200);
  });
});

describe("GET /artifacts", () => {
  test("forwards the query filter and returns a nextCursor", async () => {
    const db = await testDb();
    await seedArtifact(db, {
      tenantId: "acme",
      title: "first",
      content: "alpha",
    });
    await seedArtifact(db, {
      tenantId: "acme",
      title: "second",
      content: "beta",
    });
    const app = host(db);

    const res = await app.request("/artifacts?query=alpha", {
      headers: authed,
    });
    expect(res.status).toBe(200);
    const { data, nextCursor } = (await res.json()) as {
      data: { title: string }[];
      nextCursor: string | null;
    };
    expect(data.map((a) => a.title)).toEqual(["first"]);
    expect(nextCursor).toBeNull();
  });

  test("pages with a keyset cursor and honors kind", async () => {
    const db = await testDb();
    for (let i = 0; i < 5; i += 1) {
      await seedArtifact(db, {
        tenantId: "acme",
        title: `doc-${i}`,
        kind: "document",
      });
      await seedArtifact(db, {
        tenantId: "acme",
        title: `note-${i}`,
        kind: "note",
      });
    }
    const app = host(db);

    const first = await app.request("/artifacts?kind=document&limit=2", {
      headers: authed,
    });
    const firstJson = (await first.json()) as {
      data: { title: string }[];
      nextCursor: string | null;
    };
    expect(first.status).toBe(200);
    expect(firstJson.data).toHaveLength(2);
    expect(firstJson.nextCursor).not.toBeNull();

    const second = await app.request(
      `/artifacts?kind=document&limit=2&cursor=${encodeURIComponent(firstJson.nextCursor!)}`,
      { headers: authed },
    );
    const secondJson = (await second.json()) as {
      data: { title: string }[];
      nextCursor: string | null;
    };
    expect(second.status).toBe(200);
    expect(secondJson.data).toHaveLength(2);
    const allTitles = [...firstJson.data, ...secondJson.data].map(
      (a) => a.title,
    );
    expect(new Set(allTitles).size).toBe(4);
  });

  test("a malformed cursor is 400", async () => {
    const db = await testDb();
    const app = host(db);
    const res = await app.request("/artifacts?cursor=garbage", {
      headers: authed,
    });
    expect(res.status).toBe(400);
  });

  test("escapes ILIKE metacharacters so a query matches literals, not wildcards", async () => {
    const db = await testDb();
    await seedArtifact(db, {
      tenantId: "acme",
      title: "quota",
      content: "usage at 100%",
    });
    // A literal underscore, not a single-char wildcard.
    await seedArtifact(db, {
      tenantId: "acme",
      title: "notes_keep",
      content: "unrelated",
    });
    await seedArtifact(db, {
      tenantId: "acme",
      title: "percent",
      content: "now at 100x",
    });
    const app = host(db);

    // A literal % matches only the content containing "100%", not "100x".
    const percent = await app.request("/artifacts?query=100%25", {
      headers: authed,
    });
    const percentJson = (await percent.json()) as { data: { title: string }[] };
    expect(percent.status).toBe(200);
    expect(percentJson.data.map((a) => a.title)).toEqual(["quota"]);

    // A literal "_" matches "notes_keep" exactly, not something like "notesXkeep".
    const underscore = await app.request("/artifacts?query=notes_keep", {
      headers: authed,
    });
    const underscoreJson = (await underscore.json()) as {
      data: { title: string }[];
    };
    expect(underscore.status).toBe(200);
    expect(underscoreJson.data.map((a) => a.title)).toEqual(["notes_keep"]);
  });

  test("a crafted cursor from another tenant never leaks that tenant's rows", async () => {
    const db = await testDb();
    await seedArtifact(db, { tenantId: "acme", title: "mine" });
    const foreign = await seedArtifact(db, {
      tenantId: "other",
      title: "theirs",
    });
    const app = host(db);

    // A cursor only further restricts the tenant-confined list; the foreign
    // row's id in a far-future cursor never surfaces it.
    const res = await app.request(
      `/artifacts?cursor=2999-01-01T00:00:00.000000Z__${foreign.id}`,
      { headers: authed },
    );
    const json = (await res.json()) as {
      data: { id: string; title: string }[];
    };
    expect(res.status).toBe(200);
    expect(json.data.map((a) => a.title)).toEqual(["mine"]);
    expect(json.data.map((a) => a.id)).not.toContain(foreign.id);
  });
});

describe("GET /artifacts/:id", () => {
  test("reads back an artifact the run's own tenant owns", async () => {
    const db = await testDb();
    const seeded = await seedArtifact(db, {
      tenantId: "acme",
      content: "body text",
    });
    const app = host(db);

    const res = await app.request(`/artifacts/${seeded.id}`, {
      headers: authed,
    });
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
    expect((row?.source as { generatedBy?: string })?.generatedBy).toBe(
      "run-1",
    );
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
  test("revising an archived artifact is 404 and an oversized title is 400", async () => {
    const db = await testDb();
    const app = host(db);
    const row = await seedArtifact(db, {
      tenantId: "acme",
      title: "Draft",
      content: "v1",
    });
    const long = patchJson({ title: "t".repeat(600) });
    expect((await app.request(`/artifacts/${row.id}`, long)).status).toBe(400);
    await setArtifactArchived(db, row, true);
    expect(
      (await app.request(`/artifacts/${row.id}`, patchJson({ content: "v2" })))
        .status,
    ).toBe(404);
  });

  test("sets metadata and returns it in the response", async () => {
    const db = await testDb();
    const app = host(db);
    const row = await seedArtifact(db, {
      tenantId: "acme",
      title: "Draft",
      content: "v1",
    });

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
    const row = await seedArtifact(db, {
      tenantId: "acme",
      title: "Draft",
      content: "v1",
    });
    await app.request(
      `/artifacts/${row.id}`,
      patchJson({ metadata: { stage: "draft" } }),
    );

    await app.request(`/artifacts/${row.id}`, patchJson({ content: "v3" }));

    const updated = await getArtifact(db, row.id);
    expect(updated?.metadata).toEqual({ stage: "draft" });
  });

  test("an explicit null metadata clears it", async () => {
    const db = await testDb();
    const app = host(db);
    const row = await seedArtifact(db, {
      tenantId: "acme",
      title: "Draft",
      content: "v1",
    });
    await app.request(
      `/artifacts/${row.id}`,
      patchJson({ metadata: { stage: "draft" } }),
    );

    await app.request(`/artifacts/${row.id}`, patchJson({ metadata: null }));

    const updated = await getArtifact(db, row.id);
    expect(updated?.metadata).toBeNull();
  });

  test("rejects a metadata value that is not a JSON object", async () => {
    const db = await testDb();
    const app = host(db);
    const row = await seedArtifact(db, { tenantId: "acme" });

    const res = await app.request(
      `/artifacts/${row.id}`,
      patchJson({ metadata: "nope" }),
    );
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

describe("revising by edits", () => {
  const seeded = async (opts: { maxContentChars?: number } = {}) => {
    const db = await testDb();
    const row = await seedArtifact(db, {
      tenantId: "acme",
      content: "## Goal\nShip it.",
    });
    return { db, row, app: host(db, opts) };
  };

  test("applies exact-passage edits as the next version", async () => {
    const { db, row, app } = await seeded();
    const res = await app.request(
      `/artifacts/${row.id}`,
      patchJson({
        edits: [{ oldText: "Ship it.", newText: "Ship it by Friday." }],
        expectedVersion: 1,
      }),
    );
    expect(res.status).toBe(200);
    const updated = await getArtifact(db, row.id);
    expect(updated?.version).toBe(2);
    expect(updated?.content).toBe("## Goal\nShip it by Friday.");
  });

  test("a passage that does not land is 400 and writes nothing", async () => {
    const { db, row, app } = await seeded();
    const res = await app.request(
      `/artifacts/${row.id}`,
      patchJson({ edits: [{ oldText: "Ship it later.", newText: "x" }] }),
    );
    expect(res.status).toBe(400);
    expect((await getArtifact(db, row.id))?.version).toBe(1);
  });

  test("a stale expectedVersion is 409", async () => {
    const { app, row } = await seeded();
    const res = await app.request(
      `/artifacts/${row.id}`,
      patchJson({
        edits: [{ oldText: "Ship it.", newText: "Ship." }],
        expectedVersion: 3,
      }),
    );
    expect(res.status).toBe(409);
  });

  test("content and edits together are 400", async () => {
    const { app, row } = await seeded();
    const res = await app.request(
      `/artifacts/${row.id}`,
      patchJson({
        content: "whole",
        edits: [{ oldText: "Ship it.", newText: "Ship." }],
      }),
    );
    expect(res.status).toBe(400);
  });

  test("edits that grow the text past the host's limit are 413, version stays", async () => {
    const { db, app, row } = await seeded({ maxContentChars: 20 });
    const res = await app.request(
      `/artifacts/${row.id}`,
      patchJson({
        edits: [{ oldText: "Ship it.", newText: "Ship it, and then some." }],
      }),
    );
    expect(res.status).toBe(413);
    expect((await getArtifact(db, row.id))?.version).toBe(1);
  });

  test("an empty oldText is 400 and writes nothing", async () => {
    const { db, row, app } = await seeded();
    const res = await app.request(
      `/artifacts/${row.id}`,
      patchJson({ edits: [{ oldText: "", newText: "x" }] }),
    );
    expect(res.status).toBe(400);
    expect((await getArtifact(db, row.id))?.version).toBe(1);
  });

  test("an empty newText deletes the passage as the next version", async () => {
    const { db, row, app } = await seeded();
    const res = await app.request(
      `/artifacts/${row.id}`,
      patchJson({ edits: [{ oldText: "Ship it.", newText: "" }] }),
    );
    expect(res.status).toBe(200);
    expect((await getArtifact(db, row.id))?.version).toBe(2);
    expect((await getArtifact(db, row.id))?.content).toBe("## Goal\n");
  });

  test("an edit batch over the count bound is 400 and writes nothing", async () => {
    const { db, row, app } = await seeded();
    const tooMany = Array.from({ length: 201 }, (_, i) => ({
      oldText: `needle-${i}`,
      newText: "x",
    }));
    const res = await app.request(
      `/artifacts/${row.id}`,
      patchJson({ edits: tooMany }),
    );
    expect(res.status).toBe(400);
    expect((await getArtifact(db, row.id))?.version).toBe(1);
  });

  test("content over the ceiling is 413, matching the create path", async () => {
    const { db, row, app } = await seeded({ maxContentChars: 10 });
    const res = await app.request(
      `/artifacts/${row.id}`,
      patchJson({ content: "way beyond the ceiling" }),
    );
    expect(res.status).toBe(413);
    expect((await getArtifact(db, row.id))?.content).toBe("## Goal\nShip it.");
  });

  // A delete-shrinking batch under the ceiling still applies atomically.
  test("a legit large-batch under the ceiling still applies atomically", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, {
      tenantId: "acme",
      content: Array.from({ length: 150 }, (_, i) =>
        String(i).padStart(3, "0"),
      ).join(" "),
    });
    const app = host(db);
    const edits = Array.from({ length: 150 }, (_, i) => ({
      oldText: String(i).padStart(3, "0"),
      newText: "",
    }));
    const res = await app.request(`/artifacts/${row.id}`, patchJson({ edits }));
    expect(res.status).toBe(200);
    const updated = await getArtifact(db, row.id);
    expect(updated?.version).toBe(2);
    // Every token was deleted; only the " " separators between them remain.
    expect(updated?.content.trim()).toBe("");
  });

  test("the post-apply maxContentChars backstop fires when content is replaced past the ceiling", async () => {
    // The content path skips the pre-lock projected check; the post-apply
    // backstop must still refuse and write nothing.
    const db = await testDb();
    const row = await seedArtifact(db, {
      tenantId: "acme",
      content: "## Goal\nShip it.",
    });
    const app = createWorkflowArtifactRoutes({
      db,
      contentStore: InlineContentStore,
      resolveRunScope: () => RUN_SCOPE,
      maxContentChars: 10,
    });
    const res = await app.request(
      `/artifacts/${row.id}`,
      patchJson({ content: "way beyond the ceiling" }),
    );
    expect(res.status).toBe(413);
    expect((await getArtifact(db, row.id))?.version).toBe(1);
    expect((await getArtifact(db, row.id))?.content).toBe("## Goal\nShip it.");
  });
});

describe("user-input errors", () => {
  test("an oversized binary filename or link-file title is 400", async () => {
    const db = await testDb();
    const app = host(db);
    const long = "x".repeat(600);
    const binary = await app.request(
      "/artifacts/binary",
      json({
        filename: `${long}.html`,
        mimeType: "text/html",
        contentBase64: Buffer.from("<p>hi</p>").toString("base64"),
      }),
    );
    expect(binary.status).toBe(400);
    const linked = await app.request(
      "/artifacts/link-file",
      json({ title: long, kind: "document", path: "out/report.md" }),
    );
    expect(linked.status).toBe(400);
  });

  test("read of a missing version is 404; a version past int4 is 400", async () => {
    const db = await testDb();
    const app = host(db);
    const row = await seedArtifact(db, { tenantId: "acme" });
    const read = (query: string) =>
      app.request(`/artifacts/${row.id}/read${query}`, { headers: authed });
    expect((await read("?version=7")).status).toBe(404);
    expect((await read("?version=2147483648")).status).toBe(400);
  });
});
