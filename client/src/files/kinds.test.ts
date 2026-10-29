import { describe, expect, it } from "vitest";
import { iconOf, imageSize, isText, kindOf, pdfPages } from "./kinds";

function bytes(...parts: (number[] | string)[]): Uint8Array {
  const out: number[] = [];
  for (const part of parts) out.push(...(typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : part));
  return new Uint8Array(out);
}

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >> 8) & 255];

describe("file kinds", () => {
  it("takes the types every agent reads, by extension first", () => {
    expect(kindOf("IMG_1.HEIC", "")).toEqual({ kind: "image", type: "image/heic" });
    expect(kindOf("scan", "image/png")).toEqual({ kind: "image", type: "image/png" });
    expect(kindOf("bill.pdf", "application/octet-stream")).toEqual({ kind: "pdf", type: "application/pdf" });
    expect(kindOf("notes.md", "")).toEqual({ kind: "text", type: "text/markdown" });
    expect(kindOf("main.rs", "")).toEqual({ kind: "text", type: "text/x-rust" });
    expect(kindOf("movie.mp4", "video/mp4")).toBeNull();
    expect(kindOf("archive.zip", "")).toBeNull();
    expect([
      iconOf("a.pdf", ""),
      iconOf("a.csv", ""),
      iconOf("a.json", ""),
      iconOf("a.py", ""),
      iconOf("a.txt", ""),
    ]).toEqual(["pdf", "table", "data", "code", "text"]);
  });

  it("reads an image's size from its header", () => {
    expect(imageSize(bytes([0x89], "PNG\r\n\x1a\n", u32(13), "IHDR", u32(4000), u32(3000)))).toEqual({
      w: 4000,
      h: 3000,
    });
    expect(imageSize(bytes("GIF89a", le16(320), le16(200)))).toEqual({ w: 320, h: 200 });
    const app0 = [0xff, 0xe0, ...u16(16), ...new Array(14).fill(0)];
    const sof = [0xff, 0xc0, ...u16(17), 8, ...u16(1500), ...u16(2000), 3];
    expect(imageSize(bytes([0xff, 0xd8], app0, sof, new Array(10).fill(0)))).toEqual({ w: 2000, h: 1500 });
    const vp8x = bytes(
      "RIFF",
      [0, 0, 0, 0],
      "WEBPVP8X",
      [10, 0, 0, 0],
      [0, 0, 0, 0],
      [0xff, 0x0f, 0x00],
      [0x7f, 0x07, 0x00],
    );
    expect(imageSize(vp8x)).toEqual({ w: 4096, h: 1920 });
    expect(imageSize(bytes("hello world, not an image at all"))).toBeNull();
    // A frame after 65 KB of metadata is still found.
    const comment = [0xff, 0xfe, ...u16(65_000), ...new Array(64_998).fill(0)];
    expect(imageSize(bytes([0xff, 0xd8], comment, sof, new Array(10).fill(0)))).toEqual({ w: 2000, h: 1500 });
    // A GIF whose first frame is larger than its logical screen.
    const frame = [0x2c, ...le16(0), ...le16(0), ...le16(30_000), ...le16(30_000), 0];
    expect(imageSize(bytes("GIF89a", le16(1), le16(1), [0, 0, 0], [0x21, 0xf9, 4, 0, 0, 0, 0, 0], frame))).toEqual({
      w: 30_000,
      h: 30_000,
    });
    // HEIC: the largest `ispe`, not a thumbnail's before it.
    const ispe = (w: number, h: number) => [
      ...u32(20),
      ..."ispe".split("").map((c) => c.charCodeAt(0)),
      0,
      0,
      0,
      0,
      ...u32(w),
      ...u32(h),
    ];
    expect(
      imageSize(bytes([0, 0, 0, 24], "ftypheic", new Array(12).fill(0), ispe(320, 240), ispe(8000, 8000))),
    ).toEqual({
      w: 8000,
      h: 8000,
    });
  });

  it("counts a PDF's pages and checks text", () => {
    const pdf = new TextEncoder().encode("%PDF-1.7 /Type /Pages /Count 2 /Type /Page /Type/Page /Type /PageLabel");
    expect(pdfPages(pdf)).toBe(2);
    expect(isText(new TextEncoder().encode("привет"))).toBe(true);
    expect(isText(new Uint8Array([0xc3, 0x28]))).toBe(false);
  });
});
