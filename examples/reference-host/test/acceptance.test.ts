// Acceptance: every scenario runs against a real @intx/hub-api app with
// @corbits/artifacts mounted on it and a real Postgres behind it. Nothing is
// stubbed except the hub's session lookup.
//
// These assertions used to live in a hand-rolled `assert()` script that `bun
// test` never collected, so they could rot without anything going red. They are
// bun tests now, so the reference-host integration test is actually part of
// the suite.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  createFileArtifact,
  DataUrlContentStore,
  InlineContentStore,
  PARSED_DOCUMENT_POLICY,
  runArtifactMigrations,
  UnsupportedUploadTypeError,
  type ContentStore,
} from "@corbits/artifacts";
import { createReferenceHost, type ReferenceHost } from "../src/index.js";

let host: ReferenceHost;
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

const postJson = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  host = await createReferenceHost();
});

afterAll(async () => {
  await host.close();
});

// The one artifact the later scenarios (archive, authz, deep link) reuse.
let artifactId: string;

describe("reference host", () => {
  test("is a live @intx/hub-api app", async () => {
    expect((await host.request("/status")).status).toBe(200);
  });
});

describe("import a URL, read it back, revise it, read the history", () => {
  test("a URL import creates the artifact at version 1", async () => {
    const res = await host.request(
      "/api/artifacts",
      postJson({ mode: "url", title: "Launch plan", content: "https://example.com/plan" }),
    );
    expect(res.status).toBe(201);
    const created = await json<{ artifact: { id: string; version: number } }>(res);
    expect(created.artifact.version).toBe(1);
    artifactId = created.artifact.id;
  });

  test("the identity seam resolves the owner's name from the host directory", async () => {
    const detail = await json<{
      artifact: { ownerName: string | null; source: Record<string, unknown> };
    }>(await host.request(`/api/artifacts/${artifactId}`));
    expect(detail.artifact.ownerName).toBe("Alice Ash");
    expect(detail.artifact.source.origin).toBe("imported");
  });

  test("revising bumps to version 2 and version 1 keeps its original title", async () => {
    const revised = await host.request(
      `/api/artifacts/${artifactId}/versions`,
      postJson({ title: "Launch plan v2", content: "https://example.com/plan-2" }),
    );
    expect((await json<{ version: number }>(revised)).version).toBe(2);

    const history = await json<{ versions: { version: number; title: string }[] }>(
      await host.request(`/api/artifacts/${artifactId}/versions`),
    );
    expect(history.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(history.versions[1]!.title).toBe("Launch plan");
  });
});

// The ContentStore is a port, and the proof is that the SAME scenarios pass
// over two different backends with nothing else changed, so a further backend
// is an impl swap rather than a rewrite.
describe.each<[string, ContentStore]>([
  ["InlineContentStore", InlineContentStore],
  ["DataUrlContentStore", DataUrlContentStore],
])("upload and download over %s", (name, store) => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7, 7, 7]);
  const PDF = new Uint8Array(Buffer.from("%PDF-1.7 reference"));

  type Uploaded = {
    id: string;
    kind: string;
    version: number;
    generatedByLabel?: string;
  };

  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let uploaded: Uploaded[];

  beforeAll(async () => {
    app = host.buildApp(store, async () => false);
    const form = new FormData();
    form.append("files", new File([PNG], "chart.png", { type: "image/png" }));
    form.append("files", new File([PDF], "deck.pdf", { type: "application/pdf" }));
    form.append("generatedBy", "Reference host");
    const res = await app.request("/api/artifacts/upload", { method: "POST", body: form });
    expect(res.status).toBe(201);
    uploaded = (await json<{ artifacts: Uploaded[] }>(res)).artifacts;
  });

  test("every upload eagerly mints an artifact at version 1", () => {
    expect(uploaded.map((a) => a.kind)).toEqual(["image", "file"]);
    expect(uploaded.every((a) => a.version === 1)).toBe(true);
  });

  test("the provenance decorator ran (display-only)", () => {
    expect(uploaded[0]!.generatedByLabel).toBe("Reference host");
  });

  test("the image downloads byte for byte as a nosniff attachment", async () => {
    const png = await app.request(`/api/artifacts/${uploaded[0]!.id}/download`);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(png.headers.get("x-content-type-options")).toBe("nosniff");
    expect(png.headers.get("content-disposition")).toBe('attachment; filename="chart.png"');
    expect(new Uint8Array(await png.arrayBuffer())).toEqual(PNG);
  });

  test("a PDF is an attachment unless ?inline=1 is asked for", async () => {
    const id = uploaded[1]!.id;
    const attached = await app.request(`/api/artifacts/${id}/download`);
    const inline = await app.request(`/api/artifacts/${id}/download?inline=1`);
    expect(attached.headers.get("content-disposition")).toStartWith("attachment;");
    expect(inline.headers.get("content-disposition")).toStartWith("inline;");
  });

  test("mail_attachment_ref is an idempotent artifact↔message association", async () => {
    const pdfId = uploaded[1]!.id;
    const body = {
      mailId: `mail-${name}`,
      attachments: [
        { artifactId: pdfId, name: "deck.pdf", type: "application/pdf", size: PDF.length },
      ],
    };
    // Posted twice: the file already IS an artifact, so no bytes move and the
    // second post must record nothing new.
    for (let i = 0; i < 2; i += 1) {
      await app.request(`/api/instances/inst-${name}/mail-attachments`, postJson(body));
    }
    const refs = await json<{ refs: { artifactId: string }[] }>(
      await app.request(`/api/instances/inst-${name}/mail-attachments`),
    );
    expect(refs.refs.map((r) => r.artifactId)).toEqual([pdfId]);
  });
});

describe("an unsupported upload is refused, leaving nothing behind", () => {
  test("an SVG is rejected 415 and no orphan artifact is created", async () => {
    const before = await json<{ artifacts: unknown[] }>(
      await host.request("/api/artifacts?limit=100"),
    );
    const form = new FormData();
    form.append("files", new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }));
    const res = await host.request("/api/artifacts/upload", { method: "POST", body: form });
    const after = await json<{ artifacts: unknown[] }>(
      await host.request("/api/artifacts?limit=100"),
    );

    expect(res.status).toBe(415);
    expect(after.artifacts.length).toBe(before.artifacts.length);
  });
});

describe("list: keyset paging, creatorKind, and the archived toggle", () => {
  test("a keyset cursor is minted and the next page repeats nothing", async () => {
    const page1 = await json<{ artifacts: { id: string }[]; nextCursor: string | null }>(
      await host.request("/api/artifacts?limit=2"),
    );
    expect(page1.artifacts.length).toBe(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await json<{ artifacts: { id: string }[] }>(
      await host.request(
        `/api/artifacts?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
      ),
    );
    const overlap = page2.artifacts.filter((a) =>
      page1.artifacts.some((b) => b.id === a.id),
    );
    expect(overlap).toEqual([]);
  });

  test("creatorKind resolves through the identity seam", async () => {
    // An agent-owned artifact, so creatorKind has something to separate.
    await host.db.execute(sql`
      INSERT INTO "artifacts"."artifact" ("tenant_id", "principal_id", "owner_principal_id",
        "kind", "title", "content", "source", "version")
      VALUES (${host.tenant}, ${host.agentPrincipal}, ${host.agentPrincipal}, 'document',
        'Agent memo', 'written by an agent', '{"origin":"agent"}'::jsonb, 1)
    `);

    const agentOnly = await json<{ artifacts: { title: string }[] }>(
      await host.request("/api/artifacts?creatorKind=agent"),
    );
    expect(agentOnly.artifacts.map((a) => a.title)).toEqual(["Agent memo"]);

    const humanOnly = await json<{ artifacts: { title: string }[] }>(
      await host.request("/api/artifacts?creatorKind=user"),
    );
    expect(humanOnly.artifacts.length).toBeGreaterThan(0);
    expect(humanOnly.artifacts.some((a) => a.title === "Agent memo")).toBe(false);
  });
});

describe("archive is a soft-hide, not a revocation", () => {
  test("archiving hides the artifact from the default listing only", async () => {
    expect(
      (await host.request(`/api/artifacts/${artifactId}/archive`, { method: "POST" })).status,
    ).toBe(200);

    const listed = await json<{ artifacts: { id: string }[] }>(
      await host.request("/api/artifacts?limit=100"),
    );
    expect(listed.artifacts.some((a) => a.id === artifactId)).toBe(false);

    const archivedView = await json<{ artifacts: { id: string }[] }>(
      await host.request("/api/artifacts?archived=true"),
    );
    expect(archivedView.artifacts.some((a) => a.id === artifactId)).toBe(true);

    expect((await host.request(`/api/artifacts/${artifactId}`)).status).toBe(200);
  });

  test("revising an archived artifact is refused as not found", async () => {
    const res = await host.request(
      `/api/artifacts/${artifactId}/versions`,
      postJson({ content: "sneaky" }),
    );
    expect(res.status).toBe(404);
    await host.request(`/api/artifacts/${artifactId}/unarchive`, { method: "POST" });
  });
});

describe("a non-owner is refused unless the host's authz seam says admin", () => {
  test("a non-owner, non-admin member is refused 403", async () => {
    host.setSession({ userId: "user-bob" });
    const res = await host.request(`/api/artifacts/${artifactId}/archive`, { method: "POST" });
    expect(res.status).toBe(403);
  });

  test("the same member succeeds once the authz seam grants admin", async () => {
    const adminApp = host.buildApp(InlineContentStore, async () => true);
    const res = await adminApp.request(`/api/artifacts/${artifactId}/archive`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    await adminApp.request(`/api/artifacts/${artifactId}/unarchive`, { method: "POST" });
    host.setSession({ userId: "user-alice" });
  });

  test("the member who owns the producing agent may administer its artifact", async () => {
    const [agentRow] = await host.db.execute<{ id: string }>(
      sql`SELECT "id" FROM "artifacts"."artifact" WHERE "title" = 'Agent memo' LIMIT 1`,
    );
    host.setSession({ userId: "user-alice" });
    expect(
      (await host.request(`/api/artifacts/${agentRow!.id}/archive`, { method: "POST" })).status,
    ).toBe(200);

    host.setSession({ userId: "user-bob" });
    expect(
      (await host.request(`/api/artifacts/${agentRow!.id}/unarchive`, { method: "POST" }))
        .status,
    ).toBe(403);
    host.setSession({ userId: "user-alice" });
  });
});

// The cross-core no-member asymmetry: collection reads answer empty, anything
// that names one artifact refuses.
describe("no session", () => {
  beforeAll(() => host.setSession(null));
  afterAll(() => host.setSession({ userId: "user-alice" }));

  test("the list returns an empty 200", async () => {
    const res = await host.request("/api/artifacts");
    expect(res.status).toBe(200);
    expect((await json<{ artifacts: unknown[] }>(res)).artifacts).toEqual([]);
  });

  test("the mail-attachment collection read is also an empty 200, not a 403", async () => {
    const res = await host.request("/api/instances/inst-InlineContentStore/mail-attachments");
    expect(res.status).toBe(200);
    expect((await json<{ refs: unknown[] }>(res)).refs).toEqual([]);
  });

  test("creating is refused 403", async () => {
    const res = await host.request(
      "/api/artifacts",
      postJson({ mode: "text", title: "x", content: "y" }),
    );
    expect(res.status).toBe(403);
  });

  test("a single-artifact detail read is refused 403", async () => {
    expect((await host.request(`/api/artifacts/${artifactId}`)).status).toBe(403);
  });
});

describe("a cross-tenant request fails closed", () => {
  test("a caller-supplied tenantId is not an override", async () => {
    // The FKs demand a real second tenant and principal in the control plane.
    await host.db.execute(sql`
      INSERT INTO "tenant" ("id", "name", "slug", "domain")
      VALUES ('some-other-tenant', 'Other Tenant', 'some-other-tenant', 'some-other.example')
      ON CONFLICT DO NOTHING
    `);
    await host.db.execute(sql`
      INSERT INTO "principal" ("id", "tenant_id", "kind", "ref_id", "status")
      VALUES ('outsider', 'some-other-tenant', 'user', 'user-outsider', 'active')
      ON CONFLICT DO NOTHING
    `);
    await host.db.execute(sql`
      INSERT INTO "artifacts"."artifact" ("tenant_id", "principal_id", "owner_principal_id",
        "kind", "title", "content", "source", "version")
      VALUES ('some-other-tenant', 'outsider', 'outsider', 'document',
        'Other tenant secret', 'not yours', '{"origin":"manual"}'::jsonb, 1)
    `);
    const res = await host.request("/api/artifacts?tenantId=some-other-tenant&limit=100");
    expect(res.status).toBe(200);
    const body = await json<{ artifacts: { title: string }[] }>(res);
    expect(body.artifacts.some((a) => a.title === "Other tenant secret")).toBe(false);
  });

  // Filtering the LIST is only half of failing closed: the artifact still has
  // an id, and the detail routes take it directly. They used to answer
  // `403 Forbidden` for another tenant's artifact while a never-minted id got
  // `404 Artifact not found`, which turned every detail route into an
  // existence oracle for arbitrary UUIDs across the whole deployment.
  test("the detail routes answer 404, identically to a never-minted id", async () => {
    const [foreign] = await host.db.execute<{ id: string }>(sql`
      SELECT "id" FROM "artifacts"."artifact" WHERE "title" = 'Other tenant secret' LIMIT 1
    `);
    const ids: [string, string][] = [
      ["cross-tenant", foreign!.id],
      ["ghost id", "00000000-0000-4000-8000-000000000000"],
      ["malformed id", "not-a-uuid"],
    ];
    const routes = (id: string): [string, RequestInit][] => [
      [`/api/artifacts/${id}`, {}],
      [`/api/artifacts/${id}/versions`, {}],
      [`/api/artifacts/${id}/versions`, postJson({ content: "x" })],
      [`/api/artifacts/${id}/archive`, { method: "POST" }],
      [`/api/artifacts/${id}/unarchive`, { method: "POST" }],
      [`/api/artifacts/${id}/download`, {}],
    ];

    for (const [cause, id] of ids) {
      for (const [path, init] of routes(id)) {
        const res = await host.request(path, init);
        const label = `${cause} ${init.method ?? "GET"} ${path.replace(id, ":id")}`;
        expect({ label, status: res.status, body: await res.json() }).toEqual({
          label,
          status: 404,
          body: { error: "Artifact not found" },
        });
      }
    }
  });

  test("a mail-attachment reference to another tenant's artifact is refused", async () => {
    const [foreign] = await host.db.execute<{ id: string }>(sql`
      SELECT "id" FROM "artifacts"."artifact" WHERE "title" = 'Other tenant secret' LIMIT 1
    `);
    const res = await host.request(
      "/api/instances/inst-cross/mail-attachments",
      postJson({
        mailId: "mail-cross",
        attachments: [
          {
            artifactId: foreign!.id,
            name: "secret.pdf",
            type: "application/pdf",
            size: 1,
          },
        ],
      }),
    );
    expect(res.status).toBe(404);

    const refs = await json<{ refs: unknown[] }>(
      await host.request("/api/instances/inst-cross/mail-attachments"),
    );
    expect(refs.refs).toEqual([]);
  });

  // The archived artifact left behind by the archive scenarios above is
  // restored there; nothing here mutates, so no cleanup is needed.
});

/**
 * Of "parse a PDF and serve it inline", INLINE is this module's and is
 * asserted above. PARSE IS THE HOST'S, deliberately, and this records the
 * decision rather than leaving it unstated:
 *
 * `@corbits/artifacts` ships no PDF parser and should not. It is the same
 * call already made for spreadsheets in `uploads.ts` — the module owns the
 * allowlist (`PARSED_DOCUMENT_POLICY`), the storage, and the artifact row; the
 * host owns the extraction, because the extractor is a heavyweight,
 * fast-moving dependency and because what the parsed text is FOR (a message
 * pipeline, a search index) is the host's product, not this module's.
 *
 * What the module owes a parsing host is a contract, and that IS testable
 * here: parse-before-store. `createFileArtifact` is the one way a file
 * becomes an artifact, so a host that parses first and fails leaves no orphan;
 * a host that parses successfully gets the bytes and its extracted text
 * written in the same transaction.
 */
describe("pdf parsing is the host's, and the module's contract with it holds", () => {
  const PDF = new Uint8Array(Buffer.from("%PDF-1.7 quarterly numbers"));

  // The host's parser. A real one is pdfjs or poppler; what matters to this
  // module is only that it runs BEFORE anything is stored and may throw.
  const parsePdf = (bytes: Uint8Array): string => {
    const text = Buffer.from(bytes).toString("latin1");
    if (!text.startsWith("%PDF-")) throw new Error("not a PDF");
    return text.slice("%PDF-1.7 ".length);
  };

  const count = async () =>
    (await json<{ artifacts: unknown[] }>(await host.request("/api/artifacts?limit=100")))
      .artifacts.length;

  test("a host parse failure mints no artifact and stores no bytes", async () => {
    const before = await count();
    const beforeUploads = await host.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM "artifacts"."upload"`,
    );

    expect(() => parsePdf(new Uint8Array(Buffer.from("not a pdf at all")))).toThrow();

    expect(await count()).toBe(before);
    const afterUploads = await host.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM "artifacts"."upload"`,
    );
    expect(afterUploads[0]!.n).toBe(beforeUploads[0]!.n);
  });

  test("a successful host parse rides in on the module's one file-artifact path", async () => {
    const parsed = parsePdf(PDF);
    expect(parsed).toBe("quarterly numbers");

    const row = await host.db.transaction((tx) =>
      createFileArtifact(tx, InlineContentStore, {
        scope: host.scope(),
        ownerPrincipalId: host.scope().principal,
        filename: "report.pdf",
        mimeType: "application/pdf",
        bytes: PDF,
        // The chat/mail attachment surface, whose route the HOST owns — and
        // which is still gated by this module's allowlist, because `policy` is
        // a required argument.
        policy: PARSED_DOCUMENT_POLICY,
        generatedBy: parsed,
      }),
    );

    // The artifact and its version 1 exist, and the bytes serve back inline
    // for a PDF that asks — the half of "pdf parse+inline" this module owns.
    const inline = await host.request(`/api/artifacts/${row.id}/download?inline=1`);
    expect(inline.headers.get("content-disposition")).toStartWith("inline;");
    expect(new Uint8Array(await inline.arrayBuffer())).toEqual(PDF);

    const detail = await json<{ artifact: { version: number; kind: string } }>(
      await host.request(`/api/artifacts/${row.id}`),
    );
    expect(detail.artifact).toMatchObject({ version: 1, kind: "file" });
  });

  test("the module refuses a type the host-owned surface's policy does not accept", async () => {
    await expect(
      host.db.transaction((tx) =>
        createFileArtifact(tx, InlineContentStore, {
          scope: host.scope(),
          ownerPrincipalId: host.scope().principal,
          filename: "logo.svg",
          mimeType: "image/svg+xml",
          bytes: new Uint8Array(Buffer.from("<svg/>")),
          policy: PARSED_DOCUMENT_POLICY,
        }),
      ),
    ).rejects.toThrow(UnsupportedUploadTypeError);
  });
});

describe("a skill-draft is invisible over the mounted host", () => {
  // End to end, on a real host rather than a unit-test Hono app: the
  // kind is not addressable by ANY single-artifact route.
  test("every detail route answers 404", async () => {
    const draftAuthor = host.agentPrincipal;
    const [draft] = await host.db.execute<{ id: string }>(sql`
      INSERT INTO "artifacts"."artifact" ("tenant_id", "principal_id", "owner_principal_id",
        "kind", "title", "content", "source", "version")
      VALUES (${host.tenant}, ${draftAuthor}, ${draftAuthor}, 'skill-draft', 'Scratch',
        'draft body', '{"origin":"agent"}'::jsonb, 1)
      RETURNING "id"
    `);
    const id = draft!.id;
    const routes: [string, RequestInit][] = [
      [`/api/artifacts/${id}`, {}],
      [`/api/artifacts/${id}/versions`, {}],
      [`/api/artifacts/${id}/versions`, postJson({ content: "x" })],
      [`/api/artifacts/${id}/archive`, { method: "POST" }],
      [`/api/artifacts/${id}/unarchive`, { method: "POST" }],
      [`/api/artifacts/${id}/download`, {}],
    ];
    for (const [path, init] of routes) {
      const res = await host.request(path, init);
      expect({ route: `${init.method ?? "GET"} ${path}`, status: res.status }).toEqual({
        route: `${init.method ?? "GET"} ${path}`,
        status: 404,
      });
    }

    const listed = await json<{ artifacts: { id: string }[] }>(
      await host.request("/api/artifacts?limit=100"),
    );
    expect(listed.artifacts.some((a) => a.id === id)).toBe(false);
  });
});

describe("the migration runner is re-runnable", () => {
  test("re-running applies nothing new and destroys no data", async () => {
    const before = await host.db.execute<{ id: string }>(
      sql`SELECT "id" FROM "artifacts"."migrations"`,
    );
    await runArtifactMigrations(host.db);
    const after = await host.db.execute<{ id: string }>(
      sql`SELECT "id" FROM "artifacts"."migrations"`,
    );
    expect(after.length).toBe(before.length);

    const survived = await json<{ artifacts: unknown[] }>(
      await host.request("/api/artifacts?limit=100"),
    );
    expect(survived.artifacts.length).toBeGreaterThan(0);
  });
});
