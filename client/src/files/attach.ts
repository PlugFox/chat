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
import { FileHttpError } from "./http";
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

/** Why a picked file is not taken. */
export type Refusal = "unsupported" | "too_large" | "too_many_pixels" | "too_many_pages" | "not_text" | "unreadable";

/** A file the user picked, checked. */
export type Picked =
  | { ok: true; file: File; kind: FileKind; type: string; w?: number; h?: number; big: boolean }
  | { ok: false; name: string; reason: Refusal };

/**
 * What a message sends of a file: what the model reads, and an image's
 * original. Kept as blobs, the picked file itself where it goes unchanged,
 * so the files waiting in the composer are not held in memory.
 */
export interface Attachment {
  id: string;
  name: string;
  kind: FileKind;
  type: string;
  data: Blob;
  w?: number;
  h?: number;
  preview?: Uint8Array;
  hash?: Uint8Array;
  original?: { name: string; type: string; data: Blob };
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
    const size = imageSize(await read(file));
    // An image whose header does not tell its size is not decoded on trust.
    if (!size) return { ok: false, name: file.name, reason: "unreadable" };
    if (size && size.w * size.h > PIXELS_MAX) return { ok: false, name: file.name, reason: "too_many_pixels" };
    const big = file.size > COMPRESS_OVER || Math.max(size.w, size.h) > IMAGE_EDGE;
    return { ok: true, file, ...kind, w: size.w, h: size.h, big };
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
  if (kind !== "image") return { id, name: file.name, kind, type, data: file };
  const made = await media.prepare(file, type);
  const attachment: Attachment = {
    id,
    name: made.copyType === type ? file.name : copyName(file.name, made.copyType),
    kind,
    type: made.copyType,
    data: new Blob([new Uint8Array(made.copy)], { type: made.copyType }),
    w: made.w,
    h: made.h,
    preview: made.preview,
    hash: made.hash,
  };
  if (asIs && picked.big) attachment.original = { name: file.name, type, data: file };
  return attachment;
}

export interface UploadDeps {
  request: Request;
  keys: ChatKeys;
  http: FileHttp;
  /** Waits between tries; tests make it instant. */
  sleep?: (ms: number) => Promise<void>;
}

/** Tries of one object's `PUT`, and the waits between them. */
const PUT_TRIES = 3;
const BACKOFF = [1000, 4000];

/** Whether a failed `PUT` may go better another time: the network, a busy or failing server. */
function retryable(e: unknown): boolean {
  return e instanceof FileHttpError && (e.status === 0 || e.status === 429 || e.status >= 500);
}

async function put(deps: UploadDeps, fileId: string, object: Blob): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      await deps.http.put(fileId, object);
      return;
    } catch (e) {
      // An earlier try that stored the object lost only its answer.
      if (attempt > 1 && e instanceof FileHttpError && e.code === "file.exists") return;
      if (attempt >= PUT_TRIES || !retryable(e)) throw e;
      await sleep(BACKOFF[attempt - 1] ?? 4000);
    }
  }
}

/** Encrypts, registers and uploads one file of a chat; resolves to its id and key record. */
async function upload(
  deps: UploadDeps,
  chatId: string,
  fileId: string,
  plaintext: Blob,
  preview?: Uint8Array,
  original = false,
): Promise<{ keyRecord: Uint8Array; preview?: Uint8Array; size: number }> {
  const { object, keyRecord } = await deps.keys.encryptFile(chatId, fileId, plaintext, original);
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
      size: object.size,
      key: keyRecord,
      ...(sealedPreview ? { preview: sealedPreview } : {}),
    },
    { retry: "resend" },
  );
  await put(deps, fileId, object);
  return sealedPreview ? { keyRecord, preview: sealedPreview, size: object.size } : { keyRecord, size: object.size };
}

/**
 * Uploads a message's files for a chat, the new one included (its keys are
 * made first), one at a time; resolves to what `message.send` takes, keys
 * and all. A send that fails takes back what it registered, so nothing
 * waits on the server for the sweep.
 */
export async function uploadAll(
  deps: UploadDeps,
  chatId: string,
  attachments: Attachment[],
  files?: ChatFiles,
): Promise<SentFile[]> {
  // What the model reads of a message at most, checked before anything is uploaded.
  if (attachments.reduce((n, a) => n + a.data.size, 0) > FILE_MAX) throw new FileHttpError(0, "file.too_large");
  const sent: SentFile[] = [];
  const registered: string[] = [];
  try {
    for (const a of attachments) {
      const fileId = crypto.randomUUID();
      registered.push(fileId);
      const main = await upload(deps, chatId, fileId, a.data, a.preview);
      files?.remember({
        file_id: fileId,
        size: main.size,
        key: main.keyRecord,
        ...(main.preview ? { preview: main.preview } : {}),
      });
      const key = await deps.keys.fileKey(chatId, fileId, main.keyRecord);
      const file: SentFile = { file_id: fileId, key, name: a.name, type: a.type, size: a.data.size };
      if (a.w !== undefined && a.h !== undefined) {
        file.w = a.w;
        file.h = a.h;
      }
      if (a.hash) file.hash = a.hash;
      if (a.original) {
        const originalId = crypto.randomUUID();
        registered.push(originalId);
        const original = await upload(deps, chatId, originalId, a.original.data, undefined, true);
        files?.remember({ file_id: originalId, size: original.size, key: original.keyRecord });
        file.original = { file_id: originalId, type: a.original.type, size: a.original.data.size };
      }
      sent.push(file);
    }
  } catch (e) {
    await forget(deps, registered);
    throw e;
  }
  return sent;
}

/**
 * Takes back files a send registered and will not send; best effort, since
 * the server sweeps what no message took anyway.
 */
export async function forget(deps: Pick<UploadDeps, "request">, fileIds: string[]): Promise<void> {
  if (fileIds.length === 0) return;
  try {
    await deps.request("file.forget", { file_ids: fileIds });
  } catch {
    // Offline or refused: the sweep removes them.
  }
}
