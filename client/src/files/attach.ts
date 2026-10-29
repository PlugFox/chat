/**
 * Files on their way into a message (docs/protocol.md, "Files"; D-101):
 * checked against what every agent takes, images turned into what a
 * message keeps by the media worker, then encrypted, registered and
 * uploaded when the message is sent. Framework-free so it can be tested
 * without a DOM.
 */

import { Encoder } from "@msgpack/msgpack";
import type { ChatKeys, Request } from "../chats/list";
import type { SentFile } from "../protocol/generated/protocol";
import { uuidBytes } from "../vault/bytes";
import type { ChatFiles, FileHttp } from "./chat-files";
import {
  COMPRESS_OVER,
  FILE_MAX,
  type FileKind,
  IMAGE_EDGE,
  imageSize,
  isText,
  kindOf,
  PDF_PAGES,
  PIXELS_MAX,
  pdfPages,
  TEXT_MAX,
} from "./kinds";
import type { MediaLike } from "./media";

const encoder = new Encoder();
/** Bytes of an image's header read to learn its size. */
const HEAD = 64 * 1024;

/** Why a picked file is not taken. */
export type Refusal = "unsupported" | "too_large" | "too_many_pixels" | "too_many_pages" | "not_text" | "unreadable";

/** A file the user picked, checked. */
export type Picked =
  | { ok: true; file: File; kind: FileKind; type: string; w?: number; h?: number; big: boolean }
  | { ok: false; name: string; reason: Refusal };

/** What a message sends of a file: the bytes the model reads, and an image's original. */
export interface Attachment {
  id: string;
  name: string;
  kind: FileKind;
  type: string;
  bytes: Uint8Array;
  w?: number;
  h?: number;
  preview?: Uint8Array;
  hash?: Uint8Array;
  original?: { name: string; type: string; bytes: Uint8Array };
}

async function read(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** Checks a picked file before anything decodes it. */
export async function check(file: File): Promise<Picked> {
  const kind = kindOf(file.name, file.type);
  if (!kind) return { ok: false, name: file.name, reason: "unsupported" };
  if (file.size > FILE_MAX || file.size === 0) {
    return { ok: false, name: file.name, reason: file.size === 0 ? "unreadable" : "too_large" };
  }
  try {
    if (kind.kind === "text") {
      if (file.size > TEXT_MAX) return { ok: false, name: file.name, reason: "too_large" };
      if (!isText(await read(file))) return { ok: false, name: file.name, reason: "not_text" };
      return { ok: true, file, ...kind, big: false };
    }
    if (kind.kind === "pdf") {
      if (pdfPages(await read(file)) > PDF_PAGES) return { ok: false, name: file.name, reason: "too_many_pages" };
      return { ok: true, file, ...kind, big: false };
    }
    const size = imageSize(await read(file.slice(0, HEAD)));
    if (size && size.w * size.h > PIXELS_MAX) return { ok: false, name: file.name, reason: "too_many_pixels" };
    const big = file.size > COMPRESS_OVER || (size !== null && Math.max(size.w, size.h) > IMAGE_EDGE);
    return size ? { ok: true, file, ...kind, w: size.w, h: size.h, big } : { ok: true, file, ...kind, big };
  } catch {
    return { ok: false, name: file.name, reason: "unreadable" };
  }
}

/** The name of a copy whose type changed: `IMG_1.HEIC` sent as a JPEG is `IMG_1.jpg`. */
export function copyName(name: string, type: string): string {
  const ext = type === "image/png" ? "png" : "jpg";
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  return `${base}.${ext}`;
}

/**
 * What a message keeps of a picked file. An image becomes its copy, with
 * the original beside it when it is big and sent as it is.
 */
export async function prepare(picked: Picked & { ok: true }, asIs: boolean, media: MediaLike): Promise<Attachment> {
  const id = crypto.randomUUID();
  const { file, kind, type } = picked;
  if (kind !== "image") return { id, name: file.name, kind, type, bytes: await read(file) };
  const made = await media.prepare(file, type);
  const attachment: Attachment = {
    id,
    name: made.copyType === type ? file.name : copyName(file.name, made.copyType),
    kind,
    type: made.copyType,
    bytes: made.copy,
    w: made.w,
    h: made.h,
    preview: made.preview,
    hash: made.hash,
  };
  if (asIs && picked.big) attachment.original = { name: file.name, type, bytes: await read(file) };
  return attachment;
}

export interface UploadDeps {
  request: Request;
  keys: ChatKeys;
  http: FileHttp;
}

/** Encrypts, registers and uploads one file of a chat; resolves to its id and key record. */
async function upload(
  deps: UploadDeps,
  chatId: string,
  plaintext: Uint8Array,
  preview?: Uint8Array,
): Promise<{ fileId: string; keyRecord: Uint8Array; preview?: Uint8Array; size: number }> {
  const fileId = crypto.randomUUID();
  const { object, keyRecord } = await deps.keys.encryptFile(chatId, fileId, plaintext);
  const sealedPreview = preview
    ? await deps.keys.sealChat(
        chatId,
        { kind: "file.preview", fileId: uuidBytes(fileId) },
        encoder.encode({ type: "image/jpeg", data: preview }),
      )
    : undefined;
  await deps.request(
    "file.create",
    {
      file_id: fileId,
      chat_id: chatId,
      size: object.length,
      key: keyRecord,
      ...(sealedPreview ? { preview: sealedPreview } : {}),
    },
    { retry: "resend" },
  );
  await deps.http.put(fileId, object);
  return sealedPreview
    ? { fileId, keyRecord, preview: sealedPreview, size: object.length }
    : { fileId, keyRecord, size: object.length };
}

/**
 * Uploads a message's files for a chat, the new one included (its keys are
 * made first); resolves to what `message.send` takes, keys and all.
 */
export async function uploadAll(
  deps: UploadDeps,
  chatId: string,
  attachments: Attachment[],
  files?: ChatFiles,
): Promise<SentFile[]> {
  const sent: SentFile[] = [];
  for (const a of attachments) {
    const main = await upload(deps, chatId, a.bytes, a.preview);
    files?.remember({
      file_id: main.fileId,
      size: main.size,
      key: main.keyRecord,
      ...(main.preview ? { preview: main.preview } : {}),
    });
    const key = await deps.keys.fileKey(chatId, main.fileId, main.keyRecord);
    const file: SentFile = { file_id: main.fileId, key, name: a.name, type: a.type, size: a.bytes.length };
    if (a.w !== undefined && a.h !== undefined) {
      file.w = a.w;
      file.h = a.h;
    }
    if (a.hash) file.hash = a.hash;
    if (a.original) {
      const original = await upload(deps, chatId, a.original.bytes);
      files?.remember({ file_id: original.fileId, size: original.size, key: original.keyRecord });
      file.original = { file_id: original.fileId, type: a.original.type, size: a.original.bytes.length };
    }
    sent.push(file);
  }
  return sent;
}
