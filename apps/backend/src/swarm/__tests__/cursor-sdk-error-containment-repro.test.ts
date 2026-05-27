import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

type ChildResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

async function runStrictNodeScript(script: string): Promise<ChildResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "--eval", script], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

describe("Cursor SDK crash containment reproduction", () => {
  it("shows strict detached rejections surface through uncaughtException with preserved ALS attribution", async () => {
    const script = `
      import { AsyncLocalStorage } from "node:async_hooks";

      const als = new AsyncLocalStorage();
      process.once("uncaughtException", (error, origin) => {
        console.log(JSON.stringify({
          origin,
          store: als.getStore(),
          errorName: error?.name,
          errorMessage: error?.message,
          errorCode: error?.code
        }));
        process.exit(0);
      });

      als.run({ agentId: "worker-1", token: 7 }, () => {
        Promise.resolve().then(() => {
          const error = new Error("ConnectError: [unauthenticated] ERROR_NOT_LOGGED_IN");
          error.name = "ConnectError";
          error.code = 16;
          Promise.reject(error);
        });
      });
    `;

    const result = await runStrictNodeScript(script);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout.trim())).toEqual({
      origin: "unhandledRejection",
      store: { agentId: "worker-1", token: 7 },
      errorName: "ConnectError",
      errorMessage: "ConnectError: [unauthenticated] ERROR_NOT_LOGGED_IN",
      errorCode: 16
    });
  });

  it("reproduces a detached background auth/connect rejection escaping an awaited send/stream/wait try-catch", async () => {
    const script = `
      const result = { caught: false, completed: false };

      process.once("uncaughtException", (error, origin) => {
        console.log(JSON.stringify({
          ...result,
          origin,
          errorName: error?.name,
          errorMessage: error?.message,
          errorCode: error?.code
        }));
        process.exit(0);
      });

      async function send() {
        queueMicrotask(() => {
          const error = new Error("ConnectError: [unauthenticated] ERR_NOT_LOGGED_IN");
          error.name = "ConnectError";
          error.code = "ERR_NOT_LOGGED_IN";
          Promise.reject(error);
        });

        return {
          async *stream() {
            yield { type: "assistant", text: "ok" };
          },
          async wait() {
            return { status: "finished" };
          }
        };
      }

      async function dispatchPrompt() {
        try {
          const run = await send();
          for await (const _message of run.stream()) {}
          await run.wait();
          result.completed = true;
        } catch {
          result.caught = true;
        }
      }

      await dispatchPrompt();
    `;

    const result = await runStrictNodeScript(script);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout.trim())).toEqual({
      caught: false,
      completed: true,
      origin: "unhandledRejection",
      errorName: "ConnectError",
      errorMessage: "ConnectError: [unauthenticated] ERR_NOT_LOGGED_IN",
      errorCode: "ERR_NOT_LOGGED_IN"
    });
  });
});
