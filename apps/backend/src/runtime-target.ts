export const RUNTIME_TARGETS = ["builder", "collaboration-server"] as const;

export type RuntimeTarget = (typeof RUNTIME_TARGETS)[number];

export function isRuntimeTarget(value: string): value is RuntimeTarget {
  return (RUNTIME_TARGETS as readonly string[]).includes(value);
}

export function isBuilderRuntimeTarget(target: RuntimeTarget): boolean {
  return target === "builder";
}

export function resolveRuntimeTargetFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => console.warn(message),
): RuntimeTarget {
  const explicitValue = env.FORGE_RUNTIME_TARGET ?? env.MIDDLEMAN_RUNTIME_TARGET;
  const normalizedExplicitValue = explicitValue?.trim();

  if (normalizedExplicitValue) {
    if (isRuntimeTarget(normalizedExplicitValue)) {
      return normalizedExplicitValue;
    }

    warn(`[config] Ignoring invalid FORGE_RUNTIME_TARGET value: ${explicitValue}`);
    return "builder";
  }

  const legacyCollaborationEnabled = parseOptionalBooleanEnv(
    env.FORGE_COLLABORATION_ENABLED ?? env.MIDDLEMAN_COLLABORATION_ENABLED,
  );

  return legacyCollaborationEnabled === true ? "collaboration-server" : "builder";
}

function parseOptionalBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
}
