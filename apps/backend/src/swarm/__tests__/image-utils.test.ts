import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  meetsProviderMinImageDimension,
  prepareProviderImage,
  readImageDimensions,
  resizeImageIfNeeded,
} from "../runtime/image-utils.js";

async function pngBase64(width: number, height: number): Promise<string> {
  return (await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  }).png().toBuffer()).toString("base64");
}

describe("image-utils provider dimension policy", () => {
  it.each([
    [1, 1, false],
    [2, 2, false],
    [7, 10, false],
    [10, 7, false],
    [8, 8, true],
    [1920, 1080, true],
  ] as const)("%i×%i meets the provider minimum: %s", (width, height, expected) => {
    expect(meetsProviderMinImageDimension(width, height)).toBe(expected);
  });

  it("omits 1×1, 2×2, and 7×10 images at request time", async () => {
    for (const [width, height] of [[1, 1], [2, 2], [7, 10]] as const) {
      const data = await pngBase64(width, height);
      await expect(prepareProviderImage(data, "image/png")).resolves.toEqual({
        action: "omit",
        reason: "below-min-dimension",
        width,
        height,
      });
    }
  });

  it("keeps 8×8 images without resizing", async () => {
    const data = await pngBase64(8, 8);
    await expect(prepareProviderImage(data, "image/png")).resolves.toEqual({
      action: "keep",
      data,
      mimeType: "image/png",
      resized: false,
    });
    await expect(resizeImageIfNeeded(data, "image/png")).resolves.toEqual({
      data,
      mimeType: "image/png",
      resized: false,
    });
  });

  it("downsizes oversized images while leaving the original payload unused", async () => {
    const data = await pngBase64(2000, 1000);
    const prepared = await prepareProviderImage(data, "image/png");
    expect(prepared).toMatchObject({ action: "keep", resized: true, mimeType: "image/png" });
    if (prepared.action !== "keep") return;
    expect(prepared.data).not.toBe(data);
    await expect(readImageDimensions(prepared.data)).resolves.toEqual({ width: 1920, height: 960 });
  });

  it("does not enlarge or omit via resizeImageIfNeeded alone", async () => {
    const data = await pngBase64(1, 1);
    await expect(resizeImageIfNeeded(data, "image/png")).resolves.toEqual({
      data,
      mimeType: "image/png",
      resized: false,
    });
  });
});
