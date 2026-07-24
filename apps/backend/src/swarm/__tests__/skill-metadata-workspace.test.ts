import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { getProfilePiSkillsDir } from "../data-paths.js";
import { REQUIRED_SKILL_NAMES, SkillMetadataService } from "../skills/skill-metadata-service.js";
import type { SwarmConfig } from "../types.js";

function createConfig(root: string): SwarmConfig {
  return {
    paths: {
      rootDir: root,
      dataDir: join(root, "data"),
      resourcesDir: root,
      repoMemorySkillFile: join(root, "missing-memory", "SKILL.md"),
    },
  } as SwarmConfig;
}

async function writeSkill(root: string, handle: string, frontmatter: string[] = []): Promise<void> {
  const skillDir = join(root, handle);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    ["---", `name: ${handle}`, `description: ${handle} skill`, ...frontmatter, "---", "Use this skill."].join("\n"),
  );
}

function encodeSkillId(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

describe("SkillMetadataService workspace skills", () => {
  it("requires agent-browser and does not require the retired chrome-cdp skill", () => {
    expect(REQUIRED_SKILL_NAMES).toContain("agent-browser");
    expect(REQUIRED_SKILL_NAMES).not.toContain("chrome-cdp");
  });

  it("rejects direct workspace skill ID resolution without active workspace context", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-metadata-workspace-"));
    const config = createConfig(root);
    const arbitrarySkillRoot = join(root, "arbitrary", "not-active", "skills", "dangerous");
    await writeSkill(join(arbitrarySkillRoot, ".."), "dangerous");

    const service = new SkillMetadataService({ config });
    const craftedSkillId = encodeSkillId({ sourceKind: "workspace", skillRootPath: arbitrarySkillRoot });

    await expect(service.resolveSkillById(craftedSkillId)).resolves.toBeNull();
  });

  it("resolves workspace skill IDs only when the matching forge directory context is provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-metadata-workspace-"));
    const config = createConfig(root);
    const forgeDir = join(root, "repo", ".forge");
    const workspaceSkillsDir = join(forgeDir, "skills");
    await writeSkill(workspaceSkillsDir, "repo-only");

    const service = new SkillMetadataService({ config });
    const [workspaceSkill] = await service.getProfileSkillMetadataForWorkspace("profile-a", forgeDir);
    expect(workspaceSkill.sourceKind).toBe("workspace");
    await expect(service.resolveSkillById(workspaceSkill.skillId)).resolves.toBeNull();
    await expect(service.resolveSkillById(workspaceSkill.skillId, { profileId: "profile-a", forgeDir })).resolves.toMatchObject({
      directoryName: "repo-only",
      sourceKind: "workspace",
    });
    await expect(service.resolveSkillById(workspaceSkill.skillId, { profileId: "profile-a", forgeDir: join(root, "other", ".forge") })).resolves.toBeNull();
  });

  it("adds repository .forge skills and only overrides inherited skills with explicit precedence", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-metadata-workspace-"));
    const config = createConfig(root);
    const profileId = "profile-a";
    const localSkillsDir = join(config.paths.dataDir, "skills");
    const profileSkillsDir = getProfilePiSkillsDir(config.paths.dataDir, profileId);
    const forgeDir = join(root, "repo", ".forge");
    const workspaceSkillsDir = join(forgeDir, "skills");

    await writeSkill(localSkillsDir, "global-only");
    await writeSkill(localSkillsDir, "shared-conflict");
    await writeSkill(localSkillsDir, "explicit-conflict");
    await writeSkill(profileSkillsDir, "profile-conflict");
    await writeSkill(workspaceSkillsDir, "repo-only");
    await writeSkill(workspaceSkillsDir, "shared-conflict");
    await writeSkill(workspaceSkillsDir, "explicit-conflict", ["forgePrecedence: override"]);
    await writeSkill(workspaceSkillsDir, "profile-conflict", ["forgePrecedence: override"]);

    const service = new SkillMetadataService({ config });
    const metadata = await service.getProfileSkillMetadataForWorkspace(profileId, forgeDir);
    const byDirectory = new Map(metadata.map((entry) => [entry.directoryName, entry]));

    expect(byDirectory.get("repo-only")).toMatchObject({ sourceKind: "workspace", isInherited: true });
    expect(byDirectory.get("shared-conflict")).toMatchObject({ sourceKind: "machine-local" });
    expect(byDirectory.get("explicit-conflict")).toMatchObject({
      sourceKind: "workspace",
      conflictWarning: "Repository skill overrides inherited machine-local skill.",
    });
    expect(byDirectory.get("profile-conflict")).toMatchObject({ sourceKind: "profile" });
    expect(byDirectory.get("global-only")).toMatchObject({ sourceKind: "machine-local", isInherited: true });
  });
});
