import { useI18n } from "../i18n/index.jsx";

export default function LanguageSwitcher() {
  const { locale, setLocale } = useI18n();

  return (
    <button
      onClick={() => setLocale(locale === "ru" ? "en" : "ru")}
      title={locale === "ru" ? "Switch to English" : "Переключить на русский"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 9px",
        borderRadius: 100,
        border: "1px solid var(--b2)",
        background: "var(--s2)",
        color: "var(--tx2)",
        cursor: "pointer",
        fontSize: 12,
        fontFamily: "var(--ui)",
        transition: "all .15s",
        whiteSpace: "nowrap",
      }}
    >
      {locale === "ru" ? "🇷🇺 RU" : "🇺🇸 EN"}
    </button>
  );
}
