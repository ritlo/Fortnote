/**
 * The web client's Content-Security-Policy. The API server sends it in production,
 * and the Vite dev and preview servers send the same policy, so browser tests run
 * under the directives users get.
 */
export const CONTENT_SECURITY_POLICY_DIRECTIVES = {
  "default-src": ["'self'"],
  "base-uri": ["'self'"],
  "connect-src": ["'self'"],
  "font-src": ["'self'"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'none'"],
  // Decrypted attachments are displayed from blob: URLs.
  "img-src": ["'self'", "data:", "blob:"],
  "media-src": ["'self'", "blob:"],
  "object-src": ["'none'"],
  // libsodium runs as WebAssembly. Inline scripts stay blocked.
  "script-src": ["'self'", "'wasm-unsafe-eval'"],
  // BlockNote and Mantine set inline style attributes, which nonces cannot cover.
  "style-src": ["'self'", "'unsafe-inline'"]
} as const satisfies Record<string, readonly string[]>;

export function contentSecurityPolicyHeader(): string {
  return Object.entries(CONTENT_SECURITY_POLICY_DIRECTIVES)
    .map(([directive, sources]) => `${directive} ${sources.join(" ")}`)
    .join("; ");
}
