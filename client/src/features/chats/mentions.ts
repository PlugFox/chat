/**
 * Mentions in the composer (D-123): `@` at the end of the text offers notes and
 * metrics by name, and those still named when the message goes are read here
 * and given to the model for that turn. Choosing an item is the consent, so no
 * dialog asks; the composer says where it goes. The message's record keeps only
 * the `@name` the user wrote.
 */
import { createSignal } from "solid-js";
import { registerResult } from "../../agent/permissions";
import type { ComposerSuggestion } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
import { cut } from "../../notes/records";
import type { Mention } from "../../protocol/generated/protocol";
import { createNotebook } from "../notes/notebook";
import { metricName } from "../registers/format";
import { createRegisters } from "../registers/registers";

const PREFIX = "mention:";
const SHOWN = 6;
/** What one mention gives the model at most, in bytes of UTF-8, and how many a message takes. */
const TEXT_MAX = 32 * 1024;
export const MENTIONS_MAX = 5;

type Item = { kind: "note"; id: string; name: string } | { kind: "metric"; id: string; name: string };

/** The `@text` being typed at the end of the message, or `null`. */
export function typedMention(text: string): string | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text);
  return match ? (match[1] ?? "") : null;
}

const spansText = (spans: unknown): string =>
  Array.isArray(spans)
    ? spans.map((s) => (typeof s === "string" ? s : typeof s?.text === "string" ? s.text : "")).join("")
    : "";

function blockText(block: Record<string, unknown>): string[] {
  const nested = (blocks: unknown) => (Array.isArray(blocks) ? blocks.flatMap(blockText) : []);
  switch (block["t"]) {
    case "p":
    case "h":
      return [spansText(block["s"])];
    case "quote":
    case "callout":
      return nested(block["b"]);
    case "panel":
      return [spansText(block["title"]), ...nested(block["b"])];
    case "list":
      return Array.isArray(block["items"]) ? block["items"].flatMap((item) => nested(item?.b)) : [];
    case "code":
      return typeof block["text"] === "string" ? [block["text"]] : [];
    case "table":
      return tableText(block);
    default:
      return [];
  }
}

function tableText(block: Record<string, unknown>): string[] {
  const row = (cells: unknown) => (Array.isArray(cells) ? cells.map(spansText).join(" | ") : "");
  const rows = Array.isArray(block["rows"]) ? block["rows"].map(row) : [];
  return [row(block["head"]), ...rows];
}

/** The text of a note's document, a block to a line; what a client does not know is left out. */
export function documentText(doc: unknown): string {
  const blocks = (doc as { blocks?: unknown } | null)?.blocks;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .flatMap(blockText)
    .filter((line) => line !== "")
    .join("\n");
}

export function createMentions(draft: () => string, setDraft: (text: string) => void) {
  const { t, locale } = useI18n();
  const notebook = createNotebook();
  const registers = createRegisters();
  const [picked, setPicked] = createSignal<Item[]>([]);

  const items = (): Item[] => {
    notebook.version();
    registers.version();
    const notes = (notebook.book()?.list ?? []).flatMap((e): Item[] =>
      e.title.kind === "text" && e.title.title.trim() !== ""
        ? [{ kind: "note", id: e.info.note_id, name: e.title.title.trim() }]
        : [],
    );
    const known = registers.registers();
    const metrics = (known?.metrics ?? []).flatMap((m): Item[] =>
      known?.register(m.key) ? [{ kind: "metric", id: m.key, name: metricName(m, locale()) }] : [],
    );
    return [...notes, ...metrics];
  };

  const live = () => picked().filter((i) => draft().includes(`@${i.name}`));

  const suggestions = (): ComposerSuggestion[] => {
    const typed = typedMention(draft())?.toLowerCase();
    if (typed === undefined || live().length >= MENTIONS_MAX) return [];
    return items()
      .filter((i) => i.name.toLowerCase().includes(typed))
      .slice(0, SHOWN)
      .map((i) => ({
        id: `${PREFIX}${i.kind}:${i.id}`,
        label: `@${i.name}`,
        description: t(i.kind === "note" ? "chat.mention.note" : "chat.mention.metric"),
      }));
  };

  /** Takes a suggestion; `false` when it is not a mention's. */
  const choose = (id: string): boolean => {
    if (!id.startsWith(PREFIX)) return false;
    const item = items().find((i) => `${PREFIX}${i.kind}:${i.id}` === id);
    if (item) {
      setDraft(`${draft().replace(/@[^\s@]*$/, "")}@${item.name} `);
      setPicked((all) => [...all.filter((i) => i.id !== item.id), item]);
    }
    return true;
  };

  const read = async (item: Item): Promise<Mention> => {
    if (item.kind === "note") {
      const opened = await notebook.book()?.open(item.id);
      if (!opened?.body.ok) throw new Error("the note does not open");
      return { name: item.name, text: cut(documentText(opened.body.doc), TEXT_MAX) };
    }
    const known = registers.registers();
    const metric = known?.metric(item.id);
    if (!known || !metric) throw new Error("no such metric");
    const entries = await known.read(item.id);
    const text = registerResult(metric, entries, undefined, undefined, known.goal(item.id));
    return { name: item.name, text };
  };

  return {
    /** Whether the message as it stands gives the model anything. */
    active: () => live().length > 0,
    suggestions,
    choose,
    /** Reads what the message names; a failure stops the send, as the user asked for that item. */
    resolve: () => Promise.all(live().map(read)),
    clear: () => setPicked([]),
  };
}
