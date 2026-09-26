// Real-Postgres harness for the e2e suites: the shared artifact database, a
// fresh database per suite with Interchange's control plane and this package's
// migrations applied, a mounted artifact app, and an on-disk ContentStore.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createDB,
  createGrantStore,
  runMigrations,
  type DBConfig,
} from "@intx/db";
import { createRequireGrant, type TenantEnv } from "@intx/hub-api";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import postgres from "postgres";
import { uploadRefFromSource } from "../src/content-store.js";
import { createArtifactDb, type ArtifactDb } from "../src/db.js";
import {
  createArtifactRoutes,
  InlineContentStore,
  runArtifactMigrations,
  type ContentStore,
} from "../src/index.js";
import type { Actor } from "./fixtures.js";

export const DATABASE_URL =
  process.env.ARTIFACT_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/artifact_core";

/** `DATABASE_URL` in the shape Interchange's `runMigrations` takes. */
export function databaseConfig(connectionString: string): DBConfig {
  const url = new URL(connectionString);
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: databaseNameFromConnectionString(connectionString),
  };
}

/**
 * Explicit opt-in required before the harness runs TRUNCATE or DROP SCHEMA.
 * Must be the string `"1"` — any other value (including `"true"`) is refused.
 */
const ALLOW_DESTRUCTIVE_ARTIFACT_TESTS = "ALLOW_DESTRUCTIVE_ARTIFACT_TESTS";

type EnvMap = { readonly [key: string]: string | undefined };

/**
 * Database name segment of a Postgres connection string.
 * Pure URL parsing so the refuse path is unit-testable without a live server.
 */
function databaseNameFromConnectionString(connectionString: string): string {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error(
      `Invalid ARTIFACT_DATABASE_URL (not a URL): ${JSON.stringify(connectionString)}`,
    );
  }
  const name = decodeURIComponent(
    parsed.pathname.replace(/^\//, "").split("/")[0] ?? "",
  );
  if (!name) {
    throw new Error(
      `ARTIFACT_DATABASE_URL has no database name (path is empty): ${JSON.stringify(connectionString)}`,
    );
  }
  return name;
}

/**
 * Ephemeral-name allowlist for destructive artifact tests:
 * - exact: `artifact_core` (the documented local docker default)
 * - suffix: any name ending in `_test` (covers `artifacts_test`, `foo_test`, …)
 *
 * Everything else — production-looking names included — is refused.
 */
function isAllowlistedArtifactTestDatabase(name: string): boolean {
  if (name === "artifact_core") return true;
  if (name.endsWith("_test")) return true;
  return false;
}

/**
 * Fail closed before TRUNCATE / DROP SCHEMA: require both the opt-in env flag
 * and an allowlisted database name. Pure (URL + env only) so CI without PG
 * can still prove the refuse path.
 */
function assertDestructiveArtifactTestsAllowed(
  connectionString: string,
  env: EnvMap = process.env,
): void {
  const optedIn = env[ALLOW_DESTRUCTIVE_ARTIFACT_TESTS] === "1";
  let name: string | undefined;
  try {
    name = databaseNameFromConnectionString(connectionString);
  } catch (err) {
    // Surface parse failures as gate failures with the same requirements list.
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Refusing destructive artifact test operations (TRUNCATE/DROP). ${detail} ` +
        `Set ${ALLOW_DESTRUCTIVE_ARTIFACT_TESTS}=1 and point ARTIFACT_DATABASE_URL ` +
        `at an allowlisted ephemeral database (name must be "artifact_core" or end with "_test").`,
    );
  }
  const allowlisted = isAllowlistedArtifactTestDatabase(name);
  if (optedIn && allowlisted) return;

  const reasons: string[] = [];
  if (!optedIn) {
    reasons.push(
      `${ALLOW_DESTRUCTIVE_ARTIFACT_TESTS} is not "1" (got ${JSON.stringify(env[ALLOW_DESTRUCTIVE_ARTIFACT_TESTS] ?? null)})`,
    );
  }
  if (!allowlisted) {
    reasons.push(
      `database name ${JSON.stringify(name)} is not allowlisted (need "artifact_core" or a name ending in "_test")`,
    );
  }
  throw new Error(
    `Refusing destructive artifact test operations (TRUNCATE/DROP). ${reasons.join("; ")}. ` +
      `Set ${ALLOW_DESTRUCTIVE_ARTIFACT_TESTS}=1 and point ARTIFACT_DATABASE_URL ` +
      `at an allowlisted ephemeral database (name must be "artifact_core" or end with "_test").`,
  );
}

// One pool for the whole suite. Opening a fresh one per test leaked a
// connection pool per call and eventually hit `too many clients already`.
let shared: ArtifactDb | undefined;

/**
 * The FK targets in the host control plane. The package's migrations REFERENCE
 * `public.tenant` / `public.principal`, so the unit suite stands up id-only
 * stand-ins (a real host brings the full Interchange tables) and seeds every
 * tenant and principal id the tests mint rows for.
 */
async function ensureControlPlane(db: ArtifactDb): Promise<void> {
  await db.execute(
    sql`CREATE TABLE IF NOT EXISTS "public"."tenant" ("id" text PRIMARY KEY)`,
  );
  await db.execute(
    sql`CREATE TABLE IF NOT EXISTS "public"."principal" ("id" text PRIMARY KEY)`,
  );
  // A shared dev database may carry the REAL Interchange tables from an
  // acceptance run, whose NOT NULL columns reject id-only rows — detect by
  // shape and satisfy them.
  const [real] = await db.execute<{ present: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tenant' AND column_name = 'slug'
    ) AS present
  `);
  for (const tenant of ["acme", "other"]) {
    await db.execute(
      real?.present
        ? sql`INSERT INTO "public"."tenant" ("id", "name", "slug", "domain")
              VALUES (${tenant}, ${tenant}, ${tenant}, ${`${tenant}.example`})
              ON CONFLICT DO NOTHING`
        : sql`INSERT INTO "public"."tenant" ("id") VALUES (${tenant})
              ON CONFLICT DO NOTHING`,
    );
  }
  for (const principal of ["user-1", "someone-else", "agent-9"]) {
    await db.execute(
      real?.present
        ? sql`INSERT INTO "public"."principal" ("id", "tenant_id", "kind", "ref_id", "status")
              VALUES (${principal}, 'acme', 'user', ${principal}, 'active')
              ON CONFLICT DO NOTHING`
        : sql`INSERT INTO "public"."principal" ("id") VALUES (${principal})
              ON CONFLICT DO NOTHING`,
    );
  }
}

export async function testDb(): Promise<ArtifactDb> {
  // Gate before any pool open or TRUNCATE — a mispointed URL must never wipe.
  assertDestructiveArtifactTestsAllowed(DATABASE_URL);
  const fresh = !shared;
  const db = shared ?? createArtifactDb(DATABASE_URL).db;
  shared = db;
  // Re-seeded per call: the reference-host suite truncates the control plane on boot.
  await ensureControlPlane(db);
  if (fresh)
    await runArtifactMigrations(databaseConfig(DATABASE_URL), {
      schema: "public",
    });
  await db.execute(
    sql`TRUNCATE TABLE "artifacts"."artifact", "artifacts"."artifact_version", "artifacts"."upload" CASCADE`,
  );
  return db;
}

export type HostDb = ReturnType<typeof createDB>["db"];

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

/**
 * Creates `artifact_<random>_test`, applies Interchange's migrations and then
 * `migrateArtifacts` (this package's by default), and drops it on `close`.
 */
export async function createTestDb(
  migrateArtifacts: (config: DBConfig) => Promise<void> = (config) =>
    runArtifactMigrations(config, { schema: "public" }),
): Promise<TestDb> {
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
  await migrateArtifacts(config);
  const handle = createDB(config);
  return {
    db: handle.db,
    config,
    close: async () => {
      await handle.close();
      await admin((sql) =>
        sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
      );
    },
  };
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

// A ContentStore that keeps file bytes on disk, one file per upload, referenced
// from the artifact's `source.upload.id` the way InlineContentStore references
// its bytea row.
export function createFsContentStore(dir: string): ContentStore {
  const pathFor = (tenantId: string, id: string) => join(dir, tenantId, id);
  return {
    async put(_tx, scope, blob) {
      const id = randomUUID();
      await mkdir(join(dir, scope.tenantId), { recursive: true });
      await writeFile(pathFor(scope.tenantId, id), blob.bytes);
      return {
        content: "",
        source: {
          upload: {
            id,
            filename: blob.filename,
            mimeType: blob.mimeType,
            size: blob.bytes.byteLength,
          },
        },
      };
    },
    async get(_db, artifact) {
      const ref = uploadRefFromSource(artifact.source);
      if (ref?.id === undefined || artifact.tenantId === null) return null;
      const bytes = await readFile(pathFor(artifact.tenantId, ref.id)).catch(
        () => null,
      );
      if (bytes === null) return null;
      return {
        filename: ref.filename,
        mimeType: ref.mimeType,
        bytes: new Uint8Array(bytes),
      };
    },
  };
}
