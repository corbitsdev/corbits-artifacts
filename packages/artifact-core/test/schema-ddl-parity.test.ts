// The drizzle table objects are a public export, so a host can point
// `drizzle-kit push`/`generate` at them. If `schema.ts` declares an index the
// migrations do not create — or creates one with a different column order, a
// different direction, or as a CONSTRAINT where the DDL made a bare INDEX —
// that host's schema silently diverges from the one this package's queries were
// planned against, and its drizzle-kit diff never converges. `migrations.test.ts`
// diffs table NAMES; this suite diffs what is inside them.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  artifact,
  artifactVersion,
  upload,
  mailAttachmentRef,
} from "../src/schema.js";
import { runArtifactMigrations } from "../src/migrations.js";
import { DATABASE_URL } from "./helpers.js";

// A private schema built from empty, so what is compared is what a host booting
// against a fresh database actually gets — not whatever the shared `public`
// schema has accumulated across suites.
const SCHEMA = "artifact_ddl_parity";
const client = postgres(DATABASE_URL, {
  onnotice: () => {},
  connection: { search_path: SCHEMA },
});
const admin = postgres(DATABASE_URL, { onnotice: () => {} });

beforeAll(async () => {
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.unsafe(`CREATE SCHEMA ${SCHEMA}`);
  await runArtifactMigrations(drizzle(client));
});

afterAll(async () => {
  await client.end();
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.end();
});

const TABLES: PgTable[] = [artifact, artifactVersion, upload, mailAttachmentRef];

/** `name(col asc, col desc)` plus `unique`/`unique constraint`/`partial` markers. */
type IndexDescriptor = string;

// `unique index` and `unique constraint` are deliberately NOT the same
// descriptor. Postgres backs both with an index, but drizzle-kit emits
// `ADD CONSTRAINT ... UNIQUE` for one and `CREATE UNIQUE INDEX` for the other,
// so a host diffing `schema.ts` against DDL that used the other form gets a
// migration that never stops being pending.
function suffixFor(flags: (string | null)[]): string {
  const kept = flags.filter((flag) => flag !== null);
  return kept.length > 0 ? ` [${kept.join(" ")}]` : "";
}

function declaredIndexes(table: PgTable): IndexDescriptor[] {
  const { indexes, uniqueConstraints } = getTableConfig(table);

  const fromIndexes = indexes.map((index) => {
    const config = index.config;
    const columns = config.columns
      .map((column) => {
        // Every index here is over plain columns; an expression index would
        // have no `.name` and must be added to this canonicalizer before it
        // can be compared at all, rather than silently comparing as blank.
        const name = (column as { name?: string }).name;
        if (name === undefined) {
          throw new Error(
            `index ${config.name} uses an expression column this parity check cannot canonicalize`,
          );
        }
        const order =
          (column as { indexConfig?: { order?: string } }).indexConfig?.order ??
          "asc";
        return `${name} ${order}`;
      })
      .join(", ");
    return `${config.name}(${columns})${suffixFor([
      config.unique === true ? "unique" : null,
      config.where !== undefined ? "partial" : null,
    ])}`;
  });

  // A `unique()` table constraint is index-backed too, so it shows up on the
  // live side and must be compared, not ignored.
  const fromConstraints = uniqueConstraints.map((constraint) => {
    const columns = constraint.columns
      .map((column) => `${column.name} asc`)
      .join(", ");
    return `${constraint.name}(${columns})${suffixFor(["unique constraint"])}`;
  });

  return [...fromIndexes, ...fromConstraints].sort();
}

// `pg_get_indexdef` renders `CREATE [UNIQUE] INDEX <name> ON <tbl> USING btree
// (<cols>)[ WHERE (<pred>)]`, with DESC spelled out and ASC left implicit.
function canonicalizeIndexDef(
  def: string,
  isConstraint: boolean,
): IndexDescriptor {
  const match =
    /^CREATE (UNIQUE )?INDEX (\S+) ON \S+ USING btree \((.*?)\)( WHERE .*)?$/.exec(
      def,
    );
  if (match === null) throw new Error(`unparsed index definition: ${def}`);
  const [, unique, name, columnList, where] = match;
  const columns = columnList!
    .split(", ")
    .map((column) => {
      const desc = / DESC$/.test(column);
      const bare = column.replace(/ (DESC|ASC)$/, "").replace(/ NULLS.*$/, "");
      return `${bare} ${desc ? "desc" : "asc"}`;
    })
    .join(", ");
  return `${name}(${columns})${suffixFor([
    isConstraint ? "unique constraint" : unique !== undefined ? "unique" : null,
    where !== undefined ? "partial" : null,
  ])}`;
}

type LiveRow = { indexdef: string; contype: string | null };

async function liveIndexes(tableName: string): Promise<IndexDescriptor[]> {
  // `pg_constraint.conindid` is what distinguishes a constraint-backed index
  // from a bare `CREATE UNIQUE INDEX` — `pg_indexes` alone cannot tell them
  // apart, and that difference is exactly what drizzle-kit diffs on.
  const rows = await drizzle(client).execute<LiveRow>(sql`
    SELECT pg_get_indexdef(x.indexrelid) AS indexdef,
           con.contype::text AS contype
      FROM pg_index x
      JOIN pg_class c ON c.oid = x.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_constraint con
        ON con.conindid = x.indexrelid AND con.contype = 'u'
     WHERE n.nspname = ${SCHEMA}
       AND c.relname = ${tableName}
       AND NOT x.indisprimary
  `);
  return rows
    .map((row) => canonicalizeIndexDef(row.indexdef, row.contype === "u"))
    .sort();
}

// `table(cols) -> foreignTable(cols) on delete <action>`. The referential
// action is part of the descriptor because it is behaviour, not decoration:
// `parent_id` and `artifact_version.artifact_id` both cascade, and a schema.ts
// that omitted the action would have drizzle-kit propose dropping and recreating
// both constraints with `NO ACTION`.
function declaredForeignKeys(table: PgTable): string[] {
  const { name, foreignKeys } = getTableConfig(table);
  return foreignKeys
    .map((fk) => {
      const ref = fk.reference();
      const columns = ref.columns.map((column) => column.name).join(", ");
      const foreignTable = getTableConfig(ref.foreignTable).name;
      const foreignColumns = ref.foreignColumns
        .map((column) => column.name)
        .join(", ");
      const action = (fk.onDelete ?? "no action").toLowerCase();
      return `${name}(${columns}) -> ${foreignTable}(${foreignColumns}) on delete ${action}`;
    })
    .sort();
}

async function liveForeignKeys(tableName: string): Promise<string[]> {
  const rows = await drizzle(client).execute<{ def: string }>(sql`
    SELECT pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${SCHEMA}
       AND c.relname = ${tableName}
       AND con.contype = 'f'
  `);
  return rows
    .map((row) => {
      // `FOREIGN KEY (parent_id) REFERENCES artifact(id) ON DELETE CASCADE`
      const match =
        /^FOREIGN KEY \((.*?)\) REFERENCES (\w+)\((.*?)\)( ON DELETE (.+))?$/.exec(
          row.def,
        );
      if (match === null) {
        throw new Error(`unparsed foreign key definition: ${row.def}`);
      }
      const [, columns, foreignTable, foreignColumns, , action] = match;
      return `${tableName}(${columns}) -> ${foreignTable}(${foreignColumns}) on delete ${(action ?? "no action").toLowerCase()}`;
    })
    .sort();
}

describe("schema.ts vs. the DDL runArtifactMigrations actually creates", () => {
  for (const table of TABLES) {
    const { name } = getTableConfig(table);
    it(`${name} declares exactly the indexes the live table has, in the same column order`, async () => {
      expect(declaredIndexes(table)).toEqual(await liveIndexes(name));
    });
  }

  for (const table of TABLES) {
    const { name } = getTableConfig(table);
    it(`${name} declares exactly the foreign keys the live table has, with the same referential actions`, async () => {
      expect(declaredForeignKeys(table)).toEqual(await liveForeignKeys(name));
    });
  }

  it("keeps both cascades — the self-nesting one and the version one", async () => {
    // `parent_id` has no live writer today, but it is the declared nesting
    // seam and its cascade is what makes deleting a parent safe. The version
    // cascade is what stops history outliving its artifact.
    expect(await liveForeignKeys("artifact")).toEqual([
      "artifact(parent_id) -> artifact(id) on delete cascade",
    ]);
    expect(await liveForeignKeys("artifact_version")).toEqual([
      "artifact_version(artifact_id) -> artifact(id) on delete cascade",
    ]);
    // The by-value tables couple to nothing: no FKs into any control plane.
    expect(await liveForeignKeys("upload")).toEqual([]);
    expect(await liveForeignKeys("mail_attachment_ref")).toEqual([]);
  });

  it("keeps the list's keyset index with the id tie-break IN it", async () => {
    // Without `id` in the index the keyset cursor's row-value comparison
    // degrades from an Index Cond to a Filter plus an Incremental Sort, and
    // every page re-walks the tie group at that `updated_at`.
    const descriptor =
      "artifact_tenant_updated_id_idx(tenant_id asc, updated_at asc, id asc)";
    expect(await liveIndexes("artifact")).toContain(descriptor);
    expect(declaredIndexes(artifact)).toContain(descriptor);
  });

  it("keeps the version and attachment keys as unique CONSTRAINTS, not bare indexes", async () => {
    // The DDL declares both inline as `CONSTRAINT ... UNIQUE`. Declaring them
    // as `uniqueIndex()` instead would make drizzle-kit want to drop two
    // constraints and create two indexes the migrations never make, forever.
    for (const [table, descriptor] of [
      [
        "artifact_version",
        "artifact_version_artifact_id_version(artifact_id asc, version asc) [unique constraint]",
      ],
      [
        "mail_attachment_ref",
        "mail_attachment_ref_mail_id_artifact_id(mail_id asc, artifact_id asc) [unique constraint]",
      ],
    ] as const) {
      expect(await liveIndexes(table)).toContain(descriptor);
    }
  });
});
