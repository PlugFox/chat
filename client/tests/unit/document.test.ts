// @vitest-environment node
/** Message documents: what crates/document writes (through its WASM build) reads back here. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decode } from "@msgpack/msgpack";
import { beforeAll, describe, expect, it } from "vitest";
import { tableCsv } from "../../src/document/csv";
import { share } from "../../src/document/preview";
import { readDocument } from "../../src/document/read";
import { initSync, markdown } from "../../src/document/wasm/chat_document";

beforeAll(() => {
  initSync({ module: readFileSync(join(import.meta.dirname, "../../src/document/wasm/chat_document_bg.wasm")) });
});

const fromMarkdown = (text: string) => readDocument(decode(markdown(text)));

describe("readDocument", () => {
  it("reads what crates/document writes", () => {
    expect(
      fromMarkdown("## Plan\n\n- [x] **pack**\n\n> [!TIP]\n> go [early](https://x.org)\n\n| a | b |\n|:-|-:|\n| 1 |"),
    ).toEqual([
      { t: "h", level: 2, s: ["Plan"] },
      { t: "list", items: [{ b: [{ t: "p", s: [{ text: "pack", f: 1 }] }], checked: true }] },
      { t: "callout", kind: "tip", b: [{ t: "p", s: ["go ", { text: "early", href: "https://x.org" }] }] },
      { t: "table", align: ["left", "right"], head: [["a"], ["b"]], rows: [[["1"], []]] },
    ]);
  });

  it("shows the text for another version or a broken shape", () => {
    expect(readDocument({ v: 2, blocks: [] })).toBeNull();
    expect(readDocument({ v: 1, blocks: [{ t: "p", s: [1] }] })).toBeNull();
    expect(readDocument({ v: 1, blocks: [{ t: "h", level: 9, s: [] }] })).toBeNull();
    expect(readDocument("text")).toBeNull();
  });

  it("refuses nesting past the limit", () => {
    let deep: unknown = { t: "p", s: ["deep"] };
    for (let i = 0; i < 8; i += 1) deep = { t: "quote", b: [deep] };
    expect(readDocument({ v: 1, blocks: [deep] })).not.toBeNull();
    expect(readDocument({ v: 1, blocks: [{ t: "quote", b: [deep] }] })).toBeNull();
    // Far past it: still null, not a stack overflow.
    for (let i = 0; i < 100_000; i += 1) deep = { t: "quote", b: [deep] };
    expect(readDocument({ v: 1, blocks: [deep] })).toBeNull();
  });

  it("shows an unknown block's fallback, drops unsafe links and fits table rows", () => {
    expect(
      readDocument({
        v: 1,
        blocks: [
          { t: "chart", fallback: "Steps by week", data: [1, 2] },
          { t: "chart" },
          {
            t: "p",
            s: [
              { text: "x", href: "javascript:alert(1)" },
              { text: "y", f: 1 | 64, extra: 1 },
            ],
          },
          { t: "table", align: [""], head: [["a"]], rows: [[["1"], ["2"]], []] },
        ],
      }),
    ).toEqual([
      { t: "p", s: ["Steps by week"] },
      { t: "p", s: ["x", { text: "y", f: 1 }] },
      { t: "table", align: [""], head: [["a"]], rows: [[["1"]], [[]]] },
    ]);
  });
});

describe("tableCsv", () => {
  it("quotes what needs it and keeps formulas from running", () => {
    expect(
      tableCsv(
        [["Name"], [{ text: "Sum", f: 1 }]],
        [
          [["a, b"], ['say "hi"']],
          [["=1+1"], ["-3"]],
        ],
      ),
    ).toBe('Name,Sum\r\n"a, b","say ""hi"""\r\n\'=1+1,\'-3');
  });
});

describe("share", () => {
  it("keeps the blocks that did not change, so only the rest redraw", () => {
    const before = fromMarkdown("# Plan\n\nfirst") ?? [];
    const grown = fromMarkdown("# Plan\n\nfirst and more") ?? [];
    const shared = share(before, grown) ?? [];
    expect(shared[0]).toBe(before[0]);
    expect(shared[1]).toBe(grown[1]);
    // The stored document after an equal preview: nothing changes.
    expect(share(before, fromMarkdown("# Plan\n\nfirst") ?? undefined)).toBe(before);
  });
});
