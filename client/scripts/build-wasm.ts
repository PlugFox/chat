/**
 * Builds the client's WASM modules and writes the wasm-bindgen output,
 * gitignored: crates/crypto-wasm to src/crypto/wasm/ (the crypto worker),
 * crates/document-wasm to src/document/wasm/ (the reply preview, D-094).
 * Needs cargo with the wasm32 target and the wasm-bindgen CLI of the version
 * in Cargo.lock (both from mise / rustup). Run by the Vite plugin on dev
 * start and build, or `bun run wasm`.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");
const modules = [
  { crate: "chat-crypto-wasm", name: "chat_crypto", out: "../src/crypto/wasm" },
  { crate: "chat-document-wasm", name: "chat_document", out: "../src/document/wasm" },
];

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status ?? r.signal})`);
}

export function buildWasm(): void {
  run("cargo", [
    "build",
    "--locked",
    ...modules.flatMap((m) => ["-p", m.crate]),
    "--target",
    "wasm32-unknown-unknown",
    "--profile",
    "wasm",
  ]);
  for (const m of modules) {
    run("wasm-bindgen", [
      "--target",
      "web",
      "--out-dir",
      join(import.meta.dirname, m.out),
      "--out-name",
      m.name,
      join(root, `target/wasm32-unknown-unknown/wasm/${m.crate.replaceAll("-", "_")}.wasm`),
    ]);
  }
}

if (import.meta.main) buildWasm();
