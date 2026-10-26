import { wrapIn } from "prosemirror-commands";
import type { Node } from "prosemirror-model";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { setCallout, toggle, toggleList } from "./commands";
import { fromEditor, plainText, toEditor } from "./convert";
import { schema } from "./schema";

const doc = (blocks: unknown[]) => ({ v: 1, blocks });

function editor(blocks: unknown[]): Node {
  const node = toEditor(doc(blocks));
  if (!node) throw new Error("not readable");
  return node;
}

describe("note documents in the editor", () => {
  it("round-trips every block a note holds", () => {
    const blocks = [
      { t: "h", level: 1, s: ["Trip"] },
      { t: "p", s: ["Plain ", { text: "bold", f: 1 }, { text: " link", href: "https://example.com" }, "\nnext line"] },
      {
        t: "list",
        items: [
          { b: [{ t: "p", s: ["one"] }] },
          {
            b: [
              { t: "p", s: ["two"] },
              { t: "code", text: "x" },
            ],
          },
        ],
      },
      { t: "list", start: 3, items: [{ b: [{ t: "p", s: ["three"] }] }] },
      {
        t: "list",
        items: [
          { b: [{ t: "p", s: ["done"] }], checked: true },
          { b: [{ t: "p", s: ["open"] }], checked: false },
        ],
      },
      { t: "quote", b: [{ t: "p", s: ["quoted"] }] },
      { t: "callout", kind: "warning", b: [{ t: "p", s: ["careful"] }] },
      { t: "panel", title: ["More"], b: [{ t: "p", s: ["hidden"] }] },
      { t: "code", lang: "rust", text: "fn main() {}\n" },
      { t: "table", align: ["", "right"], head: [["Day"], ["Km"]], rows: [[["Mon"], ["5"]]] },
      { t: "rule" },
      { t: "chart", kind: "bar", title: "Km", labels: ["Mon"], series: [{ name: "Km", values: [5] }], fallback: "Km" },
    ];
    expect(fromEditor(editor(blocks))).toEqual(doc(blocks));
  });

  it("keeps a block of an unknown type as it came, and reads none it cannot", () => {
    const image = { t: "image", file: "f-1", alt: "A cat", fallback: "A cat" };
    expect(fromEditor(editor([{ t: "p", s: ["before"] }, image])).blocks[1]).toEqual(image);
    expect(toEditor({ v: 2, blocks: [] })).toBeNull();
    expect(toEditor(doc([{ t: "h", level: 9, s: [] }]))).toBeNull();
  });

  it("writes table rows as long as the head and flattens what nests too deep", () => {
    // A row longer than its head is cut on reading already; an added column fills every row.
    const table = editor([{ t: "table", align: ["", ""], head: [["a"], ["b"]], rows: [[["1"]]] }]);
    expect(fromEditor(table).blocks[0]).toMatchObject({ rows: [[["1"], []]] });

    let deep: unknown = { t: "p", s: ["deep"] };
    for (let i = 0; i < 8; i += 1) deep = { t: "quote", b: [deep] };
    const node = editor([deep]);
    let state = EditorState.create({ doc: node });
    // Wrapping the innermost paragraph once more passes the limit: the ninth quote is written as its paragraph.
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 9)));
    expect(wrapIn(schema.nodes.blockquote)(state, (tr) => (state = state.apply(tr)))).toBe(true);
    expect(state.doc.toString()).toContain(
      "blockquote(blockquote(blockquote(blockquote(blockquote(blockquote(blockquote(blockquote(blockquote(",
    );
    expect(fromEditor(state.doc)).toEqual(doc([deep]));
  });

  it("gives the text of a note for its excerpt", () => {
    const node = editor([
      { t: "h", level: 1, s: ["Title"] },
      { t: "p", s: ["Some  text\nhere"] },
    ]);
    expect(plainText(node)).toBe("Title Some text here");
  });

  it("formats, lists and wraps in callouts from commands", () => {
    let state = EditorState.create({ doc: editor([{ t: "p", s: ["item"] }]) });
    const run = (command: (s: EditorState, d: (tr: Transaction) => void) => boolean) => {
      expect(command(state, (tr) => (state = state.apply(tr)))).toBe(true);
    };
    run(toggleList("task"));
    expect(fromEditor(state.doc).blocks).toEqual([
      { t: "list", items: [{ b: [{ t: "p", s: ["item"] }], checked: false }] },
    ]);
    run(toggleList("ordered"));
    expect(fromEditor(state.doc).blocks[0]).toMatchObject({ start: 1, items: [{ b: [{ t: "p", s: ["item"] }] }] });
    run(toggleList("ordered"));
    run(setCallout("tip"));
    expect(fromEditor(state.doc).blocks).toEqual([{ t: "callout", kind: "tip", b: [{ t: "p", s: ["item"] }] }]);
    run(setCallout(null));
    state = state.apply(state.tr.setSelection(EditorState.create({ doc: state.doc }).selection));
    expect(toggle.strong(state)).toBe(true);
  });
});
