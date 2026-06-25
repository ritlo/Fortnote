import express from "express";
import helmet from "helmet";
import type { AppDb } from "../db/client.js";
import type { ServerConfig } from "../config.js";
import { createAuthRouter } from "../auth/routes.js";
import { createFoldersRouter } from "../folders/routes.js";
import { createKeyMaterialRouter } from "../keyMaterial/routes.js";
import { createNotesRouter } from "../notes/routes.js";
import { csrfGuard } from "./csrf.js";

export interface AppContext {
  config: ServerConfig;
  db: AppDb;
}

export function createApp(context: AppContext) {
  const app = express();

  app.use(helmet());
  app.use(express.json({ limit: "1mb" }));
  app.use(csrfGuard(context.config.allowedOrigin));

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.use("/api/auth", createAuthRouter(context));
  app.use("/api/folders", createFoldersRouter(context));
  app.use("/api/key-material", createKeyMaterialRouter(context));
  app.use("/api/notes", createNotesRouter(context));

  return app;
}
