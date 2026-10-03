import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { ClaudeAuthService } from "../runtime/claude/claude-auth-service.js";
import { resolveClaudeExecutable } from "../runtime/claude/claude-runtime-environment.js";
import { createClaudeAuthRoutes } from "../../ws/http/routes/claude-auth-routes.js";
import type { ClaudeAuthStatus } from "@forge/protocol";
import type { SwarmConfig } from "../types.js";

// Real bundled login + HTTP route. Isolated config, no real account or authorization code.
// Trap system launchers before starting so a regression cannot open the user's browser.
it.skipIf(process.platform === "win32")("serves a code-return link through HTTP without invoking a system browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-claude-manual-login-"));
  const bin = join(root, "bin");
  const config = join(root, "claude");
  const opened = join(root, "browser-opened");
  await mkdir(bin); await mkdir(config);
  const executable = await resolveClaudeExecutable({});
  const trap = `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(opened)}, 'invoked'); process.exit(73);\n`;
  for (const launcher of ["open", "xdg-open", "gio", "sensible-browser", "wslview"]) {
    await writeFile(join(bin, launcher), trap, { mode: 0o700 });
  }
  vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
  vi.stubEnv("HOME", root); vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("CLAUDE_CONFIG_DIR", config); vi.stubEnv("CLAUDE_BIN", executable);
  vi.stubEnv("FORGE_CLAUDE_AUTH_MODE", "cli");
  const service = new ClaudeAuthService({} as SwarmConfig);
  const [route] = createClaudeAuthRoutes(service);
  const server = createServer((request, response) => {
    void route!.handle(request, response, new URL(request.url!, "http://localhost"));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const endpoint = `http://127.0.0.1:${port}/api/settings/claude-native`;
    const start = await fetch(endpoint, { method: "POST", body: JSON.stringify({ action: "start" }) });
    expect(start.status).toBe(200);
    let state = await start.json() as ClaudeAuthStatus;
    await vi.waitFor(async () => {
      state = await (await fetch(endpoint)).json() as ClaudeAuthStatus;
      expect(state.phase).toBe("waiting");
      expect(Boolean(state.authorizationUrl)).toBe(true);
    }, { timeout: 15_000, interval: 100 });
    const url = new URL(state.authorizationUrl!);
    expect(url.searchParams.get("code")).toBe("true");
    expect(url.searchParams.get("redirect_uri")).toMatch(/^https:\/\/(platform\.claude\.com|console\.anthropic\.com)\/oauth\/code\/callback$/);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(Boolean(url.searchParams.get("state"))).toBe(true);
    expect(Boolean(url.searchParams.get("code_challenge"))).toBe(true);
    // The child emits its URL before trying its browser override. Wait for that attempt.
    await new Promise(resolve => setTimeout(resolve, 750));
    const browserInvoked = await access(opened).then(() => true, () => false);
    expect(browserInvoked).toBe(false);
    const cancelled = await fetch(endpoint, { method: "DELETE", body: JSON.stringify({ flowId: state.flowId }) });
    expect(cancelled.status).toBe(200);
    const final = await cancelled.json() as ClaudeAuthStatus;
    expect(final.phase).toBe("idle");
    expect(final.authorizationUrl).toBeUndefined();
    const artifactDir = fileURLToPath(new URL("../../../../../.internal/claude-auth/", import.meta.url));
    await mkdir(artifactDir, { recursive: true });
    const artifact = join(artifactDir, "manual-sign-in-acceptance.json");
    await writeFile(artifact, JSON.stringify({ platform: process.platform, browserInvoked, codeRequested: true,
      redirectUri: url.searchParams.get("redirect_uri"), oauthStatePresent: true, pkcePresent: true, cancelled: true }, null, 2) + "\n");
    expect(JSON.parse(await readFile(artifact, "utf8")).browserInvoked).toBe(false);
  } finally {
    await service.shutdown();
    await new Promise<void>(resolve => server.close(() => resolve()));
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 25_000);
