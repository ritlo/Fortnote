import type { NextFunction, Request, Response } from "express";
import { sendApiError } from "./errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function csrfGuard(allowedOrigin: string) {
  const allowedOrigins = allowedOriginAliases(allowedOrigin);

  return (request: Request, response: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(request.method)) {
      next();
      return;
    }

    const origin = request.get("origin");
    const fetchSite = request.get("sec-fetch-site");

    if (!origin || !allowedOrigins.has(origin) || fetchSite === "cross-site") {
      sendApiError(response, "csrf_failed", "CSRF validation failed");
      return;
    }

    next();
  };
}

export function allowedOriginAliases(origin: string): Set<string> {
  const origins = new Set([origin]);
  try {
    const url = new URL(origin);
    if (url.hostname === "localhost") {
      url.hostname = "127.0.0.1";
      origins.add(url.toString().replace(/\/$/, ""));
    } else if (url.hostname === "127.0.0.1") {
      url.hostname = "localhost";
      origins.add(url.toString().replace(/\/$/, ""));
    }
  } catch {
    return origins;
  }

  return origins;
}
