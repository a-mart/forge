import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BuilderSidebarOrderConflictError,
  BuilderSidebarOrderService,
  BuilderSidebarOrderValidationError,
  MAX_BUILDER_SIDEBAR_ORDER_REFS,
  MAX_BUILDER_SIDEBAR_ORDER_SERIALIZED_BYTES,
  parseUpdateRequest,
} from "../builder-sidebar-order-service.js";
import { getBuilderSidebarOrderPath } from "../storage/data-paths.js";

const warnings: Array<ReturnType<typeof vi.spyOn>> = [];

afterEach(() => {
  for (const warning of warnings.splice(0)) warning.mockRestore();
});

async function createService(now = new Date("2026-07-09T12:00:00.000Z")) {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-sidebar-order-service-"));
  const service = new BuilderSidebarOrderService({ dataDir, now: () => now });
  return { dataDir, service, filePath: getBuilderSidebarOrderPath(dataDir) };
}

describe("BuilderSidebarOrderService", () => {
  it("uses an empty revision-zero default when the file is missing", async () => {
    const { service } = await createService();
    await service.load();
    expect(service.getState()).toEqual({ version: 1, revision: 0, order: [], updatedAt: null });
  });

  it("persists validated composite refs atomically with a revision", async () => {
    const { service, filePath } = await createService();
    await service.load();

    const state = await service.update({
      baseRevision: 0,
      order: [
        { originId: "local", profileId: "same" },
        { originId: "remote-a", profileId: "same" },
      ],
    });

    expect(state).toEqual({
      version: 1,
      revision: 1,
      order: [
        { originId: "local", profileId: "same" },
        { originId: "remote-a", profileId: "same" },
      ],
      updatedAt: "2026-07-09T12:00:00.000Z",
    });
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(state);
    const siblingNames = await (await import("node:fs/promises")).readdir(dirname(filePath));
    expect(siblingNames.some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("loads a valid persisted state and returns defensive clones", async () => {
    const { service, filePath } = await createService();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify({
      version: 1,
      revision: 7,
      order: [{ originId: "remote", profileId: "alpha" }],
      updatedAt: "2026-07-08T12:00:00.000Z",
    }));

    await service.load();
    const first = service.getState();
    first.order[0]!.profileId = "mutated";
    expect(service.getState().order[0]!.profileId).toBe("alpha");
  });

  it.each([
    "{not-json",
    JSON.stringify({ version: 2, revision: 0, order: [], updatedAt: null }),
    JSON.stringify({ version: 1, revision: 1, order: [], updatedAt: null }),
    JSON.stringify({
      version: 1,
      revision: 1,
      order: [
        { originId: "local", profileId: "alpha" },
        { originId: "local", profileId: "alpha" },
      ],
      updatedAt: "2026-07-08T12:00:00.000Z",
    }),
  ])("fails safely to the default for a malformed persisted file", async (raw) => {
    warnings.push(vi.spyOn(console, "warn").mockImplementation(() => undefined));
    const { service, filePath } = await createService();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, raw);

    await service.load();

    expect(service.getState()).toEqual({ version: 1, revision: 0, order: [], updatedAt: null });
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it("rejects duplicates, controls, oversized IDs, excessive refs, and unknown fields", async () => {
    const { service } = await createService();
    await service.load();

    const invalidRequests = [
      {
        baseRevision: 0,
        order: [
          { originId: "local", profileId: "alpha" },
          { originId: "local", profileId: "alpha" },
        ],
      },
      { baseRevision: 0, order: [{ originId: "bad\norigin", profileId: "alpha" }] },
      { baseRevision: 0, order: [{ originId: "local", profileId: "x".repeat(257) }] },
      {
        baseRevision: 0,
        order: Array.from({ length: MAX_BUILDER_SIDEBAR_ORDER_REFS + 1 }, (_, index) => ({
          originId: "local",
          profileId: `profile-${index}`,
        })),
      },
      { baseRevision: 0, order: [], extra: true },
      { baseRevision: 0, order: [{ originId: "local", profileId: "alpha", extra: true }] },
    ];

    for (const request of invalidRequests) {
      await expect(service.update(request)).rejects.toBeInstanceOf(BuilderSidebarOrderValidationError);
    }
    expect(service.getState().revision).toBe(0);
  });

  it.each([
    ["ASCII", "a".repeat(240)],
    ["multibyte", "😀".repeat(100)],
  ])("enforces the serialized UTF-8 byte boundary for %s IDs", (_label, prefix) => {
    const within: Array<{ originId: string; profileId: string }> = [];
    let over: typeof within | null = null;

    for (let index = 0; index < MAX_BUILDER_SIDEBAR_ORDER_REFS; index += 1) {
      const suffix = String(index);
      const candidate = {
        originId: `${prefix}${suffix}`,
        profileId: `${prefix}${suffix}`,
      };
      const next = [...within, candidate];
      if (Buffer.byteLength(JSON.stringify(next), "utf8") > MAX_BUILDER_SIDEBAR_ORDER_SERIALIZED_BYTES) {
        over = next;
        break;
      }
      within.push(candidate);
    }

    expect(over).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(within), "utf8")).toBeLessThanOrEqual(
      MAX_BUILDER_SIDEBAR_ORDER_SERIALIZED_BYTES,
    );
    expect(Buffer.byteLength(JSON.stringify(over), "utf8")).toBeGreaterThan(
      MAX_BUILDER_SIDEBAR_ORDER_SERIALIZED_BYTES,
    );
    expect(parseUpdateRequest({ baseRevision: 0, order: within }).order).toHaveLength(within.length);
    expect(() => parseUpdateRequest({ baseRevision: 0, order: over })).toThrow(/serialized UTF-8 bytes/);
  });

  it("serializes concurrent writes and returns the authoritative state on conflict", async () => {
    const { service } = await createService();
    await service.load();

    const results = await Promise.allSettled([
      service.update({ baseRevision: 0, order: [{ originId: "local", profileId: "alpha" }] }),
      service.update({ baseRevision: 0, order: [{ originId: "remote", profileId: "beta" }] }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection?.status).toBe("rejected");
    if (rejection?.status === "rejected") {
      expect(rejection.reason).toBeInstanceOf(BuilderSidebarOrderConflictError);
      expect((rejection.reason as BuilderSidebarOrderConflictError).current).toEqual(service.getState());
    }
    expect(service.getState().revision).toBe(1);
  });
});
