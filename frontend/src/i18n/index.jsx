import { createContext, useContext, useState } from "react";
import en from "./en.js";
import ru from "./ru.js";
import de from "./de.js";

const locales = { en, ru, de };

const I18nContext = createContext(null);

export function I18nProvider({ children }) {
  const [locale, setLocaleState] = useState(
    localStorage.getItem("af_locale") || "ru"
  );

  // Plural forms, written in the string as "one|few|many" and picked by Intl.PluralRules for the
  // active locale. Without this a counter reads "1 профилей", "1 campaigns", "1 Kampagnen" — the
  // plural form used for every value including one. Russian needs three forms (1, 2-4, 5+),
  // English and German two; Intl knows which, so the code does not have to.
  const pluralIndex = (loc, n) => {
    const forms = { ru: ["one", "few", "many"], en: ["one", "other"], de: ["one", "other"] }[loc] || ["one", "other"];
    let cat;
    try { cat = new Intl.PluralRules(loc).select(n); } catch { cat = n === 1 ? "one" : "other"; }
    const i = forms.indexOf(cat);
    // "other" in a three-form language (2.5 профиля) falls back to the last form, which is the
    // one that reads acceptably for anything unusual.
    return i === -1 ? forms.length - 1 : i;
  };

  function t(key, vars = {}) {
    const strings = locales[locale] || locales.ru;
    let value = key.split(".").reduce((obj, k) => obj?.[k], strings) ?? key;

    if (typeof value === "string" && value.includes("|")) {
      const forms = value.split("|");
      const n = Number(vars.count ?? vars.n ?? Object.values(vars).find((v) => typeof v === "number"));
      // With no number to go on, take the last form — the general plural. Leaking the raw
      // "one|few|many" string onto the page would be the worse failure.
      value = Number.isFinite(n)
        ? forms[Math.min(pluralIndex(locale, Math.abs(n)), forms.length - 1)]
        : forms[forms.length - 1];
    }

    return Object.entries(vars).reduce(
      (s, [k, v]) => s.replaceAll(`{${k}}`, v),
      value
    );
  }

  function setLocale(newLocale) {
    localStorage.setItem("af_locale", newLocale);
    setLocaleState(newLocale);
  }

  return (
    <I18nContext.Provider value={{ t, locale, setLocale }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
