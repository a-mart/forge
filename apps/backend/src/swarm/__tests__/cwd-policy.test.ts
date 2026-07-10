import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDirectory,
  listDirectories,
  parseCwdAllowlistRootsEnv,
  resolveDirectoryPath,
  validateDirectory,
  validateDirectoryPath,
  validateSingleFolderName,
  type CwdPolicy,
} from "../cwd-policy.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  // Best-effort cleanup is unnecessary for tmp dirs in unit tests.
  tempDirs.length = 0;
});

describe("cwd-policy", () => {
  it("preserves POSIX absolute paths", () => {
    expect(resolveDirectoryPath("/tmp/project", "/repo/root")).toBe("/tmp/project");
  });

  it("preserves Windows absolute paths", () => {
    expect(resolveDirectoryPath("C:\\repo\\project", "/repo/root")).toBe("C:\\repo\\project");
  });

  it("resolves relative paths under the configured root", () => {
    expect(resolveDirectoryPath("packages/ui", "/repo/root")).toBe("/repo/root/packages/ui");
  });

  describe("parseCwdAllowlistRootsEnv", () => {
    it("splits on semicolons and newlines on Windows", () => {
      expect(parseCwdAllowlistRootsEnv("C:\\a;C:\\b\nC:\\c", "win32")).toEqual([
        "C:\\a",
        "C:\\b",
        "C:\\c",
      ]);
    });

    it("does not split Windows drive letters on colon", () => {
      expect(parseCwdAllowlistRootsEnv("C:\\workspaces;D:\\data", "win32")).toEqual([
        "C:\\workspaces",
        "D:\\data",
      ]);
    });

    it("splits on colon, semicolon, and newlines on POSIX", () => {
      expect(parseCwdAllowlistRootsEnv("/workspaces:/data;/extra\n/more", "linux")).toEqual([
        "/workspaces",
        "/data",
        "/extra",
        "/more",
      ]);
    });

    it("returns empty for blank input", () => {
      expect(parseCwdAllowlistRootsEnv(undefined)).toEqual([]);
      expect(parseCwdAllowlistRootsEnv("  ")).toEqual([]);
    });
  });

  describe("local unrestricted behavior", () => {
    it("accepts directories outside allowlistRoots when enforceAllowlist is false", async () => {
      const root = await makeTempDir("cwd-root-");
      const outside = await makeTempDir("cwd-outside-");
      const policy: CwdPolicy = {
        rootDir: root,
        allowlistRoots: [root],
        enforceAllowlist: false,
      };

      await expect(validateDirectoryPath(outside, policy)).resolves.toBe(outside);
      const validation = await validateDirectory(outside, policy);
      expect(validation.valid).toBe(true);
      expect(validation.roots).toEqual([]);

      const listed = await listDirectories(outside, policy);
      expect(listed.resolvedPath).toBe(outside);
      expect(listed.roots).toEqual([]);
    });
  });

  describe("remote allowlist enforcement", () => {
    it("fails closed when no usable roots are configured", async () => {
      const root = await makeTempDir("cwd-empty-");
      const policy: CwdPolicy = {
        rootDir: root,
        allowlistRoots: [],
        enforceAllowlist: true,
      };

      await expect(listDirectories(undefined, policy)).rejects.toMatchObject({
        code: "DIRECTORY_NO_ROOTS",
      });
      const validation = await validateDirectory(root, policy);
      expect(validation.valid).toBe(false);
      expect(validation.message).toMatch(/FORGE_CWD_ALLOWLIST_ROOTS/);
    });

    it("accepts paths inside configured roots and denies outside", async () => {
      const allowed = await makeTempDir("cwd-allowed-");
      const nested = join(allowed, "project");
      await mkdir(nested);
      const outside = await makeTempDir("cwd-denied-");

      const policy: CwdPolicy = {
        rootDir: allowed,
        allowlistRoots: [allowed],
        enforceAllowlist: true,
      };

      await expect(validateDirectoryPath(nested, policy)).resolves.toBe(nested);
      await expect(validateDirectoryPath(outside, policy)).rejects.toMatchObject({
        code: "DIRECTORY_OUTSIDE_ROOT",
      });

      const listed = await listDirectories(undefined, policy);
      expect(listed.roots).toEqual([allowed]);
      expect(listed.directories.map((entry) => entry.path)).toContain(allowed);
      expect(listed.parentPath).toBeNull();
    });

    it("rejects .. traversal and absolute escape", async () => {
      const allowed = await makeTempDir("cwd-trav-");
      const nested = join(allowed, "nested");
      await mkdir(nested);
      const policy: CwdPolicy = {
        rootDir: allowed,
        allowlistRoots: [allowed],
        enforceAllowlist: true,
      };

      await expect(validateDirectoryPath(join(nested, "..", ".."), policy)).rejects.toMatchObject({
        code: "DIRECTORY_OUTSIDE_ROOT",
      });
    });

    it("hides listed child symlinks that resolve outside the root", async () => {
      const allowed = await makeTempDir("cwd-sym-root-");
      const outside = await makeTempDir("cwd-sym-out-");
      const escapeLink = join(allowed, "escape");
      await symlink(outside, escapeLink);
      await mkdir(join(allowed, "safe"));

      const policy: CwdPolicy = {
        rootDir: allowed,
        allowlistRoots: [allowed],
        enforceAllowlist: true,
      };

      const listed = await listDirectories(allowed, policy);
      expect(listed.directories.map((entry) => entry.name)).toEqual(["safe"]);
      expect(listed.directories.map((entry) => entry.name)).not.toContain("escape");
    });

    it("rejects validating a symlink that escapes the root", async () => {
      const allowed = await makeTempDir("cwd-sym-val-");
      const outside = await makeTempDir("cwd-sym-val-out-");
      const escapeLink = join(allowed, "escape");
      await symlink(outside, escapeLink);

      const policy: CwdPolicy = {
        rootDir: allowed,
        allowlistRoots: [allowed],
        enforceAllowlist: true,
      };

      await expect(validateDirectoryPath(escapeLink, policy)).rejects.toMatchObject({
        code: "DIRECTORY_OUTSIDE_ROOT",
      });
    });
  });

  describe("createDirectory", () => {
    it("creates a single folder level inside an allowed root", async () => {
      const allowed = await makeTempDir("cwd-mkdir-");
      const policy: CwdPolicy = {
        rootDir: allowed,
        allowlistRoots: [allowed],
        enforceAllowlist: true,
      };

      const created = await createDirectory(allowed, "new-project", policy);
      expect(created.path).toBe(join(allowed, "new-project"));
      expect(created.name).toBe("new-project");
    });

    it("rejects invalid names, existing paths, outside parents, and symlink parents", async () => {
      const allowed = await makeTempDir("cwd-mkdir-bad-");
      const outside = await makeTempDir("cwd-mkdir-out-");
      await writeFile(join(allowed, "existing"), "x");
      const escapeLink = join(allowed, "escape");
      await symlink(outside, escapeLink);

      const policy: CwdPolicy = {
        rootDir: allowed,
        allowlistRoots: [allowed],
        enforceAllowlist: true,
      };

      await expect(createDirectory(allowed, "..", policy)).rejects.toMatchObject({
        code: "DIRECTORY_NAME_INVALID",
      });
      await expect(createDirectory(allowed, "a/b", policy)).rejects.toMatchObject({
        code: "DIRECTORY_NAME_INVALID",
      });
      await expect(createDirectory(allowed, "existing", policy)).rejects.toMatchObject({
        code: "DIRECTORY_ALREADY_EXISTS",
      });
      await expect(createDirectory(outside, "nope", policy)).rejects.toMatchObject({
        code: "DIRECTORY_OUTSIDE_ROOT",
      });
      await expect(createDirectory(escapeLink, "nope", policy)).rejects.toMatchObject({
        code: "DIRECTORY_OUTSIDE_ROOT",
      });
    });

    it("rejects create when no roots are configured", async () => {
      const root = await makeTempDir("cwd-mkdir-empty-");
      const policy: CwdPolicy = {
        rootDir: root,
        allowlistRoots: [],
        enforceAllowlist: true,
      };
      await expect(createDirectory(root, "x", policy)).rejects.toMatchObject({
        code: "DIRECTORY_NO_ROOTS",
      });
    });

    it("aborts parent-replacement TOCTOU to an outside symlink and leaves no orphan outside roots", async () => {
      const allowed = await makeTempDir("cwd-mkdir-toctou-");
      const parent = join(allowed, "parent");
      await mkdir(parent);
      const outside = await makeTempDir("cwd-mkdir-toctou-out-");
      const folderName = "orphan-probe";
      const outsideOrphan = join(outside, folderName);

      const policy: CwdPolicy = {
        rootDir: allowed,
        allowlistRoots: [allowed],
        enforceAllowlist: true,
      };

      await expect(
        createDirectory(parent, folderName, policy, {
          beforeMkdir: async () => {
            await rm(parent, { recursive: true, force: true });
            await symlink(outside, parent);
          },
        }),
      ).rejects.toMatchObject({
        code: "DIRECTORY_OUTSIDE_ROOT",
      });

      await expect(access(outsideOrphan)).rejects.toMatchObject({ code: "ENOENT" });
      // Symlink parent path must also not retain the created name.
      await expect(access(join(parent, folderName))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  describe("validateSingleFolderName", () => {
    it("accepts simple names and rejects separators and reserved names", () => {
      expect(validateSingleFolderName("my-project")).toBe("my-project");
      expect(() => validateSingleFolderName(".")).toThrow();
      expect(() => validateSingleFolderName("..")).toThrow();
      expect(() => validateSingleFolderName("a/b")).toThrow();
      expect(() => validateSingleFolderName("a\\b")).toThrow();
      expect(() => validateSingleFolderName("con")).toThrow();
    });
  });
});
