import { useState, useEffect } from "react";
import { useI18n } from "../i18n/index.jsx";
import { buildUtmUrl, slugify } from "../lib/emailBlocks.js";

// Reusable link-with-UTM-parameters builder, used from the Button block and the Text
// block's link toolbar button. Defaults mirror standard ESP practice: source/medium=email,
// campaign=slugified campaign name — all editable.
export default function UtmLinkBuilder({ open, initialUrl = "", campaignName = "", onApply, onClose }) {
  const { t } = useI18n();
  const [url, setUrl] = useState("");
  const [utm, setUtm] = useState({ utm_source: "email", utm_medium: "email", utm_campaign: "", utm_content: "", utm_term: "" });

  useEffect(() => {
    if (!open) return;
    setUrl(initialUrl || "");
    setUtm({ utm_source: "email", utm_medium: "email", utm_campaign: slugify(campaignName), utm_content: "", utm_term: "" });
  }, [open, initialUrl, campaignName]);

  if (!open) return null;

  const finalUrl = buildUtmUrl(url, utm);
  const field = (key, label, placeholder) => (
    <div style={{ marginBottom: 10 }}>
      <label style={{ fontSize: 12, color: "var(--tx2)" }}>{label}</label>
      <input value={utm[key]} onChange={(e) => setUtm((u) => ({ ...u, [key]: e.target.value }))}
        placeholder={placeholder} style={{ width: "100%", marginTop: 4 }} />
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 3100, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--s1)", borderRadius: 14, padding: 22, width: 440, maxWidth: "92vw" }}>
        <h3 style={{ margin: "0 0 14px", fontSize: 16 }}>{t("email.utmTitle")}</h3>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: "var(--tx2)" }}>{t("email.utmDestUrl")}</label>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/page"
            style={{ width: "100%", marginTop: 4, fontFamily: "var(--mono)", fontSize: 12 }} autoFocus />
        </div>

        {field("utm_source", t("email.utmSource"), "email")}
        {field("utm_medium", t("email.utmMedium"), "email")}
        {field("utm_campaign", t("email.utmCampaign"), "summer-sale")}
        {field("utm_content", t("email.utmContent"), "")}
        {field("utm_term", t("email.utmTerm"), "")}

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 12, color: "var(--tx2)" }}>{t("email.utmPreview")}</label>
          <div style={{ marginTop: 4, padding: "8px 10px", background: "var(--s2)", border: "1px solid var(--b1)", borderRadius: 7,
            fontFamily: "var(--mono)", fontSize: 11, color: "var(--tx2)", wordBreak: "break-all" }}>
            {finalUrl || "—"}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn btn-ghost" onClick={onClose}>{t("common.cancel") || "Cancel"}</button>
          <button className="btn btn-primary" disabled={!url} onClick={() => { onApply(finalUrl); onClose(); }}>{t("email.utmApply")}</button>
        </div>
      </div>
    </div>
  );
}
