import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { RemoteUpdateGitError, RemoteUpdateGitObserver } from "../remote-update-awareness-git.js";

const exec = promisify(execFile);
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test" };

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, env: gitEnv, encoding: "utf8" })).stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "remote-awareness-git-"));
  const bare = join(root, "remote.git");
  const seed = join(root, "seed");
  const clone = join(root, "clone");
  await git(root, "init", "--bare", bare);
  await git(root, "init", "-b", "trunk", seed);
  await exec("sh", ["-c", "printf one > file.txt"], { cwd: seed });
  await git(seed, "add", "file.txt");
  await git(seed, "commit", "-m", "one");
  await git(seed, "remote", "add", "upstream", bare);
  await git(seed, "push", "upstream", "trunk");
  await git(bare, "symbolic-ref", "HEAD", "refs/heads/trunk");
  await git(root, "clone", bare, clone);
  await git(clone, "remote", "rename", "origin", "upstream");
  return { root, bare, seed, clone, initial: await git(seed, "rev-parse", "HEAD") };
}

async function commitAndPush(seed: string, contents: string, branch = "trunk"): Promise<string> {
  await exec("sh", ["-c", `printf '${contents}' > file.txt`], { cwd: seed });
  await git(seed, "add", "file.txt");
  await git(seed, "commit", "-m", contents);
  await git(seed, "push", "upstream", `HEAD:${branch}`);
  return git(seed, "rev-parse", "HEAD");
}

describe("RemoteUpdateGitObserver", () => {
  it("canonicalizes linked worktrees and resolves a non-origin, non-main default ref", async () => {
    const repo = await fixture();
    const linked = join(repo.root, "linked");
    await git(repo.clone, "worktree", "add", "-b", "linked", linked);
    const observer = new RemoteUpdateGitObserver();
    const mainTarget = await observer.resolveTarget({ cwd: repo.clone, remoteName: "upstream" });
    const linkedTarget = await observer.resolveTarget({ cwd: linked, remoteName: "upstream" });

    expect(mainTarget.targetRef).toBe("refs/heads/trunk");
    expect(mainTarget.destinationRef).toBe("refs/remotes/upstream/trunk");
    expect(linkedTarget.commonDir).toBe(mainTarget.commonDir);
    expect(linkedTarget.monitorKey).toBe(mainTarget.monitorKey);
    expect(mainTarget.monitorKey).not.toContain(repo.root);
  });

  it("changes monitor identity when the selected remote configuration changes", async () => {
    const repo = await fixture();
    const observer = new RemoteUpdateGitObserver();
    const before = await observer.resolveTarget({ cwd: repo.clone, remoteName: "upstream", targetRef: "refs/heads/trunk" });
    await git(repo.clone, "remote", "set-url", "--add", "upstream", repo.bare);
    const after = await observer.resolveTarget({ cwd: repo.clone, remoteName: "upstream", targetRef: "refs/heads/trunk" });
    expect(after.commonDir).toBe(before.commonDir);
    expect(after.remoteFingerprint).not.toBe(before.remoteFingerprint);
    expect(after.monitorKey).not.toBe(before.monitorKey);
  });

  it("force-fetches exactly one ref without tags, submodules, FETCH_HEAD, or unrelated ref updates", async () => {
    const repo = await fixture();
    await git(repo.seed, "branch", "side");
    await git(repo.seed, "push", "upstream", "side");
    await git(repo.clone, "fetch", "upstream", "+refs/heads/side:refs/remotes/upstream/side");
    const oldSide = await git(repo.clone, "rev-parse", "refs/remotes/upstream/side");
    const target = await new RemoteUpdateGitObserver().resolveTarget({ cwd: repo.clone, remoteName: "upstream", targetRef: "refs/heads/trunk" });
    const newTrunk = await commitAndPush(repo.seed, "two");
    await git(repo.seed, "checkout", "side");
    await commitAndPush(repo.seed, "side-two", "side");

    const observer = new RemoteUpdateGitObserver();
    const result = await observer.observe({ cwd: repo.clone, target, previousTipOid: repo.initial });
    expect(result).toMatchObject({ state: "remote_ahead", tipOid: newTrunk });
    expect(await git(repo.clone, "rev-parse", target.destinationRef)).toBe(newTrunk);
    expect(await git(repo.clone, "rev-parse", "refs/remotes/upstream/side")).toBe(oldSide);
    await expect(readFile(join(repo.clone, ".git", "FETCH_HEAD"), "utf8")).resolves.not.toContain(newTrunk);
  });

  it("observes a forced rewind through the exact destination", async () => {
    const repo = await fixture();
    const observer = new RemoteUpdateGitObserver();
    const target = await observer.resolveTarget({ cwd: repo.clone, remoteName: "upstream" });
    const advanced = await commitAndPush(repo.seed, "two");
    await observer.observe({ cwd: repo.clone, target, previousTipOid: repo.initial });
    await git(repo.bare, "update-ref", "refs/heads/trunk", repo.initial);

    const rewound = await observer.observe({ cwd: repo.clone, target, previousTipOid: advanced });
    expect(rewound).toMatchObject({ state: "rewound", tipOid: repo.initial });
  });

  it("classifies a deleted exact ref without deleting or trusting the stale destination", async () => {
    const repo = await fixture();
    const observer = new RemoteUpdateGitObserver();
    const target = await observer.resolveTarget({ cwd: repo.clone, remoteName: "upstream" });
    await git(repo.bare, "update-ref", "-d", "refs/heads/trunk");

    await expect(observer.observe({ cwd: repo.clone, target, previousTipOid: repo.initial }))
      .rejects.toMatchObject({ code: "missing" });
    expect(await git(repo.clone, "rev-parse", target.destinationRef)).toBe(repo.initial);
  });

  it("reports shallow ancestry as unknown instead of false divergence", async () => {
    const repo = await fixture();
    const shallow = join(repo.root, "shallow");
    await git(repo.root, "clone", "--depth=1", `file://${repo.bare}`, shallow);
    await git(shallow, "remote", "rename", "origin", "upstream");
    await commitAndPush(repo.seed, "two");
    await commitAndPush(repo.seed, "three");
    const observer = new RemoteUpdateGitObserver();
    const target = await observer.resolveTarget({ cwd: shallow, remoteName: "upstream" });
    await expect(observer.observe({ cwd: shallow, target, previousTipOid: repo.initial }))
      .resolves.toMatchObject({ state: "unknown" });
  });

  it("reports detached worktrees as a typed non-positive observation", async () => {
    const repo = await fixture();
    const observer = new RemoteUpdateGitObserver();
    const target = await observer.resolveTarget({ cwd: repo.clone, remoteName: "upstream" });
    await commitAndPush(repo.seed, "two");
    await git(repo.clone, "checkout", "--detach", repo.initial);
    await expect(observer.observe({ cwd: repo.clone, target, previousTipOid: repo.initial }))
      .resolves.toMatchObject({ state: "detached" });
  });

  it("never guesses a default branch when local and advertised HEAD are non-symbolic", async () => {
    const repo = await fixture();
    await git(repo.clone, "symbolic-ref", "--delete", "refs/remotes/upstream/HEAD");
    await git(repo.bare, "update-ref", "--no-deref", "HEAD", repo.initial);
    const observer = new RemoteUpdateGitObserver();
    await expect(observer.resolveTarget({ cwd: repo.clone, remoteName: "upstream" }))
      .rejects.toMatchObject({ code: "unresolved" });
  });

  it("rejects option-like/non-head refs with a sanitized typed error", async () => {
    const repo = await fixture();
    const observer = new RemoteUpdateGitObserver();
    const error = await observer.resolveTarget({ cwd: repo.clone, remoteName: "upstream", targetRef: "--upload-pack=secret" })
      .catch((caught) => caught as RemoteUpdateGitError);
    expect(error).toBeInstanceOf(RemoteUpdateGitError);
    expect(error.code).toBe("unresolved");
    expect(JSON.stringify(error)).not.toContain(repo.root);
    expect(error.message).not.toContain("secret");
  });
});
