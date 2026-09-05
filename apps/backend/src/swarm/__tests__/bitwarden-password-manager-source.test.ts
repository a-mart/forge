import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { BitwardenPasswordManagerCommandClient } from "../secure-sessions/sources/bitwarden-password-manager-source.js";
import { HostOnlySecret } from "../secure-sessions/sources/host-only-secret.js";

const COLLECTION_A = "11111111-1111-4111-8111-111111111111";
const COLLECTION_B = "22222222-2222-4222-8222-222222222222";
const ORGANIZATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM = "33333333-3333-4333-8333-333333333333";
const SESSION_KEY = "synthetic-session-key-with-enough-bytes";

afterEach(() => {
  spawnMock.mockReset();
  vi.restoreAllMocks();
});

describe("BitwardenPasswordManagerCommandClient", () => {
  it("reuses only collection metadata and invalidates it on expiry, sync and lock", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    spawnMock.mockImplementation((_executable: string, args: string[]) => {
      if (args[0] === "unlock") return fakeChild(SESSION_KEY);
      if (args[0] === "status") return fakeChild(JSON.stringify({ status: "unlocked" }));
      if (args[0] === "list") return fakeChild(JSON.stringify([
        { id: COLLECTION_A, organizationId: ORGANIZATION, name: "Infrastructure" },
      ]));
      return fakeChild("");
    });
    const client = new BitwardenPasswordManagerCommandClient("fake-bw");
    await client.unlock(Buffer.from("synthetic-master-password"));
    const first = await client.listCollections();
    first[0]!.name = "Changed by consumer";
    expect((await client.listCollections())[0]!.name).toBe("Infrastructure");
    const lists = () => spawnMock.mock.calls.filter((call) => call[1][0] === "list").length;
    expect(lists()).toBe(1);
    now += 60_001;
    await client.listCollections();
    expect(lists()).toBe(2);
    await client.sync();
    await client.listCollections();
    expect(lists()).toBe(3);
    await client.lock();
    await expect(client.listCollections()).rejects.toThrow("SECURE_SOURCE_LOCKED");
    await client.unlock(Buffer.from("synthetic-master-password"));
    await client.listCollections();
    expect(lists()).toBe(4);
    client.dispose();
  });

  it("launches npm-style Windows command shims through cmd.exe without shell interpolation", async () => {
    spawnMock.mockImplementation((
      _executable: string,
      _args: string[],
    ) => fakeChild(JSON.stringify({ status: "locked" })));
    const client = new BitwardenPasswordManagerCommandClient({
      executablePath: "C:\\Program Files\\nodejs\\bw.cmd",
      source: "configured",
      platform: "win32",
      commandShell: "C:\\Windows\\System32\\cmd.exe",
    });

    await expect(client.status()).resolves.toMatchObject({ state: "locked" });

    expect(spawnMock).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\cmd.exe",
      [
        "/d",
        "/s",
        "/c",
        '""C:\\Program Files\\nodejs\\bw.cmd" "status""',
      ],
      expect.objectContaining({ windowsHide: true }),
    );
    client.dispose();
  });

  it("keeps unlock material out of arguments and reuses only the in-memory session", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    spawnMock.mockImplementation((
      _executable: string,
      args: string[],
      options: { env: NodeJS.ProcessEnv },
    ) => {
      calls.push({ args: [...args], env: { ...options.env } });
      if (args[0] === "unlock") return fakeChild(SESSION_KEY);
      if (args[0] === "status") {
        return fakeChild(JSON.stringify({
          status: options.env.BW_SESSION ? "unlocked" : "locked",
          userEmail: "forge@example.test",
          serverUrl: "https://vault.example.test",
        }));
      }
      if (args[0] === "sync") return fakeChild("");
      if (args[0] === "list" && args[1] === "collections") {
        return fakeChild(JSON.stringify([
          { id: COLLECTION_A, organizationId: ORGANIZATION, name: "Infrastructure" },
          { id: COLLECTION_B, organizationId: ORGANIZATION, name: "Development" },
        ]));
      }
      if (args[0] === "list" && args[1] === "items") {
        return fakeChild(JSON.stringify([{
          id: ITEM,
          name: "Ansible Vault",
          type: 1,
          collectionIds: [COLLECTION_A, COLLECTION_B],
          revisionDate: "2026-08-31T12:00:00.000Z",
          login: { password: "must-not-enter-catalog" },
        }]));
      }
      if (args[0] === "get" && args[1] === "item") {
        return fakeChild(JSON.stringify({
          id: ITEM,
          type: 1,
          collectionIds: [COLLECTION_A],
          revisionDate: "2026-08-31T12:00:00.000Z",
          login: { password: "synthetic-resolved-password" },
        }));
      }
      if (args[0] === "lock") return fakeChild("");
      return fakeChild("", 1);
    });

    const client = new BitwardenPasswordManagerCommandClient("fake-bw", 5_000);
    const masterPassword = Buffer.from("synthetic-master-password");
    try {
      await expect(client.unlock(masterPassword)).resolves.toEqual({
        state: "available",
        accountEmail: "forge@example.test",
        serverUrl: "https://vault.example.test",
      });
      const unlockCall = calls.find(({ args }) => args[0] === "unlock")!;
      const passwordVariable = unlockCall.args.at(-1)!;
      expect(unlockCall.args).toEqual([
        "unlock",
        "--raw",
        "--passwordenv",
        passwordVariable,
      ]);
      expect(unlockCall.args).not.toContain("synthetic-master-password");
      expect(unlockCall.env[passwordVariable]).toBe("synthetic-master-password");
      expect(unlockCall.env.BW_SESSION).toBeUndefined();

      await expect(client.listCollections()).resolves.toEqual([
        { id: COLLECTION_B, organizationId: ORGANIZATION, name: "Development" },
        { id: COLLECTION_A, organizationId: ORGANIZATION, name: "Infrastructure" },
      ]);
      await expect(client.sync()).resolves.toBeUndefined();
      expect(calls.at(-1)?.args).toEqual(["sync"]);
      await expect(client.listItems([COLLECTION_A, COLLECTION_B])).resolves.toEqual([{
        id: ITEM,
        name: "Ansible Vault",
        username: null,
        collectionIds: [COLLECTION_A, COLLECTION_B],
        revisionDate: "2026-08-31T12:00:00.000Z",
      }]);
      const resolved = await client.getSecret({
        itemId: ITEM,
        allowedCollectionIds: [COLLECTION_A],
      });
      await expect(resolved.material.withBytes((bytes) => bytes.toString("utf8")))
        .resolves.toBe("synthetic-resolved-password");
      resolved.material.release();

      for (const call of calls.filter(({ args }) => args[0] !== "unlock")) {
        expect(call.env.BW_SESSION).toBe(SESSION_KEY);
      }
      await client.lock();
      expect(calls.at(-1)?.args).toEqual(["lock"]);
      await expect(client.status()).resolves.toMatchObject({ state: "locked" });
      expect(calls.at(-1)?.env.BW_SESSION).toBeUndefined();
    } finally {
      masterPassword.fill(0);
      client.dispose();
    }
  });

  it("creates a login through stdin without putting its password in Windows arguments or environment", async () => {
    let createdChild: ReturnType<typeof fakeChild> | null = null;
    let createdEnvironment: NodeJS.ProcessEnv | null = null;
    let createdInput: Buffer | null = null;
    spawnMock.mockImplementation((
      _executable: string,
      args: string[],
      options: { env: NodeJS.ProcessEnv },
    ) => {
      if (args.some((arg) => arg.includes("status"))) {
        return fakeChild(JSON.stringify({ status: "unlocked" }));
      }
      createdEnvironment = { ...options.env };
      createdChild = fakeChild(JSON.stringify({
        id: ITEM,
        name: "Production login",
        type: 1,
        collectionIds: [COLLECTION_A],
        revisionDate: "2026-09-02T12:00:00.000Z",
        login: { username: "deploy-user" },
      }));
      createdChild.stdin.end.mockImplementation((value: Buffer) => {
        createdInput = Buffer.from(value);
      });
      return createdChild;
    });
    const client = new BitwardenPasswordManagerCommandClient({
      executablePath: "C:\\Program Files\\nodejs\\bw.cmd",
      source: "configured",
      platform: "win32",
      commandShell: "C:\\Windows\\System32\\cmd.exe",
    });
    const password = new HostOnlySecret(Buffer.from("private-generated-password"));
    try {
      // Establish the same memory-only session used by createItem.
      spawnMock.mockImplementationOnce(() => fakeChild(SESSION_KEY));
      const masterPassword = Buffer.from("synthetic-master-password");
      try {
        await client.unlock(masterPassword);
      } finally {
        masterPassword.fill(0);
      }

      const created = await client.createItem({
        name: "Production login",
        username: "deploy-user",
        collectionId: COLLECTION_A,
        organizationId: ORGANIZATION,
        material: password,
      });

      expect(created).toEqual({
        id: ITEM,
        name: "Production login",
        username: "deploy-user",
        collectionIds: [COLLECTION_A],
        revisionDate: "2026-09-02T12:00:00.000Z",
      });
      const invocation = spawnMock.mock.calls.at(-1)!;
      expect(invocation[0]).toBe("C:\\Windows\\System32\\cmd.exe");
      expect(invocation[1]).toEqual([
        "/d",
        "/s",
        "/c",
        '""C:\\Program Files\\nodejs\\bw.cmd" "create" "item""',
      ]);
      expect(JSON.stringify(invocation)).not.toContain("private-generated-password");
      expect(createdEnvironment!.BW_SESSION).toBe(SESSION_KEY);
      expect(Object.values(createdEnvironment!)).not.toContain("private-generated-password");

      const item = JSON.parse(
        Buffer.from(createdInput!.toString("utf8"), "base64").toString("utf8"),
      );
      expect(item).toEqual({
        type: 1,
        name: "Production login",
        organizationId: ORGANIZATION,
        collectionIds: [COLLECTION_A],
        login: {
          username: "deploy-user",
          password: "private-generated-password",
        },
      });
    } finally {
      createdInput?.fill(0);
      password.release();
      client.dispose();
    }
  });

  it("drops a rejected session and rechecks the account without it", async () => {
    let sessionStatusCalls = 0;
    spawnMock.mockImplementation((
      _executable: string,
      args: string[],
      options: { env: NodeJS.ProcessEnv },
    ) => {
      if (args[0] === "unlock") return fakeChild(SESSION_KEY);
      if (args[0] === "status" && options.env.BW_SESSION) {
        sessionStatusCalls += 1;
        return sessionStatusCalls === 1
          ? fakeChild(JSON.stringify({ status: "unlocked" }))
          : fakeChild("", 1);
      }
      if (args[0] === "status") {
        return fakeChild(JSON.stringify({ status: "locked" }));
      }
      return fakeChild("", 1);
    });

    const client = new BitwardenPasswordManagerCommandClient("fake-bw", 5_000);
    const password = Buffer.from("synthetic-master-password");
    try {
      await client.unlock(password);
      await expect(client.status()).resolves.toEqual({
        state: "locked",
        accountEmail: null,
        serverUrl: null,
      });
    } finally {
      password.fill(0);
      client.dispose();
    }
  });
});

function fakeChild(stdout: string, exitCode = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  child.kill = vi.fn();
  queueMicrotask(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    child.emit("close", exitCode);
  });
  return child;
}
