// reference-host — mounts @corbits/artifact-core on a bare Interchange host
// (`createApp` from the published `@intx/hub-api`) against a real Postgres.
//
// The host is the real thing: hub routes, the hub request logger and the hub
// session middleware are all live, and the artifact principal is resolved out
// of the hub's own request context (`c.var.user`) rather than a local variable.
// The two seams (authz + provenance) are implemented against the host's OWN
// control plane (interchange `principal` / `user` rows), which is the point:
// the module knows nothing about them, the host supplies them.
//
// This module only BUILDS the host. The acceptance scenarios live in
// `test/acceptance.test.ts` and run under `bun test`, so they are collected by
// CI like any other test instead of being a hand-rolled assert script nothing
// executes.
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { createApp, type AppEnv } from "@intx/hub-api";
import { createDB, runMigrations, schema as intxSchema } from "@intx/db";
// Interchange owns its id scheme; the host mints its OWN control-plane rows
// with it rather than inventing a second one.
import { generateId } from "@intx/hub-common";
import {
  createEventCollectorRegistry,
  createSidecarRouter,
  type SessionService,
  type SidecarAuthenticator,
} from "@intx/hub-sessions";
import {
  InlineContentStore,
  mountArtifacts,
  runArtifactMigrations,
  type AdminAuthz,
  type ArtifactDb,
  type ResolvedPrincipal,
  type ContentStore,
  type Provenance,
} from "@corbits/artifact-core";

export const DATABASE_URL =
  process.env.ARTIFACT_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5457/artifact_reference";

const EPOCH = new Date(0);

function parsePostgresUrl(raw: string) {
  const url = new URL(raw);
  return {
    host: url.hostname,
    port: Number(url.port === "" ? "5432" : url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
  };
}

/**
 * Resolve the human member who owns an agent principal — the agent's `refId`
 * names them in this host's own `principal` table. Used only by
 * `canAdminister`, which is called after the exact-owner match already
 * failed, so an unowned or non-agent `ownerPrincipalId` correctly resolves to
 * "nobody".
 */
async function ownerMemberPrincipalId(
  db: ArtifactDb,
  tenantId: string,
  agentPrincipalId: string,
): Promise<string | null> {
  const [agent] = await db
    .select({ refId: intxSchema.principal.refId })
    .from(intxSchema.principal)
    .where(
      and(
        eq(intxSchema.principal.id, agentPrincipalId),
        eq(intxSchema.principal.tenantId, tenantId),
        eq(intxSchema.principal.kind, "agent"),
      ),
    )
    .limit(1);
  if (!agent) return null;
  const [member] = await db
    .select({ id: intxSchema.principal.id })
    .from(intxSchema.principal)
    .where(
      and(
        eq(intxSchema.principal.tenantId, tenantId),
        eq(intxSchema.principal.kind, "user"),
        eq(intxSchema.principal.refId, agent.refId),
        eq(intxSchema.principal.status, "active"),
      ),
    )
    .limit(1);
  return member?.id ?? null;
}

/**
 * Seam A, implemented honestly against the host's own control plane.
 * `isAdmin` is the host's own coarse admin check; `canAdminister` folds it
 * together with "the member who owns the producing agent may administer its
 * artifact" — the core calls this only after the exact-owner match already
 * failed, so neither branch needs to re-check ownership.
 */
function createAdminAuthz(db: ArtifactDb, isAdmin: () => Promise<boolean>): AdminAuthz {
  return {
    async canAdminister(scope, row) {
      if (await isAdmin()) return true;
      if (row.ownerPrincipalId === null) return false;
      const member = await ownerMemberPrincipalId(
        db,
        scope.tenant,
        row.ownerPrincipalId,
      );
      return member !== null && member === scope.principal;
    },
    // This host has exactly one tenant, so a cross-tenant read is always
    // refused. A multi-tenant host would check active membership there.
    async canReadTenant() {
      return false;
    },
  };
}

/** Seam C — display-only. Adds a label, never changes what is returned. */
const provenance: Provenance = {
  async decorate(_tenantId, rows) {
    for (const row of rows) {
      row.generatedByLabel =
        typeof row.source.generatedBy === "string" ? row.source.generatedBy : null;
    }
  },
};

export type Session = { userId: string } | null;

export type ReferenceHost = {
  db: ArtifactDb;
  /** Interchange tenant id every artifact in this host is scoped to. */
  tenant: string;
  /** Principal id of the agent Alice owns. */
  agentPrincipal: string;
  /**
   * The scope a host-owned surface runs as — the same `ResolvedPrincipal` the
   * mounted routes resolve for Alice. A host that owns its own file-minting
   * route (a chat attachment divert, a workflow's generated PDF) calls
   * `createFileArtifact` with this.
   */
  scope: () => ResolvedPrincipal;
  /** Who the hub's session middleware will report. `null` means signed out. */
  setSession: (session: Session) => void;
  /** Request the default host (InlineContentStore, nobody is admin). */
  request: (path: string, init?: RequestInit) => Promise<Response>;
  /** Build another host over a different ContentStore or authz answer. */
  buildApp: (
    contentStore: ContentStore,
    isAdmin: () => Promise<boolean>,
  ) => { request: (path: string, init?: RequestInit) => Promise<Response> };
  close: () => Promise<void>;
};

export async function createReferenceHost(): Promise<ReferenceHost> {
  // ONE pool. The artifact module mounts on the handle the host already has
  // from `createDB` — the seam takes any drizzle postgres-js instance, so there
  // is no second connection to the same database.
  const hub = createDB(parsePostgresUrl(DATABASE_URL));
  const db: ArtifactDb = hub.db;

  // Startup, once, before anything is served: the host brings up its own
  // Interchange schema, then the artifact module brings up its own. Never
  // per-request — this is boot-time work.
  // Interchange's own runner has no ledger, so it is applied only on a virgin
  // database. `runArtifactMigrations` needs no such guard — carrying its own
  // ledger is precisely why it can be called unconditionally on every boot.
  const [hostSchema] = await db.execute<{ present: boolean }>(
    sql`SELECT to_regclass('public.principal') IS NOT NULL AS present`,
  );
  if (!hostSchema?.present) {
    await runMigrations(parsePostgresUrl(DATABASE_URL), { schema: "public" });
  }
  await runArtifactMigrations(db);

  // The acceptance assertions count rows, so start from a known-empty state.
  await db.execute(
    sql`TRUNCATE TABLE "artifact", "artifact_version", "upload", "mail_attachment_ref" CASCADE`,
  );
  await db.execute(sql`DELETE FROM "principal" WHERE "tenant_id" IN
    (SELECT "id" FROM "tenant" WHERE "slug" = 'reference')`);
  await db.execute(sql`DELETE FROM "tenant" WHERE "slug" = 'reference'`);
  await db.execute(sql`DELETE FROM "user" WHERE "id" IN ('user-alice', 'user-bob')`);

  // Seed the host's own control plane: a tenant, two humans, and one agent
  // owned by Alice. Note the contrast — interchange's `principal` has a real FK
  // to `tenant`, while artifact-core holds the tenant BY VALUE and so needs
  // nothing to exist here at all.
  const [tenantRow] = await db
    .insert(intxSchema.tenant)
    .values({
      id: generateId("tenant"),
      name: "Reference",
      slug: "reference",
      domain: "reference.example",
    })
    .returning({ id: intxSchema.tenant.id });
  const tenant = tenantRow!.id;

  await db.insert(intxSchema.user).values([
    {
      id: "user-alice",
      name: "Alice Ash",
      email: "alice@example.com",
      emailVerified: true,
    },
    { id: "user-bob", name: "Bob Birch", email: "bob@example.com", emailVerified: true },
  ]);
  const principals = await db
    .insert(intxSchema.principal)
    .values([
      {
        id: generateId("principal"),
        tenantId: tenant,
        kind: "user",
        refId: "user-alice",
        status: "active",
      },
      {
        id: generateId("principal"),
        tenantId: tenant,
        kind: "user",
        refId: "user-bob",
        status: "active",
      },
      {
        id: generateId("principal"),
        tenantId: tenant,
        kind: "agent",
        refId: "user-alice",
        status: "active",
      },
    ])
    .returning({
      id: intxSchema.principal.id,
      kind: intxSchema.principal.kind,
      refId: intxSchema.principal.refId,
    });

  const agentPrincipal = principals.find(
    (p) => p.kind === "agent" && p.refId === "user-alice",
  )!.id;

  let currentSession: Session = { userId: "user-alice" };

  const getSession = async (_headers: Headers) => {
    if (currentSession === null) return null;
    const { userId } = currentSession;
    return {
      user: {
        id: userId,
        createdAt: EPOCH,
        updatedAt: EPOCH,
        email: `${userId}@example.com`,
        emailVerified: true,
        name: userId,
      },
      session: {
        id: `session-${userId}`,
        createdAt: EPOCH,
        updatedAt: EPOCH,
        userId,
        expiresAt: new Date(Date.now() + 3_600_000),
        token: `token-${userId}`,
      },
    };
  };

  // The exact signature @corbits/mailbox-core takes, so a host mounting both
  // cores hands the same function to both.
  function resolvePrincipal(ctx: unknown): ResolvedPrincipal | null {
    const user = (ctx as Context<AppEnv>).get("user");
    if (!user) return null;
    const principal = principals.find((p) => p.kind === "user" && p.refId === user.id);
    return principal ? { tenant, principal: principal.id } : null;
  }

  // A bare Interchange host: real sidecar router, real event-collector
  // registry. It runs no agent sessions, so its SessionService refuses every
  // launch verb rather than pretending to serve it.
  const authenticateSidecar: SidecarAuthenticator = async ({ sidecarId }) => ({
    kind: "sidecar",
    sidecarId,
  });
  const refuse = (verb: string) => (): never => {
    throw new Error(`reference-host runs no agent sessions: ${verb}`);
  };
  const sessionService: SessionService = {
    stageWorkflowStep: refuse("stageWorkflowStep"),
    deployInstanceAtHead: refuse("deployInstanceAtHead"),
    deploySingleStepAtHead: refuse("deploySingleStepAtHead"),
    deployWorkflowDefinition: refuse("deployWorkflowDefinition"),
    sendUserMessage: refuse("sendUserMessage"),
    endSession: refuse("endSession"),
  };

  /** Build a host app with one ContentStore backend mounted. */
  function buildApp(contentStore: ContentStore, isAdmin: () => Promise<boolean>) {
    const app = createApp({
      getSession,
      authHandler: () => new Response("", { status: 404 }),
      db: hub.db,
      sidecarRouter: createSidecarRouter({ authenticateSidecar }),
      sessionService,
      eventCollectors: createEventCollectorRegistry({ db: hub.db }),
      assetService: null,
      repoStore: null,
      maxTarballBytes: 10_000_000,
    });
    // Mounted @corbits/* modules serve under `/api`, matching Interchange's
    // own convention (`app.route("/api/me", …)`). The core registers its
    // routes root-relative (`/artifacts*`, `/instances/:id/mail-attachments`),
    // so the host nests them in a sub-app and routes that at `/api`. Served
    // paths: `/api/artifacts*` — no `/v1` segment, no vendor prefix.
    const api = new Hono<AppEnv>();
    mountArtifacts(api, {
      db,
      contentStore,
      resolvePrincipal,
      adminAuthz: createAdminAuthz(db, isAdmin),
      provenance,
    });
    const mounted = app.route("/api", api);
    // `Hono#request` may answer synchronously; normalize to a promise so every
    // caller can simply await it.
    return {
      request: async (path: string, init?: RequestInit) =>
        await mounted.request(path, init),
    };
  }

  const defaultApp = buildApp(InlineContentStore, async () => false);

  return {
    db,
    tenant,
    agentPrincipal,
    scope: () => ({
      tenant,
      principal: principals.find((p) => p.kind === "user" && p.refId === "user-alice")!
        .id,
    }),
    setSession: (session) => {
      currentSession = session;
    },
    request: defaultApp.request,
    buildApp,
    close: hub.close,
  };
}
