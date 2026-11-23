/**
 * Copies Material Symbols (Outlined, weight 400) into src/design-system/icons/:
 * `bun scripts/add-icon.ts send menu`. Browse names at https://fonts.google.com/icons.
 */
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const source = join(import.meta.dirname, "../node_modules/@material-symbols/svg-400/outlined");
const target = join(import.meta.dirname, "../src/design-system/icons");

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error("usage: bun scripts/add-icon.ts <name> [<name>...]");
  process.exit(1);
}
for (const name of names) {
  const file = `${name}.svg`;
  if (!existsSync(join(source, file))) {
    console.error(`unknown icon: ${name}`);
    process.exit(1);
  }
  copyFileSync(join(source, file), join(target, file));
  console.log(`added ${file}`);
}
