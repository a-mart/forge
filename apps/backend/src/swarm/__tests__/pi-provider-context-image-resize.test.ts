import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const imageUtilsMockState = vi.hoisted(() => ({
  resizeImageIfNeeded: vi.fn()
}));

vi.mock("../runtime/image-utils.js", () => ({
  resizeImageIfNeeded: (...args: unknown[]) => imageUtilsMockState.resizeImageIfNeeded(...args)
}));

import {
  installPiProviderContextImageResize,
  resizePiProviderContextImages
} from "../runtime/pi/pi-runtime-creator.js";

type ProviderContextMessages = Parameters<typeof resizePiProviderContextImages>[0];

function asProviderContextMessages(value: unknown): ProviderContextMessages {
  return value as ProviderContextMessages;
}

describe("Pi provider context image resize", () => {
  beforeEach(() => {
    imageUtilsMockState.resizeImageIfNeeded.mockReset();
    imageUtilsMockState.resizeImageIfNeeded.mockImplementation(async (data: string, mimeType: string) => ({
      data: `resized:${data}`,
      mimeType,
      resized: true
    }));
  });

  it("resizes historical user and tool-result images without mutating canonical messages", async () => {
    const textBlock = { type: "text", text: "keep me" };
    const untouchedAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "unchanged" }],
      timestamp: 3
    };
    const messages = asProviderContextMessages([
      {
        role: "user",
        content: [textBlock, { type: "image", data: "historical-user", mimeType: "image/png" }],
        timestamp: 1
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read_image",
        content: [{ type: "image", data: "historical-tool", mimeType: "image/jpeg", extra: "preserved" }],
        isError: false,
        timestamp: 2
      },
      untouchedAssistant
    ]);
    const canonicalSnapshot = structuredClone(messages);

    const resized = await resizePiProviderContextImages(messages);

    expect(imageUtilsMockState.resizeImageIfNeeded).toHaveBeenNthCalledWith(1, "historical-user", "image/png");
    expect(imageUtilsMockState.resizeImageIfNeeded).toHaveBeenNthCalledWith(2, "historical-tool", "image/jpeg");
    expect(resized).toEqual([
      {
        role: "user",
        content: [textBlock, { type: "image", data: "resized:historical-user", mimeType: "image/png" }],
        timestamp: 1
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read_image",
        content: [{
          type: "image",
          data: "resized:historical-tool",
          mimeType: "image/jpeg",
          extra: "preserved"
        }],
        isError: false,
        timestamp: 2
      },
      untouchedAssistant
    ]);
    expect(messages).toEqual(canonicalSnapshot);
    expect(resized[2]).toBe(untouchedAssistant);
  });

  it("structurally covers custom messages and preserves invalid image-like blocks", async () => {
    const invalidBlocks = [
      { type: "image", data: "", mimeType: "image/png" },
      { type: "image", data: "not-an-image", mimeType: "application/octet-stream" },
      { type: "text", text: "plain" }
    ];
    const messages = asProviderContextMessages([
      {
        role: "custom",
        customType: "extension-context",
        content: [
          ...invalidBlocks,
          { type: "image", data: "extension-image", mimeType: "IMAGE/WEBP" }
        ],
        timestamp: 1
      }
    ]);

    const resized = await resizePiProviderContextImages(messages);

    expect(imageUtilsMockState.resizeImageIfNeeded).toHaveBeenCalledOnce();
    expect(imageUtilsMockState.resizeImageIfNeeded).toHaveBeenCalledWith("extension-image", "IMAGE/WEBP");
    expect((resized[0] as { content: unknown[] }).content).toEqual([
      ...invalidBlocks,
      { type: "image", data: "resized:extension-image", mimeType: "IMAGE/WEBP" }
    ]);
  });

  it("runs the existing transform first, forwards its signal, and resizes its output", async () => {
    const originalMessages = asProviderContextMessages([
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }
    ]);
    const transformedMessages = asProviderContextMessages([
      ...originalMessages,
      {
        role: "custom",
        content: [{ type: "image", data: "extension-added", mimeType: "image/png" }],
        timestamp: 2
      }
    ]);
    const existingTransform = vi.fn(async () => transformedMessages);
    const agent = { transformContext: existingTransform };
    const session = { agent } as unknown as AgentSession;
    const signal = new AbortController().signal;

    installPiProviderContextImageResize(session);
    const result = await agent.transformContext?.(originalMessages, signal);

    expect(existingTransform).toHaveBeenCalledWith(originalMessages, signal);
    expect(imageUtilsMockState.resizeImageIfNeeded).toHaveBeenCalledWith("extension-added", "image/png");
    expect((result?.[1] as { content: Array<{ data: string }> }).content[0]?.data).toBe("resized:extension-added");
    expect(transformedMessages[1]).toEqual({
      role: "custom",
      content: [{ type: "image", data: "extension-added", mimeType: "image/png" }],
      timestamp: 2
    });
  });

  it("falls back to the original messages when the existing transform rejects", async () => {
    const originalMessages = asProviderContextMessages([
      {
        role: "user",
        content: [{ type: "image", data: "original-image", mimeType: "image/png" }],
        timestamp: 1
      }
    ]);
    const existingTransform = vi.fn().mockRejectedValue(new Error("extension transform failed"));
    const agent = { transformContext: existingTransform };
    const session = { agent } as unknown as AgentSession;

    installPiProviderContextImageResize(session);
    const result = await agent.transformContext?.(originalMessages);

    expect(existingTransform).toHaveBeenCalledWith(originalMessages, undefined);
    expect(imageUtilsMockState.resizeImageIfNeeded).toHaveBeenCalledWith("original-image", "image/png");
    expect((result?.[0] as { content: Array<{ data: string }> }).content[0]?.data).toBe("resized:original-image");
    expect(originalMessages[0]).toEqual({
      role: "user",
      content: [{ type: "image", data: "original-image", mimeType: "image/png" }],
      timestamp: 1
    });
  });

  it("returns the prior-transform output when image resizing unexpectedly rejects", async () => {
    const originalMessages = asProviderContextMessages([
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }
    ]);
    const transformedMessages = asProviderContextMessages([
      {
        role: "custom",
        content: [
          { type: "image", data: "first-image", mimeType: "image/png" },
          { type: "image", data: "rejected-image", mimeType: "image/jpeg" }
        ],
        timestamp: 2
      }
    ]);
    imageUtilsMockState.resizeImageIfNeeded.mockImplementation(async (data: string, mimeType: string) => {
      if (data === "rejected-image") {
        throw new Error("unexpected resize rejection");
      }
      return { data: `resized:${data}`, mimeType, resized: true };
    });
    const existingTransform = vi.fn(async () => transformedMessages);
    const agent = { transformContext: existingTransform };
    const session = { agent } as unknown as AgentSession;

    installPiProviderContextImageResize(session);
    const result = await agent.transformContext?.(originalMessages);

    expect(result).toBe(transformedMessages);
    expect(transformedMessages[0]).toEqual({
      role: "custom",
      content: [
        { type: "image", data: "first-image", mimeType: "image/png" },
        { type: "image", data: "rejected-image", mimeType: "image/jpeg" }
      ],
      timestamp: 2
    });
  });

  it("processes provider-context images sequentially in message and block order", async () => {
    let activeResizeCalls = 0;
    let maxActiveResizeCalls = 0;
    imageUtilsMockState.resizeImageIfNeeded.mockImplementation(async (data: string, mimeType: string) => {
      activeResizeCalls += 1;
      maxActiveResizeCalls = Math.max(maxActiveResizeCalls, activeResizeCalls);
      await Promise.resolve();
      activeResizeCalls -= 1;
      return { data: `resized:${data}`, mimeType, resized: true };
    });
    const messages = asProviderContextMessages([
      {
        role: "user",
        content: [
          { type: "image", data: "first", mimeType: "image/png" },
          { type: "image", data: "second", mimeType: "image/png" }
        ],
        timestamp: 1
      },
      {
        role: "toolResult",
        content: [{ type: "image", data: "third", mimeType: "image/jpeg" }],
        timestamp: 2
      }
    ]);

    await resizePiProviderContextImages(messages);

    expect(maxActiveResizeCalls).toBe(1);
    expect(imageUtilsMockState.resizeImageIfNeeded.mock.calls).toEqual([
      ["first", "image/png"],
      ["second", "image/png"],
      ["third", "image/jpeg"]
    ]);
  });

  it("preserves the original array when no image changes", async () => {
    imageUtilsMockState.resizeImageIfNeeded.mockResolvedValue({
      data: "already-small",
      mimeType: "image/png",
      resized: false
    });
    const messages = asProviderContextMessages([
      {
        role: "user",
        content: [{ type: "image", data: "already-small", mimeType: "image/png" }],
        timestamp: 1
      }
    ]);

    const resized = await resizePiProviderContextImages(messages);

    expect(resized).toBe(messages);
    expect(resized[0]).toBe(messages[0]);
  });
});
