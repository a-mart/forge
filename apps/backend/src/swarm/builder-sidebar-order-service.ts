import {
  BUILDER_SIDEBAR_ORDER_MAX_ID_CODE_POINTS,
  BUILDER_SIDEBAR_ORDER_MAX_REFS,
  BUILDER_SIDEBAR_ORDER_MAX_SERIALIZED_BYTES,
  BUILDER_SIDEBAR_ORDER_VERSION,
  type BuilderSidebarOrderRef,
  type BuilderSidebarOrderState,
  type UpdateBuilderSidebarOrderRequest,
} from "@forge/protocol";
import { readFile } from "node:fs/promises";
import { writeJsonFileAtomic } from "../utils/atomic-files.js";
import { isEnoentError } from "../utils/fs-errors.js";
import { getBuilderSidebarOrderPath } from "./storage/data-paths.js";

export const MAX_BUILDER_SIDEBAR_ORDER_REFS = BUILDER_SIDEBAR_ORDER_MAX_REFS;
export const MAX_BUILDER_SIDEBAR_ORDER_ID_LENGTH = BUILDER_SIDEBAR_ORDER_MAX_ID_CODE_POINTS;
/** Maximum compact UTF-8 bytes for the `order` array itself. */
export const MAX_BUILDER_SIDEBAR_ORDER_SERIALIZED_BYTES =
  BUILDER_SIDEBAR_ORDER_MAX_SERIALIZED_BYTES;
/** Raw HTTP envelope budget; leaves bounded room for baseRevision + JSON syntax. */
export const MAX_BUILDER_SIDEBAR_ORDER_REQUEST_BYTES =
  MAX_BUILDER_SIDEBAR_ORDER_SERIALIZED_BYTES + 4 * 1024;

const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const STATE_KEYS = new Set(["version", "revision", "order", "updatedAt"]);
const UPDATE_KEYS = new Set(["baseRevision", "order"]);
const REF_KEYS = new Set(["originId", "profileId"]);

export class BuilderSidebarOrderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuilderSidebarOrderValidationError";
  }
}

export class BuilderSidebarOrderConflictError extends Error {
  readonly current: BuilderSidebarOrderState;

  constructor(current: BuilderSidebarOrderState) {
    super("Builder sidebar order changed since it was loaded.");
    this.name = "BuilderSidebarOrderConflictError";
    this.current = cloneState(current);
  }
}

/**
 * Local-instance-owned, revisioned persistence for the unified Builder sidebar.
 * A service instance serializes all writes so the revision check and atomic
 * rename form one in-process transaction.
 */
export class BuilderSidebarOrderService {
  private readonly filePath: string;
  private readonly now: () => Date;
  private state = createDefaultBuilderSidebarOrder();
  private updateMutex: Promise<void> = Promise.resolve();

  constructor(options: { dataDir: string; now?: () => Date }) {
    this.filePath = getBuilderSidebarOrderPath(options.dataDir);
    this.now = options.now ?? (() => new Date());
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.state = parsePersistedState(JSON.parse(raw) as unknown);
    } catch (error) {
      if (!isEnoentError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[builder-sidebar-order] Ignoring invalid preference at ${this.filePath}: ${message}`);
      }
      this.state = createDefaultBuilderSidebarOrder();
    }
  }

  getState(): BuilderSidebarOrderState {
    return cloneState(this.state);
  }

  async update(value: unknown): Promise<BuilderSidebarOrderState> {
    return this.withUpdateLock(async () => {
      const request = parseUpdateRequest(value);
      if (request.baseRevision !== this.state.revision) {
        throw new BuilderSidebarOrderConflictError(this.state);
      }
      if (this.state.revision >= Number.MAX_SAFE_INTEGER) {
        throw new BuilderSidebarOrderValidationError("revision cannot be incremented safely");
      }

      const next: BuilderSidebarOrderState = {
        version: BUILDER_SIDEBAR_ORDER_VERSION,
        revision: this.state.revision + 1,
        order: cloneRefs(request.order),
        updatedAt: this.now().toISOString(),
      };

      await writeJsonFileAtomic(this.filePath, next);
      this.state = next;
      return cloneState(next);
    });
  }

  private async withUpdateLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.updateMutex;
    let release: (() => void) | undefined;
    this.updateMutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

export function createDefaultBuilderSidebarOrder(): BuilderSidebarOrderState {
  return {
    version: BUILDER_SIDEBAR_ORDER_VERSION,
    revision: 0,
    order: [],
    updatedAt: null,
  };
}

export function parseUpdateRequest(value: unknown): UpdateBuilderSidebarOrderRequest {
  const record = requirePlainRecord(value, "Request body");
  rejectUnknownKeys(record, UPDATE_KEYS, "Request body");
  const baseRevision = requireRevision(record.baseRevision, "baseRevision");
  return {
    baseRevision,
    order: parseRefs(record.order),
  };
}

function parsePersistedState(value: unknown): BuilderSidebarOrderState {
  const record = requirePlainRecord(value, "Persisted preference");
  rejectUnknownKeys(record, STATE_KEYS, "Persisted preference");
  if (record.version !== BUILDER_SIDEBAR_ORDER_VERSION) {
    throw new BuilderSidebarOrderValidationError(
      `Persisted preference version must be ${BUILDER_SIDEBAR_ORDER_VERSION}`,
    );
  }

  const revision = requireRevision(record.revision, "revision");
  const updatedAt = record.updatedAt;
  if (updatedAt !== null && (typeof updatedAt !== "string" || Number.isNaN(Date.parse(updatedAt)))) {
    throw new BuilderSidebarOrderValidationError("updatedAt must be a valid timestamp or null");
  }
  if ((revision === 0) !== (updatedAt === null)) {
    throw new BuilderSidebarOrderValidationError("updatedAt must be null only at revision 0");
  }

  return {
    version: BUILDER_SIDEBAR_ORDER_VERSION,
    revision,
    order: parseRefs(record.order),
    updatedAt,
  };
}

function parseRefs(value: unknown): BuilderSidebarOrderRef[] {
  if (!Array.isArray(value)) {
    throw new BuilderSidebarOrderValidationError("order must be an array");
  }
  if (value.length > MAX_BUILDER_SIDEBAR_ORDER_REFS) {
    throw new BuilderSidebarOrderValidationError(
      `order cannot contain more than ${MAX_BUILDER_SIDEBAR_ORDER_REFS} references`,
    );
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (serializedBytes > MAX_BUILDER_SIDEBAR_ORDER_SERIALIZED_BYTES) {
    throw new BuilderSidebarOrderValidationError(
      `order cannot exceed ${MAX_BUILDER_SIDEBAR_ORDER_SERIALIZED_BYTES} serialized UTF-8 bytes`,
    );
  }

  const seen = new Set<string>();
  return value.map((entry, index) => {
    const record = requirePlainRecord(entry, `order[${index}]`);
    rejectUnknownKeys(record, REF_KEYS, `order[${index}]`);
    const ref = {
      originId: requireId(record.originId, `order[${index}].originId`),
      profileId: requireId(record.profileId, `order[${index}].profileId`),
    };
    const key = `${ref.originId}\u0000${ref.profileId}`;
    if (seen.has(key)) {
      throw new BuilderSidebarOrderValidationError(
        `order contains duplicate reference (${JSON.stringify(ref.originId)}, ${JSON.stringify(ref.profileId)})`,
      );
    }
    seen.add(key);
    return ref;
  });
}

function requirePlainRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BuilderSidebarOrderValidationError(`${fieldName} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, fieldName: string): void {
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) {
    throw new BuilderSidebarOrderValidationError(`${fieldName} contains unknown field ${JSON.stringify(unknown)}`);
  }
}

function requireRevision(value: unknown, fieldName: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new BuilderSidebarOrderValidationError(`${fieldName} must be a non-negative safe integer`);
  }
  return value as number;
}

function requireId(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BuilderSidebarOrderValidationError(`${fieldName} must be a non-empty string`);
  }
  if (Array.from(value).length > MAX_BUILDER_SIDEBAR_ORDER_ID_LENGTH) {
    throw new BuilderSidebarOrderValidationError(
      `${fieldName} cannot exceed ${MAX_BUILDER_SIDEBAR_ORDER_ID_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new BuilderSidebarOrderValidationError(`${fieldName} cannot contain control characters`);
  }
  return value;
}

function cloneRefs(refs: BuilderSidebarOrderRef[]): BuilderSidebarOrderRef[] {
  return refs.map((ref) => ({ ...ref }));
}

function cloneState(state: BuilderSidebarOrderState): BuilderSidebarOrderState {
  return {
    ...state,
    order: cloneRefs(state.order),
  };
}
