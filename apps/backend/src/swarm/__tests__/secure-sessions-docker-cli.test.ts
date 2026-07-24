import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { DockerCli } from "../secure-sessions/execution/docker-cli.js";

describe("DockerCli", () => {
  it.each([
    "ssh://builder@example.test",
    "tcp://127.0.0.1:2376",
    "npipe:////./pipe/docker_engine",
  ])("rejects non-local Docker endpoint %s", async (dockerHost) => {
    const invocations: string[][] = [];
    const cli = new DockerCli({
      command: process.execPath,
      environment: { DOCKER_HOST: dockerHost },
      onInvocation: ({ args }) => invocations.push([...args]),
    });

    await expect(cli.pinLocalEndpoint()).resolves.toBe(false);
    expect(invocations).toEqual([]);
  });

  it("pins an accepted Unix endpoint into later Docker argv", async () => {
    const invocations: string[][] = [];
    const endpoint = "unix:///tmp/forge-test-docker.sock";
    const cli = new DockerCli({
      command: process.execPath,
      environment: { DOCKER_HOST: endpoint },
      onInvocation: ({ args }) => invocations.push([...args]),
    });

    await expect(cli.pinLocalEndpoint()).resolves.toBe(true);
    await cli.run(["-e", "process.exit(0)"]);
    expect(invocations).toEqual([
      ["--host", endpoint, "-e", "process.exit(0)"],
    ]);
  });

  it("bounds a hung control-plane invocation and discards its output", async () => {
    const cli = new DockerCli({
      command: process.execPath,
      environment: {},
      controlPlaneTimeoutMs: 50,
    });
    const startedAt = performance.now();

    const result = await cli.run([
      "-e",
      "process.stdout.write('partial'); setInterval(() => {}, 1000)",
    ]);

    expect(result).toEqual({
      exitCode: -1,
      stdout: Buffer.alloc(0),
    });
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });
});
