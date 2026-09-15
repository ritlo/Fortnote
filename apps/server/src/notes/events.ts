import type { Request } from "express";
import { z } from "zod";

const clientInstanceIdSchema = z.uuid();

export function requestClientInstanceId(request: Request): string | undefined {
  const parsed = clientInstanceIdSchema.safeParse(request.get("x-fortnote-client-id"));
  return parsed.success ? parsed.data : undefined;
}

export function serializedEventMetadata(
  payloadMetadata: Record<string, unknown> | undefined,
  clientInstanceId: string | undefined
): string | null {
  const metadata = {
    ...payloadMetadata,
    ...(clientInstanceId ? { clientInstanceId } : {})
  };
  return Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null;
}
