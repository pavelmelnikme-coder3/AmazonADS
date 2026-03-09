import { useI18n } from "../i18n/index.jsx";

const LANGUAGES = [
  { code: "en", label: "EN", flag: "🇬🇧" },
  { code: "ru", label: "RU", flag: "🇷🇺" },
  { code: "de", label: "DE", flag: "🇩🇪" },
];

export default function LanguageSwitcher() {
  const { locale, setLocale } = useI18n();

  const currentIndex = LANGUAGES.findIndex((l) => l.code === locale);
  const current = LANGUAGES[currentIndex] ?? LANGUAGES[0];
  const next = LANGUAGES[(currentIndex + 1) % LANGUAGES.length];

  return (
    <button
      onClick={() => setLocale(next.code)}
      title={`Switch to ${next.label}`}
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
      {current.flag} {current.label}
    </button>
  );
}
