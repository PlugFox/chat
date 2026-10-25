/** UUIDs as the 16 bytes chat-crypto takes, and back. */

export function uuidBytes(uuid: string): Uint8Array<ArrayBuffer> {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error("not a UUID");
  return new Uint8Array(hex.match(/../g)?.map((b) => Number.parseInt(b, 16)) ?? []);
}

export function bytesUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
