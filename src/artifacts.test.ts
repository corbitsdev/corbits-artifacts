import { describe, expect, test } from "bun:test";
import {
  applyArtifactEdits,
  ArtifactEditError,
  MAX_ARTIFACT_EDITS,
  type ArtifactEdit,
  reviseArtifactVersion,
} from "./artifacts.js";

describe("applyArtifactEdits", () => {
  const cases: Array<{
    name: string;
    content: string;
    edits: readonly ArtifactEdit[];
    expect: string | Error;
  }> = [
    {
      name: "empty edits is refused",
      content: "abc",
      edits: [],
      expect: new Error("edits is empty"),
    },
    {
      name: "an empty oldText is refused",
      content: "abc",
      edits: [{ oldText: "", newText: "x" }],
      expect: new Error("oldText is empty"),
    },
    {
      name: "an empty newText deletes the passage",
      content: "abc",
      edits: [{ oldText: "b", newText: "" }],
      expect: "ac",
    },
    {
      name: "a later edit can target an earlier edit's output",
      content: "ab",
      edits: [
        { oldText: "a", newText: "aX" },
        { oldText: "X", newText: "Y" },
      ],
      expect: "aYb",
    },
    {
      name: "an edit spans into its own output boundary",
      content: "abcd",
      edits: [
        { oldText: "b", newText: "B" },
        { oldText: "Bc", newText: "BC" },
      ],
      expect: "aBCd",
    },
    {
      name: "an oldText appearing more than once is refused",
      content: "aaa",
      edits: [{ oldText: "aa", newText: "x" }],
      expect: new Error("appears more than once"),
    },
  ];

  for (const { name, content, edits, expect: expected } of cases) {
    test(name, () => {
      if (expected instanceof Error) {
        expect(() => applyArtifactEdits(content, edits)).toThrow(
          expected.message,
        );
        return;
      }
      expect(applyArtifactEdits(content, edits)).toBe(expected);
    });
  }
});

// The pure URL/DB-free guards must fail BEFORE the row is locked or any query
// runs — reaching a database call in these tests is itself a failure.
const noDbTx = () =>
  new Proxy(
    {},
    {
      get: () => {
        throw new Error(
          "test reached the database — the guard ran later than it should",
        );
      },
    },
  ) as never;

const scope = { tenantId: "acme", principalId: "user-1" };

describe("reviseArtifactVersion pre-lock guards", () => {
  test("throws before locking when content and edits are both passed", async () => {
    await expect(
      reviseArtifactVersion(
        noDbTx(),
        {
          scope,
          artifactId: "a1",
          content: "whole",
          edits: [{ oldText: "x", newText: "y" }],
        },
        new Date(),
      ),
    ).rejects.toBeInstanceOf(ArtifactEditError);
    await expect(
      reviseArtifactVersion(
        noDbTx(),
        {
          scope,
          artifactId: "a1",
          content: "whole",
          edits: [{ oldText: "x", newText: "y" }],
        },
        new Date(),
      ),
    ).rejects.toThrow("Provide content or edits, not both");
  });

  test("throws before locking when the edit batch exceeds the bound", async () => {
    const tooMany: readonly ArtifactEdit[] = Array.from(
      { length: MAX_ARTIFACT_EDITS + 1 },
      () => ({ oldText: "x", newText: "y" }),
    );
    await expect(
      reviseArtifactVersion(
        noDbTx(),
        { scope, artifactId: "a1", edits: tooMany },
        new Date(),
      ),
    ).rejects.toBeInstanceOf(ArtifactEditError);
    await expect(
      reviseArtifactVersion(
        noDbTx(),
        { scope, artifactId: "a1", edits: tooMany },
        new Date(),
      ),
    ).rejects.toThrow(`edits exceeds the ${MAX_ARTIFACT_EDITS}-edit limit`);
  });

  test("a batch of exactly the bound passes the pre-lock guard and hits the DB", async () => {
    // At the bound the pre-lock guard must not fire, so the batch reaches the
    // noDbTx proxy's DB read.
    const atBound: readonly ArtifactEdit[] = Array.from(
      { length: MAX_ARTIFACT_EDITS },
      () => ({ oldText: "x", newText: "y" }),
    );
    await expect(
      reviseArtifactVersion(
        noDbTx(),
        { scope, artifactId: "a1", edits: atBound },
        new Date(),
      ),
    ).rejects.toThrow("test reached the database");
  });
});
