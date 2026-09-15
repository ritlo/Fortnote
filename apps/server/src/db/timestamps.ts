const TIMESTAMP_KEYS = ["createdAt", "updatedAt", "deletedAt", "expiresAt"] as const;

// PostgreSQL text timestamps carry an offset, sometimes just +HH; naive values are UTC.
export function canonicalTimestamp(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const timestamp = value.replace(" ", "T");
  const zoned = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(timestamp)
    ? timestamp.replace(/([+-]\d{2})$/, "$1:00")
    : `${timestamp}Z`;
  return new Date(zoned).toISOString();
}

export function withCanonicalTimestamps<T extends object>(row: T): T {
  const result = { ...row } as Record<string, unknown>;
  for (const key of TIMESTAMP_KEYS) {
    const value = result[key];
    if (typeof value === "string" || value instanceof Date) {
      result[key] = canonicalTimestamp(value);
    }
  }
  return result as T;
}
