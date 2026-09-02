import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import type { ApplicationDatabase } from "../db/types.js";
import type { ServerConfig } from "../config.js";
import type { RealtimePublisher } from "../realtime/types.js";
import { createAttachmentsRouter } from "../attachments/routes.js";
import { createContentRouter } from "../content/routes.js";
import { createAuthRouter } from "../auth/routes.js";
import { createEventsRouter } from "../events/routes.js";
import { createFoldersRouter } from "../folders/routes.js";
import { createKeyMaterialRouter } from "../keyMaterial/routes.js";
import { createNotesRouter } from "../notes/routes.js";
import { createSharingKeysRouter } from "../sharingKeys/routes.js";
import { csrfGuard } from "./csrf.js";
import { logOperationalError, sendApiError } from "./errors.js";

export interface AppContext {
  config: ServerConfig;
  db: ApplicationDatabase;
  realtime?: RealtimePublisher;
}

export function createApp(context: AppContext) {
  const app = express();

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          imgSrc: ["'self'", "data:"],
          mediaSrc: ["'self'"],
          objectSrc: ["'none'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          upgradeInsecureRequests: []
        }
      }
    })
  );
  app.use("/api", (request, response, next) => {
    const suppliedRequestId = request.get("x-request-id");
    const requestId = isUuid(suppliedRequestId) ? suppliedRequestId : crypto.randomUUID();
    response.locals.requestId = requestId;
    response.locals.requestStartedAt = performance.now();
    response.set("Cache-Control", "no-store");
    response.set("X-Request-Id", requestId);
    next();
  });
  app.use(express.json({ limit: context.config.jsonControlMaxBytes }));
  app.use(csrfGuard(context.config.allowedOrigin));

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.use("/api/auth", createAuthRouter(context));
  app.use("/api", createAttachmentsRouter(context));
  app.use("/api", createContentRouter(context));
  app.use("/api/events", createEventsRouter(context));
  app.use("/api/folders", createFoldersRouter(context));
  app.use("/api/key-material", createKeyMaterialRouter(context));
  app.use("/api/notes", createNotesRouter(context));
  app.use("/api/sharing-keys", createSharingKeysRouter(context));

  const handleError: ErrorRequestHandler = (error, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    if (isPayloadTooLargeError(error)) {
      sendApiError(response, "payload_too_large", "Payload too large");
      return;
    }
    logOperationalError({
      boundary: "http",
      code: "internal_error",
      durationMs: performance.now() - Number(response.locals.requestStartedAt ?? performance.now()),
      error,
      method: _request.method,
      requestId: response.locals.requestId as string,
      status: 500
    });
    sendApiError(response, "internal_error", "Internal server error");
  };
  app.use(handleError);

  return app;
}

function isUuid(value: string | undefined): value is string {
  return Boolean(
    value &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        value
      )
  );
}

function isPayloadTooLargeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "entity.too.large"
  );
}
