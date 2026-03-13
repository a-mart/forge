const EXPO_PUSH_SEND_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_PUSH_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  sound?: "default";
  data?: Record<string, unknown>;
  channelId?: string;
}

export interface ExpoSendResult {
  ok: boolean;
  retryable: boolean;
  ticketId?: string;
  error?: string;
  errorCode?: string;
}

export interface ExpoReceipt {
  status: "ok" | "error";
  message?: string;
  details?: {
    error?: string;
    [key: string]: unknown;
  };
}

export class ExpoPushClient {
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options?: { fetchImpl?: typeof fetch; requestTimeoutMs?: number }) {
    this.fetchImpl = options?.fetchImpl ?? fetch;
    this.requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async send(message: ExpoPushMessage): Promise<ExpoSendResult> {
    let response: Response;
    try {
      response = await this.fetchWithTimeout(EXPO_PUSH_SEND_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify(message)
      });
    } catch (error) {
      return toRetryableTransportError(error);
    }

    const payload = await parseJsonSafe(response);

    if (!response.ok) {
      const retryable = response.status >= 500 || response.status === 429;
      const message =
        extractExpoErrorMessage(payload) ?? `Expo push send failed with status ${response.status}`;

      return {
        ok: false,
        retryable,
        error: message
      };
    }

    const ticket = normalizeFirstExpoTicket(payload);
    if (!ticket) {
      return {
        ok: false,
        retryable: false,
        error: "Invalid Expo push ticket response"
      };
    }

    if (ticket.status === "ok") {
      return {
        ok: true,
        retryable: false,
        ticketId: normalizeOptionalString(ticket.id)
      };
    }

    const errorCode = normalizeOptionalString(ticket.details?.error);
    return {
      ok: false,
      retryable: shouldRetryExpoTicketError(errorCode),
      error: normalizeOptionalString(ticket.message) ?? "Expo push ticket rejected",
      errorCode
    };
  }

  async getReceipts(receiptIds: string[]): Promise<Record<string, ExpoReceipt>> {
    if (receiptIds.length === 0) {
      return {};
    }

    const response = await this.fetchWithTimeout(EXPO_PUSH_RECEIPTS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({ ids: receiptIds })
    });

    const payload = await parseJsonSafe(response);

    if (!response.ok) {
      const message =
        extractExpoErrorMessage(payload) ?? `Expo push receipts request failed with status ${response.status}`;
      throw new Error(message);
    }

    return normalizeReceiptsResponse(payload);
  }

  private async fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.requestTimeoutMs);

    try {
      return await this.fetchImpl(input, {
        ...init,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

type ExpoPushTicket = {
  status?: unknown;
  id?: unknown;
  message?: unknown;
  details?: {
    error?: unknown;
    [key: string]: unknown;
  };
};

function normalizeFirstExpoTicket(payload: unknown): ExpoPushTicket | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const maybe = payload as { data?: unknown };
  const data = maybe.data;

  if (Array.isArray(data)) {
    return (data[0] as ExpoPushTicket | undefined) ?? null;
  }

  if (data && typeof data === "object") {
    return data as ExpoPushTicket;
  }

  return null;
}

function normalizeReceiptsResponse(payload: unknown): Record<string, ExpoReceipt> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }

  const maybe = payload as { data?: unknown };
  if (!maybe.data || typeof maybe.data !== "object" || Array.isArray(maybe.data)) {
    return {};
  }

  const receipts: Record<string, ExpoReceipt> = {};

  for (const [receiptId, rawReceipt] of Object.entries(maybe.data)) {
    if (!rawReceipt || typeof rawReceipt !== "object" || Array.isArray(rawReceipt)) {
      continue;
    }

    const receipt = rawReceipt as {
      status?: unknown;
      message?: unknown;
      details?: unknown;
    };

    const statusRaw = normalizeOptionalString(receipt.status);
    const status = statusRaw === "ok" || statusRaw === "error" ? statusRaw : undefined;
    if (!status) {
      continue;
    }

    const details =
      receipt.details && typeof receipt.details === "object" && !Array.isArray(receipt.details)
        ? {
            ...(receipt.details as Record<string, unknown>),
            error: normalizeOptionalString((receipt.details as { error?: unknown }).error)
          }
        : undefined;

    receipts[receiptId] = {
      status,
      message: normalizeOptionalString(receipt.message),
      details
    };
  }

  return receipts;
}

function extractExpoErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  const maybe = payload as {
    errors?: unknown;
  };

  if (!Array.isArray(maybe.errors) || maybe.errors.length === 0) {
    return undefined;
  }

  const first = maybe.errors[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    return undefined;
  }

  const message = (first as { message?: unknown }).message;
  return normalizeOptionalString(message);
}

function shouldRetryExpoTicketError(errorCode: string | undefined): boolean {
  if (!errorCode) {
    return false;
  }

  return errorCode === "MessageRateExceeded" || errorCode === "ExpoServerError";
}

function toRetryableTransportError(error: unknown): ExpoSendResult {
  if (error instanceof Error && error.name === "AbortError") {
    return {
      ok: false,
      retryable: true,
      error: "Expo push request timed out"
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    retryable: true,
    error: `Expo push transport error: ${message}`
  };
}

async function parseJsonSafe(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
