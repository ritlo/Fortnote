import { Router } from "express";
import { z } from "zod";
import { requireSession } from "../auth/session.js";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";
import { listVisibleEvents } from "./replay.js";

const listEventsQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(500).default(100)
});

export function createEventsRouter(context: AppContext): Router {
  const router = Router();

  router.get("/", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = listEventsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid event query");
      return;
    }

    response.json({
      events: listVisibleEvents(context, session.userId, parsed.data.after, parsed.data.limit)
    });
  });

  return router;
}
