// Applies migrations/*.sql, shipped next to dist/, into the `artifacts` schema.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DBConfig } from "@intx/db";
import postgres from "postgres";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");

// Advisory locks are namespaced by this integer alone; deliberately arbitrary
// and specific to @corbits/artifacts.
const LOCK_KEY = 0x0a27_1f04;

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Takes the same `config` and `schema` the host passes Interchange's
 * `runMigrations`. `schema` is where the host's `tenant` and `principal`
 * tables live; the package's own tables always go in the `artifacts` schema,
 * and the `"public".` foreign-key references in the SQL are rewritten to
 * `schema`. Every statement is idempotent, and the run is one transaction
 * behind an advisory lock so concurrent hub replicas cannot race the DDL.
 */
export async function runArtifactMigrations(
  config: DBConfig,
  options: { schema: string },
): Promise<void> {
  if (options.schema.length === 0) {
    throw new Error("runArtifactMigrations: schema name must not be empty");
  }
  const schemaIdent = quoteIdentifier(options.schema);
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  if (files.length === 0) {
    throw new Error(`runArtifactMigrations: no .sql files found in ${MIGRATIONS_DIR}`);
  }
  const statements: string[] = [];
  for (const file of files) {
    const raw = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    for (const stmt of raw
      .replace(/"public"\.(?=")/g, `${schemaIdent}.`)
      .split("--> statement-breakpoint")) {
      if (stmt.trim().length > 0) statements.push(stmt);
    }
  }

  const clientOptions: postgres.Options<{}> = {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    max: 1,
    onnotice: () => undefined,
  };
  if (config.ssl !== undefined) clientOptions.ssl = config.ssl;
  const client = postgres(clientOptions);
  try {
    await client.begin(async (tx) => {
      await tx.unsafe(`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);
      for (const stmt of statements) await tx.unsafe(stmt);
    });
  } catch (error) {
    throw new Error(
      `@corbits/artifacts migration failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}
