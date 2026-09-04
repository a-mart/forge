import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, open, rename, symlink, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ChatArtifactError,
  MAX_PRESENTED_CHAT_ARTIFACT_IMAGE_BYTES,
  MAX_PRESENTED_CHAT_ARTIFACT_PDF_BYTES,
  MAX_PRESENTED_CHAT_ARTIFACT_TEXT_BYTES,
  PresentedChatArtifactTicketStore,
  chatArtifactStatus,
  canonicalizeChatArtifactPath,
  canonicalizeChatArtifactPathForPlatform,
  canonicalizePresentedLinkHref,
  canonicalizePresentedLinkHrefForPlatform,
  extractPresentedArtifactPaths,
  extractPresentedArtifactPathsForPlatform,
  findUniquePresentedConversationMessage,
  readPresentedChatArtifact,
  resolveCanonicalPresentedArtifactTarget,
  securelyReadPresentedArtifact,
  stableFileIdentity,
} from "../swarm/session/presented-chat-artifact.js";
import { getSessionFilePath, getWorkerSessionFilePath } from "../swarm/storage/data-paths.js";
import { CONVERSATION_ENTRY_TYPE } from "../swarm/session/conversation-timeline.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })))); });
async function fixture() {
  const tempRoot = process.platform === "darwin" ? `/private${tmpdir()}` : tmpdir();
  const dataDir = await mkdtemp(join(tempRoot, "forge-chat-artifact-")); roots.push(dataDir);
  const agentId = "manager"; const profileId = "profile"; const sessionFile = getSessionFilePath(dataDir, profileId, agentId);
  await mkdir(join(dataDir, "profiles", profileId, "sessions", agentId), { recursive: true });
  const manager: any = { agentId, managerId: agentId, role: "manager", profileId, sessionFile, cwd: dataDir };
  const profiles = [{ profileId }];
  const source: any = { getAgent: (id: string) => id === agentId ? manager : undefined, listProfiles: () => profiles, getConfig: () => ({ paths: { dataDir } }) };
  return { dataDir, agentId, profileId, sessionFile, manager, profiles, source };
}
function line(data: any, id = data.id) { return JSON.stringify({ type: "custom", customType: CONVERSATION_ENTRY_TYPE, id, data }) + "\n"; }
function message(id: string | undefined, text: string, source = "speak_to_user", role = "assistant") { return { type: "conversation_message", id, agentId: "some-other-actor", role, source, text, timestamp: new Date().toISOString() }; }
async function errorCode(fn: () => Promise<unknown>) { try { await fn(); } catch (error) { expect(error).toBeInstanceOf(ChatArtifactError); return (error as ChatArtifactError).code; } throw new Error("expected failure"); }
async function writeSizedFile(target: string, totalBytes: number, prefix = Buffer.from("%PDF-1.4\n")) {
  const handle = await open(target, "w");
  try {
    const head = prefix.subarray(0, Math.min(prefix.length, totalBytes));
    if (head.length) await handle.write(head, 0, head.length, 0);
    await handle.truncate(totalBytes);
  } finally {
    await handle.close();
  }
}

describe("presented chat artifact authorization", () => {
  it("uses the wrapper ID without mutating canonical JSONL", async () => {
    const f = await fixture(); const outside = join(f.dataDir, "outside.txt"); await writeFile(outside, "ok");
    await writeFile(f.sessionFile, line(message(undefined, `[x](swarm-file://${outside})`), "wrapper-id"));
    const before = await stat(f.sessionFile); const bytes = await import("node:fs/promises").then(({ readFile }) => readFile(f.sessionFile));
    const result: any = await readPresentedChatArtifact(f.source, { transcriptAgentId: f.agentId, messageId: "wrapper-id", path: outside });
    expect(result.content).toBe("ok"); expect(await import("node:fs/promises").then(({ readFile }) => readFile(f.sessionFile))).toEqual(bytes); expect((await stat(f.sessionFile)).mtimeMs).toBe(before.mtimeMs);
  });

  it("requires a unique ID and rejects corrupt JSONL", async () => {
    const f = await fixture(); const target = join(f.dataDir, "a.txt"); await writeFile(target, "a");
    await writeFile(f.sessionFile, line(message("same", `[x](swarm-file://${target})`)) + line(message("same", `[x](swarm-file://${target})`)));
    expect(await errorCode(() => readPresentedChatArtifact(f.source, { transcriptAgentId: f.agentId, messageId: "same", path: target }))).toBe("ambiguous_message_id");
    await writeFile(f.sessionFile, "not json\n");
    expect(await errorCode(() => findUniquePresentedConversationMessage(f.sessionFile, "same"))).toBe("corrupt_transcript");
  });

  it("enforces the exact eligible assistant source matrix", async () => {
    const f = await fixture(); const target = join(f.dataDir, "a.txt"); await writeFile(target, "a");
    await writeFile(f.sessionFile, line(message("m", `[x](swarm-file://${target})`, "worker_report", "assistant")));
    expect(await errorCode(() => readPresentedChatArtifact(f.source, { transcriptAgentId: f.agentId, messageId: "m", path: target }))).toBe("corrupt_transcript");
    for (const [role, source, expected] of [["user", "user_input", "ineligible_message"], ["system", "system", "ineligible_message"], ["assistant", "user_input", "corrupt_transcript"]]) {
      await writeFile(f.sessionFile, line(message("m", `[x](swarm-file://${target})`, source, role)));
      expect(await errorCode(() => readPresentedChatArtifact(f.source, { transcriptAgentId: f.agentId, messageId: "m", path: target }))).toBe(expected);
    }
    await writeFile(f.sessionFile, line(message("m", `[x](swarm-file://${target})`, "assistant_progress")));
    expect((await readPresentedChatArtifact(f.source, { transcriptAgentId: f.agentId, messageId: "m", path: target }) as any).content).toBe("a");
  });

  it("streams Unicode safely across a read boundary and rejects malformed conversation candidates", async () => {
    const f = await fixture();
    const padding = JSON.stringify({ type: "custom", customType: "other", data: "x".repeat(65_500) }) + "\n";
    await writeFile(f.sessionFile, padding + line(message("unicode", "😀")));
    expect((await findUniquePresentedConversationMessage(f.sessionFile, "unicode") as any).text).toBe("😀");
    await writeFile(f.sessionFile, line({ type: "conversation_message", id: "bad", text: 5 }));
    expect(await errorCode(() => findUniquePresentedConversationMessage(f.sessionFile, "bad"))).toBe("corrupt_transcript");
  });

  it("only accepts presented link tokens and exact canonical paths", async () => {
    const f = await fixture(); const target = join(f.dataDir, "my file?.txt"); await writeFile(target, "a");
    await writeFile(f.sessionFile, line(message("m", `[x](<swarm-file://${target.replace("?", "%3F")}> "t") and \`${target}\` and ![x](${target})`)));
    expect((await readPresentedChatArtifact(f.source, { transcriptAgentId: f.agentId, messageId: "m", path: target }) as any).content).toBe("a");
    expect(await errorCode(() => readPresentedChatArtifact(f.source, { transcriptAgentId: f.agentId, messageId: "m", path: `${target}x` }))).toBe("path_not_presented");
    await writeFile(f.sessionFile, line(message("escaped", `\\[artifact:${target}]`)));
    expect(await errorCode(() => readPresentedChatArtifact(f.source, { transcriptAgentId: f.agentId, messageId: "escaped", path: target }))).toBe("path_not_presented");
    expect(extractPresentedArtifactPaths(`[x](file://${target})`)).toEqual([]);
    expect(canonicalizePresentedLinkHref("swarm-file:///tmp/a%252Fz")).toBe(canonicalizeChatArtifactPath("/tmp/a%2Fz"));
    expect(canonicalizePresentedLinkHref("swarm-file:///tmp/%")).toBeUndefined();
    expect(() => canonicalizeChatArtifactPath("//host/share")).toThrow(ChatArtifactError);
  });

  it("matches links and artifact shortcodes without authorizing code, images, or malformed destinations", () => {
    const canonical = (value: string) => canonicalizeChatArtifactPath(value);
    expect(extractPresentedArtifactPaths("[x](/tmp/a(b).txt) [r][ref]\n\n[ref]: /tmp/reference.txt")).toEqual([canonical("/tmp/a(b).txt"), canonical("/tmp/reference.txt")]);
    expect(extractPresentedArtifactPaths("[artifact:/tmp/shortcode.png]")).toEqual([canonical("/tmp/shortcode.png")]);
    expect(extractPresentedArtifactPaths("\\[artifact:/tmp/escaped.png] plain /tmp/raw.png")).toEqual([]);
    expect(extractPresentedArtifactPaths("```\n[artifact:/tmp/fenced]\n[x](/tmp/fenced-link)\n```\n~~~\n[artifact:/tmp/tilde]\n~~~\n    [artifact:/tmp/indented]\n`[artifact:/tmp/inline]`\n![x](/tmp/image)")).toEqual([]);
    expect(extractPresentedArtifactPaths("<swarm-file:///tmp/autolink> [x](file:///tmp/rejected)")).toEqual([canonical("/tmp/autolink")]);
  });

  it("fails closed when stable file identity is unavailable", () => {
    expect(() => stableFileIdentity({ dev: 0, ino: 1, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false })).toThrow(ChatArtifactError);
    expect(() => stableFileIdentity({ dev: 1, ino: 0, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false })).toThrow(ChatArtifactError);
  });

  it("normalizes only Darwin's trusted /tmp alias before authorization", () => {
    expect(canonicalizeChatArtifactPathForPlatform("/tmp/result.png", "darwin")).toBe("/private/tmp/result.png");
    expect(canonicalizeChatArtifactPathForPlatform("/private/tmp/result.png", "darwin")).toBe("/private/tmp/result.png");
    expect(canonicalizePresentedLinkHrefForPlatform("swarm-file:///tmp/result.png", "darwin")).toBe("/private/tmp/result.png");
    expect(canonicalizePresentedLinkHrefForPlatform("swarm-file:///private/tmp/result.png", "darwin")).toBe("/private/tmp/result.png");
    expect(canonicalizeChatArtifactPathForPlatform("/tmp-result/result.png", "darwin")).toBe("/tmp-result/result.png");
    expect(canonicalizeChatArtifactPathForPlatform("/tmp/result.png", "linux")).toBe("/tmp/result.png");
  });

  it("uses a larger bounded preview budget only for image MIME types", async () => {
    if (process.platform === "win32") return;
    const f = await fixture();
    const png = join(f.dataDir, "preview.png");
    await writeFile(png, Buffer.alloc(MAX_PRESENTED_CHAT_ARTIFACT_IMAGE_BYTES - 1, 0x89));

    const result: any = await securelyReadPresentedArtifact(png);
    expect(result).toMatchObject({
      path: png,
      binary: true,
      encoding: "base64",
      contentType: "image/png",
    });
    expect(Buffer.from(result.content, "base64")).toHaveLength(MAX_PRESENTED_CHAT_ARTIFACT_IMAGE_BYTES - 1);

    await writeFile(png, Buffer.alloc(MAX_PRESENTED_CHAT_ARTIFACT_IMAGE_BYTES + 1));
    expect(await errorCode(() => securelyReadPresentedArtifact(png))).toBe("file_too_large");

    const text = join(f.dataDir, "preview.txt");
    await writeFile(text, Buffer.alloc(MAX_PRESENTED_CHAT_ARTIFACT_TEXT_BYTES - 1, 0x61));
    expect((await securelyReadPresentedArtifact(text)).content).toHaveLength(MAX_PRESENTED_CHAT_ARTIFACT_TEXT_BYTES - 1);
    await writeFile(text, Buffer.alloc(MAX_PRESENTED_CHAT_ARTIFACT_TEXT_BYTES + 1, 0x61));
    expect(await errorCode(() => securelyReadPresentedArtifact(text))).toBe("file_too_large");

    const pdf = join(f.dataDir, "preview.pdf");
    const pdfHeader = Buffer.from("%PDF-1.4\n");
    await writeFile(pdf, Buffer.concat([pdfHeader, Buffer.alloc(MAX_PRESENTED_CHAT_ARTIFACT_TEXT_BYTES - pdfHeader.length, 0x61)]));
    expect(await securelyReadPresentedArtifact(pdf)).toMatchObject({
      path: pdf,
      binary: true,
      encoding: "base64",
      contentType: "application/pdf",
    });
    await writeFile(pdf, Buffer.alloc(MAX_PRESENTED_CHAT_ARTIFACT_TEXT_BYTES + 1, 0x25));
    expect(await errorCode(() => securelyReadPresentedArtifact(pdf))).toBe("file_too_large");
  });

  it("issues one-use PDF tickets at the larger in-panel budget without widening JSON/base64 reads", async () => {
    if (process.platform === "win32") return;
    const f = await fixture();
    const pdf = join(f.dataDir, "ticket.pdf");
    const pdfHeader = Buffer.from("%PDF-1.4\n");
    const inPanelBytes = MAX_PRESENTED_CHAT_ARTIFACT_TEXT_BYTES + 1;
    await writeSizedFile(pdf, inPanelBytes, pdfHeader);
    await writeFile(f.sessionFile, line(message("pdf-ticket", `[pdf](swarm-file://${pdf})`)));
    let sequence = 0;
    const store = new PresentedChatArtifactTicketStore({
      createToken: () => `pdf_ticket_token_${String(sequence++).padStart(4, "0")}`,
    });
    const issueTicket = () => readPresentedChatArtifact(f.source, {
      transcriptAgentId: f.agentId,
      messageId: "pdf-ticket",
      path: pdf,
      imageTransport: "http_ticket",
    }, { ticketStore: store });

    expect(MAX_PRESENTED_CHAT_ARTIFACT_PDF_BYTES).toBe(16 * 1024 * 1024);
    expect(MAX_PRESENTED_CHAT_ARTIFACT_PDF_BYTES).toBeGreaterThan(MAX_PRESENTED_CHAT_ARTIFACT_TEXT_BYTES);
    expect(await errorCode(() => securelyReadPresentedArtifact(pdf))).toBe("file_too_large");
    const issued: any = await issueTicket();
    expect(issued).toMatchObject({
      binary: true,
      transport: "http_ticket",
      contentType: "application/pdf",
      totalBytes: inPanelBytes,
    });
    expect(issued).not.toHaveProperty("content");
    const token = issued.ticket.url.split("/").at(-1)!;
    const redeemed = await store.redeem(token);
    expect(redeemed.contentType).toBe("application/pdf");
    expect(redeemed.totalBytes).toBe(inPanelBytes);
    expect(redeemed.content.subarray(0, pdfHeader.length)).toEqual(pdfHeader);
    expect(redeemed.content).toHaveLength(inPanelBytes);
    expect(await errorCode(() => store.redeem(token))).toBe("ticket_not_found");

    await writeSizedFile(pdf, MAX_PRESENTED_CHAT_ARTIFACT_PDF_BYTES + 1);
    expect(await errorCode(() => issueTicket())).toBe("file_too_large");
  });

  it("returns a UTF-8-safe bounded prefix with stable total-byte metadata", async () => {
    const f = await fixture();
    const target = join(f.dataDir, "large.txt");
    const prefix = Buffer.from("abcd😀tail", "utf8");
    const largeTotalBytes = 5 * 1024 * 1024;
    await writeFile(target, Buffer.concat([prefix, Buffer.alloc(largeTotalBytes - prefix.length, 0x61)]));
    await writeFile(f.sessionFile, line(message("bounded", `[x](swarm-file://${target})`)));

    const result: any = await readPresentedChatArtifact(f.source, {
      transcriptAgentId: f.agentId,
      messageId: "bounded",
      path: target,
      previewBytes: 6,
    });
    expect(result).toMatchObject({ content: "abcd", truncated: true, totalBytes: largeTotalBytes });
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(6);
    expect(result.content).not.toContain("�");
    let observedReadBytes = 0;
    await securelyReadPresentedArtifact(target, { previewBytes: 6, onRead: bytes => { observedReadBytes += bytes; } });
    expect(observedReadBytes).toBe(6);
    expect(await errorCode(() => securelyReadPresentedArtifact(target))).toBe("file_too_large");

    await writeFile(target, Buffer.alloc(MAX_PRESENTED_CHAT_ARTIFACT_TEXT_BYTES, 0x61));
    await expect(securelyReadPresentedArtifact(target)).resolves.toMatchObject({ contentType: "application/octet-stream" });
    await writeFile(target, Buffer.alloc(MAX_PRESENTED_CHAT_ARTIFACT_TEXT_BYTES + 1, 0x61));
    expect(await errorCode(() => securelyReadPresentedArtifact(target))).toBe("file_too_large");
    await expect(securelyReadPresentedArtifact(target, { previewBytes: 6 })).resolves.toMatchObject({ truncated: true, totalBytes: MAX_PRESENTED_CHAT_ARTIFACT_TEXT_BYTES + 1 });
    expect(await errorCode(() => securelyReadPresentedArtifact(target, { previewBytes: 0 }))).toBe("invalid_request");
  });

  it("issues bounded one-use image capabilities and denies expiry, binding mismatch, and identity races", async () => {
    if (process.platform === "win32") return;
    const f = await fixture();
    const image = join(f.dataDir, "ticket.png");
    await writeFile(image, Buffer.alloc(MAX_PRESENTED_CHAT_ARTIFACT_IMAGE_BYTES, 0x89));
    await writeFile(f.sessionFile, line(message("ticket", `[image](swarm-file://${image})`)));
    let now = 1_000;
    let sequence = 0;
    const store = new PresentedChatArtifactTicketStore({
      now: () => now,
      ttlMs: 100,
      createToken: () => `ticket_token_${String(sequence++).padStart(4, "0")}`,
    });
    const issue = async (binding = "user-a") => readPresentedChatArtifact(f.source, {
      transcriptAgentId: f.agentId,
      messageId: "ticket",
      path: image,
      imageTransport: "http_ticket",
    }, { ticketStore: store, ticketAuthBinding: binding }) as Promise<any>;

    const first = await issue();
    expect(first).toMatchObject({
      binary: true,
      transport: "http_ticket",
      contentType: "image/png",
      totalBytes: MAX_PRESENTED_CHAT_ARTIFACT_IMAGE_BYTES,
    });
    expect(first).not.toHaveProperty("content");
    const firstToken = first.ticket.url.split("/").at(-1)!;
    await expect(store.redeem(firstToken, "user-a")).resolves.toMatchObject({ totalBytes: MAX_PRESENTED_CHAT_ARTIFACT_IMAGE_BYTES });
    expect(await errorCode(() => store.redeem(firstToken, "user-a"))).toBe("ticket_not_found");

    const wrongBinding = await issue();
    const wrongBindingToken = wrongBinding.ticket.url.split("/").at(-1)!;
    expect(await errorCode(() => store.redeem(wrongBindingToken, "user-b"))).toBe("ticket_not_found");
    await expect(store.redeem(wrongBindingToken, "user-a")).resolves.toMatchObject({ totalBytes: MAX_PRESENTED_CHAT_ARTIFACT_IMAGE_BYTES });

    const concurrent = await issue();
    const concurrentToken = concurrent.ticket.url.split("/").at(-1)!;
    const concurrentResults = await Promise.allSettled([
      store.redeem(concurrentToken, "user-a"),
      store.redeem(concurrentToken, "user-a"),
    ]);
    expect(concurrentResults.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const concurrentFailure = concurrentResults.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(concurrentFailure.reason).toMatchObject({ code: "ticket_not_found" });

    const expired = await issue(); now += 101;
    expect(await errorCode(() => store.redeem(expired.ticket.url.split("/").at(-1)!, "user-a"))).toBe("ticket_expired");

    now = 2_000;
    const raced = await issue();
    const replacement = join(f.dataDir, "replacement.png"); await writeFile(replacement, Buffer.alloc(8, 0x42)); await rename(replacement, image);
    expect(await errorCode(() => store.redeem(raced.ticket.url.split("/").at(-1)!, "user-a"))).toBe("file_identity_changed");

    await writeFile(image, Buffer.alloc(MAX_PRESENTED_CHAT_ARTIFACT_IMAGE_BYTES + 1, 0x89));
    expect(await errorCode(() => issue())).toBe("file_too_large");
  });

  it("keeps another Collaboration principal's ticket through a deterministic 257-ticket flood", async () => {
    const f = await fixture();
    const image = join(f.dataDir, "fair-cap.png"); await writeFile(image, Buffer.from([137, 80, 78, 71]));
    let sequence = 0;
    const store = new PresentedChatArtifactTicketStore({
      createToken: () => `fair_cap_token_${String(sequence++).padStart(4, "0")}`,
    });
    const token = (issued: Awaited<ReturnType<typeof store.issue>>) => issued.ticket.url.split("/").at(-1)!;

    const ownerToken = token(await store.issue(image, "owner"));
    const flooderTokens: string[] = [];
    for (let index = 0; index < 256; index++) flooderTokens.push(token(await store.issue(image, "flooder")));

    expect(await errorCode(() => store.redeem(flooderTokens[0]!, "flooder"))).toBe("ticket_not_found");
    await expect(store.redeem(ownerToken, "owner")).resolves.toMatchObject({ contentType: "image/png", totalBytes: 4 });
    await expect(store.redeem(flooderTokens.at(-1)!, "flooder")).resolves.toMatchObject({ totalBytes: 4 });
  });

  it("bounds each Collaboration principal by evicting only that principal's oldest ticket", async () => {
    const f = await fixture();
    const image = join(f.dataDir, "principal-cap.png"); await writeFile(image, Buffer.from([137, 80, 78, 71]));
    let sequence = 0;
    const store = new PresentedChatArtifactTicketStore({
      maxTickets: 5,
      maxTicketsPerAuthBinding: 2,
      createToken: () => `principal_cap_${String(sequence++).padStart(4, "0")}`,
    });
    const token = (issued: Awaited<ReturnType<typeof store.issue>>) => issued.ticket.url.split("/").at(-1)!;

    const first = token(await store.issue(image, "user-a"));
    const second = token(await store.issue(image, "user-a"));
    const third = token(await store.issue(image, "user-a"));

    expect(await errorCode(() => store.redeem(first, "user-a"))).toBe("ticket_not_found");
    await expect(store.redeem(second, "user-a")).resolves.toMatchObject({ totalBytes: 4 });
    await expect(store.redeem(third, "user-a")).resolves.toMatchObject({ totalBytes: 4 });
  });

  it("applies a separate bounded FIFO policy to local Builder tickets", async () => {
    const f = await fixture();
    const image = join(f.dataDir, "local-cap.png"); await writeFile(image, Buffer.from([137, 80, 78, 71]));
    let sequence = 0;
    const store = new PresentedChatArtifactTicketStore({
      maxTickets: 5,
      maxLocalTickets: 2,
      createToken: () => `local_cap_token_${String(sequence++).padStart(4, "0")}`,
    });
    const token = (issued: Awaited<ReturnType<typeof store.issue>>) => issued.ticket.url.split("/").at(-1)!;

    const first = token(await store.issue(image));
    const second = token(await store.issue(image));
    const third = token(await store.issue(image));

    expect(await errorCode(() => store.redeem(first))).toBe("ticket_not_found");
    await expect(store.redeem(second)).resolves.toMatchObject({ totalBytes: 4 });
    await expect(store.redeem(third)).resolves.toMatchObject({ totalBytes: 4 });
  });

  it("purges expired tickets before applying capacity", async () => {
    const f = await fixture();
    const image = join(f.dataDir, "expiry-cap.png"); await writeFile(image, Buffer.from([137, 80, 78, 71]));
    let now = 1_000; let sequence = 0;
    const store = new PresentedChatArtifactTicketStore({
      now: () => now,
      ttlMs: 10,
      maxTickets: 2,
      maxTicketsPerAuthBinding: 2,
      createToken: () => `expiry_cap_token_${String(sequence++).padStart(4, "0")}`,
    });
    const token = (issued: Awaited<ReturnType<typeof store.issue>>) => issued.ticket.url.split("/").at(-1)!;

    const expiredA = token(await store.issue(image, "user-a"));
    const expiredB = token(await store.issue(image, "user-b"));
    now += 11;
    const current = token(await store.issue(image, "user-c"));

    expect(await errorCode(() => store.redeem(expiredA, "user-a"))).toBe("ticket_not_found");
    expect(await errorCode(() => store.redeem(expiredB, "user-b"))).toBe("ticket_not_found");
    await expect(store.redeem(current, "user-c")).resolves.toMatchObject({ totalBytes: 4 });
  });

  it("returns a typed capacity denial when the overall hard cap has no issuer-owned slot", async () => {
    const f = await fixture();
    const image = join(f.dataDir, "overall-cap.png"); await writeFile(image, Buffer.from([137, 80, 78, 71]));
    let sequence = 0;
    const store = new PresentedChatArtifactTicketStore({
      maxTickets: 2,
      maxTicketsPerAuthBinding: 2,
      createToken: () => `overall_cap_token_${String(sequence++).padStart(4, "0")}`,
    });
    const token = (issued: Awaited<ReturnType<typeof store.issue>>) => issued.ticket.url.split("/").at(-1)!;

    const userA = token(await store.issue(image, "user-a"));
    const userB = token(await store.issue(image, "user-b"));
    expect(await errorCode(() => store.issue(image, "user-c"))).toBe("ticket_capacity_exceeded");
    expect(chatArtifactStatus("ticket_capacity_exceeded")).toBe(429);
    await expect(store.redeem(userA, "user-a")).resolves.toMatchObject({ totalBytes: 4 });
    await expect(store.redeem(userB, "user-b")).resolves.toMatchObject({ totalBytes: 4 });
  });

  it("reads a literal Darwin /tmp claim through its canonical /private/tmp target", async () => {
    if (process.platform !== "darwin") return;
    const f = await fixture();
    const targetRoot = await mkdtemp("/private/tmp/forge-chat-artifact-alias-");
    roots.push(targetRoot);
    const canonicalTarget = join(targetRoot, "literal-tmp.png");
    const presentedTarget = canonicalTarget.replace(/^\/private\/tmp\//, "/tmp/");
    await writeFile(canonicalTarget, Buffer.from([137, 80, 78, 71]));
    await writeFile(f.sessionFile, line(message("tmp-image", `[artifact:${presentedTarget}]`)));
    f.manager.cwd = targetRoot;

    const result: any = await readPresentedChatArtifact(f.source, {
      transcriptAgentId: f.agentId,
      messageId: "tmp-image",
      path: presentedTarget,
    });
    expect(result).toMatchObject({ path: presentedTarget, binary: true, contentType: "image/png" });
    expect(await readPresentedChatArtifact(f.source, {
      transcriptAgentId: f.agentId,
      messageId: "tmp-image",
      path: canonicalTarget,
    })).toMatchObject({ path: canonicalTarget, binary: true, contentType: "image/png" });
  });

  it("has platform-independent Windows URI and path canonicalization", () => {
    expect(canonicalizeChatArtifactPathForPlatform("c:\\tmp\\..\\Report.txt", "win32")).toBe("C:/Report.txt");
    expect(canonicalizeChatArtifactPathForPlatform("/T:/repos/project/report.md", "win32")).toBe("T:/repos/project/report.md");
    expect(canonicalizePresentedLinkHrefForPlatform("swarm-file:///c:/tmp/a%252Fz", "win32")).toBe("C:/tmp/a%2Fz");
    expect(canonicalizePresentedLinkHrefForPlatform("C:%5Ctmp%5Ca", "win32")).toBe("C:/tmp/a");
    expect(canonicalizePresentedLinkHrefForPlatform("/T:/repos/project/report.md", "win32")).toBe("T:/repos/project/report.md");
    expect(extractPresentedArtifactPathsForPlatform("[report](/T:/repos/project/report.md)", "win32")).toEqual(["T:/repos/project/report.md"]);
    expect(() => canonicalizeChatArtifactPathForPlatform("//T:/repos/project/report.md", "win32")).toThrow(ChatArtifactError);
    expect(() => canonicalizeChatArtifactPathForPlatform("//server/share", "win32")).toThrow(ChatArtifactError);
    expect(() => canonicalizeChatArtifactPathForPlatform("C:/tmp/a:stream", "win32")).toThrow(ChatArtifactError);
  });

  it("uses the validated transcript descriptor when the live descriptor is replaced during reading", async () => {
    const f = await fixture();
    const target = join(f.dataDir, "snapshot.txt"); await writeFile(target, "snapshot");
    await writeFile(f.sessionFile, line(message("snapshot", `[x](swarm-file://${target})`)));
    const replacementRoot = await mkdtemp(join(tmpdir(), "forge-artifact-replacement-")); roots.push(replacementRoot);
    const replacement = { ...f.manager, cwd: replacementRoot };

    await expect(readPresentedChatArtifact(f.source, {
      transcriptAgentId: f.agentId,
      messageId: "snapshot",
      path: target,
    }, {
      transcriptRead: { afterOpen: () => { f.source.getAgent = (id: string) => id === f.agentId ? replacement : undefined; } },
    })).resolves.toMatchObject({ content: "snapshot", path: target });
  });

  it("reads presented absolute paths outside the transcript and project workspaces", async () => {
    if (process.platform === "win32") return;
    const f = await fixture();
    const outsideRoot = await mkdtemp(join(tmpdir(), "forge-artifact-external-")); roots.push(outsideRoot);
    const outsideTarget = join(outsideRoot, "external report.txt"); await writeFile(outsideTarget, "external");
    const outsideAlias = join(f.dataDir, "external-alias.txt"); await symlink(outsideTarget, outsideAlias);
    await writeFile(f.sessionFile, line(message("external-paths", [outsideTarget, outsideAlias]
      .map(candidate => `[artifact:${candidate}]`).join(" "))));

    await expect(readPresentedChatArtifact(f.source, {
      transcriptAgentId: f.agentId,
      messageId: "external-paths",
      path: outsideTarget,
    })).resolves.toMatchObject({ content: "external", path: outsideTarget });
    await expect(readPresentedChatArtifact(f.source, {
      transcriptAgentId: f.agentId,
      messageId: "external-paths",
      path: outsideAlias,
    })).resolves.toMatchObject({ content: "external", path: outsideAlias });
    expect(await errorCode(() => readPresentedChatArtifact(f.source, {
      transcriptAgentId: f.agentId,
      messageId: "external-paths",
      path: outsideTarget,
      worktreeId: "caller-selected",
    } as any))).toBe("invalid_request");
  });

  it("canonicalizes Windows drive aliases without workspace containment", async () => {
    const aliases = new Map<string, string>([
      ["T:/aliases/project/report.md", "C:/physical/project/report.md"],
      ["T:/aliases/project-feature/result.md", "C:/physical/project-feature/result.md"],
      ["T:/aliases/unrelated/report.md", "C:/outside/report.md"],
    ]);
    const hooks = {
      platform: "win32" as const,
      realpath: async (value: string) => {
        const resolved = aliases.get(value);
        if (resolved) return resolved;
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    };

    await expect(resolveCanonicalPresentedArtifactTarget("T:/aliases/project/report.md", hooks))
      .resolves.toBe("C:/physical/project/report.md");
    await expect(resolveCanonicalPresentedArtifactTarget("T:/aliases/project-feature/result.md", hooks))
      .resolves.toBe("C:/physical/project-feature/result.md");
    await expect(resolveCanonicalPresentedArtifactTarget("T:/aliases/unrelated/report.md", hooks))
      .resolves.toBe("C:/outside/report.md");
    expect(await errorCode(() => resolveCanonicalPresentedArtifactTarget("T:/aliases/missing.md", hooks))).toBe("file_not_found");
  });

  it("rejects collaboration, archived, orphan and noncanonical worker descriptors", async () => {
    const f = await fixture(); const target = join(f.dataDir, "a"); await writeFile(target, "a"); await writeFile(f.sessionFile, line(message("m", `[x](swarm-file://${target})`)));
    f.profiles.splice(0); expect(await errorCode(() => readPresentedChatArtifact(f.source, { transcriptAgentId: f.agentId, messageId: "m", path: target }))).toBe("invalid_transcript_owner"); f.profiles.push({ profileId: f.profileId });
    f.manager.collab = { channelId: "c" }; expect(await errorCode(() => readPresentedChatArtifact(f.source, { transcriptAgentId: f.agentId, messageId: "m", path: target }))).toBe("invalid_transcript_owner"); delete f.manager.collab;
    f.manager.archivedAt = "now"; expect(await errorCode(() => readPresentedChatArtifact(f.source, { transcriptAgentId: f.agentId, messageId: "m", path: target }))).toBe("invalid_transcript_owner"); delete f.manager.archivedAt;
    const worker: any = { agentId: "worker", managerId: "missing", role: "worker", profileId: f.profileId, sessionFile: getWorkerSessionFilePath(f.dataDir, f.profileId, f.agentId, "worker") };
    f.source.getAgent = (id: string) => id === "worker" ? worker : id === f.agentId ? f.manager : undefined;
    expect(await errorCode(() => readPresentedChatArtifact(f.source, { transcriptAgentId: "worker", messageId: "m", path: target }))).toBe("invalid_transcript_owner");
  });

  it("rejects bounded in-place size mutations between every pre-read stage", async () => {
    if (process.platform === "win32") return;
    const f = await fixture(); const target = join(f.dataDir, "target"); await writeFile(target, "old");
    expect(await errorCode(() => securelyReadPresentedArtifact(target, { afterInitialWalk: () => writeFile(target, "changed") }))).toBe("file_identity_changed");
    await writeFile(target, "old");
    expect(await errorCode(() => securelyReadPresentedArtifact(target, { afterOpen: () => writeFile(target, "changed") }))).toBe("file_identity_changed");
  });

  it("uses identity-verified handle reads for Windows artifacts", async () => {
    const f = await fixture(); const target = join(f.dataDir, "target"); await writeFile(target, "safe");
    await writeFile(f.sessionFile, line(message("windows", `[x](swarm-file://${target})`)));
    expect(await readPresentedChatArtifact(f.source, {
      transcriptAgentId: f.agentId,
      messageId: "windows",
      path: target,
    }, { securityPlatform: "win32" })).toMatchObject({ content: "safe", path: target });
    expect(chatArtifactStatus("stable_identity_unsupported")).toBe(501);
  });

  it("reads outside-workspace Windows artifacts while rejecting transcript-mismatched claims", async () => {
    const f = await fixture();
    const outsideRoot = await mkdtemp(join(process.platform === "darwin" ? `/private${tmpdir()}` : tmpdir(), "forge-chat-artifact-outside-")); roots.push(outsideRoot);
    const outside = join(outsideRoot, "outside.txt"); await writeFile(outside, "outside");
    await writeFile(f.sessionFile, line(message("outside", `[x](swarm-file://${outside})`)));
    await expect(readPresentedChatArtifact(f.source, {
      transcriptAgentId: f.agentId,
      messageId: "outside",
      path: outside,
    }, { securityPlatform: "win32" })).resolves.toMatchObject({ content: "outside", path: outside });
    expect(await errorCode(() => readPresentedChatArtifact(f.source, {
      transcriptAgentId: f.agentId,
      messageId: "outside",
      path: join(f.dataDir, "not-presented.txt"),
    }, { securityPlatform: "win32" }))).toBe("path_not_presented");
  });

  it("detects ordinary-file and parent-directory replacement before bytes are read", async () => {
    if (process.platform === "win32") return;
    const f = await fixture(); const target = join(f.dataDir, "target"); const replacement = join(f.dataDir, "replacement"); await writeFile(target, "old"); await writeFile(replacement, "new");
    expect(await errorCode(() => securelyReadPresentedArtifact(target, { afterInitialWalk: () => rename(replacement, target) }))).toBe("file_identity_changed");
    const parent = join(f.dataDir, "parent"); const alternate = join(f.dataDir, "alternate"); await mkdir(parent); await mkdir(alternate); await writeFile(join(parent, "file"), "old"); await writeFile(join(alternate, "file"), "new");
    expect(await errorCode(() => securelyReadPresentedArtifact(join(parent, "file"), { afterInitialWalk: async () => { await rename(parent, `${parent}-old`); await rename(alternate, parent); } }))).toBe("file_identity_changed");
  });

  it("rejects a handle that grows beyond the bounded read limit", async () => {
    if (process.platform === "win32") return;
    const f = await fixture(); const target = join(f.dataDir, "target"); await writeFile(target, "small");
    expect(await errorCode(() => securelyReadPresentedArtifact(target, { afterOpen: () => writeFile(target, Buffer.alloc(2 * 1024 * 1024 + 2)) }))).toBe("file_too_large");
  });

  it("rejects non-regular targets before any open/read", async () => {
    const f = await fixture(); const target = join(f.dataDir, "directory"); await mkdir(target);
    expect(await errorCode(() => securelyReadPresentedArtifact(target))).toBe("invalid_path");
  });

  it("rejects FIFOs by lstat without opening them", async () => {
    if (process.platform === "win32") return;
    const f = await fixture(); const fifo = join(f.dataDir, "pipe"); await execFileAsync("mkfifo", [fifo]);
    expect(await errorCode(() => securelyReadPresentedArtifact(fifo))).toBe("invalid_path");
  });

  it("rejects final and parent symlinks and reads only ordinary files", async () => {
    if (process.platform === "win32") return;
    const f = await fixture(); const target = join(f.dataDir, "target"); await writeFile(target, "safe"); const link = join(f.dataDir, "link"); await symlink(target, link);
    expect(await errorCode(() => securelyReadPresentedArtifact(link))).toBe("unsafe_file_identity");
    const dir = join(f.dataDir, "dir"); await mkdir(dir); await symlink(f.dataDir, join(dir, "parent"));
    expect(await errorCode(() => securelyReadPresentedArtifact(join(dir, "parent", "target")))).toBe("unsafe_file_identity");
  });
});
