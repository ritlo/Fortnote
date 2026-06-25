import type { Response } from "express";

type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "payload_too_large"
  | "quota_exceeded"
  | "csrf_failed";

interface ApiError {
  code: ApiErrorCode;
  message: string;
}

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  quota_exceeded: 413,
  csrf_failed: 403
};

export function sendApiError(
  response: Response,
  code: ApiErrorCode,
  message: string
): void {
  const payload: ApiError = { code, message };
  response.status(STATUS_BY_CODE[code]).json(payload);
}
