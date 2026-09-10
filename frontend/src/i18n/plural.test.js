/**
 * Plural forms. The bug these cover is the one that was on every counter in the app: a single
 * string used for all values, so "1 профилей" / "1 campaigns" / "1 Kampagnen" shipped to users.
 */
import { describe, test, expect } from "vitest";
import { pluralIndex, selectPluralForm } from "./plural.js";

const RU = "{n} кампания|{n} кампании|{n} кампаний";
const EN = "{count} campaign|{count} campaigns";

describe("pluralIndex", () => {
  // Russian keeps three forms: 1, 2-4, 5+. The awkward cases are 11-14 (many, not few) and
  // anything ending in 1 other than 11 (one).
  test.each([
    [1, 0], [2, 1], [3, 1], [4, 1], [5, 2], [10, 2],
    [11, 2], [12, 2], [13, 2], [14, 2],
    [21, 0], [22, 1], [25, 2], [101, 0], [111, 2],
    [0, 2],
  ])("ru %i → form %i", (n, i) => expect(pluralIndex("ru", n)).toBe(i));

  test.each([[1, 0], [0, 1], [2, 1], [21, 1], [100, 1]])(
    "en %i → form %i", (n, i) => expect(pluralIndex("en", n)).toBe(i)
  );

  test.each([[1, 0], [0, 1], [2, 1], [11, 1]])(
    "de %i → form %i", (n, i) => expect(pluralIndex("de", n)).toBe(i)
  );

  // Russian has no separate form for fractions, so they must not index past the end of the array.
  test("a fraction in a three-form language lands on the last form", () => {
    expect(pluralIndex("ru", 2.5)).toBe(2);
  });

  test("an unknown locale still answers", () => {
    expect(pluralIndex("xx-ZZ", 1)).toBe(0);
    expect(pluralIndex("xx-ZZ", 7)).toBe(1);
  });
});

describe("selectPluralForm", () => {
  test("picks the Russian form the number calls for", () => {
    expect(selectPluralForm(RU, { n: 1 }, "ru")).toBe("{n} кампания");
    expect(selectPluralForm(RU, { n: 3 }, "ru")).toBe("{n} кампании");
    expect(selectPluralForm(RU, { n: 12 }, "ru")).toBe("{n} кампаний");
  });

  test("reads the count from `count`, `n`, or the first number in vars", () => {
    expect(selectPluralForm(EN, { count: 1 }, "en")).toBe("{count} campaign");
    expect(selectPluralForm(EN, { n: 1 }, "en")).toBe("{count} campaign");
    expect(selectPluralForm(EN, { total: 1 }, "en")).toBe("{count} campaign");
    expect(selectPluralForm(EN, { total: 4 }, "en")).toBe("{count} campaigns");
  });

  // `count: 0` must not be mistaken for "no count given" — that is the ?? vs || distinction.
  test("zero is a count, not a missing value", () => {
    expect(selectPluralForm(EN, { count: 0 }, "en")).toBe("{count} campaigns");
    expect(selectPluralForm(RU, { count: 0 }, "ru")).toBe("{n} кампаний");
  });

  // Negative deltas appear in the movers panel; the form follows the magnitude.
  test("a negative count uses the form for its magnitude", () => {
    expect(selectPluralForm(RU, { n: -1 }, "ru")).toBe("{n} кампания");
    expect(selectPluralForm(RU, { n: -5 }, "ru")).toBe("{n} кампаний");
  });

  test("a string without forms is returned untouched", () => {
    expect(selectPluralForm("Кампании", { n: 2 }, "ru")).toBe("Кампании");
  });

  // The worst outcome would be the raw "one|few|many" reaching the page, so a call with no usable
  // number still has to resolve to one form.
  test("no usable number falls back to the last form", () => {
    expect(selectPluralForm(RU, {}, "ru")).toBe("{n} кампаний");
    expect(selectPluralForm(RU, { name: "x" }, "ru")).toBe("{n} кампаний");
    expect(selectPluralForm(RU, undefined, "ru")).toBe("{n} кампаний");
  });

  test("a two-form string in a three-form locale does not index past the end", () => {
    expect(selectPluralForm(EN, { count: 8 }, "ru")).toBe("{count} campaigns");
  });

  test("non-strings pass through", () => {
    expect(selectPluralForm(undefined, { n: 1 }, "ru")).toBe(undefined);
    expect(selectPluralForm(5, { n: 1 }, "ru")).toBe(5);
  });
});
