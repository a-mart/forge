import { createReadStream } from "node:fs";

const MAX_SECURE_CONTROL_TOKEN_BYTES = 128;
const DEFAULT_SECURE_CONTROL_TOKEN_TIMEOUT_MS = 5_000;
const SECURE_CONTROL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export async function readDesktopSecureControlTokenFromFd(
  fd = 4,
): Promise<string> {
  const stream = createReadStream("", {
    fd,
    autoClose: true,
  });
  return await readDesktopSecureControlToken(stream);
}

export function readDesktopSecureControlToken(
  stream: NodeJS.ReadableStream,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs =
    options.timeoutMs ?? DEFAULT_SECURE_CONTROL_TOKEN_TIMEOUT_MS;
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error("Desktop secure control capability was not received"));
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timeout);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    const finish = (error?: Error, token?: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve(token!);
      }
    };
    const onData = (chunk: string | Buffer): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += bytes.byteLength;
      if (byteLength > MAX_SECURE_CONTROL_TOKEN_BYTES) {
        finish(new Error("Desktop secure control capability was invalid"));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = (): void => {
      const token = Buffer.concat(chunks).toString("utf8");
      if (!SECURE_CONTROL_TOKEN_PATTERN.test(token)) {
        finish(new Error("Desktop secure control capability was invalid"));
        return;
      }
      finish(undefined, token);
    };
    const onError = (): void => {
      finish(new Error("Desktop secure control capability was unavailable"));
    };

    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
}
