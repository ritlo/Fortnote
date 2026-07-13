import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import type { AppDb } from "../db/client.js";
import type { ServerConfig } from "../config.js";
import type { RealtimePublisher } from "../realtime/types.js";
import { createAttachmentsRouter } from "../attachments/routes.js";
import { createAuthRouter } from "../auth/routes.js";
import { createEventsRouter } from "../events/routes.js";
import { createFoldersRouter } from "../folders/routes.js";
import { createKeyMaterialRouter } from "../keyMaterial/routes.js";
import { createNotesRouter } from "../notes/routes.js";
import { createSharingKeysRouter } from "../sharingKeys/routes.js";
import { csrfGuard } from "./csrf.js";

const JSON_BODY_LIMIT_BYTES = 1024 * 1024;

export interface AppContext {
  config: ServerConfig;
  db: AppDb;
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
  app.use(express.json({ limit: JSON_BODY_LIMIT_BYTES }));
  app.use(csrfGuard(context.config.allowedOrigin));

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.use("/api/auth", createAuthRouter(context));
  app.use("/api", createAttachmentsRouter(context));
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
      response.status(413).json({ code: "payload_too_large", message: "Payload too large" });
      return;
    }
    console.error(error);
    response.status(500).json({ code: "internal_error", message: "Internal server error" });
  };
  app.use(handleError);

  return app;
}

function isPayloadTooLargeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "entity.too.large"
  );
}
