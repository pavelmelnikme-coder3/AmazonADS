import { useState, useEffect, useRef, useCallback } from "react";

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
const get = (p, q) => apiFetch(p + (q ? "?" + new URLSearchParams(q) : ""));
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
  { id: "overview", icon: "⬡", label: "Overview" },
  { id: "campaigns", icon: "◈", label: "Campaigns" },
  { id: "keywords", icon: "◇", label: "Keywords" },
  { id: "reports", icon: "≋", label: "Reports" },
  { id: "rules", icon: "⟁", label: "Rules" },
  { id: "alerts", icon: "◎", label: "Alerts" },
  { id: "ai", icon: "✦", label: "AI Assistant" },
  { id: "audit", icon: "⊡", label: "Audit Log" },
  { id: "connect", icon: "⊕", label: "Connections" },
  { id: "settings", icon: "⊛", label: "Settings" },
];

const Sidebar = ({ active, setActive, user, workspace }) => (
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
        <div style={{ fontSize: 9, color: "var(--tx3)", fontFamily: "var(--mono)", marginBottom: 3, letterSpacing: ".06em" }}>WORKSPACE</div>
        <div style={{ fontSize: 12, fontWeight: 500 }}>{workspace.name}</div>
      </div>
    )}

    <nav style={{ flex: 1, padding: "6px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
      {NAV.map(({ id, icon, label }) => (
        <button key={id} onClick={() => setActive(id)} style={{
          display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 7,
          background: active === id ? "var(--s3)" : "transparent",
          border: active === id ? "1px solid var(--b2)" : "1px solid transparent",
          color: active === id ? "var(--tx)" : "var(--tx2)",
          cursor: "pointer", fontSize: 13, fontFamily: "var(--ui)", width: "100%", textAlign: "left",
          transition: "all .15s", position: "relative"
        }}>
          <span style={{ fontSize: 14, width: 18, textAlign: "center", color: active === id ? "var(--ac2)" : "var(--tx3)" }}>{icon}</span>
          {label}
          {active === id && <span style={{ position: "absolute", right: 0, top: "50%", transform: "translateY(-50%)", width: 3, height: 18, background: "var(--ac)", borderRadius: "2px 0 0 2px" }} />}
        </button>
      ))}
    </nav>

    <div style={{ padding: "12px 14px", borderTop: "1px solid var(--b1)", display: "flex", alignItems: "center", gap: 10 }}>
      <div style={{ width: 28, height: 28, borderRadius: "50%", background: "linear-gradient(135deg,#3B82F6,#8B5CF6)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 600, color: "#fff" }}>
        {user?.name?.slice(0, 2).toUpperCase() || "??"}
      </div>
      <div>
        <div style={{ fontSize: 12, fontWeight: 500 }}>{user?.name || "—"}</div>
        <div style={{ fontSize: 10, color: "var(--tx3)", fontFamily: "var(--mono)" }}>{user?.role || ""}</div>
      </div>
    </div>
  </aside>
);

// ─── Connect / OAuth Page ─────────────────────────────────────────────────────
const ConnectPage = ({ workspaceId, onConnected }) => {
  const [step, setStep] = useState("list"); // list, connecting, profiles, done
  const [connections, setConnections] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [currentConnection, setCurrentConnection] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);

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
      const { url, state } = await get("/connections/amazon/init");
      localStorage.setItem("af_oauth_state", state);
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
      setError("Security validation failed. Please try again.");
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
    if (!confirm("Disconnect this Amazon account? All tokens will be deleted.")) return;
    await del(`/connections/${id}`);
    setConnections(c => c.filter(x => x.id !== id));
  }

  return (
    <div className="fade">
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontFamily: "var(--disp)", fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Amazon Connections</h1>
        <div style={{ fontSize: 13, color: "var(--tx2)" }}>Подключите рекламные аккаунты через Login with Amazon (LwA) OAuth 2.0</div>
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
                <thead><tr><th>Аккаунт</th><th>Профили</th><th>Статус</th><th>Обновлён</th><th></th></tr></thead>
                <tbody>
                  {connections.map(c => (
                    <tr key={c.id}>
                      <td><span className="mono" style={{ fontSize: 11, color: "var(--tx2)" }}>{c.id.slice(0, 8)}…</span> {c.amazon_email || ""}</td>
                      <td className="num">{c.profile_count}</td>
                      <td><span className={`badge ${c.status === "active" ? "bg-grn" : "bg-red"}`}>● {c.status}</span></td>
                      <td style={{ color: "var(--tx3)", fontSize: 12 }}>{c.last_refresh_at ? new Date(c.last_refresh_at).toLocaleString("ru") : "—"}</td>
                      <td>
                        <button className="btn btn-red" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => revokeConnection(c.id)}>Отключить</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="card" style={{ padding: "40px 32px", textAlign: "center", border: "1px dashed var(--b2)" }}>
            <div style={{ fontSize: 40, marginBottom: 16 }}>⬡</div>
            <div style={{ fontFamily: "var(--disp)", fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Подключить Amazon Ads</div>
            <div style={{ fontSize: 13, color: "var(--tx2)", marginBottom: 24, maxWidth: 400, margin: "0 auto 24px" }}>
              Авторизуйтесь через Login with Amazon для доступа к Sponsored Products, Brands и Display кампаниям
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center", maxWidth: 320, margin: "0 auto" }}>
              <button className="btn btn-amazon" style={{ width: "100%", justifyContent: "center", padding: "12px 20px", fontSize: 14 }}
                onClick={startConnect} disabled={loading}>
                {loading ? <span className="loader" style={{ borderTopColor: "#111" }} /> : "🛍"} Connect Amazon Ads Account
              </button>

              <div style={{ fontSize: 11, color: "var(--tx3)", textAlign: "center", lineHeight: 1.5 }}>
                Вы будете перенаправлены на amazon.com для авторизации.<br/>
                Токены хранятся в зашифрованном виде на сервере.
              </div>
            </div>

            <div style={{ marginTop: 28, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, maxWidth: 500, margin: "28px auto 0" }}>
              {[
                { icon: "🔒", label: "Безопасно", desc: "OAuth 2.0 + AES-256 шифрование" },
                { icon: "⚡", label: "Быстро", desc: "Первые данные через 2-5 минут" },
                { icon: "♻", label: "Авто-sync", desc: "Обновление каждые 2 часа" },
              ].map(({ icon, label, desc }) => (
                <div key={label} style={{ padding: "14px", background: "var(--s2)", borderRadius: 8, border: "1px solid var(--b1)" }}>
                  <div style={{ fontSize: 20, marginBottom: 6 }}>{icon}</div>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 3 }}>{label}</div>
                  <div style={{ fontSize: 11, color: "var(--tx3)" }}>{desc}</div>
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
          <div style={{ fontFamily: "var(--disp)", fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Обмен токенами...</div>
          <div style={{ fontSize: 13, color: "var(--tx2)" }}>Устанавливаем защищённое соединение с Amazon Ads API</div>
        </div>
      )}

      {/* Step: Select Profiles */}
      {step === "profiles" && (
        <div className="fade">
          <div className="card" style={{ marginBottom: 16, padding: "16px 20px", borderColor: "rgba(34,197,94,.2)" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span style={{ fontSize: 20 }}>✓</span>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>Amazon аккаунт подключён!</div>
                <div style={{ fontSize: 12, color: "var(--tx2)" }}>Найдено {profiles.length} профилей. Выберите, какие подключить к этому workspace.</div>
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
              Подключить выбранные ({selected.size})
            </button>
            <button className="btn btn-ghost" onClick={() => { setStep("list"); }}>Отмена</button>
          </div>
        </div>
      )}

      {/* Step: Done */}
      {step === "done" && (
        <div className="card fade" style={{ padding: "40px 32px", textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🎉</div>
          <div style={{ fontFamily: "var(--disp)", fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Готово!</div>
          <div style={{ fontSize: 13, color: "var(--tx2)", marginBottom: 20 }}>{msg}</div>
          <button className="btn btn-primary" onClick={() => setStep("list")}>К подключениям</button>
        </div>
      )}
    </div>
  );
};

// ─── Overview Page (real data) ────────────────────────────────────────────────
const OverviewPage = ({ workspaceId }) => {
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
  const t = summary?.totals || {};
  const d = summary?.deltas || {};
  const trend = summary?.trend || [];

  const kpis = [
    { label: "Total Spend", value: hasData ? `$${parseFloat(t.spend).toLocaleString("en", { maximumFractionDigits: 0 })}` : "—", delta: d.spend, color: "#60A5FA" },
    { label: "Total Sales", value: hasData ? `$${parseFloat(t.sales).toLocaleString("en", { maximumFractionDigits: 0 })}` : "—", delta: d.sales, color: "#22C55E" },
    { label: "ACOS", value: hasData ? `${parseFloat(t.acos).toFixed(1)}%` : "—", delta: d.acos, color: "#F59E0B" },
    { label: "ROAS", value: hasData ? `${parseFloat(t.roas).toFixed(2)}×` : "—", delta: d.roas, color: "#A78BFA" },
    { label: "Clicks", value: hasData ? parseInt(t.clicks).toLocaleString() : "—", delta: null, color: "#14B8A6" },
    { label: "Impressions", value: hasData ? (parseInt(t.impressions) / 1000).toFixed(0) + "K" : "—", delta: null, color: "#F472B6" },
  ];

  const spendTrend = trend.map(r => parseFloat(r.spend));
  const activeProfiles = profiles?.filter(p => p.sync_status === "synced") || [];

  return (
    <div className="fade">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }}>
        <div>
          <h1 style={{ fontFamily: "var(--disp)", fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Overview</h1>
          <div style={{ fontSize: 13, color: "var(--tx2)" }}>
            {activeProfiles.length > 0
              ? `${activeProfiles.length} профилей синхронизировано`
              : <span style={{ color: "var(--amb)" }}>⚠ Нет синхронизированных профилей — <span style={{ color: "var(--ac2)", cursor: "pointer" }} onClick={() => {}}>подключите Amazon</span></span>
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
          <strong style={{ color: "var(--ac2)" }}>Нет данных.</strong>{" "}
          <span style={{ color: "var(--tx2)" }}>Подключите Amazon аккаунт, выберите профили и подождите первого синка (~2-5 мин).</span>
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
          <div style={{ fontFamily: "var(--disp)", fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Spend по дням</div>
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
          <div style={{ padding: "14px 18px 10px", fontFamily: "var(--disp)", fontSize: 14, fontWeight: 600 }}>Топ кампании</div>
          <table>
            <thead><tr><th>Кампания</th><th>Тип</th><th style={{ textAlign: "right" }}>Spend</th><th style={{ textAlign: "right" }}>Sales</th><th style={{ textAlign: "right" }}>ACOS</th><th style={{ textAlign: "right" }}>ROAS</th></tr></thead>
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

// ─── Campaigns Page (real data) ───────────────────────────────────────────────
const CampaignsPage = ({ workspaceId }) => {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [editId, setEditId] = useState(null);
  const [editState, setEditState] = useState(null);
  const [saving, setSaving] = useState(false);

  const { data, loading, reload } = useAsync(
    () => workspaceId
      ? get("/campaigns", { status: filter !== "all" ? filter : undefined, search: search || undefined, limit: 100 })
      : Promise.resolve({ data: [], pagination: {} }),
    [workspaceId, filter, search]
  );

  const campaigns = data?.data || [];

  async function updateCampaign(id, updates) {
    setSaving(true);
    try {
      await patch(`/campaigns/${id}`, updates);
      reload();
      setEditId(null);
    } catch (e) {
      alert("Ошибка: " + e.message);
    }
    setSaving(false);
  }

  const typeLabel = t => ({ sponsoredProducts: "SP", sponsoredBrands: "SB", sponsoredDisplay: "SD" })[t] || t;

  return (
    <div className="fade">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <div>
          <h1 style={{ fontFamily: "var(--disp)", fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Campaigns</h1>
          <div style={{ fontSize: 13, color: "var(--tx2)" }}>{data?.pagination?.total ?? "—"} кампаний</div>
        </div>
        <button className="btn btn-primary">+ Новая кампания</button>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <input placeholder="🔍 Поиск..." value={search} onChange={e => setSearch(e.target.value)} style={{ width: 200 }} />
        {["all", "enabled", "paused", "archived"].map(f => (
          <button key={f} onClick={() => setFilter(f)} className={`btn ${filter === f ? "btn-primary" : "btn-ghost"}`} style={{ fontSize: 12, padding: "5px 12px" }}>
            {f === "all" ? "Все" : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        <button className="btn btn-ghost" style={{ fontSize: 12, marginLeft: "auto" }} onClick={reload}>↺ Обновить</button>
      </div>

      <div className="card" style={{ overflow: "hidden" }}>
        {loading
          ? <div style={{ padding: "40px", textAlign: "center", color: "var(--tx3)" }}><span className="loader" style={{ width: 20, height: 20 }} /></div>
          : campaigns.length === 0
            ? <div style={{ padding: "40px", textAlign: "center", color: "var(--tx3)" }}>Нет кампаний. Подключите Amazon аккаунт и дождитесь синка.</div>
            : (
              <div style={{ overflowX: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Название</th><th>Тип</th><th>Статус</th>
                      <th style={{ textAlign: "right" }}>Бюджет/д</th>
                      <th style={{ textAlign: "right" }}>Spend</th>
                      <th style={{ textAlign: "right" }}>Sales</th>
                      <th style={{ textAlign: "right" }}>ACOS</th>
                      <th style={{ textAlign: "right" }}>ROAS</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaigns.map(c => (
                      <tr key={c.id}>
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
                                Изм.
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
    </div>
  );
};

// ─── Reports Page ─────────────────────────────────────────────────────────────
const ReportsPage = ({ workspaceId }) => {
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
    if (!form.startDate || !form.endDate) return alert("Укажите период");
    const profileId = profilesList?.[0]?.id;
    if (!profileId) return alert("Нет подключённых профилей");

    setSubmitting(true);
    try {
      const res = await post("/reports", { ...form, profileId });
      setSubmitted(res);
      reload();
    } catch (e) {
      alert("Ошибка: " + e.message);
    }
    setSubmitting(false);
  }

  return (
    <div className="fade">
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontFamily: "var(--disp)", fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Reports</h1>
        <div style={{ fontSize: 13, color: "var(--tx2)" }}>Amazon Ads Reporting API v3 · Async pipeline</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: 16 }}>
        <div className="card" style={{ padding: "18px 20px", height: "fit-content" }}>
          <div style={{ fontFamily: "var(--disp)", fontSize: 14, fontWeight: 600, marginBottom: 16 }}>Новый отчёт</div>
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
            <div style={{ fontSize: 10, color: "var(--tx3)", marginBottom: 6, fontFamily: "var(--mono)", letterSpacing: ".06em", textTransform: "uppercase" }}>Период</div>
            <div style={{ display: "flex", gap: 8 }}>
              <input type="date" value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} style={{ flex: 1, fontSize: 12 }} />
              <input type="date" value={form.endDate} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} style={{ flex: 1, fontSize: 12 }} />
            </div>
          </div>
          <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center" }} onClick={submitReport} disabled={submitting}>
            {submitting ? <span className="loader" /> : "▶ Запустить отчёт"}
          </button>
          {submitted && <div style={{ marginTop: 10, fontSize: 12, color: "var(--teal)" }}>✓ Поставлен в очередь (jobId: {submitted.jobId?.slice(0, 8)})</div>}
        </div>

        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ padding: "12px 16px 8px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontFamily: "var(--disp)", fontSize: 14, fontWeight: 600 }}>История отчётов</div>
            <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={reload}>↺</button>
          </div>
          {loading
            ? <div style={{ padding: 30, textAlign: "center" }}><span className="loader" /></div>
            : !reports?.length
              ? <div style={{ padding: "30px 20px", textAlign: "center", color: "var(--tx3)", fontSize: 13 }}>Нет отчётов</div>
              : (
                <table>
                  <thead><tr><th>Тип</th><th>Период</th><th>Статус</th><th>Строк</th><th>Создан</th></tr></thead>
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
  const { data: events, loading, reload } = useAsync(
    () => workspaceId ? get("/audit", { limit: 50 }) : Promise.resolve([]),
    [workspaceId]
  );

  return (
    <div className="fade">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: "var(--disp)", fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Audit Log</h1>
          <div style={{ fontSize: 13, color: "var(--tx2)" }}>Все изменения · append-only</div>
        </div>
        <button className="btn btn-ghost" onClick={reload}>↺</button>
      </div>
      <div className="card" style={{ overflow: "hidden" }}>
        {loading
          ? <div style={{ padding: 40, textAlign: "center" }}><span className="loader" /></div>
          : !events?.length
            ? <div style={{ padding: "40px", textAlign: "center", color: "var(--tx3)" }}>Нет событий</div>
            : (
              <table>
                <thead><tr><th>Время</th><th>Пользователь</th><th>Действие</th><th>Сущность</th><th>Источник</th></tr></thead>
                <tbody>
                  {events.map(e => (
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

// ─── Login Page ───────────────────────────────────────────────────────────────
const LoginPage = ({ onLogin }) => {
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
          <div style={{ fontSize: 12, color: "var(--tx3)" }}>Amazon Ads Dashboard</div>
        </div>

        <div style={{ display: "flex", gap: 0, marginBottom: 20, background: "var(--s2)", borderRadius: 8, padding: 3 }}>
          {["login", "register"].map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              flex: 1, padding: "7px", borderRadius: 6, border: "none", cursor: "pointer",
              background: tab === t ? "var(--s3)" : "transparent",
              color: tab === t ? "var(--tx)" : "var(--tx3)", fontSize: 13, fontFamily: "var(--ui)",
              transition: "all .15s"
            }}>
              {t === "login" ? "Войти" : "Регистрация"}
            </button>
          ))}
        </div>

        {error && <div style={{ marginBottom: 14, padding: "10px 14px", background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.2)", borderRadius: 8, color: "var(--red)", fontSize: 12 }}>{error}</div>}

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {tab === "register" && (
            <>
              <input placeholder="Ваше имя" {...f("name")} />
              <input placeholder="Название организации" {...f("orgName")} />
            </>
          )}
          <input placeholder="Email" type="email" {...f("email")} />
          <input placeholder="Пароль (мин. 8 символов)" type="password" {...f("password")}
            onKeyDown={e => e.key === "Enter" && submit()} />
          <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center", padding: "10px" }} onClick={submit} disabled={loading}>
            {loading ? <span className="loader" /> : tab === "login" ? "Войти" : "Создать аккаунт"}
          </button>
        </div>

        {tab === "login" && (
          <div style={{ marginTop: 14, padding: "10px 14px", background: "rgba(59,130,246,.06)", border: "1px solid rgba(59,130,246,.12)", borderRadius: 8, fontSize: 11, color: "var(--tx3)" }}>
            💡 Для демо: зарегистрируйтесь, затем подключите Amazon аккаунт в разделе Connections
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Placeholder pages ────────────────────────────────────────────────────────
const PlaceholderPage = ({ title, desc }) => (
  <div className="fade">
    <h1 style={{ fontFamily: "var(--disp)", fontSize: 22, fontWeight: 700, marginBottom: 8 }}>{title}</h1>
    <div style={{ fontSize: 13, color: "var(--tx2)", marginBottom: 20 }}>{desc}</div>
    <div className="card" style={{ padding: "60px 32px", textAlign: "center", borderStyle: "dashed" }}>
      <div style={{ fontSize: 36, marginBottom: 12, color: "var(--tx3)" }}>⚙</div>
      <div style={{ fontSize: 14, color: "var(--tx3)" }}>Раздел в разработке — следующий спринт</div>
    </div>
  </div>
);

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [authed, setAuthed] = useState(!!localStorage.getItem("af_token"));
  const [user, setUser] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [active, setActive] = useState("overview");

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
    keywords: <PlaceholderPage title="Keywords / Targets" desc="Управление ключевыми словами и таргетингом" />,
    reports: <ReportsPage workspaceId={wid} />,
    rules: <PlaceholderPage title="Rule Engine" desc="Автоматические правила оптимизации" />,
    alerts: <PlaceholderPage title="Alerts" desc="Уведомления по метрикам" />,
    ai: <PlaceholderPage title="AI Assistant" desc="Рекомендации и автопилот" />,
    audit: <AuditPage workspaceId={wid} />,
    connect: <ConnectPage workspaceId={wid} onConnected={() => setActive("overview")} />,
    settings: <PlaceholderPage title="Settings" desc="Настройки аккаунта и интеграций" />,
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
    </>
  );
}
