import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rename, symlink, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ChatArtifactError,
  MAX_PRESENTED_CHAT_ARTIFACT_IMAGE_BYTES,
  MAX_PRESENTED_CHAT_ARTIFACT_TEXT_BYTES,
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
import { parseWorktreeListPorcelain } from "../versioning/git-source-control-helpers.js";

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
async function execGit(cwd: string, args: string[]) { await execFileAsync("git", args, { cwd }); }

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

  it("uses the validated workspace snapshot when the live descriptor is replaced during transcript reading", async () => {
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

  it("matches file-browser project roots without authorizing sibling naming or unrelated repositories", async () => {
    if (process.platform === "win32") return;
    const f = await fixture();
    const projectRoot = await mkdtemp(join(tmpdir(), "forge-artifact-project-")); roots.push(projectRoot);
    const main = join(projectRoot, "project");
    const linked = join(projectRoot, "project-feature");
    const transcriptCwd = join(projectRoot, "transcript-cwd");
    const similarlyNamed = join(projectRoot, "transcript-cwd-unregistered");
    const unrelatedRepo = join(projectRoot, "unrelated-repo");
    const outside = join(projectRoot, "outside");
    await mkdir(main); await mkdir(transcriptCwd); await mkdir(similarlyNamed); await mkdir(unrelatedRepo); await mkdir(outside);
    await execGit(main, ["init"]);
    await execGit(main, ["config", "user.name", "Forge Test"]);
    await execGit(main, ["config", "user.email", "forge-test@example.com"]);
    await writeFile(join(main, "exact.txt"), "exact");
    await execGit(main, ["add", "exact.txt"]); await execGit(main, ["commit", "-m", "initial"]);
    await execGit(main, ["branch", "artifact-linked"]); await execGit(main, ["worktree", "add", linked, "artifact-linked"]);
    const registeredLinkedPath = parseWorktreeListPorcelain((await execFileAsync("git", ["worktree", "list", "--porcelain", "-z"], { cwd: main })).stdout)
      .find(worktree => worktree.branch === "artifact-linked")!.path;
    await execGit(unrelatedRepo, ["init"]);

    const effectiveProjectTarget = join(await realpath(main), "exact.txt");
    const linkedTarget = join(await realpath(linked), "linked.txt"); await writeFile(linkedTarget, "linked");
    const transcriptCwdTarget = join(await realpath(transcriptCwd), "descriptor.txt"); await writeFile(transcriptCwdTarget, "descriptor");
    const similarlyNamedTarget = join(similarlyNamed, "denied.txt"); await writeFile(similarlyNamedTarget, "similar");
    const unrelatedTarget = join(unrelatedRepo, "denied.txt"); await writeFile(unrelatedTarget, "unrelated");
    const repointedTarget = join(linked, "repointed.txt"); await writeFile(join(unrelatedRepo, "repointed.txt"), "repointed");
    const outsideTarget = join(outside, "secret.txt"); await writeFile(outsideTarget, "secret");
    const internalDir = join(main, "internal"); await mkdir(internalDir); await writeFile(join(internalDir, "safe.txt"), "internal");
    const internalAlias = join(main, "internal-alias"); await symlink(internalDir, internalAlias);
    const internalPresented = join(internalAlias, "safe.txt");
    const outsideAlias = join(main, "outside-alias.txt"); await symlink(outsideTarget, outsideAlias);
    const effectiveProjectCwd = await realpath(main);
    f.manager.cwd = await realpath(transcriptCwd);
    const profileOwner = { agentId: f.profileId, cwd: effectiveProjectCwd };
    f.source.getAgent = (id: string) => id === f.agentId ? f.manager : id === f.profileId ? profileOwner : undefined;
    await writeFile(f.sessionFile, line(message("project-roots", [effectiveProjectTarget, linkedTarget, transcriptCwdTarget, similarlyNamedTarget, unrelatedTarget, repointedTarget, internalPresented, outsideAlias]
      .map(candidate => `[x](swarm-file://${candidate})`).join(" "))));

    await expect(readPresentedChatArtifact(f.source, { transcriptAgentId: f.agentId, messageId: "project-roots", path: transcriptCwdTarget }))
      .resolves.toMatchObject({ content: "descriptor", path: transcriptCwdTarget });
    await expect(readPresentedChatArtifact(f.source, { transcriptAgentId: f.agentId, messageId: "project-roots", path: effectiveProjectTarget }))
      .resolves.toMatchObject({ content: "exact", path: effectiveProjectTarget });
    await expect(readPresentedChatArtifact(f.source, { transcriptAgentId: f.agentId, messageId: "project-roots", path: linkedTarget }))
      .resolves.toMatchObject({ content: "linked", path: linkedTarget });
    await rename(linked, `${linked}-original`);
    await symlink(unrelatedRepo, linked, "dir");
    const listed = parseWorktreeListPorcelain((await execFileAsync("git", ["worktree", "list", "--porcelain", "-z"], { cwd: main })).stdout)
      .find(worktree => worktree.path === registeredLinkedPath);
    expect(listed).toMatchObject({ isPrunable: false });
    expect(await errorCode(() => readPresentedChatArtifact(f.source, { transcriptAgentId: f.agentId, messageId: "project-roots", path: repointedTarget }))).toBe("path_outside_workspace");
    await expect(readPresentedChatArtifact(f.source, { transcriptAgentId: f.agentId, messageId: "project-roots", path: internalPresented }))
      .resolves.toMatchObject({ content: "internal", path: internalPresented });
    expect(await errorCode(() => readPresentedChatArtifact(f.source, { transcriptAgentId: f.agentId, messageId: "project-roots", path: similarlyNamedTarget }))).toBe("path_outside_workspace");
    expect(await errorCode(() => readPresentedChatArtifact(f.source, { transcriptAgentId: f.agentId, messageId: "project-roots", path: unrelatedTarget }))).toBe("path_outside_workspace");
    expect(await errorCode(() => readPresentedChatArtifact(f.source, { transcriptAgentId: f.agentId, messageId: "project-roots", path: outsideAlias }))).toBe("path_outside_workspace");
    expect(await errorCode(() => readPresentedChatArtifact(f.source, {
      transcriptAgentId: f.agentId,
      messageId: "project-roots",
      path: effectiveProjectTarget,
      worktreeId: "caller-selected",
    } as any))).toBe("invalid_request");
  });

  it("canonicalizes Windows drive aliases and internal junctions before root containment", async () => {
    const workspace = { transcriptCwd: "T:/aliases/project", effectiveProjectCwd: "T:/aliases/project" };
    const aliases = new Map<string, string>([
      ["T:/aliases/project", "C:/physical/project"],
      ["T:/aliases/project/report.md", "C:/physical/project/report.md"],
      ["T:/aliases/project-feature", "C:/physical/project-feature"],
      ["T:/aliases/project-feature/result.md", "C:/physical/project-feature/result.md"],
      ["T:/aliases/project-prunable", "C:/physical/project-prunable"],
      ["T:/aliases/project-prunable/stale.md", "C:/physical/project-prunable/stale.md"],
      ["T:/aliases/project-unverified", "C:/physical/project-unverified"],
      ["T:/aliases/project-unverified/denied.md", "C:/physical/project-unverified/denied.md"],
      ["T:/aliases/project-similar/denied.md", "C:/physical/project-similar/denied.md"],
      ["T:/aliases/project/outside-link.md", "C:/outside/secret.md"],
    ]);
    const fakeRealpath = async (value: string) => {
      const resolved = aliases.get(value);
      if (resolved) return resolved;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };
    const hooks = {
      platform: "win32" as const,
      realpath: fakeRealpath,
      listRegisteredWorktrees: async () => [
        { path: "T:/aliases/project", isPrunable: false },
        { path: "T:/aliases/project-feature", isPrunable: false },
        { path: "T:/aliases/project-prunable", isPrunable: true },
        { path: "T:/aliases/project-unverified", isPrunable: false },
      ],
      resolveGitRepositoryIdentity: async (canonicalCwd: string) =>
        canonicalCwd === "C:/physical/project" || canonicalCwd === "C:/physical/project-feature" ? "C:/git/common" : undefined,
    };

    await expect(resolveCanonicalPresentedArtifactTarget(workspace, "T:/aliases/project/report.md", hooks))
      .resolves.toBe("C:/physical/project/report.md");
    await expect(resolveCanonicalPresentedArtifactTarget(workspace, "T:/aliases/project-feature/result.md", hooks))
      .resolves.toBe("C:/physical/project-feature/result.md");
    expect(await errorCode(() => resolveCanonicalPresentedArtifactTarget(workspace, "T:/aliases/project-similar/denied.md", hooks))).toBe("path_outside_workspace");
    expect(await errorCode(() => resolveCanonicalPresentedArtifactTarget(workspace, "T:/aliases/project-prunable/stale.md", hooks))).toBe("path_outside_workspace");
    expect(await errorCode(() => resolveCanonicalPresentedArtifactTarget(workspace, "T:/aliases/project-unverified/denied.md", hooks))).toBe("path_outside_workspace");
    expect(await errorCode(() => resolveCanonicalPresentedArtifactTarget(workspace, "T:/aliases/project/outside-link.md", hooks))).toBe("path_outside_workspace");
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

  it("uses identity-verified handle reads for in-workspace Windows artifacts", async () => {
    const f = await fixture(); const target = join(f.dataDir, "target"); await writeFile(target, "safe");
    await writeFile(f.sessionFile, line(message("windows", `[x](swarm-file://${target})`)));
    expect(await readPresentedChatArtifact(f.source, {
      transcriptAgentId: f.agentId,
      messageId: "windows",
      path: target,
    }, { securityPlatform: "win32" })).toMatchObject({ content: "safe", path: target });
    expect(chatArtifactStatus("stable_identity_unsupported")).toBe(501);
  });

  it("denies out-of-workspace and transcript-mismatched Windows artifact claims", async () => {
    const f = await fixture();
    const outsideRoot = await mkdtemp(join(process.platform === "darwin" ? `/private${tmpdir()}` : tmpdir(), "forge-chat-artifact-outside-")); roots.push(outsideRoot);
    const outside = join(outsideRoot, "outside.txt"); await writeFile(outside, "outside");
    await writeFile(f.sessionFile, line(message("outside", `[x](swarm-file://${outside})`)));
    expect(await errorCode(() => readPresentedChatArtifact(f.source, {
      transcriptAgentId: f.agentId,
      messageId: "outside",
      path: outside,
    }, { securityPlatform: "win32" }))).toBe("path_outside_workspace");
    expect(chatArtifactStatus("path_outside_workspace")).toBe(403);
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
