import { describe, expect, test } from "bun:test";
import {
  normalizeWebSiteContent,
  normalizeWebSitePath,
  parseWebSiteContentJson,
  serializeWebSiteContent,
  summarizeWebSiteContent,
  WEB_SITE_MAX_FILES,
  WebSiteContentError,
} from "../src/web-site.js";
import { denyAllAdminAuthz, noProvenance } from "../src/ports.js";

describe("path normalization", () => {
  test("strips leading slashes and converts backslashes", () => {
    expect(normalizeWebSitePath("/assets\\app.css")).toBe("assets/app.css");
    expect(normalizeWebSitePath("  index.html  ")).toBe("index.html");
  });

  test("refuses traversal, empty segments, and an empty path", () => {
    for (const bad of ["../secret", "a/../../b", "a//b", "   ", "/"]) {
      expect(() => normalizeWebSitePath(bad)).toThrow(WebSiteContentError);
    }
  });
});

describe("content validation", () => {
  test("defaults the entry to index.html and normalizes every path", () => {
    expect(
      normalizeWebSiteContent({ files: { "/index.html": "<p/>", "a\\b.css": "x" } }),
    ).toEqual({ entry: "index.html", files: { "index.html": "<p/>", "a/b.css": "x" } });
  });

  test("requires the entry file to exist in the bundle", () => {
    expect(() =>
      normalizeWebSiteContent({ entry: "main.html", files: { "index.html": "<p/>" } }),
    ).toThrow(/entry file "main.html" is not present/);
  });

  test("refuses an empty bundle and two paths that normalize to one", () => {
    expect(() => normalizeWebSiteContent({ files: {} })).toThrow(/at least one file/);
    expect(() =>
      normalizeWebSiteContent({ files: { "index.html": "a", "/index.html": "b" } }),
    ).toThrow(/duplicate path after normalization/);
  });

  test("enforces the file-count ceiling", () => {
    const files: Record<string, string> = { "index.html": "<p/>" };
    for (let i = 0; i < WEB_SITE_MAX_FILES; i += 1) files[`f${i}.css`] = "x";
    expect(() => normalizeWebSiteContent({ files })).toThrow(/max file count/);
  });

  test("enforces the total-size ceiling", () => {
    expect(() =>
      normalizeWebSiteContent({ files: { "index.html": "x".repeat(4_500_001) } }),
    ).toThrow(/total size exceeds/);
  });

  test("rejects invalid JSON and a payload of the wrong shape", () => {
    expect(() => parseWebSiteContentJson("{oops")).toThrow(/must be valid JSON/);
    expect(() => parseWebSiteContentJson('{"files":"nope"}')).toThrow(/content invalid/);
  });

  test("serialize then parse is a fixed point", () => {
    const raw = serializeWebSiteContent({ files: { "/index.html": "<p/>" } });
    expect(parseWebSiteContentJson(raw)).toEqual({
      entry: "index.html",
      files: { "index.html": "<p/>" },
    });
  });
});

describe("summary", () => {
  test("reports each file's byte length, sorted, with the total", () => {
    const raw = serializeWebSiteContent({
      files: { "index.html": "<h1>Hi</h1>", "a.css": "body{}" },
    });
    expect(summarizeWebSiteContent(raw)).toEqual({
      kind: "web_site",
      entry: "index.html",
      files: [
        { path: "a.css", bytes: 6 },
        { path: "index.html", bytes: 11 },
      ],
      totalBytes: 17,
    });
  });

  test("counts bytes, not characters, for multi-byte content", () => {
    const raw = serializeWebSiteContent({ files: { "index.html": "é" } });
    expect(summarizeWebSiteContent(raw).totalBytes).toBe(2);
  });
});

describe("default seams", () => {
  test("the deny-all authz refuses administration and every cross-tenant read", async () => {
    expect(
      await denyAllAdminAuthz.canAdminister(
        { tenantId: "t", principalId: "p" },
        { ownerPrincipalId: "p" },
      ),
    ).toBe(false);
    expect(
      await denyAllAdminAuthz.canReadTenant({ tenantId: "t", principalId: "p" }, "other"),
    ).toBe(false);
  });

  test("the no-op provenance leaves rows untouched", async () => {
    const rows = [{ source: { origin: "manual" } }];
    await noProvenance.decorate("t", rows);
    expect(rows).toEqual([{ source: { origin: "manual" } }]);
  });
});
