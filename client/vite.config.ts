import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  server: { port: 3000, strictPort: true },
  build: { target: "es2023", sourcemap: true },
});
