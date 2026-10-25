import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      include: ["src/**/*.test.{ts,tsx}"],
      coverage: { provider: "v8", include: ["src/**/*.{ts,tsx}"], exclude: ["src/**/*.test.{ts,tsx}"] },
    },
    resolve: { conditions: ["development", "browser"] },
  }),
);
