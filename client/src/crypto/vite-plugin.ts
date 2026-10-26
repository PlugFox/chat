import type { Plugin } from "vite";
import { buildWasm } from "../../scripts/build-wasm";

/** Builds the WASM modules before dev start and production builds (once per process). */
export function cryptoWasm(): Plugin {
  let built = false;
  return {
    name: "crypto-wasm",
    buildStart() {
      if (built || process.env["CHAT_SKIP_WASM"] === "1") return;
      buildWasm();
      built = true;
    },
  };
}
