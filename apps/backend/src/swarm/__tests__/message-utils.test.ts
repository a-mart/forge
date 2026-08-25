import { describe, expect, it } from "vitest";
import { normalizeProviderErrorMessage } from "../session/message-utils.js";

describe("normalizeProviderErrorMessage", () => {
  it("prefers OpenRouter metadata.raw over a generic wrapper message", () => {
    expect(
      normalizeProviderErrorMessage(
        '429: {"message":"Provider returned error","code":429,"metadata":{"raw":"stealth/ox-alpha is temporarily rate-limited upstream. Please retry shortly.","provider_name":"Stealth"}}'
      )
    ).toBe("HTTP 429: stealth/ox-alpha is temporarily rate-limited upstream. Please retry shortly");
  });

  it("keeps nested Anthropic error.message for context overflow", () => {
    expect(
      normalizeProviderErrorMessage(
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 180186 tokens > 180000 maximum"},"request_id":"req_test"}'
      )
    ).toBe("HTTP 400: prompt is too long: 180186 tokens > 180000 maximum");
  });

  it("does not invent a nested message when JSON is absent", () => {
    expect(normalizeProviderErrorMessage("Rate limit exceeded for requests per minute.")).toBe(
      "Rate limit exceeded for requests per minute."
    );
  });
});
