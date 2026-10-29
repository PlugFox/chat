/**
 * What a file is and whether the agents take it (docs/protocol.md, "Files";
 * D-101): the limits are the smallest of the OpenAI and Anthropic APIs.
 * Framework-free so it can be tested without a DOM.
 */

/** The largest file, and the most a message gives the model (OpenAI's 50 MB for PDFs). */
export const FILE_MAX = 50_000_000;
/** Files a message carries. */
export const FILES_PER_MESSAGE = 10;
/** The long edge of an image the model reads (Anthropic's limit past 20 images, under OpenAI's 2048). */
export const IMAGE_EDGE = 2000;
/** An image this large or larger offers to be compressed. */
export const COMPRESS_OVER = 2_000_000;
/** Pixels of an image the media worker decodes at most: 4 bytes each once decoded. */
export const PIXELS_MAX = 50_000_000;
/** The largest image copy the model reads (Anthropic's 10 MB in base64). */
export const MODEL_IMAGE_MAX = 7_000_000;
/** The longest text file, in bytes of UTF-8. */
export const TEXT_MAX = 200 * 1024;
/** Pages of a PDF at most (Anthropic below a 1M context). */
export const PDF_PAGES = 100;
/** The square preview of an image, in pixels. */
export const PREVIEW_EDGE = 256;

export type FileKind = "image" | "pdf" | "text";

const IMAGE_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
};

/** Text files the model reads as text, by extension, with the type they are sent as. */
const TEXT_TYPES: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  log: "text/plain",
  ini: "text/plain",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  ts: "text/javascript",
  tsx: "text/javascript",
  jsx: "text/javascript",
  py: "text/x-python",
  rs: "text/x-rust",
  go: "text/x-go",
  java: "text/x-java",
  kt: "text/x-kotlin",
  swift: "text/x-swift",
  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c++",
  cs: "text/x-csharp",
  rb: "text/x-ruby",
  php: "text/x-php",
  sh: "text/x-shellscript",
  sql: "application/sql",
  dart: "text/x-dart",
};

/** What the file chooser offers: every type a message takes. */
export const ACCEPT = [
  ...Object.keys(IMAGE_TYPES).map((ext) => `.${ext}`),
  ...Object.values(IMAGE_TYPES),
  ".pdf",
  "application/pdf",
  ...Object.keys(TEXT_TYPES).map((ext) => `.${ext}`),
].join(",");

export function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** The kind of a file and the type it is sent as, or `null` when no agent takes it. */
export function kindOf(name: string, type: string): { kind: FileKind; type: string } | null {
  const ext = extension(name);
  const image = IMAGE_TYPES[ext] ?? (Object.values(IMAGE_TYPES).includes(type) ? type : undefined);
  if (image) return { kind: "image", type: image };
  if (ext === "pdf" || type === "application/pdf") return { kind: "pdf", type: "application/pdf" };
  const text = TEXT_TYPES[ext];
  if (text) return { kind: "text", type: text };
  return null;
}

/** The icon of a file's type in the sprite (`FileIcon`): its extension, or a generic one. */
export function iconOf(name: string, type: string): string {
  const kind = kindOf(name, type);
  if (kind?.kind === "pdf") return "pdf";
  if (kind?.kind === "image") return "image";
  const ext = extension(name);
  if (["csv", "tsv"].includes(ext)) return "table";
  if (["json", "xml", "yaml", "yml", "toml"].includes(ext)) return "data";
  if (["md", "markdown", "txt", "log", "ini"].includes(ext)) return "text";
  if (kind?.kind === "text") return "code";
  return "file";
}

/** A GIF's first frame, which a decoder may draw larger than the logical screen. */
function gifFrame(bytes: Uint8Array, view: DataView): { w: number; h: number } | null {
  const flags = bytes[10] ?? 0;
  let i = 13 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0);
  while (i < bytes.length) {
    const block = bytes[i];
    if (block === 0x2c && i + 9 <= bytes.length)
      return { w: view.getUint16(i + 5, true), h: view.getUint16(i + 7, true) };
    if (block !== 0x21) return null;
    // An extension: its label, then sub-blocks until an empty one.
    i += 2;
    while (i < bytes.length && (bytes[i] ?? 0) > 0) i += (bytes[i] ?? 0) + 1;
    i += 1;
  }
  return null;
}

/**
 * Pixels of an image from its header, before anything decodes it: the
 * largest size the file declares anywhere a decoder may use it. `null` when
 * the header does not tell. Takes the whole file: a JPEG may put its frame
 * after long metadata.
 */
export function imageSize(bytes: Uint8Array): { w: number; h: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = (i: number) => bytes[i] ?? 0;
  // PNG: IHDR is the first chunk.
  if (bytes.length >= 24 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return { w: view.getUint32(16), h: view.getUint32(20) };
  }
  // GIF: the logical screen.
  if (bytes.length >= 10 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) {
    const screen = { w: view.getUint16(6, true), h: view.getUint16(8, true) };
    const frame = gifFrame(bytes, view);
    return frame ? { w: Math.max(screen.w, frame.w), h: Math.max(screen.h, frame.h) } : screen;
  }
  // WebP: VP8, VP8L or VP8X.
  if (bytes.length >= 30 && at(0) === 0x52 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) {
    const chunk = String.fromCharCode(at(12), at(13), at(14), at(15));
    if (chunk === "VP8 ") return { w: view.getUint16(26, true) & 0x3fff, h: view.getUint16(28, true) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = view.getUint32(21, true);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") {
      const w = 1 + (at(24) | (at(25) << 8) | (at(26) << 16));
      const h = 1 + (at(27) | (at(28) << 8) | (at(29) << 16));
      return { w, h };
    }
    return null;
  }
  // JPEG: the first start-of-frame marker.
  if (at(0) === 0xff && at(1) === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (at(i) !== 0xff) return null;
      const marker = at(i + 1);
      const length = view.getUint16(i + 2);
      const frame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (frame) return { w: view.getUint16(i + 7), h: view.getUint16(i + 5) };
      i += 2 + length;
    }
    return null;
  }
  // HEIC and HEIF: `ispe` properties hold the sizes of the image and its
  // tiles and thumbnails; the largest is what decodes.
  let largest: { w: number; h: number } | null = null;
  for (let i = 4; i + 16 <= Math.min(bytes.length, 1 << 20); i += 1) {
    if (at(i) === 0x69 && at(i + 1) === 0x73 && at(i + 2) === 0x70 && at(i + 3) === 0x65) {
      const size = { w: view.getUint32(i + 8), h: view.getUint32(i + 12) };
      if (!largest || size.w * size.h > largest.w * largest.h) largest = size;
    }
  }
  return largest;
}

/**
 * Pages of a PDF as far as its uncompressed objects tell: page objects
 * kept in compressed object streams are not counted, so this is a floor.
 */
export function pdfPages(bytes: Uint8Array): number {
  const text = new TextDecoder("latin1").decode(bytes);
  return text.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
}

/** Whether the bytes are UTF-8 text. */
export function isText(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
