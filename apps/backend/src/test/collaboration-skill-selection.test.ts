import { describe, expect, it } from "vitest";
import {
  findMissingCollaborationSkillHandles,
  parseCollaborationSkillHandlesJson,
  resolveCollaborationSkillSelectionMode,
  serializeCollaborationSkillHandles,
} from "../collaboration/skill-selection.js";
import { resolveCollaborationSkillRoster } from "../swarm/skills/collaboration-skill-resolver.js";
import type { SkillMetadata } from "../swarm/skills/skill-metadata-service.js";

describe("collaboration skill selection helpers", () => {
  it("preserves null as all mode and distinguishes custom empty", () => {
    expect(parseCollaborationSkillHandlesJson(null)).toBeNull();
    expect(resolveCollaborationSkillSelectionMode(null)).toBe("all");
    expect(parseCollaborationSkillHandlesJson("[]")).toEqual([]);
    expect(resolveCollaborationSkillSelectionMode("[]")).toBe("custom");
  });

  it("normalizes, dedupes, serializes, and reports missing handles without mutation", () => {
    expect(parseCollaborationSkillHandlesJson(JSON.stringify([" Search ", "search", "Browser"]))).toEqual([
      "search",
      "browser",
    ]);
    expect(serializeCollaborationSkillHandles([" Search ", "search", "Browser"])).toBe(
      JSON.stringify(["search", "browser"]),
    );
    expect(findMissingCollaborationSkillHandles(["search", "missing"], ["search"])).toEqual(["missing"]);
  });

  it("strips always-on core handles from optional persisted selections", () => {
    expect(serializeCollaborationSkillHandles(["memory", "Search", "memory"])).toBe(JSON.stringify(["search"]));
    expect(findMissingCollaborationSkillHandles(["memory", "missing"], [])).toEqual(["missing"]);
  });

  it("rejects malformed custom selection JSON", () => {
    expect(() => parseCollaborationSkillHandlesJson(JSON.stringify(["ok", 1]))).toThrow(/only strings/);
    expect(() => parseCollaborationSkillHandlesJson(JSON.stringify(["ok", " "]))).toThrow(/non-empty/);
    expect(() => parseCollaborationSkillHandlesJson(JSON.stringify({ skill: "search" }))).toThrow(/array/);
  });
});

describe("collaboration skill roster resolver", () => {
  it("resolves all mode dynamically and keeps memory always-on", async () => {
    const roster = await resolveCollaborationSkillRoster({
      selectionJson: null,
      skillMetadataService: fakeSkillMetadataService(["memory", "search", "browser"]),
    });

    expect(roster.mode).toBe("all");
    expect(roster.alwaysOnHandles).toEqual(["memory"]);
    expect(roster.savedSelectedOptionalHandles).toEqual([]);
    expect(roster.resolvedOptionalHandles).toEqual(["search", "browser"]);
    expect(roster.skills.map((skill) => skill.directoryName)).toEqual(["memory", "search", "browser"]);
  });

  it("preserves missing saved handles while resolving only available optional skills", async () => {
    const roster = await resolveCollaborationSkillRoster({
      selectionJson: JSON.stringify(["search", "memory", "missing", "search"]),
      skillMetadataService: fakeSkillMetadataService(["memory", "search", "browser"]),
    });

    expect(roster.mode).toBe("custom");
    expect(roster.savedSelectedOptionalHandles).toEqual(["search", "missing"]);
    expect(roster.resolvedOptionalHandles).toEqual(["search"]);
    expect(roster.missingHandles).toEqual(["missing"]);
    expect(roster.skills.map((skill) => skill.directoryName)).toEqual(["memory", "search"]);
  });

  it("custom empty still includes memory only", async () => {
    const roster = await resolveCollaborationSkillRoster({
      selectionJson: "[]",
      skillMetadataService: fakeSkillMetadataService(["memory", "search"]),
    });

    expect(roster.mode).toBe("custom");
    expect(roster.resolvedOptionalHandles).toEqual([]);
    expect(roster.skills.map((skill) => skill.directoryName)).toEqual(["memory"]);
  });
});

function fakeSkillMetadataService(directoryNames: string[]) {
  return {
    ensureSkillMetadataLoaded: async () => {},
    getSkillMetadata: () => directoryNames.map(fakeSkill),
  };
}

function fakeSkill(directoryName: string): SkillMetadata {
  return {
    skillId: directoryName,
    skillName: directoryName,
    directoryName,
    path: `/skills/${directoryName}/SKILL.md`,
    rootPath: `/skills/${directoryName}`,
    env: [],
    sourceKind: "builtin",
    isInherited: false,
    isEffective: true,
  };
}
