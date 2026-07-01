import express from "express";
import helmet from "helmet";
import { LIMITS } from "@fortnote/shared";
import type { AppDb } from "../db/client.js";
import type { ServerConfig } from "../config.js";
import { createAttachmentsRouter } from "../attachments/routes.js";
import { createAuthRouter } from "../auth/routes.js";
import { createFoldersRouter } from "../folders/routes.js";
import { createKeyMaterialRouter } from "../keyMaterial/routes.js";
import { createNotesRouter } from "../notes/routes.js";
import { createSharingKeysRouter } from "../sharingKeys/routes.js";
import { csrfGuard } from "./csrf.js";

export interface AppContext {
  config: ServerConfig;
  db: AppDb;
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
  app.use(express.json({ limit: jsonBodyLimitBytes() }));
  app.use(csrfGuard(context.config.allowedOrigin));

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.use("/api/auth", createAuthRouter(context));
  app.use("/api", createAttachmentsRouter(context));
  app.use("/api/folders", createFoldersRouter(context));
  app.use("/api/key-material", createKeyMaterialRouter(context));
  app.use("/api/notes", createNotesRouter(context));
  app.use("/api/sharing-keys", createSharingKeysRouter(context));

  return app;
}

function jsonBodyLimitBytes(): number {
  return Math.ceil(LIMITS.maxAttachmentBytes * 1.4) + 1024 * 1024;
}
