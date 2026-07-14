import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConversationAttachmentService,
  type PreparedConversationAttachments,
} from "../conversation-attachment-service.js";
import type { ConversationAttachment } from "../types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ConversationAttachmentService", () => {
  it("normalizes once and returns aligned persisted, metadata, and runtime representations", async () => {
    const harness = await createHarness();
    const prepared = await harness.service.prepareConversation([
      image(" aW1hZ2U= ", " image/png ", " screenshot.png ", "/client/image.png"),
      text("hello text", " notes.txt ", "/client/notes.txt"),
      binary("binary body", " report.pdf ", "/client/report.pdf"),
      { type: "text", mimeType: "text/plain", text: "   " },
      { mimeType: "text/plain", data: "ignored" },
    ]);

    expect(prepared.normalizedAttachments).toEqual([
      image("aW1hZ2U=", "image/png", "screenshot.png"),
      text("hello text", "notes.txt"),
      binary("binary body", "report.pdf"),
    ]);
    expect(prepared.persistedAttachments).toHaveLength(3);
    expect(prepared.attachmentMetadata).toEqual([
      expect.objectContaining({ type: "image", mimeType: "image/png", fileName: "screenshot.png", sizeBytes: 5 }),
      expect.objectContaining({ type: "text", mimeType: "text/plain", fileName: "notes.txt", sizeBytes: 10 }),
      expect.objectContaining({ type: "binary", mimeType: "application/pdf", fileName: "report.pdf", sizeBytes: 11 }),
    ]);
    expect(prepared.attachmentMetadata.map((entry) => entry.fileRef)).toEqual(
      prepared.persistedAttachments.map((entry) => entry.filePath?.split("/").at(-1)),
    );
    expect(prepared.runtimeAttachments).toEqual(
      prepared.normalizedAttachments.map((attachment, index) => ({
        ...attachment,
        filePath: prepared.persistedAttachments[index]?.filePath,
      })),
    );

    await expect(readFile(requiredPath(prepared, 0))).resolves.toEqual(Buffer.from("image"));
    await expect(readFile(requiredPath(prepared, 1), "utf8")).resolves.toBe("hello text");
    await expect(readFile(requiredPath(prepared, 2))).resolves.toEqual(Buffer.from("binary body"));
  });

  it("returns empty aligned representations without creating the uploads directory", async () => {
    const harness = await createHarness();

    await expect(harness.service.prepareConversation(undefined)).resolves.toEqual({
      normalizedAttachments: [],
      persistedAttachments: [],
      attachmentMetadata: [],
      runtimeAttachments: [],
    });
    await expect(readdir(harness.uploadsDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves mixed attachment ordering in images, file blocks, and persisted path notices", async () => {
    const harness = await createHarness();
    const prepared = await harness.service.prepareConversation([
      image("first image", "image/png", "first.png"),
      text("alpha", "alpha.txt"),
      binary("payload", "payload.bin"),
      image("second image", "image/jpeg", "second.jpg"),
    ]);

    const runtime = await harness.service.prepareRuntime("Manager One", prepared.runtimeAttachments);

    expect(runtime.images).toEqual([
      { mimeType: "image/png", data: Buffer.from("first image").toString("base64") },
      { mimeType: "image/jpeg", data: Buffer.from("second image").toString("base64") },
    ]);
    expect(runtime.attachmentMessage).toBe([
      "The user attached the following files:",
      "",
      "[Attachment 2]",
      "Name: alpha.txt",
      "MIME type: text/plain",
      "Content:",
      "----- BEGIN FILE -----",
      "alpha",
      "----- END FILE -----",
      "[Attachment 3]",
      "Name: payload.bin",
      "MIME type: application/octet-stream",
      `Saved to: ${requiredPath(prepared, 2)}`,
      "Use read/bash tools to inspect the file directly from disk.",
      "",
      ...prepared.runtimeAttachments.map((attachment) => `[Attached file saved to: ${attachment.filePath}]`),
    ].join("\n"));
  });

  it("writes unpersisted binaries once into one sanitized agent batch in attachment order", async () => {
    const harness = await createHarness();
    const attachments = [
      binary("first", " ../first\\file.bin "),
      binary("second", undefined),
    ];

    const runtime = await harness.service.prepareRuntime(" Manager / One ", attachments);
    const managerDir = join(harness.dataDir, "attachments", "manager-one");
    const batches = await readdir(managerDir);
    expect(batches).toHaveLength(1);
    const batchDir = join(managerDir, batches[0]!);
    expect(await readdir(batchDir)).toEqual([
      "01--first-file.bin",
      "02-attachment-2.bin",
    ]);
    await expect(readFile(join(batchDir, "01--first-file.bin"), "utf8")).resolves.toBe("first");
    await expect(readFile(join(batchDir, "02-attachment-2.bin"), "utf8")).resolves.toBe("second");
    expect(runtime.attachmentMessage).toContain(`Saved to: ${join(batchDir, "01--first-file.bin")}`);
    expect(runtime.attachmentMessage).toContain(`Saved to: ${join(batchDir, "02-attachment-2.bin")}`);
    expect(runtime.attachmentMessage).not.toContain("[Attached file saved to:");
  });

  it("uses an existing trimmed binary path without creating a runtime artifact", async () => {
    const harness = await createHarness();
    const existingPath = join(harness.root, "already-persisted.bin");
    await writeFile(existingPath, "already there");

    const runtime = await harness.service.prepareRuntime("manager", [{
      ...binary("not rewritten", "saved.bin"),
      filePath: `  ${existingPath}  `,
    }]);

    expect(runtime.attachmentMessage).toContain(`Saved to: ${existingPath}`);
    expect(runtime.attachmentMessage).toContain(`[Attached file saved to: ${existingPath}]`);
    await expect(readdir(join(harness.dataDir, "attachments"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(existingPath, "utf8")).resolves.toBe("already there");
  });

  it("keeps image-only runtime content message-free unless a persisted path is present", async () => {
    const harness = await createHarness();
    const attachment = image("image body", "image/png", "screen.png");

    await expect(harness.service.prepareRuntime("manager", [attachment])).resolves.toEqual({
      images: [{ mimeType: "image/png", data: attachment.data }],
      attachmentMessage: "",
    });

    const filePath = join(harness.uploadsDir, "screen.png");
    await expect(harness.service.prepareRuntime("manager", [{ ...attachment, filePath }])).resolves.toEqual({
      images: [{ mimeType: "image/png", data: attachment.data }],
      attachmentMessage: `[Attached file saved to: ${filePath}]`,
    });
  });

  it("propagates persistence and runtime directory errors before returning partial results", async () => {
    const harness = await createHarness();
    await mkdir(dirname(harness.uploadsDir), { recursive: true });
    await writeFile(harness.uploadsDir, "not a directory");

    await expect(harness.service.prepareConversation([text("blocked")])).rejects.toThrow();

    const second = await createHarness();
    await mkdir(second.dataDir, { recursive: true });
    await writeFile(join(second.dataDir, "attachments"), "not a directory");
    await expect(second.service.prepareRuntime("manager", [binary("blocked")])).rejects.toThrow();
  });
});

async function createHarness(): Promise<{
  root: string;
  dataDir: string;
  uploadsDir: string;
  service: ConversationAttachmentService;
}> {
  const root = await mkdtemp(join(tmpdir(), "forge-attachment-service-"));
  tempRoots.push(root);
  const dataDir = join(root, "data");
  const uploadsDir = join(root, "uploads");
  return {
    root,
    dataDir,
    uploadsDir,
    service: new ConversationAttachmentService({ dataDir, uploadsDir }),
  };
}

function image(
  value: string,
  mimeType = "image/png",
  fileName?: string,
  filePath?: string,
): ConversationAttachment {
  return {
    mimeType,
    data: value.trim().endsWith("=") ? value : Buffer.from(value).toString("base64"),
    fileName,
    filePath,
  };
}

function text(value: string, fileName?: string, filePath?: string): ConversationAttachment {
  return { type: "text", mimeType: "text/plain", text: value, fileName, filePath };
}

function binary(value: string, fileName?: string, filePath?: string): ConversationAttachment {
  return {
    type: "binary",
    mimeType: fileName?.trim().endsWith(".pdf") ? "application/pdf" : "application/octet-stream",
    data: Buffer.from(value).toString("base64"),
    fileName,
    filePath,
  };
}

function requiredPath(prepared: PreparedConversationAttachments, index: number): string {
  const filePath = prepared.persistedAttachments[index]?.filePath;
  if (!filePath) {
    throw new Error(`Missing persisted attachment path at index ${index}`);
  }
  return filePath;
}
