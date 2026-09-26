// Real-Postgres harness for the tests/ suites: a fresh database per suite with
// Interchange's control plane and this package's migrations applied, and a
// mounted artifact app for a seeded tenant principal.
import { randomUUID } from "node:crypto";
import {
  createDB,
  createGrantStore,
  runMigrations,
  schema as intx,
  type DBConfig,
} from "@intx/db";
import { createRequireGrant, type TenantEnv } from "@intx/hub-api";
import { generateId } from "@intx/hub-common";
import { Hono } from "hono";
import postgres from "postgres";
import {
  createArtifactRoutes,
  InlineContentStore,
  runArtifactMigrations,
  type ContentStore,
} from "../../src/index.js";
import {
  assertDestructiveArtifactTestsAllowed,
  databaseConfig,
  DATABASE_URL,
} from "../../src/test-helpers.js";

type Tenant = typeof intx.tenant.$inferSelect;
type Principal = typeof intx.principal.$inferSelect;
type HostDb = ReturnType<typeof createDB>["db"];

export type Actor = { tenant: Tenant; principal: Principal };

export type TestDb = {
  db: HostDb;
  config: DBConfig;
  close: () => Promise<void>;
};

export function connectionString(config: DBConfig): string {
  const user = encodeURIComponent(config.user);
  const password = encodeURIComponent(config.password ?? "");
  return `postgres://${user}:${password}@${config.host}:${config.port}/${config.database}`;
}

async function admin<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
  try {
    return await run(sql);
  } finally {
    await sql.end();
  }
}

/** Creates `artifact_<random>_test`, migrates it, and drops it on `close`. */
export async function createTestDb(): Promise<TestDb> {
  assertDestructiveArtifactTestsAllowed(DATABASE_URL);
  const name = `artifact_${randomUUID().replaceAll("-", "").slice(0, 12)}_test`;
  await admin((sql) => sql.unsafe(`CREATE DATABASE "${name}"`));
  const server = databaseConfig(DATABASE_URL);
  const config: DBConfig = {
    host: server.host,
    port: server.port,
    user: server.user,
    password: server.password,
    database: name,
  };
  await runMigrations(config, { schema: "public" });
  await runArtifactMigrations(config, { schema: "public" });
  const handle = createDB(config);
  return {
    db: handle.db,
    config,
    close: async () => {
      await handle.close();
      await admin((sql) => sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    },
  };
}

/** A tenant with one active user principal, allowed to create artifacts. */
export async function seedActor(db: HostDb, slug: string): Promise<Actor> {
  const [tenant] = await db
    .insert(intx.tenant)
    .values({ id: generateId("tenant"), name: slug, slug, domain: `${slug}.example` })
    .returning();
  const [principal] = await db
    .insert(intx.principal)
    .values({
      id: generateId("principal"),
      tenantId: tenant!.id,
      kind: "user",
      refId: `user-${slug}`,
      status: "active",
    })
    .returning();
  await grant(db, { tenant: tenant!, principal: principal! }, "artifact:*", "create");
  return { tenant: tenant!, principal: principal! };
}

export async function grant(
  db: HostDb,
  actor: Actor,
  resource: string,
  action: string,
): Promise<void> {
  await db.insert(intx.grant).values({
    id: generateId("grant"),
    tenantId: actor.tenant.id,
    principalId: actor.principal.id,
    roleId: null,
    resource,
    action,
    effect: "allow",
    origin: "system",
    conditions: null,
  });
}

/**
 * `createArtifactRoutes` mounted at `/api` for `actor`, authorized by the
 * platform's real `createRequireGrant` over the database's `grant` table.
 */
export function artifactApp(
  db: HostDb,
  actor: Actor,
  contentStore: ContentStore = InlineContentStore,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  app.use("*", async (c, next) => {
    c.set("tenant", actor.tenant);
    c.set("principal", actor.principal);
    await next();
  });
  return app.route(
    "/api",
    createArtifactRoutes({
      db,
      contentStore,
      requireGrant: createRequireGrant({
        grantStore: createGrantStore(db),
        conditionRegistry: {},
      }),
    }),
  );
}
