import type { DurableObjectStateBinding } from "./types.js";

interface UploadWindowState {
  windowStartMs: number;
  count: number;
}

interface ShareQuotaState {
  bytes: number;
  expiresAtMs: number;
  downloads: number;
  egressBytes: number;
  pendingDownloads?: number;
  pendingEgressBytes?: number;
}

interface ReserveUploadRequest {
  ip: string;
  shareId: string;
  bytes: number;
  expiresAtMs: number;
  nowMs: number;
  uploadRateLimitPerMinute: number;
  maxActiveObjects: number;
  maxActiveStorageBytes: number;
}

interface ReserveDownloadRequest {
  shareId: string;
  nowMs: number;
  downloadRateLimitPerMinute: number;
  maxDownloadsPerShare: number;
  maxEgressBytesPerShare: number;
}

interface CommitDownloadRequest {
  reservationId: string;
  nowMs: number;
}

interface RollbackDownloadRequest {
  reservationId: string;
}

interface ReleaseShareRequest {
  shareId: string;
}

interface DownloadReservationState {
  shareId: string;
  bytes: number;
  expiresAtMs: number;
}

const META_ACTIVE_OBJECTS_KEY = "meta:activeObjects";
const META_ACTIVE_BYTES_KEY = "meta:activeBytes";
const META_LEGACY_DOWNLOAD_RESERVATIONS_MIGRATED_KEY = "meta:legacyDownloadReservationsMigrated";
const SHARE_PREFIX = "share:";
const UPLOAD_WINDOW_PREFIX = "upload:";
const DOWNLOAD_WINDOW_PREFIX = "download:";
const DOWNLOAD_RESERVATION_PREFIX = "download-reservation:";
const DOWNLOAD_RESERVATION_TTL_MS = 60_000;

export class SkillShareLimiter {
  constructor(private readonly state: DurableObjectStateBinding) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/reserve-upload") {
        return jsonResponse(await this.reserveUpload(await request.json() as ReserveUploadRequest));
      }
      if (request.method === "POST" && url.pathname === "/reserve-download") {
        return jsonResponse(await this.reserveDownload(await request.json() as ReserveDownloadRequest));
      }
      if (request.method === "POST" && url.pathname === "/commit-download") {
        return jsonResponse(await this.commitDownload(await request.json() as CommitDownloadRequest));
      }
      if (request.method === "POST" && url.pathname === "/rollback-download") {
        return jsonResponse(await this.rollbackDownload(await request.json() as RollbackDownloadRequest));
      }
      if (request.method === "POST" && url.pathname === "/release-share") {
        return jsonResponse(await this.releaseShare(await request.json() as ReleaseShareRequest));
      }
      if (request.method === "POST" && url.pathname === "/cleanup-expired") {
        const body = await request.json() as { nowMs: number };
        return jsonResponse(await this.cleanupExpiredShares(body.nowMs));
      }
    } catch {
      return jsonResponse({ ok: false, reason: "limiter_error" }, 500);
    }

    return jsonResponse({ ok: false, reason: "not_found" }, 404);
  }

  private async reserveUpload(body: ReserveUploadRequest): Promise<Record<string, unknown>> {
    if (!isSafeRequestNumber(body.bytes) || !isSafeRequestNumber(body.expiresAtMs) || !isSafeRequestNumber(body.nowMs)) {
      return { ok: false, reason: "invalid_request" };
    }

    await this.cleanupExpiredShares(body.nowMs);
    await this.cleanupOldUploadWindows(body.nowMs);

    const uploadWindow = await this.incrementWindowCounter({
      keyPrefix: UPLOAD_WINDOW_PREFIX,
      subject: normalizeSubject(body.ip),
      nowMs: body.nowMs,
      limitPerMinute: body.uploadRateLimitPerMinute
    });
    if (!uploadWindow.ok) {
      return { ok: false, reason: "upload_rate_limited", retryAfterSeconds: uploadWindow.retryAfterSeconds };
    }

    const activeObjects = await this.getNumber(META_ACTIVE_OBJECTS_KEY);
    const activeBytes = await this.getNumber(META_ACTIVE_BYTES_KEY);
    if (activeObjects + 1 > body.maxActiveObjects) {
      return { ok: false, reason: "active_object_budget_exceeded" };
    }
    if (activeBytes + body.bytes > body.maxActiveStorageBytes) {
      return { ok: false, reason: "active_storage_budget_exceeded" };
    }

    const shareKey = `${SHARE_PREFIX}${body.shareId}`;
    const existing = await this.state.storage.get<ShareQuotaState>(shareKey);
    if (existing) {
      return { ok: false, reason: "share_id_collision" };
    }

    await this.state.storage.put<ShareQuotaState>(shareKey, {
      bytes: body.bytes,
      expiresAtMs: body.expiresAtMs,
      downloads: 0,
      egressBytes: 0
    });
    await this.state.storage.put(META_ACTIVE_OBJECTS_KEY, activeObjects + 1);
    await this.state.storage.put(META_ACTIVE_BYTES_KEY, activeBytes + body.bytes);
    return { ok: true };
  }

  private async reserveDownload(body: ReserveDownloadRequest): Promise<Record<string, unknown>> {
    if (!isSafeRequestNumber(body.nowMs)) {
      return { ok: false, reason: "invalid_request" };
    }

    await this.cleanupStaleDownloadReservations(body.shareId, body.nowMs);

    const shareKey = `${SHARE_PREFIX}${body.shareId}`;
    const share = await this.state.storage.get<ShareQuotaState>(shareKey);
    if (!share) {
      return { ok: false, reason: "share_quota_missing" };
    }
    if (share.expiresAtMs <= body.nowMs) {
      await this.releaseShare({ shareId: body.shareId });
      return { ok: false, reason: "expired", retryAfterSeconds: 1 };
    }

    const downloadWindow = await this.incrementWindowCounter({
      keyPrefix: DOWNLOAD_WINDOW_PREFIX,
      subject: body.shareId,
      nowMs: body.nowMs,
      limitPerMinute: body.downloadRateLimitPerMinute
    });
    if (!downloadWindow.ok) {
      return { ok: false, reason: "download_rate_limited", retryAfterSeconds: downloadWindow.retryAfterSeconds };
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((share.expiresAtMs - body.nowMs) / 1000));
    const pendingDownloads = share.pendingDownloads ?? 0;
    const pendingEgressBytes = share.pendingEgressBytes ?? 0;
    if (share.downloads + pendingDownloads + 1 > body.maxDownloadsPerShare) {
      return { ok: false, reason: "share_download_budget_exceeded", retryAfterSeconds };
    }
    if (share.egressBytes + pendingEgressBytes + share.bytes > body.maxEgressBytesPerShare) {
      return { ok: false, reason: "share_egress_budget_exceeded", retryAfterSeconds };
    }

    const reservationId = createDownloadReservationId(body.shareId);
    share.pendingDownloads = pendingDownloads + 1;
    share.pendingEgressBytes = pendingEgressBytes + share.bytes;
    await this.state.storage.put(shareKey, share);
    await this.state.storage.put<DownloadReservationState>(getDownloadReservationKey(reservationId), {
      shareId: body.shareId,
      bytes: share.bytes,
      expiresAtMs: Math.min(body.nowMs + DOWNLOAD_RESERVATION_TTL_MS, share.expiresAtMs)
    });
    return { ok: true, reservationId, bytes: share.bytes };
  }

  private async commitDownload(body: CommitDownloadRequest): Promise<Record<string, unknown>> {
    if (!isSafeRequestNumber(body.nowMs)) {
      return { ok: false, reason: "invalid_request" };
    }

    const reservationKey = getDownloadReservationKey(body.reservationId);
    const reservation = await this.state.storage.get<DownloadReservationState>(reservationKey);
    if (!reservation) {
      return { ok: false, reason: "reservation_missing" };
    }

    const shareKey = `${SHARE_PREFIX}${reservation.shareId}`;
    const share = await this.state.storage.get<ShareQuotaState>(shareKey);
    if (!share) {
      await this.state.storage.delete(reservationKey);
      return { ok: false, reason: "expired" };
    }
    if (share.expiresAtMs <= body.nowMs) {
      await this.rollbackReservation(reservationKey, reservation);
      return { ok: false, reason: "expired" };
    }

    this.applyReservationDelta(share, reservation, "rollback");
    share.downloads += 1;
    share.egressBytes += reservation.bytes;
    await this.state.storage.put(shareKey, share);
    await this.state.storage.delete(reservationKey);
    return { ok: true };
  }

  private async rollbackDownload(body: RollbackDownloadRequest): Promise<Record<string, unknown>> {
    const reservationKey = getDownloadReservationKey(body.reservationId);
    const reservation = await this.state.storage.get<DownloadReservationState>(reservationKey);
    if (!reservation) {
      return { ok: true, rolledBack: false };
    }

    await this.rollbackReservation(reservationKey, reservation);
    return { ok: true, rolledBack: true };
  }

  private async releaseShare(body: ReleaseShareRequest): Promise<Record<string, unknown>> {
    const shareKey = `${SHARE_PREFIX}${body.shareId}`;
    const share = await this.state.storage.get<ShareQuotaState>(shareKey);
    if (!share) {
      return { ok: true, released: false };
    }

    await this.state.storage.delete(shareKey);
    await this.deleteReservationsForShare(body.shareId);
    await this.state.storage.put(META_ACTIVE_OBJECTS_KEY, Math.max(0, await this.getNumber(META_ACTIVE_OBJECTS_KEY) - 1));
    await this.state.storage.put(META_ACTIVE_BYTES_KEY, Math.max(0, await this.getNumber(META_ACTIVE_BYTES_KEY) - share.bytes));
    return { ok: true, released: true };
  }

  private async cleanupExpiredShares(nowMs: number): Promise<Record<string, unknown>> {
    const shares = await this.state.storage.list<ShareQuotaState>({ prefix: SHARE_PREFIX });
    let released = 0;
    for (const [key, share] of shares.entries()) {
      if (share.expiresAtMs <= nowMs) {
        const shareId = key.slice(SHARE_PREFIX.length);
        await this.releaseShare({ shareId });
        released += 1;
      }
    }

    return { ok: true, released };
  }

  private async incrementWindowCounter(options: {
    keyPrefix: string;
    subject: string;
    nowMs: number;
    limitPerMinute: number;
  }): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
    const windowStartMs = Math.floor(options.nowMs / 60_000) * 60_000;
    const key = `${options.keyPrefix}${options.subject}:${windowStartMs}`;
    const existing = await this.state.storage.get<UploadWindowState>(key);
    const count = existing?.windowStartMs === windowStartMs ? existing.count : 0;
    if (count >= options.limitPerMinute) {
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((windowStartMs + 60_000 - options.nowMs) / 1000))
      };
    }

    await this.state.storage.put<UploadWindowState>(key, { windowStartMs, count: count + 1 });
    return { ok: true };
  }

  private async cleanupOldUploadWindows(nowMs: number): Promise<void> {
    const oldestWindowStartMs = Math.floor(nowMs / 60_000) * 60_000 - 5 * 60_000;
    for (const prefix of [UPLOAD_WINDOW_PREFIX, DOWNLOAD_WINDOW_PREFIX]) {
      const windows = await this.state.storage.list<UploadWindowState>({ prefix });
      for (const [key, windowState] of windows.entries()) {
        if (windowState.windowStartMs < oldestWindowStartMs) {
          await this.state.storage.delete(key);
        }
      }
    }
  }

  private async cleanupStaleDownloadReservations(shareId: string, nowMs: number): Promise<void> {
    await this.migrateLegacyDownloadReservationsOnce();
    const reservations = await this.state.storage.list<DownloadReservationState>({ prefix: getShareReservationPrefix(shareId) });
    for (const [key, reservation] of reservations.entries()) {
      if (reservation.expiresAtMs <= nowMs) {
        await this.rollbackReservation(key, reservation);
      }
    }
  }

  private async migrateLegacyDownloadReservationsOnce(): Promise<void> {
    const alreadyMigrated = await this.state.storage.get<boolean>(META_LEGACY_DOWNLOAD_RESERVATIONS_MIGRATED_KEY);
    if (alreadyMigrated) {
      return;
    }

    // Compatibility for the short-lived rollout that keyed reservations globally as
    // `download-reservation:<uuid>`. This one-time scan rolls those pending records
    // back and then sets a marker so public download paths keep share-scoped cleanup.
    const reservations = await this.state.storage.list<DownloadReservationState>({ prefix: DOWNLOAD_RESERVATION_PREFIX });
    for (const [key, reservation] of reservations.entries()) {
      if (isLegacyDownloadReservationKey(key)) {
        await this.rollbackReservation(key, reservation);
      }
    }
    await this.state.storage.put(META_LEGACY_DOWNLOAD_RESERVATIONS_MIGRATED_KEY, true);
  }

  private async rollbackReservation(key: string, reservation: DownloadReservationState): Promise<void> {
    const shareKey = `${SHARE_PREFIX}${reservation.shareId}`;
    const share = await this.state.storage.get<ShareQuotaState>(shareKey);
    if (share) {
      this.applyReservationDelta(share, reservation, "rollback");
      await this.state.storage.put(shareKey, share);
    }
    await this.state.storage.delete(key);
  }

  private async deleteReservationsForShare(shareId: string): Promise<void> {
    await this.migrateLegacyDownloadReservationsOnce();
    const reservations = await this.state.storage.list<DownloadReservationState>({ prefix: getShareReservationPrefix(shareId) });
    for (const [key, reservation] of reservations.entries()) {
      if (reservation.shareId === shareId) {
        await this.state.storage.delete(key);
      }
    }
  }

  private applyReservationDelta(
    share: ShareQuotaState,
    reservation: DownloadReservationState,
    direction: "rollback"
  ): void {
    if (direction === "rollback") {
      share.pendingDownloads = Math.max(0, (share.pendingDownloads ?? 0) - 1);
      share.pendingEgressBytes = Math.max(0, (share.pendingEgressBytes ?? 0) - reservation.bytes);
    }
  }

  private async getNumber(key: string): Promise<number> {
    const value = await this.state.storage.get<number>(key);
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }
}

function isLegacyDownloadReservationKey(key: string): boolean {
  const reservationId = key.slice(DOWNLOAD_RESERVATION_PREFIX.length);
  return !reservationId.includes(":");
}

function createDownloadReservationId(shareId: string): string {
  return `${shareId}:${crypto.randomUUID()}`;
}

function getShareReservationPrefix(shareId: string): string {
  return `${DOWNLOAD_RESERVATION_PREFIX}${shareId}:`;
}

function getDownloadReservationKey(reservationId: string): string {
  return `${DOWNLOAD_RESERVATION_PREFIX}${reservationId}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function normalizeSubject(value: string): string {
  return value.replace(/[^A-Za-z0-9:._-]/g, "_").slice(0, 128) || "unknown";
}

function isSafeRequestNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
