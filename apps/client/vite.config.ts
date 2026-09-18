import { defineConfig } from "vite";
// The subpath keeps this config from loading the crypto modules.
import { contentSecurityPolicyHeader } from "@fortnote/shared/content-security-policy";

const apiPort = Number(process.env.API_PORT ?? 3001);
const securityHeaders = { "Content-Security-Policy": contentSecurityPolicyHeader() };

export default defineConfig({
  server: {
    host: true,
    port: Number(process.env.CLIENT_PORT ?? 5173),
    headers: securityHeaders,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${String(apiPort)}`,
        changeOrigin: true,
        ws: true
      }
    }
  },
  preview: {
    headers: securityHeaders
  }
});
