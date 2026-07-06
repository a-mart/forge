import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLLAB_SELECTED_SPECIALIST_HANDLES,
  parseCollaborationSpecialistHandlesJson,
  serializeCollaborationSpecialistHandles,
} from "../collaboration/specialist-selection.js";

describe("collaboration specialist selection", () => {
  it("defaults new collaboration selections to the tier-based empty handle list", () => {
    expect(DEFAULT_COLLAB_SELECTED_SPECIALIST_HANDLES).toEqual([]);
    expect(parseCollaborationSpecialistHandlesJson(null)).toEqual([]);
    expect(serializeCollaborationSpecialistHandles(DEFAULT_COLLAB_SELECTED_SPECIALIST_HANDLES)).toBe("[]");
  });

  it("normalizes explicit legacy handle lists without silently dropping missing handles", () => {
    expect(parseCollaborationSpecialistHandlesJson(JSON.stringify(["Collab Planner", "collab-planner"]))).toEqual([
      "collab-planner",
    ]);
  });
});
