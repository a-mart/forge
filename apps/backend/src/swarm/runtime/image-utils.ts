import sharp from "sharp";

const DEFAULT_MAX_DIMENSION = 1920;

interface ResizeResult {
  data: string;
  mimeType: string;
  resized: boolean;
}

/**
 * Resize a base64-encoded image if either dimension exceeds maxDimension.
 * Maintains aspect ratio and re-encodes in the original format.
 * Returns the original on failure or if no resize is needed.
 */
export async function resizeImageIfNeeded(
  data: string,
  mimeType: string,
  maxDimension: number = DEFAULT_MAX_DIMENSION
): Promise<ResizeResult> {
  try {
    const buffer = Buffer.from(data, "base64");
    const image = sharp(buffer);
    const metadata = await image.metadata();

    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;

    if (width <= maxDimension && height <= maxDimension) {
      return { data, mimeType, resized: false };
    }

    const format = toSharpFormat(mimeType);
    const resized = image.resize({
      width: maxDimension,
      height: maxDimension,
      fit: "inside",
      withoutEnlargement: true
    });

    const formatted = applyFormat(resized, format);
    const outputBuffer = await formatted.toBuffer();
    const resizedMetadata = await sharp(outputBuffer).metadata();

    const originalSizeKB = Math.round(buffer.length / 1024);
    const newSizeKB = Math.round(outputBuffer.length / 1024);
    const newWidth = resizedMetadata.width ?? 0;
    const newHeight = resizedMetadata.height ?? 0;

    console.log(
      `[image-resize] Resized ${width}×${height} → ${newWidth}×${newHeight} ` +
        `(${originalSizeKB}KB → ${newSizeKB}KB, ${format})`
    );

    return {
      data: outputBuffer.toString("base64"),
      mimeType: toMimeType(format),
      resized: true
    };
  } catch (error) {
    console.warn("[image-resize] Failed to process image, using original:", error);
    return { data, mimeType, resized: false };
  }
}

type SharpFormat = "jpeg" | "png" | "webp" | "gif" | "tiff" | "avif";

function toSharpFormat(mimeType: string): SharpFormat {
  const lower = mimeType.toLowerCase();
  if (lower.includes("png")) return "png";
  if (lower.includes("webp")) return "webp";
  if (lower.includes("gif")) return "gif";
  if (lower.includes("tiff")) return "tiff";
  if (lower.includes("avif")) return "avif";
  return "jpeg";
}

function toMimeType(format: SharpFormat): string {
  switch (format) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "tiff":
      return "image/tiff";
    case "avif":
      return "image/avif";
    case "jpeg":
    default:
      return "image/jpeg";
  }
}

function applyFormat(pipeline: sharp.Sharp, format: SharpFormat): sharp.Sharp {
  switch (format) {
    case "jpeg":
      return pipeline.jpeg({ quality: 85 });
    case "png":
      return pipeline.png({ compressionLevel: 6 });
    case "webp":
      return pipeline.webp({ quality: 85 });
    case "gif":
      return pipeline.gif();
    case "tiff":
      return pipeline.tiff({ quality: 85 });
    case "avif":
      return pipeline.avif({ quality: 65 });
    default:
      return pipeline.jpeg({ quality: 85 });
  }
}
