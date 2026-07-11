import { describe, expect, it } from "vitest";
import {
  FORGE_MIN_NODE_VERSION,
  assertNodeEngineFloor,
  compareNodeVersions,
  parseNodeVersion,
  satisfiesNodeEngineFloor,
} from "../../node-engine-floor.js";

describe("node engine floor", () => {
  it("pins the Forge minimum at 22.19.0", () => {
    expect(FORGE_MIN_NODE_VERSION).toBe("22.19.0");
  });

  it("accepts versions at or above the floor", () => {
    expect(satisfiesNodeEngineFloor("22.19.0")).toBe(true);
    expect(satisfiesNodeEngineFloor("v22.19.1")).toBe(true);
    expect(satisfiesNodeEngineFloor("22.21.1")).toBe(true);
    expect(satisfiesNodeEngineFloor("23.0.0")).toBe(true);
  });

  it("rejects versions below the floor and unparsable values", () => {
    expect(satisfiesNodeEngineFloor("22.18.0")).toBe(false);
    expect(satisfiesNodeEngineFloor("22.0.0")).toBe(false);
    expect(satisfiesNodeEngineFloor("21.99.99")).toBe(false);
    expect(satisfiesNodeEngineFloor("not-a-version")).toBe(false);
  });

  it("compares version parts lexicographically", () => {
    expect(compareNodeVersions(parseNodeVersion("22.19.0")!, parseNodeVersion("22.18.9")!)).toBe(1);
    expect(compareNodeVersions(parseNodeVersion("22.19.0")!, parseNodeVersion("22.19.0")!)).toBe(0);
    expect(compareNodeVersions(parseNodeVersion("22.19.0")!, parseNodeVersion("22.19.1")!)).toBe(-1);
  });

  it("throws a clear startup error below the floor", () => {
    expect(() => assertNodeEngineFloor("22.18.0")).toThrow(/Forge requires Node.js >=22\.19\.0/);
    expect(() => assertNodeEngineFloor(process.version)).not.toThrow();
  });
});
