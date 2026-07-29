import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { mountArtifacts } from "./mount.js";
import { InlineContentStore } from "./content-store.js";
import { listArtifacts, setArtifactArchived } from "./artifacts.js";
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILE_COUNT,
  MAX_UPLOAD_TOTAL_BYTES,
} from "./uploads.js";
import type { ArtifactDb } from "./db.js";
import type { MountArtifactsOpts } from "./mount.js";
import type { ResolvedPrincipal, Identity } from "./ports.js";
import { fakeIdentity, seedArtifact, seedSkillDraft, SCOPE, testDb } from "./test-helpers.js";

type HostOpts = {
  principal?: ResolvedPrincipal | null;
  identity?: Identity;
  isAdmin?: MountArtifactsOpts["isAdmin"];
  decorate?: MountArtifactsOpts["decorate"];
};

function host(db: ArtifactDb, opts: HostOpts = {}) {
  const app = new Hono();
  const principal = opts.principal === undefined ? SCOPE : opts.principal;
  return mountArtifacts(app, {
    db,
    contentStore: InlineContentStore,
    resolvePrincipal: () => principal,
    identity: opts.identity ?? fakeIdentity(),
    ...(opts.isAdmin ? { isAdmin: opts.isAdmin } : {}),
    ...(opts.decorate ? { decorate: opts.decorate } : {}),
  });
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("POST /artifacts", () => {
  test("imports a URL as a link with an imported origin", async () => {
    const db = await testDb();
    const app = host(db);

    const res = await app.request(
      "/artifacts",
      json({ mode: "url", title: "  Docs  ", content: "https://example.com/a" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { artifact: Record<string, any> };
    expect(body.artifact).toMatchObject({
      kind: "link",
      title: "Docs",
      version: 1,
      source: { origin: "imported", url: "https://example.com/a" },
    });
  });

  test("imports pasted text as a document with a manual origin", async () => {
    const db = await testDb();
    const res = await host(db).request(
      "/artifacts",
      json({ mode: "text", title: "Notes", content: "body" }),
    );
    const body = (await res.json()) as { artifact: Record<string, any> };
    expect(body.artifact).toMatchObject({ kind: "document", source: { origin: "manual" } });
  });

  test("rejects a non-http URL, a non-URL, and an empty field", async () => {
    const db = await testDb();
    const app = host(db);
    for (const body of [
      { mode: "url", title: "t", content: "javascript:alert(1)" },
      { mode: "url", title: "t", content: "not a url" },
      { mode: "text", title: "   ", content: "body" },
      { mode: "sideways", title: "t", content: "body" },
    ]) {
      expect((await app.request("/artifacts", json(body))).status).toBe(400);
    }
    const malformed = await app.request("/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
  });

  test("refuses a kind outside the importable allowlist", async () => {
    const db = await testDb();
    const res = await host(db).request(
      "/artifacts",
      json({ mode: "text", title: "t", content: "a,b", kind: "csv-export" }),
    );
    expect(res.status).toBe(400);
  });

  test("is 403 without a resolvable principal", async () => {
    const db = await testDb();
    const res = await host(db, { principal: null }).request(
      "/artifacts",
      json({ mode: "text", title: "t", content: "b" }),
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /artifacts", () => {
  test("returns an empty page — not a 403 — when there is no principal", async () => {
    const db = await testDb();
    const res = await host(db, { principal: null }).request("/artifacts");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ artifacts: [], nextCursor: null });
  });

  // List is discovery: full bodies stay on detail/download/tools.
  test("omits content from listed artifacts even when the body is large", async () => {
    const db = await testDb();
    const large = "y".repeat(40_000);
    const row = await seedArtifact(db, { title: "Heavy", content: large });
    const app = host(db);

    const listed = (await (await app.request("/artifacts")).json()) as {
      artifacts: Record<string, unknown>[];
    };
    expect(listed.artifacts).toHaveLength(1);
    expect(listed.artifacts[0]!.id).toBe(row.id);
    expect(listed.artifacts[0]!.title).toBe("Heavy");
    expect("content" in listed.artifacts[0]!).toBe(false);

    // Detail still returns the full body.
    const detail = (await (
      await app.request(`/artifacts/${row.id}`)
    ).json()) as { artifact: { content: string } };
    expect(detail.artifact.content).toBe(large);
  });

  test("attaches owner names and runs the display-only provenance decorator", async () => {
    const db = await testDb();
    await seedArtifact(db, { title: "Doc" });

    const decorated: string[] = [];
    const app = host(db, {
      identity: fakeIdentity({
        ownerNames: async (_tenant, ids) => new Map(ids.map((id) => [id, `Name of ${id}`])),
      }),
      decorate: async (tenantId, rows) => {
        decorated.push(tenantId);
        for (const row of rows) {
          (row as Record<string, unknown>).sessionName = "Weekly brief";
        }
      },
    });

    const body = (await (await app.request("/artifacts")).json()) as {
      artifacts: Record<string, unknown>[];
    };
    expect(body.artifacts[0]).toMatchObject({
      ownerName: "Name of user-1",
      sessionName: "Weekly brief",
    });
    expect(decorated).toEqual(["acme"]);
  });

  // The MATCH case is covered above. The SKIP case is the other half of the
  // seam's contract and was unasserted: a row whose source names no run the
  // host can resolve must come back UNDECORATED — not decorated with a wrong
  // run's label, and not omitted from the page. A decorator that quietly
  // stamped every row would pass a match-only test.
  test("a row whose source has no matching run is left undecorated", async () => {
    const db = await testDb();
    await seedArtifact(db, {
      title: "From a run",
      source: { origin: "workflow", runId: "run-1" },
    });
    await seedArtifact(db, { title: "Hand written", source: { origin: "manual" } });

    // A realistic host decorator: it joins on an id it finds in `source`, and
    // has nothing to say about a row that carries none.
    const runs = new Map([["run-1", "Weekly brief"]]);
    const app = host(db, {
      decorate: async (_tenantId, rows) => {
        for (const row of rows) {
          const runId = row.source.runId;
          const name = typeof runId === "string" ? runs.get(runId) : undefined;
          if (name !== undefined) (row as Record<string, unknown>).sessionName = name;
        }
      },
    });

    const body = (await (await app.request("/artifacts")).json()) as {
      artifacts: { title: string; sessionName?: string }[];
    };
    const byTitle = new Map(body.artifacts.map((a) => [a.title, a]));
    expect([...byTitle.keys()].sort()).toEqual(["From a run", "Hand written"]);
    expect(byTitle.get("From a run")!.sessionName).toBe("Weekly brief");
    // Absent, not null and not another run's label.
    expect("sessionName" in byTitle.get("Hand written")!).toBe(false);
  });

  test("rejects a bad creatorKind and a bad cursor with 400", async () => {
    const db = await testDb();
    const app = host(db);
    expect((await app.request("/artifacts?creatorKind=robot")).status).toBe(400);
    expect((await app.request("/artifacts?cursor=garbage")).status).toBe(400);
    expect((await app.request("/artifacts?createdAfter=nonsense")).status).toBe(400);
  });

  test("a caller-supplied tenant cannot widen the resolved scope", async () => {
    const db = await testDb();
    await seedArtifact(db, { title: "Theirs", tenantId: "other" });
    const res = await host(db).request("/artifacts?tenantId=other");
    expect(res.status).toBe(200);
    // The query param is not a tenant override; only the session's tenant is read.
    expect(await res.json()).toEqual({ artifacts: [], nextCursor: null });
  });
});

describe("GET /artifacts/:id", () => {
  test("loads an archived artifact by deep link so it can be unarchived", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { title: "Put away" });
    await setArtifactArchived(db, row, true);

    const res = await host(db).request(`/artifacts/${row.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifact: { archivedAt: string | null } };
    expect(body.artifact.archivedAt).not.toBeNull();
  });

  // Was "is 404 for an unknown id and 403 across tenants" — it pinned the
  // existence oracle. Another tenant's artifact answering 403 while a ghost id
  // answered 404 let any account holder walk arbitrary UUIDs and learn which
  // ones name a real artifact anywhere in the deployment. The doctrine ten
  // lines above `loadScoped` already said that is not the caller's to learn.
  test("is 404 for an unknown id AND for another tenant's artifact", async () => {
    const db = await testDb();
    const app = host(db);
    expect(
      (await app.request("/artifacts/00000000-0000-0000-0000-000000000000")).status,
    ).toBe(404);

    const foreign = await seedArtifact(db, { tenantId: "other" });
    expect((await app.request(`/artifacts/${foreign.id}`)).status).toBe(404);
  });

  // A malformed id used to reach `eq(artifact.id, …)` on a uuid column, so
  // Postgres raised 22P02 and it propagated as an unhandled 500 — on every one
  // of the six single-artifact routes, without authenticating, dumping the
  // statement text and its bound parameters into the host's logs.
  test("a malformed id is not a 500", async () => {
    const db = await testDb();
    const res = await host(db).request("/artifacts/not-a-uuid");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Artifact not found" });
  });
});

/**
 * The whole point of the choke point, asserted as one table: for a caller who
 * HAS a principal, there is exactly ONE way to fail to get an artifact, and it
 * looks the same however you failed. Route × cause, status AND body.
 */
describe("every way of not getting an artifact is indistinguishable", () => {
  const detailRoutes = (id: string): [string, RequestInit][] => [
    [`/artifacts/${id}`, {}],
    [`/artifacts/${id}/versions`, {}],
    [`/artifacts/${id}/versions`, json({ content: "x" })],
    [`/artifacts/${id}/archive`, { method: "POST" }],
    [`/artifacts/${id}/unarchive`, { method: "POST" }],
    [`/artifacts/${id}/download`, {}],
  ];

  test("skill-draft, ghost id, cross-tenant and malformed id agree on all six routes", async () => {
    const db = await testDb();
    const app = host(db);
    const cases: [string, string][] = [
      ["skill-draft", await seedSkillDraft(db, "scratch")],
      ["ghost id", "00000000-0000-4000-8000-000000000000"],
      ["cross-tenant", (await seedArtifact(db, { tenantId: "other" })).id],
      ["malformed id", "not-a-uuid"],
    ];

    const observed: Record<string, unknown>[] = [];
    for (const [cause, id] of cases) {
      for (const [path, init] of detailRoutes(id)) {
        const res = await app.request(path, init);
        observed.push({
          cause,
          route: `${init.method ?? "GET"} ${path.replace(id, ":id")}`,
          status: res.status,
          body: await res.json(),
        });
      }
    }

    expect(observed).toEqual(
      observed.map((o) => ({
        cause: o.cause,
        route: o.route,
        status: 404,
        body: { error: "Artifact not found" },
      })),
    );
  });

  // A refused cross-tenant mutation must also not have mutated. A 404 that
  // still archived someone else's artifact would be the worse bug.
  test("a cross-tenant archive leaves the foreign row untouched", async () => {
    const db = await testDb();
    const foreign = await seedArtifact(db, { tenantId: "other" });
    expect(
      (await host(db).request(`/artifacts/${foreign.id}/archive`, { method: "POST" }))
        .status,
    ).toBe(404);
    const rows = await db.execute<{ archived_at: Date | null }>(
      sql`SELECT "archived_at" FROM "artifacts"."artifact" WHERE "id" = ${foreign.id}`,
    );
    expect(rows[0]!.archived_at).toBeNull();
  });

  // The malformed-id 500 was reachable BEFORE authentication. The scope is now
  // resolved first, so a signed-out caller gets the same 403 whatever it names
  // — and the database is never asked about the id at all.
  test("a signed-out caller gets 403 for every id, well-formed or not", async () => {
    const db = await testDb();
    const real = await seedArtifact(db);
    const app = host(db, { principal: null });
    for (const id of [real.id, "00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      for (const [path, init] of detailRoutes(id)) {
        const res = await app.request(path, init);
        expect({ id, path: path.replace(id, ":id"), status: res.status }).toEqual({
          id,
          path: path.replace(id, ":id"),
          status: 403,
        });
      }
    }
  });
});

describe("versions", () => {
  test("revises through the route and lists the history newest-first", async () => {
    const db = await testDb();
    const app = host(db);
    const row = await seedArtifact(db, { title: "Draft", content: "v1" });

    const res = await app.request(`/artifacts/${row.id}/versions`, json({ content: "v2" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: 2, title: "Draft" });

    const history = (await (
      await app.request(`/artifacts/${row.id}/versions`)
    ).json()) as { versions: { version: number }[] };
    expect(history.versions.map((v) => v.version)).toEqual([2, 1]);
  });

  test("a body with neither title nor content is 400", async () => {
    const db = await testDb();
    const row = await seedArtifact(db);
    const res = await host(db).request(`/artifacts/${row.id}/versions`, json({}));
    expect(res.status).toBe(400);
  });

  test("revising an archived artifact is 404", async () => {
    const db = await testDb();
    const row = await seedArtifact(db);
    await setArtifactArchived(db, row, true);
    const res = await host(db).request(`/artifacts/${row.id}/versions`, json({ content: "x" }));
    expect(res.status).toBe(404);
  });

  // Named for exactly what it asserts: every single-artifact route.
  // These all funnel through `loadScoped`, and the point of the test is that
  // none of them can drift away from the choke point unnoticed.
  test("a skill-draft is 404 on read, versions, revise, archive, unarchive and download", async () => {
    const db = await testDb();
    const id = await seedSkillDraft(db, "scratch");
    const app = host(db);

    const GET = {} as const;
    const POST = { method: "POST" } as const;
    const routes: [string, RequestInit][] = [
      [`/artifacts/${id}`, GET],
      [`/artifacts/${id}/versions`, GET],
      [`/artifacts/${id}/versions`, json({ content: "x" })],
      [`/artifacts/${id}/archive`, POST],
      [`/artifacts/${id}/unarchive`, POST],
      [`/artifacts/${id}/download`, GET],
    ];
    for (const [path, init] of routes) {
      const res = await app.request(path, init);
      expect({
        route: `${init.method ?? "GET"} ${path}`,
        status: res.status,
        body: await res.json(),
      }).toEqual({
        route: `${init.method ?? "GET"} ${path}`,
        status: 404,
        body: { error: "Artifact not found" },
      });
    }
  });

  // The archive route mutates before it answers, so a mere status assertion
  // would still pass if the row had already been changed. Read the row back.
  test("a refused skill-draft archive leaves the row untouched", async () => {
    const db = await testDb();
    const id = await seedSkillDraft(db, "scratch");
    expect((await host(db).request(`/artifacts/${id}/archive`, { method: "POST" })).status).toBe(
      404,
    );
    const rows = await db.execute<{ archived_at: Date | null }>(
      sql`SELECT "archived_at" FROM "artifacts"."artifact" WHERE "id" = ${id}`,
    );
    expect(rows[0]!.archived_at).toBeNull();
  });

  // A skill-draft is invisible, not merely un-writable: the id must not be
  // distinguishable from one that was never minted.
  test("an unknown id and a skill-draft id are indistinguishable", async () => {
    const db = await testDb();
    const app = host(db);
    const draft = await app.request(`/artifacts/${await seedSkillDraft(db, "scratch")}`);
    const unknown = await app.request("/artifacts/00000000-0000-4000-8000-000000000000");
    expect(draft.status).toBe(unknown.status);
    expect(await draft.json()).toEqual(await unknown.json());
  });
});

describe("archive authorization", () => {
  const post = (app: Hono, id: string, verb: string) =>
    app.request(`/artifacts/${id}/${verb}`, { method: "POST" });

  test("the exact owner may archive and unarchive", async () => {
    const db = await testDb();
    const app = host(db);
    const row = await seedArtifact(db);

    const archived = await post(app, row.id, "archive");
    expect(archived.status).toBe(200);
    expect(((await archived.json()) as any).artifact.archivedAt).not.toBeNull();

    const restored = await post(app, row.id, "unarchive");
    expect(((await restored.json()) as any).artifact.archivedAt).toBeNull();
  });

  test("a non-owner without admin is refused", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { ownerPrincipalId: "someone-else" });
    expect((await post(host(db), row.id, "archive")).status).toBe(403);
  });

  test("the member who owns the producing agent may archive", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { ownerPrincipalId: "agent-9" });
    const app = host(db, {
      identity: fakeIdentity({
        ownerMemberPrincipalId: async (scope) =>
          scope.principalId === "agent-9" ? "user-1" : null,
      }),
    });
    expect((await post(app, row.id, "archive")).status).toBe(200);
  });

  test("an admin may archive anyone's artifact via the authz seam", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { ownerPrincipalId: "someone-else" });
    const app = host(db, { isAdmin: async () => true });
    expect((await post(app, row.id, "archive")).status).toBe(200);
  });

  test("archiving is idempotent over the route", async () => {
    const db = await testDb();
    const app = host(db);
    const row = await seedArtifact(db);

    const first = (await (await post(app, row.id, "archive")).json()) as any;
    const second = (await (await post(app, row.id, "archive")).json()) as any;
    expect(second.artifact.archivedAt).toBe(first.artifact.archivedAt);
  });
});

describe("POST /artifacts/upload", () => {
  const form = (files: File[], generatedBy?: string) => {
    const data = new FormData();
    for (const file of files) data.append("files", file);
    if (generatedBy !== undefined) data.append("generatedBy", generatedBy);
    return { method: "POST", body: data };
  };

  test("mints one artifact per file and serves the bytes back", async () => {
    const db = await testDb();
    const app = host(db);
    const png = new File([new Uint8Array([1, 2, 3])], "logo.png", { type: "image/png" });
    const txt = new File(["hello"], "notes.txt", { type: "text/plain" });

    const res = await app.request("/artifacts/upload", form([png, txt], "Import"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { artifacts: { id: string; kind: string }[] };
    expect(body.artifacts.map((a) => a.kind)).toEqual(["image", "file"]);

    const download = await app.request(`/artifacts/${body.artifacts[0]!.id}/download`);
    expect(download.headers.get("content-type")).toBe("image/png");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(download.headers.get("content-disposition")).toBe(
      'attachment; filename="logo.png"',
    );
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("rejects an empty body, an unsupported type, and too many files", async () => {
    const db = await testDb();
    const app = host(db);

    expect((await app.request("/artifacts/upload", form([]))).status).toBe(400);
    expect(
      (
        await app.request(
          "/artifacts/upload",
          form([new File(["<svg/>"], "x.svg", { type: "image/svg+xml" })]),
        )
      ).status,
    ).toBe(415);

    const many = Array.from(
      { length: MAX_UPLOAD_FILE_COUNT + 1 },
      (_v, i) => new File(["a"], `f${i}.txt`, { type: "text/plain" }),
    );
    expect((await app.request("/artifacts/upload", form(many))).status).toBe(413);
  });

  test("one rejected file aborts the whole batch — no partial import", async () => {
    const db = await testDb();
    const app = host(db);
    const ok = new File(["a"], "good.txt", { type: "text/plain" });
    const bad = new File(["b"], "bad.svg", { type: "image/svg+xml" });

    expect((await app.request("/artifacts/upload", form([ok, bad]))).status).toBe(415);
    const list = (await (await app.request("/artifacts")).json()) as { artifacts: unknown[] };
    expect(list.artifacts.length).toBe(0);
  });

  // The size ceilings, exercised rather than restated. Asserting the constant
  // equals its own literal proves the constant, not the branch — these drive a
  // real request across each boundary and check the answer on both sides of it.
  //
  // One buffer backs every File: the route validates sizes BEFORE reading any
  // bytes (that is the point of the check order), so the batch never gets
  // buffered and the test costs one allocation, not a hundred.
  const bulk = (bytes: number) => new Uint8Array(bytes);

  test("a file one byte over the per-file cap is 413; the cap itself is accepted", async () => {
    const db = await testDb();
    const app = host(db);

    const over = new File([bulk(MAX_UPLOAD_BYTES + 1)], "huge.txt", { type: "text/plain" });
    const rejected = await app.request("/artifacts/upload", form([over]));
    expect(rejected.status).toBe(413);
    expect(((await rejected.json()) as { error: string }).error).toContain("huge.txt");

    const atLimit = new File([bulk(MAX_UPLOAD_BYTES)], "exact.txt", { type: "text/plain" });
    expect((await app.request("/artifacts/upload", form([atLimit]))).status).toBe(201);
  });

  test("a batch over the 100MB aggregate is 413 even though every file is legal", async () => {
    const db = await testDb();
    const app = host(db);

    // 11 x 10MB = 110MB: under the file-count cap, each file exactly at the
    // per-file cap, so ONLY the aggregate branch can refuse this.
    const chunk = bulk(MAX_UPLOAD_BYTES);
    const files = Array.from(
      { length: Math.floor(MAX_UPLOAD_TOTAL_BYTES / MAX_UPLOAD_BYTES) + 1 },
      (_v, i) => new File([chunk], `part-${i}.txt`, { type: "text/plain" }),
    );
    expect(files.length).toBeLessThanOrEqual(MAX_UPLOAD_FILE_COUNT);
    expect(files.every((f) => f.size <= MAX_UPLOAD_BYTES)).toBe(true);

    const res = await app.request("/artifacts/upload", form(files));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toContain("aggregate");

    const list = (await (await app.request("/artifacts")).json()) as { artifacts: unknown[] };
    expect(list.artifacts.length).toBe(0);
  });

  test("a batch exactly at the aggregate limit is accepted", async () => {
    const db = await testDb();
    const app = host(db);
    const chunk = bulk(MAX_UPLOAD_BYTES);
    const files = Array.from(
      { length: MAX_UPLOAD_TOTAL_BYTES / MAX_UPLOAD_BYTES },
      (_v, i) => new File([chunk], `part-${i}.txt`, { type: "text/plain" }),
    );
    const res = await app.request("/artifacts/upload", form(files));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { artifacts: unknown[] }).artifacts.length).toBe(files.length);
  }, 60_000);
});

describe("download over HTTP", () => {
  test("serves a csv-export as an attachment with nosniff", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, {
      kind: "csv-export",
      title: "Keywords",
      content: "a,b\n",
    });
    const res = await host(db).request(`/artifacts/${row.id}/download`);
    expect(await res.text()).toBe("a,b\n");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="Keywords.csv"',
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("a PDF is inline only with ?inline=1", async () => {
    const db = await testDb();
    const app = host(db);
    const pdf = new File([new Uint8Array([37, 80, 68, 70])], "deck.pdf", {
      type: "application/pdf",
    });
    const data = new FormData();
    data.append("files", pdf);
    const created = (await (
      await app.request("/artifacts/upload", { method: "POST", body: data })
    ).json()) as { artifacts: { id: string }[] };
    const id = created.artifacts[0]!.id;

    expect(
      (await app.request(`/artifacts/${id}/download`)).headers.get("content-disposition"),
    ).toStartWith("attachment;");
    expect(
      (await app.request(`/artifacts/${id}/download?inline=1`)).headers.get(
        "content-disposition",
      ),
    ).toStartWith("inline;");
  });

  test("a non-downloadable kind is 400", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { kind: "document" });
    expect((await host(db).request(`/artifacts/${row.id}/download`)).status).toBe(400);
  });
});

describe("mail attachment references", () => {
  test("records and lists an artifact↔message association, idempotently", async () => {
    const db = await testDb();
    const app = host(db);
    const file = await seedArtifact(db, { kind: "file", title: "a.pdf" });

    const body = {
      mailId: "mail-1",
      attachments: [
        { artifactId: file.id, name: "a.pdf", type: "application/pdf", size: 12 },
      ],
    };
    expect((await app.request("/instances/inst-1/mail-attachments", json(body))).status).toBe(
      201,
    );
    expect((await app.request("/instances/inst-1/mail-attachments", json(body))).status).toBe(
      201,
    );

    const listed = (await (
      await app.request("/instances/inst-1/mail-attachments")
    ).json()) as { refs: unknown[] };
    expect(listed.refs).toEqual([
      { mailId: "mail-1", artifactId: file.id, name: "a.pdf", type: "application/pdf", size: 12 },
    ]);
  });

  test("rejects a malformed body and refuses the WRITE without a principal", async () => {
    const db = await testDb();
    expect(
      (
        await host(db).request(
          "/instances/inst-1/mail-attachments",
          json({ mailId: "", attachments: [] }),
        )
      ).status,
    ).toBe(400);
    // The write is a mutation, so 403. The matching READ is a collection read
    // and answers an empty 200 — see the no-identity route-class block below.
    expect(
      (
        await host(db, { principal: null }).request(
          "/instances/inst-1/mail-attachments",
          json({
            mailId: "mail-1",
            attachments: [
              { artifactId: "a", name: "a.pdf", type: "application/pdf", size: 1 },
            ],
          }),
        )
      ).status,
    ).toBe(403);
  });

  // The route used to accept ANY string as an artifactId with no existence and
  // no tenant check, so a reference to another tenant's artifact was recorded
  // and answered 201. This table is an artifact↔message association; an
  // association to something that is not this tenant's artifact is not one.
  test("an artifactId the caller cannot see is refused, and nothing is written", async () => {
    const db = await testDb();
    const app = host(db);
    const foreign = await seedArtifact(db, { tenantId: "other" });
    const draft = await seedSkillDraft(db, "scratch");

    const post = (artifactId: string, mailId: string) =>
      app.request(
        "/instances/inst-1/mail-attachments",
        json({
          mailId,
          attachments: [
            { artifactId, name: "a.pdf", type: "application/pdf", size: 1 },
          ],
        }),
      );

    for (const [cause, artifactId] of [
      ["ghost id", "00000000-0000-4000-8000-000000000000"],
      ["cross-tenant", foreign.id],
      ["skill-draft", draft],
      ["malformed id", "not-a-uuid"],
    ] as [string, string][]) {
      const res = await post(artifactId, `mail-${cause}`);
      expect({ cause, status: res.status, body: await res.json() }).toEqual({
        cause,
        status: 404,
        body: { error: "Artifact not found" },
      });
    }

    const listed = (await (
      await app.request("/instances/inst-1/mail-attachments")
    ).json()) as { refs: unknown[] };
    expect(listed.refs).toEqual([]);
  });

  // All-or-nothing: one bad reference in a batch refuses the batch, so a
  // caller cannot smuggle a foreign id alongside a legitimate one.
  test("one unusable reference in a batch refuses the whole batch", async () => {
    const db = await testDb();
    const app = host(db);
    const mine = await seedArtifact(db, { kind: "file", title: "a.pdf" });
    const foreign = await seedArtifact(db, { tenantId: "other" });

    const res = await app.request(
      "/instances/inst-1/mail-attachments",
      json({
        mailId: "mail-1",
        attachments: [
          { artifactId: mine.id, name: "a.pdf", type: "application/pdf", size: 1 },
          { artifactId: foreign.id, name: "b.pdf", type: "application/pdf", size: 1 },
        ],
      }),
    );
    expect(res.status).toBe(404);

    const listed = (await (
      await app.request("/instances/inst-1/mail-attachments")
    ).json()) as { refs: unknown[] };
    expect(listed.refs).toEqual([]);
  });
});

describe("post-commit side effects never turn a committed write into a 500", () => {
  // Enrichment runs against HOST-supplied seams after the transaction commits.
  // A throwing host must not make a durable mutation report failure: the client
  // would retry a write that already succeeded, and keep retrying forever.
  const exploding = {
    identity: fakeIdentity({
      ownerNames: async () => {
        throw new Error("host directory is down");
      },
    }),
    decorate: async () => {
      throw new Error("host workflow lookup is down");
    },
  };

  test("POST /artifacts still returns 201 and the artifact is durable", async () => {
    const db = await testDb();
    const app = host(db, exploding);

    const res = await app.request(
      "/artifacts",
      json({ mode: "text", title: "Survives", content: "body" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { artifact: { id: string; ownerName: null } };
    expect(body.artifact.ownerName).toBeNull();

    const rows = await listArtifacts(db, fakeIdentity(), SCOPE.tenantId, {});
    expect(rows.rows.map((r) => r.id)).toEqual([body.artifact.id]);
  });

  test("POST /artifacts/upload still returns 201", async () => {
    const db = await testDb();
    const form = new FormData();
    form.append("file", new File(["hello"], "a.txt", { type: "text/plain" }));
    const res = await host(db, exploding).request("/artifacts/upload", {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(201);
  });

  test("archive/unarchive still return 200 with the row's new state", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { title: "Put away" });
    const app = host(db, exploding);

    const archived = await app.request(`/artifacts/${row.id}/archive`, { method: "POST" });
    expect(archived.status).toBe(200);
    expect(((await archived.json()) as any).artifact.archivedAt).not.toBeNull();

    const restored = await app.request(`/artifacts/${row.id}/unarchive`, { method: "POST" });
    expect(restored.status).toBe(200);
    expect(((await restored.json()) as any).artifact.archivedAt).toBeNull();
  });
});

// The cross-core no-member asymmetry, asserted per route CLASS rather
// than per happenstance, so a route added later has an obvious bucket to fall
// into and this file fails if it lands in the wrong one.
describe("no-identity response: every route matches the cross-core rule", () => {
  // Collection reads answer the truth — "you have none" — because the answer
  // names no resource and so discloses nothing.
  test("list/collection reads return an empty 200", async () => {
    const db = await testDb();
    await seedArtifact(db, { title: "Someone else's" });
    const app = host(db, { principal: null });

    const list = await app.request("/artifacts");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ artifacts: [], nextCursor: null });

    const refs = await app.request("/instances/inst-1/mail-attachments");
    expect(refs.status).toBe(200);
    expect(await refs.json()).toEqual({ refs: [] });
  });

  // Detail reads name one artifact, and whether it exists is not a signed-out
  // caller's to learn — so they refuse rather than 404, which would separate a
  // real id from a fabricated one.
  test("single-item detail reads return 403, not 404", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { title: "Private" });
    const app = host(db, { principal: null });

    for (const path of [
      `/artifacts/${row.id}`,
      `/artifacts/${row.id}/versions`,
      `/artifacts/${row.id}/download`,
    ]) {
      expect((await app.request(path)).status).toBe(403);
    }
  });

  test("mutations return 403", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { title: "Private" });
    const app = host(db, { principal: null });

    expect(
      (await app.request("/artifacts", json({ mode: "text", title: "t", content: "b" })))
        .status,
    ).toBe(403);

    const form = new FormData();
    form.append("file", new File(["hi"], "a.txt", { type: "text/plain" }));
    expect(
      (await app.request("/artifacts/upload", { method: "POST", body: form })).status,
    ).toBe(403);

    expect(
      (await app.request(`/artifacts/${row.id}/versions`, json({ content: "x" }))).status,
    ).toBe(403);
    expect(
      (await app.request(`/artifacts/${row.id}/archive`, { method: "POST" })).status,
    ).toBe(403);
    expect(
      (await app.request(`/artifacts/${row.id}/unarchive`, { method: "POST" })).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          "/instances/inst-1/mail-attachments",
          json({
            mailId: "mail-1",
            attachments: [
              { artifactId: row.id, name: "a.pdf", type: "application/pdf", size: 1 },
            ],
          }),
        )
      ).status,
    ).toBe(403);
  });

  // A refused mutation must also not have happened. A 403 that still wrote
  // would be the worse bug of the two.
  test("a refused mutation leaves nothing behind", async () => {
    const db = await testDb();
    const before = await listArtifacts(db, fakeIdentity(), SCOPE.tenantId, {});
    const app = host(db, { principal: null });
    await app.request("/artifacts", json({ mode: "text", title: "ghost", content: "b" }));
    const after = await listArtifacts(db, fakeIdentity(), SCOPE.tenantId, {});
    expect(after.rows.length).toBe(before.rows.length);
  });
});

describe("hardening regressions", () => {
  test("revising someone else's artifact is 403, admin may", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { ownerPrincipalId: "someone-else" });
    const revise = (app: Hono) =>
      app.request(`/artifacts/${row.id}/versions`, json({ content: "hijack" }));

    expect((await revise(host(db))).status).toBe(403);
    const admin = host(db, { isAdmin: async () => true });
    expect((await revise(admin)).status).toBe(200);
  });

  test("revising a web_site with invalid content is 400, not 404", async () => {
    const db = await testDb();
    const app = host(db);
    const row = await seedArtifact(db, {
      kind: "web_site",
      content: JSON.stringify({ entry: "index.html", files: { "index.html": "<p>" } }),
    });
    const res = await app.request(
      `/artifacts/${row.id}/versions`,
      json({ content: JSON.stringify({ files: {} }) }),
    );
    expect(res.status).toBe(400);
  });

  test("kind must agree with mode on import", async () => {
    const db = await testDb();
    const app = host(db);
    const linkAsText = await app.request(
      "/artifacts",
      json({ mode: "text", title: "t", content: "not a url", kind: "link" }),
    );
    expect(linkAsText.status).toBe(400);
    const docAsUrl = await app.request(
      "/artifacts",
      json({ mode: "url", title: "t", content: "https://x.example", kind: "document" }),
    );
    expect(docAsUrl.status).toBe(400);
  });

  test("only the named generatedBy field carries provenance, capped at 200", async () => {
    const db = await testDb();
    const app = host(db);
    const form = new FormData();
    form.append("file", new File(["x"], "a.txt", { type: "text/plain" }));
    form.append("comment", "stray text field");
    const res = await app.request("/artifacts/upload", { method: "POST", body: form });
    expect(res.status).toBe(201);
    const { artifacts } = (await res.json()) as any;
    expect(artifacts[0].source.generatedBy).toBeUndefined();

    const over = new FormData();
    over.append("file", new File(["x"], "a.txt", { type: "text/plain" }));
    over.append("generatedBy", "x".repeat(201));
    expect(
      (await app.request("/artifacts/upload", { method: "POST", body: over })).status,
    ).toBe(400);
  });

  test("a non-ASCII filename downloads with an RFC 5987 header instead of 500ing", async () => {
    const db = await testDb();
    const app = host(db);
    const form = new FormData();
    form.append("file", new File(["pdf bytes"], "résumé—final.pdf", { type: "application/pdf" }));
    const up = await app.request("/artifacts/upload", { method: "POST", body: form });
    expect(up.status).toBe(201);
    const { artifacts } = (await up.json()) as any;

    const dl = await app.request(`/artifacts/${artifacts[0].id}/download`);
    expect(dl.status).toBe(200);
    const cd = dl.headers.get("content-disposition")!;
    expect(cd).toContain("filename*=UTF-8''");
    expect(cd).toMatch(/filename="[\x20-\x7e]*"/);
  });

  test("the download body is exactly the view's bytes even from an offset buffer", async () => {
    const db = await testDb();
    const backing = new Uint8Array(64).fill(0xaa);
    backing.set([1, 2, 3], 16);
    const store = {
      put: InlineContentStore.put,
      get: async () => ({
        bytes: backing.subarray(16, 19),
        mimeType: "application/octet-stream",
        filename: "view.bin",
      }),
    };
    const app = new Hono();
    mountArtifacts(app, {
      db,
      contentStore: store,
      resolvePrincipal: () => SCOPE,
      identity: fakeIdentity(),
    });
    const row = await seedArtifact(db, {
      kind: "file",
      source: { origin: "imported", upload: { id: "u-1", filename: "view.bin", mimeType: "application/octet-stream", size: 3 } },
    });
    const res = await app.request(`/artifacts/${row.id}/download`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});
