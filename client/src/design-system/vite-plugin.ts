import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { loadTokens, renderCss } from "./tokens";

const root = fileURLToPath(new URL(".", import.meta.url));
const tokensDir = join(root, "tokens");
export const tokensCssPath = join(root, "generated", "tokens.css");

function generate(): void {
  mkdirSync(join(root, "generated"), { recursive: true });
  writeFileSync(tokensCssPath, renderCss(loadTokens(tokensDir)));
}

/**
 * Generates `generated/tokens.css` from `tokens/` before every dev start and
 * build, and again when a token file changes in dev.
 */
export function designTokens(): Plugin {
  return {
    name: "design-tokens",
    buildStart() {
      generate();
      this.addWatchFile(tokensDir);
    },
    configureServer(server) {
      server.watcher.add(tokensDir);
      server.watcher.on("change", (file) => {
        if (file.startsWith(tokensDir) && file.endsWith(".json")) generate();
      });
    },
  };
}
