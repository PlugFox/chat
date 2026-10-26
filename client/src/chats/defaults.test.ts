import { decode, encode } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";
import { decodeDefaults, encodeDefaults } from "./defaults";

describe("chat defaults", () => {
  it("reads the history it knows and keeps what it does not", () => {
    const read = decodeDefaults(encode({ history: { mode: "compact", auto: false, threshold: 8000 }, later: 1 }));
    expect(read.value).toEqual({ history: { mode: "compact", auto: false, threshold: 8000 } });
    expect(decode(encodeDefaults({ history: { mode: "recent", messages: 9 } }, read.raw))).toEqual({
      history: { mode: "recent", messages: 9 },
      later: 1,
    });
    // Back to the built-in default; a history this client cannot read counts as none.
    expect(decode(encodeDefaults({}, read.raw))).toEqual({ later: 1 });
    expect(decodeDefaults(encode({ history: { mode: "all" } })).value).toEqual({});
    expect(decodeDefaults(encode({ history: { mode: "recent", messages: -1 } })).value).toEqual({});
  });
});
