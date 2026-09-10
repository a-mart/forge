import { describe, expect, it } from "vitest";
import { parseOpenRouterRoutingConfig, resolveOpenRouterRouting } from "../openrouter-routing.js";
describe("OpenRouter routing", () => {
  it("preserves legacy absence and distinguishes inherit from clear and replacement", () => {
    expect(resolveOpenRouterRouting()).toEqual({});
    expect(resolveOpenRouterRouting({ only: ["one"], order: ["one"], max_price: { prompt: 2, completion: 3 } }, { only: ["two"], order: null, max_price: { prompt: 1 } })).toEqual({ only: ["two"], max_price: { prompt: 1 } });
    expect(resolveOpenRouterRouting({ only: ["one"] }, {})).toEqual({ only: ["one"] });
  });
  it("enforces privacy floor even for explicit weakening or clearing", () => {
    for (const local of [{ zdr: false, data_collection: "allow" as const }, { zdr: null, data_collection: null }]) {
      expect(resolveOpenRouterRouting({ zdr: true, data_collection: "deny" }, local)).toEqual({ zdr: true, data_collection: "deny" });
    }
  });
  it.each([null, [], { unknown: true }, { zdr: "true" }, { zdr: undefined }, { only: [] }, { only: ["one", "one"] }, { only: [" bad"] }, { quantizations: ["nope"] }, { sort: "speed" }, { max_price: {} }, { max_price: { prompt: -1 } }, { max_price: { prompt: Infinity } }, { max_price: { image: 2 } }, { order: ["one"], sort: "price" }, { only: ["azure/eu"], ignore: ["azure"] }])("rejects malformed/contradictory policy %j", (value) => {
    expect(() => parseOpenRouterRoutingConfig(value)).toThrow();
  });
  it("rejects contradictions created by inheritance", () => {
    expect(() => resolveOpenRouterRouting({ order: ["one"] }, { sort: "price" })).toThrow();
    expect(resolveOpenRouterRouting({ order: ["one"] }, { order: null, sort: "price" })).toEqual({ sort: "price" });
  });
  it("accepts all first-release fields without sharing mutable references", () => {
    const config = { zdr: true, data_collection: "deny", order: ["google-vertex/us-east5"], only: ["google-vertex"], ignore: ["azure"], allow_fallbacks: false, require_parameters: true, max_price: { prompt: 0, completion: 1 }, quantizations: ["fp8", "bf16"] };
    expect(parseOpenRouterRoutingConfig(config)).toEqual(config);
    expect(parseOpenRouterRoutingConfig(config).only).not.toBe(config.only);
  });
});
