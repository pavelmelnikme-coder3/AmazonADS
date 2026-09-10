/**
 * Small pure helpers for turning stored values into what a person reads.
 *
 * They live here rather than in App.jsx so they can be tested on their own — each was written to
 * fix a case where the interface stated something untrue.
 */

/**
 * A rank badge.
 *
 * `blocked` is not the same answer as "not in the results", and the two must not share a badge.
 * Amazon refuses roughly a quarter of these checks — 20 of 73 on the day this was written, 25.2%
 * over the preceding three weeks — and every refusal used to render as the same grey dash a
 * genuinely unranked keyword gets. Someone reading the page saw a product that had dropped out of
 * the rankings; what had actually happened was that nobody could look.
 */
export function positionBadge(position, found, blocked) {
  if (blocked) return { label: "?", bg: "rgba(245,158,11,.12)", color: "var(--amb)", border: "rgba(245,158,11,.35)", blocked: true };
  if (!found || position === null || position === 0) return { label: "—", bg: "var(--s2)", color: "var(--tx3)", border: "var(--b2)" };
  if (position <= 3)  return { label: `#${position}`, bg: "rgba(234,179,8,.15)",  color: "#ca8a04", border: "rgba(234,179,8,.4)" };
  if (position <= 10) return { label: `#${position}`, bg: "rgba(34,197,94,.15)",  color: "var(--grn)", border: "rgba(34,197,94,.4)" };
  if (position <= 20) return { label: `#${position}`, bg: "rgba(20,184,166,.12)", color: "#0d9488", border: "rgba(20,184,166,.35)" };
  if (position <= 48) return { label: `#${position}`, bg: "rgba(245,158,11,.12)", color: "var(--amb)", border: "rgba(245,158,11,.35)" };
  return { label: `#${position}`, bg: "rgba(239,68,68,.1)", color: "var(--red)", border: "rgba(239,68,68,.3)" };
}

/**
 * A value out of an audit diff.
 *
 * Diffs carry whatever the backend recorded, and some fields hold an object — the rule engine
 * stores the metrics a rule matched on under `metrics`, which is exactly the evidence for why it
 * fired. Both renderers passed the value through String(), so that evidence reached the page as
 * the literal text "[object Object]".
 */
export function auditValueText(v) {
  if (v === null || v === undefined) return "—";
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) return v.map(auditValueText).join(", ") || "—";
  const parts = Object.entries(v).map(([k, x]) => {
    const n = typeof x === "number" ? (Number.isInteger(x) ? x : Math.round(x * 100) / 100) : auditValueText(x);
    return `${k}=${n}`;
  });
  return parts.join(" ") || "—";
}

/** The full JSON, for the hover title, when the compact form had to drop detail. */
export const auditValueTitle = (v) => (v && typeof v === "object" ? JSON.stringify(v, null, 1) : undefined);

/**
 * What to call a product on screen.
 *
 * `title` is the Amazon listing title and is empty for half this catalogue — those listings are
 * dead in the home marketplace, so the scraper has nothing to fetch and the row used to render as
 * a bare ASIN. The ERP knows what the article is, so its name stands in, marked as such: it is
 * the company's own wording, not what a shopper sees on Amazon.
 */
export function productDisplayName(p) {
  const title = (p?.title || "").trim();
  if (title) return { name: title, fromWawi: false };
  const wawi = (p?.wawi_name || "").trim();
  return wawi ? { name: wawi, fromWawi: true } : { name: "", fromWawi: false };
}
