import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PINNED_MESSAGES_FILE_NAME } from "../message-pins.js";
import { createProfileWorkspace } from "../session/profile-workspace.js";
import { createSessionWorkspace } from "../session/session-workspace.js";
import {
  getProfileDir,
  getProfileMemoryPath,
  getProfilePiDir,
  getProfilePiExtensionsDir,
  getProfilePiPromptsDir,
  getProfilePiSkillsDir,
  getProfilePiThemesDir,
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

  it("wraps profile-scoped paths in ProfileWorkspace without changing existing helpers", () => {
    const workspace = createProfileWorkspace(DATA_DIR, PROFILE_ID);

    expect(workspace.dataDir).toBe(DATA_DIR);
    expect(workspace.profileId).toBe(PROFILE_ID);
    expect(workspace.profileDir).toBe(getProfileDir(DATA_DIR, PROFILE_ID));
    expect(workspace.memoryPath).toBe(getProfileMemoryPath(DATA_DIR, PROFILE_ID));
    expect(workspace.referenceDir).toBe(getProfileReferenceDir(DATA_DIR, PROFILE_ID));
    expect(workspace.projectAgentsDir).toBe(getProjectAgentsDir(DATA_DIR, PROFILE_ID));
    expect(workspace.schedulesDir).toBe(getProfileSchedulesDir(DATA_DIR, PROFILE_ID));
    expect(workspace.scheduleFilePath).toBe(getProfileScheduleFilePath(DATA_DIR, PROFILE_ID));
    expect(workspace.slashCommandsPath).toBe(getProfileSlashCommandsPath(DATA_DIR, PROFILE_ID));
    expect(workspace.pi.piDir).toBe(getProfilePiDir(DATA_DIR, PROFILE_ID));
    expect(workspace.pi.extensionsDir).toBe(getProfilePiExtensionsDir(DATA_DIR, PROFILE_ID));
    expect(workspace.pi.skillsDir).toBe(getProfilePiSkillsDir(DATA_DIR, PROFILE_ID));
    expect(workspace.pi.promptsDir).toBe(getProfilePiPromptsDir(DATA_DIR, PROFILE_ID));
    expect(workspace.pi.themesDir).toBe(getProfilePiThemesDir(DATA_DIR, PROFILE_ID));
    expect(workspace.terminalRootDir).toBe(getSessionTerminalsDir(DATA_DIR, PROFILE_ID, PROFILE_ID));

    const sessionWorkspace = workspace.session(CHAT_SESSION_ID);
    expect(sessionWorkspace.sessionDir).toBe(createSessionWorkspace(DATA_DIR, PROFILE_ID, CHAT_SESSION_ID).sessionDir);
    expect(sessionWorkspace.sessionFilePath).toBe(getSessionFilePath(DATA_DIR, PROFILE_ID, CHAT_SESSION_ID));
  });

  it("wraps ordinary session paths in SessionWorkspace and intentionally excludes terminal paths", () => {
    const workspace = createSessionWorkspace(DATA_DIR, PROFILE_ID, CHAT_SESSION_ID);

    expect(workspace.dataDir).toBe(DATA_DIR);
    expect(workspace.profileId).toBe(PROFILE_ID);
    expect(workspace.sessionAgentId).toBe(CHAT_SESSION_ID);
    expect(workspace.sessionDir).toBe(getSessionDir(DATA_DIR, PROFILE_ID, CHAT_SESSION_ID));
    expect(workspace.sessionFilePath).toBe(getSessionFilePath(DATA_DIR, PROFILE_ID, CHAT_SESSION_ID));
    expect(workspace.memoryPath).toBe(getSessionMemoryPath(DATA_DIR, PROFILE_ID, CHAT_SESSION_ID));
    expect(workspace.metaPath).toBe(getSessionMetaPath(DATA_DIR, PROFILE_ID, CHAT_SESSION_ID));
    expect(workspace.feedbackPath).toBe(getSessionFeedbackPath(DATA_DIR, PROFILE_ID, CHAT_SESSION_ID));
    expect(workspace.workersDir).toBe(getWorkersDir(DATA_DIR, PROFILE_ID, CHAT_SESSION_ID));
    expect(workspace.pinnedMessagesPath).toBe(
      join(getSessionDir(DATA_DIR, PROFILE_ID, CHAT_SESSION_ID), PINNED_MESSAGES_FILE_NAME)
    );
    expect(workspace.workerSessionFilePath(WORKER_ID)).toBe(
      getWorkerSessionFilePath(DATA_DIR, PROFILE_ID, CHAT_SESSION_ID, WORKER_ID)
    );

    expect("terminalRootDir" in workspace).toBe(false);
    expect("terminalsDir" in workspace).toBe(false);
    expect(Object.keys(workspace).some((key) => key.toLowerCase().includes("terminal"))).toBe(false);
  });
});
