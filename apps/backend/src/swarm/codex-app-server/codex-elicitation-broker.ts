import { randomUUID } from "node:crypto";

export type CodexElicitationDecision = "allow" | "deny" | "cancel";
export type CodexElicitationMode = "form" | "url";
export type CodexElicitationPersistScope = "session" | "always";

export interface CodexElicitationField {
  key: string;
  label: string;
  type: "string" | "boolean" | "number" | "enum";
  required: boolean;
  options?: string[];
  sensitive?: boolean;
}

export interface CodexPendingElicitation {
  elicitationId: string;
  managerAgentId: string;
  sidecarAgentId: string;
  threadId: string;
  turnId: string;
  mode: CodexElicitationMode;
  title?: string;
  message: string;
  fields?: CodexElicitationField[];
  /** Safe normalized origin shown when a live URL is no longer available. */
  urlOrigin?: string;
  persistScopes: CodexElicitationPersistScope[];
}

/** Full URL is only carried on the initial live event; never bootstrap it. */
export interface CodexLiveElicitation extends CodexPendingElicitation {
  url?: string;
}

interface Pending extends CodexLiveElicitation {
  resolve: (response: Record<string, unknown>) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface CodexElicitationBrokerOptions {
  now?: () => number;
  timeoutMs?: number;
  emit: (request: CodexLiveElicitation) => void;
  dismiss: (elicitationId: string, managerAgentId: string) => void;
  logDebug: (message: string, details?: unknown) => void;
}

/**
 * Ephemeral, fail-closed bridge between a server initiated MCP elicitation and
 * the Builder UI. Nothing in this class is transcript-backed: form values and
 * upstream `_meta` never enter Forge persistence or event history.
 */
export class CodexElicitationBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly timeoutMs: number;

  constructor(private readonly options: CodexElicitationBrokerOptions) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  request(input: {
    params: unknown;
    active: { managerAgentId: string; sidecarAgentId: string; threadId?: string; turnId?: string } | undefined;
  }): Promise<Record<string, unknown>> {
    const parsed = parseElicitation(input.params);
    const active = input.active;
    if (!parsed || !active?.threadId || !active.turnId || parsed.threadId !== active.threadId || parsed.turnId !== active.turnId) {
      this.options.logDebug("codex_elicitation:declined:uncorrelated", {
        hasActiveTurn: Boolean(active),
        hasParsedRequest: Boolean(parsed),
      });
      return Promise.resolve({ action: "decline" });
    }

    const elicitationId = randomUUID();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => this.finish(elicitationId, { action: "cancel" }), this.timeoutMs);
      const pending: Pending = { ...parsed, elicitationId, managerAgentId: active.managerAgentId, sidecarAgentId: active.sidecarAgentId, resolve, timeout };
      this.pending.set(elicitationId, pending);
      this.options.emit(liveRequest(pending));
    });
  }

  respond(input: {
    elicitationId: string;
    managerAgentId: string;
    decision: CodexElicitationDecision;
    values?: Record<string, unknown>;
    persistScope?: CodexElicitationPersistScope;
  }): boolean {
    const pending = this.pending.get(input.elicitationId);
    if (!pending || pending.managerAgentId !== input.managerAgentId) return false;
    if (input.decision !== "allow") {
      this.finish(input.elicitationId, { action: input.decision === "deny" ? "decline" : "cancel" });
      return true;
    }
    if (input.persistScope && !pending.persistScopes.includes(input.persistScope)) return false;
    const content = pending.mode === "form" ? validateValues(pending.fields ?? [], input.values) : {};
    if (!content) return false;
    this.finish(input.elicitationId, {
      action: "accept",
      ...(pending.mode === "form" ? { content } : {}),
      ...(input.persistScope ? { _meta: { persist: input.persistScope } } : {}),
    });
    return true;
  }

  cancelForSidecar(sidecarAgentId: string): void {
    for (const pending of [...this.pending.values()]) if (pending.sidecarAgentId === sidecarAgentId) this.finish(pending.elicitationId, { action: "cancel" });
  }

  cancelAll(): void {
    for (const pending of [...this.pending.values()]) this.finish(pending.elicitationId, { action: "cancel" });
  }

  getPendingForManager(managerAgentId: string): CodexPendingElicitation[] {
    return [...this.pending.values()].filter((item) => item.managerAgentId === managerAgentId).map(publicRequest);
  }

  private finish(id: string, response: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    this.options.dismiss(id, pending.managerAgentId);
    pending.resolve(response);
  }
}

function parseElicitation(params: unknown): Omit<CodexLiveElicitation, "elicitationId" | "managerAgentId" | "sidecarAgentId"> | undefined {
  if (!isRecord(params) || typeof params.threadId !== "string" || typeof params.turnId !== "string" || typeof params.message !== "string") return undefined;
  const mode = params.mode === "url" || typeof params.url === "string" ? "url" : "form";
  const url = mode === "url" ? parseUrl(params.url) : undefined;
  if (mode === "url" && !url) return undefined;
  const fields = mode === "form" ? parseFields(params.requestedSchema ?? params.schema) : undefined;
  if (mode === "form" && !fields) return undefined;
  return {
    threadId: params.threadId,
    turnId: params.turnId,
    mode,
    message: bounded(params.message, 4_000),
    ...(typeof params.title === "string" ? { title: bounded(params.title, 300) } : {}),
    ...(fields ? { fields } : {}),
    ...(url ? { url: url.href, urlOrigin: url.origin } : {}),
    persistScopes: parsePersistScopes(params._meta),
  };
}

function parseFields(schema: unknown): CodexElicitationField[] | undefined {
  if (!isRecord(schema) || !isRecord(schema.properties)) return undefined;
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((x): x is string => typeof x === "string") : []);
  const fields: CodexElicitationField[] = [];
  for (const [key, raw] of Object.entries(schema.properties)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) || !isRecord(raw)) return undefined;
    const enumValues = Array.isArray(raw.enum) ? raw.enum.filter((x): x is string => typeof x === "string").slice(0, 50) : undefined;
    const type = enumValues?.length ? "enum" : raw.type === "boolean" ? "boolean" : raw.type === "number" || raw.type === "integer" ? "number" : raw.type === "string" || raw.type === undefined ? "string" : undefined;
    if (!type) return undefined;
    fields.push({ key, label: typeof raw.title === "string" ? bounded(raw.title, 200) : key, type, required: required.has(key), ...(enumValues?.length ? { options: enumValues.map((x) => bounded(x, 200)) } : {}), ...(raw.format === "password" || raw.writeOnly === true ? { sensitive: true } : {}) });
  }
  return fields.length <= 32 ? fields : undefined;
}

function validateValues(fields: CodexElicitationField[], values: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!values || !isRecord(values)) return fields.some((field) => field.required) ? undefined : {};
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.key];
    if (value === undefined || value === null || value === "") { if (field.required) return undefined; continue; }
    if (field.type === "string" && typeof value === "string" && value.length <= 16_384) out[field.key] = value;
    else if (field.type === "boolean" && typeof value === "boolean") out[field.key] = value;
    else if (field.type === "number" && typeof value === "number" && Number.isFinite(value)) out[field.key] = value;
    else if (field.type === "enum" && typeof value === "string" && field.options?.includes(value)) out[field.key] = value;
    else return undefined;
  }
  return out;
}

function parsePersistScopes(meta: unknown): CodexElicitationPersistScope[] {
  if (!isRecord(meta)) return [];
  const value = meta.persist;
  const values = Array.isArray(value) ? value : [value];
  return values.filter((item): item is CodexElicitationPersistScope => item === "session" || item === "always");
}
function liveRequest(pending: Pending): CodexLiveElicitation {
  const { elicitationId, managerAgentId, sidecarAgentId, threadId, turnId, mode, title, message, fields, url, urlOrigin, persistScopes } = pending;
  return { elicitationId, managerAgentId, sidecarAgentId, threadId, turnId, mode, ...(title ? { title } : {}), message, ...(fields ? { fields } : {}), ...(url ? { url } : {}), ...(urlOrigin ? { urlOrigin } : {}), persistScopes };
}
function publicRequest(pending: Pending | CodexPendingElicitation): CodexPendingElicitation {
  const { elicitationId, managerAgentId, sidecarAgentId, threadId, turnId, mode, title, message, fields, urlOrigin, persistScopes } = pending;
  return { elicitationId, managerAgentId, sidecarAgentId, threadId, turnId, mode, ...(title ? { title } : {}), message, ...(fields ? { fields } : {}), ...(urlOrigin ? { urlOrigin } : {}), persistScopes };
}
function parseUrl(value: unknown): { href: string; origin: string } | undefined { try { const href = typeof value === "string" ? value : ""; const url = new URL(href); return url.protocol === "https:" || url.protocol === "http:" ? { href, origin: url.origin } : undefined; } catch { return undefined; } }
function bounded(value: string, max: number): string { return value.replace(/[\u0000-\u001F]/g, " ").trim().slice(0, max); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
