import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";
import { cryptoWasm } from "./src/crypto/vite-plugin";
import { designTokens } from "./src/design-system/vite-plugin";

/**
 * The Content Security Policy of built pages (docs/threat-model.md): scripts
 * from our origin only, WASM allowed, no inline scripts or styles, no
 * third-party anything. Dev mode needs inline styles for HMR, so the policy
 * is added to builds only; the reverse proxy sends the same one as a header.
 */
export const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

function csp(): Plugin {
  return {
    name: "content-security-policy",
    apply: "build",
    transformIndexHtml: () => [
      {
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: contentSecurityPolicy },
        injectTo: "head-prepend",
      },
    ],
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [designTokens(), cryptoWasm(), solid(), csp()],
  worker: { format: "es" },
  define: {
    // The UI kit is left out of production builds (docs/design-system.md).
    "import.meta.env.VITE_UI_KIT": JSON.stringify(String(mode !== "production")),
  },
  css: { modules: { localsConvention: "dashes" } },
  server: {
    port: 3000,
    strictPort: true,
    // Same origin in development as behind the reverse proxy in production.
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8080", ws: true },
      "/health": "http://127.0.0.1:8080",
      "/ready": "http://127.0.0.1:8080",
    },
  },
  preview: { port: 4173, strictPort: true },
  build: { target: "es2023", sourcemap: true, assetsInlineLimit: 0 },
}));
