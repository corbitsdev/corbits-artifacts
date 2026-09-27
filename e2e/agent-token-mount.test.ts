import { describe, expect, test } from "bun:test";
import {
  createWorkflowArtifactRoutes,
  type AgentTokenAuth,
  type ResolvedWorkflowRunScope,
} from "../src/workflow-mount.js";
import { InlineContentStore } from "../src/content-store.js";
import { seedArtifact } from "./fixtures.js";
import { testDb } from "./helpers.js";
import type { ArtifactDb } from "../src/db.js";

const RUN_SCOPE: ResolvedWorkflowRunScope = {
  tenantId: "acme",
  principalId: "user-1",
  runId: "run-1",
};

const ADDRESS = "run-1@acme";
const AGENT_TOKEN = "agent-token";

function agentTokenAuth(overrides: Partial<AgentTokenAuth> = {}): AgentTokenAuth {
  return {
    verify: (ctx) => {
      const c = ctx as { req: { header(name: string): string | undefined } };
      return c.req.header("authorization") === `Bearer ${AGENT_TOKEN}`
        ? { tenantId: "acme", definitionId: "def-1" }
        : undefined;
    },
    resolveRun: (address) => (address === ADDRESS ? RUN_SCOPE : null),
    ...overrides,
  };
}

function host(db: ArtifactDb, agentToken: AgentTokenAuth = agentTokenAuth()) {
  return createWorkflowArtifactRoutes({
    db,
    contentStore: InlineContentStore,
    // The sidecar path stays wired: an agent token is a second way in, not a
    // replacement.
    resolveRunScope: (token, address) =>
      token === "sidecar-token" && address === ADDRESS ? RUN_SCOPE : null,
    agentToken,
  });
}

const agentHeaders = {
  authorization: `Bearer ${AGENT_TOKEN}`,
  "x-workflow-run-address": ADDRESS,
};

describe("agent-token authentication", () => {
  test("an agent bearer authenticates and scopes to the run's tenant", async () => {
    const db = await testDb();
    const app = host(db);
    const res = await app.request("/artifacts/recent", { headers: agentHeaders });
    expect(res.status).toBe(200);
  });

  test("a token from another tenant is refused with the same 401", async () => {
    const db = await testDb();
    const app = host(
      db,
      agentTokenAuth({ verify: () => ({ tenantId: "other", definitionId: "def-1" }) }),
    );
    const res = await app.request("/artifacts/recent", { headers: agentHeaders });
    expect(res.status).toBe(401);
  });

  test("an address that names no run is refused", async () => {
    const db = await testDb();
    const app = host(db);
    const res = await app.request("/artifacts/recent", {
      headers: { ...agentHeaders, "x-workflow-run-address": "run-9@acme" },
    });
    expect(res.status).toBe(401);
  });

  test("a bearer the verifier does not recognize falls through to the sidecar path", async () => {
    const db = await testDb();
    const app = host(db);
    const res = await app.request("/artifacts/recent", {
      headers: { authorization: "Bearer sidecar-token", "x-workflow-run-address": ADDRESS },
    });
    expect(res.status).toBe(200);
  });
});

describe("the routes the artifact tools call", () => {
  test("lists, finds, revises, reads and chunks an artifact", async () => {
    const db = await testDb();
    const app = host(db);

    const created = await app.request("/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json", ...agentHeaders },
      body: JSON.stringify({ title: "Notes", kind: "document", content: "first" }),
    });
    expect(created.status).toBe(201);
    const { data: artifact } = (await created.json()) as { data: { id: string } };

    const listed = await app.request("/artifacts?kind=document", { headers: agentHeaders });
    const listedBody = (await listed.json()) as { data: Array<{ id: string }> };
    expect(listedBody.data.map((row) => row.id)).toContain(artifact.id);

    const found = await app.request("/artifacts/find?title=Notes", { headers: agentHeaders });
    expect((await found.json()) as unknown).toEqual({
      data: { artifactId: artifact.id, version: 1 },
    });

    const revised = await app.request(`/artifacts/${artifact.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...agentHeaders },
      body: JSON.stringify({ content: "second" }),
    });
    expect(revised.status).toBe(200);
    expect((await revised.json()) as { data: { id: string; version: number } }).toEqual({
      data: { id: artifact.id, version: 2 },
    });

    const read = await app.request(`/artifacts/${artifact.id}/read`, { headers: agentHeaders });
    const readBody = (await read.json()) as { data: { content: string } };
    expect(readBody.data.content).toBe("second");

    const pinned = await app.request(`/artifacts/${artifact.id}/read?version=1`, {
      headers: agentHeaders,
    });
    expect(((await pinned.json()) as { data: { content: string } }).data.content).toBe("first");

    const chunk = await app.request(`/artifacts/${artifact.id}/chunk?offset=0&limit=3`, {
      headers: agentHeaders,
    });
    expect(((await chunk.json()) as { data: { content: string } }).data.content).toBe("sec");
  });

  test("links a workspace file without moving any bytes", async () => {
    const db = await testDb();
    const app = host(db);
    const linked = await app.request("/artifacts/link-file", {
      method: "POST",
      headers: { "content-type": "application/json", ...agentHeaders },
      body: JSON.stringify({ title: "Report", kind: "document", path: "out/report.md" }),
    });
    expect(linked.status).toBe(201);
  });

  test("another tenant's artifact reads as not found", async () => {
    const db = await testDb();
    const foreign = await seedArtifact(db, { tenantId: "other" });
    const app = host(db);
    const read = await app.request(`/artifacts/${foreign.id}/read`, { headers: agentHeaders });
    expect(read.status).toBe(404);
  });
});
