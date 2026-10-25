import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default defineConfig((env) =>
  mergeConfig(
    viteConfig(env),
    defineConfig({
      test: {
        // Unit tests do not load the worker; the e2e suite does.
        env: { CHAT_SKIP_WASM: "1" },
        environment: "jsdom",
        include: ["src/**/*.test.{ts,tsx}", "tests/unit/**/*.test.ts"],
        coverage: { provider: "v8", include: ["src/**/*.{ts,tsx}"], exclude: ["src/**/*.test.{ts,tsx}"] },
      },
      resolve: { conditions: ["development", "browser"] },
    }),
  ),
);
