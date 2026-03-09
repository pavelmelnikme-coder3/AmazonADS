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

  function t(key, vars = {}) {
    const strings = locales[locale] || locales.ru;
    const value = key.split(".").reduce((obj, k) => obj?.[k], strings) ?? key;
    return Object.entries(vars).reduce(
      (s, [k, v]) => s.replace(`{${k}}`, v),
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
