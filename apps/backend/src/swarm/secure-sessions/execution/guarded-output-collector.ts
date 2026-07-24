import { Buffer } from "node:buffer";
import type {
  GuardedSecureOutput,
  SecureOutputGuard,
  SecureOutputStream,
} from "./secure-execution-backend.js";
import { SecureExecutionError } from "./secure-execution-error.js";

interface GuardedOutputCollectorOptions {
  guard: SecureOutputGuard;
  onOutput?: (output: GuardedSecureOutput) => void | Promise<void>;
  maxBytes: number;
  onFailure: (error: SecureExecutionError) => void;
}

export class GuardedOutputCollector {
  private readonly options: GuardedOutputCollectorOptions;
  private chain: Promise<void> = Promise.resolve();
  private failure: SecureExecutionError | undefined;
  private retainedBytes = 0;
  private readonly stdout: Buffer[] = [];
  private readonly stderr: Buffer[] = [];

  constructor(options: GuardedOutputCollectorOptions) {
    this.options = options;
  }

  accept(stream: SecureOutputStream, unguarded: Uint8Array): Promise<void> {
    const owned = Buffer.from(unguarded);
    return this.enqueue(async () => {
      try {
        await this.guardAndRetain(stream, owned, false);
      } finally {
        owned.fill(0);
      }
    });
  }

  async finish(): Promise<{ stdout: Buffer; stderr: Buffer }> {
    await this.enqueue(async () => {
      await this.guardAndRetain("stdout", Buffer.alloc(0), true);
      await this.guardAndRetain("stderr", Buffer.alloc(0), true);
    });
    await this.chain;

    if (this.failure) {
      throw this.failure;
    }
    return {
      stdout: Buffer.concat(this.stdout),
      stderr: Buffer.concat(this.stderr),
    };
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (this.failure) {
        return;
      }
      try {
        await operation();
      } catch {
        this.fail(new SecureExecutionError("GUARD_FAILED"));
      }
    });
    return this.chain;
  }

  private async guardAndRetain(
    stream: SecureOutputStream,
    bytes: Uint8Array,
    final: boolean,
  ): Promise<void> {
    let guarded: Uint8Array;
    try {
      guarded = await this.options.guard({ stream, bytes, final });
    } catch {
      throw new SecureExecutionError("GUARD_FAILED");
    }

    if (!(guarded instanceof Uint8Array)) {
      throw new SecureExecutionError("GUARD_FAILED");
    }

    const retained = Buffer.from(guarded);
    this.retainedBytes += retained.byteLength;
    if (this.retainedBytes > this.options.maxBytes) {
      retained.fill(0);
      this.fail(new SecureExecutionError("OUTPUT_LIMIT_EXCEEDED"));
      return;
    }
    if (retained.byteLength === 0) {
      return;
    }

    (stream === "stdout" ? this.stdout : this.stderr).push(retained);
    if (this.options.onOutput) {
      try {
        await this.options.onOutput({
          stream,
          bytes: Buffer.from(retained),
        });
      } catch {
        throw new SecureExecutionError("GUARD_FAILED");
      }
    }
  }

  private fail(error: SecureExecutionError): void {
    if (this.failure) {
      return;
    }
    this.failure = error;
    this.options.onFailure(error);
  }
}
