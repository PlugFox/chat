/**
 * Markdown to a document on the client, for a reply that is still streaming
 * or was stored without one (docs/crypto.md, "Message documents"). The
 * conversion is crates/document compiled to WASM, loaded on first use on
 * the main thread, apart from the crypto worker (D-094).
 */
import { decode } from "@msgpack/msgpack";
import { type Accessor, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import type { Block } from "../protocol/generated/protocol";
import { readDocument } from "./read";

type Convert = (markdown: string) => Uint8Array;

let loading: Promise<Convert> | null = null;

function converter(): Promise<Convert> {
  loading ??= import("./wasm/chat_document").then(async (m) => {
    await m.default();
    return m.markdown;
  });
  return loading;
}

/** The blocks of `markdown`, as a stored document would read. */
export async function toDocument(markdown: string): Promise<Block[] | null> {
  const convert = await converter();
  return readDocument(decode(convert(markdown)));
}

/** How often a streaming reply's preview is rebuilt. */
const PREVIEW_MS = 100;

/**
 * `next` with every block equal to the one at its place in `prev` replaced
 * by that one: the list renders by identity, so a growing reply redraws its
 * last block only, and the stored document after its preview nothing. A
 * long text is costly to lay out (seconds for 70 KB without a space on a
 * phone), which is why this matters.
 */
export function share(prev: Block[] | undefined, next: Block[] | undefined): Block[] | undefined {
  if (!prev || !next) return next;
  let same = prev.length === next.length;
  const shared = next.map((block, i) => {
    const old = prev[i];
    if (old !== undefined && (old === block || JSON.stringify(old) === JSON.stringify(block))) return old;
    same = false;
    return block;
  });
  return same ? prev : shared;
}

export interface Rendered {
  /** The blocks to show. */
  blocks: Accessor<Block[] | undefined>;
  /** A text waits for its first conversion: show nothing rather than lay it out twice. */
  pending: Accessor<boolean>;
}

/**
 * The blocks to show for a message: its stored document, else its text
 * converted, at most every `PREVIEW_MS` while the text grows. Without a
 * text to convert, or when the converter fails to load, there are none.
 */
export function createDocument(stored: Accessor<Block[] | undefined>, text: Accessor<string | undefined>): Rendered {
  const [converted, setConverted] = createSignal<Block[] | undefined>();
  const [failed, setFailed] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: string | undefined;
  let alive = true;
  onCleanup(() => {
    alive = false;
    clearTimeout(timer);
  });
  const run = () => {
    timer = undefined;
    const markdown = pending;
    if (markdown === undefined) return;
    toDocument(markdown).then(
      (blocks) => {
        // Only the latest text counts: an older one may finish later.
        if (alive && pending === markdown) setConverted(blocks ?? undefined);
      },
      () => setFailed(true),
    );
  };
  const source = () => (stored() ? undefined : text() || undefined);
  createEffect(() => {
    const next = source();
    pending = next;
    if (next === undefined) {
      setConverted(undefined);
      return;
    }
    timer ??= setTimeout(run, untrack(converted) === undefined ? 0 : PREVIEW_MS);
  });
  const blocks = createMemo<Block[] | undefined>((prev) => share(prev, stored() ?? converted()));
  return {
    blocks,
    pending: () => source() !== undefined && converted() === undefined && !failed(),
  };
}
