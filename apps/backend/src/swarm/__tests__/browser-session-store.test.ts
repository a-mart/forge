import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserSessionSnapshot, BrowserTabSnapshot } from "@forge/protocol";
import { BrowserSessionStore } from "../browser-automation/browser-session-store.js";

const roots: string[] = [];
const now = () => "2026-07-22T12:00:00.000Z";

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "forge-browser-store-"));
  roots.push(value);
  return value;
}

function tab(): BrowserTabSnapshot {
  return {
    targetAffinity: "managed-electron",
    tabId: "tab-1",
    sessionAgentId: "manager-1",
    profileId: "profile-1",
    url: "https://example.com/",
    title: "Example",
    lifecycle: "ready",
    loading: false,
    live: true,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1,
    controller: "none",
    agentCursor: null,
    recording: null,
    viewportSetting: { mode: "freeform", width: 800, height: 600 },
    renderedViewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    error: null,
    createdAt: now(),
    updatedAt: now(),
  };
}

function snapshot(store: BrowserSessionStore): BrowserSessionSnapshot {
  return {
    ...store.createEmpty("profile-1", "manager-1"),
    tabs: [tab()],
    activeTabId: "tab-1",
    defaultTabId: "tab-1",
    revision: 3,
    recentActions: [{
      id: "action-1",
      operation: "snapshot",
      tabId: "tab-1",
      status: "succeeded",
      startedAt: now(),
      completedAt: now(),
      elapsedMs: 10,
    }],
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("BrowserSessionStore", () => {
  it("writes atomically and reloads metadata after service restart", async () => {
    const dataDir = await root();
    const store = new BrowserSessionStore({ dataDir, now });
    await store.save(snapshot(store));

    const restarted = new BrowserSessionStore({ dataDir, now });
    await expect(restarted.load("profile-1", "manager-1")).resolves.toMatchObject({
      revision: 3,
      defaultTabId: "tab-1",
      tabs: [{ tabId: "tab-1", url: "https://example.com/" }],
    });
    const entries = await readdir(join(dataDir, "profiles", "profile-1", "sessions", "manager-1"));
    expect(entries).toEqual(["browser.json"]);
  });

  it("accepts agent-idle live state but never claims a physical External Chrome attachment after restart", async () => {
    const dataDir = await root();
    const store = new BrowserSessionStore({ dataDir, now });
    const state = snapshot(store);
    state.tabs = [{ ...tab(), targetAffinity: "external-chrome", controller: "agent-idle" }];
    await store.save(state);
    const persisted = JSON.parse(await readFile(store.getStatePath("profile-1", "manager-1"), "utf8"));
    expect(persisted.tabs).toMatchObject([{ targetAffinity: "external-chrome", controller: "agent-idle" }]);

    const restarted = new BrowserSessionStore({ dataDir, now });
    await expect(restarted.load("profile-1", "manager-1")).resolves.toMatchObject({
      tabs: [{ targetAffinity: "external-chrome", live: false, controller: "none" }],
    });
  });

  it("defaults legacy persisted session and tab host kinds to Managed Electron", async () => {
    const dataDir = await root();
    const store = new BrowserSessionStore({ dataDir, now });
    await store.save(snapshot(store));
    const path = store.getStatePath("profile-1", "manager-1");
    const legacy = JSON.parse(await readFile(path, "utf8"));
    legacy.schemaVersion = 1;
    legacy.hostKind = "managed-electron";
    legacy.tabs[0].hostKind = "managed-electron";
    delete legacy.tabs[0].targetAffinity;
    await writeFile(path, JSON.stringify(legacy), "utf8");
    await expect(store.load("profile-1", "manager-1")).resolves.toMatchObject({
      schemaVersion: 2,
      tabs: [{ targetAffinity: "managed-electron" }],
    });
  });

  it("rejects duplicate logical tab ids across target affinities", async () => {
    const dataDir = await root();
    const store = new BrowserSessionStore({ dataDir, now });
    const state = snapshot(store);
    state.tabs.push({ ...tab(), targetAffinity: "external-chrome", title: "External" });
    await expect(store.save(state)).rejects.toThrow("Duplicate browser logical tab id");
  });

  it("migrates v1 mixed state by preserving managed tabs and dropping unproven Chrome hints", async () => {
    const dataDir = await root();
    const store = new BrowserSessionStore({ dataDir, now });
    const path = store.getStatePath("profile-1", "manager-1");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dataDir, "profiles", "profile-1", "sessions", "manager-1"), { recursive: true });
    const state = snapshot(store) as any;
    state.schemaVersion = 1;
    state.hostKind = "external-chrome";
    state.tabs = [
      { ...tab(), targetAffinity: undefined, hostKind: "managed-electron" },
      { ...tab(), tabId: "ext.profile.7", targetAffinity: undefined, hostKind: "external-chrome", url: "https://private.invalid", title: "Private" },
    ];
    state.activeTabId = "ext.profile.7";
    state.defaultTabId = "ext.profile.7";
    await writeFile(path, JSON.stringify(state), "utf8");
    const migrated = await store.load("profile-1", "manager-1");
    expect(migrated).toMatchObject({ schemaVersion: 2, activeTabId: "tab-1", defaultTabId: "tab-1", tabs: [{ tabId: "tab-1", targetAffinity: "managed-electron" }] });
    expect(migrated).not.toHaveProperty("hostKind");
    const rewritten = await readFile(path, "utf8");
    expect(JSON.parse(rewritten)).toMatchObject({ schemaVersion: 2, tabs: [{ tabId: "tab-1" }] });
    expect(rewritten).not.toContain("private.invalid");
    expect(rewritten).not.toContain("must-not-migrate");
  });

  it("never persists External Chrome titles, full URLs, origins, or action copies", async () => {
    const dataDir = await root();
    const store = new BrowserSessionStore({ dataDir, now });
    const state = snapshot(store);
    state.tabs = [{ ...tab(), targetAffinity: "external-chrome", url: "https://private.invalid/path?secret=yes", title: "Private title" }];
    state.recentActions = [{
      id: "external-action", operation: "navigate", tabId: "tab-1", status: "succeeded",
      url: "https://private.invalid/path?secret=yes", title: "Private title", startedAt: now(),
    }];
    await store.save(state);
    const persisted = await readFile(store.getStatePath("profile-1", "manager-1"), "utf8");
    expect(persisted).not.toContain("private.invalid");
    expect(persisted).not.toContain("Private title");
    expect(JSON.parse(persisted)).toMatchObject({ tabs: [{ url: "", title: "", error: null }], recentActions: [{ id: "external-action" }] });
    const restarted = new BrowserSessionStore({ dataDir, now });
    await expect(restarted.load("profile-1", "manager-1")).resolves.toMatchObject({
      schemaVersion: 2,
      tabs: [{ targetAffinity: "external-chrome", url: "", title: "", error: null }],
      recentActions: [{ id: "external-action" }],
    });
  });

  it("persists only canonical metadata and omits screenshot, page, evaluate, and diagnostic payloads", async () => {
    const dataDir = await root();
    const store = new BrowserSessionStore({ dataDir, now });
    const state = snapshot(store) as BrowserSessionSnapshot & Record<string, unknown>;
    state.screenshot = { data: "SCREENSHOT_SECRET" };
    state.visibleText = "PAGE_SECRET";
    state.accessibility = { secret: "A11Y_SECRET" };
    state.consoleEntries = [{ text: "CONSOLE_SECRET" }];
    state.value = "EVALUATE_SECRET";
    await store.save(state);

    const persisted = await readFile(store.getStatePath("profile-1", "manager-1"), "utf8");
    expect(persisted).not.toContain("SECRET");
    expect(JSON.parse(persisted)).not.toHaveProperty("screenshot");
  });

  it("preserves corrupt and unknown-schema source data under a diagnostic suffix", async () => {
    const dataDir = await root();
    const store = new BrowserSessionStore({ dataDir, now });
    const path = store.getStatePath("profile-1", "manager-1");
    await writeFile(path, "{not-json", { encoding: "utf8", flag: "wx" }).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(dataDir, "profiles", "profile-1", "sessions", "manager-1"), { recursive: true });
      await writeFile(path, "{not-json", "utf8");
    });

    await expect(store.load("profile-1", "manager-1")).resolves.toMatchObject({ tabs: [], revision: 0 });
    let entries = await readdir(join(dataDir, "profiles", "profile-1", "sessions", "manager-1"));
    expect(entries.some((entry) => entry.startsWith("browser.json.corrupt-"))).toBe(true);
    const corruptName = entries.find((entry) => entry.startsWith("browser.json.corrupt-"))!;
    expect(await readFile(join(dataDir, "profiles", "profile-1", "sessions", "manager-1", corruptName), "utf8")).toBe("{not-json");

    await writeFile(path, JSON.stringify({ schemaVersion: 99 }), "utf8");
    await expect(store.load("profile-1", "manager-1")).resolves.toMatchObject({ tabs: [] });
    entries = await readdir(join(dataDir, "profiles", "profile-1", "sessions", "manager-1"));
    expect(entries.filter((entry) => entry.startsWith("browser.json.corrupt-"))).toHaveLength(2);
  });

  it("removes browser metadata and canonical artifacts on delete without removing the session directory", async () => {
    const dataDir = await root();
    const store = new BrowserSessionStore({ dataDir, now });
    await store.save(snapshot(store));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(store.getArtifactsDirectory("profile-1", "manager-1"), { recursive: true });
    await writeFile(join(store.getArtifactsDirectory("profile-1", "manager-1"), "recording.webm"), "data");
    await store.delete("profile-1", "manager-1");
    await expect(readdir(join(dataDir, "profiles", "profile-1", "sessions", "manager-1"))).resolves.toEqual(["artifacts"]);
    await expect(readdir(join(dataDir, "profiles", "profile-1", "sessions", "manager-1", "artifacts"))).resolves.toEqual([]);
  });
});
