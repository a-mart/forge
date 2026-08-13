import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  emptySessionAttentionState,
  parsePersistedSessionAttentionState,
  SessionAttentionStore,
} from "../session/session-attention-store.js";

const NOW = "2026-08-04T12:00:00.000Z";

describe("SessionAttentionStore", () => {
  it("atomically writes and reads the versioned global state round trip", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "session-attention-store-"));
    const store = new SessionAttentionStore({ dataDir });
    const state = {
      version: 1 as const,
      revision: 7,
      sessions: {
        "manager-1": {
          profileId: "profile-1",
          epoch: 3,
          phase: "settled" as const,
          workStartedAt: NOW,
          hadError: true,
          attention: {
            attentionId: "attention-3",
            reason: "work_failed" as const,
            raisedAt: NOW,
            dismissedAt: "2026-08-04T12:01:00.000Z",
          },
        },
      },
    };

    await store.save(state);
    expect(await store.load()).toEqual(state);
    expect(JSON.parse(await readFile(store.filePath, "utf8"))).toEqual(state);
  });

  it("strictly rejects unknown versions, malformed records, and working records with attention", () => {
    expect(() => parsePersistedSessionAttentionState({ version: 2, revision: 0, sessions: {} })).toThrow(/version/);
    expect(() => parsePersistedSessionAttentionState({ version: 1, revision: -1, sessions: {} })).toThrow(/revision/);
    expect(() => parsePersistedSessionAttentionState({
      version: 1,
      revision: 0,
      sessions: {
        "manager-1": {
          profileId: "profile-1",
          epoch: 1,
          phase: "working",
          workStartedAt: NOW,
          attention: { attentionId: "wrong", reason: "work_settled", raisedAt: NOW },
        },
      },
    })).toThrow(/Working/);
  });

  it("returns an empty, revision-zero state for an absent document", async () => {
    const store = new SessionAttentionStore({ dataDir: await mkdtemp(join(tmpdir(), "session-attention-empty-")) });
    expect(await store.load()).toEqual(emptySessionAttentionState());
  });
});
