import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/**
 * The db handle this package expects a host to hand in.
 *
 * Deliberately schema-agnostic: every query names its table explicitly rather
 * than going through drizzle's relational API (`db.query.<table>`), so a host
 * passes the drizzle instance it already has — typically the one from
 * `createDB` — instead of opening a second pool against the same database.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle's schema
// generic is invariant, so naming a concrete schema here would reject a host
// handle bound to its own. Nothing here reads `db.query`.
export type ArtifactDb = PostgresJsDatabase<any>;

/**
 * Opens a standalone handle, for hosts and scripts that don't already have one.
 * `close` is returned because the primary caller is a boot-time migration
 * script, which would otherwise hold an open socket and never exit.
 */
export function createArtifactDb(connectionString: string): {
  db: ArtifactDb;
  close: () => Promise<void>;
} {
  const client = postgres(connectionString);
  return { db: drizzle(client), close: () => client.end() };
}

/** The handle inside a transaction. Every write path takes one of these. */
export type ArtifactTx = Parameters<
  Parameters<ArtifactDb["transaction"]>[0]
>[0];
