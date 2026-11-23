// @vitest-environment node
/**
 * Cross-implementation fixtures (docs/protocol.md, "Encoding rules"): frames
 * Rust encoded decode here to the expected values, and frames encoded here go
 * to `crates/protocol/fixtures/ts.json` for the Rust side to decode. The
 * samples mirror `crates/protocol/src/fixtures.rs`. `CHAT_PROTOCOL_REGEN=1`
 * rewrites `ts.json`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, type Frame } from "../../src/transport/codec";

const dir = new URL("../../../crates/protocol/fixtures/", import.meta.url);
const session = "01920000-0000-7000-8000-000000000001";

const samples: Record<string, Frame> = {
  auth: ["auth", 1, { v: 1, access_token: "t" }],
  "auth.resume": ["auth", 2, { v: 1, access_token: "t", resume: { agent_session_id: session } }],
  "auth.ok": ["ok", 3, { session_id: session, heartbeat_ms: 20_000, server_time: 1_793_000_000_000, files: true }],
  error: ["error", 4, { code: "rate_limited", message: "slow down", retry: true }],
  "keys.setup": [
    "keys.setup",
    5,
    {
      commitment: new Uint8Array(32).fill(1),
      writer_public_key: new Uint8Array(32).fill(2),
      wraps: [new Uint8Array(66).fill(3)],
      scopes: [
        {
          scope_id: session,
          kind: "profile:basics",
          public_key: new Uint8Array(32).fill(4),
          wrapped_private_key: new Uint8Array(73).fill(5),
        },
      ],
    },
  ],
  sample: [
    "sample",
    0,
    {
      data: new Uint8Array([0, 1, 255]),
      empty: new Uint8Array([]),
      list: [new Uint8Array([7]), new Uint8Array(300).fill(8)],
      // Omitted on the wire, as Rust expects (`ignoreUndefined`).
      absent: undefined,
      negative: -5,
      large: 2 ** 53 - 1,
      text: "привет 🙂",
    },
  ],
};

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s: string): Uint8Array => new Uint8Array(s.match(/../g)?.map((b) => Number.parseInt(b, 16)) ?? []);
const read = (file: string): Record<string, string> =>
  JSON.parse(readFileSync(new URL(file, dir), "utf8")) as Record<string, string>;

/** The sample as decoding gives it back: no `undefined` fields. */
function decoded(frame: Frame): Frame {
  const [type, id, payload] = frame;
  const entries = Object.entries(payload as Record<string, unknown>).filter(([, v]) => v !== undefined);
  return [type, id, Object.fromEntries(entries)];
}

describe("MessagePack frames", () => {
  it("decodes what Rust encoded to the same values", () => {
    const rust = read("rust.json");
    expect(Object.keys(rust).sort()).toEqual(Object.keys(samples).sort());
    for (const [name, frame] of Object.entries(samples)) {
      expect(decodeFrame(unhex(rust[name] ?? "")), name).toEqual(decoded(frame));
    }
  });

  it("writes the frames Rust decodes", () => {
    const encoded = Object.fromEntries(
      Object.entries(samples)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, [type, id, payload]]) => [name, hex(encodeFrame(type, id, payload))]),
    );
    const json = `${JSON.stringify(encoded, null, 2)}\n`;
    if (process.env["CHAT_PROTOCOL_REGEN"]) writeFileSync(new URL("ts.json", dir), json);
    else expect(readFileSync(new URL("ts.json", dir), "utf8"), "run with CHAT_PROTOCOL_REGEN=1").toBe(json);
  });

  it("omits undefined fields instead of sending nil", () => {
    const [, , payload] = decodeFrame(encodeFrame("x", 1, { a: undefined, b: 1 })) ?? [];
    expect(payload).toStrictEqual({ b: 1 });
  });

  it("refuses what is not an envelope", () => {
    expect(decodeFrame(new Uint8Array([0xc1]))).toBeNull();
    expect(decodeFrame(encodeFrame("x", 1.5, {}))).toBeNull();
    expect(decodeFrame(new Uint8Array([0x92, 0xa1, 0x78, 0x01]))).toBeNull();
  });
});
