import type { NextFunction, Request, Response } from "express";
import { sendApiError } from "./errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function csrfGuard(allowedOrigin: string) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(request.method)) {
      next();
      return;
    }

    const origin = request.get("origin");
    const fetchSite = request.get("sec-fetch-site");

    if (origin !== allowedOrigin || fetchSite === "cross-site") {
      sendApiError(response, "csrf_failed", "CSRF validation failed");
      return;
    }

    next();
  };
}
