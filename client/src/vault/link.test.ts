import { describe, expect, it } from "vitest";
import { type LinkCode, linkUrl, parseLink } from "./link";

const code: LinkCode = {
  sid: "0190d2c4-8b7e-7000-8000-00000000000a",
  publicKey: new Uint8Array(32).fill(0xfb),
  secret: Uint8Array.from({ length: 32 }, (_, i) => i),
};

describe("link codes", () => {
  it("round-trip through the URL fragment", () => {
    const url = new URL(linkUrl("https://chat.example", code));
    expect(url.pathname).toBe("/link");
    expect(url.search).toBe("");
    expect(url.hash).toMatch(/^#1\.[\w-]{22}\.[\w-]{43}\.[\w-]{43}$/);
    expect(parseLink(url.hash.slice(1))).toEqual(code);
  });

  it("refuse other versions, lengths and characters", () => {
    const fragment = new URL(linkUrl("https://chat.example", code)).hash.slice(1);
    const [, sid, pk, k] = fragment.split(".");
    for (const bad of [
      `2.${sid}.${pk}.${k}`,
      `1.${sid}.${pk}`,
      `1.${sid}.${pk}.${k}.x`,
      `1.${sid}.${pk?.slice(1)}.${k}`,
      `1.${sid}.${pk}.${k?.replace(/.$/, "+")}`,
      "",
    ]) {
      expect(parseLink(bad)).toBeNull();
    }
  });
});
