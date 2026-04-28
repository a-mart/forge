import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { isCollaborationServerRuntimeTarget } from "../../runtime-target.js";
import type { SwarmConfig } from "../../swarm/types.js";
import { getCollaborationAuthSecret } from "./auth-secret-service.js";
import { getOrCreateCollaborationAuthDb } from "./collaboration-db.js";
import { isHttpsOrigin, resolveCollaborationOriginPolicy } from "./collaboration-origin-policy.js";
import { nodeRequestToWebRequest, writeWebResponseToNodeResponse } from "./node-http-adapter.js";

export interface CollaborationAuthSession {
  session: {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    userId: string;
    expiresAt: Date;
    token: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  };
  user: {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    email: string;
    emailVerified: boolean;
    name: string;
    image?: string | null;
  };
}

export interface CollaborationAuthUser {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  email: string;
  emailVerified: boolean;
  name: string;
  image?: string | null;
}

export interface CollaborationBetterAuthService {
  handleAuthRequest(request: IncomingMessage, response: ServerResponse): Promise<void>;
  getSessionFromRequest(request: IncomingMessage): Promise<CollaborationAuthSession | null>;
  getSessionFromCookieHeader(cookieHeader: string | string[] | undefined): Promise<CollaborationAuthSession | null>;
  createUser(email: string, name: string, password: string): Promise<CollaborationAuthUser>;
  createSessionCookies(userId: string): Promise<string[]>;
  clearSessionCookies(): Promise<string[]>;
  deleteUser(userId: string): Promise<void>;
  revokeUserSessions(userId: string): Promise<void>;
  revokeOtherUserSessions(userId: string, currentSessionId: string): Promise<void>;
  setUserPassword(userId: string, newPassword: string, options?: { passwordChangeRequired?: boolean }): Promise<void>;
  verifyUserPassword(userId: string, password: string): Promise<boolean>;
}

const serviceInstances = new Map<string, CollaborationBetterAuthService>();
const servicePromises = new Map<string, Promise<CollaborationBetterAuthService>>();

export async function getOrCreateCollaborationBetterAuthService(
  config: SwarmConfig,
): Promise<CollaborationBetterAuthService> {
  if (!isCollaborationServerRuntimeTarget(config.runtimeTarget)) {
    throw new Error("Collaboration auth service requested while collaboration server runtime is disabled");
  }

  const serviceKey = config.paths.collaborationAuthDbPath ?? config.paths.dataDir;
  const existingService = serviceInstances.get(serviceKey);
  if (existingService) {
    return existingService;
  }

  const existingPromise = servicePromises.get(serviceKey);
  if (existingPromise) {
    return existingPromise;
  }

  const servicePromise = createCollaborationBetterAuthService(config);
  servicePromises.set(serviceKey, servicePromise);

  try {
    const service = await servicePromise;
    serviceInstances.set(serviceKey, service);
    return service;
  } finally {
    servicePromises.delete(serviceKey);
  }
}

export function clearCollaborationBetterAuthService(config: Pick<SwarmConfig, "paths">): void {
  const serviceKey = config.paths.collaborationAuthDbPath ?? config.paths.dataDir;
  servicePromises.delete(serviceKey);
  serviceInstances.delete(serviceKey);
}

async function createCollaborationBetterAuthService(
  config: SwarmConfig,
): Promise<CollaborationBetterAuthService> {
  const loader = config.collaborationModules?.loadAuthModule;
  if (!loader) {
    throw new Error("Missing collaboration auth module loader in config");
  }

  const [{ betterAuth }, database, secret] = await Promise.all([
    loader(),
    getOrCreateCollaborationAuthDb(config),
    getCollaborationAuthSecret(config),
  ]);

  const originPolicy = resolveCollaborationOriginPolicy(config);
  if (originPolicy.requiresCrossOriginCookies && !isHttpsOrigin(config.collaborationBaseUrl)) {
    throw new Error(
      "Cross-origin collaboration auth requires FORGE_COLLABORATION_BASE_URL to use https://",
    );
  }

  const useSecureCookies = originPolicy.requiresCrossOriginCookies || isHttpsOrigin(config.collaborationBaseUrl);
  const auth = betterAuth({
    database,
    secret,
    baseURL: config.collaborationBaseUrl || originPolicy.backendOrigin,
    basePath: "/api/auth",
    trustedOrigins: originPolicy.trustedOrigins,
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
    },
    session: {
      cookieCache: {
        enabled: false,
      },
    },
    advanced: {
      useSecureCookies,
      cookies: {
        session_token: {
          name: "forge_collab_session",
          attributes: {
            httpOnly: true,
            sameSite: originPolicy.requiresCrossOriginCookies ? "none" : "lax",
            secure: useSecureCookies,
          },
        },
      },
    },
  });

  return new BetterAuthService(auth as BetterAuthRuntime, database);
}

interface BetterAuthRuntime {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(context: { headers: Headers }): Promise<CollaborationAuthSession | null>;
  };
  $context: Promise<{
    password: {
      hash(password: string): Promise<string>;
      verify(input: { hash: string; password: string }): Promise<boolean>;
      config: {
        minPasswordLength: number;
        maxPasswordLength: number;
      };
    };
    secret: string | BufferSource;
    authCookies: {
      sessionToken: {
        name: string;
        attributes: CookieAttributes;
      };
      sessionData: {
        name: string;
        attributes: CookieAttributes;
      };
      dontRememberToken: {
        name: string;
        attributes: CookieAttributes;
      };
    };
    sessionConfig: {
      expiresIn: number;
    };
    internalAdapter: {
      findUserByEmail(email: string): Promise<{ user: CollaborationAuthUser } | null>;
      createUser(user: { email: string; name: string }): Promise<CollaborationAuthUser>;
      createSession(userId: string, dontRememberMe?: boolean): Promise<CollaborationAuthSession["session"] | null>;
      linkAccount(account: {
        accountId: string;
        providerId: string;
        password: string;
        userId: string;
      }): Promise<unknown>;
      deleteUser(userId: string): Promise<void>;
      deleteSessions(userId: string): Promise<void>;
    };
  }>;
}

interface CookieAttributes {
  domain?: string;
  path?: string;
  httpOnly?: boolean;
  sameSite?: boolean | "lax" | "strict" | "none" | "Lax" | "Strict" | "None";
  secure?: boolean;
  maxAge?: number;
}

class BetterAuthService implements CollaborationBetterAuthService {
  constructor(
    private readonly auth: BetterAuthRuntime,
    private readonly database: Database.Database,
  ) {}

  async handleAuthRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const webRequest = nodeRequestToWebRequest(request);
    const webResponse = await this.auth.handler(webRequest);
    await writeWebResponseToNodeResponse(webResponse, response);
  }

  async getSessionFromRequest(request: IncomingMessage): Promise<CollaborationAuthSession | null> {
    return this.getSessionFromCookieHeader(request.headers.cookie);
  }

  async getSessionFromCookieHeader(
    cookieHeader: string | string[] | undefined,
  ): Promise<CollaborationAuthSession | null> {
    const normalizedCookieHeader = normalizeCookieHeader(cookieHeader);
    if (!normalizedCookieHeader) {
      return null;
    }

    return this.auth.api.getSession({
      headers: new Headers({ cookie: normalizedCookieHeader }),
    });
  }

  async createUser(email: string, name: string, password: string): Promise<CollaborationAuthUser> {
    const normalizedEmail = normalizeRequiredValue(email, "email").toLowerCase();
    const normalizedName = normalizeRequiredValue(name, "name");
    const normalizedPassword = normalizeRequiredPassword(password, "password");
    const context = await this.auth.$context;

    validatePasswordLength(normalizedPassword, context.password.config);

    const existingUser = await context.internalAdapter.findUserByEmail(normalizedEmail);
    if (existingUser?.user) {
      throw new Error(`Collaboration auth user already exists for email ${normalizedEmail}`);
    }

    const hashedPassword = await context.password.hash(normalizedPassword);
    const user = await context.internalAdapter.createUser({ email: normalizedEmail, name: normalizedName });

    try {
      await context.internalAdapter.linkAccount({
        accountId: user.id,
        providerId: "credential",
        password: hashedPassword,
        userId: user.id,
      });
    } catch (error) {
      await context.internalAdapter.deleteUser(user.id).catch(() => undefined);
      throw error;
    }

    return user;
  }

  async createSessionCookies(userId: string): Promise<string[]> {
    const normalizedUserId = normalizeRequiredValue(userId, "userId");
    const context = await this.auth.$context;
    const session = await context.internalAdapter.createSession(normalizedUserId);
    if (!session) {
      throw new Error(`Failed to create collaboration auth session for user ${normalizedUserId}`);
    }

    return [
      serializeSignedCookie(context.authCookies.sessionToken.name, session.token, context.secret, {
        ...context.authCookies.sessionToken.attributes,
        maxAge: context.sessionConfig.expiresIn,
      }),
    ];
  }

  async clearSessionCookies(): Promise<string[]> {
    const context = await this.auth.$context;

    return [
      serializeCookie(context.authCookies.sessionToken.name, "", {
        ...context.authCookies.sessionToken.attributes,
        maxAge: 0,
      }),
      serializeCookie(context.authCookies.sessionData.name, "", {
        ...context.authCookies.sessionData.attributes,
        maxAge: 0,
      }),
      serializeCookie(context.authCookies.dontRememberToken.name, "", {
        ...context.authCookies.dontRememberToken.attributes,
        maxAge: 0,
      }),
    ];
  }

  async deleteUser(userId: string): Promise<void> {
    const context = await this.auth.$context;
    await context.internalAdapter.deleteUser(normalizeRequiredValue(userId, "userId"));
  }

  async revokeUserSessions(userId: string): Promise<void> {
    const context = await this.auth.$context;
    await context.internalAdapter.deleteSessions(normalizeRequiredValue(userId, "userId"));
  }

  async revokeOtherUserSessions(userId: string, currentSessionId: string): Promise<void> {
    this.database.prepare(
      `DELETE FROM session
       WHERE userId = ?
         AND id != ?`,
    ).run(normalizeRequiredValue(userId, "userId"), normalizeRequiredValue(currentSessionId, "currentSessionId"));
  }

  async setUserPassword(
    userId: string,
    newPassword: string,
    options?: { passwordChangeRequired?: boolean },
  ): Promise<void> {
    const normalizedUserId = normalizeRequiredValue(userId, "userId");
    const normalizedPassword = normalizeRequiredPassword(newPassword, "newPassword");
    const context = await this.auth.$context;

    validatePasswordLength(normalizedPassword, context.password.config);

    const hashedPassword = await context.password.hash(normalizedPassword);
    const now = new Date().toISOString();

    const result = this.database.prepare(
      `UPDATE account
       SET password = ?,
           updatedAt = ?
       WHERE userId = ?
         AND providerId = 'credential'`,
    ).run(hashedPassword, now, normalizedUserId);

    if (result.changes === 0) {
      throw new Error(`Collaboration auth account not found for user ${normalizedUserId}`);
    }

    if (options?.passwordChangeRequired !== undefined) {
      this.database.prepare(
        `UPDATE collaboration_user
         SET password_change_required = ?,
             updated_at = ?
         WHERE user_id = ?`,
      ).run(options.passwordChangeRequired ? 1 : 0, now, normalizedUserId);
    }
  }

  async verifyUserPassword(userId: string, password: string): Promise<boolean> {
    const normalizedUserId = normalizeRequiredValue(userId, "userId");
    const normalizedPassword = normalizeRequiredPassword(password, "password");
    const row = this.database.prepare<[string], { password: string | null }>(
      `SELECT password
       FROM account
       WHERE userId = ?
         AND providerId = 'credential'`,
    ).get(normalizedUserId);

    if (!row?.password) {
      return false;
    }

    const context = await this.auth.$context;
    return context.password.verify({ hash: row.password, password: normalizedPassword });
  }
}

function normalizeRequiredValue(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Missing collaboration auth ${fieldName}`);
  }

  return normalized;
}

function normalizeRequiredPassword(value: string, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`Missing collaboration auth ${fieldName}`);
  }

  if (value.length === 0) {
    throw new Error(`Missing collaboration auth ${fieldName}`);
  }

  return value;
}

function validatePasswordLength(
  password: string,
  limits: { minPasswordLength: number; maxPasswordLength: number },
): void {
  if (password.length < limits.minPasswordLength) {
    throw new Error(`Password must be at least ${limits.minPasswordLength} characters`);
  }

  if (password.length > limits.maxPasswordLength) {
    throw new Error(`Password must be at most ${limits.maxPasswordLength} characters`);
  }
}

function normalizeCookieHeader(cookieHeader: string | string[] | undefined): string | null {
  if (Array.isArray(cookieHeader)) {
    const entries = cookieHeader.map((entry) => entry.trim()).filter(Boolean);
    return entries.length > 0 ? entries.join("; ") : null;
  }

  const normalized = cookieHeader?.trim();
  return normalized ? normalized : null;
}

function serializeSignedCookie(
  name: string,
  value: string,
  secret: string | BufferSource,
  attributes: CookieAttributes,
): string {
  const normalizedSecret = normalizeSecret(secret);
  const encodedValue = encodeURIComponent(value);
  const signature = createHmac("sha256", normalizedSecret).update(value).digest("base64url");
  return serializeCookie(name, `${encodedValue}.${signature}`, attributes);
}

function serializeCookie(name: string, value: string, attributes: CookieAttributes): string {
  const segments = [`${name}=${value}`];

  if (attributes.maxAge !== undefined) {
    segments.push(`Max-Age=${Math.max(0, Math.floor(attributes.maxAge))}`);
  }

  segments.push(`Path=${attributes.path ?? "/"}`);

  if (attributes.domain) {
    segments.push(`Domain=${attributes.domain}`);
  }

  if (attributes.httpOnly) {
    segments.push("HttpOnly");
  }

  if (attributes.secure) {
    segments.push("Secure");
  }

  const sameSite = normalizeSameSite(attributes.sameSite);
  if (sameSite) {
    segments.push(`SameSite=${sameSite}`);
  }

  return segments.join("; ");
}

function normalizeSameSite(value: CookieAttributes["sameSite"]): "Lax" | "Strict" | "None" | null {
  if (value === true) {
    return "Strict";
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "lax") {
    return "Lax";
  }

  if (normalized === "strict") {
    return "Strict";
  }

  if (normalized === "none") {
    return "None";
  }

  return null;
}

function normalizeSecret(secret: string | BufferSource): string | Buffer {
  if (typeof secret === "string") {
    return secret;
  }

  if (secret instanceof ArrayBuffer) {
    return Buffer.from(secret);
  }

  if (ArrayBuffer.isView(secret)) {
    return Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength);
  }

  return Buffer.from(String(secret));
}
