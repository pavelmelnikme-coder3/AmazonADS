import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "./i18n/index.jsx";
import LanguageSwitcher from "./components/LanguageSwitcher.jsx";
import SyncStatusToast from "./components/SyncStatusToast.jsx";

// ─── Styles ───────────────────────────────────────────────────────────────────
const Styles = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Mono:wght@300;400;500&family=Outfit:wght@300;400;500;600&display=swap');
    :root{--bg:#070C18;--s1:#0D1425;--s2:#141D30;--s3:#1C2640;--b1:#1E2A40;--b2:#26344E;
    --ac:#3B82F6;--ac2:#60A5FA;--teal:#14B8A6;--amb:#F59E0B;--red:#EF4444;--grn:#22C55E;
    --pur:#A78BFA;--tx:#E2E8F0;--tx2:#94A3B8;--tx3:#4A5568;
    --mono:'DM Mono',monospace;--ui:'Outfit',sans-serif;--disp:'Syne',sans-serif;}
    *{box-sizing:border-box;margin:0;padding:0;}
    body{background:var(--bg);color:var(--tx);font-family:var(--ui);overflow-x:hidden;}
    ::-webkit-scrollbar{width:4px;height:4px;}
    ::-webkit-scrollbar-track{background:var(--s1);}
    ::-webkit-scrollbar-thumb{background:var(--b2);border-radius:2px;}
    @keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
    @keyframes slideDown{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}
    @keyframes syncProgress{0%{transform:translateX(-150%)}100%{transform:translateX(350%)}}
    .fade{animation:fadeIn .3s ease both}
    .card{background:var(--s1);border:1px solid var(--b1);border-radius:10px;transition:border-color .2s}
    .card:hover{border-color:var(--b2)}
    .btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:7px;
      font-family:var(--ui);font-size:13px;font-weight:500;cursor:pointer;border:none;
      transition:all .15s;white-space:nowrap;text-decoration:none;}
    .btn-primary{background:var(--ac);color:#fff}.btn-primary:hover{background:#2563EB}
    .btn-ghost{background:transparent;color:var(--tx2);border:1px solid var(--b2)}
    .btn-ghost:hover{background:var(--s2);color:var(--tx)}
    .btn-teal{background:rgba(20,184,166,.15);color:var(--teal);border:1px solid rgba(20,184,166,.25)}
    .btn-red{background:rgba(239,68,68,.1);color:var(--red);border:1px solid rgba(239,68,68,.2)}
    .btn-green{background:rgba(34,197,94,.1);color:var(--grn);border:1px solid rgba(34,197,94,.2)}
    .btn-amazon{background:linear-gradient(135deg,#FF9900,#FFB700);color:#111;font-weight:700}
    .btn-amazon:hover{background:linear-gradient(135deg,#FF8C00,#FFA500)}
    input,select,textarea{background:var(--s2);border:1px solid var(--b2);color:var(--tx);
      border-radius:7px;padding:7px 12px;font-family:var(--ui);font-size:13px;outline:none;
      transition:border-color .2s;}
    input:focus,select:focus{border-color:var(--ac)}
    table{border-collapse:collapse;width:100%}
    th{text-align:left;padding:10px 12px;font-size:11px;font-weight:600;letter-spacing:.06em;
      text-transform:uppercase;color:var(--tx3);border-bottom:1px solid var(--b1);font-family:var(--mono)}
    td{padding:10px 12px;font-size:13px;border-bottom:1px solid var(--b1)}
    tr:last-child td{border-bottom:none}
    tr:hover td{background:rgba(255,255,255,.02)}
    .badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:100px;
      font-size:11px;font-weight:500;font-family:var(--mono)}
    .bg-grn{background:rgba(34,197,94,.12);color:var(--grn)}
    .bg-red{background:rgba(239,68,68,.12);color:var(--red)}
    .bg-amb{background:rgba(245,158,11,.12);color:var(--amb)}
    .bg-bl{background:rgba(59,130,246,.12);color:var(--ac2)}
    .bg-pur{background:rgba(167,139,250,.12);color:var(--pur)}
    .tag{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:100px;font-size:11px;font-weight:500}
    .tag-on{background:rgba(34,197,94,.1);color:#4ade80}
    .tag-pause{background:rgba(245,158,11,.1);color:var(--amb)}
    .tag-arch{background:rgba(100,116,139,.1);color:#64748b}
    .mono{font-family:var(--mono)}
    .spin{animation:spin .7s linear infinite}
    .num{font-family:var(--mono);font-size:13px}
    .loader{width:14px;height:14px;border:2px solid rgba(255,255,255,.2);
      border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;display:inline-block}
  `}</style>
);

// ─── Config ───────────────────────────────────────────────────────────────────
const API = (import.meta?.env?.VITE_API_URL) || "http://localhost:4000/api/v1";

// ─── API client ───────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const token = localStorage.getItem("af_token");
  const wsId = localStorage.getItem("af_workspace");
  const headers = { "Content-Type": "application/json", ...opts.headers };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (wsId) headers["x-workspace-id"] = wsId;

  const res = await fetch(`${API}${path}`, { ...opts, headers });
  if (res.status === 401) {
    localStorage.removeItem("af_token");
    window.location.reload();
    return;
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const get = (p, q) => {
  if (q) {
    // Strip undefined/null/empty values so they don't appear as "?key=undefined" in the URL
    const clean = Object.fromEntries(
      Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== "")
    );
    const qs = new URLSearchParams(clean).toString();
    return apiFetch(p + (qs ? "?" + qs : ""));
  }
  return apiFetch(p);
};
const post = (p, b) => apiFetch(p, { method: "POST", body: JSON.stringify(b) });
const patch = (p, b) => apiFetch(p, { method: "PATCH", body: JSON.stringify(b) });
const del = (p) => apiFetch(p, { method: "DELETE" });

// ─── Hooks ────────────────────────────────────────────────────────────────────
function useAsync(fn, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const load = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: null }));
    try {
      const data = await fn();
      setState({ data, loading: false, error: null });
    } catch (e) {
      setState({ data: null, loading: false, error: e.message });
    }
  }, deps);
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}

// ─── Micro-chart ──────────────────────────────────────────────────────────────
const Spark = ({ data = [], color = "#3B82F6", h = 36 }) => {
  if (!data.length) return <div style={{ height: h }} />;
  const w = 100, max = Math.max(...data), min = Math.min(...data), rng = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / rng) * (h - 4) - 2}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: h }} preserveAspectRatio="none">
      <defs><linearGradient id={`g${color.replace("#","")}`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={color} stopOpacity=".25" />
        <stop offset="100%" stopColor={color} stopOpacity="0" />
      </linearGradient></defs>
      <polygon points={`0,${h} ${pts} ${w},${h}`} fill={`url(#g${color.replace("#","")})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
};

// ─── KPI Card ─────────────────────────────────────────────────────────────────
const KPICard = ({ label, value, delta, color, spark, prefix = "", suffix = "", loading }) => (
  <div className="card fade" style={{ padding: "18px 20px" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
      <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--tx3)", fontFamily: "var(--mono)" }}>{label}</span>
      {delta != null && (
        <span className={`badge ${parseFloat(delta) >= 0 ? "bg-grn" : "bg-red"}`}>
          {parseFloat(delta) >= 0 ? "▲" : "▼"} {Math.abs(delta)}%
        </span>
      )}
    </div>
    {loading
      ? <div style={{ height: 32, background: "var(--s3)", borderRadius: 6, animation: "pulse 1.5s infinite" }} />
      : <div style={{ fontFamily: "var(--mono)", fontSize: 26, fontWeight: 500, color, letterSpacing: "-.5px", marginBottom: 6 }}>
          {prefix}{value}{suffix}
        </div>
    }
    <Spark data={spark || []} color={color} />
  </div>
);

// ─── Sidebar ──────────────────────────────────────────────────────────────────
const NAV = [
  { id: "overview", icon: "⬡" },
  { id: "campaigns", icon: "◈" },
  { id: "keywords", icon: "◇" },
  { id: "reports", icon: "≋" },
  { id: "rules", icon: "⟁" },
  { id: "alerts", icon: "◎" },
  { id: "ai", icon: "✦" },
  { id: "audit", icon: "⊡" },
  { id: "connect", icon: "⊕" },
  { id: "settings", icon: "⊛" },
];

const Sidebar = ({ active, setActive, user, workspace }) => {
  const { t } = useI18n();
  return (
    <aside style={{
      width: 220, minHeight: "100vh", background: "var(--s1)", borderRight: "1px solid var(--b1)",
      display: "flex", flexDirection: "column", position: "fixed", left: 0, top: 0, bottom: 0, zIndex: 100
    }}>
      <div style={{ padding: "20px 20px 14px", borderBottom: "1px solid var(--b1)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 32, height: 32, background: "linear-gradient(135deg,#3B82F6,#A78BFA)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>⬡</div>
          <div>
            <div style={{ fontFamily: "var(--disp)", fontWeight: 700, fontSize: 15 }}>AdsFlow</div>
            <div style={{ fontSize: 10, color: "var(--tx3)", fontFamily: "var(--mono)" }}>Amazon Ads</div>
          </div>
        </div>
      </div>

      {workspace && (
        <div style={{ padding: "10px 12px", margin: "8px 10px", background: "var(--s2)", borderRadius: 8, border: "1px solid var(--b1)" }}>
          <div style={{ fontSize: 9, color: "var(--tx3)", fontFamily: "var(--mono)", marginBottom: 3, letterSpacing: ".06em" }}>{t("common.workspace")}</div>
          <div style={{ fontSize: 12, fontWeight: 500 }}>{workspace.name}</div>
        </div>
      )}

      <nav style={{ flex: 1, padding: "6px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
        {NAV.map(({ id, icon }) => (
          <button key={id} onClick={() => setActive(id)} style={{
            display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 7,
            background: active === id ? "var(--s3)" : "transparent",
            border: active === id ? "1px solid var(--b2)" : "1px solid transparent",
            color: active === id ? "var(--tx)" : "var(--tx2)",
            cursor: "pointer", fontSize: 13, fontFamily: "var(--ui)", width: "100%", textAlign: "left",
            transition: "all .15s", position: "relative"
          }}>
            <span style={{ fontSize: 14, width: 18, textAlign: "center", color: active === id ? "var(--ac2)" : "var(--tx3)" }}>{icon}</span>
            {t("nav." + id)}
            {active === id && <span style={{ position: "absolute", right: 0, top: "50%", transform: "translateY(-50%)", width: 3, height: 18, background: "var(--ac)", borderRadius: "2px 0 0 2px" }} />}
          </button>
        ))}
      </nav>

      <div style={{ padding: "12px 14px", borderTop: "1px solid var(--b1)", display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 28, height: 28, borderRadius: "50%", background: "linear-gradient(135deg,#3B82F6,#8B5CF6)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 600, color: "#fff" }}>
          {user?.name?.slice(0, 2).toUpperCase() || "??"}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 500 }}>{user?.name || "—"}</div>
          <div style={{ fontSize: 10, color: "var(--tx3)", fontFamily: "var(--mono)" }}>{user?.role || ""}</div>
        </div>
        <LanguageSwitcher />
      </div>
    </aside>
  );
};

// ─── Connect / OAuth Page ─────────────────────────────────────────────────────
const ConnectPage = ({ workspaceId, onConnected, onSyncStarted }) => {
  const { t } = useI18n();
  const [step, setStep] = useState("list"); // list, connecting, profiles, done
  const [connections, setConnections] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [currentConnection, setCurrentConnection] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [region, setRegion] = useState("EU"); // NA, EU, FE
  const [rowState, setRowState] = useState({}); // { [id]: { loading: 'reconnect'|'sync'|null, error: null|string, success: null|'reconnect'|'sync' } }

  const REGIONS = [
    { value: "NA", label: "🇺🇸 North America", desc: "US, Canada, Mexico" },
    { value: "EU", label: "🇪🇺 Europe", desc: "DE, UK, FR, IT, ES, NL..." },
    { value: "FE", label: "🌏 Far East", desc: "Japan, Australia, India" },
  ];

  // Load existing connections
  useEffect(() => {
    get("/connections").then(setConnections).catch(() => {});
  }, []);

  // Handle OAuth callback from URL params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    if (code && state) {
      window.history.replaceState({}, "", window.location.pathname);
      handleCallback(code, state);
    }
  }, []);

  async function startConnect() {
    setLoading(true); setError(null);
    try {
      const { url, state } = await get(`/connections/amazon/init?region=${region}`);
      localStorage.setItem("af_oauth_state", state);
      localStorage.setItem("af_oauth_region", region);
      window.location.href = url;
    } catch (e) {
      setError(e.message);
      setLoading(false);
    }
  }

  async function handleCallback(code, state) {
    setStep("connecting"); setLoading(true); setError(null);
    const savedState = localStorage.getItem("af_oauth_state");
    localStorage.removeItem("af_oauth_state");

    if (state !== savedState) {
      setError("Security validation failed. Please try again."); // technical message, keep en
      setStep("list"); setLoading(false);
      return;
    }

    try {
      const result = await post("/connections/amazon/callback", { code, state, workspaceId });
      setCurrentConnection(result.connection.id);
      setProfiles(result.profiles);
      setStep("profiles");
    } catch (e) {
      setError(e.message);
      setStep("list");
    }
    setLoading(false);
  }

  async function attachProfiles() {
    if (!selected.size) return;
    setLoading(true); setError(null);
    try {
      const result = await post(`/connections/${currentConnection}/profiles/attach`, {
        profileIds: Array.from(selected),
        workspaceId,
      });
      setMsg(result.message);
      setStep("done");
      onConnected?.();
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }

  async function revokeConnection(id) {
    if (!confirm(t("connect.disconnectConfirm"))) return;
    await del(`/connections/${id}`);
    setConnections(c => c.filter(x => x.id !== id));
  }

  function setRow(id, patch) {
    setRowState(s => ({ ...s, [id]: { ...s[id], ...patch } }));
  }

  async function reconnectConnection(id) {
    setRow(id, { loading: "reconnect", error: null, success: null });
    try {
      await post(`/connections/${id}/reconnect`, {});
      setRow(id, { loading: null, error: null, success: "reconnect" });
      get("/connections").then(setConnections).catch(() => {});
      onSyncStarted?.();
      setTimeout(() => setRow(id, { success: null }), 2500);
    } catch (e) {
      setRow(id, { loading: null, error: e.message, success: null });
    }
  }

  async function forceSyncConnection(id) {
    setRow(id, { loading: "sync", error: null, success: null });
    try {
      await post(`/connections/${id}/sync`, {});
      setRow(id, { loading: null, error: null, success: "sync" });
      onSyncStarted?.();
      setTimeout(() => setRow(id, { success: null }), 2500);
    } catch (e) {
      setRow(id, { loading: null, error: e.message, success: null });
    }
  }

  const [backfillState, setBackfillState] = useState({ loading: false, success: false, error: null });

  async function triggerMetricsBackfill() {
    setBackfillState({ loading: true, success: false, error: null });
    try {
      await post("/metrics/backfill", {});
      setBackfillState({ loading: false, success: true, error: null });
      setTimeout(() => setBackfillState({ loading: false, success: false, error: null }), 4000);
    } catch (e) {
      setBackfillState({ loading: false, success: false, error: e.message });
    }
  }

  return (
    <div className="fade">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: "var(--disp)", fontSize: 22, fontWeight: 700, marginBottom: 4 }}>{t("connect.title")}</h1>
          <div style={{ fontSize: 13, color: "var(--tx2)" }}>{t("connect.subtitle")}</div>
        </div>
        {connections.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
            <button
              className="btn btn-primary"
              disabled={backfillState.loading}
              onClick={triggerMetricsBackfill}
              title={t("metrics.backfillDesc")}
              style={{ fontSize: 13, whiteSpace: "nowrap" }}
            >
              {backfillState.loading
                ? <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 12, height: 12, border: "2px solid rgba(255,255,255,.3)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin .7s linear infinite", display: "inline-block" }} />
                    {t("metrics.backfill")}
                  </span>
                : t("metrics.backfill")}
            </button>
            {backfillState.success && (
              <div style={{ fontSize: 12, color: "var(--teal)" }}>✓ {t("metrics.backfillStarted")}</div>
            )}
            {backfillState.error && (
              <div style={{ fontSize: 12, color: "var(--red)" }}>{t("metrics.backfillError")}{backfillState.error}</div>
            )}
          </div>
        )}
      </div>

      {error && (
        <div style={{ marginBottom: 16, padding: "12px 16px", background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.2)", borderRadius: 8, color: "var(--red)", fontSize: 13 }}>
          ⚠ {error}
        </div>
      )}

      {/* Step: List */}
      {step === "list" && (
        <>
          {connections.length > 0 && (
            <div className="card" style={{ marginBottom: 20, overflow: "hidden" }}>
              <table>
                <thead><tr><th>{t("connect.colAccount")}</th><th>{t("connect.colProfiles")}</th><th>{t("connect.colStatus")}</th><th>{t("connect.colUpdated")}</th><th></th></tr></thead>
                <tbody>
                  {connections.map(c => {
                    const rs = rowState[c.id] || {};
                    const isReconnecting = rs.loading === "reconnect";
                    const isSyncing = rs.loading === "sync";
                    const rowBg = rs.success === "reconnect"
                      ? "rgba(59,130,246,.07)"
                      : rs.success === "sync"
                      ? "rgba(20,184,166,.07)"
                      : undefined;
                    return (
                      <tr key={c.id} style={{ background: rowBg, transition: "background .4s" }}>
                        <td><span className="mono" style={{ fontSize: 11, color: "var(--tx2)" }}>{c.id.slice(0, 8)}…</span> {c.amazon_email || ""}</td>
                        <td className="num">{c.profile_count}</td>
                        <td><span className={`badge ${c.status === "active" ? "bg-grn" : "bg-red"}`}>● {c.status}</span></td>
                        <td style={{ color: "var(--tx3)", fontSize: 12 }}>{c.last_refresh_at ? new Date(c.last_refresh_at).toLocaleString("ru") : "—"}</td>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                            {/* Reconnect button */}
                            <button
                              title={t("connections.reconnect")}
                              disabled={!!rs.loading}
                              onClick={() => reconnectConnection(c.id)}
                              style={{
                                width: 28, height: 28, padding: 0, borderRadius: 6,
                                display: "inline-flex", alignItems: "center", justifyContent: "center",
                                background: "rgba(59,130,246,.1)", color: "var(--ac2)",
                                border: "1px solid rgba(59,130,246,.2)",
                                cursor: rs.loading ? "not-allowed" : "pointer",
                                opacity: rs.loading ? .5 : 1, fontSize: 14, transition: "all .15s",
                              }}
                            >
                              {isReconnecting
                                ? <span style={{ width: 10, height: 10, border: "2px solid rgba(96,165,250,.3)", borderTopColor: "var(--ac2)", borderRadius: "50%", animation: "spin .7s linear infinite", display: "inline-block" }} />
                                : "↻"}
                            </button>
                            {/* Force sync button */}
                            <button
                              title={t("connections.forceSync")}
                              disabled={!!rs.loading}
                              onClick={() => forceSyncConnection(c.id)}
                              style={{
                                width: 28, height: 28, padding: 0, borderRadius: 6,
                                display: "inline-flex", alignItems: "center", justifyContent: "center",
                                background: "rgba(20,184,166,.1)", color: "var(--teal)",
                                border: "1px solid rgba(20,184,166,.2)",
                                cursor: rs.loading ? "not-allowed" : "pointer",
                                opacity: rs.loading ? .5 : 1, fontSize: 13, transition: "all .15s",
                              }}
                            >
                              {isSyncing
                                ? <span style={{ width: 10, height: 10, border: "2px solid rgba(20,184,166,.3)", borderTopColor: "var(--teal)", borderRadius: "50%", animation: "spin .7s linear infinite", display: "inline-block" }} />
                                : "⬇"}
                            </button>
                            {/* Disconnect button */}
                            <button className="btn btn-red" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => revokeConnection(c.id)}>{t("connect.disconnect")}</button>
                          </div>
                          {rs.error && (
                            <div style={{ fontSize: 11, color: "var(--red)", marginTop: 5, maxWidth: 240 }}>
                              {t("connections.reconnectError")}{rs.error}
                            </div>
                          )}
                          {rs.success && (
                            <div style={{ fontSize: 11, color: rs.success === "reconnect" ? "var(--ac2)" : "var(--teal)", marginTop: 5 }}>
                              {rs.success === "reconnect" ? t("connections.reconnectSuccess") : t("connections.syncStarted")}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="card" style={{ padding: "40px 32px", textAlign: "center", border: "1px dashed var(--b2)" }}>
            <div style={{ fontSize: 40, marginBottom: 16 }}>⬡</div>
            <div style={{ fontFamily: "var(--disp)", fontSize: 18, fontWeight: 700, marginBottom: 8 }}>{t("connect.connectTitle")}</div>
            <div style={{ fontSize: 13, color: "var(--tx2)", marginBottom: 24, maxWidth: 400, margin: "0 auto 24px" }}>
              {t("connect.connectDesc")}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center", maxWidth: 360, margin: "0 auto" }}>
              {/* Region selector */}
              <div style={{ width: "100%", marginBottom: 8 }}>
                <div style={{ fontSize: 12, color: "var(--tx2)", marginBottom: 8, fontWeight: 600 }}>{t("connect.selectRegion")}</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                  {REGIONS.map(r => (
                    <div key={r.value}
                      onClick={() => setRegion(r.value)}
                      style={{
                        padding: "10px 8px", borderRadius: 8, cursor: "pointer", textAlign: "center",
                        border: `2px solid ${region === r.value ? "var(--ac)" : "var(--b2)"}`,
                        background: region === r.value ? "rgba(59,130,246,.08)" : "var(--s2)",
                        transition: "all .15s"
                      }}>
                      <div style={{ fontSize: 16, marginBottom: 2 }}>{r.label.split(" ")[0]}</div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: region === r.value ? "var(--ac)" : "var(--tx1)" }}>{r.value}</div>
                      <div style={{ fontSize: 10, color: "var(--tx3)", marginTop: 2 }}>{r.desc}</div>
                    </div>
                  ))}
                </div>
              </div>

              <button className="btn btn-amazon" style={{ width: "100%", justifyContent: "center", padding: "12px 20px", fontSize: 14 }}
                onClick={startConnect} disabled={loading}>
                {loading ? <span className="loader" style={{ borderTopColor: "#111" }} /> : "🛍"} {t("connect.connectBtn")}
              </button>

              <div style={{ fontSize: 11, color: "var(--tx3)", textAlign: "center", lineHeight: 1.5 }}>
                {t("connect.redirectNote").split("\n").map((line, i) => <span key={i}>{line}{i === 0 && <br/>}</span>)}
              </div>
            </div>

            <div style={{ marginTop: 28, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, maxWidth: 500, margin: "28px auto 0" }}>
              {[
                { icon: "🔒", labelKey: "connect.secure", descKey: "connect.secureDesc" },
                { icon: "⚡", labelKey: "connect.fast", descKey: "connect.fastDesc" },
                { icon: "♻", labelKey: "connect.autoSync", descKey: "connect.autoSyncDesc" },
              ].map(({ icon, labelKey, descKey }) => (
                <div key={labelKey} style={{ padding: "14px", background: "var(--s2)", borderRadius: 8, border: "1px solid var(--b1)" }}>
                  <div style={{ fontSize: 20, marginBottom: 6 }}>{icon}</div>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 3 }}>{t(labelKey)}</div>
                  <div style={{ fontSize: 11, color: "var(--tx3)" }}>{t(descKey)}</div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Step: Connecting */}
      {step === "connecting" && (
        <div className="card fade" style={{ padding: "60px 32px", textAlign: "center" }}>
          <div className="loader" style={{ width: 32, height: 32, margin: "0 auto 16px" }} />
          <div style={{ fontFamily: "var(--disp)", fontSize: 16, fontWeight: 600, marginBottom: 8 }}>{t("connect.exchangingTokens")}</div>
          <div style={{ fontSize: 13, color: "var(--tx2)" }}>{t("connect.securingConnection")}</div>
        </div>
      )}

      {/* Step: Select Profiles */}
      {step === "profiles" && (
        <div className="fade">
          <div className="card" style={{ marginBottom: 16, padding: "16px 20px", borderColor: "rgba(34,197,94,.2)" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span style={{ fontSize: 20 }}>✓</span>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>{t("connect.accountConnected")}</div>
                <div style={{ fontSize: 12, color: "var(--tx2)" }}>{t("connect.profilesFound", { count: profiles.length })}</div>
              </div>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
            {profiles.map(p => (
              <div key={p.id} className="card" style={{ padding: "14px 18px", cursor: "pointer", borderColor: selected.has(p.id) ? "var(--ac)" : undefined }}
                onClick={() => {
                  const s = new Set(selected);
                  s.has(p.id) ? s.delete(p.id) : s.add(p.id);
                  setSelected(s);
                }}>
                <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                  <input type="checkbox" checked={selected.has(p.id)} readOnly style={{ width: 16, height: 16 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, marginBottom: 3 }}>
                      {p.accountName || `Profile ${p.profileId}`}
                      <span className="badge bg-bl" style={{ marginLeft: 8 }}>{p.marketplace}</span>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--tx3)", fontFamily: "var(--mono)" }}>
                      ID: {p.profileId} · {p.accountType || "advertiser"} · {p.currencyCode}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-primary" onClick={attachProfiles} disabled={!selected.size || loading}>
              {loading ? <span className="loader" /> : null}
              {t("connect.attachSelected", { count: selected.size })}
            </button>
            <button className="btn btn-ghost" onClick={() => { setStep("list"); }}>{t("common.cancel")}</button>
          </div>
        </div>
      )}

      {/* Step: Done */}
      {step === "done" && (
        <div className="card fade" style={{ padding: "40px 32px", textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🎉</div>
          <div style={{ fontFamily: "var(--disp)", fontSize: 18, fontWeight: 700, marginBottom: 8 }}>{t("connect.done")}</div>
          <div style={{ fontSize: 13, color: "var(--tx2)", marginBottom: 20 }}>{msg}</div>
          <button className="btn btn-primary" onClick={() => setStep("list")}>{t("connect.toConnections")}</button>
        </div>
      )}
    </div>
  );
};

// ─── Overview Page (real data) ────────────────────────────────────────────────
const OverviewPage = ({ workspaceId }) => {
  const { t } = useI18n();
  const [range, setRange] = useState("7");
  const endDate = new Date().toISOString().split("T")[0];
  const startDate = new Date(Date.now() - parseInt(range) * 86400000).toISOString().split("T")[0];

  const { data: summary, loading: sl } = useAsync(
    () => workspaceId ? get("/metrics/summary", { startDate, endDate, workspaceId }) : Promise.resolve(null),
    [workspaceId, range]
  );

  const { data: topCampaigns, loading: tl } = useAsync(
    () => workspaceId ? get("/metrics/top-campaigns", { startDate, endDate, limit: 5 }) : Promise.resolve([]),
    [workspaceId, range]
  );

  const { data: profiles } = useAsync(
    () => workspaceId ? get("/profiles", { workspaceId }) : Promise.resolve([]),
    [workspaceId]
  );

  const hasData = summary?.totals;
  const totals = summary?.totals || {};
  const d = summary?.deltas || {};
  const trend = summary?.trend || [];

  const kpis = [
    { label: t("overview.kpiSpend"), value: hasData ? `$${parseFloat(totals.spend).toLocaleString("en", { maximumFractionDigits: 0 })}` : "—", delta: d.spend, color: "#60A5FA" },
    { label: t("overview.kpiSales"), value: hasData ? `$${parseFloat(totals.sales).toLocaleString("en", { maximumFractionDigits: 0 })}` : "—", delta: d.sales, color: "#22C55E" },
    { label: "ACOS", value: hasData ? `${parseFloat(totals.acos).toFixed(1)}%` : "—", delta: d.acos, color: "#F59E0B" },
    { label: "ROAS", value: hasData ? `${parseFloat(totals.roas).toFixed(2)}×` : "—", delta: d.roas, color: "#A78BFA" },
    { label: t("overview.kpiClicks"), value: hasData ? parseInt(totals.clicks).toLocaleString() : "—", delta: null, color: "#14B8A6" },
    { label: t("overview.kpiImpressions"), value: hasData ? (parseInt(totals.impressions) / 1000).toFixed(0) + "K" : "—", delta: null, color: "#F472B6" },
  ];

  const spendTrend = trend.map(r => parseFloat(r.spend));

  const activeProfiles = profiles?.filter(p => p.sync_status === "synced") || [];

  return (
    <div className="fade">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }}>
        <div>
          <h1 style={{ fontFamily: "var(--disp)", fontSize: 22, fontWeight: 700, marginBottom: 4 }}>{t("overview.title")}</h1>
          <div style={{ fontSize: 13, color: "var(--tx2)" }}>
            {activeProfiles.length > 0
              ? t("overview.profilesSynced", { count: activeProfiles.length })
              : <span style={{ color: "var(--amb)" }}>{t("overview.noProfilesWarning")}<span style={{ color: "var(--ac2)", cursor: "pointer" }} onClick={() => {}}>{t("overview.connectAmazon")}</span></span>
            }
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {["7", "14", "30"].map(d => (
            <button key={d} onClick={() => setRange(d)} className={`btn ${range === d ? "btn-primary" : "btn-ghost"}`} style={{ fontSize: 12, padding: "5px 12px" }}>
              {d}d
            </button>
          ))}
        </div>
      </div>

      {!hasData && !sl && (
        <div style={{ marginBottom: 16, padding: "14px 18px", background: "rgba(59,130,246,.06)", border: "1px solid rgba(59,130,246,.15)", borderRadius: 8, fontSize: 13 }}>
          <strong style={{ color: "var(--ac2)" }}>{t("overview.noData")}</strong>{" "}
          <span style={{ color: "var(--tx2)" }}>{t("overview.noDataDesc")}</span>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
        {kpis.map((k, i) => (
          <KPICard key={i} {...k} loading={sl} spark={i === 0 ? spendTrend : []} />
        ))}
      </div>

      {/* Spend trend chart */}
      {trend.length > 0 && (
        <div className="card" style={{ padding: "18px 20px", marginBottom: 16 }}>
          <div style={{ fontFamily: "var(--disp)", fontSize: 14, fontWeight: 600, marginBottom: 14 }}>{t("overview.spendByDay")}</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 64 }}>
            {trend.map((r, i) => {
              const max = Math.max(...trend.map(x => parseFloat(x.spend)));
              const h = max > 0 ? Math.max((parseFloat(r.spend) / max) * 56, 3) : 3;
              return (
                <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }} title={`$${parseFloat(r.spend).toFixed(0)}`}>
                  <div style={{ width: "100%", height: h, background: "linear-gradient(to top, #3B82F6, #60A5FA88)", borderRadius: "3px 3px 0 0" }} />
                  <span style={{ fontSize: 9, color: "var(--tx3)", fontFamily: "var(--mono)" }}>
                    {new Date(r.date).toLocaleDateString("en", { weekday: "short" }).slice(0, 2)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Top Campaigns */}
      {(topCampaigns?.length > 0) && (
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ padding: "14px 18px 10px", fontFamily: "var(--disp)", fontSize: 14, fontWeight: 600 }}>{t("overview.topCampaigns")}</div>
          <table>
            <thead><tr><th>{t("overview.colCampaign")}</th><th>{t("overview.colType")}</th><th style={{ textAlign: "right" }}>Spend</th><th style={{ textAlign: "right" }}>Sales</th><th style={{ textAlign: "right" }}>ACOS</th><th style={{ textAlign: "right" }}>ROAS</th></tr></thead>
            <tbody>
              {topCampaigns.map(c => (
                <tr key={c.id}>
                  <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</td>
                  <td><span className="badge bg-bl" style={{ fontSize: 10 }}>{c.campaign_type?.replace("sponsored", "").toUpperCase().slice(0, 2)}</span></td>
                  <td className="num" style={{ textAlign: "right", color: "var(--ac2)" }}>${parseFloat(c.spend).toFixed(0)}</td>
                  <td className="num" style={{ textAlign: "right", color: "var(--grn)" }}>${parseFloat(c.sales).toFixed(0)}</td>
                  <td className="num" style={{ textAlign: "right", color: parseFloat(c.acos) > 20 ? "var(--red)" : "var(--grn)" }}>
                    {parseFloat(c.acos).toFixed(1)}%
                  </td>
                  <td className="num" style={{ textAlign: "right", color: "var(--pur)" }}>{parseFloat(c.roas).toFixed(2)}×</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

// ─── SortHeader — reusable sortable column header ─────────────────────────────
const SortHeader = ({ field, label, currentSort, currentDir, onSort, align = "left" }) => {
  const active = currentSort === field;
  return (
    <th
      onClick={() => onSort(field)}
      style={{
        cursor: "pointer",
        userSelect: "none",
        textAlign: align,
        whiteSpace: "nowrap",
        color: active ? "var(--ac2)" : "var(--tx2)",
      }}
    >
      {label}{" "}
      <span style={{ fontSize: 10, opacity: active ? 1 : 0.3 }}>
        {active ? (currentDir === "asc" ? "↑" : "↓") : "↕"}
      </span>
    </th>
  );
};

// ─── Campaigns Page (real data) ───────────────────────────────────────────────
const CampaignsPage = ({ workspaceId }) => {
  const { t } = useI18n();
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("spend");
  const [sortDir, setSortDir] = useState("desc");
  const [editId, setEditId] = useState(null);
  const [editState, setEditState] = useState(null);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [showBudgetModal, setShowBudgetModal] = useState(false);
  const [budgetPct, setBudgetPct] = useState("");

  function handleCampSort(field) {
    const isText = ["name", "state"].includes(field);
    if (sortBy === field) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortBy(field); setSortDir(isText ? "asc" : "desc"); }
  }

  const { data, loading, reload } = useAsync(
    () => {
      if (!workspaceId) return Promise.resolve({ data: [], pagination: {} });
      const params = { limit: 100, sortBy, sortDir };
      if (filter && filter !== "all") params.status = filter;
      if (search && search.trim()) params.search = search.trim();
      return get("/campaigns", params);
    },
    [workspaceId, filter, search, sortBy, sortDir]
  );

  const campaigns = data?.data || [];

  async function updateCampaign(id, updates) {
    setSaving(true);
    try {
      await patch(`/campaigns/${id}`, updates);
      reload();
      setEditId(null);
    } catch (e) {
      alert(t("campaigns.errorUpdate") + e.message);
    }
    setSaving(false);
  }

  async function bulkStatus(state) {
    setSaving(true);
    try {
      await post("/bulk/campaigns/status", { ids: Array.from(selected), state });
      reload();
      setSelected(new Set());
    } catch (e) { alert(t("campaigns.errorUpdate") + e.message); }
    setSaving(false);
  }

  async function bulkBudget() {
    if (!budgetPct) return;
    setSaving(true);
    try {
      await post("/bulk/campaigns/budget", { ids: Array.from(selected), adjustPct: parseFloat(budgetPct) });
      reload();
      setSelected(new Set());
      setShowBudgetModal(false);
      setBudgetPct("");
    } catch (e) { alert(t("campaigns.errorUpdate") + e.message); }
    setSaving(false);
  }

  function toggleSelect(id) {
    const s = new Set(selected);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelected(s);
  }

  function toggleAll() {
    selected.size === campaigns.length ? setSelected(new Set()) : setSelected(new Set(campaigns.map(c => c.id)));
  }

  const typeLabel = ct => ({ sponsoredProducts: "SP", sponsoredBrands: "SB", sponsoredDisplay: "SD" })[ct] || ct;

  return (
    <div className="fade">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <div>
          <h1 style={{ fontFamily: "var(--disp)", fontSize: 22, fontWeight: 700, marginBottom: 4 }}>{t("campaigns.title")}</h1>
          <div style={{ fontSize: 13, color: "var(--tx2)" }}>{t("campaigns.count", { count: data?.pagination?.total ?? "—" })}</div>
        </div>
        <button className="btn btn-primary">{t("campaigns.newCampaign")}</button>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <input placeholder={t("campaigns.searchPlaceholder")} value={search} onChange={e => setSearch(e.target.value)} style={{ width: 200 }} />
        {["all", "enabled", "paused", "archived"].map(f => (
          <button key={f} onClick={() => setFilter(f)} className={`btn ${filter === f ? "btn-primary" : "btn-ghost"}`} style={{ fontSize: 12, padding: "5px 12px" }}>
            {f === "all" ? t("common.all") : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        <button className="btn btn-ghost" style={{ fontSize: 12, marginLeft: "auto" }} onClick={reload}>↺ {t("common.refresh")}</button>
      </div>

      {selected.size > 0 && (
        <div className="card fade" style={{ padding: "10px 16px", marginBottom: 12, display: "flex", gap: 10, alignItems: "center", borderColor: "rgba(59,130,246,.4)", background: "rgba(59,130,246,.05)" }}>
          <span style={{ fontSize: 13, color: "var(--ac2)", fontWeight: 500 }}>{t("campaigns.selected", { count: selected.size })}</span>
          <button className="btn btn-ghost" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => bulkStatus("paused")} disabled={saving}>{t("campaigns.bulkPause")}</button>
          <button className="btn btn-ghost" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => bulkStatus("enabled")} disabled={saving}>{t("campaigns.bulkEnable")}</button>
          <button className="btn btn-ghost" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => bulkStatus("archived")} disabled={saving}>{t("campaigns.bulkArchive")}</button>
          <button className="btn btn-teal" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setShowBudgetModal(true)}>{t("campaigns.bulkBudget")}</button>
          <button className="btn btn-ghost" style={{ fontSize: 12, padding: "5px 12px", marginLeft: "auto" }} onClick={() => setSelected(new Set())}>{t("common.cancel")}</button>
        </div>
      )}

      <div className="card" style={{ overflow: "hidden" }}>
        {loading
          ? <div style={{ padding: "40px", textAlign: "center", color: "var(--tx3)" }}><span className="loader" style={{ width: 20, height: 20 }} /></div>
          : campaigns.length === 0
            ? <div style={{ padding: "40px", textAlign: "center", color: "var(--tx3)" }}>{t("campaigns.noCampaigns")}</div>
            : (
              <div style={{ overflowX: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}>
                        <input type="checkbox" checked={selected.size === campaigns.length && campaigns.length > 0} onChange={toggleAll} />
                      </th>
                      <SortHeader field="name"    label={t("campaigns.colName")}   currentSort={sortBy} currentDir={sortDir} onSort={handleCampSort} />
                      <th>{t("campaigns.colType")}</th>
                      <SortHeader field="state"   label={t("campaigns.colStatus")} currentSort={sortBy} currentDir={sortDir} onSort={handleCampSort} />
                      <SortHeader field="budget"  label={t("campaigns.colBudget")} currentSort={sortBy} currentDir={sortDir} onSort={handleCampSort} align="right" />
                      <SortHeader field="spend"   label="Spend"  currentSort={sortBy} currentDir={sortDir} onSort={handleCampSort} align="right" />
                      <SortHeader field="sales"   label="Sales"  currentSort={sortBy} currentDir={sortDir} onSort={handleCampSort} align="right" />
                      <SortHeader field="acos"    label="ACOS"   currentSort={sortBy} currentDir={sortDir} onSort={handleCampSort} align="right" />
                      <SortHeader field="roas"    label="ROAS"   currentSort={sortBy} currentDir={sortDir} onSort={handleCampSort} align="right" />
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaigns.map(c => (
                      <tr key={c.id}>
                        <td><input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleSelect(c.id)} /></td>
                        <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>{c.name}</td>
                        <td><span className="badge bg-bl">{typeLabel(c.campaign_type)}</span></td>
                        <td>
                          {editId === c.id
                            ? (
                              <select value={editState} onChange={e => setEditState(e.target.value)} style={{ fontSize: 11, padding: "3px 6px" }}>
                                <option value="enabled">enabled</option>
                                <option value="paused">paused</option>
                                <option value="archived">archived</option>
                              </select>
                            )
                            : (
                              <span className={`tag ${c.state === "enabled" ? "tag-on" : c.state === "paused" ? "tag-pause" : "tag-arch"}`}>
                                <span style={{ width: 5, height: 5, borderRadius: "50%", background: "currentColor", display: "inline-block" }} />
                                {c.state}
                              </span>
                            )
                          }
                        </td>
                        <td className="num" style={{ textAlign: "right" }}>${parseFloat(c.daily_budget || 0).toFixed(0)}</td>
                        <td className="num" style={{ textAlign: "right", color: "var(--ac2)" }}>${parseFloat(c.spend || 0).toFixed(0)}</td>
                        <td className="num" style={{ textAlign: "right", color: "var(--grn)" }}>{c.sales > 0 ? `$${parseFloat(c.sales).toFixed(0)}` : "—"}</td>
                        <td className="num" style={{ textAlign: "right", color: c.acos > 20 ? "var(--red)" : c.acos > 0 ? "var(--grn)" : "var(--tx3)" }}>
                          {c.acos > 0 ? `${parseFloat(c.acos).toFixed(1)}%` : "—"}
                        </td>
                        <td className="num" style={{ textAlign: "right", color: "var(--pur)" }}>
                          {c.roas > 0 ? `${parseFloat(c.roas).toFixed(2)}×` : "—"}
                        </td>
                        <td>
                          {editId === c.id
                            ? (
                              <div style={{ display: "flex", gap: 4 }}>
                                <button className="btn btn-green" style={{ fontSize: 10, padding: "3px 8px" }}
                                  onClick={() => updateCampaign(c.id, { state: editState })} disabled={saving}>
                                  {saving ? "…" : "✓"}
                                </button>
                                <button className="btn btn-ghost" style={{ fontSize: 10, padding: "3px 8px" }} onClick={() => setEditId(null)}>✕</button>
                              </div>
                            )
                            : (
                              <button className="btn btn-ghost" style={{ fontSize: 11, padding: "4px 8px" }}
                                onClick={() => { setEditId(c.id); setEditState(c.state); }}>
                                {t("common.edit")}
                              </button>
                            )
                          }
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        }
      </div>

      {showBudgetModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div className="card fade" style={{ width: 360, padding: "24px 28px" }}>
            <div style={{ fontFamily: "var(--disp)", fontSize: 16, fontWeight: 700, marginBottom: 14 }}>{t("campaigns.bulkBudgetTitle")}</div>
            <div style={{ fontSize: 13, color: "var(--tx2)", marginBottom: 14 }}>{t("campaigns.bulkBudgetDesc", { count: selected.size })}</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 20 }}>
              <input type="number" value={budgetPct} onChange={e => setBudgetPct(e.target.value)} style={{ flex: 1 }} placeholder="+10 or -10" />
              <span style={{ color: "var(--tx2)" }}>%</span>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn btn-primary" onClick={bulkBudget} disabled={saving || !budgetPct}>
                {saving ? <span className="loader" /> : t("campaigns.bulkApply")}
              </button>
              <button className="btn btn-ghost" onClick={() => setShowBudgetModal(false)}>{t("common.cancel")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Reports Page ─────────────────────────────────────────────────────────────
const ReportsPage = ({ workspaceId }) => {
  const { t } = useI18n();
  const [form, setForm] = useState({ campaignType: "SP", reportLevel: "campaign", startDate: "", endDate: "" });
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(null);

  const { data: reports, loading, reload } = useAsync(
    () => workspaceId ? get("/reports") : Promise.resolve([]),
    [workspaceId]
  );

  const { data: profilesList } = useAsync(
    () => workspaceId ? get("/profiles", { workspaceId }) : Promise.resolve([]),
    [workspaceId]
  );

  async function submitReport() {
    if (!form.startDate || !form.endDate) return alert(t("reports.alertPeriod"));
    const profileId = profilesList?.[0]?.id;
    if (!profileId) return alert(t("reports.alertNoProfiles"));

    setSubmitting(true);
    try {
      const res = await post("/reports", { ...form, profileId });
      setSubmitted(res);
      reload();
    } catch (e) {
      alert(t("reports.alertError") + e.message);
    }
    setSubmitting(false);
  }

  return (
    <div className="fade">
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontFamily: "var(--disp)", fontSize: 22, fontWeight: 700, marginBottom: 4 }}>{t("reports.title")}</h1>
        <div style={{ fontSize: 13, color: "var(--tx2)" }}>{t("reports.subtitle")}</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: 16 }}>
        <div className="card" style={{ padding: "18px 20px", height: "fit-content" }}>
          <div style={{ fontFamily: "var(--disp)", fontSize: 14, fontWeight: 600, marginBottom: 16 }}>{t("reports.newReport")}</div>
          {[
            { label: "Ad Product", field: "campaignType", opts: ["SP", "SB", "SD"] },
            { label: "Report Level", field: "reportLevel", opts: ["campaign", "ad_group", "keyword"] },
          ].map(({ label, field, opts }) => (
            <div key={field} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10, color: "var(--tx3)", marginBottom: 6, fontFamily: "var(--mono)", letterSpacing: ".06em", textTransform: "uppercase" }}>{label}</div>
              <div style={{ display: "flex", gap: 6 }}>
                {opts.map(o => (
                  <button key={o} onClick={() => setForm(f => ({ ...f, [field]: o }))} className={`btn ${form[field] === o ? "btn-primary" : "btn-ghost"}`} style={{ fontSize: 11, padding: "4px 10px" }}>{o}</button>
                ))}
              </div>
            </div>
          ))}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, color: "var(--tx3)", marginBottom: 6, fontFamily: "var(--mono)", letterSpacing: ".06em", textTransform: "uppercase" }}>{t("reports.period")}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <input type="date" value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} style={{ flex: 1, fontSize: 12 }} />
              <input type="date" value={form.endDate} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} style={{ flex: 1, fontSize: 12 }} />
            </div>
          </div>
          <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center" }} onClick={submitReport} disabled={submitting}>
            {submitting ? <span className="loader" /> : t("reports.run")}
          </button>
          {submitted && <div style={{ marginTop: 10, fontSize: 12, color: "var(--teal)" }}>{t("reports.queued", { jobId: submitted.jobId?.slice(0, 8) })}</div>}
        </div>

        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ padding: "12px 16px 8px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontFamily: "var(--disp)", fontSize: 14, fontWeight: 600 }}>{t("reports.history")}</div>
            <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={reload}>↺</button>
          </div>
          {loading
            ? <div style={{ padding: 30, textAlign: "center" }}><span className="loader" /></div>
            : !reports?.length
              ? <div style={{ padding: "30px 20px", textAlign: "center", color: "var(--tx3)", fontSize: 13 }}>{t("reports.noReports")}</div>
              : (
                <table>
                  <thead><tr><th>{t("reports.colType")}</th><th>{t("reports.colPeriod")}</th><th>{t("reports.colStatus")}</th><th>{t("reports.colRows")}</th><th>{t("reports.colCreated")}</th></tr></thead>
                  <tbody>
                    {reports.map(r => (
                      <tr key={r.id}>
                        <td><span className="badge bg-bl">{r.campaign_type}</span> <span style={{ fontSize: 11, color: "var(--tx3)" }}>{r.report_type}</span></td>
                        <td className="num" style={{ fontSize: 11 }}>{r.date_start} → {r.date_end}</td>
                        <td>
                          <span className={`badge ${r.status === "completed" ? "bg-grn" : r.status === "failed" ? "bg-red" : "bg-amb"}`}>
                            {r.status}
                          </span>
                        </td>
                        <td className="num">{r.row_count ?? "—"}</td>
                        <td style={{ fontSize: 11, color: "var(--tx3)" }}>{new Date(r.created_at).toLocaleString("ru")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
          }
        </div>
      </div>
    </div>
  );
};

// ─── Audit Page ───────────────────────────────────────────────────────────────
const AuditPage = ({ workspaceId }) => {
  const { t } = useI18n();
  const [sortBy, setSortBy] = useState("date");
  const [sortDir, setSortDir] = useState("desc");

  const { data: events, loading, reload } = useAsync(
    () => workspaceId ? get("/audit", { limit: 50 }) : Promise.resolve([]),
    [workspaceId]
  );

  function handleAuditSort(field) {
    if (sortBy === field) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortBy(field); setSortDir("asc"); }
  }

  const sorted = events?.length
    ? [...events].sort((a, b) => {
        const v1 = a[sortBy] ?? "";
        const v2 = b[sortBy] ?? "";
        const cmp = v1 < v2 ? -1 : v1 > v2 ? 1 : 0;
        return sortDir === "asc" ? cmp : -cmp;
      })
    : (events ?? []);

  return (
    <div className="fade">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: "var(--disp)", fontSize: 22, fontWeight: 700, marginBottom: 4 }}>{t("audit.title")}</h1>
          <div style={{ fontSize: 13, color: "var(--tx2)" }}>{t("audit.subtitle")}</div>
        </div>
        <button className="btn btn-ghost" onClick={reload}>↺</button>
      </div>
      <div className="card" style={{ overflow: "hidden" }}>
        {loading
          ? <div style={{ padding: 40, textAlign: "center" }}><span className="loader" /></div>
          : !events?.length
            ? <div style={{ padding: "40px", textAlign: "center", color: "var(--tx3)" }}>{t("audit.noEvents")}</div>
            : (
              <table>
                <thead>
                  <tr>
                    <SortHeader field="date"        label={t("audit.colTime")}   currentSort={sortBy} currentDir={sortDir} onSort={handleAuditSort} />
                    <SortHeader field="actor_name"  label={t("audit.colUser")}   currentSort={sortBy} currentDir={sortDir} onSort={handleAuditSort} />
                    <SortHeader field="action"      label={t("audit.colAction")} currentSort={sortBy} currentDir={sortDir} onSort={handleAuditSort} />
                    <SortHeader field="entity_type" label={t("audit.colEntity")} currentSort={sortBy} currentDir={sortDir} onSort={handleAuditSort} />
                    <th>{t("audit.colSource")}</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(e => (
                    <tr key={e.id}>
                      <td className="num" style={{ fontSize: 11, color: "var(--tx3)" }}>{new Date(e.created_at).toLocaleString("ru")}</td>
                      <td style={{ fontSize: 12 }}>{e.actor_name || e.actor_type}</td>
                      <td><span className="badge bg-bl" style={{ fontSize: 10 }}>{e.action}</span></td>
                      <td style={{ fontSize: 11, color: "var(--tx2)" }}>{e.entity_type} {e.entity_name ? `· ${e.entity_name}` : ""}</td>
                      <td><span className={`badge ${e.source === "ai" ? "bg-pur" : e.source === "system" ? "bg-amb" : "bg-grn"}`}>{e.source}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
        }
      </div>
    </div>
  );
};

// ─── Keywords Page ────────────────────────────────────────────────────────────
const KeywordsPage = ({ workspaceId }) => {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [sortBy, setSortBy] = useState("keyword_text");
  const [sortDir, setSortDir] = useState("asc");
  const [selected, setSelected] = useState(new Set());
  const [editId, setEditId] = useState(null);
  const [editBid, setEditBid] = useState("");
  const [saving, setSaving] = useState(false);
  const [bulkPct, setBulkPct] = useState("");
  const [kwToast, setKwToast] = useState(null);

  function handleKwSort(field) {
    const isText = ["keyword_text", "match_type", "state", "campaign"].includes(field);
    if (sortBy === field) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortBy(field); setSortDir(isText ? "asc" : "desc"); }
  }

  const { data: kwResponse, loading, reload } = useAsync(
    () => workspaceId
      ? get("/keywords", { search: search || undefined, state: stateFilter || undefined, limit: 200, sortBy, sortDir })
      : Promise.resolve({ data: [], total: 0 }),
    [workspaceId, search, stateFilter, sortBy, sortDir]
  );

  const keywords = kwResponse?.data ?? [];
  const kwTotal = kwResponse?.total ?? 0;

  function toggleSelect(id) {
    const s = new Set(selected);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelected(s);
  }

  function toggleAll() {
    if (!keywords?.length) return;
    selected.size === keywords.length ? setSelected(new Set()) : setSelected(new Set(keywords.map(k => k.id)));
  }

  async function saveBid(id) {
    setSaving(true);
    try {
      await patch(`/keywords/${id}`, { bid: parseFloat(editBid) });
      reload();
      setEditId(null);
    } catch (e) { alert(t("common.error") + e.message); }
    setSaving(false);
  }

  async function bulkBidUpdate() {
    const pct = parseFloat(bulkPct);
    if (!pct || !selected.size) return;
    setSaving(true);
    try {
      const updates = Array.from(selected).map(id => {
        const kw = keywords.find(k => k.id === id);
        const newBid = Math.max(0.02, parseFloat(kw?.bid || 0.02) * (1 + pct / 100));
        return { id, bid: parseFloat(newBid.toFixed(2)) };
      });
      await patch("/keywords/bulk", { updates });
      reload();
      setSelected(new Set());
      setBulkPct("");
      setKwToast(`Обновлено ${updates.length} ставок`);
      setTimeout(() => setKwToast(null), 3000);
    } catch (e) { alert(t("common.error") + e.message); }
    setSaving(false);
  }

  const matchCls = mt => ({ exact: "bg-grn", phrase: "bg-bl", broad: "bg-amb" })[mt] || "bg-bl";

  return (
    <div className="fade">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <div>
          <h1 style={{ fontFamily: "var(--disp)", fontSize: 22, fontWeight: 700, marginBottom: 4 }}>{t("keywords.title")}</h1>
          <div style={{ fontSize: 13, color: "var(--tx2)" }}>{kwTotal.toLocaleString()} ключевых слов</div>
        </div>
      </div>

      {kwToast && createPortal(
        <div style={{ position: "fixed", top: 20, right: 20, zIndex: 9999, background: "var(--grn)", color: "#fff", padding: "10px 18px", borderRadius: 8, fontSize: 13, fontWeight: 600, boxShadow: "0 4px 20px rgba(0,0,0,.3)" }}>
          {kwToast}
        </div>,
        document.body
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center" }}>
        <input placeholder={t("keywords.searchPlaceholder")} value={search} onChange={e => setSearch(e.target.value)} style={{ width: 220 }} />
        <select value={stateFilter} onChange={e => setStateFilter(e.target.value)} style={{ width: 130 }}>
          <option value="">All States</option>
          <option value="enabled">Enabled</option>
          <option value="paused">Paused</option>
          <option value="archived">Archived</option>
        </select>
        <button className="btn btn-ghost" style={{ fontSize: 12, marginLeft: "auto" }} onClick={reload}>↺ {t("common.refresh")}</button>
      </div>

      {selected.size > 0 && (
        <div className="card fade" style={{ padding: "10px 16px", marginBottom: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", borderColor: "rgba(59,130,246,.4)", background: "rgba(59,130,246,.05)" }}>
          <span style={{ fontSize: 13, color: "var(--ac2)", fontWeight: 500 }}>{selected.size} выбрано</span>
          <span style={{ fontSize: 12, color: "var(--tx2)" }}>Изм. ставку на:</span>
          <input
            type="number"
            value={bulkPct}
            onChange={e => setBulkPct(e.target.value)}
            placeholder="0"
            min="-100" max="100"
            style={{ width: 70, fontSize: 12, padding: "4px 8px" }}
          />
          <span style={{ fontSize: 12, color: "var(--tx2)" }}>%</span>
          <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => setBulkPct("10")}>+10%</button>
          <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => setBulkPct("-10")}>-10%</button>
          <button className="btn btn-primary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={bulkBidUpdate} disabled={saving || !bulkPct}>
            {saving ? <span className="loader" /> : "Применить"}
          </button>
          <button className="btn btn-ghost" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setSelected(new Set())}>{t("common.cancel")}</button>
        </div>
      )}

      <div className="card" style={{ overflow: "hidden" }}>
        {loading
          ? <div style={{ padding: 40, textAlign: "center" }}><span className="loader" /></div>
          : !keywords?.length
            ? <div style={{ padding: "40px", textAlign: "center", color: "var(--tx3)" }}>{t("keywords.noKeywords")}</div>
            : (
              <div style={{ overflowX: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}>
                        <input type="checkbox" checked={selected.size === keywords.length && keywords.length > 0} onChange={toggleAll} />
                      </th>
                      <SortHeader field="keyword_text" label={t("keywords.colKeyword")} currentSort={sortBy} currentDir={sortDir} onSort={handleKwSort} />
                      <SortHeader field="match_type"   label={t("keywords.colMatch")}   currentSort={sortBy} currentDir={sortDir} onSort={handleKwSort} />
                      <SortHeader field="state"        label={t("keywords.colStatus")}  currentSort={sortBy} currentDir={sortDir} onSort={handleKwSort} />
                      <SortHeader field="bid"          label={t("keywords.colBid")}     currentSort={sortBy} currentDir={sortDir} onSort={handleKwSort} align="right" />
                      <SortHeader field="campaign"     label={t("keywords.colCampaign")} currentSort={sortBy} currentDir={sortDir} onSort={handleKwSort} />
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {keywords.map(kw => (
                      <tr key={kw.id}>
                        <td><input type="checkbox" checked={selected.has(kw.id)} onChange={() => toggleSelect(kw.id)} /></td>
                        <td style={{ fontWeight: 500 }}>{kw.keyword_text}</td>
                        <td><span className={`badge ${matchCls(kw.match_type)}`} style={{ fontSize: 10 }}>{kw.match_type}</span></td>
                        <td>
                          <span className={`tag ${kw.state === "enabled" ? "tag-on" : kw.state === "paused" ? "tag-pause" : "tag-arch"}`}>
                            <span style={{ width: 5, height: 5, borderRadius: "50%", background: "currentColor", display: "inline-block" }} />
                            {kw.state}
                          </span>
                        </td>
                        <td className="num" style={{ textAlign: "right" }}>
                          {editId === kw.id
                            ? (
                              <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                                <input type="number" step="0.01" value={editBid} onChange={e => setEditBid(e.target.value)} style={{ width: 70, fontSize: 11, padding: "3px 6px" }} autoFocus />
                                <button className="btn btn-green" style={{ fontSize: 10, padding: "3px 8px" }} onClick={() => saveBid(kw.id)} disabled={saving}>✓</button>
                                <button className="btn btn-ghost" style={{ fontSize: 10, padding: "3px 8px" }} onClick={() => setEditId(null)}>✕</button>
                              </div>
                            )
                            : (
                              <span style={{ cursor: "pointer", color: "var(--ac2)" }} onClick={() => { setEditId(kw.id); setEditBid(kw.bid || ""); }}>
                                ${parseFloat(kw.bid || 0).toFixed(2)}
                              </span>
                            )
                          }
                        </td>
                        <td style={{ fontSize: 11, color: "var(--tx3)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{kw.campaign_name}</td>
                        <td>
                          {editId !== kw.id && (
                            <button className="btn btn-ghost" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => { setEditId(kw.id); setEditBid(kw.bid || ""); }}>
                              {t("keywords.editBid")}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        }
      </div>

    </div>
  );
};

// ─── Condition / Action type definitions (new DSL) ────────────────────────────
const COND_FIELDS = [
  { value: "acos",         label: "ACoS",        unit: "%" },
  { value: "roas",         label: "ROAS",        unit: ""  },
  { value: "cpc",          label: "CPC",         unit: "$" },
  { value: "ctr",          label: "CTR",         unit: "%" },
  { value: "spend",        label: "Spend",       unit: "$" },
  { value: "clicks",       label: "Clicks",      unit: ""  },
  { value: "impressions",  label: "Impressions", unit: ""  },
  { value: "orders",       label: "Orders",      unit: ""  },
  { value: "daily_budget", label: "Budget",      unit: "$" },
];
const COND_OPS = [
  { value: "gt",  label: ">" },
  { value: "lt",  label: "<" },
  { value: "gte", label: ">=" },
  { value: "lte", label: "<=" },
  { value: "eq",  label: "=" },
  { value: "neq", label: "≠" },
];
const ACT_TYPES = [
  { value: "adjust_bid",     label: "Adjust Bid",     hasValue: true,  unit: "%" },
  { value: "set_bid",        label: "Set Bid",        hasValue: true,  unit: "$" },
  { value: "adjust_budget",  label: "Adjust Budget",  hasValue: true,  unit: "%" },
  { value: "set_budget",     label: "Set Budget",     hasValue: true,  unit: "$" },
  { value: "pause_campaign",  label: "Pause Campaign",  hasValue: false },
  { value: "enable_campaign", label: "Enable Campaign", hasValue: false },
];

function relTime(ts) {
  if (!ts) return null;
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function condSummary(conds) {
  return (Array.isArray(conds) ? conds : []).map(c => {
    const f = COND_FIELDS.find(x => x.value === c.field);
    const o = COND_OPS.find(x => x.value === c.operator);
    return `${f?.label || c.field} ${o?.label || c.operator} ${c.value}${f?.unit || ""}`;
  }).join(" AND ");
}
function actSummary(acts) {
  return (Array.isArray(acts) ? acts : []).map(a => {
    const d = ACT_TYPES.find(x => x.value === a.type);
    if (!d?.hasValue) return d?.label || a.type;
    return `${d.label} ${a.value}${d.unit || ""}`;
  }).join(", ");
}
function parseRuleJSON(val, fallback) {
  if (!val) return fallback;
  if (typeof val === "string") { try { return JSON.parse(val); } catch { return fallback; } }
  return val;
}
const EMPTY_RULE_FORM = {
  name: "", schedule_type: "daily", dry_run: false,
  conditions: [{ field: "acos", operator: "gt", value: 30 }],
  actions:    [{ type: "pause_campaign" }],
  safety:     { max_change_pct: 20, min_bid: 0.02, max_bid: 50, min_budget: 1, max_budget: 10000 },
};

// ─── Rules Page ───────────────────────────────────────────────────────────────
const RulesPage = ({ workspaceId }) => {
  const { t } = useI18n();
  const [showModal,     setShowModal]     = useState(false);
  const [editRule,      setEditRule]      = useState(null);
  const [saving,        setSaving]        = useState(false);
  const [form,          setForm]          = useState(EMPTY_RULE_FORM);
  const [showSafety,    setShowSafety]    = useState(false);
  const [historyRule,   setHistoryRule]   = useState(null);
  const [historyData,   setHistoryData]   = useState(null);
  const [expandedExec,  setExpandedExec]  = useState(null);
  const [previewRule,   setPreviewRule]   = useState(null);
  const [previewData,   setPreviewData]   = useState(null);
  const [previewLoad,   setPreviewLoad]   = useState(false);
  const [toast,         setToast]         = useState(null);
  const [running,       setRunning]       = useState({});

  const { data: rules, loading, reload } = useAsync(
    () => workspaceId ? get("/rules") : Promise.resolve([]),
    [workspaceId]
  );

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  function openCreate() {
    setEditRule(null); setForm(EMPTY_RULE_FORM); setShowSafety(false); setShowModal(true);
  }

  function openEdit(rule) {
    setEditRule(rule);
    const conds = parseRuleJSON(rule.conditions, EMPTY_RULE_FORM.conditions);
    const acts  = parseRuleJSON(rule.actions,    EMPTY_RULE_FORM.actions);
    const saf   = parseRuleJSON(rule.safety,     EMPTY_RULE_FORM.safety);
    setForm({
      name: rule.name, schedule_type: rule.schedule_type || "daily", dry_run: !!rule.dry_run,
      conditions: Array.isArray(conds) ? conds : [conds],
      actions:    Array.isArray(acts)  ? acts  : [acts],
      safety:     saf || EMPTY_RULE_FORM.safety,
    });
    setShowSafety(false); setShowModal(true);
  }

  async function saveRule() {
    if (!form.name) return alert(t("rules.alertName"));
    setSaving(true);
    try {
      if (editRule) {
        await apiFetch(`/rules/${editRule.id}`, { method: "PUT", body: JSON.stringify(form) });
      } else {
        await post("/rules", form);
      }
      reload(); setShowModal(false);
    } catch (e) { alert(t("common.error") + e.message); }
    setSaving(false);
  }

  async function deleteRule(id) {
    if (!confirm(t("rules.confirmDelete"))) return;
    await del(`/rules/${id}`); reload();
  }

  async function toggleRule(id) {
    await patch(`/rules/${id}/toggle`); reload();
  }

  async function runNow(rule) {
    setRunning(r => ({ ...r, [rule.id]: true }));
    try {
      await post(`/rules/${rule.id}/run`, {});
      showToast(t("rules.queued"));
      setTimeout(() => { reload(); setRunning(r => ({ ...r, [rule.id]: false })); }, 3000);
    } catch (e) {
      alert(t("common.error") + e.message);
      setRunning(r => ({ ...r, [rule.id]: false }));
    }
  }

  async function openHistory(rule) {
    setHistoryRule(rule); setHistoryData(null); setExpandedExec(null);
    try { setHistoryData(await get(`/rules/${rule.id}/executions`)); }
    catch { setHistoryData([]); }
  }

  async function openPreview(rule) {
    setPreviewRule(rule); setPreviewData(null); setPreviewLoad(true);
    try { setPreviewData(await get(`/rules/${rule.id}/preview`)); }
    catch (e) { setPreviewData({ matched: 0, actions: [], error: e.message }); }
    setPreviewLoad(false);
  }

  function updCond(i, f, v) {
    setForm(fm => { const c = [...fm.conditions]; c[i] = { ...c[i], [f]: v }; return { ...fm, conditions: c }; });
  }
  function updAct(i, f, v) {
    setForm(fm => { const a = [...fm.actions]; a[i] = { ...a[i], [f]: v }; return { ...fm, actions: a }; });
  }
  function updSafety(k, v) {
    setForm(fm => ({ ...fm, safety: { ...fm.safety, [k]: v } }));
  }

  const statusColor = s => ({ success: "var(--grn)", error: "var(--red)", running: "var(--amb)" }[s] || "var(--b3)");
  const dot = s => <span style={{ width: 7, height: 7, borderRadius: "50%", background: statusColor(s), display: "inline-block", marginRight: 5 }} />;

  const MODAL_WRAP = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 1000, overflowY: "auto", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 20px", boxSizing: "border-box" };
  const LABEL_STYLE = { fontSize: 10, color: "var(--tx3)", marginBottom: 6, fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: ".06em" };

  return (
    <div className="fade">
      {toast && (
        <div style={{ position: "fixed", top: 20, right: 20, zIndex: 9999, background: "var(--grn)", color: "#fff", padding: "10px 18px", borderRadius: 8, fontSize: 13, fontWeight: 600, boxShadow: "0 4px 20px rgba(0,0,0,.3)" }}>
          {toast}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: "var(--disp)", fontSize: 22, fontWeight: 700, marginBottom: 4 }}>{t("rules.title")}</h1>
          <div style={{ fontSize: 13, color: "var(--tx2)" }}>{t("rules.subtitle")}</div>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>{t("rules.newRule")}</button>
      </div>

      {loading
        ? <div style={{ padding: 40, textAlign: "center" }}><span className="loader" /></div>
        : !rules?.length
          ? <div className="card" style={{ padding: "40px", textAlign: "center", color: "var(--tx3)" }}>{t("rules.noRules")}</div>
          : <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {rules.map(rule => {
                const conds = parseRuleJSON(rule.conditions, []);
                const acts  = parseRuleJSON(rule.actions, []);
                const isRunning = running[rule.id];
                return (
                  <div key={rule.id} className="card" style={{ padding: "16px 20px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 600, fontSize: 15 }}>{rule.name}</span>
                        <span className={`badge ${rule.schedule_type === "hourly" ? "bg-bl" : "bg-grn"}`} style={{ fontSize: 10 }}>
                          {t(rule.schedule_type === "hourly" ? "rules.hourly" : "rules.daily")}
                        </span>
                        {rule.dry_run && <span className="badge bg-amb" style={{ fontSize: 10 }}>{t("rules.dryRun")}</span>}
                      </div>
                      <button onClick={() => toggleRule(rule.id)} style={{ width: 36, height: 20, borderRadius: 10, border: "none", cursor: "pointer", flexShrink: 0, background: rule.is_active ? "var(--grn)" : "var(--b2)", position: "relative", transition: "background .2s" }}>
                        <span style={{ position: "absolute", top: 3, left: rule.is_active ? 17 : 3, width: 14, height: 14, borderRadius: "50%", background: "#fff", transition: "left .2s" }} />
                      </button>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--tx2)", marginBottom: 5 }}>
                      <span style={{ color: "var(--tx3)", fontFamily: "var(--mono)", fontSize: 10, textTransform: "uppercase", marginRight: 4 }}>IF</span>
                      {condSummary(conds) || "—"}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--tx2)", marginBottom: 12 }}>
                      <span style={{ color: "var(--tx3)", fontFamily: "var(--mono)", fontSize: 10, textTransform: "uppercase", marginRight: 4 }}>THEN</span>
                      {actSummary(acts) || "—"}
                    </div>
                    <div style={{ display: "flex", gap: 16, fontSize: 11, color: "var(--tx3)", marginBottom: 12, flexWrap: "wrap" }}>
                      <span>{dot(rule.last_run_status)}{t("rules.lastRun")}: {relTime(rule.last_run_at) || t("rules.neverRun")}</span>
                      {rule.run_count > 0 && <span>Runs: {rule.run_count}</span>}
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button className="btn btn-primary" style={{ fontSize: 11, padding: "4px 10px" }} onClick={() => runNow(rule)} disabled={isRunning}>
                        {isRunning ? <span className="loader" /> : `▶ ${t("rules.runNow")}`}
                      </button>
                      <button className="btn btn-ghost" style={{ fontSize: 11, padding: "4px 10px" }} onClick={() => openPreview(rule)}>
                        {t("rules.preview")}
                      </button>
                      <button className="btn btn-ghost" style={{ fontSize: 11, padding: "4px 10px" }} onClick={() => openEdit(rule)}>{t("common.edit")}</button>
                      <button className="btn btn-ghost" style={{ fontSize: 11, padding: "4px 10px" }} onClick={() => openHistory(rule)}>{t("rules.history")}</button>
                      <button className="btn btn-red"   style={{ fontSize: 11, padding: "4px 10px" }} onClick={() => deleteRule(rule.id)}>✕</button>
                    </div>
                  </div>
                );
              })}
            </div>
      }

      {/* ── Rule Builder Modal ──────────────────────────────────────────────── */}
      {showModal && createPortal(
        <div style={MODAL_WRAP}>
          <div style={{ background: "#1a1d2e", borderRadius: "12px", padding: "28px", width: "100%", maxWidth: "560px", position: "relative", margin: "0 auto" }}>
            <div style={{ fontFamily: "var(--disp)", fontSize: 16, fontWeight: 700, marginBottom: 20 }}>
              {editRule ? `✎ ${t("rules.editRule")}` : t("rules.newRule")}
            </div>

            {/* Name */}
            <div style={{ marginBottom: 14 }}>
              <div style={LABEL_STYLE}>{t("rules.name")}</div>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={{ width: "100%" }} placeholder={t("rules.namePlaceholder")} />
            </div>

            {/* Schedule */}
            <div style={{ marginBottom: 14 }}>
              <div style={LABEL_STYLE}>{t("rules.schedule")}</div>
              <div style={{ display: "flex", gap: 8 }}>
                {["hourly","daily"].map(s => (
                  <button key={s} onClick={() => setForm(f => ({ ...f, schedule_type: s }))}
                    className={`btn ${form.schedule_type === s ? "btn-primary" : "btn-ghost"}`} style={{ fontSize: 12, padding: "5px 14px" }}>
                    {t("rules.schedule_" + s)}
                  </button>
                ))}
              </div>
            </div>

            {/* Dry Run */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer", fontSize: 13 }}>
                <input type="checkbox" checked={form.dry_run} onChange={e => setForm(f => ({ ...f, dry_run: e.target.checked }))} />
                {t("rules.dryRun")}
              </label>
              {form.dry_run && <div style={{ fontSize: 11, color: "var(--amb)", marginTop: 4, marginLeft: 22 }}>{t("rules.dryRunDesc")}</div>}
            </div>

            {/* Conditions */}
            <div style={{ marginBottom: 14 }}>
              <div style={LABEL_STYLE}>{t("rules.conditions")}</div>
              {form.conditions.map((cond, i) => (
                <div key={i} style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center" }}>
                  <select value={cond.field || "acos"} onChange={e => updCond(i, "field", e.target.value)} style={{ flex: 1 }}>
                    {COND_FIELDS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                  <select value={cond.operator || "gt"} onChange={e => updCond(i, "operator", e.target.value)} style={{ width: 60 }}>
                    {COND_OPS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <input type="number" value={cond.value ?? ""} onChange={e => updCond(i, "value", parseFloat(e.target.value) || 0)} style={{ width: 80 }} />
                  {form.conditions.length > 1 && (
                    <button className="btn btn-red" style={{ fontSize: 11, padding: "3px 8px" }}
                      onClick={() => setForm(f => ({ ...f, conditions: f.conditions.filter((_, idx) => idx !== i) }))}>✕</button>
                  )}
                </div>
              ))}
              {form.conditions.length < 5 && (
                <button className="btn btn-ghost" style={{ fontSize: 11 }}
                  onClick={() => setForm(f => ({ ...f, conditions: [...f.conditions, { field: "acos", operator: "gt", value: 30 }] }))}>
                  {t("rules.addCondition")}
                </button>
              )}
            </div>

            {/* Actions */}
            <div style={{ marginBottom: 14 }}>
              <div style={LABEL_STYLE}>{t("rules.actions")}</div>
              {form.actions.map((action, i) => {
                const def = ACT_TYPES.find(a => a.value === action.type);
                return (
                  <div key={i} style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center" }}>
                    <select value={action.type} onChange={e => updAct(i, "type", e.target.value)} style={{ flex: 1 }}>
                      {ACT_TYPES.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                    </select>
                    {def?.hasValue && (
                      <>
                        <input type="number" value={action.value ?? ""} onChange={e => updAct(i, "value", parseFloat(e.target.value) || 0)} style={{ width: 70 }} />
                        <span style={{ fontSize: 12, color: "var(--tx3)", minWidth: 14 }}>{def.unit}</span>
                      </>
                    )}
                    {form.actions.length > 1 && (
                      <button className="btn btn-red" style={{ fontSize: 11, padding: "3px 8px" }}
                        onClick={() => setForm(f => ({ ...f, actions: f.actions.filter((_, idx) => idx !== i) }))}>✕</button>
                    )}
                  </div>
                );
              })}
              {form.actions.length < 3 && (
                <button className="btn btn-ghost" style={{ fontSize: 11 }}
                  onClick={() => setForm(f => ({ ...f, actions: [...f.actions, { type: "pause_campaign" }] }))}>
                  {t("rules.addAction")}
                </button>
              )}
            </div>

            {/* Safety Limits (collapsible) */}
            <div style={{ marginBottom: 20 }}>
              <button className="btn btn-ghost" style={{ fontSize: 11, marginBottom: showSafety ? 10 : 0 }}
                onClick={() => setShowSafety(s => !s)}>
                {showSafety ? "▾" : "▸"} {t("rules.safety")}
              </button>
              {showSafety && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                  {[
                    { key: "max_change_pct", label: "Max change", unit: "%" },
                    { key: "min_bid",        label: "Min bid",    unit: "$" },
                    { key: "max_bid",        label: "Max bid",    unit: "$" },
                    { key: "min_budget",     label: "Min budget", unit: "$" },
                    { key: "max_budget",     label: "Max budget", unit: "$" },
                  ].map(({ key, label, unit }) => (
                    <div key={key}>
                      <div style={{ fontSize: 10, color: "var(--tx3)", marginBottom: 4 }}>{label} ({unit})</div>
                      <input type="number" value={form.safety[key] ?? ""} style={{ width: "100%" }}
                        onChange={e => updSafety(key, parseFloat(e.target.value) || 0)} />
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn btn-primary" onClick={saveRule} disabled={saving}>
                {saving ? <span className="loader" /> : t("rules.saveRule")}
              </button>
              <button className="btn btn-ghost" onClick={() => setShowModal(false)}>{t("common.cancel")}</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── Execution History Modal ─────────────────────────────────────────── */}
      {historyRule && createPortal(
        <div style={MODAL_WRAP}>
          <div className="card fade" style={{ width: 700, padding: "24px 28px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={{ fontFamily: "var(--disp)", fontSize: 16, fontWeight: 700 }}>
                {t("rules.history")}: {historyRule.name}
              </div>
              <button className="btn btn-ghost" onClick={() => setHistoryRule(null)}>✕</button>
            </div>
            {!historyData
              ? <div style={{ textAlign: "center", padding: 30 }}><span className="loader" /></div>
              : !historyData.length
                ? <div style={{ color: "var(--tx3)", fontSize: 13 }}>{t("rules.neverRun")}</div>
                : historyData.map(exec => (
                    <div key={exec.id} style={{ borderBottom: "1px solid var(--b1)", paddingBottom: 10, marginBottom: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          {dot(exec.status)}
                          <span style={{ fontSize: 12 }}>{new Date(exec.started_at).toLocaleString()}</span>
                          {exec.dry_run && <span className="badge bg-amb" style={{ fontSize: 9 }}>DRY</span>}
                        </div>
                        <div style={{ display: "flex", gap: 12, alignItems: "center", fontSize: 11, color: "var(--tx3)" }}>
                          <span>{t("rules.evaluated")}: {exec.entities_evaluated}</span>
                          <span>{t("rules.matched")}: {exec.entities_matched}</span>
                          <span>Actions: {exec.actions_taken}</span>
                          <button className="btn btn-ghost" style={{ fontSize: 10, padding: "2px 6px" }}
                            onClick={() => setExpandedExec(expandedExec === exec.id ? null : exec.id)}>
                            {expandedExec === exec.id ? "▴" : "▾"}
                          </button>
                        </div>
                      </div>
                      {expandedExec === exec.id && Array.isArray(exec.summary) && exec.summary.length > 0 && (
                        <table style={{ marginTop: 10, fontSize: 11 }}>
                          <thead><tr><th>Entity</th><th>Action</th><th>Before → After</th><th>Applied</th></tr></thead>
                          <tbody>
                            {exec.summary.map((s, idx) => (
                              <tr key={idx}>
                                <td>{s.entityName}</td>
                                <td>{s.action}</td>
                                <td style={{ fontFamily: "var(--mono)" }}>{s.oldValue !== undefined ? `${s.oldValue} → ${s.newValue}` : s.error || "—"}</td>
                                <td>{s.applied ? "✓" : "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  ))
            }
          </div>
        </div>,
        document.body
      )}

      {/* ── Preview Modal ───────────────────────────────────────────────────── */}
      {previewRule && createPortal(
        <div style={MODAL_WRAP}>
          <div className="card fade" style={{ width: 700, padding: "24px 28px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={{ fontFamily: "var(--disp)", fontSize: 16, fontWeight: 700 }}>
                {t("rules.preview")}: {previewRule.name}
              </div>
              <button className="btn btn-ghost" onClick={() => setPreviewRule(null)}>✕</button>
            </div>
            {previewLoad
              ? <div style={{ textAlign: "center", padding: 30 }}><span className="loader" /></div>
              : !previewData?.actions?.length
                ? <div style={{ color: "var(--tx3)", fontSize: 13 }}>{t("rules.noMatches")}</div>
                : <>
                    <div style={{ fontSize: 12, color: "var(--tx2)", marginBottom: 12 }}>
                      {t("rules.matched")}: {previewData.matched}
                    </div>
                    <table style={{ fontSize: 12 }}>
                      <thead><tr><th>Entity</th><th>Action</th><th>Before → After</th></tr></thead>
                      <tbody>
                        {previewData.actions.map((s, i) => (
                          <tr key={i}>
                            <td>{s.entityName}</td>
                            <td>{s.action}</td>
                            <td style={{ fontFamily: "var(--mono)" }}>
                              {s.oldValue !== undefined ? `${s.oldValue} → ${s.newValue}` : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
            }
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

// ─── Alerts Page ──────────────────────────────────────────────────────────────
const ALERT_METRICS   = ["acos", "roas", "spend", "impressions", "ctr", "cpc"];
const ALERT_OPERATORS = [{ value: "gt", label: ">" }, { value: "gte", label: ">=" }, { value: "lt", label: "<" }, { value: "lte", label: "<=" }];

const AlertsPage = ({ workspaceId }) => {
  const { t } = useI18n();
  const [tab, setTab] = useState("configs");
  const [showModal, setShowModal] = useState(false);
  const [editConfig, setEditConfig] = useState(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", metric: "acos", operator: "gt", value: 30, channels: { in_app: true, email: false }, cooldown_hours: 24 });

  const { data: configs, loading: cl, reload: reloadConfigs } = useAsync(
    () => workspaceId ? get("/alerts/configs") : Promise.resolve([]),
    [workspaceId]
  );
  const { data: instances, loading: il, reload: reloadInstances } = useAsync(
    () => workspaceId ? get("/alerts", { status: "open" }) : Promise.resolve([]),
    [workspaceId]
  );

  function openCreate() {
    setEditConfig(null);
    setForm({ name: "", metric: "acos", operator: "gt", value: 30, channels: { in_app: true, email: false }, cooldown_hours: 24 });
    setShowModal(true);
  }

  function openEdit(config) {
    setEditConfig(config);
    const cond = typeof config.conditions === "string" ? JSON.parse(config.conditions) : config.conditions;
    const ch   = typeof config.channels   === "string" ? JSON.parse(config.channels)   : config.channels;
    setForm({
      name: config.name, metric: cond.metric || config.alert_type,
      operator: cond.operator || "gt", value: cond.value || 0,
      channels: ch || { in_app: true, email: false }, cooldown_hours: config.suppression_hours || 24,
    });
    setShowModal(true);
  }

  async function saveConfig() {
    if (!form.name) return alert(t("alerts.alertName"));
    setSaving(true);
    try {
      if (editConfig) {
        await apiFetch(`/alerts/configs/${editConfig.id}`, { method: "PUT", body: JSON.stringify(form) });
      } else {
        await post("/alerts/configs", form);
      }
      reloadConfigs();
      setShowModal(false);
    } catch (e) { alert(t("common.error") + e.message); }
    setSaving(false);
  }

  async function deleteConfig(id) {
    if (!confirm(t("alerts.deleteConfirm"))) return;
    await del(`/alerts/configs/${id}`);
    reloadConfigs();
  }

  async function toggleConfig(id) {
    await patch(`/alerts/configs/${id}/toggle`);
    reloadConfigs();
  }

  async function acknowledge(id) {
    await patch(`/alerts/${id}/acknowledge`);
    reloadInstances();
  }

  const operLabel = op => ALERT_OPERATORS.find(o => o.value === op)?.label || op;

  return (
    <div className="fade">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: "var(--disp)", fontSize: 22, fontWeight: 700, marginBottom: 4 }}>{t("alerts.title")}</h1>
          <div style={{ fontSize: 13, color: "var(--tx2)" }}>{t("alerts.subtitle")}</div>
        </div>
        {tab === "configs" && <button className="btn btn-primary" onClick={openCreate}>+ {t("alerts.newAlert")}</button>}
      </div>

      <div style={{ display: "flex", gap: 4, marginBottom: 14 }}>
        {["configs", "instances"].map(tabId => (
          <button key={tabId} onClick={() => setTab(tabId)} className={`btn ${tab === tabId ? "btn-primary" : "btn-ghost"}`} style={{ fontSize: 12, padding: "5px 12px" }}>
            {t("alerts.tab_" + tabId)}
            {tabId === "instances" && instances?.length > 0 && (
              <span className="badge bg-red" style={{ marginLeft: 6, fontSize: 9, padding: "1px 5px" }}>{instances.length}</span>
            )}
          </button>
        ))}
      </div>

      {tab === "configs" && (
        <div className="card" style={{ overflow: "hidden" }}>
          {cl
            ? <div style={{ padding: 40, textAlign: "center" }}><span className="loader" /></div>
            : !configs?.length
              ? <div style={{ padding: "40px", textAlign: "center", color: "var(--tx3)" }}>{t("alerts.noAlerts")}</div>
              : (
                <table>
                  <thead>
                    <tr>
                      <th>{t("alerts.colName")}</th>
                      <th>{t("alerts.colMetric")}</th>
                      <th>{t("alerts.colThreshold")}</th>
                      <th>{t("alerts.colChannels")}</th>
                      <th>{t("alerts.colCooldown")}</th>
                      <th>{t("alerts.colActive")}</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {configs.map(config => {
                      const cond = (() => { try { return typeof config.conditions === "string" ? JSON.parse(config.conditions) : config.conditions; } catch { return {}; } })();
                      const ch   = (() => { try { return typeof config.channels   === "string" ? JSON.parse(config.channels)   : config.channels;   } catch { return {}; } })();
                      return (
                        <tr key={config.id}>
                          <td style={{ fontWeight: 500 }}>{config.name}</td>
                          <td><span className="badge bg-bl" style={{ fontSize: 10 }}>{(cond.metric || config.alert_type || "").toUpperCase()}</span></td>
                          <td className="num">{operLabel(cond.operator)} {cond.value}</td>
                          <td>
                            <div style={{ display: "flex", gap: 4 }}>
                              {ch?.in_app && <span className="badge bg-pur" style={{ fontSize: 9 }}>in-app</span>}
                              {ch?.email  && <span className="badge bg-grn" style={{ fontSize: 9 }}>email</span>}
                            </div>
                          </td>
                          <td className="num">{config.suppression_hours}h</td>
                          <td>
                            <button onClick={() => toggleConfig(config.id)} style={{
                              width: 34, height: 18, borderRadius: 9, border: "none", cursor: "pointer",
                              background: config.is_active ? "var(--grn)" : "var(--b2)", position: "relative", transition: "background .2s",
                            }}>
                              <span style={{ position: "absolute", top: 2, left: config.is_active ? 16 : 2, width: 14, height: 14, borderRadius: "50%", background: "#fff", transition: "left .2s" }} />
                            </button>
                          </td>
                          <td>
                            <div style={{ display: "flex", gap: 4 }}>
                              <button className="btn btn-ghost" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => openEdit(config)}>{t("common.edit")}</button>
                              <button className="btn btn-red"   style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => deleteConfig(config.id)}>✕</button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )
          }
        </div>
      )}

      {tab === "instances" && (
        <div className="card" style={{ overflow: "hidden" }}>
          {il
            ? <div style={{ padding: 40, textAlign: "center" }}><span className="loader" /></div>
            : !instances?.length
              ? <div style={{ padding: "40px", textAlign: "center", color: "var(--tx3)" }}>{t("alerts.noInstances")}</div>
              : (
                <table>
                  <thead>
                    <tr>
                      <th>{t("alerts.colTime")}</th>
                      <th>{t("alerts.colAlert")}</th>
                      <th>{t("alerts.colSeverity")}</th>
                      <th>{t("alerts.colEntity")}</th>
                      <th>{t("alerts.colStatus")}</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {instances.map(inst => (
                      <tr key={inst.id}>
                        <td className="num" style={{ fontSize: 11, color: "var(--tx3)" }}>{new Date(inst.created_at).toLocaleString()}</td>
                        <td style={{ fontWeight: 500, fontSize: 12 }}>{inst.config_name || inst.title}</td>
                        <td>
                          <span className={`badge ${inst.severity === "critical" || inst.severity === "high" ? "bg-red" : inst.severity === "medium" ? "bg-amb" : "bg-bl"}`} style={{ fontSize: 10 }}>
                            {inst.severity}
                          </span>
                        </td>
                        <td style={{ fontSize: 11, color: "var(--tx2)" }}>{inst.entity_name || "—"}</td>
                        <td><span className={`badge ${inst.status === "open" ? "bg-amb" : "bg-grn"}`} style={{ fontSize: 10 }}>{inst.status}</span></td>
                        <td>
                          {inst.status === "open" && (
                            <button className="btn btn-ghost" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => acknowledge(inst.id)}>{t("alerts.acknowledge")}</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
          }
        </div>
      )}

      {showModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div className="card fade" style={{ width: 480, padding: "24px 28px" }}>
            <div style={{ fontFamily: "var(--disp)", fontSize: 16, fontWeight: 700, marginBottom: 20 }}>
              {editConfig ? t("alerts.editAlert") : t("alerts.newAlert")}
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10, color: "var(--tx3)", marginBottom: 6, fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: ".06em" }}>{t("alerts.name")}</div>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={{ width: "100%" }} />
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10, color: "var(--tx3)", marginBottom: 6, fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: ".06em" }}>{t("alerts.threshold")}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <select value={form.metric} onChange={e => setForm(f => ({ ...f, metric: e.target.value }))} style={{ flex: 1 }}>
                  {ALERT_METRICS.map(m => <option key={m} value={m}>{m.toUpperCase()}</option>)}
                </select>
                <select value={form.operator} onChange={e => setForm(f => ({ ...f, operator: e.target.value }))} style={{ width: 60 }}>
                  {ALERT_OPERATORS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <input type="number" value={form.value} onChange={e => setForm(f => ({ ...f, value: parseFloat(e.target.value) }))} style={{ width: 80 }} />
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10, color: "var(--tx3)", marginBottom: 6, fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: ".06em" }}>{t("alerts.channels")}</div>
              <div style={{ display: "flex", gap: 16 }}>
                <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer", fontSize: 13 }}>
                  <input type="checkbox" checked={form.channels.in_app} onChange={e => setForm(f => ({ ...f, channels: { ...f.channels, in_app: e.target.checked } }))} />
                  {t("alerts.channelInApp")}
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer", fontSize: 13 }}>
                  <input type="checkbox" checked={form.channels.email} onChange={e => setForm(f => ({ ...f, channels: { ...f.channels, email: e.target.checked } }))} />
                  {t("alerts.channelEmail")}
                </label>
              </div>
            </div>

            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 10, color: "var(--tx3)", marginBottom: 6, fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: ".06em" }}>{t("alerts.cooldown")}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="number" value={form.cooldown_hours} onChange={e => setForm(f => ({ ...f, cooldown_hours: parseInt(e.target.value) }))} style={{ width: 80 }} />
                <span style={{ fontSize: 13, color: "var(--tx2)" }}>h</span>
              </div>
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn btn-primary" onClick={saveConfig} disabled={saving}>
                {saving ? <span className="loader" /> : t("rules.save")}
              </button>
              <button className="btn btn-ghost" onClick={() => setShowModal(false)}>{t("common.cancel")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Login Page ───────────────────────────────────────────────────────────────
const LoginPage = ({ onLogin }) => {
  const { t } = useI18n();
  const [tab, setTab] = useState("login");
  const [form, setForm] = useState({ email: "", password: "", name: "", orgName: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    setLoading(true); setError(null);
    try {
      let res;
      if (tab === "login") {
        res = await post("/auth/login", { email: form.email, password: form.password });
      } else {
        res = await post("/auth/register", { email: form.email, password: form.password, name: form.name, orgName: form.orgName });
      }
      localStorage.setItem("af_token", res.accessToken);
      if (res.workspaces?.[0]) localStorage.setItem("af_workspace", res.workspaces[0].id);
      onLogin(res);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }

  const f = (field) => ({ value: form[field], onChange: e => setForm(f => ({ ...f, [field]: e.target.value }) )});

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)" }}>
      <Styles />
      <div style={{ width: 380, padding: "36px 32px", background: "var(--s1)", borderRadius: 14, border: "1px solid var(--b1)" }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ width: 44, height: 44, background: "linear-gradient(135deg,#3B82F6,#A78BFA)", borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, margin: "0 auto 12px" }}>⬡</div>
          <div style={{ fontFamily: "var(--disp)", fontSize: 22, fontWeight: 800 }}>AdsFlow</div>
          <div style={{ fontSize: 12, color: "var(--tx3)" }}>{t("login.subtitle")}</div>
        </div>

        <div style={{ display: "flex", gap: 0, marginBottom: 20, background: "var(--s2)", borderRadius: 8, padding: 3 }}>
          {["login", "register"].map(tabId => (
            <button key={tabId} onClick={() => setTab(tabId)} style={{
              flex: 1, padding: "7px", borderRadius: 6, border: "none", cursor: "pointer",
              background: tab === tabId ? "var(--s3)" : "transparent",
              color: tab === tabId ? "var(--tx)" : "var(--tx3)", fontSize: 13, fontFamily: "var(--ui)",
              transition: "all .15s"
            }}>
              {tabId === "login" ? t("login.login") : t("login.register")}
            </button>
          ))}
        </div>

        {error && <div style={{ marginBottom: 14, padding: "10px 14px", background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.2)", borderRadius: 8, color: "var(--red)", fontSize: 12 }}>{error}</div>}

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {tab === "register" && (
            <>
              <input placeholder={t("login.namePlaceholder")} {...f("name")} />
              <input placeholder={t("login.orgPlaceholder")} {...f("orgName")} />
            </>
          )}
          <input placeholder={t("login.emailPlaceholder")} type="email" {...f("email")} />
          <input placeholder={t("login.passwordPlaceholder")} type="password" {...f("password")}
            onKeyDown={e => e.key === "Enter" && submit()} />
          <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center", padding: "10px" }} onClick={submit} disabled={loading}>
            {loading ? <span className="loader" /> : tab === "login" ? t("login.login") : t("login.createAccount")}
          </button>
        </div>

        {tab === "login" && (
          <div style={{ marginTop: 14, padding: "10px 14px", background: "rgba(59,130,246,.06)", border: "1px solid rgba(59,130,246,.12)", borderRadius: 8, fontSize: 11, color: "var(--tx3)" }}>
            {t("login.demoHint")}
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Placeholder pages ────────────────────────────────────────────────────────
// ─── AI Page ──────────────────────────────────────────────────────────────────
const RISK_COLORS = { low: "var(--grn)", medium: "var(--amb)", high: "var(--red)" };
const RISK_BG = { low: "rgba(34,197,94,.1)", medium: "rgba(245,158,11,.1)", high: "rgba(239,68,68,.1)" };
const TYPE_LABELS = {
  bid_increase: "↑ Bid", bid_decrease: "↓ Bid",
  budget_increase: "↑ Budget", budget_decrease: "↓ Budget",
  pause_campaign: "⏸ Pause", enable_campaign: "▶ Enable",
  add_negative_keyword: "⊖ Neg. KW", change_bidding_strategy: "⟳ Strategy",
};

function AIPage({ workspaceId }) {
  const { t } = useI18n();
  const [filter, setFilter] = useState("pending");
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState(null);
  const [applying, setApplying] = useState(null);
  const [confirmRec, setConfirmRec] = useState(null);
  const [previewRec, setPreviewRec] = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [toast, setToast] = useState(null);

  const { data: recs, loading, reload } = useAsync(
    () => get("/ai/recommendations", { status: filter === "all" ? undefined : filter }),
    [filter]
  );

  const showToast = (msg, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  };

  async function handleRunAnalysis() {
    setRunning(true); setRunMsg(null);
    try {
      const locale = localStorage.getItem("af_locale") || "en";
      await apiFetch("/ai/run", {
        method: "POST",
        body: JSON.stringify({ locale }),
        headers: { "x-locale": locale },
      });
      setRunMsg(t("ai.analysisQueued"));
      setTimeout(() => { reload(); setRunMsg(null); }, 8000);
    } catch (e) {
      setRunMsg(t("common.error") + e.message);
    } finally {
      setRunning(false);
    }
  }

  async function handleApply(rec) {
    setApplying(rec.id);
    try {
      await post(`/ai/recommendations/${rec.id}/apply`, {});
      showToast(t("ai.applySuccess"));
      reload();
    } catch (e) {
      showToast(t("ai.applyError") + ": " + e.message, false);
    } finally {
      setApplying(null);
      setConfirmRec(null);
    }
  }

  async function handleDismiss(rec) {
    try {
      await post(`/ai/recommendations/${rec.id}/dismiss`, {});
      reload();
    } catch (e) {
      showToast(t("common.error") + e.message, false);
    }
  }

  async function handlePreview(rec) {
    setPreviewRec(rec);
    setPreviewLoading(true);
    setPreviewData(null);
    try {
      const data = await post(`/ai/recommendations/${rec.id}/preview`, {});
      setPreviewData(data.changes || []);
    } catch (e) {
      setPreviewData([]);
    } finally {
      setPreviewLoading(false);
    }
  }

  const pendingCount  = (recs || []).filter(r => r.status === "pending").length;
  const appliedCount  = (recs || []).filter(r => r.status === "applied").length;
  const dismissedCount = (recs || []).filter(r => r.status === "dismissed").length;

  const FILTERS = [
    { key: "all",       label: t("ai.filterAll") },
    { key: "pending",   label: t("ai.filterPending") },
    { key: "applied",   label: t("ai.filterApplied") },
    { key: "dismissed", label: t("ai.filterDismissed") },
  ];

  return (
    <div className="fade">
      {/* Toast */}
      {toast && (
        <div style={{
          position: "fixed", top: 24, right: 24, zIndex: 9999,
          background: toast.ok ? "var(--grn)" : "var(--red)",
          color: "#fff", padding: "10px 18px", borderRadius: 8,
          fontSize: 13, fontWeight: 500, animation: "slideDown .2s ease",
        }}>{toast.msg}</div>
      )}

      {/* Confirm Apply Modal */}
      {confirmRec && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", zIndex: 1000,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div className="card" style={{ padding: 28, maxWidth: 440, width: "90%" }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 10 }}>{t("ai.confirmApply")}</div>
            <div style={{ fontSize: 13, color: "var(--tx2)", marginBottom: 6 }}><strong>{confirmRec.title}</strong></div>
            <div style={{ fontSize: 12, color: "var(--tx3)", marginBottom: 20 }}>{confirmRec.rationale}</div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button className="btn btn-ghost" onClick={() => setConfirmRec(null)}>{t("common.cancel")}</button>
              <button className="btn btn-primary" disabled={applying === confirmRec.id} onClick={() => handleApply(confirmRec)}>
                {applying === confirmRec.id ? <span className="loader" /> : t("ai.confirmApplyBtn")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Preview Modal */}
      {previewRec && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", zIndex: 1000,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div className="card" style={{ padding: 28, maxWidth: 600, width: "90%", maxHeight: "80vh", overflow: "auto" }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 14 }}>{t("ai.previewTitle")}: {previewRec.title}</div>
            {previewLoading ? (
              <div style={{ textAlign: "center", padding: 30 }}><span className="loader" /></div>
            ) : previewData?.length ? (
              <table style={{ marginBottom: 16 }}>
                <thead><tr>
                  <th>{t("ai.entity")}</th>
                  <th>{t("ai.field")}</th>
                  <th>{t("ai.current")}</th>
                  <th>{t("ai.new")}</th>
                </tr></thead>
                <tbody>
                  {previewData.map((ch, i) => (
                    <tr key={i}>
                      <td><span className="mono" style={{ fontSize: 11 }}>{ch.entity_name}</span></td>
                      <td><span className="mono" style={{ fontSize: 11 }}>{ch.field}</span></td>
                      <td style={{ color: "var(--red)" }}>{String(ch.current_value ?? "—")}</td>
                      <td style={{ color: "var(--grn)" }}>{String(ch.new_value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div style={{ color: "var(--tx3)", fontSize: 13, marginBottom: 16 }}>No entity details available.</div>
            )}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button className="btn btn-ghost" onClick={() => { setPreviewRec(null); setPreviewData(null); }}>{t("common.cancel")}</button>
              {previewRec.status === "pending" && (
                <button className="btn btn-primary" onClick={() => { setPreviewRec(null); setConfirmRec(previewRec); }}>
                  {t("ai.apply")}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: "var(--disp)", fontSize: 22, fontWeight: 700 }}>{t("ai.title")}</h1>
          <div style={{ fontSize: 12, color: "var(--tx3)", marginTop: 4 }}>Claude · Amazon Ads Optimizer</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {runMsg && <span style={{ fontSize: 12, color: "var(--teal)" }}>{runMsg}</span>}
          <button className="btn btn-primary" disabled={running} onClick={handleRunAnalysis} style={{ gap: 8 }}>
            {running ? <><span className="loader" /> {t("ai.running")}</> : <>✦ {t("ai.runAnalysis")}</>}
          </button>
        </div>
      </div>

      {/* Stats bar */}
      <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
        {[
          { label: t("ai.filterPending"), count: pendingCount, color: "var(--ac2)" },
          { label: t("ai.filterApplied"), count: appliedCount, color: "var(--grn)" },
          { label: t("ai.filterDismissed"), count: dismissedCount, color: "var(--tx3)" },
        ].map(s => (
          <div key={s.label} className="card" style={{ padding: "10px 18px", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 20, fontWeight: 600, color: s.color }}>{s.count}</span>
            <span style={{ fontSize: 12, color: "var(--tx2)" }}>{s.label}</span>
          </div>
        ))}
      </div>

      {/* Filter tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: 18, borderBottom: "1px solid var(--b1)", paddingBottom: 12 }}>
        {FILTERS.map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)} style={{
            padding: "5px 14px", borderRadius: 100, fontSize: 12, fontWeight: 500,
            border: "1px solid " + (filter === f.key ? "var(--ac)" : "var(--b2)"),
            background: filter === f.key ? "rgba(59,130,246,.15)" : "transparent",
            color: filter === f.key ? "var(--ac2)" : "var(--tx2)",
            cursor: "pointer",
          }}>{f.label}</button>
        ))}
      </div>

      {/* Recommendations list */}
      {loading ? (
        <div style={{ textAlign: "center", padding: 60, color: "var(--tx3)" }}>
          <span className="loader" style={{ width: 24, height: 24, borderWidth: 3 }} />
        </div>
      ) : !recs?.length ? (
        <div className="card" style={{ padding: "60px 32px", textAlign: "center" }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>✦</div>
          <div style={{ color: "var(--tx2)", fontSize: 14 }}>{t("ai.noRecs")}</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {recs.map(rec => {
            const actions = typeof rec.actions === "string" ? JSON.parse(rec.actions) : (rec.actions || []);
            const riskColor = RISK_COLORS[rec.risk_level] || "var(--tx2)";
            const riskBg = RISK_BG[rec.risk_level] || "transparent";
            const riskLabel = rec.risk_level === "low" ? t("ai.riskLow") : rec.risk_level === "high" ? t("ai.riskHigh") : t("ai.riskMedium");
            const isPending = rec.status === "pending";

            return (
              <div key={rec.id} className="card fade" style={{
                padding: "18px 22px",
                opacity: rec.status !== "pending" ? 0.65 : 1,
                borderColor: isPending ? "var(--b1)" : "var(--b2)",
              }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
                  {/* Left: type badge + content */}
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                      <span style={{
                        padding: "2px 10px", borderRadius: 100, fontSize: 11, fontWeight: 600,
                        background: "rgba(59,130,246,.12)", color: "var(--ac2)", fontFamily: "var(--mono)",
                      }}>{TYPE_LABELS[rec.type] || rec.type}</span>
                      <span style={{ padding: "2px 10px", borderRadius: 100, fontSize: 11, fontWeight: 500, background: riskBg, color: riskColor }}>
                        {riskLabel}
                      </span>
                      {rec.status !== "pending" && (
                        <span style={{ padding: "2px 10px", borderRadius: 100, fontSize: 11, fontWeight: 500, background: "var(--s3)", color: "var(--tx3)" }}>
                          {rec.status === "applied" ? t("ai.applied") : t("ai.dismissed")}
                        </span>
                      )}
                    </div>

                    <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>{rec.title}</div>
                    <div style={{ fontSize: 12, color: "var(--tx2)", lineHeight: 1.6, marginBottom: rec.expected_effect ? 8 : 0 }}>{rec.rationale}</div>

                    {rec.expected_effect && (
                      <div style={{
                        fontSize: 12, marginTop: 6, padding: "6px 12px", borderRadius: 6,
                        background: "rgba(20,184,166,.08)", color: "var(--teal)", borderLeft: "2px solid var(--teal)",
                      }}>
                        <strong>{t("ai.expectedEffect")}:</strong> {rec.expected_effect}
                      </div>
                    )}

                    {actions.length > 0 && (
                      <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {actions.map((a, i) => (
                          <span key={i} style={{
                            fontSize: 11, padding: "2px 8px", borderRadius: 4,
                            background: "var(--s3)", color: "var(--tx3)", fontFamily: "var(--mono)",
                          }}>
                            {a.action_type} · {a.entity_type}
                            {a.params && Object.entries(a.params).map(([k, v]) => ` · ${k}: ${v}`).join("")}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Right: action buttons */}
                  {isPending && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
                      <button className="btn btn-green" style={{ fontSize: 12, padding: "5px 12px" }}
                        disabled={applying === rec.id}
                        onClick={() => setConfirmRec(rec)}>
                        {applying === rec.id ? <span className="loader" /> : <>✓ {t("ai.apply")}</>}
                      </button>
                      <button className="btn btn-ghost" style={{ fontSize: 12, padding: "5px 12px" }}
                        onClick={() => handlePreview(rec)}>
                        👁 {t("ai.preview")}
                      </button>
                      <button className="btn btn-red" style={{ fontSize: 12, padding: "5px 12px" }}
                        onClick={() => handleDismiss(rec)}>
                        ✗ {t("ai.dismiss")}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Settings Page ────────────────────────────────────────────────────────────
function avatarColor(name = "") {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return `hsl(${h % 360},55%,45%)`;
}
function initials(name = "") {
  return name.split(" ").slice(0, 2).map(w => w[0]).join("").toUpperCase() || "?";
}
function pwStrength(pw = "") {
  let score = 0;
  if (pw.length >= 8)              score++;
  if (pw.length >= 12)             score++;
  if (/[A-Z]/.test(pw))           score++;
  if (/[0-9]/.test(pw))           score++;
  if (/[^A-Za-z0-9]/.test(pw))   score++;
  if (score <= 1) return { label: "Weak",   color: "var(--red)" };
  if (score === 2) return { label: "Fair",   color: "var(--amb)" };
  if (score === 3) return { label: "Good",   color: "#EAB308" };
  return              { label: "Strong", color: "var(--grn)" };
}

const WORKSPACE_ROLES = [
  { value: "admin",       label: "Admin",        desc: "Full access, can manage team" },
  { value: "analyst",     label: "Analyst",      desc: "View + edit campaigns and reports" },
  { value: "media_buyer", label: "Media Buyer",  desc: "Edit campaigns, bids, budgets" },
  { value: "ai_operator", label: "AI Operator",  desc: "Run AI analysis, apply recommendations" },
  { value: "read_only",   label: "Read Only",    desc: "View-only access" },
];

function Toggle({ checked, onChange }) {
  return (
    <button onClick={() => onChange(!checked)} style={{
      width: 40, height: 22, borderRadius: 11, border: "none", cursor: "pointer",
      background: checked ? "var(--grn)" : "var(--b2)", position: "relative", transition: "background .2s", flexShrink: 0,
    }}>
      <span style={{ position: "absolute", top: 3, left: checked ? 19 : 3, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left .2s" }} />
    </button>
  );
}

const SettingsPage = ({ workspaceId, user: appUser }) => {
  const { t } = useI18n();
  const [tab, setTab] = useState("profile");
  const [toast, setToast] = useState(null);
  const [saving, setSaving] = useState(false);

  // Profile state
  const [profile, setProfile] = useState(null);
  const [profileForm, setProfileForm] = useState({ name: "", email: "" });
  const [pwForm, setPwForm] = useState({ current_password: "", new_password: "", confirm: "" });
  const [pwErr, setPwErr] = useState("");

  // Workspace state
  const [wsData, setWsData] = useState(null);
  const [wsForm, setWsForm] = useState({ name: "", description: "", settings: {} });

  // Members state
  const [members, setMembers] = useState(null);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteForm, setInviteForm] = useState({ email: "", name: "", workspace_role: "analyst" });
  const [inviteErr, setInviteErr] = useState({});

  // Notifications state
  const [notifs, setNotifs] = useState(null);

  // Danger zone state
  const [showDeleteWs, setShowDeleteWs] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");

  function showToast(msg, isErr = false) {
    setToast({ msg, isErr });
    setTimeout(() => setToast(null), 3000);
  }

  // Load data when tab changes
  useEffect(() => {
    if (tab === "profile" && !profile) {
      get("/settings/profile").then(d => { setProfile(d); setProfileForm({ name: d.name, email: d.email }); }).catch(() => {});
    }
    if (tab === "workspace" && !wsData) {
      get("/settings/workspace").then(d => {
        setWsData(d);
        const s = typeof d.settings === "string" ? JSON.parse(d.settings) : (d.settings || {});
        setWsForm({ name: d.name, description: d.description || "", settings: s });
      }).catch(() => {});
    }
    if (tab === "team" && !members) {
      get("/settings/members").then(setMembers).catch(() => setMembers([]));
    }
    if (tab === "notifications" && !notifs) {
      get("/settings/notifications").then(setNotifs).catch(() => {});
    }
  }, [tab]);

  async function saveProfile() {
    setSaving(true);
    try {
      const d = await apiFetch("/settings/profile", { method: "PATCH", body: JSON.stringify(profileForm) });
      setProfile(d); showToast(t("settings.saveChanges") + " ✓");
    } catch (e) { showToast(e.message, true); }
    setSaving(false);
  }

  async function savePassword() {
    setPwErr("");
    if (pwForm.new_password !== pwForm.confirm) { setPwErr(t("settings.confirmPassword") + " mismatch"); return; }
    if (pwForm.new_password.length < 8) { setPwErr("Min 8 characters"); return; }
    setSaving(true);
    try {
      await apiFetch("/settings/profile/password", { method: "PATCH", body: JSON.stringify(pwForm) });
      setPwForm({ current_password: "", new_password: "", confirm: "" });
      showToast(t("settings.changePassword") + " ✓");
    } catch (e) { setPwErr(e.message); }
    setSaving(false);
  }

  async function saveWorkspace() {
    setSaving(true);
    try {
      const d = await apiFetch("/settings/workspace", { method: "PATCH", body: JSON.stringify(wsForm) });
      setWsData(d); showToast(t("settings.saveChanges") + " ✓");
    } catch (e) { showToast(e.message, true); }
    setSaving(false);
  }

  async function sendInvite() {
    const errs = {};
    if (!inviteForm.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteForm.email)) errs.email = "Valid email required";
    if (!inviteForm.name?.trim()) errs.name = "Name required";
    setInviteErr(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    try {
      await post("/settings/members/invite", inviteForm);
      showToast(t("settings.invite") + " sent!");
      setShowInvite(false);
      setInviteForm({ email: "", name: "", workspace_role: "analyst" });
      get("/settings/members").then(setMembers);
    } catch (e) { showToast(e.message, true); }
    setSaving(false);
  }

  async function changeMemberRole(userId, role) {
    if (!confirm(`Change role to ${role}?`)) return;
    try {
      await apiFetch(`/settings/members/${userId}/role`, { method: "PATCH", body: JSON.stringify({ role }) });
      get("/settings/members").then(setMembers);
      showToast("Role updated");
    } catch (e) { showToast(e.message, true); }
  }

  async function removeMember(userId, name) {
    if (!confirm(`Remove ${name} from workspace?`)) return;
    try {
      await apiFetch(`/settings/members/${userId}`, { method: "DELETE" });
      setMembers(m => m.filter(x => x.id !== userId));
      showToast("Member removed");
    } catch (e) { showToast(e.message, true); }
  }

  async function toggleNotif(key, val) {
    const next = { ...notifs, [key]: val };
    setNotifs(next);
    try { await apiFetch("/settings/notifications", { method: "PATCH", body: JSON.stringify(next) }); }
    catch (e) { showToast(e.message, true); }
  }

  async function deleteWorkspace() {
    if (deleteConfirm !== wsData?.name) return;
    try {
      await apiFetch("/settings/workspace", { method: "DELETE" });
      showToast("Workspace deleted");
      setShowDeleteWs(false);
      setTimeout(() => { localStorage.removeItem("af_token"); window.location.reload(); }, 1500);
    } catch (e) { showToast(e.message, true); }
  }

  const myRole = members?.find(m => m.id === appUser?.id)?.workspace_role;
  const canInvite = myRole === "owner" || myRole === "admin";
  const canManageRoles = myRole === "owner" || myRole === "admin";
  const canRemove = myRole === "owner" || myRole === "admin";
  const isOwner = myRole === "owner";

  const TABS = [
    { id: "profile",       icon: "👤", label: t("settings.profile") },
    { id: "workspace",     icon: "🏢", label: t("settings.workspace") },
    { id: "team",          icon: "👥", label: t("settings.team") },
    { id: "notifications", icon: "🔔", label: t("settings.notifications") },
    { id: "security",      icon: "🔒", label: t("settings.security") },
    { id: "danger",        icon: "⚠️", label: t("settings.dangerZone") },
  ];

  const SL = { fontSize: 10, color: "var(--tx3)", marginBottom: 6, fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: ".06em" };
  const INPUT_W = { width: "100%", marginBottom: 14 };
  const SECTION = { marginBottom: 24 };

  const roleBadge = role => {
    const colors = { owner: "bg-pur", admin: "bg-bl", analyst: "bg-grn", media_buyer: "bg-amb", ai_operator: "bg-teal", read_only: "bg-red" };
    return <span className={`badge ${colors[role] || "bg-grn"}`} style={{ fontSize: 10 }}>{role?.replace("_"," ")}</span>;
  };

  return (
    <div className="fade" style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
      {/* Toast */}
      {toast && createPortal(
        <div style={{ position: "fixed", top: 20, right: 20, zIndex: 9999, background: toast.isErr ? "var(--red)" : "var(--grn)", color: "#fff", padding: "10px 18px", borderRadius: 8, fontSize: 13, fontWeight: 600, boxShadow: "0 4px 20px rgba(0,0,0,.3)" }}>
          {toast.msg}
        </div>,
        document.body
      )}

      {/* Sidebar */}
      <div className="card" style={{ width: 200, padding: "8px 0", flexShrink: 0 }}>
        <div style={{ padding: "12px 16px 8px", fontSize: 11, color: "var(--tx3)", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: ".06em" }}>{t("settings.title")}</div>
        {TABS.map(tb => (
          <button key={tb.id} onClick={() => setTab(tb.id)} style={{
            display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 16px",
            background: tab === tb.id ? "var(--b1)" : "transparent", border: "none",
            borderLeft: tab === tb.id ? "2px solid var(--ac)" : "2px solid transparent",
            color: tab === tb.id ? "var(--tx)" : "var(--tx2)", cursor: "pointer", fontSize: 13,
            fontFamily: "var(--ui)", textAlign: "left", transition: "all .15s",
          }}>
            <span>{tb.icon}</span>{tb.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1 }}>
        <h1 style={{ fontFamily: "var(--disp)", fontSize: 20, fontWeight: 700, marginBottom: 20 }}>
          {TABS.find(x => x.id === tab)?.label}
        </h1>

        {/* ── Profile ── */}
        {tab === "profile" && (
          <div className="card" style={{ padding: 24 }}>
            {!profile ? <span className="loader" /> : <>
              <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
                <div style={{ width: 56, height: 56, borderRadius: "50%", background: avatarColor(profile.name), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, fontWeight: 700, color: "#fff", flexShrink: 0 }}>
                  {initials(profile.name)}
                </div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{profile.name}</div>
                  <div style={{ fontSize: 12, color: "var(--tx2)" }}>{profile.email}</div>
                  <div style={{ marginTop: 4 }}>{roleBadge(profile.role)}</div>
                </div>
              </div>
              <div style={SECTION}>
                <div style={SL}>{t("settings.profile")} Info</div>
                <div style={SL}>Name</div>
                <input value={profileForm.name} onChange={e => setProfileForm(f => ({...f, name: e.target.value}))} style={INPUT_W} />
                <div style={SL}>Email</div>
                <input value={profileForm.email} onChange={e => setProfileForm(f => ({...f, email: e.target.value}))} style={INPUT_W} />
                <div style={{ fontSize: 11, color: "var(--tx3)", marginBottom: 12 }}>
                  {t("settings.lastLogin")}: {relTime(profile.last_login_at) || "Never"}
                </div>
                <button className="btn btn-primary" onClick={saveProfile} disabled={saving}>
                  {saving ? <span className="loader" /> : t("settings.saveChanges")}
                </button>
              </div>
            </>}
          </div>
        )}

        {/* ── Workspace ── */}
        {tab === "workspace" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="card" style={{ padding: 24 }}>
              {!wsData ? <span className="loader" /> : <>
                <div style={SL}>Workspace Name</div>
                <input value={wsForm.name} onChange={e => setWsForm(f => ({...f, name: e.target.value}))} style={INPUT_W} />
                <div style={SL}>Description</div>
                <textarea value={wsForm.description} onChange={e => setWsForm(f => ({...f, description: e.target.value}))}
                  style={{ ...INPUT_W, height: 70, resize: "vertical", padding: "7px 12px", background: "var(--s2)", border: "1px solid var(--b2)", borderRadius: 7, color: "var(--tx)", fontFamily: "var(--ui)", fontSize: 13 }} />
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12, marginBottom: 14 }}>
                  {[
                    { key: "timezone", label: "Timezone", opts: ["UTC","Europe/Berlin","Europe/London","America/New_York","America/Los_Angeles","Asia/Tokyo"] },
                    { key: "default_attribution_window", label: "Attribution Window", opts: ["1d","7d","14d","30d"] },
                    { key: "currency", label: "Currency", opts: ["EUR","USD","GBP","JPY","CAD","AUD","PLN","SEK"] },
                  ].map(({ key, label, opts }) => (
                    <div key={key}>
                      <div style={SL}>{label}</div>
                      <select value={wsForm.settings[key] || opts[0]} onChange={e => setWsForm(f => ({...f, settings: {...f.settings, [key]: e.target.value}}))} style={{ width: "100%", minWidth: 200 }}>
                        {opts.map(o => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
                <button className="btn btn-primary" onClick={saveWorkspace} disabled={saving}>
                  {saving ? <span className="loader" /> : t("settings.saveChanges")}
                </button>
              </>}
            </div>
            {wsData && (
              <div className="card" style={{ padding: 20 }}>
                <div style={SL}>Organization</div>
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <span style={{ fontWeight: 600 }}>{wsData.org_name}</span>
                  <span className="badge bg-bl" style={{ fontSize: 10 }}>{wsData.plan}</span>
                  <span style={{ fontSize: 11, color: "var(--tx3)", fontFamily: "var(--mono)" }}>{wsData.slug}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Team ── */}
        {tab === "team" && (
          <div className="card" style={{ overflow: "hidden" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid var(--b1)" }}>
              <div style={{ fontWeight: 600 }}>Members ({members?.length ?? "…"})</div>
              {canInvite && (
                <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={() => setShowInvite(true)}>+ {t("settings.invite")}</button>
              )}
            </div>
            {!members ? <div style={{ padding: 40, textAlign: "center" }}><span className="loader" /></div> : (
              <table>
                <thead><tr>
                  <th>Member</th>
                  <th>{t("settings.role")}</th>
                  <th>{t("settings.lastLogin")}</th>
                  <th></th>
                </tr></thead>
                <tbody>
                  {members.map(m => (
                    <tr key={m.id}>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <div style={{ width: 32, height: 32, borderRadius: "50%", background: avatarColor(m.name), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: "#fff", flexShrink: 0 }}>{initials(m.name)}</div>
                          <div>
                            <div style={{ fontWeight: 500, fontSize: 13 }}>{m.name}</div>
                            <div style={{ fontSize: 11, color: "var(--tx3)" }}>{m.email}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        {canManageRoles && m.workspace_role !== "owner" && m.id !== appUser?.id ? (
                          <select value={m.workspace_role} onChange={e => changeMemberRole(m.id, e.target.value)}
                            style={{ fontSize: 11, padding: "3px 6px", background: "var(--s2)", border: "1px solid var(--b2)", borderRadius: 5, color: "var(--tx)" }}>
                            {WORKSPACE_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                          </select>
                        ) : roleBadge(m.workspace_role)}
                      </td>
                      <td style={{ fontSize: 11, color: "var(--tx3)" }}>{relTime(m.last_login_at) || "Never"}</td>
                      <td>
                        {canRemove && m.workspace_role !== "owner" && m.id !== appUser?.id && (
                          <button className="btn btn-red" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => removeMember(m.id, m.name)}>
                            {t("settings.remove")}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ── Notifications ── */}
        {tab === "notifications" && (
          <div className="card" style={{ padding: 24 }}>
            {!notifs ? <span className="loader" /> : <>
              {[
                { heading: "Email Notifications", keys: [
                  { key: "email_alerts",        label: "Campaign alerts" },
                  { key: "email_weekly_report", label: "Weekly report" },
                  { key: "email_ai_summary",    label: "AI summary" },
                ]},
                { heading: "Alert Types", keys: [
                  { key: "alert_acos",       label: "High ACoS" },
                  { key: "alert_budget",     label: "Budget overrun" },
                  { key: "alert_roas",       label: "ROAS drop" },
                  { key: "alert_zero_spend", label: "Zero-spend campaigns" },
                ]},
              ].map(({ heading, keys }) => (
                <div key={heading} style={{ marginBottom: 24 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12, color: "var(--tx2)" }}>{heading}</div>
                  {keys.map(({ key, label }) => (
                    <div key={key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                      <span style={{ fontSize: 13 }}>{label}</span>
                      <Toggle checked={!!notifs[key]} onChange={v => toggleNotif(key, v)} />
                    </div>
                  ))}
                </div>
              ))}
            </>}
          </div>
        )}

        {/* ── Security ── */}
        {tab === "security" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="card" style={{ padding: 24 }}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 16 }}>{t("settings.changePassword")}</div>
              <div style={SL}>{t("settings.currentPassword")}</div>
              <input type="password" value={pwForm.current_password} onChange={e => setPwForm(f => ({...f, current_password: e.target.value}))} style={INPUT_W} />
              <div style={SL}>{t("settings.newPassword")}</div>
              <input type="password" value={pwForm.new_password} onChange={e => setPwForm(f => ({...f, new_password: e.target.value}))} style={{ ...INPUT_W, marginBottom: 6 }} />
              {pwForm.new_password && (() => {
                const s = pwStrength(pwForm.new_password);
                return <div style={{ fontSize: 11, color: s.color, marginBottom: 14, fontWeight: 600 }}>{s.label}</div>;
              })()}
              <div style={SL}>{t("settings.confirmPassword")}</div>
              <input type="password" value={pwForm.confirm} onChange={e => setPwForm(f => ({...f, confirm: e.target.value}))} style={INPUT_W} />
              {pwErr && <div style={{ fontSize: 12, color: "var(--red)", marginBottom: 12 }}>{pwErr}</div>}
              <button className="btn btn-primary" onClick={savePassword} disabled={saving}>
                {saving ? <span className="loader" /> : t("settings.changePassword")}
              </button>
            </div>
            <div className="card" style={{ padding: 20 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Current Session</div>
              <div style={{ fontSize: 12, color: "var(--tx2)", marginBottom: 12 }}>{navigator.userAgent.slice(0, 80)}</div>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => showToast("Feature coming soon")}>
                Sign out all other sessions
              </button>
            </div>
          </div>
        )}

        {/* ── Danger Zone ── */}
        {tab === "danger" && (
          <div className="card" style={{ padding: 24, border: "1px solid var(--red)" }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: "var(--red)", marginBottom: 8 }}>{t("settings.deleteWorkspace")}</div>
            <div style={{ fontSize: 13, color: "var(--tx2)", marginBottom: 16 }}>
              This action is irreversible. All data, campaigns and rules will be deleted.
            </div>
            <button className="btn btn-red" disabled={!isOwner} onClick={() => setShowDeleteWs(true)}>
              {t("settings.deleteWorkspace")}
            </button>
            {!isOwner && <div style={{ fontSize: 11, color: "var(--tx3)", marginTop: 8 }}>Only the workspace owner can delete it.</div>}
          </div>
        )}
      </div>

      {/* ── Invite Modal ── */}
      {showInvite && createPortal(
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 1000, overflowY: "auto", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 20px", boxSizing: "border-box" }}>
          <div style={{ background: "#1a1d2e", borderRadius: 12, padding: 28, width: "100%", maxWidth: 480, margin: "0 auto" }}>
            <div style={{ fontFamily: "var(--disp)", fontSize: 16, fontWeight: 700, marginBottom: 20 }}>{t("settings.inviteMember")}</div>
            <div style={SL}>Email</div>
            <input value={inviteForm.email} onChange={e => setInviteForm(f => ({...f, email: e.target.value}))} style={{ width: "100%", marginBottom: inviteErr.email ? 4 : 14 }} placeholder="colleague@example.com" />
            {inviteErr.email && <div style={{ fontSize: 11, color: "var(--red)", marginBottom: 10 }}>{inviteErr.email}</div>}
            <div style={SL}>Name</div>
            <input value={inviteForm.name} onChange={e => setInviteForm(f => ({...f, name: e.target.value}))} style={{ width: "100%", marginBottom: inviteErr.name ? 4 : 14 }} placeholder="Full name" />
            {inviteErr.name && <div style={{ fontSize: 11, color: "var(--red)", marginBottom: 10 }}>{inviteErr.name}</div>}
            <div style={SL}>{t("settings.role")}</div>
            <select value={inviteForm.workspace_role} onChange={e => setInviteForm(f => ({...f, workspace_role: e.target.value}))} style={{ width: "100%", marginBottom: 8 }}>
              {WORKSPACE_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
            <div style={{ fontSize: 11, color: "var(--tx3)", marginBottom: 20 }}>
              {WORKSPACE_ROLES.find(r => r.value === inviteForm.workspace_role)?.desc}
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn btn-primary" onClick={sendInvite} disabled={saving}>{saving ? <span className="loader" /> : t("settings.invite")}</button>
              <button className="btn btn-ghost" onClick={() => { setShowInvite(false); setInviteErr({}); }}>{t("common.cancel")}</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── Delete Workspace Modal ── */}
      {showDeleteWs && createPortal(
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 1000, overflowY: "auto", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 20px", boxSizing: "border-box" }}>
          <div style={{ background: "#1a1d2e", borderRadius: 12, padding: 28, width: "100%", maxWidth: 460, margin: "0 auto" }}>
            <div style={{ fontFamily: "var(--disp)", fontSize: 16, fontWeight: 700, color: "var(--red)", marginBottom: 12 }}>Delete Workspace</div>
            <div style={{ fontSize: 13, color: "var(--tx2)", marginBottom: 16 }}>
              Type <strong style={{ color: "var(--tx)" }}>{wsData?.name}</strong> to confirm deletion:
            </div>
            <input value={deleteConfirm} onChange={e => setDeleteConfirm(e.target.value)} style={{ width: "100%", marginBottom: 20 }} placeholder={wsData?.name} />
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn btn-red" disabled={deleteConfirm !== wsData?.name} onClick={deleteWorkspace}>Confirm Delete</button>
              <button className="btn btn-ghost" onClick={() => { setShowDeleteWs(false); setDeleteConfirm(""); }}>{t("common.cancel")}</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

const PlaceholderPage = ({ title, desc }) => {
  const { t } = useI18n();
  return (
    <div className="fade">
      <h1 style={{ fontFamily: "var(--disp)", fontSize: 22, fontWeight: 700, marginBottom: 8 }}>{title}</h1>
      <div style={{ fontSize: 13, color: "var(--tx2)", marginBottom: 20 }}>{desc}</div>
      <div className="card" style={{ padding: "60px 32px", textAlign: "center", borderStyle: "dashed" }}>
        <div style={{ fontSize: 36, marginBottom: 12, color: "var(--tx3)" }}>⚙</div>
        <div style={{ fontSize: 14, color: "var(--tx3)" }}>{t("placeholder.inDev")}</div>
      </div>
    </div>
  );
};

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const { t } = useI18n();
  const [authed, setAuthed] = useState(!!localStorage.getItem("af_token"));
  const [user, setUser] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [active, setActive] = useState("overview");
  const [syncTrigger, setSyncTrigger] = useState(0);

  // Handle OAuth callback on page load
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("code") && params.get("state")) {
      setActive("connect");
    }
  }, []);

  // Load user on mount
  useEffect(() => {
    if (!authed) return;
    apiFetch("/auth/me").then(data => {
      setUser(data.user);
      if (data.workspaces?.[0]) {
        setWorkspace(data.workspaces[0]);
        localStorage.setItem("af_workspace", data.workspaces[0].id);
      }
    }).catch(() => {
      localStorage.removeItem("af_token");
      setAuthed(false);
    });
  }, [authed]);

  function handleLogin(data) {
    setAuthed(true);
    setUser(data.user);
    if (data.workspaces?.[0]) {
      setWorkspace(data.workspaces[0]);
    }
  }

  if (!authed) return <LoginPage onLogin={handleLogin} />;

  const wid = workspace?.id || localStorage.getItem("af_workspace");

  const pages = {
    overview: <OverviewPage workspaceId={wid} />,
    campaigns: <CampaignsPage workspaceId={wid} />,
    keywords: <KeywordsPage workspaceId={wid} />,
    reports: <ReportsPage workspaceId={wid} />,
    rules: <RulesPage workspaceId={wid} />,
    alerts: <AlertsPage workspaceId={wid} />,
    ai: <AIPage workspaceId={wid} />,
    audit: <AuditPage workspaceId={wid} />,
    connect: <ConnectPage workspaceId={wid} onConnected={() => { setActive("overview"); setSyncTrigger(t => t + 1); }} onSyncStarted={() => setSyncTrigger(t => t + 1)} />,
    settings: <SettingsPage workspaceId={wid} user={user} />,
  };

  return (
    <>
      <Styles />
      <div style={{ display: "flex", minHeight: "100vh" }}>
        <Sidebar active={active} setActive={setActive} user={user} workspace={workspace} />
        <main style={{ marginLeft: 220, flex: 1, padding: "26px 30px", minHeight: "100vh", overflow: "auto" }}>
          {pages[active]}
        </main>
      </div>
      <SyncStatusToast triggerShow={syncTrigger} />
    </>
  );
}
