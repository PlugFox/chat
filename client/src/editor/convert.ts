/**
 * A note's document (docs/crypto.md, "Note documents") to the editor's
 * nodes and back. Reading checks the whole document with the message
 * reader first, so the editor takes only what a reader would show; within
 * it, a block of an unknown type becomes an atom that keeps its raw map and
 * is written back unchanged. Writing produces only shapes the reader takes:
 * nothing nested past the limit, table rows as long as the head.
 */
import type { Mark, MarkType, Node } from "prosemirror-model";
import { readDocument } from "../document/read";
import type { Block, Span } from "../protocol/generated/protocol";
import { schema } from "./schema";

/** A block as stored: a known one, or one of a type this client does not know. */
export type Raw = Record<string, unknown>;

const DEPTH_MAX = 8;
const FLAGS: [MarkType, number][] = [
  [schema.marks.strong, 1],
  [schema.marks.em, 2],
  [schema.marks.strike, 4],
  [schema.marks.code, 8],
];
const KNOWN = new Set(["p", "h", "list", "quote", "callout", "panel", "code", "table", "rule", "chart"]);

function fields(v: unknown): Raw {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Raw) : {};
}

function array(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** One known block as the reader takes it, children left out. */
function readOne(raw: Raw): Block {
  const read = readDocument({ v: 1, blocks: [raw] });
  const block = read?.[0];
  if (!block) throw new Error("block not readable");
  return block;
}

function marks(span: Span): Mark[] {
  if (typeof span === "string") return [];
  const out: Mark[] = [];
  if (span.href !== undefined) out.push(schema.marks.link.create({ href: span.href }));
  for (const [type, bit] of FLAGS) if ((span.f ?? 0) & bit) out.push(type.create());
  return out;
}

function inline(spans: Span[]): Node[] {
  const out: Node[] = [];
  for (const span of spans) {
    const text = typeof span === "string" ? span : span.text;
    const styled = marks(span);
    text.split("\n").forEach((part, i) => {
      if (i > 0) out.push(schema.nodes.hard_break.create());
      if (part !== "") out.push(schema.text(part, styled));
    });
  }
  return out;
}

function blocksIn(raws: unknown[]): Node[] {
  return raws.map((raw) => blockIn(fields(raw)));
}

function blockIn(raw: Raw): Node {
  const t = raw["t"];
  if (typeof t !== "string" || !KNOWN.has(t)) return schema.nodes.opaque.create({ raw });
  const n = schema.nodes;
  // Containers: their own fields read without children, the children kept raw.
  switch (t) {
    case "quote":
      readOne({ ...raw, b: [] });
      return n.blockquote.create(null, nonEmpty(blocksIn(array(raw["b"]))));
    case "callout": {
      const read = readOne({ ...raw, b: [] });
      return n.callout.create({ kind: read.t === "callout" ? read.kind : "note" }, nonEmpty(blocksIn(array(raw["b"]))));
    }
    case "panel": {
      const read = readOne({ ...raw, b: [] });
      const title = read.t === "panel" ? read.title : [];
      return n.panel.create(null, [n.panel_title.create(null, inline(title)), ...nonEmpty(blocksIn(array(raw["b"])))]);
    }
    case "list": {
      const items = array(raw["items"]).map(fields);
      const read = readOne({ ...raw, items: items.map((i) => ({ ...i, b: [] })) });
      if (read.t !== "list") throw new Error("list not readable");
      const nodes = items.map((item, i) => {
        const children = blocksIn(array(item["b"]));
        // An item starts with a paragraph in the editor.
        if (children[0]?.type !== n.paragraph) children.unshift(n.paragraph.create());
        return n.list_item.create({ checked: read.items[i]?.checked ?? null }, children);
      });
      if (nodes.length === 0) return n.paragraph.create();
      return read.start === undefined
        ? n.bullet_list.create(null, nodes)
        : n.ordered_list.create({ order: read.start }, nodes);
    }
  }
  const block = readOne(raw);
  switch (block.t) {
    case "p":
      return n.paragraph.create(null, inline(block.s));
    case "h":
      return n.heading.create({ level: block.level }, inline(block.s));
    case "code":
      return n.code_block.create({ lang: block.lang ?? null }, block.text === "" ? [] : schema.text(block.text));
    case "rule":
      return n.horizontal_rule.create();
    case "table": {
      const row = (cells: Span[][], header: boolean) =>
        n.table_row.create(
          null,
          cells.map((cell, i) =>
            (header ? n.table_header : n.table_cell).create({ align: block.align[i] || null }, inline(cell)),
          ),
        );
      if (block.head.length === 0) return n.paragraph.create();
      return n.table.create(null, [row(block.head, true), ...block.rows.map((r) => row(r, false))]);
    }
    case "chart":
      // Written back as read, with the title as its fallback as the writer sets it.
      return n.chart.create({ data: block.title === undefined ? block : { ...block, fallback: block.title } });
    default:
      // A chart the reader shows as a table, or a block it turned into its fallback.
      return blockIn(block as unknown as Raw);
  }
}

/** The editor's nodes of blocks converted from Markdown, or `null` when no reader would show them. */
export function blocksToNodes(blocks: Raw[]): Node[] | null {
  if (readDocument({ v: 1, blocks }) === null) return null;
  try {
    return blocksIn(blocks);
  } catch {
    return null;
  }
}

function nonEmpty(nodes: Node[]): Node[] {
  return nodes.length > 0 ? nodes : [schema.nodes.paragraph.create()];
}

/** The editor's document of a note's `doc`, or `null` when no reader would show it (it stays read-only). */
export function toEditor(doc: unknown): Node | null {
  if (readDocument(doc) === null) return null;
  try {
    return schema.nodes.doc.create(null, nonEmpty(blocksIn(array(fields(doc)["blocks"]))));
  } catch {
    return null;
  }
}

function spansOut(node: Node): Span[] {
  const out: { text: string; f: number; href: string | undefined }[] = [];
  node.forEach((child) => {
    let f = 0;
    let href: string | undefined;
    // A break is unstyled text: it joins a plain span, never a link or bold one.
    const breaks = child.type === schema.nodes.hard_break;
    for (const mark of breaks ? [] : child.marks) {
      if (mark.type === schema.marks.link) href = mark.attrs["href"] as string;
      for (const [type, bit] of FLAGS) if (mark.type === type) f |= bit;
    }
    const text = breaks ? "\n" : (child.text ?? "");
    const last = out.at(-1);
    if (last && last.f === f && last.href === href) last.text += text;
    else out.push({ text, f, href });
  });
  return out.map(({ text, f, href }) => {
    if (f === 0 && href === undefined) return text;
    const span: Span = { text };
    if (f !== 0) span.f = f;
    if (href !== undefined) span.href = href;
    return span;
  });
}

function children(node: Node, depth: number): Raw[] {
  const out: Raw[] = [];
  node.forEach((child) => {
    out.push(...blockOut(child, depth));
  });
  return out;
}

/** The leaf blocks of a container nested too deep, in order (docs/crypto.md, "Message documents"). */
function flatten(node: Node): Raw[] {
  const out: Raw[] = [];
  node.descendants((child) => {
    if (child.isTextblock || child.isAtom || child.type === schema.nodes.table) {
      out.push(...blockOut(child, 0));
      return false;
    }
    return true;
  });
  return out;
}

function blockOut(node: Node, depth: number): Raw[] {
  const n = schema.nodes;
  const container = (raw: (inner: Raw[]) => Raw): Raw[] =>
    depth >= DEPTH_MAX ? flatten(node) : [raw(children(node, depth + 1))];
  switch (node.type) {
    case n.paragraph:
    case n.panel_title:
      return [{ t: "p", s: spansOut(node) }];
    case n.heading:
      return [{ t: "h", level: node.attrs["level"] as number, s: spansOut(node) }];
    case n.blockquote:
      return container((b) => ({ t: "quote", b }));
    case n.callout:
      return container((b) => ({ t: "callout", kind: node.attrs["kind"] as string, b }));
    case n.panel: {
      const title = node.firstChild;
      if (depth >= DEPTH_MAX) return flatten(node);
      const body: Raw[] = [];
      node.forEach((child, _offset, i) => {
        if (i > 0) body.push(...blockOut(child, depth + 1));
      });
      return [{ t: "panel", title: title ? spansOut(title) : [], b: body }];
    }
    case n.bullet_list:
    case n.ordered_list: {
      if (depth >= DEPTH_MAX) return flatten(node);
      const items: Raw[] = [];
      node.forEach((item) => {
        const out: Raw = { b: children(item, depth + 1) };
        const checked = item.attrs["checked"];
        if (typeof checked === "boolean") out["checked"] = checked;
        items.push(out);
      });
      const list: Raw = { t: "list", items };
      if (node.type === n.ordered_list) list["start"] = node.attrs["order"] as number;
      return [list];
    }
    case n.code_block: {
      const code: Raw = { t: "code", text: node.textContent };
      const lang = node.attrs["lang"];
      if (typeof lang === "string" && lang !== "") code["lang"] = lang;
      return [code];
    }
    case n.horizontal_rule:
      return [{ t: "rule" }];
    case n.table: {
      const rows: Span[][][] = [];
      const align: string[] = [];
      node.forEach((row, _offset, r) => {
        const cells: Span[][] = [];
        row.forEach((cell) => {
          if (r === 0) align.push((cell.attrs["align"] as string | null) ?? "");
          cells.push(spansOut(cell));
        });
        rows.push(cells);
      });
      const [head = [], ...body] = rows;
      const fitted = body.map((r) => {
        const cells = r.slice(0, head.length);
        while (cells.length < head.length) cells.push([]);
        return cells;
      });
      return [{ t: "table", align, head, rows: fitted }];
    }
    case n.chart:
      return [node.attrs["data"] as Raw];
    case n.opaque:
      return [node.attrs["raw"] as Raw];
    default:
      return [];
  }
}

/** The `doc` of a note from the editor's document. */
export function fromEditor(doc: Node): { v: 1; blocks: Raw[] } {
  return { v: 1, blocks: children(doc, 0) };
}

/** The text of a document, for a note's excerpt: blocks joined by spaces, whitespace collapsed. */
export function plainText(doc: Node): string {
  return doc.textBetween(0, doc.content.size, " ", " ").replace(/\s+/g, " ").trim();
}
