/**
 * Builds crates/crypto-wasm and writes the wasm-bindgen output to
 * src/crypto/wasm/ (gitignored). Needs cargo with the wasm32 target and the
 * wasm-bindgen CLI of the version in Cargo.lock (both from mise / rustup).
 * Run by the Vite plugin on dev start and build, or `bun run wasm`.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");
const out = join(import.meta.dirname, "../src/crypto/wasm");

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status ?? r.signal})`);
}

export function buildWasm(): void {
  run("cargo", [
    "build",
    "--locked",
    "-p",
    "chat-crypto-wasm",
    "--target",
    "wasm32-unknown-unknown",
    "--profile",
    "wasm",
  ]);
  run("wasm-bindgen", [
    "--target",
    "web",
    "--out-dir",
    out,
    "--out-name",
    "chat_crypto",
    join(root, "target/wasm32-unknown-unknown/wasm/chat_crypto_wasm.wasm"),
  ]);
}

if (import.meta.main) buildWasm();
