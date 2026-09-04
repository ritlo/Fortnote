import { randomUuid } from "@fortnote/shared";
import type { BinaryTransferProgress } from "./contracts";

export const JSON_CONTROL_MAX_BYTES = 1024 * 1024;

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId: string | null = null
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

const clientInstanceId = randomUuid();

export function getClientInstanceId(): string {
  return clientInstanceId;
}

export function isApiRequestError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError;
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const requestId = randomUuid();
  const headers = requestHeaders(init, requestId, true);
  assertBoundedJsonControl(init.body, headers, requestId);

  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers
  });

  if (!response.ok) {
    throw await toApiRequestError(response, requestId);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

interface BinaryApiResponse {
  bytes: Uint8Array;
  headers: Headers;
}

export async function apiBinaryRequest(
  path: string,
  init: RequestInit = {}
): Promise<BinaryApiResponse> {
  const requestId = randomUuid();
  const headers = requestHeaders(init, requestId, false);
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers
  });
  if (!response.ok) {
    throw await toApiRequestError(response, requestId);
  }
  if (response.status === 204) {
    return { bytes: new Uint8Array(), headers: response.headers };
  }
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    headers: response.headers
  };
}

export function requestHeaders(init: RequestInit, requestId: string, defaultJson: boolean): Headers {
  const headers = new Headers(init.headers);
  if (defaultJson && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  headers.set("x-fortnote-client-id", clientInstanceId);
  headers.set("x-request-id", requestId);
  return headers;
}

function assertBoundedJsonControl(
  body: BodyInit | null | undefined,
  headers: Headers,
  requestId: string
): void {
  if (
    typeof body === "string" &&
    headers.get("content-type")?.toLowerCase().startsWith("application/json") &&
    new TextEncoder().encode(body).length > JSON_CONTROL_MAX_BYTES
  ) {
    throw new ApiRequestError(
      0,
      "control_payload_too_large",
      "Control payload exceeds 1 MiB; protected content must use binary chunks",
      requestId
    );
  }
}

async function toApiRequestError(
  response: Response,
  fallbackRequestId: string
): Promise<ApiRequestError> {
  const payload = (await response.json().catch(() => undefined)) as unknown;
  const parsed = parseApiErrorEnvelope(payload);
  return new ApiRequestError(
    response.status,
    parsed?.code ?? "request_failed",
    parsed?.message ?? `Request failed: ${String(response.status)}`,
    parsed?.requestId ?? response.headers.get("x-request-id") ?? fallbackRequestId
  );
}

function parseApiErrorEnvelope(value: unknown): {
  code: string;
  message: string;
  requestId: string | null;
} | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const outer = value as Record<string, unknown>;
  const candidate =
    outer.error && typeof outer.error === "object"
      ? (outer.error as Record<string, unknown>)
      : outer;
  if (typeof candidate.code !== "string" || typeof candidate.message !== "string") {
    return null;
  }
  return {
    code: candidate.code,
    message: candidate.message,
    requestId: typeof candidate.requestId === "string" ? candidate.requestId : null
  };
}

export function applyXhrHeaders(xhr: XMLHttpRequest, headers: Headers): void {
  headers.forEach((value, name) => {
    xhr.setRequestHeader(name, value);
  });
}

export function xhrRequestError(xhr: XMLHttpRequest, requestId: string): ApiRequestError {
  const payload = parseXhrPayload(xhr.response as unknown);
  const parsed = parseApiErrorEnvelope(payload);
  return new ApiRequestError(
    xhr.status,
    parsed?.code ?? "request_failed",
    parsed?.message ?? `Request failed: ${String(xhr.status)}`,
    parsed?.requestId ?? xhr.getResponseHeader("x-request-id") ?? requestId
  );
}

function parseXhrPayload(value: unknown): unknown {
  if (value instanceof ArrayBuffer) {
    const text = new TextDecoder().decode(value);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  return value;
}

export function transferProgress(
  event: ProgressEvent,
  fallbackTotalBytes: number,
  onProgress: ((progress: BinaryTransferProgress) => void) | undefined
): void {
  onProgress?.({
    loadedBytes: event.loaded,
    totalBytes: event.lengthComputable ? event.total : fallbackTotalBytes
  });
}
