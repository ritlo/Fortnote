export type OperationalLogLevel = "error" | "info" | "warn";
export type OperationalLogFields = Record<string, boolean | null | number | string>;

export interface OperationalLogRecord extends OperationalLogFields {
  event: string;
  level: OperationalLogLevel;
  timestamp: string;
}

export function createOperationalLogRecord(
  level: OperationalLogLevel,
  event: string,
  fields: OperationalLogFields = {},
  now = new Date()
): OperationalLogRecord {
  return {
    ...fields,
    event,
    level,
    timestamp: now.toISOString()
  };
}

export function logInfo(event: string, fields: OperationalLogFields = {}): void {
  console.log(JSON.stringify(createOperationalLogRecord("info", event, fields)));
}

export function logError(
  event: string,
  fields: OperationalLogFields,
  error: unknown
): void {
  console.error(
    JSON.stringify(
      createOperationalLogRecord("error", event, {
        ...fields,
        ...classifyError(error)
      })
    )
  );
}

function classifyError(error: unknown): OperationalLogFields {
  if (!(error instanceof Error)) {
    return { errorName: "UnknownError" };
  }
  const code =
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]{1,64}$/u.test(error.code)
      ? error.code
      : null;
  return {
    errorName: error.name,
    ...(code ? { errorCode: code } : {})
  };
}
