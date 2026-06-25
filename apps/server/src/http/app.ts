import express from "express";
import helmet from "helmet";
import type { AppDb } from "../db/client.js";
import type { ServerConfig } from "../config.js";
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

  return app;
}
