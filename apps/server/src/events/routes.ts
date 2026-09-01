import { Router } from "express";
import { z } from "zod";
import { requireSessionAsync } from "../auth/session.js";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";

const listEventsQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(500).default(100)
});
const acknowledgeEventsBodySchema = z.object({
  cursor: z.number().int().nonnegative()
});

export function createEventsRouter(context: AppContext): Router {
  const router = Router();

  router.get("/", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = listEventsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid event query");
      return;
    }

    const events = await context.db.events.listVisible(
      session.userId,
      parsed.data.after,
      parsed.data.limit
    );
    response.json({ events });
  });

  router.get("/cursor", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    response.json({
      cursor: await context.db.events.acknowledgedCursor(session.userId)
    });
  });

  router.post("/ack", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = acknowledgeEventsBodySchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid acknowledgement payload");
      return;
    }

    await context.db.events.acknowledge(session.userId, parsed.data.cursor);
    await context.db.events.prune(parsed.data.cursor);
    response.status(204).send();
  });

  return router;
}
