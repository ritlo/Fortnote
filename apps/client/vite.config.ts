import { defineConfig } from "vite";

const apiPort = Number(process.env.API_PORT ?? 3001);

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws:",
  "img-src 'self' data: blob:",
  "media-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

export default defineConfig({
  server: {
    host: true,
    port: Number(process.env.CLIENT_PORT ?? 5173),
    headers: {
      "Content-Security-Policy": contentSecurityPolicy
    },
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${String(apiPort)}`,
        changeOrigin: true,
        ws: true
      }
    }
  }
});
