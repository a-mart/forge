import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

const SENSITIVE_METADATA_KEY_PATTERN = /(password|token|cookie|user[_-]?agent|ip)/i;
const SENSITIVE_METADATA_VALUE_PATTERN = /(forge_collab_session|collaboration\/invite\/|set-cookie|authorization:|bearer\s+)/i;

export interface CollaborationAuditEntry {
  action: string;
  actorUserId?: string | null;
  targetUserId?: string | null;
  targetInviteId?: string | null;
  metadata?: Record<string, unknown>;
}

export class CollaborationAuditService {
  constructor(private readonly db: Database.Database) {}

  log(entry: CollaborationAuditEntry): void {
    const action = normalizeRequiredString(entry.action, "action");
    const actorUserId = normalizeOptionalString(entry.actorUserId);
    const targetUserId = normalizeOptionalString(entry.targetUserId);
    const targetInviteId = normalizeOptionalString(entry.targetInviteId);
    const createdAt = new Date().toISOString();
    const metadataJson = serializeMetadata(
      withIdentitySnapshots(entry.metadata, {
        actorUserId,
        targetUserId,
        targetInviteId,
      }),
    );

    this.db.prepare(
      `INSERT INTO collaboration_audit_log (
         audit_id,
         action,
         actor_user_id,
         target_user_id,
         target_invite_id,
         created_at,
         metadata_json
       )
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), action, actorUserId, targetUserId, targetInviteId, createdAt, metadataJson);
  }
}

function withIdentitySnapshots(
  metadata: Record<string, unknown> | undefined,
  identity: { actorUserId: string | null; targetUserId: string | null; targetInviteId: string | null },
): Record<string, unknown> | undefined {
  const enrichedMetadata = metadata ? { ...metadata } : {};

  if (identity.actorUserId && enrichedMetadata.actorUserIdSnapshot === undefined) {
    enrichedMetadata.actorUserIdSnapshot = identity.actorUserId;
  }

  if (identity.targetUserId && enrichedMetadata.targetUserIdSnapshot === undefined) {
    enrichedMetadata.targetUserIdSnapshot = identity.targetUserId;
  }

  if (identity.targetInviteId && enrichedMetadata.targetInviteIdSnapshot === undefined) {
    enrichedMetadata.targetInviteIdSnapshot = identity.targetInviteId;
  }

  return Object.keys(enrichedMetadata).length > 0 ? enrichedMetadata : undefined;
}

function serializeMetadata(metadata: Record<string, unknown> | undefined): string | null {
  if (!metadata) {
    return null;
  }

  const sanitized = sanitizeMetadataValue(metadata);
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    return null;
  }

  const entries = Object.entries(sanitized);
  if (entries.length === 0) {
    return null;
  }

  return JSON.stringify(Object.fromEntries(entries));
}

function sanitizeMetadataValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return SENSITIVE_METADATA_VALUE_PATTERN.test(value) ? "[redacted]" : value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeMetadataValue(entry)).filter((entry) => entry !== undefined);
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SENSITIVE_METADATA_KEY_PATTERN.test(key))
        .map(([key, entryValue]) => [key, sanitizeMetadataValue(entryValue)] as const)
        .filter(([, entryValue]) => entryValue !== undefined),
    );
  }

  return undefined;
}

function normalizeRequiredString(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Missing collaboration audit ${fieldName}`);
  }

  return normalized;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}
