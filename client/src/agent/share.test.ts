import { encode } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";
import { parsePastedProvider, parseProvider, providerUrl, type SharedProvider } from "./share";

const PROVIDER: SharedProvider = {
  name: "OpenRouter",
  kind: "openai_compatible",
  base_url: "https://openrouter.ai/api/v1",
  api_key: "sk-or-secret",
  model: "some/model",
};

function fragment(url: string): string {
  return url.slice(url.indexOf("#") + 1);
}

function link(config: unknown, version = "1"): string {
  const bytes = encode(config);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `${version}.${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

describe("provider links", () => {
  it("round-trips a config, with the key or without it", () => {
    const url = providerUrl("https://chat.example", PROVIDER, true);
    expect(url).toMatch(/^https:\/\/chat\.example\/provider#1\.[A-Za-z0-9_-]+$/);
    expect(parseProvider(fragment(url))).toEqual(PROVIDER);
    const keyless = providerUrl("https://chat.example", PROVIDER, false);
    expect(parseProvider(fragment(keyless))).toEqual({ ...PROVIDER, api_key: "" });
  });

  it("takes a pasted link from any host, or its fragment", () => {
    const url = providerUrl("https://other.example", PROVIDER, true);
    expect(parsePastedProvider(`  ${url}\n`)).toEqual(PROVIDER);
    expect(parsePastedProvider(fragment(url))).toEqual(PROVIDER);
  });

  it("ignores fields it does not know", () => {
    expect(parseProvider(link({ ...PROVIDER, colour: "blue" }))).toEqual(PROVIDER);
  });

  it("refuses what is not a config it can use", () => {
    const { api_key: _, ...rest } = PROVIDER;
    for (const bad of [
      "",
      "1",
      "1.",
      "1.!!",
      link(PROVIDER, "2"),
      `${link(PROVIDER)}.extra`,
      link([PROVIDER]),
      link("text"),
      link({ ...PROVIDER, kind: "gemini" }),
      link({ ...PROVIDER, name: " " }),
      link({ ...PROVIDER, model: "" }),
      link({ ...PROVIDER, base_url: "ftp://host" }),
      link({ ...PROVIDER, base_url: "not a url" }),
      link({ ...PROVIDER, api_key: 7 }),
      link({ ...rest, name: undefined }),
      `1.${"A".repeat(4096)}`,
    ]) {
      expect(parseProvider(bad), bad.slice(0, 40)).toBeNull();
    }
  });
});
