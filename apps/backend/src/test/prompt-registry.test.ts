import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { FileBackedPromptRegistry } from "../swarm/prompt-registry.js";

const SWARM_DIR = fileURLToPath(new URL("../swarm", import.meta.url));
const BUILTIN_ARCHETYPES_DIR = join(SWARM_DIR, "archetypes", "builtins");
const BUILTIN_OPERATIONAL_DIR = join(SWARM_DIR, "operational", "builtins");

async function createRegistryFixture(): Promise<{
  dataDir: string;
  repoDir: string;
  registry: FileBackedPromptRegistry;
}> {
  const root = await mkdtemp(join(tmpdir(), "prompt-registry-test-"));
  const dataDir = join(root, "data");
  const repoDir = join(root, "repo");
  await mkdir(dataDir, { recursive: true });
  await mkdir(repoDir, { recursive: true });

  const registry = new FileBackedPromptRegistry({
    dataDir,
    repoDir,
    builtinArchetypesDir: BUILTIN_ARCHETYPES_DIR,
    builtinOperationalDir: BUILTIN_OPERATIONAL_DIR
  });

  return { dataDir, repoDir, registry };
}

describe("FileBackedPromptRegistry", () => {
  it("loads built-in archetype and operational prompts", async () => {
    const { registry } = await createRegistryFixture();

    await expect(registry.resolve("archetype", "manager")).resolves.toContain(
      "You are the manager agent in a multi-agent swarm."
    );
    await expect(registry.resolve("archetype", "collaboration-channel")).resolves.toContain(
      "You are the manager agent for a collaboration channel in a multi-agent swarm."
    );
    await expect(registry.resolve("operational", "memory-merge")).resolves.toContain(
      "You are a memory file editor."
    );
  });

  it("uses repo archetype overrides over built-ins", async () => {
    const { registry, repoDir } = await createRegistryFixture();
    const repoOverridesDir = join(repoDir, ".swarm", "archetypes");
    await mkdir(repoOverridesDir, { recursive: true });
    await writeFile(join(repoOverridesDir, "manager.md"), "repo manager override\n", "utf8");

    registry.invalidate();

    await expect(registry.resolve("archetype", "manager")).resolves.toBe("repo manager override");
    await expect(registry.resolve("operational", "memory-merge")).resolves.toContain(
      "You are a memory file editor."
    );
  });

  it("uses profile overrides over repo and isolates by profile", async () => {
    const { registry, repoDir } = await createRegistryFixture();
    const repoOverridesDir = join(repoDir, ".swarm", "archetypes");
    await mkdir(repoOverridesDir, { recursive: true });
    await writeFile(join(repoOverridesDir, "manager.md"), "repo manager override\n", "utf8");

    await registry.save("archetype", "manager", "profile-a manager override\n", "profile-a");

    await expect(registry.resolve("archetype", "manager", "profile-a")).resolves.toBe(
      "profile-a manager override"
    );
    await expect(registry.resolve("archetype", "manager", "profile-b")).resolves.toBe("repo manager override");

    await expect(registry.hasOverride("archetype", "manager", "profile-a")).resolves.toBe(true);
    await expect(registry.hasOverride("archetype", "manager", "profile-b")).resolves.toBe(false);
  });

  it("falls through when profile override path is unreadable", async () => {
    const { registry, dataDir, repoDir } = await createRegistryFixture();

    const profilePromptDir = join(dataDir, "profiles", "profile-a", "prompts", "archetypes", "manager.md");
    await mkdir(profilePromptDir, { recursive: true });

    const repoOverridesDir = join(repoDir, ".swarm", "archetypes");
    await mkdir(repoOverridesDir, { recursive: true });
    await writeFile(join(repoOverridesDir, "manager.md"), "repo fallback\n", "utf8");

    registry.invalidate();

    await expect(registry.resolve("archetype", "manager", "profile-a")).resolves.toBe("repo fallback");
  });

  it("records versioning mutations for prompt save and delete", async () => {
    const recordMutation = vi.fn(async () => true);
    const root = await mkdtemp(join(tmpdir(), "prompt-registry-test-"));
    const dataDir = join(root, "data");
    const repoDir = join(root, "repo");
    await mkdir(dataDir, { recursive: true });
    await mkdir(repoDir, { recursive: true });

    const registry = new FileBackedPromptRegistry({
      dataDir,
      repoDir,
      builtinArchetypesDir: BUILTIN_ARCHETYPES_DIR,
      builtinOperationalDir: BUILTIN_OPERATIONAL_DIR,
      versioning: {
        isTrackedPath: () => true,
        recordMutation,
        flushPending: async () => {},
        reconcileNow: async () => {}
      }
    });

    await registry.save("archetype", "manager", "override\n", "profile-a");
    await registry.deleteOverride("archetype", "manager", "profile-a");

    expect(recordMutation).toHaveBeenNthCalledWith(1, {
      path: join(dataDir, "profiles", "profile-a", "prompts", "archetypes", "manager.md"),
      action: "write",
      source: "prompt-save",
      profileId: "profile-a",
      promptCategory: "archetype",
      promptId: "manager"
    });
    expect(recordMutation).toHaveBeenNthCalledWith(2, {
      path: join(dataDir, "profiles", "profile-a", "prompts", "archetypes", "manager.md"),
      action: "delete",
      source: "prompt-delete",
      profileId: "profile-a",
      promptCategory: "archetype",
      promptId: "manager"
    });
  });
});
