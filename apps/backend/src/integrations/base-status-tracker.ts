import { EventEmitter } from "node:events";

export type BaseConnectionState =
  | "disabled"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export interface BaseStatusEvent<TType extends string, TState extends string = BaseConnectionState> {
  type: TType;
  managerId?: string;
  integrationProfileId?: string;
  state: TState;
  enabled: boolean;
  updatedAt: string;
  message?: string;
}

type CoreStatusKeys =
  | "type"
  | "updatedAt"
  | "state"
  | "enabled"
  | "managerId"
  | "integrationProfileId"
  | "message";

type ExtraStatusKeys<TEvent extends BaseStatusEvent<string, string>> = Exclude<
  keyof TEvent,
  CoreStatusKeys
>;

export type BaseStatusUpdate<TEvent extends BaseStatusEvent<string, string>> = {
  state?: TEvent["state"];
  enabled?: boolean;
  managerId?: string;
  integrationProfileId?: string;
  message?: string;
} & Partial<Record<ExtraStatusKeys<TEvent>, string | undefined>>;

export class BaseStatusTracker<TEvent extends BaseStatusEvent<string, string>> extends EventEmitter {
  private snapshot: TEvent;
  private readonly extraFields: readonly ExtraStatusKeys<TEvent>[];

  constructor(options: {
    type: TEvent["type"];
    initial?: Partial<Omit<TEvent, "type" | "updatedAt">>;
    extraFields?: readonly ExtraStatusKeys<TEvent>[];
  }) {
    super();

    this.extraFields = options.extraFields ?? [];

    const snapshot = {
      type: options.type,
      managerId: normalizeOptionalString(options.initial?.managerId),
      integrationProfileId: normalizeOptionalString(options.initial?.integrationProfileId),
      state: options.initial?.state ?? ("disabled" as TEvent["state"]),
      enabled: options.initial?.enabled ?? false,
      updatedAt: new Date().toISOString(),
      message: normalizeOptionalString(options.initial?.message)
    } as TEvent;

    const initial = options.initial as Record<string, unknown> | undefined;
    for (const field of this.extraFields) {
      const value = initial?.[field as string];
      (snapshot as Record<string, unknown>)[field as string] = normalizeOptionalString(
        value as string | undefined
      );
    }

    this.snapshot = snapshot;
  }

  getSnapshot(): TEvent {
    return { ...this.snapshot };
  }

  update(next: BaseStatusUpdate<TEvent>): TEvent {
    const updated = {
      ...this.snapshot,
      state: next.state ?? this.snapshot.state,
      enabled: next.enabled ?? this.snapshot.enabled,
      managerId:
        "managerId" in next ? normalizeOptionalString(next.managerId) : this.snapshot.managerId,
      integrationProfileId:
        "integrationProfileId" in next
          ? normalizeOptionalString(next.integrationProfileId)
          : this.snapshot.integrationProfileId,
      message: next.message === undefined ? this.snapshot.message : normalizeOptionalString(next.message),
      updatedAt: new Date().toISOString()
    } as TEvent;

    for (const field of this.extraFields) {
      if (!(field in next)) {
        continue;
      }

      const value = (next as Record<string, unknown>)[field as string] as string | undefined;
      (updated as Record<string, unknown>)[field as string] = normalizeOptionalString(value);
    }

    this.snapshot = updated;
    const snapshot = this.getSnapshot();
    this.emit("status", snapshot);
    return snapshot;
  }
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
