import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexAppServerClient } from "../codex-app-server/codex-app-server-client.js";
import type { CodexAppServerClientPort } from "../codex-app-server/types.js";

const activeClients = new Set<CodexAppServerClientPort>();

function createFakeAppServerClientScript(): string {
  return String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const pendingByProbe = new Map();

rl.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.method === 'initialize') {
    send({ id: message.id, result: { capabilities: { experimentalApi: true } } });
    return;
  }

  if (message.method === 'initialized') {
    return;
  }

  if (message.method === 'probe-server-request') {
    pendingByProbe.set('elicitation', message.id);
    send({
      id: 'server-elicitation',
      method: 'mcpServer/elicitation/request',
      params: { prompt: 'Allow access?' }
    });
    return;
  }

  if (message.id === 'server-elicitation') {
    const originalId = pendingByProbe.get('elicitation');
    send({ id: originalId, result: message });
    return;
  }

  if (message.method === 'slow') {
    setTimeout(() => send({ id: message.id, result: { slow: true } }), 80);
    return;
  }

  if (message.method === 'plugin/list') {
    send({ id: message.id, result: { plugins: [] } });
  }
});
`;
}

function trackClient(client: CodexAppServerClientPort): CodexAppServerClientPort {
  activeClients.add(client);
  return client;
}

afterEach(() => {
  for (const client of activeClients) {
    client.dispose();
  }
  activeClients.clear();
});

describe("CodexAppServerClient", () => {
  it("initializes with experimentalApi and sends initialized notification", async () => {
    const client = trackClient(
      createCodexAppServerClient({}, {
        command: process.execPath,
        args: ["-e", createFakeAppServerClientScript()],
      }),
    );

    await client.connect();
    const result = await client.request<{ plugins: unknown[] }>("plugin/list");
    expect(result).toEqual({ plugins: [] });
  });

  it("times out requests and rejects further use after dispose", async () => {
    const client = trackClient(
      createCodexAppServerClient({}, {
        command: process.execPath,
        args: ["-e", createFakeAppServerClientScript()],
      }),
    );

    await client.connect();
    await expect(client.request("slow", undefined, 15)).rejects.toThrow(
      "JSON-RPC request timed out: slow",
    );

    client.dispose();
    expect(client.isDisposed()).toBe(true);
    await expect(client.request("plugin/list")).rejects.toThrow(/disposed/i);
  });

  it("responds to server elicitation requests with fail-closed decline", async () => {
    const client = trackClient(
      createCodexAppServerClient({}, {
        command: process.execPath,
        args: ["-e", createFakeAppServerClientScript()],
      }),
    );

    await client.connect();
    const result = await client.request<{ result: { action: string } }>("probe-server-request");
    expect(result.result).toEqual({
      action: "decline",
    });
  });

  it("disposes the client when initialize fails during connect", async () => {
    const client = trackClient(
      createCodexAppServerClient({}, {
        command: process.execPath,
        args: [
          "-e",
          String.raw`
const readline = require('node:readline');
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      id: message.id,
      error: { code: -32000, message: 'initialize failed' }
    }) + '\n');
  }
});
`,
        ],
      }),
    );

    await expect(client.connect()).rejects.toThrow("initialize failed");
    expect(client.isDisposed()).toBe(true);
    await expect(client.request("plugin/list")).rejects.toThrow(/disposed/i);
  });

  it("includes sanitized stderr context when Codex exits during initialization", async () => {
    const client = trackClient(
      createCodexAppServerClient(
        {},
        {
          command: process.execPath,
          args: [
            "-e",
            String.raw`
process.stderr.write('Codex vendor executable spawn failed: Bearer sk-testsecret1234567890\\n');
process.exit(1);
`,
          ],
        },
      ),
    );

    const error = await client.connect().catch((error: unknown) => error as Error);
    expect(error.message).toContain("Codex vendor executable spawn failed: Bearer [redacted-api-key]");
    expect(error.message).not.toContain("sk-testsecret");
  });

  it("forwards sanitized stderr lines to handler", async () => {
    const onStderr = vi.fn();
    const client = trackClient(
      createCodexAppServerClient(
        { onStderr },
        {
          command: process.execPath,
          args: [
            "-e",
            String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
process.stderr.write('Bearer sk-testsecret1234567890\n');
rl.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === 'initialize') {
    send({ id: message.id, result: {} });
  }
});
`,
          ],
        },
      ),
    );

    await client.connect();
    await new Promise((resolve) => setTimeout(resolve, 30));
    client.dispose();
    expect(onStderr).toHaveBeenCalled();
    expect(onStderr.mock.calls[0]?.[0]).not.toContain("sk-testsecret");
    expect(onStderr.mock.calls[0]?.[0]).toContain("[redacted");
  });
});
