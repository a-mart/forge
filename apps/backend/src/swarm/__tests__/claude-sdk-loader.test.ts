import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeSdkUnavailableError,
  isClaudeSdkUnavailableError,
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
    expect(sdk.pathToClaudeCodeExecutable).toMatch(/[/\\]cli\.js$/);
  });

  it("throws a clear error when the SDK package is missing", async () => {
    const missing = Object.assign(new Error("not found"), { code: "ERR_MODULE_NOT_FOUND" });
    setClaudeSdkImporterForTests(vi.fn().mockRejectedValue(missing));

    let thrown: unknown;
    try {
      await loadClaudeSdkModule();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ClaudeSdkUnavailableError);
    expect(isClaudeSdkUnavailableError(thrown)).toBe(true);
    expect((thrown as Error).message).toBe('Claude backend requires "@anthropic-ai/claude-agent-sdk" to be installed.');
  });

  it("classifies native-load failures as SDK unavailability", async () => {
    const nativeFailure = Object.assign(new Error("dlopen(/tmp/audio-capture.node) failed"), {
      code: "ERR_DLOPEN_FAILED"
    });
    setClaudeSdkImporterForTests(vi.fn().mockRejectedValue(nativeFailure));

    let thrown: unknown;
    try {
      await loadClaudeSdkModule();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ClaudeSdkUnavailableError);
    expect(isClaudeSdkUnavailableError(thrown)).toBe(true);
    expect((thrown as Error).message).toContain("Claude Agent SDK is unavailable in this environment.");
    expect((thrown as Error).message).toContain("dlopen(/tmp/audio-capture.node) failed");
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
    expect(sdkAgain.pathToClaudeCodeExecutable).toBe(sdk.pathToClaudeCodeExecutable);
    expect(helpers.createSdkMcpServer).toBe(createSdkMcpServer);
    expect(helpers.tool).toBe(tool);
  });
});
