/**
 * Frames on the WebSocket: `[type, id, payload]` in MessagePack, with the
 * encoding rules both sides follow (docs/protocol.md, "Encoding rules").
 * `crates/protocol/fixtures` holds frames encoded by each side, decoded by
 * the other in tests.
 */
import { Decoder, Encoder } from "@msgpack/msgpack";

export type Frame = [type: string, id: number, payload: unknown];

/** An absent optional field is omitted, never sent as nil: Rust rejects nil for a required field. */
const encoder = new Encoder({ ignoreUndefined: true });
const decoder = new Decoder();

export function encodeFrame(type: string, id: number, payload: unknown): Uint8Array<ArrayBuffer> {
  return encoder.encode([type, id, payload]);
}

/** The frame, or null when the bytes are not a well-formed envelope. */
export function decodeFrame(data: ArrayBuffer | Uint8Array): Frame | null {
  let value: unknown;
  try {
    value = decoder.decode(data);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [type, id, payload] = value as unknown[];
  if (typeof type !== "string" || typeof id !== "number" || !Number.isInteger(id) || id < 0) return null;
  return [type, id, payload];
}
