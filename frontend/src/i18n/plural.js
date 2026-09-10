/**
 * Plural forms for interpolated counters.
 *
 * A string may carry its forms separated by "|", ordered the way the language needs them:
 *
 *   ru: "{n} кампания|{n} кампании|{n} кампаний"   (1 / 2-4 / 5+)
 *   en: "{count} campaign|{count} campaigns"        (1 / other)
 *   de: "{count} Kampagne|{count} Kampagnen"
 *
 * Without this every counter used the plural form for every value — "1 профилей", "1 campaigns",
 * "1 Kampagnen". Intl.PluralRules knows which category a number falls into per language, so the
 * only thing written down here is how many forms each language keeps and in what order.
 */

// Ordered to match how the strings are authored.
const FORMS_BY_LOCALE = {
  ru: ["one", "few", "many"],
  en: ["one", "other"],
  de: ["one", "other"],
};

/** Which form index a number takes in a locale. */
export function pluralIndex(locale, n) {
  const forms = FORMS_BY_LOCALE[locale] || FORMS_BY_LOCALE.en;
  let category;
  try {
    category = new Intl.PluralRules(locale).select(n);
  } catch {
    // An unknown locale still has to produce something sensible.
    category = n === 1 ? "one" : "other";
  }
  const i = forms.indexOf(category);
  // A category the language does not keep a separate form for (Russian "other", which covers
  // fractions like 2.5) takes the last form — the one that reads acceptably for anything unusual.
  return i === -1 ? forms.length - 1 : i;
}

/**
 * Pick a form out of a "one|few|many" string.
 * @param {string} value - the raw string, with or without "|"
 * @param {object} vars  - interpolation vars; the count is `count`, `n`, or the first number
 * @param {string} locale
 * @returns {string} the chosen form, or `value` unchanged when it carries no forms
 */
export function selectPluralForm(value, vars, locale) {
  if (typeof value !== "string" || !value.includes("|")) return value;
  const forms = value.split("|");
  const n = Number(
    vars?.count ?? vars?.n ?? Object.values(vars || {}).find((v) => typeof v === "number")
  );
  // With no number to go on, take the last form — the general plural. Leaking the raw
  // "one|few|many" string onto the page would be the worse failure.
  if (!Number.isFinite(n)) return forms[forms.length - 1];
  return forms[Math.min(pluralIndex(locale, Math.abs(n)), forms.length - 1)];
}
