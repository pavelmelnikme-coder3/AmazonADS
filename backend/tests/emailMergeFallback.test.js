"use strict";
/**
 * `{{ key | fallback }}` — a default value for merge tags.
 *
 * Every contact in the asian_b2b audience carries a business name in first_name, and the
 * campaign used no merge tags at all, greeting 3,102 restaurants with a flat "Guten Tag,".
 * The names come off public listings, so they are usable but not uniformly: 2,998 of 3,102 sit
 * between 4 and 30 characters, 48 are three characters or fewer, and 58 run to things like
 * "May Asia Shop | Asiatisches Restaurant und Asiatische Lebensmittel". Substituting blindly
 * would put that inside a salutation; substituting nothing wastes the one personalization lever
 * this list has. So a tag may carry the text to use when the value is missing or too long.
 */
const { applyMergeTags } = require("../src/services/email/render");

describe("plain tags keep their old behaviour", () => {
  test("a present value is substituted", () => {
    expect(applyMergeTags("Hallo {{first_name}}!", { first_name: "Geisha" })).toBe("Hallo Geisha!");
  });

  test("an unknown key with no fallback still collapses to empty", () => {
    expect(applyMergeTags("Hi {{nope}}.", {})).toBe("Hi .");
  });

  test("values are still HTML-escaped", () => {
    expect(applyMergeTags("{{x}}", { x: '<b>"&' })).toBe("&lt;b&gt;&quot;&amp;");
  });

  // Without a fallback there is no length rule — a long value is the author's problem, and
  // silently truncating one would be worse than rendering it.
  test("a long value is substituted when no fallback is given", () => {
    const long = "May Asia Shop | Asiatisches Restaurant und Asiatische Lebensmittel";
    expect(applyMergeTags("{{first_name}}", { first_name: long })).toBe(long);
  });
});

describe("{{ key | fallback }}", () => {
  const line = "Guten Tag, liebes Team von {{ first_name | Ihrem Restaurant }},";

  test("a usable name is used", () => {
    expect(applyMergeTags(line, { first_name: "Sojubar" }))
      .toBe("Guten Tag, liebes Team von Sojubar,");
  });

  test("a missing field falls back", () => {
    expect(applyMergeTags(line, {})).toBe("Guten Tag, liebes Team von Ihrem Restaurant,");
  });

  test("an empty or whitespace-only field falls back", () => {
    expect(applyMergeTags(line, { first_name: "" })).toBe("Guten Tag, liebes Team von Ihrem Restaurant,");
    expect(applyMergeTags(line, { first_name: "   " })).toBe("Guten Tag, liebes Team von Ihrem Restaurant,");
  });

  test("a name too long for a sentence falls back", () => {
    const long = "May Asia Shop | Asiatisches Restaurant und Asiatische Lebensmittel";
    expect(applyMergeTags(line, { first_name: long })).toBe("Guten Tag, liebes Team von Ihrem Restaurant,");
  });

  // Real names from the audience, either side of the limit.
  test.each([
    ["Geisha", "Geisha"],
    ["MMAAH! Eat Korean", "MMAAH! Eat Korean"],
    ["Thairestaurant Orchidee", "Thairestaurant Orchidee"],
    ["Ça Va Sàigòn Bánh Mì", "Ça Va Sàigòn Bánh Mì"],
    ["Kaishi Asia Food & Culture", "Kaishi Asia Food &amp; Culture"],
    ["Kai Kitchen - modern vietnamese sushi fusion restaurant", "Ihrem Restaurant"],
    ["Gaststätte Steinerkopf, Biergarten / Asia Restaurant Goldene Ente", "Ihrem Restaurant"],
  ])("%s renders as %s", (name, expected) => {
    expect(applyMergeTags("{{ first_name | Ihrem Restaurant }}", { first_name: name })).toBe(expected);
  });

  test("the value is trimmed before it is measured and used", () => {
    expect(applyMergeTags("{{ first_name | X }}", { first_name: "  Kichi  " })).toBe("Kichi");
  });

  test("the fallback itself is escaped — it lands in the same HTML position", () => {
    expect(applyMergeTags("{{ a | Ihr Betrieb & Team }}", {})).toBe("Ihr Betrieb &amp; Team");
  });

  test("an empty fallback is allowed and means 'render nothing'", () => {
    expect(applyMergeTags("[{{ a | }}]", {})).toBe("[]");
  });
});

// A subject line is plain text in the recipient's inbox. Escaping it turns a real business name
// into markup the recipient reads literally — and 3,102 contacts carry business names, several
// with an ampersand in them ("Kaishi Asia Food & Culture", "T&T").
describe("escape:false, for subject lines", () => {
  test("an ampersand survives into the subject", () => {
    expect(applyMergeTags("Konditionen für {{first_name}}", { first_name: "Kaishi Asia Food & Culture" },
      { escape: false })).toBe("Konditionen für Kaishi Asia Food & Culture");
  });

  test("quotes and angle brackets survive too", () => {
    expect(applyMergeTags("{{n}}", { n: `The Dragon's City <Sushi>` }, { escape: false }))
      .toBe(`The Dragon's City <Sushi>`);
  });

  test("the fallback is left unescaped as well", () => {
    expect(applyMergeTags("{{ a | Ihr Betrieb & Team }}", {}, { escape: false })).toBe("Ihr Betrieb & Team");
  });

  test("the length rule still applies", () => {
    const long = "May Asia Shop | Asiatisches Restaurant und Asiatische Lebensmittel";
    expect(applyMergeTags("{{ n | Ihren Betrieb }}", { n: long }, { escape: false })).toBe("Ihren Betrieb");
  });

  test("escaping is still the default when no options are passed", () => {
    expect(applyMergeTags("{{n}}", { n: "A & B" })).toBe("A &amp; B");
    expect(applyMergeTags("{{n}}", { n: "A & B" }, {})).toBe("A &amp; B");
  });

  test("the limit is configurable, with a floor so it cannot be set to nonsense", () => {
    const prev = process.env.EMAIL_MERGE_MAX_LEN;
    const withLimit = (n) => {
      process.env.EMAIL_MERGE_MAX_LEN = String(n);
      jest.resetModules();
      return require("../src/services/email/render").applyMergeTags;
    };

    let fresh = withLimit(12);
    expect(fresh("{{ n | short }}", { n: "Kichi" })).toBe("Kichi");              // 5
    expect(fresh("{{ n | short }}", { n: "MMAAH! Eat Korean" })).toBe("short");  // 17

    // A limit below 8 would reject nearly every real business name, so it is clamped up.
    fresh = withLimit(2);
    expect(fresh("{{ n | short }}", { n: "Geisha" })).toBe("Geisha");            // 6, under the floor of 8

    if (prev === undefined) delete process.env.EMAIL_MERGE_MAX_LEN; else process.env.EMAIL_MERGE_MAX_LEN = prev;
    jest.resetModules();
  });
});
