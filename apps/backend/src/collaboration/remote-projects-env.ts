/**
 * Collaboration-server-only Remote Projects environment overrides.
 *
 * Parsed once at startup. Builder runtimes must ignore these variables entirely.
 * There are no MIDDLEMAN_* aliases.
 */

export const REMOTE_PROJECTS_ENABLED_ENV = "FORGE_REMOTE_PROJECTS_ENABLED";
export const REMOTE_PROJECTS_TERMINALS_ENABLED_ENV = "FORGE_REMOTE_PROJECTS_TERMINALS_ENABLED";
export const REMOTE_PROJECTS_INSTANCE_NAME_ENV = "FORGE_REMOTE_PROJECTS_INSTANCE_NAME";

export const REMOTE_PROJECTS_INSTANCE_NAME_MAX_LENGTH = 120;

export interface RemoteProjectsEnvOverrides {
  enabled?: boolean;
  terminalsEnabled?: boolean;
  instanceName?: string;
}

export class RemoteProjectsEnvParseError extends Error {
  readonly envVarName: string;

  constructor(envVarName: string, message: string) {
    super(message);
    this.name = "RemoteProjectsEnvParseError";
    this.envVarName = envVarName;
  }
}

type EnvReader = Record<string, string | undefined>;

/**
 * Parse Forge-only Remote Projects deployment overrides from an env map.
 * Unset / whitespace-only values are absent. Invalid nonblank booleans and
 * trimmed instance names longer than 120 characters throw with the variable named.
 */
export function parseRemoteProjectsEnv(env: EnvReader = process.env): RemoteProjectsEnvOverrides {
  const overrides: RemoteProjectsEnvOverrides = {};

  const enabled = parseOptionalStrictBooleanEnv(env[REMOTE_PROJECTS_ENABLED_ENV], REMOTE_PROJECTS_ENABLED_ENV);
  if (enabled !== undefined) {
    overrides.enabled = enabled;
  }

  const terminalsEnabled = parseOptionalStrictBooleanEnv(
    env[REMOTE_PROJECTS_TERMINALS_ENABLED_ENV],
    REMOTE_PROJECTS_TERMINALS_ENABLED_ENV,
  );
  if (terminalsEnabled !== undefined) {
    overrides.terminalsEnabled = terminalsEnabled;
  }

  const instanceName = parseOptionalInstanceNameEnv(
    env[REMOTE_PROJECTS_INSTANCE_NAME_ENV],
    REMOTE_PROJECTS_INSTANCE_NAME_ENV,
  );
  if (instanceName !== undefined) {
    overrides.instanceName = instanceName;
  }

  return overrides;
}

function parseOptionalStrictBooleanEnv(value: string | undefined, envVarName: string): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }

  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }

  throw new RemoteProjectsEnvParseError(
    envVarName,
    `Invalid ${envVarName} value: ${value}. Accepted values: 1/true/yes/on or 0/false/no/off.`,
  );
}

function parseOptionalInstanceNameEnv(value: string | undefined, envVarName: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.length > REMOTE_PROJECTS_INSTANCE_NAME_MAX_LENGTH) {
    throw new RemoteProjectsEnvParseError(
      envVarName,
      `Invalid ${envVarName} value: trimmed instance name must be at most ${REMOTE_PROJECTS_INSTANCE_NAME_MAX_LENGTH} characters.`,
    );
  }

  return trimmed;
}
