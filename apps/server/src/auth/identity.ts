const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,62}[a-z0-9])$/u;

export function canonicalizeHandle(value: string): string | null {
  const canonical = value.trim().toLowerCase();
  return HANDLE_PATTERN.test(canonical) ? canonical : null;
}

export function accountDisplayName(value: string): string {
  return value.trim();
}
