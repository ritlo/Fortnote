import { defineConfig } from "vite";

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws://localhost:5173 ws://127.0.0.1:5173",
  "img-src 'self' data: blob:",
  "media-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

export default defineConfig({
  server: {
    headers: {
      "Content-Security-Policy": contentSecurityPolicy
    },
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true
      }
    }
  }
});
