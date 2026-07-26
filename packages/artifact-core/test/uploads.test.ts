import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_UPLOAD_POLICY,
  createFileArtifact,
  downloadFilename,
  effectiveUploadMime,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILE_COUNT,
  MAX_UPLOAD_TOTAL_BYTES,
  PARSED_DOCUMENT_POLICY,
  SPREADSHEET_UPLOAD_POLICY,
  UnsupportedUploadTypeError,
  type UploadPolicy,
} from "../src/uploads.js";
import { InlineContentStore } from "../src/content-store.js";
import { artifact, upload } from "../src/schema.js";
import { SCOPE, testDb } from "./helpers.js";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("MIME gating", () => {
  test("trusts a declared type the policy accepts", () => {
    expect(
      effectiveUploadMime({ name: "a.png", type: "image/png" }, ARTIFACT_UPLOAD_POLICY),
    ).toBe("image/png");
  });

  test("falls back to the extension when the browser omits the type", () => {
    expect(
      effectiveUploadMime({ name: "sheet.XLSX", type: "" }, ARTIFACT_UPLOAD_POLICY),
    ).toBe(XLSX);
  });

  test("falls back to the extension when the declared type is not accepted", () => {
    expect(
      effectiveUploadMime(
        { name: "doc.pdf", type: "application/x-made-up" },
        ARTIFACT_UPLOAD_POLICY,
      ),
    ).toBe("application/pdf");
  });

  test("rejects a file that resolves through neither type nor extension", () => {
    expect(
      effectiveUploadMime({ name: "payload.bin", type: "" }, ARTIFACT_UPLOAD_POLICY),
    ).toBe("");
    expect(
      effectiveUploadMime(
        { name: "run.sh", type: "application/x-sh" },
        ARTIFACT_UPLOAD_POLICY,
      ),
    ).toBe("");
  });

  test("SVG is excluded — it can carry inline script and would be stored XSS", () => {
    expect(ARTIFACT_UPLOAD_POLICY.accepts("image/svg+xml")).toBe(false);
    expect(
      effectiveUploadMime(
        { name: "logo.svg", type: "image/svg+xml" },
        ARTIFACT_UPLOAD_POLICY,
      ),
    ).toBe("");
  });

  test("the three policies stay genuinely distinct, per entry point", () => {
    // Spreadsheet ingest is the narrowest; parsed documents exclude images;
    // the gallery import is the union.
    expect(SPREADSHEET_UPLOAD_POLICY.accepts("application/pdf")).toBe(false);
    expect(SPREADSHEET_UPLOAD_POLICY.accepts(XLSX)).toBe(true);

    // Delegated to Interchange's own attachment allowlist: it takes PDFs but
    // not Office formats, and it excludes SVG for us.
    expect(PARSED_DOCUMENT_POLICY.accepts("application/pdf")).toBe(true);
    expect(PARSED_DOCUMENT_POLICY.accepts(XLSX)).toBe(false);
    expect(PARSED_DOCUMENT_POLICY.accepts("image/svg+xml")).toBe(false);
    expect(effectiveUploadMime({ name: "sheet.xlsx", type: "" }, PARSED_DOCUMENT_POLICY)).toBe(
      "",
    );

    expect(ARTIFACT_UPLOAD_POLICY.accepts("image/png")).toBe(true);
    expect(ARTIFACT_UPLOAD_POLICY.accepts("application/pdf")).toBe(true);

    expect(
      effectiveUploadMime({ name: "a.png", type: "image/png" }, SPREADSHEET_UPLOAD_POLICY),
    ).toBe("");
  });

  // The ceilings are BEHAVIOR-tested against the route in mount.test.ts, where
  // a real request is driven across each boundary. This only pins the published
  // numbers so a silent change to the contract is visible in a diff — it is not
  // and must not be mistaken for coverage of the branches themselves.
  test("the published ceiling constants are the documented ones", () => {
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_UPLOAD_FILE_COUNT).toBe(50);
    expect(MAX_UPLOAD_TOTAL_BYTES).toBe(100 * 1024 * 1024);
  });
});

/**
 * All three allowlists are live config, not decoration: `createFileArtifact`
 * requires one, so whichever surface mints a file artifact is gated by the
 * policy it names. Two of the three surfaces (spreadsheet ingest, chat/mail
 * attachment divert) are HOST-owned routes — this package ships no spreadsheet
 * parser and no message pipeline — but the host still cannot mint a file
 * artifact outside the allowlist for the surface it claims to be serving.
 */
describe("every entry-point policy gates createFileArtifact", () => {
  const mint = (
    db: Awaited<ReturnType<typeof testDb>>,
    policy: UploadPolicy,
    filename: string,
    mimeType: string,
  ) =>
    db.transaction((tx) =>
      createFileArtifact(tx, InlineContentStore, {
        scope: SCOPE,
        ownerPrincipalId: SCOPE.principal,
        filename,
        mimeType,
        bytes: new Uint8Array([1, 2, 3]),
        policy,
      }),
    );

  const SURFACES: [string, UploadPolicy, [string, string], [string, string]][] = [
    [
      "ARTIFACT_UPLOAD_POLICY (gallery import — this package's own route)",
      ARTIFACT_UPLOAD_POLICY,
      ["chart.png", "image/png"],
      // An SVG can carry inline <script>: stored XSS on the app origin.
      ["logo.svg", "image/svg+xml"],
    ],
    [
      "SPREADSHEET_UPLOAD_POLICY (host-owned spreadsheet ingest)",
      SPREADSHEET_UPLOAD_POLICY,
      ["book.xlsx", XLSX],
      // The narrow surface must stay narrow: a PDF here would reach a parser
      // that only understands one format.
      ["report.pdf", "application/pdf"],
    ],
    [
      "PARSED_DOCUMENT_POLICY (host-owned chat/mail attachment divert)",
      PARSED_DOCUMENT_POLICY,
      ["notes.txt", "text/plain"],
      ["logo.svg", "image/svg+xml"],
    ],
  ];

  for (const [label, policy, [okName, okMime], [badName, badMime]] of SURFACES) {
    test(`${label} admits its own type and refuses one outside it`, async () => {
      const db = await testDb();

      const row = await mint(db, policy, okName, okMime);
      expect(row.title).toBe(okName);

      await expect(mint(db, policy, badName, badMime)).rejects.toThrow(
        UnsupportedUploadTypeError,
      );

      // Refused at the gate, BEFORE the ContentStore is touched: a rejected
      // file leaves no blob and no artifact behind it.
      expect((await db.select().from(upload)).length).toBe(1);
      expect((await db.select().from(artifact)).length).toBe(1);
    });
  }

  test("the narrow surfaces really are narrower than the gallery's", () => {
    // If a policy ever widened to match the gallery's, the tests above would
    // still pass while the separation the three lists exist for was gone.
    expect(ARTIFACT_UPLOAD_POLICY.accepts("image/png")).toBe(true);
    expect(SPREADSHEET_UPLOAD_POLICY.accepts("image/png")).toBe(false);
    expect(PARSED_DOCUMENT_POLICY.accepts("image/svg+xml")).toBe(false);
  });
});

describe("downloadFilename", () => {
  test("strips characters that would break the header and never returns empty", () => {
    expect(downloadFilename('a"b\\c\nd.png')).toBe("abcd.png");
    expect(downloadFilename("   ")).toBe("download");
  });
});

describe("createFileArtifact", () => {
  test("mints the artifact eagerly — bytes, row, and version 1 in one transaction", async () => {
    const db = await testDb();
    const row = await db.transaction((tx) =>
      createFileArtifact(tx, InlineContentStore, {
        scope: SCOPE,
        ownerPrincipalId: SCOPE.principal,
        filename: "report.pdf",
        mimeType: "application/pdf",
        bytes: new Uint8Array([1, 2, 3]),
        policy: ARTIFACT_UPLOAD_POLICY,
        generatedBy: "Weekly Report",
      }),
    );

    expect(row.kind).toBe("file");
    expect(row.title).toBe("report.pdf");
    expect(row.source).toMatchObject({ origin: "imported", generatedBy: "Weekly Report" });
    expect(row.version).toBe(1);
  });

  test("a caller that fails after storing leaves neither an upload nor an artifact", async () => {
    const db = await testDb();
    await expect(
      db.transaction(async (tx) => {
        await createFileArtifact(tx, InlineContentStore, {
          scope: SCOPE,
          ownerPrincipalId: null,
          filename: "half.pdf",
          mimeType: "application/pdf",
          bytes: new Uint8Array([1]),
          policy: ARTIFACT_UPLOAD_POLICY,
        });
        throw new Error("downstream failure");
      }),
    ).rejects.toThrow("downstream failure");

    expect((await db.select().from(upload)).length).toBe(0);
    expect((await db.select().from(artifact)).length).toBe(0);
  });
});
