interface CollaborationBrowserOriginConfig {
  collaborationBaseUrl?: string;
  collaborationTrustedOrigins?: string[];
}

interface CollaborationOriginPolicyConfig extends CollaborationBrowserOriginConfig {
  host: string;
  port: number;
}

export interface CollaborationOriginPolicy {
  backendOrigin: string;
  collabApiOrigin: string;
  browserTrustedOrigins: string[];
  trustedOrigins: string[];
  requiresCrossOriginCookies: boolean;
}

export function collectCollaborationBrowserOrigins(
  config: CollaborationBrowserOriginConfig | undefined,
): string[] {
  const origins = new Set<string>();

  const collaborationBaseOrigin = normalizeOrigin(config?.collaborationBaseUrl);
  if (collaborationBaseOrigin) {
    origins.add(collaborationBaseOrigin);
  }

  for (const value of config?.collaborationTrustedOrigins ?? []) {
    const origin = normalizeOrigin(value);
    if (origin) {
      origins.add(origin);
    }
  }

  return [...origins];
}

export function resolveCollaborationOriginPolicy(
  config: CollaborationOriginPolicyConfig,
): CollaborationOriginPolicy {
  const backendOrigin = `http://${normalizeBrowserOriginHost(config.host)}:${config.port}`;
  const browserTrustedOrigins = collectCollaborationBrowserOrigins(config);
  const collabApiOrigin = normalizeOrigin(config.collaborationBaseUrl) ?? backendOrigin;
  const trustedOrigins = [...new Set([backendOrigin, ...browserTrustedOrigins])];

  return {
    backendOrigin,
    collabApiOrigin,
    browserTrustedOrigins,
    trustedOrigins,
    requiresCrossOriginCookies: browserTrustedOrigins.some((origin) => !isSameSiteOrigin(origin, collabApiOrigin)),
  };
}

function isSameSiteOrigin(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return leftUrl.protocol === rightUrl.protocol && leftUrl.hostname === rightUrl.hostname;
  } catch {
    return left === right;
  }
}

function normalizeBrowserOriginHost(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]") {
    return "127.0.0.1";
  }

  return normalized;
}

export function normalizeOrigin(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }

  try {
    return new URL(normalized).origin;
  } catch {
    return null;
  }
}

export function isHttpsOrigin(value: string | undefined | null): boolean {
  return value?.trim().toLowerCase().startsWith("https://") === true;
}

export type { CollaborationBrowserOriginConfig };
