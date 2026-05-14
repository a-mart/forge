import type { Writable } from "node:stream";

type GuardedStream = Writable & {
  write: (...args: unknown[]) => boolean;
};

type RestoreStdioGuard = () => void;

type InstallStdioEpipeGuardOptions = {
  onFatalError?: (error: Error) => void;
};

const guardedStreams = new WeakMap<GuardedStream, RestoreStdioGuard>();

export function installBackendStdioEpipeGuard(): RestoreStdioGuard {
  return installStdioEpipeGuard([process.stdout as GuardedStream, process.stderr as GuardedStream]);
}

export function installStdioEpipeGuard(
  streams: GuardedStream[],
  options: InstallStdioEpipeGuardOptions = {},
): RestoreStdioGuard {
  const restoreHandlers = streams.map((stream) => installStreamEpipeGuard(stream, options));
  return () => {
    for (const restore of restoreHandlers.reverse()) {
      restore();
    }
  };
}

function installStreamEpipeGuard(
  stream: GuardedStream,
  options: InstallStdioEpipeGuardOptions,
): RestoreStdioGuard {
  const existingRestore = guardedStreams.get(stream);
  if (existingRestore) {
    return () => {};
  }

  let pipeClosed = false;
  const originalWrite = stream.write.bind(stream);

  const handleError = (error: unknown): void => {
    if (isErrnoCode(error, "EPIPE")) {
      pipeClosed = true;
      return;
    }

    reportFatalError(error, options.onFatalError);
  };

  stream.write = (...args: unknown[]): boolean => {
    if (pipeClosed) {
      notifyWriteCallback(args);
      return false;
    }

    try {
      return originalWrite(...wrapWriteCallback(args, () => {
        pipeClosed = true;
      }));
    } catch (error) {
      if (isErrnoCode(error, "EPIPE")) {
        pipeClosed = true;
        notifyWriteCallback(args);
        return false;
      }

      throw error;
    }
  };

  stream.on("error", handleError);

  const restore = (): void => {
    stream.off("error", handleError);
    stream.write = originalWrite;
    guardedStreams.delete(stream);
  };
  guardedStreams.set(stream, restore);
  return restore;
}

function wrapWriteCallback(args: unknown[], onEpipe: () => void): unknown[] {
  const callbackIndex = findLastFunctionIndex(args);
  if (callbackIndex === -1) {
    return args;
  }

  const nextArgs = [...args];
  const callback = nextArgs[callbackIndex] as (error?: Error | null) => void;
  nextArgs[callbackIndex] = (error?: Error | null): void => {
    if (isErrnoCode(error, "EPIPE")) {
      onEpipe();
      return;
    }

    callback(error);
  };
  return nextArgs;
}

function notifyWriteCallback(args: unknown[]): void {
  const callbackIndex = findLastFunctionIndex(args);
  if (callbackIndex !== -1) {
    const callback = args[callbackIndex] as () => void;
    process.nextTick(callback);
  }
}

function findLastFunctionIndex(args: unknown[]): number {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    if (typeof args[index] === "function") {
      return index;
    }
  }

  return -1;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

function reportFatalError(error: unknown, onFatalError: ((error: Error) => void) | undefined): void {
  const fatalError = error instanceof Error ? error : new Error(String(error));
  if (onFatalError) {
    onFatalError(fatalError);
    return;
  }

  throw fatalError;
}
