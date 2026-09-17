/**
 * Returns the constraint a PostgreSQL unique violation (SQLSTATE 23505) hit, or
 * null for any other error. Drizzle wraps driver errors, so causes are followed.
 */
export function uniqueViolationConstraint(error: unknown): string | null {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 5 && typeof current === "object" && current !== null;
    depth += 1
  ) {
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (candidate.code === "23505") {
      return typeof candidate.constraint === "string" ? candidate.constraint : "";
    }
    current = candidate.cause;
  }
  return null;
}
