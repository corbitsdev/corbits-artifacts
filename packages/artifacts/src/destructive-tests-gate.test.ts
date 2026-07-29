import { describe, expect, test } from "bun:test";
import {
  ALLOW_DESTRUCTIVE_ARTIFACT_TESTS,
  assertDestructiveArtifactTestsAllowed,
  databaseNameFromConnectionString,
  isAllowlistedArtifactTestDatabase,
} from "./test-helpers.js";

describe("databaseNameFromConnectionString", () => {
  test("reads the path segment of a postgres URL", () => {
    expect(
      databaseNameFromConnectionString(
        "postgres://postgres:postgres@localhost:5457/artifact_core",
      ),
    ).toBe("artifact_core");
  });

  test("strips query parameters", () => {
    expect(
      databaseNameFromConnectionString(
        "postgresql://u:p@db.example:5432/artifacts_test?sslmode=require",
      ),
    ).toBe("artifacts_test");
  });

  test("decodes percent-encoded names", () => {
    expect(
      databaseNameFromConnectionString("postgres://localhost/my%2Ddb_test"),
    ).toBe("my-db_test");
  });

  test("refuses a URL with no database name", () => {
    expect(() => databaseNameFromConnectionString("postgres://localhost/")).toThrow(
      /database name/i,
    );
  });
});

describe("isAllowlistedArtifactTestDatabase", () => {
  test("allows the documented default name", () => {
    expect(isAllowlistedArtifactTestDatabase("artifact_core")).toBe(true);
  });

  test("allows names ending in _test", () => {
    expect(isAllowlistedArtifactTestDatabase("artifacts_test")).toBe(true);
    expect(isAllowlistedArtifactTestDatabase("foo_test")).toBe(true);
  });

  test("refuses production-looking names", () => {
    expect(isAllowlistedArtifactTestDatabase("postgres")).toBe(false);
    expect(isAllowlistedArtifactTestDatabase("interchange")).toBe(false);
    expect(isAllowlistedArtifactTestDatabase("artifact_prod")).toBe(false);
    expect(isAllowlistedArtifactTestDatabase("test")).toBe(false);
  });
});

describe("assertDestructiveArtifactTestsAllowed", () => {
  const ephemeral =
    "postgres://postgres:postgres@localhost:5457/artifact_core";
  const production =
    "postgres://postgres:postgres@localhost:5432/interchange";

  test("refuses when the opt-in env is unset, even on an allowlisted name", () => {
    expect(() =>
      assertDestructiveArtifactTestsAllowed(ephemeral, {}),
    ).toThrow(ALLOW_DESTRUCTIVE_ARTIFACT_TESTS);
  });

  test("refuses when the opt-in env is not exactly 1", () => {
    expect(() =>
      assertDestructiveArtifactTestsAllowed(ephemeral, {
        [ALLOW_DESTRUCTIVE_ARTIFACT_TESTS]: "true",
      }),
    ).toThrow(ALLOW_DESTRUCTIVE_ARTIFACT_TESTS);
  });

  test("refuses a non-allowlisted database name even with opt-in", () => {
    expect(() =>
      assertDestructiveArtifactTestsAllowed(production, {
        [ALLOW_DESTRUCTIVE_ARTIFACT_TESTS]: "1",
      }),
    ).toThrow(/interchange/);
  });

  test("allows allowlisted name with explicit opt-in", () => {
    expect(() =>
      assertDestructiveArtifactTestsAllowed(ephemeral, {
        [ALLOW_DESTRUCTIVE_ARTIFACT_TESTS]: "1",
      }),
    ).not.toThrow();
    expect(() =>
      assertDestructiveArtifactTestsAllowed(
        "postgres://localhost/artifacts_test",
        { [ALLOW_DESTRUCTIVE_ARTIFACT_TESTS]: "1" },
      ),
    ).not.toThrow();
  });

  test("error message names both requirements", () => {
    try {
      assertDestructiveArtifactTestsAllowed(production, {});
      expect.unreachable("should have thrown");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain(ALLOW_DESTRUCTIVE_ARTIFACT_TESTS);
      expect(message).toMatch(/artifact_core|_test/);
    }
  });
});
