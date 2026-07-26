#!/usr/bin/env bun
// Fails the build if this repo reaches for anything off limits. This package is
// a public, mountable module: it must stand up on a host schema it knows nothing
// about, so it may not depend on an unpublished scope, on Interchange's own
// database package, or on Interchange's workflow tables. Everything it needs
// from a host arrives through a DECLARED PORT — the `ArtifactDb` handle and the
// authz/identity/provenance seams — never through an import or a table name
// compiled into this package.
//
// Three categories, each independently fatal:
//
//  1. `@workbench/*` — an unpublished scope. Importing it would make this
//     package uninstallable for anyone outside the project that defines it.
//  2. `@intx/db` — Interchange's schema+client package. Taking it would bind
//     the module to one host's migration story and one host's table layout;
//     the host hands over a drizzle handle through `ArtifactDb` instead.
//     (`@intx/types` is fine: it is types and pure predicates, and it is a
//     declared peer dependency.)
//  3. Workflow tables — reading them directly would make provenance a database
//     join against a host's private schema instead of the Seam C port the host
//     supplies.
//
// Scope is per-directory, not one flat list:
//
//  - The package's own `src/` and `test/` carry all three categories.
//  - `examples/` — the reference host, this package's acceptance proof, which
//    ships in the repo — carries the UNIVERSAL category only. The example IS an
//    Interchange host: it legitimately imports `createDB`/`runMigrations`/
//    `schema` from `@intx/db` to build the app the module mounts on, and
//    applying the module's ruleset there flags correct code. What no shipped
//    file may do, host or module, is import an unpublished scope.
//  - Dependency source and build output are never scanned anywhere: an example's
//    `node_modules` contains other people's code — including this package,
//    re-exported — and flagging it teaches people to delete the rule rather than
//    fix a real leak.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const REPO_ROOT = join(ROOT, "..", "..");

/** Never descended into, under any scan root. */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage"]);

/** Interchange's workflow tables. Provenance comes from Seam C, not a join. */
const WORKFLOW_TABLES = new Set([
  "workflow",
  "workflow_definition",
  "workflow_run",
  "workflow_step",
  "workflow_step_run",
  "workflow_version",
]);

// Match a module SPECIFIER, not any mention of the string, so prose and test
// assertions about the guard itself are not false positives.
// `import "@workbench/x"` (side-effect only) has no `from`, so it needs its own
// alternative — without it the most concise way to write the forbidden
// dependency was the one form the guard let through.
const specifier = (pattern: string) =>
  new RegExp(
    `(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\brequire\\s*\\(\\s*|\\bimport\\s+)["'\`]${pattern}`,
  );

// A table reference is a quoted identifier in a TABLE POSITION —
// `pgTable("workflow_run", ...)`, `sql.identifier("workflow")`, or a raw
// fragment selecting FROM / JOIN / INTO / UPDATE it.
//
// The position matters, and this is not pedantry: `"workflow"` is also one of
// this module's own `ARTIFACT_ORIGINS` values, so a guard that flagged the bare
// string anywhere would fire on `source: { origin: "workflow" }` — legitimate,
// by-value, touching no host table. Whoever hit that would delete the rule
// rather than narrow it, and the real category would go unguarded.
const TABLE_POSITION =
  /(?:pgTable\(\s*|sql\.identifier\(\s*|\b(?:from|join|into|update|table)\s+)["'`]([a-z_]+)["'`]/gi;

// The `workflow_` family is unambiguous wherever it appears — no origin value,
// kind, or field name shares the prefix — so it is caught in any position, not
// only a recognized one. Between the two rules, a raw multi-table SQL list is
// covered even where the position regex cannot see the table keyword.
// Deliberately NOT /g: `.test()` on a global regex carries `lastIndex` between
// calls and would skip every other match.
const WORKFLOW_PREFIXED = /["'`]workflow_[a-z_]+["'`]/;

type Rule = {
  label: string;
  /** Whether this line commits the violation. */
  matches: (line: string) => boolean;
};

/**
 * The droppability invariant: true of the package AND of everything shipped
 * alongside it.
 */
const NO_WORKBENCH: Rule = {
  label: "@workbench/* import",
  matches: (line) => specifier("@workbench/").test(line),
};

const UNIVERSAL_RULES: Rule[] = [NO_WORKBENCH];

/** Rules that hold only for the package itself — a host may do all of these. */
const PACKAGE_RULES: Rule[] = [
  ...UNIVERSAL_RULES,
  {
    label: "@intx/db import",
    matches: (line) => specifier("@intx/db").test(line),
  },
  {
    label: "workflow-table reference",
    matches: (line) => {
      for (const [, name] of line.matchAll(TABLE_POSITION)) {
        if (WORKFLOW_TABLES.has(name!.toLowerCase())) return true;
      }
      return WORKFLOW_PREFIXED.test(line);
    },
  },
];

const SCANS: { dir: string; rules: Rule[] }[] = [
  { dir: join(ROOT, "src"), rules: PACKAGE_RULES },
  { dir: join(ROOT, "test"), rules: PACKAGE_RULES },
  { dir: join(REPO_ROOT, "examples"), rules: UNIVERSAL_RULES },
];

// Comment lines are skipped before matching. The guard documents itself and its
// own tests name what they forbid; a guard that flags its own explanation
// teaches people to weaken it. Code is what ships, so code is what is scanned.
const isComment = (line: string) => /^\s*(?:\/\/|\/\*|\*)/.test(line);

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const violations: string[] = [];
for (const { dir, rules } of SCANS) {
  try {
    statSync(dir);
  } catch {
    continue;
  }
  for (const file of walk(dir, [])) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((text, index) => {
        if (isComment(text)) return;
        for (const rule of rules) {
          if (rule.matches(text)) {
            violations.push(`  [${rule.label}] ${file}:${index + 1}: ${text.trim()}`);
          }
        }
      });
  }
}

if (violations.length > 0) {
  console.error("dep-guard: forbidden dependency found:");
  for (const v of violations) console.error(v);
  process.exit(1);
}

console.log(
  `dep-guard: clean — no ${PACKAGE_RULES.map((r) => r.label).join(", no ")} in src/ or test/, and no ${NO_WORKBENCH.label} in examples/.`,
);
