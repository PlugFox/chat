/**
 * Reads a message document (docs/crypto.md, "Message documents") from the
 * decoded `doc` of a record. The server writes it, so nothing is trusted:
 * a document of another version, nesting past the limit or of the wrong
 * shape reads as `null` and the message shows its text. Within one, an
 * unknown block shows its `fallback`, unknown fields are dropped, links
 * keep only safe schemes and table rows are fitted to the head. A chart's
 * values are fitted to its labels; a chart of an unknown kind, or a pie
 * past a pie's limits, is a table of its data.
 */
import type { Align, Block, CalloutKind, ChartKind, Item, Series, Span } from "../protocol/generated/protocol";

const DEPTH_MAX = 8;
const SERIES_MAX = 8;
const LABELS_MAX = 1000;
const KINDS = new Set<string>(["line", "area", "bar", "pie"]);
const SAFE_HREF = /^(https?|mailto):/i;
const CALLOUTS = new Set<string>(["note", "tip", "important", "warning", "caution"]);
const ALIGNS = new Set<string>(["", "left", "center", "right"]);

class Invalid extends Error {}

type Fields = Record<string, unknown>;

function fields(v: unknown): Fields {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Invalid();
  return v as Fields;
}

function list(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new Invalid();
  return v;
}

function string(v: unknown): string {
  if (typeof v !== "string") throw new Invalid();
  return v;
}

function span(v: unknown): Span {
  if (typeof v === "string") return v;
  const s = fields(v);
  const text = string(s["text"]);
  const f = s["f"] === undefined ? 0 : s["f"];
  if (typeof f !== "number" || !Number.isInteger(f)) throw new Invalid();
  const href = s["href"] === undefined ? undefined : string(s["href"]);
  const styled: Span = { text };
  if (f & 15) styled.f = f & 15;
  if (href !== undefined && SAFE_HREF.test(href)) styled.href = href;
  return styled.f === undefined && styled.href === undefined ? text : styled;
}

function spans(v: unknown): Span[] {
  return list(v).map(span);
}

function optional(v: unknown): string | undefined {
  return v === undefined ? undefined : string(v);
}

function chart(b: Fields): Block {
  const labels = list(b["labels"]).map(string);
  const series = list(b["series"]).map((s): Series => {
    const f = fields(s);
    const values = list(f["values"])
      .slice(0, labels.length)
      .map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));
    while (values.length < labels.length) values.push(null);
    return { name: string(f["name"]), values };
  });
  if (labels.length < 1 || labels.length > LABELS_MAX || series.length < 1 || series.length > SERIES_MAX) {
    throw new Invalid();
  }
  const kind = string(b["kind"]);
  const title = optional(b["title"]);
  const x = optional(b["x"]);
  const y = optional(b["y"]);
  const pie = kind === "pie" && series.length === 1 && labels.length <= SERIES_MAX;
  if (KINDS.has(kind) && (kind !== "pie" || pie)) {
    const read: Block = { t: "chart", kind: kind as ChartKind, labels, series };
    if (title !== undefined) read.title = title;
    if (x !== undefined) read.x = x;
    if (y !== undefined) read.y = y;
    return read;
  }
  return {
    t: "table",
    align: ["", ...series.map((): Align => "right")],
    head: [[x ?? ""], ...series.map((s) => [s.name])],
    rows: labels.map((label, i) => [[label], ...series.map((s) => [String(s.values[i] ?? "")])]),
  };
}

function blocks(v: unknown, depth: number): Block[] {
  return list(v).flatMap((b) => block(b, depth));
}

function nested(v: unknown, depth: number): Block[] {
  if (depth >= DEPTH_MAX) throw new Invalid();
  return blocks(v, depth + 1);
}

function block(v: unknown, depth: number): Block[] {
  const b = fields(v);
  switch (b["t"]) {
    case "p":
      return [{ t: "p", s: spans(b["s"]) }];
    case "h": {
      const level = b["level"];
      if (typeof level !== "number" || !Number.isInteger(level) || level < 1 || level > 6) throw new Invalid();
      return [{ t: "h", level, s: spans(b["s"]) }];
    }
    case "list": {
      if (depth >= DEPTH_MAX) throw new Invalid();
      const start = b["start"];
      if (start !== undefined && (typeof start !== "number" || !Number.isInteger(start) || start < 0)) {
        throw new Invalid();
      }
      const items = list(b["items"]).map((i): Item => {
        const item = fields(i);
        const checked = item["checked"];
        if (checked !== undefined && typeof checked !== "boolean") throw new Invalid();
        const read: Item = { b: blocks(item["b"], depth + 1) };
        if (checked !== undefined) read.checked = checked;
        return read;
      });
      return [start === undefined ? { t: "list", items } : { t: "list", start, items }];
    }
    case "quote":
      return [{ t: "quote", b: nested(b["b"], depth) }];
    case "callout": {
      const kind = string(b["kind"]);
      if (!CALLOUTS.has(kind)) throw new Invalid();
      return [{ t: "callout", kind: kind as CalloutKind, b: nested(b["b"], depth) }];
    }
    case "panel":
      return [{ t: "panel", title: spans(b["title"]), b: nested(b["b"], depth) }];
    case "code": {
      const lang = b["lang"] === undefined ? undefined : string(b["lang"]);
      const text = string(b["text"]);
      return [lang === undefined ? { t: "code", text } : { t: "code", lang, text }];
    }
    case "table": {
      const head = list(b["head"]).map(spans);
      const align = list(b["align"]).map((a) => {
        if (typeof a !== "string" || !ALIGNS.has(a)) throw new Invalid();
        return a as Align;
      });
      const rows = list(b["rows"]).map((r) => {
        const cells = list(r).slice(0, head.length).map(spans);
        while (cells.length < head.length) cells.push([]);
        return cells;
      });
      return [{ t: "table", align, head, rows }];
    }
    case "rule":
      return [{ t: "rule" }];
    case "chart":
      return [chart(b)];
    default: {
      const fallback = b["fallback"];
      return typeof fallback === "string" && fallback !== "" ? [{ t: "p", s: [fallback] }] : [];
    }
  }
}

/** The blocks of a record's `doc`, or `null` when the message should show its text. */
export function readDocument(doc: unknown): Block[] | null {
  try {
    const d = fields(doc);
    if (d["v"] !== 1) return null;
    return blocks(d["blocks"], 0);
  } catch (e) {
    if (e instanceof Invalid || e instanceof RangeError) return null;
    throw e;
  }
}
