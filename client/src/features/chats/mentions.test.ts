import { describe, expect, it } from "vitest";
import { documentText, typedMention } from "./mentions";

describe("mentions", () => {
  it("finds the @ being typed at the end of the text only", () => {
    expect(typedMention("@")).toBe("");
    expect(typedMention("see @pack")).toBe("pack");
    expect(typedMention("a@b.example")).toBeNull();
    expect(typedMention("@done now")).toBeNull();
  });

  it("reads a document's text, a block to a line", () => {
    const doc = {
      v: 1,
      blocks: [
        { t: "p", s: ["One ", { text: "two", f: 1 }] },
        { t: "list", items: [{ b: [{ t: "p", s: ["three"] }] }] },
      ],
    };
    expect(documentText(doc)).toBe("One two\nthree");
  });
});
