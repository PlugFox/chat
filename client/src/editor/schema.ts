/**
 * The ProseMirror schema of the note editor (D-096): one node or mark per
 * construct of the document format (docs/crypto.md, "Message documents"),
 * so a note goes in and out without loss. Table cells hold inline content,
 * as a document's cells are spans. A chart and a block this client does not
 * know are atoms that keep their data as it came.
 */
import { type DOMOutputSpec, type Node, Schema } from "prosemirror-model";
import { tableNodes } from "prosemirror-tables";

const SAFE_HREF = /^(https?|mailto):/i;
export const CALLOUT_KINDS = ["note", "tip", "important", "warning", "caution"] as const;

function align(dom: HTMLElement): string | null {
  const value = dom.style.textAlign;
  return value === "left" || value === "center" || value === "right" ? value : null;
}

export const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "inline*",
      group: "block",
      parseDOM: [{ tag: "p" }],
      toDOM: (): DOMOutputSpec => ["p", 0],
    },
    heading: {
      attrs: { level: { default: 2 } },
      content: "inline*",
      group: "block",
      defining: true,
      parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
      toDOM: (node: Node): DOMOutputSpec => [`h${node.attrs["level"] as number}`, 0],
    },
    blockquote: {
      content: "block+",
      group: "block",
      defining: true,
      parseDOM: [{ tag: "blockquote" }],
      toDOM: (): DOMOutputSpec => ["blockquote", 0],
    },
    callout: {
      attrs: { kind: { default: "note" } },
      content: "block+",
      group: "block",
      defining: true,
      parseDOM: [
        {
          tag: "aside[data-callout]",
          getAttrs: (dom: HTMLElement) => {
            const kind = dom.dataset["callout"] ?? "";
            return (CALLOUT_KINDS as readonly string[]).includes(kind) ? { kind } : { kind: "note" };
          },
        },
      ],
      toDOM: (node: Node): DOMOutputSpec => ["aside", { "data-callout": node.attrs["kind"] as string }, 0],
    },
    panel: {
      content: "panel_title block+",
      group: "block",
      defining: true,
      parseDOM: [{ tag: "details" }],
      toDOM: (): DOMOutputSpec => ["section", { "data-panel": "" }, 0],
    },
    panel_title: {
      content: "inline*",
      defining: true,
      parseDOM: [{ tag: "summary" }],
      toDOM: (): DOMOutputSpec => ["p", { "data-panel-title": "" }, 0],
    },
    bullet_list: {
      content: "list_item+",
      group: "block",
      parseDOM: [{ tag: "ul" }],
      toDOM: (): DOMOutputSpec => ["ul", 0],
    },
    ordered_list: {
      attrs: { order: { default: 1 } },
      content: "list_item+",
      group: "block",
      parseDOM: [
        {
          tag: "ol",
          getAttrs: (dom: HTMLElement) => ({
            order: dom.hasAttribute("start") ? Number(dom.getAttribute("start")) || 0 : 1,
          }),
        },
      ],
      toDOM: (node: Node): DOMOutputSpec =>
        node.attrs["order"] === 1 ? ["ol", 0] : ["ol", { start: node.attrs["order"] as number }, 0],
    },
    list_item: {
      // `null`: a plain item; `true` or `false`: a task, done or not.
      attrs: { checked: { default: null } },
      content: "paragraph block*",
      defining: true,
      parseDOM: [{ tag: "li" }],
      toDOM: (node: Node): DOMOutputSpec =>
        node.attrs["checked"] === null ? ["li", 0] : ["li", { "data-checked": String(node.attrs["checked"]) }, 0],
    },
    code_block: {
      attrs: { lang: { default: null } },
      content: "text*",
      marks: "",
      group: "block",
      code: true,
      defining: true,
      parseDOM: [{ tag: "pre", preserveWhitespace: "full" }],
      toDOM: (): DOMOutputSpec => ["pre", ["code", 0]],
    },
    horizontal_rule: {
      group: "block",
      parseDOM: [{ tag: "hr" }],
      toDOM: (): DOMOutputSpec => ["hr"],
    },
    ...tableNodes({
      tableGroup: "block",
      cellContent: "inline*",
      cellAttributes: {
        align: {
          default: null,
          getFromDOM: align,
          setDOMAttr: (value, attrs) => {
            if (value) attrs["data-align"] = value;
          },
        },
      },
    }),
    /** A chart, kept as it was read; drawn by the editor's node view. */
    chart: {
      attrs: { data: {} },
      group: "block",
      atom: true,
      selectable: true,
      draggable: true,
      toDOM: (): DOMOutputSpec => ["div", { "data-chart": "" }],
    },
    /** A block of a type this client does not know, written back as it came (docs/crypto.md, "Note documents"). */
    opaque: {
      attrs: { raw: {} },
      group: "block",
      atom: true,
      selectable: true,
      draggable: true,
      toDOM: (): DOMOutputSpec => ["div", { "data-opaque": "" }],
    },
    text: { group: "inline" },
    hard_break: {
      inline: true,
      group: "inline",
      selectable: false,
      parseDOM: [{ tag: "br" }],
      toDOM: (): DOMOutputSpec => ["br"],
    },
  },
  marks: {
    link: {
      attrs: { href: {} },
      inclusive: false,
      parseDOM: [
        {
          tag: "a[href]",
          getAttrs: (dom: HTMLElement) => {
            const href = dom.getAttribute("href") ?? "";
            return SAFE_HREF.test(href) ? { href } : false;
          },
        },
      ],
      toDOM: (mark): DOMOutputSpec => ["a", { href: mark.attrs["href"] as string, rel: "noopener noreferrer" }, 0],
    },
    strong: {
      parseDOM: [{ tag: "strong" }, { tag: "b" }],
      toDOM: (): DOMOutputSpec => ["strong", 0],
    },
    em: {
      parseDOM: [{ tag: "em" }, { tag: "i" }],
      toDOM: (): DOMOutputSpec => ["em", 0],
    },
    strike: {
      parseDOM: [{ tag: "s" }, { tag: "del" }],
      toDOM: (): DOMOutputSpec => ["s", 0],
    },
    code: {
      parseDOM: [{ tag: "code" }],
      toDOM: (): DOMOutputSpec => ["code", 0],
    },
  },
});

/** Whether a link may point there: the schemes a document keeps. */
export function safeHref(href: string): boolean {
  return SAFE_HREF.test(href);
}
