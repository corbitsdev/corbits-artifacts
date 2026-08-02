import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { createRequireGrant, type RequireGrant, type TenantEnv } from "@intx/hub-api";
import { createInMemoryGrantStore } from "@intx/authz";
import type { GrantRule } from "@intx/types/authz";
import { mountArtifacts } from "./mount.js";
import { InlineContentStore } from "./content-store.js";
import {
  listArtifacts,
  MAX_ARTIFACT_CONTENT_BYTES,
  setArtifactArchived,
} from "./artifacts.js";
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILE_COUNT,
  MAX_UPLOAD_TOTAL_BYTES,
} from "./uploads.js";
import type { ArtifactDb } from "./db.js";
import type { MountArtifactsOpts } from "./mount.js";
import type { ResolvedPrincipal } from "./ports.js";
import { seedArtifact, seedSkillDraft, SCOPE, testDb } from "./test-helpers.js";

/** Places tenant/principal on the context the way a real host's session
 * middleware does, without pinning it to any one `requireGrant` wiring. */
function withPrincipal(app: Hono<TenantEnv>, principal: ResolvedPrincipal | null) {
  app.use("*", async (c, next) => {
    if (principal !== null) {
      const now = new Date(0);
      c.set("tenant", {
        id: principal.tenantId,
        name: principal.tenantId,
        slug: principal.tenantId,
        domain: `${principal.tenantId}.example`,
        parentId: null,
        config: null,
        createdAt: now,
        updatedAt: now,
      });
      c.set("principal", {
        id: principal.principalId,
        tenantId: principal.tenantId,
        kind: "user",
        refId: principal.principalId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
    }
    await next();
  });
  return app;
}

/** A grant minted for exactly one resource/action/principal — deny is simply
 * not minting the matching one, which is how the real store discriminates. */
function grantRule(over: Partial<GrantRule> & Pick<GrantRule, "resource" | "action" | "principalId">): GrantRule {
  return {
    id: `grant-${over.resource}-${over.action}-${over.principalId}`,
    effect: "allow",
    origin: "creator",
    conditions: null,
    expiresAt: null,
    roleId: null,
    ...over,
  };
}

type HostOpts = {
  principal?: ResolvedPrincipal | null;
  authorize?: (resource: string, action: string) => boolean;
  decorate?: MountArtifactsOpts["decorate"];
  contentStore?: MountArtifactsOpts["contentStore"];
};

function host(db: ArtifactDb, opts: HostOpts = {}) {
  const app = new Hono<TenantEnv>();
  const principal = opts.principal === undefined ? SCOPE : opts.principal;
  app.use("*", async (c, next) => {
    if (principal !== null) {
      const now = new Date(0);
      c.set("tenant", {
        id: principal.tenantId,
        name: principal.tenantId,
        slug: principal.tenantId,
        domain: `${principal.tenantId}.example`,
        parentId: null,
        config: null,
        createdAt: now,
        updatedAt: now,
      });
      c.set("principal", {
        id: principal.principalId,
        tenantId: principal.tenantId,
        kind: "user",
        refId: principal.principalId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
    }
    await next();
  });
  const requireGrant: RequireGrant = (resource, action) => async (c, next) => {
    const resolved =
      typeof resource === "function"
        ? resource({ param: (name) => c.req.param(name) })
        : resource;
    const allowed = (opts.authorize ?? (() => true))(resolved, action);
    if (!allowed) {
      return c.json(
        {
          error: {
            code: "forbidden",
            message: "forbidden",
          },
        },
        403,
      );
    }
    return next();
  };
  return mountArtifacts(app, {
    db,
    contentStore: opts.contentStore ?? InlineContentStore,
    requireGrant,
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

  // Auth must run before body parse: an unauthenticated caller never learns
  // whether the body was valid JSON/shape — they get 403 either way.
  test("is 403 for an unauthenticated caller even when the body is empty or invalid", async () => {
    const db = await testDb();
    const app = host(db, { principal: null });
    for (const body of ["", "{", "{}", "null"]) {
      const res = await app.request("/artifacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect({ body, status: res.status, json: await res.json() }).toEqual({
        body,
        status: 403,
        json: { error: "Tenant not accessible" },
      });
    }
  });

  test("rejects a declared Content-Length over the content ceiling with 413", async () => {
    const db = await testDb();
    const res = await host(db).request("/artifacts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_ARTIFACT_CONTENT_BYTES + 1),
      },
      // Body is small; the declared length alone must be enough to refuse.
      body: JSON.stringify({ mode: "text", title: "t", content: "small" }),
    });
    expect(res.status).toBe(413);
  });

  test("rejects oversize content after parse with 400", async () => {
    const db = await testDb();
    const res = await host(db).request(
      "/artifacts",
      json({
        mode: "text",
        title: "t",
        content: "x".repeat(MAX_ARTIFACT_CONTENT_BYTES + 1),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/content exceeds/i);
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

  test("runs the display-only provenance decorator", async () => {
    const db = await testDb();
    await seedArtifact(db, { title: "Doc" });

    const decorated: string[] = [];
    const app = host(db, {
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

  test("rejects a bad cursor and a bad date with 400", async () => {
    const db = await testDb();
    const app = host(db);
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
  // Auth (loadScoped) before body parse: empty/invalid body still 403 when signed out.
  test("revise is 403 for an unauthenticated caller even with an empty or invalid body", async () => {
    const db = await testDb();
    const row = await seedArtifact(db);
    const app = host(db, { principal: null });
    for (const body of ["", "{", "{}", "null"]) {
      const res = await app.request(`/artifacts/${row.id}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect({ body, status: res.status, json: await res.json() }).toEqual({
        body,
        status: 403,
        json: { error: "Forbidden" },
      });
    }
  });

  test("revise rejects a declared Content-Length over the content ceiling with 413", async () => {
    const db = await testDb();
    const row = await seedArtifact(db);
    const res = await host(db).request(`/artifacts/${row.id}/versions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_ARTIFACT_CONTENT_BYTES + 1),
      },
      body: JSON.stringify({ content: "small" }),
    });
    expect(res.status).toBe(413);
  });

  test("revises through the route and lists the history newest-first", async () => {
    const db = await testDb();
    const app = host(db);
    const row = await seedArtifact(db, { title: "Draft", content: "v1" });

    const res = await app.request(`/artifacts/${row.id}/versions`, json({ content: "v2" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: 2, title: "Draft" });

    const history = (await (
      await app.request(`/artifacts/${row.id}/versions`)
    ).json()) as { versions: { version: number }[]; nextCursor: string | null };
    expect(history.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(history.nextCursor).toBeNull();
  });

  test("version history paginates with cursor and limit", async () => {
    const db = await testDb();
    const app = host(db);
    const row = await seedArtifact(db, { title: "Draft", content: "v1" });
    await app.request(`/artifacts/${row.id}/versions`, json({ content: "v2" }));
    await app.request(`/artifacts/${row.id}/versions`, json({ content: "v3" }));

    const page1 = (await (
      await app.request(`/artifacts/${row.id}/versions?limit=2`)
    ).json()) as { versions: { version: number }[]; nextCursor: string | null };
    expect(page1.versions.map((v) => v.version)).toEqual([3, 2]);
    expect(page1.nextCursor).toBe("2");

    const page2 = (await (
      await app.request(`/artifacts/${row.id}/versions?limit=2&cursor=${page1.nextCursor}`)
    ).json()) as { versions: { version: number }[]; nextCursor: string | null };
    expect(page2.versions.map((v) => v.version)).toEqual([1]);
    expect(page2.nextCursor).toBeNull();
  });

  test("oversize create title is 400", async () => {
    const db = await testDb();
    const res = await host(db).request(
      "/artifacts",
      json({
        title: "x".repeat(513),
        content: "ok",
        mode: "text",
      }),
    );
    expect(res.status).toBe(400);
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
  const post = (app: Hono<TenantEnv>, id: string, verb: string) =>
    app.request(`/artifacts/${id}/${verb}`, { method: "POST" });

  test("allow records checks for archive and unarchive", async () => {
    const db = await testDb();
    const row = await seedArtifact(db);
    const checks: { resource: string; action: string }[] = [];
    const app = host(db, {
      authorize: (resource, action) => {
        checks.push({ resource, action });
        return true;
      },
    });

    const archived = await post(app, row.id, "archive");
    expect(archived.status).toBe(200);
    expect(((await archived.json()) as any).artifact.archivedAt).not.toBeNull();

    const restored = await post(app, row.id, "unarchive");
    expect(((await restored.json()) as any).artifact.archivedAt).toBeNull();

    expect(checks).toEqual([
      { resource: `artifact:${row.id}`, action: "archive" },
      { resource: `artifact:${row.id}`, action: "archive" },
    ]);
  });

  test("deny authorize false expects 403 and leaves archived_at null", async () => {
    const db = await testDb();
    const row = await seedArtifact(db);
    const app = host(db, { authorize: () => false });

    expect((await post(app, row.id, "archive")).status).toBe(403);

    const rows = await db.execute<{ archived_at: Date | null }>(
      sql`SELECT "archived_at" FROM "artifacts"."artifact" WHERE "id" = ${row.id}`,
    );
    expect(rows[0]!.archived_at).toBeNull();
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

/**
 * `archive authorization` above proves WIRING: the package calls whatever
 * `requireGrant` it is handed with the right resource/action and honors the
 * answer. It says nothing about whether a real grant check would refuse
 * anyone, because its stub `authorize` is a bare predicate the test itself
 * chooses the answer for.
 *
 * This block runs the SAME routes through `createRequireGrant` +
 * `createInMemoryGrantStore` from the platform's own `@intx/hub-api` /
 * `@intx/authz` — the exact evaluator a real host runs in production, not a
 * reimplementation of it. Grants are looked up by `principalId`, so a caller
 * who was never minted one is refused on the merits, not because a test typed
 * `() => false`.
 */
describe("authorization through the real platform grant evaluator", () => {
  const OWNER: ResolvedPrincipal = SCOPE;
  const NON_OWNER: ResolvedPrincipal = { tenantId: SCOPE.tenantId, principalId: "someone-else" };

  function hostWithGrants(
    db: ArtifactDb,
    principal: ResolvedPrincipal | null,
    grants: GrantRule[],
  ) {
    const requireGrant = createRequireGrant({
      grantStore: createInMemoryGrantStore(grants),
      conditionRegistry: {},
    });
    return mountArtifacts(withPrincipal(new Hono<TenantEnv>(), principal), {
      db,
      contentStore: InlineContentStore,
      requireGrant,
    });
  }

  test("the owner's creator-origin grant allows write; a co-tenant with no grant is refused", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { content: "v1" });
    const grants = [
      grantRule({ resource: `artifact:${row.id}`, action: "write", principalId: OWNER.principalId }),
    ];

    const ownerRes = await hostWithGrants(db, OWNER, grants).request(
      `/artifacts/${row.id}/versions`,
      json({ content: "v2" }),
    );
    expect(ownerRes.status).toBe(200);

    // Same grant list, same tenant, no grant naming this principal: the real
    // evaluator finds nothing to match and fails closed, not open.
    const intruderRes = await hostWithGrants(db, NON_OWNER, grants).request(
      `/artifacts/${row.id}/versions`,
      json({ content: "hijack" }),
    );
    expect(intruderRes.status).toBe(403);

    const [current] = await db.execute<{ content: string }>(
      sql`SELECT "content" FROM "artifacts"."artifact" WHERE "id" = ${row.id}`,
    );
    expect(current!.content).toBe("v2");
  });

  test("a grant for the wrong action does not authorize a different one", async () => {
    const db = await testDb();
    const row = await seedArtifact(db);
    // The owner can write, but was never granted archive.
    const grants = [
      grantRule({ resource: `artifact:${row.id}`, action: "write", principalId: OWNER.principalId }),
    ];
    const app = hostWithGrants(db, OWNER, grants);

    expect(
      (await app.request(`/artifacts/${row.id}/archive`, { method: "POST" })).status,
    ).toBe(403);
    const [current] = await db.execute<{ archived_at: Date | null }>(
      sql`SELECT "archived_at" FROM "artifacts"."artifact" WHERE "id" = ${row.id}`,
    );
    expect(current!.archived_at).toBeNull();
  });

  test("no grants at all refuses everyone, including the artifact's own owner", async () => {
    const db = await testDb();
    const row = await seedArtifact(db);
    const app = hostWithGrants(db, OWNER, []);
    expect(
      (await app.request(`/artifacts/${row.id}/archive`, { method: "POST" })).status,
    ).toBe(403);
  });
});

/**
 * The other half of the wiring test above: `onArtifactCreated` is the seam a
 * host uses to provision the grant that later authorizes the caller against
 * the row it just made — see the reference host for a real one backed by
 * `@intx/db`'s grant table. Here the point is narrower: the hook runs inside
 * the SAME transaction as the insert, once per created row, with the row and
 * the creating scope.
 */
describe("onArtifactCreated: the host's grant-provisioning seam", () => {
  // These tests are about the hook, not authorization, so the grant check
  // itself is a trivial always-allow — `requireGrant` isn't even reached by
  // POST /artifacts or /artifacts/upload, which authorize nothing on create.
  const allowAll: RequireGrant = () => async (_c, next) => next();

  test("runs once with the created row and the creating scope", async () => {
    const db = await testDb();
    const seen: { row: { id: string }; scope: ResolvedPrincipal }[] = [];
    const app = mountArtifacts(withPrincipal(new Hono<TenantEnv>(), SCOPE), {
      db,
      contentStore: InlineContentStore,
      requireGrant: allowAll,
      onArtifactCreated: async (_tx, row, scope) => {
        seen.push({ row: { id: row.id }, scope });
      },
    });

    const res = await app.request(
      "/artifacts",
      json({ mode: "text", title: "Provisioned", content: "body" }),
    );
    const body = (await res.json()) as { artifact: { id: string } };
    expect(seen).toEqual([{ row: { id: body.artifact.id }, scope: SCOPE }]);
  });

  test("a throw inside the hook rolls back the artifact insert — no orphan row", async () => {
    const db = await testDb();
    const app = mountArtifacts(withPrincipal(new Hono<TenantEnv>(), SCOPE), {
      db,
      contentStore: InlineContentStore,
      requireGrant: allowAll,
      onArtifactCreated: async () => {
        throw new Error("grant store is down");
      },
    });

    await app.request("/artifacts", json({ mode: "text", title: "Orphan?", content: "body" }));
    const rows = await listArtifacts(db, SCOPE.tenantId, {});
    expect(rows.rows.length).toBe(0);
  });

  test("runs once per file on the upload route", async () => {
    const db = await testDb();
    const ids: string[] = [];
    const app = mountArtifacts(withPrincipal(new Hono<TenantEnv>(), SCOPE), {
      db,
      contentStore: InlineContentStore,
      requireGrant: allowAll,
      onArtifactCreated: async (_tx, row) => {
        ids.push(row.id);
      },
    });

    const form = new FormData();
    form.append("files", new File(["a"], "a.txt", { type: "text/plain" }));
    form.append("files", new File(["b"], "b.txt", { type: "text/plain" }));
    const res = await app.request("/artifacts/upload", { method: "POST", body: form });
    const body = (await res.json()) as { artifacts: { id: string }[] };
    expect(ids.sort()).toEqual(body.artifacts.map((a) => a.id).sort());
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
  // Auth before body parse on the write route.
  test("POST is 403 for an unauthenticated caller even with an empty or invalid body", async () => {
    const db = await testDb();
    const app = host(db, { principal: null });
    for (const body of ["", "{", "{}", "null"]) {
      const res = await app.request("/instances/inst-1/mail-attachments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect({ body, status: res.status, json: await res.json() }).toEqual({
        body,
        status: 403,
        json: { error: "Tenant not accessible" },
      });
    }
  });

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
    // and answers an empty 200 — see the no-principal route-class block below.
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
  // Enrichment runs against HOST-supplied decorator after the transaction commits.
  // A throwing host must not make a durable mutation report failure: the client
  // would retry a write that already succeeded, and keep retrying forever.
  const exploding = {
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
    const body = (await res.json()) as { artifact: { id: string } };

    const rows = await listArtifacts(db, SCOPE.tenantId, {});
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
describe("no-principal response: every route matches the cross-core rule", () => {
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
    const before = await listArtifacts(db, SCOPE.tenantId, {});
    const app = host(db, { principal: null });
    await app.request("/artifacts", json({ mode: "text", title: "ghost", content: "b" }));
    const after = await listArtifacts(db, SCOPE.tenantId, {});
    expect(after.rows.length).toBe(before.rows.length);
  });
});

describe("hardening regressions", () => {
  test("write grant deny is 403; allow records artifact:id/write and returns 200", async () => {
    const db = await testDb();
    const row = await seedArtifact(db);
    const revise = (app: Hono<TenantEnv>) =>
      app.request(`/artifacts/${row.id}/versions`, json({ content: "hijack" }));

    expect((await revise(host(db, { authorize: () => false }))).status).toBe(403);

    const checks: { resource: string; action: string }[] = [];
    const allowed = host(db, {
      authorize: (resource, action) => {
        checks.push({ resource, action });
        return true;
      },
    });
    expect((await revise(allowed)).status).toBe(200);
    expect(checks).toEqual([{ resource: `artifact:${row.id}`, action: "write" }]);
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
    const app = host(db, { contentStore: store });
    const row = await seedArtifact(db, {
      kind: "file",
      source: { origin: "imported", upload: { id: "u-1", filename: "view.bin", mimeType: "application/octet-stream", size: 3 } },
    });
    const res = await app.request(`/artifacts/${row.id}/download`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});
