import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGE_ROOT = join(import.meta.dir, "..");
const GUARD = join(PACKAGE_ROOT, "scripts", "dep-guard.ts");
const PLANTED = join(PACKAGE_ROOT, "src", "__dep-guard-probe.ts");

const runGuard = async () => {
  const proc = Bun.spawn(["bun", "run", GUARD], {
    cwd: PACKAGE_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stderr };
};

afterEach(() => rmSync(PLANTED, { force: true }));

// Every forbidden token below is assembled at runtime: writing one literally in
// this file would make the guard flag its own test, which is exactly the false
// positive the position-aware patterns exist to avoid.
const WORKBENCH = `@work${"bench"}/shared`;
const INTX_DB = `@intx/${"db"}`;
const WORKFLOW_TABLE = `workflow${"_run"}`;

/** One planted violation per forbidden category, with the label it must report. */
const CATEGORIES: { label: string; token: string; source: string }[] = [
  {
    label: "@workbench/* import",
    token: WORKBENCH,
    source: `import { artifactOrigins } from "${WORKBENCH}";\nexport { artifactOrigins };\n`,
  },
  {
    label: "@intx/db import",
    token: INTX_DB,
    source: `import { schema } from "${INTX_DB}";\nexport { schema };\n`,
  },
  {
    label: "workflow-table reference",
    token: WORKFLOW_TABLE,
    // A join against the host's workflow tables — the thing the Seam C
    // provenance port exists so this package never has to write.
    source:
      `import { sql } from "drizzle-orm";\n` +
      `export const runs = sql\`SELECT "id" FROM "${WORKFLOW_TABLE}"\`;\n`,
  },
];

describe("dep-guard", () => {
  test(
    "passes on the package as it stands",
    async () => {
      const { exitCode, stderr } = await runGuard();
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    },
    30_000,
  );

  for (const category of CATEGORIES) {
    test(
      `fails, naming the file and the category, on a planted ${category.label}`,
      async () => {
        writeFileSync(PLANTED, category.source);
        const { exitCode, stderr } = await runGuard();
        expect(exitCode).toBe(1);
        expect(stderr).toContain("__dep-guard-probe.ts");
        expect(stderr).toContain(`[${category.label}]`);
        expect(stderr).toContain(category.token);

        // …and passes again the moment the violation is removed, so the guard
        // is proven to be reacting to the plant and not merely broken.
        rmSync(PLANTED);
        expect((await runGuard()).exitCode).toBe(0);
      },
      30_000,
    );
  }

  // The guard's own escape hatch, pinned: a comment may DISCUSS a forbidden
  // thing without failing the build, but the same text as code must still fail.
  test("a forbidden token in a comment is allowed; the same token in code is not", async () => {
    writeFileSync(PLANTED, `// never import from "${WORKBENCH}"\nexport const ok = 1;\n`);
    expect((await runGuard()).exitCode).toBe(0);

    writeFileSync(PLANTED, `export * from "${WORKBENCH}";\n`);
    expect((await runGuard()).exitCode).toBe(1);
  }, 30_000);

  // @intx/types is a declared peer dependency and must NOT be caught by the
  // @intx/db rule — a prefix-happy pattern would break the package's one
  // legitimate Interchange import.
  test("the sibling @intx/types import the package legitimately uses still passes", async () => {
    writeFileSync(
      PLANTED,
      `import { isAllowedMimeType } from "@intx/types";\nexport { isAllowedMimeType };\n`,
    );
    expect((await runGuard()).exitCode).toBe(0);
  }, 30_000);

  // `workflow` is one of this module's own ARTIFACT_ORIGINS values. Held by
  // value in a jsonb column it touches no host table, and the guard must not
  // punish it — otherwise the rule gets deleted instead of narrowed.
  test("the 'workflow' origin string is not a workflow-table reference", async () => {
    writeFileSync(PLANTED, `export const source = { origin: "work${"flow"}" } as const;\n`);
    expect((await runGuard()).exitCode).toBe(0);
  }, 30_000);
});
