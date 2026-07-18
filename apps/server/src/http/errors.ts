import type { Response } from "express";

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "payload_too_large"
  | "quota_exceeded"
  | "rate_limited"
  | "csrf_failed"
  | "storage_limit"
  | "stale_epoch"
  | "rotation_pending"
  | "chunk_missing"
  | "chunk_conflict"
  | "manifest_mismatch"
  | "internal_error";

interface ApiErrorEnvelope {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId: string;
  };
}

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  quota_exceeded: 413,
  rate_limited: 429,
  csrf_failed: 403,
  storage_limit: 413,
  stale_epoch: 409,
  rotation_pending: 409,
  chunk_missing: 409,
  chunk_conflict: 409,
  manifest_mismatch: 409,
  internal_error: 500
};

export function sendApiError(
  response: Response,
  code: ApiErrorCode,
  message: string
): void {
  const payload: ApiErrorEnvelope = {
    error: {
      code,
      message,
      requestId: response.locals.requestId as string
    }
  };
  response.status(STATUS_BY_CODE[code]).json(payload);
}

export interface OperationalErrorInput {
  boundary: string;
  code: string;
  durationMs: number;
  error?: unknown;
  method: string;
  requestId: string;
  status: number;
}

export interface OperationalErrorRecord {
  boundary: string;
  code: string;
  durationMs: number;
  method: string;
  requestId: string;
  status: number;
}

export function createOperationalErrorRecord(
  input: OperationalErrorInput
): OperationalErrorRecord {
  return {
    boundary: input.boundary,
    code: input.code,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    method: input.method,
    requestId: input.requestId,
    status: input.status
  };
}

export function logOperationalError(input: OperationalErrorInput): void {
  console.error("Fortnote operational error", createOperationalErrorRecord(input));
}
