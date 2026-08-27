import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PINNED_MESSAGES_FILE_NAME } from "../message-pins.js";
import {
  getProfileDir,
  getProfileMemoryPath,
  getProfileReferenceDir,
  getProfileScheduleFilePath,
  getProfileSchedulesDir,
  getProfileSlashCommandsPath,
  getProjectAgentsDir,
  getSessionDir,
  getSessionFeedbackPath,
  getSessionFilePath,
  getSessionMemoryPath,
  getSessionMetaPath,
  getSessionTerminalsDir,
  getTerminalLogPath,
  getTerminalMetaPath,
  getTerminalSnapshotPath,
  getWorkerSessionFilePath,
  getWorkersDir
} from "../data-paths.js";

const DATA_DIR = join(tmpdir(), "forge-workspace-contract");
const PROFILE_ID = "builder-profile";
const ROOT_SESSION_ID = PROFILE_ID;
const CHAT_SESSION_ID = "builder-profile--session-2";
const WORKER_ID = "backend-worker";
const TERMINAL_ID = "terminal-1";

describe("workspace/data path contract", () => {
  it("keeps profile-scoped state under the profile root", () => {
    const profileDir = join(DATA_DIR, "profiles", PROFILE_ID);

    expect(getProfileDir(DATA_DIR, PROFILE_ID)).toBe(profileDir);
    expect(getProfileMemoryPath(DATA_DIR, PROFILE_ID)).toBe(join(profileDir, "memory.md"));
    expect(getProfileReferenceDir(DATA_DIR, PROFILE_ID)).toBe(join(profileDir, "reference"));
    expect(getProjectAgentsDir(DATA_DIR, PROFILE_ID)).toBe(join(profileDir, "project-agents"));
    expect(getProfileSchedulesDir(DATA_DIR, PROFILE_ID)).toBe(join(profileDir, "schedules"));
    expect(getProfileScheduleFilePath(DATA_DIR, PROFILE_ID)).toBe(join(profileDir, "schedules", "schedules.json"));
    expect(getProfileSlashCommandsPath(DATA_DIR, PROFILE_ID)).toBe(join(profileDir, "slash-commands.json"));
  });

  it("keeps ordinary chat-session state adjacent inside the session directory", () => {
    const sessionDir = join(DATA_DIR, "profiles", PROFILE_ID, "sessions", CHAT_SESSION_ID);

    expect(getSessionDir(DATA_DIR, PROFILE_ID, CHAT_SESSION_ID)).toBe(sessionDir);
    expect(getSessionFilePath(DATA_DIR, PROFILE_ID, CHAT_SESSION_ID)).toBe(join(sessionDir, "session.jsonl"));
    expect(getSessionMemoryPath(DATA_DIR, PROFILE_ID, CHAT_SESSION_ID)).toBe(join(sessionDir, "memory.md"));
    expect(getSessionFeedbackPath(DATA_DIR, PROFILE_ID, CHAT_SESSION_ID)).toBe(join(sessionDir, "feedback.jsonl"));
    expect(getSessionMetaPath(DATA_DIR, PROFILE_ID, CHAT_SESSION_ID)).toBe(join(sessionDir, "meta.json"));
    expect(getWorkersDir(DATA_DIR, PROFILE_ID, CHAT_SESSION_ID)).toBe(join(sessionDir, "workers"));
    expect(getWorkerSessionFilePath(DATA_DIR, PROFILE_ID, CHAT_SESSION_ID, WORKER_ID)).toBe(
      join(sessionDir, "workers", `${WORKER_ID}.jsonl`)
    );

    // Message pins are a session sidecar file, adjacent to the transcript/memory/meta files.
    expect(join(getSessionDir(DATA_DIR, PROFILE_ID, CHAT_SESSION_ID), PINNED_MESSAGES_FILE_NAME)).toBe(
      join(sessionDir, "pinned-messages.json")
    );
  });

  it("documents terminal persistence as profile/root-session scoped rather than ordinary chat-session state", () => {
    const profileRootSessionDir = join(DATA_DIR, "profiles", PROFILE_ID, "sessions", ROOT_SESSION_ID);
    const rootTerminalsDir = join(profileRootSessionDir, "terminals");
    const chatSessionTerminalsDir = join(DATA_DIR, "profiles", PROFILE_ID, "sessions", CHAT_SESSION_ID, "terminals");

    // The helper is session-shaped, but current product semantics pass the profile/root session id.
    expect(getSessionTerminalsDir(DATA_DIR, PROFILE_ID, PROFILE_ID)).toBe(rootTerminalsDir);
    expect(getSessionTerminalsDir(DATA_DIR, PROFILE_ID, CHAT_SESSION_ID)).toBe(chatSessionTerminalsDir);
    expect(getSessionTerminalsDir(DATA_DIR, PROFILE_ID, PROFILE_ID)).not.toBe(
      getSessionTerminalsDir(DATA_DIR, PROFILE_ID, CHAT_SESSION_ID)
    );

    expect(getTerminalMetaPath(DATA_DIR, PROFILE_ID, PROFILE_ID, TERMINAL_ID)).toBe(
      join(rootTerminalsDir, TERMINAL_ID, "meta.json")
    );
    expect(getTerminalSnapshotPath(DATA_DIR, PROFILE_ID, PROFILE_ID, TERMINAL_ID)).toBe(
      join(rootTerminalsDir, TERMINAL_ID, "snapshot.vt")
    );
    expect(getTerminalLogPath(DATA_DIR, PROFILE_ID, PROFILE_ID, TERMINAL_ID)).toBe(
      join(rootTerminalsDir, TERMINAL_ID, "delta.ndjson")
    );
  });
});
