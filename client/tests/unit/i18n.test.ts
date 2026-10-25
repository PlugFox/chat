import { type MessageFormatElement, parse, TYPE } from "@formatjs/icu-messageformat-parser";
import { describe, expect, it } from "vitest";
import { detectLocale, locales } from "../../src/i18n/locales";
import { en } from "../../src/i18n/messages/en";
import { ru } from "../../src/i18n/messages/ru";

const catalogs = { en, ru };

/** Argument names a message uses, e.g. `{seconds, plural, …}` → seconds. */
function argumentsOf(elements: MessageFormatElement[], out = new Set<string>()): Set<string> {
  for (const el of elements) {
    if (el.type === TYPE.literal || el.type === TYPE.pound) continue;
    out.add(el.value);
    if (el.type === TYPE.plural || el.type === TYPE.select) {
      for (const option of Object.values(el.options)) argumentsOf(option.value, out);
    }
  }
  return out;
}

describe("messages", () => {
  it("every locale has a catalog", () => {
    expect(Object.keys(catalogs).sort()).toEqual([...locales].sort());
  });

  for (const [locale, catalog] of Object.entries(catalogs)) {
    it(`${locale}: same keys as en, valid ICU, same arguments`, () => {
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(en).sort());
      for (const [key, message] of Object.entries(catalog)) {
        const source = en[key as keyof typeof en];
        expect(() => parse(message), `${locale} ${key}`).not.toThrow();
        expect([...argumentsOf(parse(message))].sort(), `${locale} ${key}`).toEqual(
          [...argumentsOf(parse(source))].sort(),
        );
        expect(message.trim(), `${locale} ${key} is empty`).not.toBe("");
      }
    });
  }
});

describe("detectLocale", () => {
  it("prefers the saved choice, then browser languages, then English", () => {
    expect(detectLocale("ru", ["en-US"])).toBe("ru");
    expect(detectLocale(null, ["de-DE", "ru-RU", "en"])).toBe("ru");
    expect(detectLocale("xx", ["fr"])).toBe("en");
    expect(detectLocale(null, [])).toBe("en");
  });
});
