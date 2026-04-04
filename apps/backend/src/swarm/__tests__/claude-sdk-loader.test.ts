import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadClaudeSdkMcpHelpers,
  loadClaudeSdkModule,
  resetClaudeSdkLoaderForTests,
  setClaudeSdkImporterForTests,
  type ClaudeSdkModule
} from "../claude-sdk-loader.js";

afterEach(() => {
  resetClaudeSdkLoaderForTests();
});

describe("claude-sdk-loader", () => {
  it("loads the SDK module through the injected importer", async () => {
    const query = vi.fn() as ClaudeSdkModule["query"];
    const importer = vi.fn().mockResolvedValue({ query });
    setClaudeSdkImporterForTests(importer);

    const sdk = await loadClaudeSdkModule();

    expect(importer).toHaveBeenCalledWith("@anthropic-ai/claude-agent-sdk");
    expect(sdk.query).toBe(query);
  });

  it("throws a clear error when the SDK package is missing", async () => {
    const missing = Object.assign(new Error("not found"), { code: "ERR_MODULE_NOT_FOUND" });
    setClaudeSdkImporterForTests(vi.fn().mockRejectedValue(missing));

    await expect(loadClaudeSdkModule()).rejects.toThrow(
      'Claude backend requires "@anthropic-ai/claude-agent-sdk" to be installed.'
    );
  });

  it("rejects modules that do not expose query", async () => {
    setClaudeSdkImporterForTests(vi.fn().mockResolvedValue({}));

    await expect(loadClaudeSdkModule()).rejects.toThrow(
      'Claude Agent SDK module is missing the required "query" function.'
    );
  });

  it("caches the imported module singleton across loader helpers", async () => {
    const query = vi.fn();
    const createSdkMcpServer = vi.fn();
    const tool = vi.fn();
    const importer = vi.fn().mockResolvedValue({ query, createSdkMcpServer, tool });
    setClaudeSdkImporterForTests(importer);

    const sdk = await loadClaudeSdkModule();
    const helpers = await loadClaudeSdkMcpHelpers();
    const sdkAgain = await loadClaudeSdkModule();

    expect(importer).toHaveBeenCalledTimes(1);
    expect(sdkAgain.query).toBe(sdk.query);
    expect(helpers.createSdkMcpServer).toBe(createSdkMcpServer);
    expect(helpers.tool).toBe(tool);
  });
});
