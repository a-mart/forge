import { describe, expect, it } from "vitest";
import {
  parseRemoteProjectsEnv,
  RemoteProjectsEnvParseError,
  REMOTE_PROJECTS_ENABLED_ENV,
  REMOTE_PROJECTS_INSTANCE_NAME_ENV,
  REMOTE_PROJECTS_TERMINALS_ENABLED_ENV,
} from "../collaboration/remote-projects-env.js";

describe("parseRemoteProjectsEnv", () => {
  it("treats unset and whitespace-only values as absent", () => {
    expect(parseRemoteProjectsEnv({})).toEqual({});
    expect(
      parseRemoteProjectsEnv({
        [REMOTE_PROJECTS_ENABLED_ENV]: "   ",
        [REMOTE_PROJECTS_TERMINALS_ENABLED_ENV]: "\t",
        [REMOTE_PROJECTS_INSTANCE_NAME_ENV]: "\n",
      }),
    ).toEqual({});
  });

  it("parses accepted boolean forms case-insensitively", () => {
    expect(
      parseRemoteProjectsEnv({
        [REMOTE_PROJECTS_ENABLED_ENV]: "TRUE",
        [REMOTE_PROJECTS_TERMINALS_ENABLED_ENV]: " Off ",
      }),
    ).toEqual({ enabled: true, terminalsEnabled: false });

    expect(
      parseRemoteProjectsEnv({
        [REMOTE_PROJECTS_ENABLED_ENV]: "1",
        [REMOTE_PROJECTS_TERMINALS_ENABLED_ENV]: "yes",
      }),
    ).toEqual({ enabled: true, terminalsEnabled: true });

    expect(
      parseRemoteProjectsEnv({
        [REMOTE_PROJECTS_ENABLED_ENV]: "0",
        [REMOTE_PROJECTS_TERMINALS_ENABLED_ENV]: "no",
      }),
    ).toEqual({ enabled: false, terminalsEnabled: false });
  });

  it("parses trimmed instance names within the length limit", () => {
    expect(
      parseRemoteProjectsEnv({
        [REMOTE_PROJECTS_INSTANCE_NAME_ENV]: "  Central Forge  ",
      }),
    ).toEqual({ instanceName: "Central Forge" });
  });

  it("fails with the variable named for invalid booleans", () => {
    expect(() =>
      parseRemoteProjectsEnv({
        [REMOTE_PROJECTS_ENABLED_ENV]: "maybe",
      }),
    ).toThrow(RemoteProjectsEnvParseError);

    try {
      parseRemoteProjectsEnv({ [REMOTE_PROJECTS_TERMINALS_ENABLED_ENV]: "yep" });
      expect.unreachable("expected parse to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteProjectsEnvParseError);
      expect((error as RemoteProjectsEnvParseError).envVarName).toBe(
        REMOTE_PROJECTS_TERMINALS_ENABLED_ENV,
      );
      expect((error as Error).message).toContain(REMOTE_PROJECTS_TERMINALS_ENABLED_ENV);
    }
  });

  it("fails with the variable named for over-long instance names", () => {
    const tooLong = "x".repeat(121);
    try {
      parseRemoteProjectsEnv({ [REMOTE_PROJECTS_INSTANCE_NAME_ENV]: `  ${tooLong}  ` });
      expect.unreachable("expected parse to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteProjectsEnvParseError);
      expect((error as RemoteProjectsEnvParseError).envVarName).toBe(
        REMOTE_PROJECTS_INSTANCE_NAME_ENV,
      );
    }
  });

  it("ignores MIDDLEMAN aliases", () => {
    expect(
      parseRemoteProjectsEnv({
        MIDDLEMAN_REMOTE_PROJECTS_ENABLED: "true",
        MIDDLEMAN_REMOTE_PROJECTS_TERMINALS_ENABLED: "false",
        MIDDLEMAN_REMOTE_PROJECTS_INSTANCE_NAME: "Legacy",
      } as Record<string, string>),
    ).toEqual({});
  });
});
