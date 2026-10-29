/**
 * The media worker (D-101): decodes an image the user picked and writes
 * what a message keeps of it, away from the crypto worker, so an untrusted
 * decoder never runs in the memory that holds the keys. The main thread
 * gives it one image at a time (`MediaClient`).
 */
import { rgbaToThumbHash } from "thumbhash";
import { IMAGE_EDGE, MODEL_IMAGE_MAX, PIXELS_MAX, PREVIEW_EDGE } from "./kinds";

export interface MediaRequest {
  id: number;
  image: Blob;
  /** The picked file's type: a PNG stays a PNG when it can. */
  type: string;
}

export interface Prepared {
  /** The copy the model reads and the chat shows: no metadata, at most `IMAGE_EDGE` on the long edge. */
  copy: Uint8Array;
  copyType: "image/jpeg" | "image/png";
  w: number;
  h: number;
  /** The image's own pixels, before the copy shrank it. */
  sourceW: number;
  sourceH: number;
  preview: Uint8Array;
  hash: Uint8Array;
}

export type MediaResponse = { id: number; ok: true; value: Prepared } | { id: number; ok: false; error: string };

const HASH_EDGE = 100;
const PREVIEW_MAX = 48 * 1024;
const QUALITIES = [0.85, 0.7, 0.5];

async function bytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function canvas(w: number, h: number): OffscreenCanvasRenderingContext2D {
  const context = new OffscreenCanvas(w, h).getContext("2d");
  if (!context) throw new Error("no 2d context");
  return context;
}

/** A JPEG has no alpha: what was transparent becomes white. */
function opaque(context: OffscreenCanvasRenderingContext2D): void {
  context.fillStyle = "#fff";
  context.fillRect(0, 0, context.canvas.width, context.canvas.height);
}

async function jpeg(context: OffscreenCanvasRenderingContext2D, quality: number): Promise<Uint8Array> {
  return bytes(await context.canvas.convertToBlob({ type: "image/jpeg", quality }));
}

async function prepare(image: Blob, type: string): Promise<Prepared> {
  // Applies the EXIF orientation; the pixels carry no metadata on.
  const bitmap = await createImageBitmap(image);
  try {
    const { width: sourceW, height: sourceH } = bitmap;
    if (sourceW * sourceH > PIXELS_MAX) throw new Error("too many pixels");
    const scale = Math.min(1, IMAGE_EDGE / Math.max(sourceW, sourceH));
    const w = Math.max(1, Math.round(sourceW * scale));
    const h = Math.max(1, Math.round(sourceH * scale));

    let copy: Uint8Array | null = null;
    let copyType: Prepared["copyType"] = "image/jpeg";
    if (type === "image/png" || type === "image/gif") {
      const png = canvas(w, h);
      png.drawImage(bitmap, 0, 0, w, h);
      const written = await bytes(await png.canvas.convertToBlob({ type: "image/png" }));
      if (written.length <= MODEL_IMAGE_MAX) {
        copy = written;
        copyType = "image/png";
      }
    }
    if (!copy) {
      const photo = canvas(w, h);
      opaque(photo);
      photo.drawImage(bitmap, 0, 0, w, h);
      for (const quality of QUALITIES) {
        copy = await jpeg(photo, quality);
        if (copy.length <= MODEL_IMAGE_MAX) break;
      }
    }
    if (!copy || copy.length > MODEL_IMAGE_MAX) throw new Error("copy too large");

    // The preview: a square cut from the middle.
    const side = Math.min(sourceW, sourceH);
    const square = canvas(PREVIEW_EDGE, PREVIEW_EDGE);
    opaque(square);
    square.drawImage(bitmap, (sourceW - side) / 2, (sourceH - side) / 2, side, side, 0, 0, PREVIEW_EDGE, PREVIEW_EDGE);
    // A `file.preview` holds at most 48 KiB of image (docs/crypto.md).
    let preview = await jpeg(square, 0.8);
    for (const quality of [0.6, 0.4, 0.2]) {
      if (preview.length <= PREVIEW_MAX) break;
      preview = await jpeg(square, quality);
    }
    if (preview.length > PREVIEW_MAX) throw new Error("preview too large");

    const hashScale = Math.min(1, HASH_EDGE / Math.max(sourceW, sourceH));
    const hw = Math.max(1, Math.round(sourceW * hashScale));
    const hh = Math.max(1, Math.round(sourceH * hashScale));
    const small = canvas(hw, hh);
    small.drawImage(bitmap, 0, 0, hw, hh);
    const hash = rgbaToThumbHash(hw, hh, small.getImageData(0, 0, hw, hh).data);

    return { copy, copyType, w, h, sourceW, sourceH, preview, hash };
  } finally {
    bitmap.close();
  }
}

self.onmessage = async (event: MessageEvent<MediaRequest>) => {
  const { id, image, type } = event.data;
  let response: MediaResponse;
  try {
    response = { id, ok: true, value: await prepare(image, type) };
  } catch (e) {
    response = { id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  postMessage(response);
};
