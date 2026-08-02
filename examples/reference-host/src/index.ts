// reference-host — mounts @corbits/artifacts on a bare Interchange host
// (`createApp` from the published `@intx/hub-api`) against a real Postgres.
//
// The host is the real thing: hub routes, the hub request logger and the hub
// session middleware are all live. Artifact routes nest under `/api` on a
// `Hono<TenantEnv>` that places the seeded tenant/principal on the context
// from the hub session user, and authorizes through the platform's real
// `createRequireGrant` backed by the real `grant` table — a caller with no
// matching grant row is refused, same as production. `buildApp`'s optional
// `authorize` still lets a test force a specific answer without provisioning
// rows for it.
//
// This module only BUILDS the host. The acceptance scenarios live in
// `test/acceptance.test.ts` and run under `bun test`, so they are collected by
// CI like any other test instead of being a hand-rolled assert script nothing
// executes.
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import {
  createApp,
  createRequireGrant,
  type RequireGrant,
  type TenantEnv,
} from "@intx/hub-api";
import { createDB, createGrantStore, runMigrations, schema as intxSchema } from "@intx/db";
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
  type ArtifactDb,
  type ArtifactRow,
  type ArtifactTx,
  type ResolvedPrincipal,
  type ContentStore,
  type SerializedArtifactBase,
} from "@corbits/artifacts";

export const DATABASE_URL =
  process.env.ARTIFACT_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5457/artifact_core";

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

/** Display-only decorator. Adds a label, never changes what is returned. */
async function decorate(_tenantId: string, rows: readonly SerializedArtifactBase[]) {
  for (const row of rows) {
    (row as Record<string, unknown>).generatedByLabel =
      typeof row.source.generatedBy === "string" ? row.source.generatedBy : null;
  }
}

/**
 * The worked example this host owes the next `@corbits/*-core` package: what
 * a "the artifact's owner may write to it" grant actually IS, and who mints
 * it. `@corbits/artifacts` provisions nothing itself — this runs through
 * `mountArtifacts`'s `onArtifactCreated` hook, inside the same transaction as
 * the row it grants on, so a grant never outlives (or fails to accompany) the
 * artifact it names.
 *
 * `origin: "creator"` is the platform's own vocabulary for exactly this case
 * (see `@intx/types/authz`'s `GrantRule.origin`) — the host is not inventing
 * a policy layer, it is recording, in the platform's own grant table, the
 * one fact this module already decided: `scope.principalId` made this row.
 */
async function grantOwnership(tx: ArtifactTx, row: ArtifactRow, scope: ResolvedPrincipal) {
  const resource = `artifact:${row.id}`;
  await tx.insert(intxSchema.grant).values(
    (["write", "archive"] as const).map((action) => ({
      id: generateId("grant"),
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      roleId: null,
      resource,
      action,
      effect: "allow" as const,
      origin: "creator" as const,
      conditions: null,
    })),
  );
}

export type Session = { userId: string } | null;

export type ReferenceHost = {
  db: ArtifactDb;
  /** Interchange tenant id every artifact in this host is scoped to. */
  tenantId: string;
  /** Principal id of the agent Alice owns. */
  agentPrincipal: string;
  /**
   * The scope a host-owned surface runs as — the same principal the mounted
   * routes resolve for Alice. A host that owns its own file-minting route
   * (a chat attachment divert, a workflow's generated PDF) calls
   * `createFileArtifact` with this.
   */
  scope: () => ResolvedPrincipal;
  /** Who the hub's session middleware will report. `null` means signed out. */
  setSession: (session: Session) => void;
  /** Request the default host (InlineContentStore, real DB-backed grants). */
  request: (path: string, init?: RequestInit) => Promise<Response>;
  /** Build another host over a different ContentStore or grant answer. */
  buildApp: (
    contentStore: ContentStore,
    authorize?: (resource: string, action: string) => boolean,
  ) => { request: (path: string, init?: RequestInit) => Promise<Response> };
  close: () => Promise<void>;
};

export async function createReferenceHost(): Promise<ReferenceHost> {
  // ONE pool. The artifact module mounts on the handle the host already has
  // from `createDB` — the seam takes any drizzle postgres-js instance, so there
  // is no second connection to the same database.
  const hub = createDB(parsePostgresUrl(DATABASE_URL));
  const db: ArtifactDb = hub.db;

  // This host resets and truncates its database on boot — refuse to run
  // against anything that doesn't look like a throwaway database unless
  // explicitly opted in.
  const { database } = parsePostgresUrl(DATABASE_URL);
  if (
    !database.startsWith("artifact_") &&
    process.env.ARTIFACT_REFERENCE_ALLOW_RESET !== "1"
  ) {
    throw new Error(
      `reference-host truncates its database on boot; refusing to reset "${database}". ` +
        `Point ARTIFACT_DATABASE_URL at a throwaway artifact_* database, or set ` +
        `ARTIFACT_REFERENCE_ALLOW_RESET=1 if you really mean it.`,
    );
  }

  // Startup, once, before anything is served: the host brings up its own
  // Interchange schema, then the artifact module brings up its own. Never
  // per-request — this is boot-time work.
  // Interchange's own runner has no ledger, so it is applied only when the
  // REAL control plane is absent. The unit suite stands up id-only tenant /
  // principal stand-ins as FK targets; on a shared dev database those look
  // present by name but lack Interchange's columns, so detect by shape
  // (`tenant.slug`), drop the stand-ins, and migrate for real.
  // `runArtifactMigrations` needs no such guard — carrying its own ledger is
  // precisely why it can be called unconditionally on every boot.
  const [hostSchema] = await db.execute<{ present: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tenant' AND column_name = 'slug'
    ) AS present
  `);
  if (!hostSchema?.present) {
    await db.execute(sql`DROP TABLE IF EXISTS "public"."principal" CASCADE`);
    await db.execute(sql`DROP TABLE IF EXISTS "public"."tenant" CASCADE`);
    await db.execute(sql`DROP SCHEMA IF EXISTS "artifacts" CASCADE`);
    await runMigrations(parsePostgresUrl(DATABASE_URL), { schema: "public" });
  }
  await runArtifactMigrations(db);
  await db.execute(
    sql`TRUNCATE TABLE "artifacts"."artifact", "artifacts"."artifact_version", "artifacts"."upload", "artifacts"."mail_attachment_ref" CASCADE`,
  );
  await db.execute(sql`DELETE FROM "principal" WHERE "tenant_id" IN
    (SELECT "id" FROM "tenant" WHERE "slug" = 'reference')`);
  await db.execute(sql`DELETE FROM "tenant" WHERE "slug" = 'reference'`);
  await db.execute(sql`DELETE FROM "user" WHERE "id" IN ('user-alice', 'user-bob')`);

  // Seed the host's own control plane: a tenant, two humans, and one agent
  // owned by Alice. Returning full rows so TenantEnv middleware can place them
  // on the request context without a second lookup.
  const [tenantRow] = await db
    .insert(intxSchema.tenant)
    .values({
      id: generateId("tenant"),
      name: "Reference",
      slug: "reference",
      domain: "reference.example",
    })
    .returning();
  const tenant = tenantRow!;

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
        tenantId: tenant.id,
        kind: "user",
        refId: "user-alice",
        status: "active",
      },
      {
        id: generateId("principal"),
        tenantId: tenant.id,
        kind: "user",
        refId: "user-bob",
        status: "active",
      },
      {
        id: generateId("principal"),
        tenantId: tenant.id,
        kind: "agent",
        refId: "user-alice",
        status: "active",
      },
    ])
    .returning();

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
  function buildApp(
    contentStore: ContentStore,
    authorize?: (resource: string, action: string) => boolean,
  ) {
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
    const api = new Hono<TenantEnv>();
    // Place full tenant/principal rows from the hub session user. Signed-out
    // (or unknown) callers leave the context empty so mountArtifacts applies
    // the no-principal contract.
    api.use("*", async (c, next) => {
      const user = c.get("user");
      if (user) {
        const principal = principals.find(
          (p) => p.kind === "user" && p.refId === user.id && p.status === "active",
        );
        if (principal) {
          c.set("tenant", tenant);
          c.set("principal", principal);
        }
      }
      await next();
    });
    // The real evaluator: the platform's own `createRequireGrant`, backed by
    // the real `grant` table via `createGrantStore(db)`. No existence-blind,
    // no default-allow — a caller with no matching row in `grant` is refused,
    // same as production. `authorize` remains for tests that want to force a
    // specific answer without provisioning rows for it (e.g. "deny always").
    const requireGrant: RequireGrant =
      authorize === undefined
        ? createRequireGrant({ grantStore: createGrantStore(hub.db), conditionRegistry: {} })
        : (resource, action) => async (c, next) => {
            const resolved =
              typeof resource === "function"
                ? resource({ param: (name) => c.req.param(name) })
                : resource;
            const allowed = authorize(resolved, action);
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
    mountArtifacts(api, {
      db,
      contentStore,
      requireGrant,
      decorate,
      onArtifactCreated: grantOwnership,
    });
    const mounted = app.route("/api", api);
    // `Hono#request` may answer synchronously; normalize to a promise so every
    // caller can simply await it.
    return {
      request: async (path: string, init?: RequestInit) =>
        await mounted.request(path, init),
    };
  }

  const defaultApp = buildApp(InlineContentStore);

  return {
    db,
    tenantId: tenant.id,
    agentPrincipal,
    scope: () => ({
      tenantId: tenant.id,
      principalId: principals.find((p) => p.kind === "user" && p.refId === "user-alice")!
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
