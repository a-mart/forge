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
  getSessionTerminalsDir
} from "../data-paths.js";
import { createSessionWorkspace, type SessionWorkspace } from "./session-workspace.js";

export interface ProfilePiWorkspace {
  readonly piDir: string;
  readonly extensionsDir: string;
  readonly skillsDir: string;
  readonly promptsDir: string;
  readonly themesDir: string;
}

export interface ProfileWorkspace {
  readonly dataDir: string;
  readonly profileId: string;
  readonly profileDir: string;
  readonly memoryPath: string;
  readonly referenceDir: string;
  readonly projectAgentsDir: string;
  readonly schedulesDir: string;
  readonly scheduleFilePath: string;
  readonly slashCommandsPath: string;
  readonly pi: ProfilePiWorkspace;
  readonly terminalRootDir: string;
  session(sessionAgentId: string): SessionWorkspace;
}

/**
 * Profile-scoped filesystem view for profile-owned state.
 *
 * `terminalRootDir` preserves the current product contract: integrated
 * terminals live under the profile/root-session terminal directory, not under
 * arbitrary chat-session workspaces.
 */
export function createProfileWorkspace(dataDir: string, profileId: string): ProfileWorkspace {
  return {
    dataDir,
    profileId,
    profileDir: getProfileDir(dataDir, profileId),
    memoryPath: getProfileMemoryPath(dataDir, profileId),
    referenceDir: getProfileReferenceDir(dataDir, profileId),
    projectAgentsDir: getProjectAgentsDir(dataDir, profileId),
    schedulesDir: getProfileSchedulesDir(dataDir, profileId),
    scheduleFilePath: getProfileScheduleFilePath(dataDir, profileId),
    slashCommandsPath: getProfileSlashCommandsPath(dataDir, profileId),
    pi: {
      piDir: getProfilePiDir(dataDir, profileId),
      extensionsDir: getProfilePiExtensionsDir(dataDir, profileId),
      skillsDir: getProfilePiSkillsDir(dataDir, profileId),
      promptsDir: getProfilePiPromptsDir(dataDir, profileId),
      themesDir: getProfilePiThemesDir(dataDir, profileId)
    },
    terminalRootDir: getSessionTerminalsDir(dataDir, profileId, profileId),
    session(sessionAgentId: string): SessionWorkspace {
      return createSessionWorkspace(dataDir, profileId, sessionAgentId);
    }
  };
}
