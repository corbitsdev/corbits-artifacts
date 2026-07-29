import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import {
  listMailAttachmentRefs,
  MailAttachmentKindError,
  MailAttachmentRefSchema,
  MAX_MAIL_ATTACHMENT_BYTES,
  saveMailAttachmentRefs,
  SaveMailAttachmentRefsSchema,
} from "./mail-attachments.js";
import { seedArtifact, SCOPE, testDb } from "./test-helpers.js";

describe("MailAttachmentRefSchema size bounds", () => {
  test("accepts a non-negative integer size within the upload ceiling", () => {
    const ok = MailAttachmentRefSchema({
      artifactId: "a1",
      name: "a.pdf",
      type: "application/pdf",
      size: 0,
    });
    expect(ok instanceof type.errors).toBe(false);
    const atCap = MailAttachmentRefSchema({
      artifactId: "a1",
      name: "a.pdf",
      type: "application/pdf",
      size: MAX_MAIL_ATTACHMENT_BYTES,
    });
    expect(atCap instanceof type.errors).toBe(false);
  });

  test("rejects a non-integer size", () => {
    const bad = MailAttachmentRefSchema({
      artifactId: "a1",
      name: "a.pdf",
      type: "application/pdf",
      size: 1.5,
    });
    expect(bad instanceof type.errors).toBe(true);
  });

  test("rejects a size above the upload ceiling", () => {
    const bad = MailAttachmentRefSchema({
      artifactId: "a1",
      name: "a.pdf",
      type: "application/pdf",
      size: MAX_MAIL_ATTACHMENT_BYTES + 1,
    });
    expect(bad instanceof type.errors).toBe(true);
  });

  test("rejects a negative size", () => {
    const bad = MailAttachmentRefSchema({
      artifactId: "a1",
      name: "a.pdf",
      type: "application/pdf",
      size: -1,
    });
    expect(bad instanceof type.errors).toBe(true);
  });

  test("rejects an empty contentType", () => {
    const bad = MailAttachmentRefSchema({
      artifactId: "a1",
      name: "a.pdf",
      type: "",
      size: 1,
    });
    expect(bad instanceof type.errors).toBe(true);
  });

  test("rejects an empty filename", () => {
    const bad = MailAttachmentRefSchema({
      artifactId: "a1",
      name: "",
      type: "application/pdf",
      size: 1,
    });
    expect(bad instanceof type.errors).toBe(true);
  });
});

describe("saveMailAttachmentRefs integrity", () => {
  test("refuses a non-file kind and writes nothing", async () => {
    const db = await testDb();
    const doc = await seedArtifact(db, { kind: "document", title: "notes.txt" });

    await expect(
      saveMailAttachmentRefs(db, {
        scope: SCOPE,
        instanceId: "inst-1",
        body: {
          mailId: "mail-kind",
          attachments: [
            {
              artifactId: doc.id,
              name: "notes.txt",
              type: "text/plain",
              size: 4,
            },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(MailAttachmentKindError);

    expect(await listMailAttachmentRefs(db, SCOPE, "inst-1")).toEqual([]);
  });

  test("refuses a missing artifact id and writes nothing", async () => {
    const db = await testDb();
    const { ArtifactNotFoundError } = await import("./artifacts.js");

    await expect(
      saveMailAttachmentRefs(db, {
        scope: SCOPE,
        instanceId: "inst-1",
        body: {
          mailId: "mail-missing",
          attachments: [
            {
              artifactId: "00000000-0000-4000-8000-000000000000",
              name: "ghost.pdf",
              type: "application/pdf",
              size: 1,
            },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);

    expect(await listMailAttachmentRefs(db, SCOPE, "inst-1")).toEqual([]);
  });

  test("stores artifact-canonical name/type/size, not client-supplied lies", async () => {
    const db = await testDb();
    const file = await seedArtifact(db, {
      kind: "file",
      title: "canonical.pdf",
      source: {
        origin: "imported",
        upload: {
          id: "u-canon",
          filename: "canonical.pdf",
          mimeType: "application/pdf",
          size: 42,
        },
      },
    });

    await saveMailAttachmentRefs(db, {
      scope: SCOPE,
      instanceId: "inst-1",
      body: {
        mailId: "mail-canon",
        attachments: [
          {
            artifactId: file.id,
            // Deliberately wrong — durable truth must win.
            name: "liar.bin",
            type: "application/octet-stream",
            size: 1,
          },
        ],
      },
    });

    expect(await listMailAttachmentRefs(db, SCOPE, "inst-1")).toEqual([
      {
        mailId: "mail-canon",
        artifactId: file.id,
        name: "canonical.pdf",
        type: "application/pdf",
        size: 42,
      },
    ]);
  });

  test("one non-attachable kind in a batch refuses the whole batch", async () => {
    const db = await testDb();
    const file = await seedArtifact(db, {
      kind: "file",
      title: "a.pdf",
      source: {
        origin: "imported",
        upload: {
          filename: "a.pdf",
          mimeType: "application/pdf",
          size: 12,
        },
      },
    });
    const doc = await seedArtifact(db, { kind: "document", title: "memo" });

    await expect(
      saveMailAttachmentRefs(db, {
        scope: SCOPE,
        instanceId: "inst-1",
        body: {
          mailId: "mail-batch",
          attachments: [
            {
              artifactId: file.id,
              name: "a.pdf",
              type: "application/pdf",
              size: 12,
            },
            {
              artifactId: doc.id,
              name: "memo",
              type: "text/plain",
              size: 4,
            },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(MailAttachmentKindError);

    expect(await listMailAttachmentRefs(db, SCOPE, "inst-1")).toEqual([]);
  });

  test("SaveMailAttachmentRefsSchema rejects a non-integer size at the body edge", () => {
    const bad = SaveMailAttachmentRefsSchema({
      mailId: "mail-1",
      attachments: [
        {
          artifactId: "a1",
          name: "a.pdf",
          type: "application/pdf",
          size: 3.14,
        },
      ],
    });
    expect(bad instanceof type.errors).toBe(true);
  });
});
