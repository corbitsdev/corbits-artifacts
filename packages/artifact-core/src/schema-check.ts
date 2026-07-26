import { getTableColumns, getTableName, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { ArtifactDb, ArtifactTx } from "./db.js";
import { artifact, artifactVersion, mailAttachmentRef, upload } from "./schema.js";

/**
 * Every DDL statement in `MIGRATIONS` is `CREATE TABLE IF NOT EXISTS`, which is
 * exactly the right thing when this package is remounted onto a database it
 * already owns — and exactly the wrong thing when the host already has a table
 * of that name that this package did NOT create. `IF NOT EXISTS` compares the
 * NAME and nothing else: it silently no-ops, the migration is recorded as
 * applied, and from then on every read in this package decodes the host's
 * columns through our codec. The typecheck is green, the queries run, and the
 * data is wrong.
 *
 * So after the DDL, assert the shape we actually depend on. The expectation is
 * DERIVED from the drizzle table definitions rather than written out a second
 * time, so it cannot drift away from the schema it is supposed to be guarding.
 */

/**
 * drizzle's rendered column type → the `information_schema.columns.data_type`
 * Postgres reports for it. Only the types this package's tables actually use
 * are listed; an unmapped type is a loud error rather than a silent skip,
 * because a silent skip is precisely the failure this module exists to catch.
 */
const DATA_TYPE_BY_SQL_TYPE: Record<string, string> = {
  text: "text",
  integer: "integer",
  bigint: "bigint",
  jsonb: "jsonb",
  bytea: "bytea",
  date: "date",
  timestamp: "timestamp without time zone",
  "timestamp with time zone": "timestamp with time zone",
};

export class SchemaTypeMismatchError extends Error {
  constructor(public readonly mismatches: readonly string[]) {
    super(
      "This database's tables do not have the column types " +
        "@corbits/artifact-core requires, so it is reading columns it did not " +
        "create through its own codec. Mismatches:\n" +
        mismatches.map((line) => `  - ${line}`).join("\n") +
        "\nThe migrations use CREATE TABLE IF NOT EXISTS, which matches on " +
        "the table NAME only: a pre-existing table of the same name is left " +
        "untouched. Rename the conflicting table, or mount this package on a " +
        "schema of its own.",
    );
    this.name = "SchemaTypeMismatchError";
  }
}

const GUARDED_TABLES: readonly PgTable[] = [
  artifact,
  artifactVersion,
  upload,
  mailAttachmentRef,
];

type ExpectedColumn = { table: string; column: string; dataType: string };

/** The (table, column, data_type) triples this package depends on. */
export function expectedColumnTypes(): ExpectedColumn[] {
  const expected: ExpectedColumn[] = [];
  for (const table of GUARDED_TABLES) {
    const name = getTableName(table);
    for (const column of Object.values(getTableColumns(table))) {
      const sqlType = column.getSQLType();
      const dataType = DATA_TYPE_BY_SQL_TYPE[sqlType];
      if (dataType === undefined) {
        throw new Error(
          `No information_schema data_type mapping for drizzle SQL type ` +
            `"${sqlType}" on ${name}.${column.name}. Add it to ` +
            `DATA_TYPE_BY_SQL_TYPE in schema-check.ts.`,
        );
      }
      expected.push({ table: name, column: column.name, dataType });
    }
  }
  return expected;
}

/**
 * Throws `SchemaTypeMismatchError` naming every column whose live type differs
 * from the one this package's codec assumes, including a column that is missing
 * outright. Runs on the migration's own transaction so it sees exactly the
 * schema that transaction just produced.
 */
export async function assertExpectedColumnTypes(
  db: ArtifactDb | ArtifactTx,
): Promise<void> {
  const expected = expectedColumnTypes();
  const tables = [...new Set(expected.map((e) => e.table))];
  const rows = await db.execute<{
    table_name: string;
    column_name: string;
    data_type: string;
  }>(sql`
    SELECT "table_name", "column_name", "data_type"
    FROM information_schema.columns
    WHERE "table_schema" = current_schema()
      AND "table_name" IN (${sql.join(
        tables.map((t) => sql`${t}`),
        sql`, `,
      )})
  `);
  const live = new Map(
    rows.map((row) => [`${row.table_name}.${row.column_name}`, row.data_type]),
  );

  const mismatches: string[] = [];
  for (const { table, column, dataType } of expected) {
    const actual = live.get(`${table}.${column}`);
    if (actual === undefined) {
      mismatches.push(`${table}.${column} is missing (expected ${dataType})`);
      continue;
    }
    if (actual !== dataType) {
      mismatches.push(`${table}.${column} is ${actual}, expected ${dataType}`);
    }
  }
  if (mismatches.length > 0) throw new SchemaTypeMismatchError(mismatches);
}
