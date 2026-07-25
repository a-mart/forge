import { describe, expect, it } from "vitest";
import {
  buildUpdateWorkGraphTool,
  updateWorkGraphToolSchema,
} from "../planning/update-work-graph-tool.js";

describe("update_work_graph guidance", () => {
  it("teaches eligibility, minimality, and planning promotion without prescribing ceremony", () => {
    const tool = buildUpdateWorkGraphTool({} as never, {} as never);

    expect(tool.description).toContain("all three eligibility conditions");
    expect(tool.description).toContain("smallest dependency graph");
    expect(tool.description).toContain("worker count alone is not a reason");
    expect(tool.description).toContain("one bounded planning investigation");
    expect(tool.description).toContain("do not create speculative downstream nodes");
  });

  it("describes independently acceptable nodes and true readiness dependencies", () => {
    const serialized = JSON.stringify(updateWorkGraphToolSchema);

    expect(serialized).toContain("Independently executable worker instruction");
    expect(serialized).toContain("true readiness prerequisites");
    expect(serialized).toContain("Related work does not automatically require an edge");
    expect(serialized).toContain("smallest DAG that preserves real parallel readiness");
    expect(serialized).toContain("Graph size and fan-in do not justify a stronger route");
  });
});
