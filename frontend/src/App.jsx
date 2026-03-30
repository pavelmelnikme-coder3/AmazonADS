import React, { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "./i18n/index.jsx";
import LanguageSwitcher from "./components/LanguageSwitcher.jsx";
import SyncStatusToast from "./components/SyncStatusToast.jsx";
import {
  Activity, Megaphone, Tag, Package, Newspaper,
  Layers, Workflow, Bell, Sparkles, History, Cable, Cog,
  Repeat, Edit2, Trash2, Play, Eye,
  Pause, Power, Percent, Target,
  Ban, Undo2, Download, Filter, ArrowUpDown,
  ChevronUp, ChevronDown, Search, X, Check, AlertCircle,
  Lock, Archive,
  CircleCheck, Hourglass, Frown,
  ArrowUp, ArrowDown, Link, Zap,
  BrainCircuit, Bot,
  FileText, Settings2,
  ChevronRight, ChevronLeft, ChevronsUpDown,
  Minus, MoreVertical, Calendar,
  DollarSign, Hash, LayoutGrid,
  TrendingUp, TrendingDown,
  RotateCcw, RefreshCw, PenLine,
  SlidersHorizontal, Pencil, MoreHorizontal,
  BarChart2, FileBarChart, Settings, Orbit, Plug2,
  HelpCircle, LogOut, Plus, Sun, Moon, Copy
} from 'lucide-react';

// Unified icon size helper
const Ic = ({ icon: Icon, size = 14, color, style, className }) => (
  <Icon
    size={size}
    strokeWidth={1.75}
    color={color}
    style={style}
    className={className}
  />
);

// ─── Styles ───────────────────────────────────────────────────────────────────
const Styles = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Mono:wght@300;400;500&family=Outfit:wght@300;400;500;600&display=swap');
    :root{--bg:#070C18;--s1:#0D1425;--s2:#141D30;--s3:#1C2640;--b1:#1E2A40;--b2:#26344E;
    --ac:#3B82F6;--ac2:#60A5FA;--teal:#14B8A6;--amb:#F59E0B;--red:#EF4444;--grn:#22C55E;
    --pur:#A78BFA;--tx:#E2E8F0;--tx2:#94A3B8;--tx3:#4A5568;
    --mono:'DM Mono',monospace;--ui:'Outfit',sans-serif;--disp:'Syne',sans-serif;}
    [data-theme="light"]{
      --bg:#F0F4F8;--s1:#FFFFFF;--s2:#F1F5F9;--s3:#E2E8F0;--b1:#E2E8F0;--b2:#CBD5E1;
      --ac:#2563EB;--ac2:#3B82F6;--teal:#0D9488;--amb:#D97706;--red:#DC2626;--grn:#16A34A;
      --pur:#7C3AED;--tx:#0F172A;--tx2:#475569;--tx3:#94A3B8;
    }
    [data-theme="light"] body{background:var(--bg);color:var(--tx);}
    [data-theme="light"] ::-webkit-scrollbar-track{background:var(--s2);}
    [data-theme="light"] ::-webkit-scrollbar-thumb{background:var(--b2);}
    [data-theme="light"] tr:hover td{background:rgba(0,0,0,.025)}
    [data-theme="light"] .loader{border-color:rgba(0,0,0,.15);border-top-color:var(--tx2);}
    [data-theme="light"] .tag-on{background:rgba(22,163,74,.1);color:#15803d}
    [data-theme="light"] .tag-pause{background:rgba(217,119,6,.1);color:#b45309}
    [data-theme="light"] .tag-arch{background:rgba(100,116,139,.12);color:#475569}
    [data-theme="light"] .btn-ghost{color:var(--tx2);border-color:var(--b2);}
    [data-theme="light"] .btn-ghost:hover{background:var(--s3);color:var(--tx);}
    [data-theme="light"] .card{background:var(--s1);border-color:var(--b1);}
    [data-theme="light"] .card:hover{border-color:var(--b2);}
    [data-theme="light"] .audit-date-group td{background:var(--s2);border-bottom:1px solid var(--b1);}
    [data-theme="light"] .bg-grn{background:rgba(22,163,74,.1);color:#15803d}
    [data-theme="light"] .bg-red{background:rgba(220,38,38,.1);color:#b91c1c}
    [data-theme="light"] .bg-amb{background:rgba(217,119,6,.1);color:#b45309}
    [data-theme="light"] .bg-bl{background:rgba(37,99,235,.1);color:#2563eb}
    [data-theme="light"] .bg-pur{background:rgba(124,58,237,.1);color:#7c3aed}
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
    @keyframes shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(400%)}}
    @keyframes slideInRight{from{transform:translateX(100%);opacity:0}to{transform:none;opacity:1}}
    svg[class*="lucide"]{display:inline-block;vertical-align:middle;flex-shrink:0;}
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
      text-transform:uppercase;color:var(--tx3);border-bottom:1px solid var(--b1);font-family:var(--mono);position:relative;}
    table.resizable{table-layout:fixed}
    .col-resize-handle{position:absolute;right:-1px;top:0;height:100%;width:8px;cursor:col-resize;
      display:flex;align-items:center;justify-content:center;z-index:2;user-select:none;}
    .col-resize-handle::after{content:'';width:2px;height:55%;background:var(--b2);border-radius:1px;transition:background .15s}
    .col-resize-handle:hover::after,.col-resize-handle:active::after{background:var(--ac)}
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
    /* S1-3: ACOS semantic color — applied via acosColor() inline style helper */
    /* S1-5: Hover-row action visibility */
    .tbl-row .act-cell { opacity: 0; transition: opacity 150ms ease; }
    .tbl-row:hover .act-cell { opacity: 1; }
    .tbl-row.row-selected .act-cell { opacity: 1; }
    @media (hover: none) { .tbl-row .act-cell { opacity: 1; } }
    /* S1-7: Last sync timestamp */
    .last-sync-label { font-size: 11px; color: var(--tx3); white-space: nowrap; }
    /* S1-8: Audit date group header */
    .audit-date-group td { padding: 4px 8px; font-size: 11px; color: var(--tx3);
      background: var(--s2); border-bottom: 1px solid var(--b1);
      font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; }
    /* S1-4: Clickable status badge */
    .status-clickable { cursor: pointer; }
    .status-clickable:hover { opacity: 0.75; text-decoration: underline dotted; }
  `}</style>
);

// ─── ACOS semantic color helper (S1-3) ────────────────────────────────────────
const acosColor = (pct) => {
  if (pct == null || isNaN(pct)) return 'var(--tx2)';
  if (pct < 15)  return 'var(--grn)';
  if (pct <= 30) return 'var(--amb)';
  return 'var(--red)';
};

// ─── S2-3: Budget utilization helper ──────────────────────────────────────────
const budgetUtil = (spend, budget, days) => {
  if (!budget || budget <= 0) return null;
  const avgDaily = spend / (days || 30);
  return Math.round((avgDaily / budget) * 100);
};

// ─── S2-7: AI recommendation params renderer ──────────────────────────────────
const AI_PARAM_LABELS = {
  target_acos:               'Target ACOS',
  recommended_daily_budget:  'Daily budget',
  product_categories:        'Categories',
  target_roas:               'Target ROAS',
  bid_adjustment:            'Bid adjustment',
  campaign_type:             'Campaign type',
  match_type:                'Match type',
  keyword:                   'Keyword',
  acos:                      'Current ACOS',
  spend:                     'Spend',
  orders:                    'Orders',
  recommended_bid:           'Recommended bid',
  new_bid:                   'New bid',
  old_bid:                   'Old bid',
};
const renderAiParams = (params) => {
  if (!params) return null;
  const obj = (typeof params === 'string')
    ? (() => { try { return JSON.parse(params); } catch { return null; } })()
    : (typeof params === 'object' ? params : null);
  if (!obj) return null;
  const entries = Object.entries(obj);
  if (entries.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', marginTop: 4,
      padding: '6px 10px', background: 'var(--s2)', borderRadius: 6, border: '1px solid var(--b2)' }}>
      {entries.map(([key, val]) => (
        <span key={key} style={{ fontSize: 11, color: 'var(--tx2)', whiteSpace: 'nowrap' }}>
          <span style={{ color: 'var(--tx3)' }}>{AI_PARAM_LABELS[key] || key.replace(/_/g, ' ')}:</span>
          {' '}
          <span style={{ color: 'var(--tx)', fontWeight: 600 }}>{String(val)}</span>
        </span>
      ))}
    </div>
  );
};

// ─── Last-sync relative time helper (S1-7) ────────────────────────────────────
const fmtLastSync = (isoString) => {
  if (!isoString) return null;
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  const hrs  = Math.floor(diff / 3600000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (hrs  < 24) return `${hrs}h ago`;
  const d = new Date(isoString);
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
         + ', ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
};

// ─── Tooltip component (S1-6) ─────────────────────────────────────────────────
const Tip = ({ text, children, width = 200 }) => {
  const [show, setShow] = useState(false);
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <span style={{
          position: 'absolute',
          bottom: 'calc(100% + 6px)',
          left: '50%',
          transform: 'translateX(-50%)',
          width: width,
          background: '#1e293b',
          color: '#e2e8f0',
          border: '1px solid #334155',
          borderRadius: 6,
          padding: '7px 10px',
          fontSize: 11,
          lineHeight: 1.5,
          zIndex: 1000,
          pointerEvents: 'none',
          whiteSpace: 'normal',
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        }}>
          <span style={{
            position: 'absolute',
            top: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            width: 0,
            height: 0,
            borderLeft: '5px solid transparent',
            borderRight: '5px solid transparent',
            borderTop: '5px solid #334155',
          }} />
          {text}
        </span>
      )}
    </span>
  );
};

// ─── Audit helpers (S1-8) ─────────────────────────────────────────────────────
const AUDIT_ACTION_LABELS = {
  'connection.created':          'Account connected',
  'connection.sync_requested':   'Sync started',
  'connection.sync_completed':   'Sync completed',
  'connection.sync_failed':      'Sync failed',
  'connection.deleted':          'Account disconnected',
  'keyword.bid_change':          'Keyword bid updated',
  'keyword.bid_change.rollback': 'Bid change rolled back',
  'keyword.state_change':        'Keyword status changed',
  'campaign.state_change':       'Campaign status changed',
  'campaign.budget_change':      'Campaign budget updated',
  'rule.executed':               'Rule executed',
  'rule.dry_run':                'Rule dry-run executed',
  'ai.recommendation.applied':   'AI recommendation applied',
  'ai.recommendation.dismissed': 'AI recommendation dismissed',
};
const auditLabel = (action) =>
  AUDIT_ACTION_LABELS[action] || action.replace(/[._]/g, ' ');

const formatDateGroup = (iso) => {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
};

// ─── Report helpers (S1-10) ───────────────────────────────────────────────────
const fmtReportPeriod = (from, to) => {
  if (!from || !to) return '—';
  const f = new Date(from);
  const t = new Date(to);
  const opts = { day: 'numeric', month: 'short' };
  return `${f.toLocaleDateString('en-GB', opts)} – ${t.toLocaleDateString('en-GB', opts)}`;
};
const fmtReportType = (type) => {
  if (!type) return '—';
  return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
};

// ─── Config ───────────────────────────────────────────────────────────────────
const API = (import.meta?.env?.VITE_API_URL) || "http://localhost:4000/api/v1";

// ─── API client ───────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}, asBlob = false) {
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
  if (asBlob) {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
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
  const mutate = useCallback((updater) => {
    setState(s => ({ ...s, data: typeof updater === "function" ? updater(s.data) : updater }));
  }, []);
  return { ...state, reload: load, mutate };
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
const KPICard = ({ label, value, delta, color, spark, prefix = "", suffix = "", loading, extra }) => (
  <div className="card fade" style={{ padding: "18px 20px" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
      <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--tx3)", fontFamily: "var(--mono)" }}>{label}</span>
      {delta != null && (
        <span className={`badge ${parseFloat(delta) >= 0 ? "bg-grn" : "bg-red"}`}>
          {parseFloat(delta) >= 0
            ? <TrendingUp size={11} strokeWidth={1.75} style={{display:'inline-block',verticalAlign:'middle'}} />
            : <TrendingDown size={11} strokeWidth={1.75} style={{display:'inline-block',verticalAlign:'middle'}} />
          } {Math.abs(delta)}%
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
    {extra}
  </div>
);

// ─── Sidebar ──────────────────────────────────────────────────────────────────
const NAV = [
  { id: "overview",  icon: Activity  },
  { id: "campaigns", icon: Megaphone },
  { id: "products",  icon: Package   },
  { id: "keywords",  icon: Tag       },
  { id: "reports",   icon: Newspaper },
  { id: "analytics", icon: Layers    },
  { id: "rules",      icon: Workflow  },
  { id: "strategies", icon: Orbit    },
  { id: "alerts",     icon: Bell     },
  { id: "ai",        icon: Sparkles  },
  { id: "audit",     icon: History   },
  { id: "connect",   icon: Cable     },
  { id: "settings",  icon: Cog       },
];

const SIDEBAR_W = 220;
const SIDEBAR_W_COLLAPSED = 56;

const Sidebar = ({ active, setActive, user, workspace, onLogout, theme, toggleTheme, collapsed, toggleCollapsed }) => {
  const { t } = useI18n();
  const W = collapsed ? SIDEBAR_W_COLLAPSED : SIDEBAR_W;
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ bottom: 0, left: 0 });
  const footerRef = useRef(null);
  const popupRef = useRef(null);

  const openMenu = () => {
    if (footerRef.current) {
      const rect = footerRef.current.getBoundingClientRect();
      setMenuPos({ bottom: window.innerHeight - rect.top + 6, left: rect.left });
    }
    setMenuOpen(o => !o);
  };

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e) => {
      const inPopup = popupRef.current?.contains(e.target);
      const inFooter = footerRef.current?.contains(e.target);
      if (!inPopup && !inFooter) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const iconBtn = (onClick, titleKey, Icon, hoverColor = "var(--tx)") => (
    <button onClick={onClick} title={t(titleKey)}
      style={{ background: "transparent", border: "none", cursor: "pointer", padding: 4,
        color: "var(--tx3)", display: "flex", alignItems: "center", borderRadius: 6, flexShrink: 0 }}
      onMouseEnter={e => e.currentTarget.style.color = hoverColor}
      onMouseLeave={e => e.currentTarget.style.color = "var(--tx3)"}>
      <Ic icon={Icon} size={15} />
    </button>
  );

  return (
    <aside style={{
      width: W, minHeight: "100vh", background: "var(--s1)", borderRight: "1px solid var(--b1)",
      display: "flex", flexDirection: "column", position: "fixed", left: 0, top: 0, bottom: 0, zIndex: 100,
      transition: "width 220ms cubic-bezier(0.4,0,0.2,1)", overflow: "hidden",
    }}>

      {/* ── Logo header ── */}
      <div style={{ padding: "16px 12px 14px", borderBottom: "1px solid var(--b1)",
        display: "flex", alignItems: "center", justifyContent: "center", minHeight: 64 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, overflow: "hidden" }}>
          <div style={{ width: 32, height: 32, background: "linear-gradient(135deg,#3B82F6,#A78BFA)",
            borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Activity size={16} strokeWidth={1.75} color="#fff" />
          </div>
          {!collapsed && (
            <div>
              <div style={{ fontFamily: "var(--disp)", fontWeight: 700, fontSize: 15, whiteSpace: "nowrap" }}>AdsFlow</div>
              <div style={{ fontSize: 10, color: "var(--tx3)", fontFamily: "var(--mono)", whiteSpace: "nowrap" }}>Amazon Ads</div>
            </div>
          )}
        </div>
      </div>

      {/* ── Workspace chip ── */}
      {workspace && !collapsed && (
        <div style={{ padding: "10px 12px", margin: "8px 10px", background: "var(--s2)",
          borderRadius: 8, border: "1px solid var(--b1)" }}>
          <div style={{ fontSize: 9, color: "var(--tx3)", fontFamily: "var(--mono)", marginBottom: 3,
            letterSpacing: ".06em" }}>{t("common.workspace")}</div>
          <div style={{ fontSize: 12, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden",
            textOverflow: "ellipsis" }}>{workspace.name}</div>
        </div>
      )}

      {/* ── Nav ── */}
      <nav style={{ flex: 1, padding: collapsed ? "6px 4px" : "6px 8px", display: "flex",
        flexDirection: "column", gap: 2, overflowY: "auto", overflowX: "hidden" }}>
        {NAV.map(({ id, icon }) => (
          <button key={id} onClick={() => setActive(id)}
            title={collapsed ? t("nav." + id) : undefined}
            style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: collapsed ? "9px 0" : "8px 12px",
              justifyContent: collapsed ? "center" : "flex-start",
              borderRadius: 7,
              background: active === id ? "var(--s3)" : "transparent",
              border: active === id ? "1px solid var(--b2)" : "1px solid transparent",
              color: active === id ? "var(--tx)" : "var(--tx2)",
              cursor: "pointer", fontSize: 13, fontFamily: "var(--ui)", width: "100%", textAlign: "left",
              transition: "all .15s", position: "relative", whiteSpace: "nowrap",
            }}>
            <Ic icon={icon} size={15} color={active === id ? "var(--ac2)" : "var(--tx3)"} />
            {!collapsed && t("nav." + id)}
            {active === id && (
              <span style={{ position: "absolute", right: 0, top: "50%", transform: "translateY(-50%)",
                width: 3, height: 18, background: "var(--ac)", borderRadius: "2px 0 0 2px" }} />
            )}
          </button>
        ))}
      </nav>

      {/* ── Footer ── */}
      <div ref={footerRef} style={{ padding: collapsed ? "10px 4px" : "12px 14px",
        borderTop: "1px solid var(--b1)", display: "flex", alignItems: "center", gap: 8 }}>

        {/* Avatar — triggers menu */}
        <button onClick={openMenu} title={user?.name || ""}
          style={{ width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
            background: menuOpen ? "linear-gradient(135deg,#2563EB,#7C3AED)" : "linear-gradient(135deg,#3B82F6,#8B5CF6)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 11, fontWeight: 600, color: "#fff", cursor: "pointer",
            border: menuOpen ? "2px solid var(--ac)" : "2px solid transparent",
            transition: "border-color 150ms", padding: 0,
            marginLeft: collapsed ? "auto" : 0, marginRight: collapsed ? "auto" : 0 }}>
          {user?.name?.slice(0, 2).toUpperCase() || "??"}
        </button>

        {!collapsed && (
          <>
            <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={openMenu}>
              <div style={{ fontSize: 12, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis",
                whiteSpace: "nowrap" }}>{user?.name || "—"}</div>
              <div style={{ fontSize: 10, color: "var(--tx3)", fontFamily: "var(--mono)" }}>{user?.role || ""}</div>
            </div>
            {iconBtn(toggleTheme, theme === "dark" ? "common.lightTheme" : "common.darkTheme",
              theme === "dark" ? Sun : Moon)}
          </>
        )}
      </div>

      {/* ── Profile popup — rendered via portal to escape overflow:hidden ── */}
      {menuOpen && createPortal(
        <div ref={popupRef} style={{
          position: "fixed",
          bottom: menuPos.bottom, left: menuPos.left,
          width: 210, background: "var(--s1)", border: "1px solid var(--b2)",
          borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,.28)",
          zIndex: 500, overflow: "hidden", animation: "slideDown .15s ease both",
        }}>
          <div style={{ padding: "12px 14px 10px", borderBottom: "1px solid var(--b1)" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--tx)", overflow: "hidden",
              textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user?.name || "—"}</div>
            <div style={{ fontSize: 11, color: "var(--tx3)", fontFamily: "var(--mono)", marginTop: 2 }}>{user?.role || ""}</div>
          </div>
          <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--b1)",
            display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: "var(--tx3)", paddingLeft: 6, flex: 1 }}>{t("settings.language")}</span>
            <LanguageSwitcher />
          </div>
          <button onClick={() => { toggleTheme(); }}
            style={{ width: "100%", display: "flex", alignItems: "center", gap: 10,
              padding: "9px 14px", background: "none", border: "none", cursor: "pointer",
              color: "var(--tx2)", fontSize: 13, fontFamily: "var(--ui)", borderBottom: "1px solid var(--b1)" }}
            onMouseEnter={e => { e.currentTarget.style.background = "var(--s2)"; e.currentTarget.style.color = "var(--tx)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--tx2)"; }}>
            <Ic icon={theme === "dark" ? Sun : Moon} size={14} color="var(--tx3)" />
            {theme === "dark" ? t("common.lightTheme") : t("common.darkTheme")}
          </button>
          <button onClick={() => { setMenuOpen(false); onLogout(); }}
            style={{ width: "100%", display: "flex", alignItems: "center", gap: 10,
              padding: "9px 14px", background: "none", border: "none", cursor: "pointer",
              color: "var(--tx2)", fontSize: 13, fontFamily: "var(--ui)" }}
            onMouseEnter={e => { e.currentTarget.style.background = "rgba(239,68,68,.08)"; e.currentTarget.style.color = "var(--red)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--tx2)"; }}>
            <Ic icon={LogOut} size={14} color="var(--tx3)" />
            {t("common.signOut")}
          </button>
        </div>,
        document.body
      )}
    </aside>
  );
};

// ─── useResizableColumns ──────────────────────────────────────────────────────
function useResizableColumns(tableId, defaultWidths) {
  const defaultsRef = useRef(defaultWidths);
  const storageKey = `af:cols:${tableId}`;
  const colRefs = useRef([]);

  const [widths, setWidths] = useState(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length === defaultWidths.length) return parsed;
      }
    } catch {}
    return defaultsRef.current;
  });

  const onMouseDown = useCallback((colIdx, e) => {
    e.preventDefault();
    const col = colRefs.current[colIdx];
    const startX = e.clientX;
    const startW = col ? col.offsetWidth : (defaultsRef.current[colIdx] || 100);

    const onMove = (ev) => {
      const newW = Math.max(40, startW + ev.clientX - startX);
      if (col) col.style.width = newW + "px";
    };
    const onUp = (ev) => {
      const newW = Math.max(40, startW + ev.clientX - startX);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      setWidths(prev => {
        const next = [...prev];
        next[colIdx] = newW;
        try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch {}
        return next;
      });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [storageKey]);

  const resetCols = useCallback(() => {
    setWidths(defaultsRef.current);
    try { localStorage.removeItem(storageKey); } catch {}
  }, [storageKey]);

  const colgroup = (
    <colgroup>
      {widths.map((w, i) => (
        <col key={i} ref={el => { colRefs.current[i] = el; }} style={{ width: w }} />
      ))}
    </colgroup>
  );

  const resizeHandle = (colIdx) => (
    <span
      className="col-resize-handle"
      onMouseDown={e => onMouseDown(colIdx, e)}
      onDoubleClick={() => {
        const def = defaultsRef.current[colIdx] || 100;
        setWidths(prev => {
          const next = [...prev];
          next[colIdx] = def;
          try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch {}
          return next;
        });
      }}
    />
  );

  return { widths, colgroup, resizeHandle, resetCols };
}

// ─── useColumnVisibility ──────────────────────────────────────────────────────
function useColumnVisibility(tableId, columnDefs) {
  // columnDefs: [{ key, label, defaultVisible?: boolean }]
  const storageKey = `af:colvis:${tableId}`;
  const [visible, setVisible] = useState(() => {
    const defaults = Object.fromEntries(columnDefs.map(c => [c.key, c.defaultVisible !== false]));
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      if (saved && typeof saved === "object") return { ...defaults, ...saved };
    } catch {}
    return defaults;
  });
  const [open, setOpen] = useState(false);
  const dropRef = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (dropRef.current && !dropRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const toggle = useCallback((key) => {
    setVisible(prev => {
      const next = { ...prev, [key]: !prev[key] };
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch {}
      return next;
    });
  }, [storageKey]);

  const isVisible = useCallback((key) => visible[key] !== false, [visible]);

  const ColVisDropdown = (
    <div ref={dropRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        className="btn btn-ghost"
        style={{ fontSize: 12, padding: "5px 10px", display: "flex", alignItems: "center", gap: 4 }}
        onClick={() => setOpen(o => !o)}
        title="Toggle columns"
      >
        <SlidersHorizontal size={13} /> Cols
      </button>
      {open && (
        <div style={{
          position: "absolute", right: 0, top: "100%", marginTop: 4,
          background: "var(--s1)", border: "1px solid var(--b2)", borderRadius: 8,
          padding: "6px 4px", zIndex: 200, minWidth: 150, boxShadow: "0 4px 16px rgba(0,0,0,.15)"
        }}>
          {columnDefs.map(col => (
            <div
              key={col.key}
              onClick={() => toggle(col.key)}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "5px 12px",
                cursor: "pointer", borderRadius: 5, fontSize: 12, color: "var(--tx)",
                userSelect: "none"
              }}
              onMouseEnter={e => e.currentTarget.style.background = "var(--s2)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
            >
              <span style={{
                width: 13, height: 13, borderRadius: 3, border: "1.5px solid var(--ac2)",
                background: visible[col.key] !== false ? "var(--ac2)" : "transparent",
                display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0
              }}>
                {visible[col.key] !== false && <Check size={9} strokeWidth={3} color="#fff" />}
              </span>
              {col.label}
            </div>
          ))}
          <div style={{ borderTop: "1px solid var(--b2)", margin: "4px 8px 0" }}>
            <div
              onClick={() => {
                const def = Object.fromEntries(columnDefs.map(c => [c.key, c.defaultVisible !== false]));
                setVisible(def);
                try { localStorage.removeItem(storageKey); } catch {}
              }}
              style={{ padding: "5px 4px", cursor: "pointer", fontSize: 11, color: "var(--tx3)", borderRadius: 5, marginTop: 2 }}
              onMouseEnter={e => e.currentTarget.style.color = "var(--tx)"}
              onMouseLeave={e => e.currentTarget.style.color = "var(--tx3)"}
            >Reset columns</div>
          </div>
        </div>
      )}
    </div>
  );

  return { isVisible, ColVisDropdown };
}

// ─── useKeyboardShortcuts ──────────────────────────────────────────────────────
function useKeyboardShortcuts(shortcuts) {
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;
  useEffect(() => {
    const onKeyDown = (e) => {
      const inInput = e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable;
      if (inInput) {
        if (e.key === "Escape") e.target.blur();
        return;
      }
      for (const sc of shortcutsRef.current) {
        const ctrlMatch = sc.ctrl ? e.ctrlKey || e.metaKey : !e.ctrlKey && !e.metaKey;
        if (sc.key === e.key && ctrlMatch) {
          e.preventDefault();
          sc.handler();
          break;
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

// ─── KeyboardShortcutsHelp overlay ───────────────────────────────────────────
const KeyboardShortcutsHelp = ({ onClose }) => {
  const { t } = useI18n();
  return createPortal(
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onClose}
    >
      <div
        style={{ background: "var(--s1)", border: "1px solid var(--b2)", borderRadius: 12, padding: "24px 28px", minWidth: 300, boxShadow: "0 8px 32px rgba(0,0,0,.3)" }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <span style={{ fontFamily: "var(--disp)", fontSize: 15, fontWeight: 700 }}>{t("shortcuts.title")}</span>
          <button className="btn btn-ghost" style={{ padding: "3px 8px" }} onClick={onClose}><X size={14} /></button>
        </div>
        {[
          { keys: ["/"],       label: t("shortcuts.search") },
          { keys: ["r"],       label: t("shortcuts.refresh") },
          { keys: ["Esc"],     label: t("shortcuts.close") },
          { keys: ["?"],       label: t("shortcuts.help") },
        ].map(({ keys, label }) => (
          <div key={keys[0]} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--b2)", fontSize: 13 }}>
            <span style={{ color: "var(--tx2)" }}>{label}</span>
            <div style={{ display: "flex", gap: 4 }}>
              {keys.map(k => (
                <kbd key={k} style={{
                  background: "var(--s2)", border: "1px solid var(--b2)", borderRadius: 5,
                  padding: "2px 8px", fontSize: 12, fontFamily: "monospace", color: "var(--tx)"
                }}>{k}</kbd>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>,
    document.body
  );
};

// ─── ChangeHistory popup ──────────────────────────────────────────────────────
function ChangeHistoryBtn({ entityId }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState(null);
  const [loading, setLoading] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    get(`/audit/entity/${entityId}`, { limit: 8 })
      .then(data => { setEvents(data); setLoading(false); })
      .catch(() => { setEvents([]); setLoading(false); });
  }, [open, entityId]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const fmtDiff = (ev) => {
    const diff = ev.diff;
    if (!diff) return ev.action;
    const parts = Object.entries(diff).map(([k, v]) => {
      const before = v.before != null ? v.before : "—";
      const after  = v.after  != null ? v.after  : "—";
      return `${k}: ${before} → ${after}`;
    });
    return parts.join(", ") || ev.action;
  };

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        className="btn btn-ghost"
        style={{ padding: "3px 6px", opacity: 0.6 }}
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        title="Change history"
      >
        <History size={12} />
      </button>
      {open && createPortal(
        <div
          onClick={e => e.stopPropagation()}
          style={{
            position: "fixed",
            top: ref.current ? ref.current.getBoundingClientRect().bottom + 4 : 100,
            left: ref.current ? Math.max(8, ref.current.getBoundingClientRect().right - 280) : 100,
            width: 280, zIndex: 2000,
            background: "var(--s1)", border: "1px solid var(--b2)", borderRadius: 8,
            boxShadow: "0 6px 24px rgba(0,0,0,.25)", padding: "10px 0",
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--tx2)", padding: "0 12px 6px", borderBottom: "1px solid var(--b2)" }}>
            Change History
          </div>
          {loading && <div style={{ padding: "12px", fontSize: 12, color: "var(--tx3)", textAlign: "center" }}>Loading…</div>}
          {!loading && events?.length === 0 && (
            <div style={{ padding: "12px", fontSize: 12, color: "var(--tx3)", textAlign: "center" }}>No history found</div>
          )}
          {!loading && events?.map(ev => (
            <div key={ev.id} style={{ padding: "6px 12px", borderBottom: "1px solid var(--b2)" }}>
              <div style={{ fontSize: 11, color: "var(--tx)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {fmtDiff(ev)}
              </div>
              <div style={{ fontSize: 10, color: "var(--tx3)", marginTop: 2 }}>
                {ev.actor_name || ev.actor_type} · {new Date(ev.created_at).toLocaleString()}
              </div>
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}

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

  const [scheduleUpdating, setScheduleUpdating] = useState(null);

  async function handleScheduleChange(connId, schedule) {
    setScheduleUpdating(connId);
    try {
      await patch(`/connections/${connId}/schedule`, { schedule });
      setConnections(cs => cs.map(c => c.id === connId ? { ...c, sync_schedule: schedule } : c));
    } catch (e) { alert(t("common.error") + e.message); }
    setScheduleUpdating(null);
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
              <div style={{ fontSize: 12, color: "var(--teal)", display:"flex", alignItems:"center", gap:4 }}><Check size={12} strokeWidth={1.75} color="var(--teal)" /> {t("metrics.backfillStarted")}</div>
            )}
            {backfillState.error && (
              <div style={{ fontSize: 12, color: "var(--red)" }}>{t("metrics.backfillError")}{backfillState.error}</div>
            )}
          </div>
        )}
      </div>

      {error && (
        <div style={{ marginBottom: 16, padding: "12px 16px", background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.2)", borderRadius: 8, color: "var(--red)", fontSize: 13 }}>
          <AlertCircle size={13} strokeWidth={1.75} style={{display:'inline-block',verticalAlign:'middle',marginRight:6}} /> {error}
        </div>
      )}

      {/* Step: List */}
      {step === "list" && (
        <>
          {connections.length > 0 && (
            <div className="card" style={{ marginBottom: 20, overflow: "hidden" }}>
              <table>
                <thead><tr><th>{t("connect.colAccount")}</th><th>{t("connect.colProfiles")}</th><th>{t("connect.colStatus")}</th><th>{t("connect.schedule")}</th><th>{t("connect.colUpdated")}</th><th></th></tr></thead>
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
                        <td><span className={`badge ${c.status === "active" ? "bg-grn" : "bg-red"}`}><Power size={9} strokeWidth={1.75} style={{display:'inline-block',verticalAlign:'middle'}} /> {c.status}</span></td>
                        <td>
                          <select
                            value={c.sync_schedule || "daily"}
                            onChange={e => handleScheduleChange(c.id, e.target.value)}
                            disabled={scheduleUpdating === c.id}
                            style={{ fontSize: 11, padding: "3px 6px", background: "var(--s2)", border: "1px solid var(--b2)", borderRadius: 6, color: "var(--tx)", cursor: "pointer" }}
                          >
                            <option value="hourly">{t("connect.scheduleHourly")}</option>
                            <option value="daily">{t("connect.scheduleDaily")}</option>
                            <option value="weekly">{t("connect.scheduleWeekly")}</option>
                          </select>
                          {scheduleUpdating === c.id && <span className="loader" style={{ width: 10, height: 10, borderWidth: 2, marginLeft: 6, display: "inline-block" }} />}
                        </td>
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
                                : <RefreshCw size={14} strokeWidth={1.75} />}
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
                                : <Download size={13} strokeWidth={1.75} />}
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
            <div style={{ marginBottom: 16 }}><Activity size={40} strokeWidth={1.5} color="var(--ac)" /></div>
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
                {loading ? <span className="loader" style={{ borderTopColor: "#111" }} /> : <Plug2 size={16} strokeWidth={1.75} />} {t("connect.connectBtn")}
              </button>

              <div style={{ fontSize: 11, color: "var(--tx3)", textAlign: "center", lineHeight: 1.5 }}>
                {t("connect.redirectNote").split("\n").map((line, i) => <span key={i}>{line}{i === 0 && <br/>}</span>)}
              </div>
            </div>

            <div style={{ marginTop: 28, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, maxWidth: 500, margin: "28px auto 0" }}>
              {[
                { icon: Lock,   color: "var(--teal)", labelKey: "connect.secure", descKey: "connect.secureDesc" },
                { icon: Zap,    color: "var(--ac)",   labelKey: "connect.fast", descKey: "connect.fastDesc" },
                { icon: Repeat, color: "var(--pur)",  labelKey: "connect.autoSync", descKey: "connect.autoSyncDesc" },
              ].map(({ icon, color, labelKey, descKey }) => (
                <div key={labelKey} style={{ padding: "14px", background: "var(--s2)", borderRadius: 8, border: "1px solid var(--b1)" }}>
                  <div style={{ marginBottom: 6 }}><Ic icon={icon} size={20} color={color} /></div>
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
              <CircleCheck size={20} strokeWidth={1.75} color="var(--grn)" />
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
          <div style={{ marginBottom: 12 }}><CircleCheck size={48} strokeWidth={1.5} color="var(--grn)" /></div>
          <div style={{ fontFamily: "var(--disp)", fontSize: 18, fontWeight: 700, marginBottom: 8 }}>{t("connect.done")}</div>
          <div style={{ fontSize: 13, color: "var(--tx2)", marginBottom: 20 }}>{msg}</div>
          <button className="btn btn-primary" onClick={() => setStep("list")}>{t("connect.toConnections")}</button>
        </div>
      )}
    </div>
  );
};

// ─── Dashboard widget registry ────────────────────────────────────────────────
const WIDGET_DEFS = [
  { id: "kpi_spend",       label: "Spend",            group: "kpi",   defaultSize: "half", desc: "Total spend for period" },
  { id: "kpi_sales",       label: "Sales",            group: "kpi",   defaultSize: "half", desc: "Sales for period" },
  { id: "kpi_acos",        label: "ACOS",             group: "kpi",   defaultSize: "half", desc: "Advertising cost of sales" },
  { id: "kpi_roas",        label: "ROAS",             group: "kpi",   defaultSize: "half", desc: "Return on ad spend" },
  { id: "kpi_clicks",      label: "Clicks",           group: "kpi",   defaultSize: "half", desc: "Click count" },
  { id: "kpi_impressions", label: "Impressions",      group: "kpi",   defaultSize: "half", desc: "Impression count" },
  { id: "kpi_orders",      label: "Orders",           group: "kpi",   defaultSize: "half", desc: "Order count" },
  { id: "kpi_ctr",         label: "CTR",              group: "kpi",   defaultSize: "half", desc: "Click-through rate" },
  { id: "kpi_cpc",         label: "CPC",              group: "kpi",   defaultSize: "half", desc: "Cost per click" },
  { id: "chart_spend",     label: "Spend Trend",      group: "chart", defaultSize: "full", desc: "Daily spend bar chart" },
  { id: "chart_trend",     label: "Multi-trend",      group: "chart", defaultSize: "full", desc: "Clicks & sales by day" },
  { id: "table_campaigns", label: "Top Campaigns",    group: "table", defaultSize: "full", desc: "Best campaigns by spend" },
  { id: "table_type",      label: "By Campaign Type", group: "table", defaultSize: "full", desc: "SP / SD / SB breakdown" },
  { id: "widget_alerts",   label: "Alerts",           group: "other", defaultSize: "half", desc: "Active alerts" },
  { id: "widget_ai",       label: "AI Recs",          group: "other", defaultSize: "full", desc: "AI recommendations" },
  { id: "widget_sync",     label: "Sync Status",      group: "other", defaultSize: "half", desc: "Profile sync status" },
];
const DEFAULT_LAYOUT = [
  { id: "kpi_spend",       size: "half" },
  { id: "kpi_sales",       size: "half" },
  { id: "kpi_acos",        size: "half" },
  { id: "kpi_roas",        size: "half" },
  { id: "kpi_clicks",      size: "half" },
  { id: "kpi_impressions", size: "half" },
  { id: "chart_spend",     size: "full" },
  { id: "table_campaigns", size: "full" },
];

// ─── Overview Page (real data) ────────────────────────────────────────────────
// ─── Products / BSR Page ──────────────────────────────────────────────────────
const ProductsPage = ({ workspaceId }) => {
  const { t: tr } = useI18n();
  const [newAsin, setNewAsin] = useState("");
  const [adding, setAdding] = useState(false);
  const [refreshingId, setRefreshingId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [history, setHistory] = useState({});
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);

  const { data: products, loading } = useAsync(
    () => workspaceId ? get("/products") : Promise.resolve([]),
    [workspaceId, tick]
  );

  const reload = () => setTick(t => t + 1);

  const handleAdd = async () => {
    if (!newAsin.trim()) return;
    setAdding(true); setError(null);
    try {
      await post("/products", { asin: newAsin.trim().toUpperCase() });
      setNewAsin("");
      reload();
    } catch (e) {
      setError(e.message || "Failed to add ASIN");
    } finally { setAdding(false); }
  };

  const handleRefresh = async (id) => {
    setRefreshingId(id); setError(null);
    try {
      await post(`/products/${id}/refresh`);
      reload();
    } catch (e) {
      setError(e.message);
    } finally { setRefreshingId(null); }
  };

  const handleHistory = async (id) => {
    if (expandedId === id) { setExpandedId(null); return; }
    setExpandedId(id);
    if (!history[id]) {
      try {
        const data = await get(`/products/${id}/history`);
        setHistory(h => ({ ...h, [id]: data }));
      } catch {}
    }
  };

  const handleDelete = async (id) => {
    await del(`/products/${id}`);
    reload();
  };

  return (
    <div className="fade">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 22 }}>
        <div>
          <h1 style={{ fontFamily: "var(--disp)", fontSize: 22, fontWeight: 700, marginBottom: 4 }}>
            {tr("products.title")}
          </h1>
          <div style={{ fontSize: 12, color: "var(--tx3)" }}>
            Track BSR rankings and connect advertising spend to product performance
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={newAsin}
            onChange={e => setNewAsin(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === "Enter" && handleAdd()}
            placeholder="B0XXXXXXXXXX"
            maxLength={10}
            style={{
              padding: "6px 12px", borderRadius: 7, fontSize: 13,
              background: "var(--s2)", border: "1px solid var(--b2)",
              color: "var(--tx)", outline: "none", width: 150,
              fontFamily: "var(--mono)", letterSpacing: "0.05em",
            }}
          />
          <button
            onClick={handleAdd}
            disabled={adding || newAsin.length !== 10}
            className="btn btn-primary"
            style={{ fontSize: 12, padding: "6px 14px" }}
          >
            {adding ? "…" : tr("products.addAsin")}
          </button>
        </div>
      </div>

      {error && (
        <div style={{
          background: "rgba(239,68,68,.1)", border: "1px solid rgba(239,68,68,.3)",
          borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13, color: "var(--red)",
        }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ color: "var(--tx3)", fontSize: 13 }}>Loading…</div>
      ) : (!products?.length) ? (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', padding: '60px 32px', gap: 16, textAlign: 'center' }}>
          <Ic icon={Package} size={48} style={{ color: 'var(--tx3)', opacity: 0.4 }} />
          <div>
            <p style={{ fontSize: 16, fontWeight: 600, color: 'var(--tx)', margin: '0 0 6px' }}>
              Start tracking your products
            </p>
            <p style={{ fontSize: 13, color: 'var(--tx2)', margin: 0, maxWidth: 360, lineHeight: 1.6 }}>
              Add an ASIN to see BSR trends, sales, and advertising spend
              for each product in one place.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 4, fontSize: 12, color: 'var(--tx3)' }}>
            <span>📦 BSR ranking history</span>
            <span>·</span>
            <span>💰 P&amp;L per ASIN</span>
            <span>·</span>
            <span>📊 Ad spend attribution</span>
          </div>
          <p style={{ fontSize: 11, color: 'var(--tx3)', marginTop: 4,
            background: 'var(--s2)', border: '1px solid var(--b2)',
            borderRadius: 6, padding: '6px 12px' }}>
            Enter a 10-character ASIN (e.g. B09XXXXX) in the field above
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {products.map(p => {
            const allRanks = [
              ...(p.classification_ranks || []),
              ...(p.display_group_ranks || []),
            ];
            const hist = history[p.id] || [];
            const isExpanded = expandedId === p.id;
            const isRefreshing = refreshingId === p.id;
            const bsrUpdated = p.bsr_updated_at
              ? new Date(p.bsr_updated_at).toLocaleString("en", {
                  day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
                })
              : null;

            return (
              <div key={p.id} className="card" style={{ padding: "16px 20px" }}>
                <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
                  {p.image_url && (
                    <img
                      src={p.image_url} alt={p.asin}
                      style={{ width: 56, height: 56, objectFit: "contain",
                        borderRadius: 6, background: "var(--s2)", flexShrink: 0 }}
                    />
                  )}

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 600, color: "var(--ac2)" }}>
                        {p.asin}
                      </span>
                      {p.brand && (
                        <span className="badge bg-bl" style={{ fontSize: 10 }}>{p.brand}</span>
                      )}
                      <span className="badge bg-bl" style={{ fontSize: 9 }}>{p.marketplace_id}</span>
                      {bsrUpdated && (
                        <span style={{ fontSize: 10, color: "var(--tx3)", marginLeft: "auto" }}>
                          Updated: {bsrUpdated}
                        </span>
                      )}
                    </div>
                    {p.title && (
                      <div style={{ fontSize: 12, color: "var(--tx2)", marginBottom: 10,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {p.title}
                      </div>
                    )}

                    {allRanks.length > 0 ? (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {allRanks.map((r, i) => (
                          <a
                            key={i}
                            href={r.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              display: "inline-flex", alignItems: "center", gap: 6,
                              padding: "4px 10px", borderRadius: 20, textDecoration: "none",
                              background: i === 0 ? "rgba(59,130,246,.15)" : "var(--s2)",
                              border: `1px solid ${i === 0 ? "rgba(59,130,246,.35)" : "var(--b2)"}`,
                            }}
                          >
                            <span style={{
                              fontFamily: "var(--mono)", fontSize: 13, fontWeight: 700,
                              color: i === 0 ? "var(--ac2)" : "var(--tx)",
                            }}>
                              #{r.rank.toLocaleString()}
                            </span>
                            <span style={{ fontSize: 11, color: "var(--tx3)" }}>
                              {r.title}
                            </span>
                          </a>
                        ))}
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: "var(--tx3)" }}>
                        No BSR data — configure SP_API_REFRESH_TOKEN in .env
                      </div>
                    )}
                  </div>

                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button
                      onClick={() => handleHistory(p.id)}
                      className="btn btn-ghost"
                      style={{ fontSize: 11, padding: "4px 10px" }}
                    >
                      {isExpanded ? <ChevronUp size={11} strokeWidth={1.75} style={{display:'inline-block',verticalAlign:'middle'}} /> : <ChevronDown size={11} strokeWidth={1.75} style={{display:'inline-block',verticalAlign:'middle'}} />} {tr("products.history")}
                    </button>
                    <button
                      onClick={() => handleRefresh(p.id)}
                      disabled={isRefreshing}
                      className="btn btn-ghost"
                      style={{ fontSize: 11, padding: "4px 10px" }}
                    >
                      {isRefreshing ? "…" : <RefreshCw size={13} strokeWidth={1.75} />}
                    </button>
                    <button
                      onClick={() => handleDelete(p.id)}
                      className="btn btn-red"
                      style={{ fontSize: 11, padding: "4px 8px" }}
                    >
                      <X size={12} strokeWidth={1.75} />
                    </button>
                  </div>
                </div>

                {isExpanded && hist.length > 0 && (
                  <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--b1)" }}>
                    <div style={{ fontSize: 11, color: "var(--tx3)", marginBottom: 8,
                      fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: ".06em" }}>
                      BSR History ({hist.length} points)
                    </div>
                    <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 48 }}>
                      {hist.map((snap, i) => {
                        if (!snap.best_rank) return null;
                        const ranks = hist.filter(s => s.best_rank).map(s => s.best_rank);
                        const min = Math.min(...ranks);
                        const max = Math.max(...ranks);
                        const h = max > min
                          ? Math.max(((max - snap.best_rank) / (max - min)) * 40 + 8, 4)
                          : 24;
                        const date = new Date(snap.captured_at).toLocaleDateString("en", { day: "2-digit", month: "short" });
                        return (
                          <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column",
                            alignItems: "center", gap: 2 }}
                            title={`#${snap.best_rank.toLocaleString()} • ${date}`}>
                            <div style={{ width: "100%", height: h,
                              background: "linear-gradient(to top, var(--ac), var(--ac2)88)",
                              borderRadius: "2px 2px 0 0", transition: "height .2s" }} />
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between",
                      fontSize: 10, color: "var(--tx3)", fontFamily: "var(--mono)", marginTop: 4 }}>
                      <span>{new Date(hist[0]?.captured_at).toLocaleDateString("en", { day: "2-digit", month: "short" })}</span>
                      <span>Best: #{Math.min(...hist.filter(s => s.best_rank).map(s => s.best_rank)).toLocaleString()}</span>
                      <span>{new Date(hist[hist.length - 1]?.captured_at).toLocaleDateString("en", { day: "2-digit", month: "short" })}</span>
                    </div>
                  </div>
                )}
                {isExpanded && hist.length === 0 && (
                  <div style={{ marginTop: 12, fontSize: 12, color: "var(--tx3)" }}>
                    No history yet — BSR syncs every 6 hours
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ─── SyncButton ───────────────────────────────────────────────────────────────
const SYNC_MODES = [
  { mode: "quick", icon: Zap,    labelKey: "sync.quick", descKey: "sync.quickDesc" },
  { mode: "full",  icon: Repeat, labelKey: "sync.full",  descKey: "sync.fullDesc"  },
];

const SyncButton = ({ workspaceId, onSynced }) => {
  const { t } = useI18n();
  const [selectedMode, setSelectedMode] = useState("quick");
  const [open, setOpen]     = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [done, setDone]     = useState(false);
  const ref     = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      const outsideBtn  = !ref.current     || !ref.current.contains(e.target);
      const outsideMenu = !menuRef.current || !menuRef.current.contains(e.target);
      if (outsideBtn && outsideMenu) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    setDone(false);
    try {
      await post("/connections/sync-all", { mode: selectedMode });
      setDone(true);
      setTimeout(() => setDone(false), 2000);
      onSynced?.();
    } catch (e) {
      alert(t("sync.error") + ": " + e.message);
    } finally {
      setSyncing(false);
    }
  };

  const selectMode = (mode) => {
    setSelectedMode(mode);
    setOpen(false);
  };

  const currentMode = SYNC_MODES.find(m => m.mode === selectedMode) || SYNC_MODES[0];

  const getMenuStyle = () => {
    if (!ref.current) return { position: "fixed", top: 60, right: 20, zIndex: 2000 };
    const rect = ref.current.getBoundingClientRect();
    return {
      position: "fixed",
      top: rect.bottom + 6,
      right: window.innerWidth - rect.right,
      zIndex: 2000,
      background: "var(--s2)",
      border: "1px solid var(--b2)",
      borderRadius: 8,
      padding: 6,
      minWidth: 240,
      boxShadow: "0 8px 24px rgba(0,0,0,.4)",
    };
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <div style={{ display: "flex", gap: 0 }}>

        {/* ── Main button — runs selectedMode ── */}
        <button
          onClick={handleSync}
          disabled={syncing}
          className="btn btn-primary"
          style={{ fontSize: 12, padding: "6px 12px", borderRadius: "6px 0 0 6px",
            display: "flex", alignItems: "center", gap: 5 }}
        >
          {syncing ? (
            <><span style={{ animation: "spin 1s linear infinite", display: "inline-block", width: 12, height: 12, border: "2px solid rgba(255,255,255,.3)", borderTopColor: "#fff", borderRadius: "50%" }} /> {t("sync.syncing")}</>
          ) : done ? (
            <><Check size={12} strokeWidth={1.75} style={{display:'inline-block',verticalAlign:'middle'}} /> {t("sync.done")}</>
          ) : (
            <><Ic icon={currentMode.icon} size={12} /> {t(currentMode.labelKey)}</>
          )}
        </button>

        {/* ── Dropdown arrow — select mode only ── */}
        <button
          onClick={(e) => { e.stopPropagation(); if (!syncing) setOpen(o => !o); }}
          disabled={syncing}
          className="btn btn-primary"
          style={{ fontSize: 11, padding: "6px 8px", borderRadius: "0 6px 6px 0",
            borderLeft: "1px solid rgba(255,255,255,.15)" }}
          title="Select sync mode"
        >
          {open ? <ChevronUp size={12} strokeWidth={1.75} style={{display:'inline-block',verticalAlign:'middle'}} /> : <ChevronDown size={12} strokeWidth={1.75} style={{display:'inline-block',verticalAlign:'middle'}} />}
        </button>
      </div>

      {/* ── Dropdown menu ── */}
      {open && createPortal(
        <div ref={menuRef} style={getMenuStyle()}>
          <div style={{ fontSize: 10, color: "var(--tx3)", padding: "6px 14px 4px",
            fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: ".05em" }}>
            Select sync mode
          </div>
          {SYNC_MODES.map(({ mode, icon, labelKey, descKey }) => (
            <button
              key={mode}
              onMouseDown={(e) => { e.stopPropagation(); selectMode(mode); }}
              style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "10px 14px", width: "100%", textAlign: "left",
                background: mode === selectedMode ? "var(--s3)" : "none",
                border: "none", cursor: "pointer", borderRadius: 6,
                color: "var(--tx)",
              }}
              onMouseEnter={e => e.currentTarget.style.background = "var(--s3)"}
              onMouseLeave={e => e.currentTarget.style.background = mode === selectedMode ? "var(--s3)" : "none"}
            >
              <Ic icon={icon} size={18} style={{ flexShrink: 0 }} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
                  {t(labelKey)}
                  {mode === selectedMode && (
                    <span style={{ fontSize: 9, color: "var(--ac2)",
                      background: "rgba(59,130,246,.15)",
                      padding: "1px 5px", borderRadius: 3 }}>
                      selected
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: "var(--tx3)", marginTop: 2 }}>
                  {t(descKey)}
                </div>
              </div>
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
};

// ─── GlobalProgressBar ────────────────────────────────────────────────────────
const GlobalProgressBar = ({ workspaceId }) => {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const intervalRef = useRef(null);
  const wasActiveRef = useRef(false);

  const poll = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const result = await get("/jobs/progress");
      setData(result);
    } catch (e) {
      // silently ignore poll errors
    }
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    poll();
    intervalRef.current = setInterval(poll, 3000);
    return () => clearInterval(intervalRef.current);
  }, [workspaceId, poll]);

  // Completion toast — must be before early returns (Rules of Hooks)
  useEffect(() => {
    if (!data) return;
    const hasAct = (data.active?.length > 0) || Object.values(data.queued || {}).some(v => v > 0);
    if (wasActiveRef.current && !hasAct) {
      window.dispatchEvent(new CustomEvent("af:toast", { detail: { msg: t("overview.syncComplete"), ok: true } }));
    }
    wasActiveRef.current = hasAct;
  }, [data]);

  if (!data) return null;

  const activeJobs = data.active || [];
  const queued = data.queued || {};
  const totalQueued = Object.values(queued).reduce((s, v) => s + (v || 0), 0);
  const hasActivity = activeJobs.length > 0 || totalQueued > 0;

  if (!hasActivity) return null;

  const primaryJob = activeJobs[0];
  const progress = Number(primaryJob?.progress) || 0;
  const label = primaryJob
    ? (primaryJob.type === "entity_sync" ? t("progress.sync") : t("progress.report"))
    : t("progress.sync");

  return createPortal(
    <div style={{
      position: "fixed", bottom: 20, right: 20, zIndex: 1500,
      background: "var(--s2)", border: "1px solid var(--b2)",
      borderRadius: 10, padding: "10px 14px",
      boxShadow: "0 4px 20px rgba(0,0,0,.4)",
      minWidth: 220, maxWidth: 280,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{
            width: 7, height: 7, borderRadius: "50%",
            background: "var(--ac)", display: "inline-block",
            animation: "pulse 1.5s ease-in-out infinite",
          }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--tx)" }}>{label}</span>
        </div>
        {totalQueued > 0 && (
          <span style={{ fontSize: 10, color: "var(--tx3)" }}>
            +{totalQueued} {t("progress.queued")}
          </span>
        )}
      </div>

      <div style={{
        height: 4, background: "var(--b2)", borderRadius: 4, overflow: "hidden",
        marginBottom: activeJobs.length > 0 ? 6 : 0,
      }}>
        <div style={{
          height: "100%", borderRadius: 4,
          background: "linear-gradient(90deg, var(--ac), var(--ac2))",
          width: progress > 0 ? `${progress}%` : "40%",
          transition: "width .5s ease",
          animation: progress === 0 ? "shimmer 1.5s infinite" : "none",
        }} />
      </div>

      {activeJobs.slice(0, 3).map(job => (
        <div key={job.id} style={{ display: "flex", justifyContent: "space-between",
          fontSize: 11, color: "var(--tx3)", marginTop: 3 }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            maxWidth: 170 }}>{job.label}</span>
          <span style={{ color: "var(--ac2)", flexShrink: 0, marginLeft: 6 }}>
            {job.progress}%
          </span>
        </div>
      ))}
      {activeJobs.length > 3 && (
        <div style={{ fontSize: 10, color: "var(--tx3)", marginTop: 3 }}>
          +{activeJobs.length - 3} more
        </div>
      )}
    </div>,
    document.body
  );
};

const OverviewPage = ({ workspaceId, user, onSettingsUpdate, onNavigate }) => {
  const { t } = useI18n();
  const [rangeMode, setRangeMode] = useState("7");
  const [customStart, setCustomStart] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30);
    return d.toISOString().split("T")[0];
  });
  const [customEnd, setCustomEnd] = useState(() => new Date().toISOString().split("T")[0]);
  const [acosMode, setAcosMode] = useState("acos"); // "acos" | "tacos"
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);
  const [syncOk, setSyncOk] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [layout, setLayout] = useState(() => user?.settings?.dashboardLayout || DEFAULT_LAYOUT);
  const [saveStatus, setSaveStatus] = useState(null);
  const saveTimerRef = useRef(null);

  // S2-6: Onboarding checklist
  const [checklistDismissed, setChecklistDismissed] = useState(
    () => localStorage.getItem('af_checklist_done') === '1'
  );
  const [rulesCount, setRulesCount] = useState(0);

  const endDate   = rangeMode !== "custom" ? new Date().toISOString().split("T")[0] : customEnd;
  const startDate = rangeMode !== "custom"
    ? new Date(Date.now() - parseInt(rangeMode) * 86400000).toISOString().split("T")[0]
    : customStart;

  const { data: summary, loading: sl, reload: reloadSummary } = useAsync(
    () => workspaceId ? get("/metrics/summary", { startDate, endDate, workspaceId }) : Promise.resolve(null),
    [workspaceId, startDate, endDate]
  );
  const { data: topCampaigns, reload: reloadTopCampaigns } = useAsync(
    () => workspaceId ? get("/metrics/top-campaigns", { startDate, endDate, limit: 5 }) : Promise.resolve([]),
    [workspaceId, startDate, endDate]
  );
  const { data: profiles, reload: reloadProfiles } = useAsync(
    () => workspaceId ? get("/profiles", { workspaceId }) : Promise.resolve([]),
    [workspaceId]
  );
  const { data: byType } = useAsync(
    () => workspaceId ? get("/metrics/by-type", { startDate, endDate }) : Promise.resolve([]),
    [workspaceId, startDate, endDate]
  );
  const { data: alertsData } = useAsync(
    () => workspaceId ? get("/alerts", { limit: 5 }) : Promise.resolve({ data: [] }),
    [workspaceId]
  );
  const { data: aiRecs } = useAsync(
    () => workspaceId ? get("/ai/recommendations") : Promise.resolve([]),
    [workspaceId]
  );

  // S1-7: connections for last-sync timestamp
  const [connections, setConnections] = useState([]);
  useEffect(() => {
    if (workspaceId) {
      get("/connections").then(data => {
        if (Array.isArray(data)) setConnections(data);
      }).catch(() => {});
    }
  }, [workspaceId]);
  const lastSync = connections.length
    ? connections.reduce((latest, c) =>
        !latest || new Date(c.last_refresh_at) > new Date(latest)
          ? c.last_refresh_at : latest
      , null)
    : null;

  // S2-6: fetch rules count for checklist
  useEffect(() => {
    if (workspaceId) {
      get('/rules', { limit: 1 }).then(d => setRulesCount(d?.pagination?.total || d?.data?.length || 0)).catch(() => {});
    }
  }, [workspaceId]);

  // S3-6: keyboard shortcuts
  useKeyboardShortcuts([
    { key: "?", handler: () => setShowShortcutsHelp(h => !h) },
    { key: "r", handler: () => { reloadSummary(); reloadTopCampaigns(); reloadProfiles(); } },
    { key: "R", handler: () => { reloadSummary(); reloadTopCampaigns(); reloadProfiles(); } },
  ]);

  // Update layout when user settings load
  useEffect(() => {
    if (user?.settings?.dashboardLayout) {
      setLayout(user.settings.dashboardLayout);
    }
  }, [user?.settings?.dashboardLayout]);

  async function handleSync() {
    if (syncing) return;
    setSyncing(true); setSyncMsg(null);
    try {
      const connections = await get("/connections");
      const activeConnIds = [...new Set(
        (profiles || []).filter(p => p.is_attached).map(p => p.connection_id).filter(Boolean)
      )];
      const toSync = activeConnIds.length
        ? activeConnIds
        : connections.filter(c => c.status === "active").map(c => c.id);
      let synced = 0;
      for (const connId of toSync) {
        try { const r = await post(`/connections/${connId}/sync`, {}); synced += r.queued || r.profiles || 1; } catch {}
      }
      setSyncOk(true); setSyncMsg(t("overview.syncStarted", { count: synced }));
      setTimeout(() => setSyncMsg(null), 4000);
    } catch {
      setSyncOk(false); setSyncMsg(t("overview.syncError"));
      setTimeout(() => setSyncMsg(null), 4000);
    }
    setSyncing(false);
  }

  const saveLayout = (newLayout) => {
    setLayout(newLayout);
    setSaveStatus("saving");
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        await patch("/auth/me", { settings: { dashboardLayout: newLayout } });
        if (onSettingsUpdate) onSettingsUpdate({ dashboardLayout: newLayout });
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus(null), 2000);
      } catch {
        setSaveStatus(null);
      }
    }, 800);
  };

  const moveWidget = (idx, dir) => {
    const next = [...layout];
    const swap = idx + dir;
    if (swap < 0 || swap >= next.length) return;
    [next[idx], next[swap]] = [next[swap], next[idx]];
    saveLayout(next);
  };
  const toggleWidget = (widgetId) => {
    const exists = layout.find(w => w.id === widgetId);
    const def = WIDGET_DEFS.find(d => d.id === widgetId);
    if (exists) {
      saveLayout(layout.filter(w => w.id !== widgetId));
    } else {
      saveLayout([...layout, { id: widgetId, size: def.defaultSize }]);
    }
  };
  const toggleSize = (idx) => {
    const next = [...layout];
    next[idx] = { ...next[idx], size: next[idx].size === "full" ? "half" : "full" };
    saveLayout(next);
  };
  const resetLayout = () => saveLayout(DEFAULT_LAYOUT);

  const hasData = summary?.totals;
  const totals = summary?.totals || {};
  const deltas = summary?.deltas || {};
  const trend = summary?.trend || [];

  const sparkData = {
    spend:       trend.map(r => parseFloat(r.spend || 0)),
    sales:       trend.map(r => parseFloat(r.sales || 0)),
    acos:        trend.map(r => parseFloat(r.acos || 0)),
    roas:        trend.map(r => parseFloat(r.roas || 0)),
    clicks:      trend.map(r => parseFloat(r.clicks || 0)),
    impressions: trend.map(r => parseFloat(r.impressions || 0)),
    orders:      trend.map(r => parseFloat(r.orders || 0)),
    ctr:         trend.map(r => parseFloat(r.ctr || 0)),
    cpc:         trend.map(r => parseFloat(r.cpc || 0)),
  };

  const fmt$ = v => `$${parseFloat(v || 0).toLocaleString("en", { maximumFractionDigits: 0 })}`;
  const fmtN = v => parseInt(v || 0).toLocaleString();

  const kpiMap = {
    kpi_spend:       { label: t("overview.kpiSpend"),       value: hasData ? fmt$(totals.spend)       : "—", delta: deltas.spend, color: "#60A5FA", spark: sparkData.spend },
    kpi_sales:       { label: t("overview.kpiSales"),       value: hasData ? fmt$(totals.sales)       : "—", delta: deltas.sales, color: "#22C55E", spark: sparkData.sales },
    kpi_acos:        { label: acosMode === "tacos" ? t("metrics.tacos") : "ACOS",
                       value: acosMode === "tacos"
                         ? (hasData && totals.tacos != null ? `${parseFloat(totals.tacos).toFixed(1)}%` : "—")
                         : (hasData ? `${parseFloat(totals.acos).toFixed(1)}%` : "—"),
                       delta: acosMode === "tacos" ? null : deltas.acos, color: "#F59E0B", spark: sparkData.acos },
    kpi_roas:        { label: "ROAS",                        value: hasData ? `${parseFloat(totals.roas).toFixed(2)}×` : "—", delta: deltas.roas,  color: "#A78BFA", spark: sparkData.roas },
    kpi_clicks:      { label: t("overview.kpiClicks"),      value: hasData ? fmtN(totals.clicks)      : "—", delta: null, color: "#14B8A6", spark: sparkData.clicks },
    kpi_impressions: { label: t("overview.kpiImpressions"), value: hasData ? `${(parseInt(totals.impressions || 0)/1000).toFixed(0)}K` : "—", delta: null, color: "#F472B6", spark: sparkData.impressions },
    kpi_orders:      { label: t("overview.kpiOrders"),      value: hasData ? fmtN(totals.orders)      : "—", delta: null, color: "#34D399", spark: sparkData.orders },
    kpi_ctr:         { label: "CTR",                         value: hasData ? `${parseFloat(totals.ctr || 0).toFixed(2)}%` : "—", delta: null, color: "#FBBF24", spark: sparkData.ctr },
    kpi_cpc:         { label: "CPC",                         value: hasData ? `$${parseFloat(totals.cpc || 0).toFixed(2)}` : "—", delta: null, color: "#F87171", spark: sparkData.cpc },
  };

  const typeLabel = ct => ({ sponsoredProducts: "SP", sponsoredBrands: "SB", sponsoredDisplay: "SD" })[ct] || (ct || "").slice(0, 3).toUpperCase();

  // S2-6: Checklist steps (derived from existing state — no extra API calls)
  const checklistSteps = [
    { id: 'connected',   label: t("overview.checklistStep1"), done: (connections?.length || 0) > 0,                          action: () => onNavigate && onNavigate('connect'),   cta: t("overview.checklistStep1Cta") },
    { id: 'synced',      label: t("overview.checklistStep2"), done: connections?.some(c => c.last_refresh_at != null) || false, action: null,                                        cta: null },
    { id: 'rule',        label: t("overview.checklistStep3"), done: rulesCount > 0,                                           action: () => onNavigate && onNavigate('rules'),     cta: t("overview.checklistStep3Cta") },
    { id: 'target_acos', label: t("overview.checklistStep4"), done: !!(user?.settings?.target_acos),                         action: () => onNavigate && onNavigate('settings'),  cta: t("overview.checklistStep4Cta") },
    { id: 'ai',          label: t("overview.checklistStep5"), done: false,                                                    action: () => onNavigate && onNavigate('ai'),        cta: t("overview.checklistStep5Cta") },
  ];
  const completedCount = checklistSteps.filter(s => s.done).length;
  const totalSteps = checklistSteps.length;
  const allDone = completedCount === totalSteps;

  useEffect(() => {
    if (allDone) {
      localStorage.setItem('af_checklist_done', '1');
      const t = setTimeout(() => setChecklistDismissed(true), 2000);
      return () => clearTimeout(t);
    }
  }, [allDone]);

  function renderWidget(item) {
    if (item.id.startsWith("kpi_")) {
      const kpi = kpiMap[item.id];
      if (!kpi) return null;
      let extra = null;
      if (item.id === "kpi_acos") {
        const targetAcos = user?.settings?.target_acos;
        const hasTacos = hasData && totals.tacos != null;
        extra = (
          <div>
            <div style={{ display: "flex", gap: 3, marginTop: 5, marginBottom: 2 }}>
              <button
                className={`btn ${acosMode === "acos" ? "btn-primary" : "btn-ghost"}`}
                style={{ fontSize: 10, padding: "2px 8px", height: 22 }}
                onClick={() => setAcosMode("acos")}
              >ACOS</button>
              <button
                className={`btn ${acosMode === "tacos" ? "btn-primary" : "btn-ghost"}`}
                style={{ fontSize: 10, padding: "2px 8px", height: 22 }}
                onClick={() => setAcosMode("tacos")}
                title={t("metrics.tacosTooltip")}
              >{t("metrics.tacos")}</button>
            </div>
            {acosMode === "acos" && targetAcos && hasData && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                fontSize: 11, color: "var(--tx3)", marginTop: 3 }}>
                <span>{t("overview.targetAcos", { acos: targetAcos })}</span>
                <span style={{ color: parseFloat(totals.acos) <= parseFloat(targetAcos) ? "var(--grn)" : "var(--red)", fontWeight: 600 }}>
                  {parseFloat(totals.acos) <= parseFloat(targetAcos) ? t("overview.onTarget") : t("overview.aboveTarget")}
                </span>
              </div>
            )}
            {acosMode === "tacos" && !hasTacos && (
              <div style={{ fontSize: 10, color: "var(--tx3)", marginTop: 3 }}>
                {t("metrics.tacosNoData")}
              </div>
            )}
          </div>
        );
      }
      return <KPICard key={item.id} label={kpi.label} value={kpi.value} delta={kpi.delta} color={kpi.color} spark={kpi.spark} loading={sl} extra={extra} />;
    }

    if (item.id === "chart_spend") {
      return (
        <div className="card" style={{ padding: "18px 20px" }}>
          <div style={{ fontFamily: "var(--disp)", fontSize: 14, fontWeight: 600, marginBottom: 14 }}>{t("overview.spendByDay")}</div>
          {trend.length === 0
            ? <div style={{ height: 64, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--tx3)", fontSize: 12 }}>{t("overview.noDataWidget")}</div>
            : <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 64 }}>
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
          }
        </div>
      );
    }

    if (item.id === "chart_trend") {
      const metrics = [
        { key: "clicks", label: t("overview.kpiClicks"), color: "#14B8A6" },
        { key: "sales",  label: t("overview.kpiSales"),  color: "#22C55E" },
      ];
      return (
        <div className="card" style={{ padding: "18px 20px" }}>
          <div style={{ fontFamily: "var(--disp)", fontSize: 14, fontWeight: 600, marginBottom: 14 }}>{t("overview.multiTrend")}</div>
          {trend.length === 0
            ? <div style={{ height: 64, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--tx3)", fontSize: 12 }}>{t("overview.noDataWidget")}</div>
            : <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {metrics.map(({ key, label, color }) => (
                  <div key={key}>
                    <div style={{ fontSize: 10, color: "var(--tx3)", fontFamily: "var(--mono)", marginBottom: 4, textTransform: "uppercase" }}>{label}</div>
                    <Spark data={trend.map(r => parseFloat(r[key] || 0))} color={color} h={28} />
                  </div>
                ))}
              </div>
          }
        </div>
      );
    }

    if (item.id === "table_campaigns") {
      return (
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ padding: "14px 18px 10px", fontFamily: "var(--disp)", fontSize: 14, fontWeight: 600 }}>{t("overview.topCampaigns")}</div>
          {!topCampaigns?.length
            ? <div style={{ padding: "20px", textAlign: "center", color: "var(--tx3)", fontSize: 12 }}>{t("overview.noDataWidget")}</div>
            : <table>
                <thead><tr>
                  <th>{t("overview.colCampaign")}</th>
                  <th>{t("overview.colType")}</th>
                  <th style={{ textAlign: "right" }}>Spend</th>
                  <th style={{ textAlign: "right" }}>Sales</th>
                  <th style={{ textAlign: "right" }}>ACOS</th>
                  <th style={{ textAlign: "right" }}>ROAS</th>
                </tr></thead>
                <tbody>
                  {topCampaigns.map(c => (
                    <tr key={c.id}>
                      <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</td>
                      <td><span className="badge bg-bl" style={{ fontSize: 10 }}>{typeLabel(c.campaign_type)}</span></td>
                      <td className="num" style={{ textAlign: "right", color: "var(--ac2)" }}>${parseFloat(c.spend).toFixed(0)}</td>
                      <td className="num" style={{ textAlign: "right", color: "var(--grn)" }}>{c.sales > 0 ? `$${parseFloat(c.sales).toFixed(0)}` : "—"}</td>
                      <td className="num" style={{ textAlign: "right", color: acosColor(parseFloat(c.acos)) }}>
                        {parseFloat(c.acos) > 0 ? `${parseFloat(c.acos).toFixed(1)}%` : "—"}
                      </td>
                      <td className="num" style={{ textAlign: "right", color: "var(--pur)" }}>
                        {parseFloat(c.roas) > 0 ? `${parseFloat(c.roas).toFixed(2)}×` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
          }
        </div>
      );
    }

    if (item.id === "table_type") {
      const rows = byType || [];
      return (
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ padding: "14px 18px 10px", fontFamily: "var(--disp)", fontSize: 14, fontWeight: 600 }}>{t("overview.byCampType")}</div>
          {!rows.length
            ? <div style={{ padding: "20px", textAlign: "center", color: "var(--tx3)", fontSize: 12 }}>{t("overview.noDataWidget")}</div>
            : <table>
                <thead><tr>
                  <th>{t("overview.typeCol")}</th>
                  <th style={{ textAlign: "right" }}>Spend</th>
                  <th style={{ textAlign: "right" }}>Sales</th>
                  <th style={{ textAlign: "right" }}>ACOS</th>
                  <th style={{ textAlign: "right" }}>ROAS</th>
                  <th style={{ textAlign: "right" }}>Clicks</th>
                </tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td><span className="badge bg-bl" style={{ fontSize: 10 }}>{typeLabel(r.campaign_type)}</span></td>
                      <td className="num" style={{ textAlign: "right", color: "var(--ac2)" }}>${parseFloat(r.spend || 0).toFixed(0)}</td>
                      <td className="num" style={{ textAlign: "right", color: "var(--grn)" }}>{parseFloat(r.sales || 0) > 0 ? `$${parseFloat(r.sales).toFixed(0)}` : "—"}</td>
                      <td className="num" style={{ textAlign: "right", color: acosColor(parseFloat(r.acos || 0)) }}>
                        {parseFloat(r.acos || 0) > 0 ? `${parseFloat(r.acos).toFixed(1)}%` : "—"}
                      </td>
                      <td className="num" style={{ textAlign: "right", color: "var(--pur)" }}>
                        {parseFloat(r.roas || 0) > 0 ? `${parseFloat(r.roas).toFixed(2)}×` : "—"}
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>{parseInt(r.clicks || 0).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
          }
        </div>
      );
    }

    if (item.id === "widget_alerts") {
      const alerts = alertsData?.data || [];
      return (
        <div className="card" style={{ padding: "14px 18px" }}>
          <div style={{ fontFamily: "var(--disp)", fontSize: 14, fontWeight: 600, marginBottom: 10 }}>{t("overview.alertsWidget")}</div>
          {!alerts.length
            ? <div style={{ fontSize: 12, color: "var(--tx3)" }}>{t("overview.noActiveAlerts")}</div>
            : <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {alerts.slice(0, 3).map(a => (
                  <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                    <span className={`badge ${a.severity === "high" || a.severity === "critical" ? "bg-red" : a.severity === "medium" ? "bg-amb" : "bg-bl"}`} style={{ fontSize: 9 }}>{a.severity || "info"}</span>
                    <span style={{ color: "var(--tx2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.config_name || a.title || "Alert"}</span>
                  </div>
                ))}
              </div>
          }
        </div>
      );
    }

    if (item.id === "widget_ai") {
      const recs = Array.isArray(aiRecs) ? aiRecs : [];
      return (
        <div className="card" style={{ padding: "14px 18px" }}>
          <div style={{ fontFamily: "var(--disp)", fontSize: 14, fontWeight: 600, marginBottom: 10 }}>{t("overview.aiRecs")}</div>
          {!recs.length
            ? <div style={{ fontSize: 12, color: "var(--tx3)" }}>{t("overview.noRecs")}</div>
            : <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {recs.slice(0, 3).map(r => (
                  <div key={r.id} style={{ borderBottom: "1px solid var(--b1)", paddingBottom: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                      <span className="badge bg-bl" style={{ fontSize: 9 }}>{r.type || "rec"}</span>
                      <span className={`badge ${r.risk_level === "high" ? "bg-red" : r.risk_level === "low" ? "bg-grn" : "bg-amb"}`} style={{ fontSize: 9 }}>{r.risk_level || "medium"}</span>
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 500 }}>{r.title}</div>
                  </div>
                ))}
              </div>
          }
        </div>
      );
    }

    if (item.id === "widget_sync") {
      const syncProfiles = profiles || [];
      return (
        <div className="card" style={{ padding: "14px 18px" }}>
          <div style={{ fontFamily: "var(--disp)", fontSize: 14, fontWeight: 600, marginBottom: 10 }}>{t("overview.syncStatus")}</div>
          {!syncProfiles.length
            ? <div style={{ fontSize: 12, color: "var(--tx3)" }}>{t("overview.noProfiles")}</div>
            : <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {syncProfiles.slice(0, 5).map(p => (
                  <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: p.sync_status === "synced" ? "var(--grn)" : "var(--amb)", display: "inline-block", flexShrink: 0 }} />
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.account_name || p.marketplace || "Profile"}</span>
                    <span style={{ fontSize: 10, color: "var(--tx3)", fontFamily: "var(--mono)" }}>{p.sync_status || "?"}</span>
                  </div>
                ))}
              </div>
          }
        </div>
      );
    }

    return null;
  }

  const activeProfiles = profiles?.filter(p => p.sync_status === "synced") || [];

  return (
    <div className="fade">
      {showShortcutsHelp && <KeyboardShortcutsHelp onClose={() => setShowShortcutsHelp(false)} />}
      {/* ── Header ── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h1 style={{ fontFamily: "var(--disp)", fontSize: 22, fontWeight: 700, marginBottom: 4 }}>
            {t("overview.title")}
            <span style={{ fontSize: 12, color: "var(--tx3)", marginLeft: 10, fontFamily: "var(--mono)", fontWeight: 400 }}>
              {startDate} – {endDate}
            </span>
          </h1>
          <div style={{ fontSize: 13, color: "var(--tx2)" }}>
            {activeProfiles.length > 0
              ? t("overview.profilesSynced", { count: activeProfiles.length })
              : <span style={{ color: "var(--amb)" }}>{t("overview.noProfilesWarning")}<span style={{ color: "var(--ac2)", cursor: "pointer" }}>{t("overview.connectAmazon")}</span></span>
            }
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {!editMode && saveStatus === "saved" && <Check size={14} strokeWidth={1.75} color="var(--grn)" />}
          <button
            className="btn btn-ghost"
            style={{ fontSize: 12, padding: "5px 12px" }}
            onClick={() => { reloadSummary(); reloadTopCampaigns(); reloadProfiles(); }}
          >
            <Ic icon={Repeat} size={13} /> {t("overview.refreshData")}
          </button>
          {lastSync && (
            <span className="last-sync-label" style={{ marginLeft: 2 }}>
              · {fmtLastSync(lastSync)}
            </span>
          )}
          <SyncButton workspaceId={workspaceId} onSynced={() => { reloadSummary(); reloadTopCampaigns(); reloadProfiles(); }} />
          {[["7","7d"],["14","14d"],["30","30d"],["90","90d"]].map(([val,label]) => (
            <button
              key={val}
              onClick={() => setRangeMode(val)}
              className={`btn ${rangeMode===val ? "btn-primary" : "btn-ghost"}`}
              style={{ fontSize: 12, padding: "5px 12px" }}
            >
              {label}
            </button>
          ))}
          <button
            onClick={() => setRangeMode("custom")}
            className={`btn ${rangeMode==="custom" ? "btn-primary" : "btn-ghost"}`}
            style={{ fontSize: 12, padding: "5px 12px" }}
          >
            <Ic icon={Calendar} size={13} /> {rangeMode==="custom"
              ? `${customStart.slice(5)} – ${customEnd.slice(5)}`
              : t("overview.custom") || "Custom"}
          </button>
          {rangeMode === "custom" && (
            <>
              <input
                type="date"
                value={customStart}
                max={customEnd}
                onChange={e => setCustomStart(e.target.value)}
                style={{
                  fontSize: 12, padding: "4px 8px", borderRadius: 6,
                  background: "var(--s2)", border: "1px solid var(--b2)",
                  color: "var(--tx)", outline: "none", cursor: "pointer"
                }}
              />
              <span style={{ fontSize: 12, color: "var(--tx3)" }}>→</span>
              <input
                type="date"
                value={customEnd}
                min={customStart}
                max={new Date().toISOString().split("T")[0]}
                onChange={e => setCustomEnd(e.target.value)}
                style={{
                  fontSize: 12, padding: "4px 8px", borderRadius: 6,
                  background: "var(--s2)", border: "1px solid var(--b2)",
                  color: "var(--tx)", outline: "none", cursor: "pointer"
                }}
              />
            </>
          )}
          <button
            onClick={() => setEditMode(e => !e)}
            className={editMode ? "btn btn-primary" : "btn btn-ghost"}
            style={{ fontSize: 12, padding: "5px 12px" }}
          >
            {editMode ? <><Check size={13} strokeWidth={1.75} style={{display:'inline-block',verticalAlign:'middle'}} /> {t("overview.done")}</> : <><Ic icon={LayoutGrid} size={13} /> {t("overview.customize")}</>}
          </button>
          <button className="btn btn-ghost" style={{ fontSize: 12, padding: "5px 10px" }} onClick={() => setShowShortcutsHelp(true)} title={t("shortcuts.help")}>
            <HelpCircle size={14} />
          </button>
        </div>
      </div>

      {syncMsg && (
        <div style={{
          marginBottom: 12, padding: "8px 14px", borderRadius: 8, fontSize: 13,
          background: syncOk ? "rgba(34,197,94,.1)" : "rgba(239,68,68,.1)",
          color: syncOk ? "var(--grn)" : "var(--red)",
          border: `1px solid ${syncOk ? "rgba(34,197,94,.2)" : "rgba(239,68,68,.2)"}`,
        }}>
          {syncMsg}
        </div>
      )}

      {!hasData && !sl && (
        <div style={{ marginBottom: 16, padding: "14px 18px", background: "rgba(59,130,246,.06)", border: "1px solid rgba(59,130,246,.15)", borderRadius: 8, fontSize: 13 }}>
          <strong style={{ color: "var(--ac2)" }}>{t("overview.noData")}</strong>{" "}
          <span style={{ color: "var(--tx2)" }}>{t("overview.noDataDesc")}</span>
        </div>
      )}

      {/* ── Widget palette (edit mode) ── */}
      {editMode && (
        <div className="card fade" style={{ padding: "16px 20px", marginBottom: 16, borderColor: "rgba(59,130,246,.3)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--tx)" }}>{t("overview.widgetPalette")}</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {saveStatus === "saved" && <span style={{ fontSize: 12, color: "var(--grn)", display:"flex", alignItems:"center", gap:4 }}><Check size={12} strokeWidth={1.75} color="var(--grn)" /> {t("overview.saved")}</span>}
              {saveStatus === "saving" && <span style={{ fontSize: 12, color: "var(--tx3)" }}>{t("overview.saving")}</span>}
              <button onClick={resetLayout} className="btn btn-ghost" style={{ fontSize: 11, padding: "4px 10px" }}><Ic icon={RotateCcw} size={11} /> {t("overview.resetLayout")}</button>
            </div>
          </div>
          {[
            { key: "kpi",   label: t("overview.widgetGroupKpi") },
            { key: "chart", label: t("overview.widgetGroupCharts") },
            { key: "table", label: t("overview.widgetGroupTables") },
            { key: "other", label: t("overview.widgetGroupOther") },
          ].map(({ key, label }) => {
            const groupDefs = WIDGET_DEFS.filter(d => d.group === key);
            return (
              <div key={key} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--tx3)", marginBottom: 6, fontFamily: "var(--mono)" }}>{label}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {groupDefs.map(def => {
                    const active = layout.some(w => w.id === def.id);
                    return (
                      <button
                        key={def.id}
                        onClick={() => toggleWidget(def.id)}
                        title={def.desc}
                        style={{
                          padding: "5px 12px", fontSize: 12, borderRadius: 6, cursor: "pointer",
                          background: active ? "rgba(59,130,246,.15)" : "var(--s2)",
                          border: active ? "1px solid rgba(59,130,246,.4)" : "1px solid var(--b2)",
                          color: active ? "var(--ac2)" : "var(--tx2)",
                          transition: "all .15s", fontFamily: "var(--ui)",
                        }}
                      >
                        {active ? <><Check size={11} strokeWidth={1.75} style={{display:'inline-block',verticalAlign:'middle'}} />{" "}</> : "+ "}{def.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── S2-6: Onboarding checklist ── */}
      {!checklistDismissed && completedCount < totalSteps && (
        <div style={{ background: 'var(--s1)', border: '1px solid var(--b2)', borderRadius: 12, padding: '16px 20px', marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--tx)' }}>{t("overview.checklistTitle")}</span>
              <span style={{ fontSize: 12, color: 'var(--tx3)', marginLeft: 12 }}>{t("overview.checklistCompleted", { done: completedCount, total: totalSteps })}</span>
            </div>
            <button
              onClick={() => { setChecklistDismissed(true); localStorage.setItem('af_checklist_done', '1'); }}
              style={{ background: 'none', border: 'none', color: 'var(--tx3)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}
              title={t("overview.checklistDismiss")}
            >×</button>
          </div>
          <div style={{ height: 4, background: 'var(--b2)', borderRadius: 2, marginBottom: 14, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(completedCount / totalSteps) * 100}%`, background: 'var(--ac)', borderRadius: 2, transition: 'width 400ms ease' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {checklistSteps.map(step => (
              <div key={step.id} style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: step.done ? 0.6 : 1 }}>
                <div style={{ width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                  background: step.done ? 'var(--grn)' : 'var(--s2)',
                  border: `2px solid ${step.done ? 'var(--grn)' : 'var(--b2)'}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 300ms' }}>
                  {step.done && <span style={{ color: '#fff', fontSize: 10, fontWeight: 700 }}>✓</span>}
                </div>
                <span style={{ fontSize: 13, color: step.done ? 'var(--tx3)' : 'var(--tx)', textDecoration: step.done ? 'line-through' : 'none', flex: 1 }}>
                  {step.label}
                </span>
                {!step.done && step.cta && step.action && (
                  <button onClick={step.action}
                    style={{ fontSize: 11, padding: '3px 10px', background: 'var(--ac)', color: '#fff', border: 'none', borderRadius: 5, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    {step.cta}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Widget grid ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
        {layout.map((item, idx) => {
          const def = WIDGET_DEFS.find(d => d.id === item.id);
          if (!def) return null;
          return (
            <div
              key={item.id}
              style={{
                gridColumn: item.size === "full" ? "1 / -1" : "span 1",
                position: "relative",
                ...(editMode ? { outline: "2px dashed rgba(59,130,246,.4)", outlineOffset: 2, borderRadius: 11 } : {}),
              }}
            >
              {editMode && (
                <div style={{ position: "absolute", top: 8, right: 8, zIndex: 10, display: "flex", gap: 4 }}>
                  <button
                    onClick={() => moveWidget(idx, -1)}
                    disabled={idx === 0}
                    style={{ width: 24, height: 24, background: "var(--s3)", border: "1px solid var(--b2)", borderRadius: 4, fontSize: 10, cursor: idx === 0 ? "not-allowed" : "pointer", color: "var(--tx2)", display: "flex", alignItems: "center", justifyContent: "center", opacity: idx === 0 ? .4 : 1 }}
                  ><ArrowUp size={10} strokeWidth={1.75} /></button>
                  <button
                    onClick={() => moveWidget(idx, 1)}
                    disabled={idx === layout.length - 1}
                    style={{ width: 24, height: 24, background: "var(--s3)", border: "1px solid var(--b2)", borderRadius: 4, fontSize: 10, cursor: idx === layout.length - 1 ? "not-allowed" : "pointer", color: "var(--tx2)", display: "flex", alignItems: "center", justifyContent: "center", opacity: idx === layout.length - 1 ? .4 : 1 }}
                  ><ArrowDown size={10} strokeWidth={1.75} /></button>
                  {!item.id.startsWith("kpi_") && (
                    <button
                      onClick={() => toggleSize(idx)}
                      title={item.size === "full" ? "Make narrow" : "Make wide"}
                      style={{ width: 24, height: 24, background: "var(--s3)", border: "1px solid var(--b2)", borderRadius: 4, fontSize: 10, cursor: "pointer", color: "var(--tx2)", display: "flex", alignItems: "center", justifyContent: "center" }}
                    ><ArrowUpDown size={10} strokeWidth={1.75} /></button>
                  )}
                  <button
                    onClick={() => toggleWidget(item.id)}
                    style={{ width: 24, height: 24, background: "rgba(239,68,68,.15)", border: "1px solid rgba(239,68,68,.3)", borderRadius: 4, fontSize: 10, cursor: "pointer", color: "var(--red)", display: "flex", alignItems: "center", justifyContent: "center" }}
                  ><X size={10} strokeWidth={1.75} /></button>
                </div>
              )}
              {renderWidget(item)}
            </div>
          );
        })}
        {layout.length === 0 && (
          <div style={{ gridColumn: "1/-1", padding: 60, textAlign: "center", color: "var(--tx3)", border: "2px dashed var(--b2)", borderRadius: 12 }}>
            <div style={{ marginBottom: 8 }}><LayoutGrid size={32} strokeWidth={1.5} color="var(--tx3)" /></div>
            <div>No widgets — click «{t("overview.customize")}» to add</div>
          </div>
        )}
      </div>
    </div>
  );
};

// ─── SortHeader — reusable sortable column header ─────────────────────────────
const SortHeader = ({ field, label, currentSort, currentDir, onSort, align = "left", rh }) => {
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
      {active
        ? (currentDir === "asc"
            ? <ChevronUp size={11} strokeWidth={1.75} style={{display:'inline-block',verticalAlign:'middle',color:'var(--ac)'}} />
            : <ChevronDown size={11} strokeWidth={1.75} style={{display:'inline-block',verticalAlign:'middle',color:'var(--ac)'}} />)
        : <ChevronsUpDown size={11} strokeWidth={1.75} style={{opacity:0.3,display:'inline-block',verticalAlign:'middle'}} />
      }
      {rh}
    </th>
  );
};

// ─── useSavedFilters ──────────────────────────────────────────────────────────
const useSavedFilters = (storageKey, defaultFilters) => {
  const PRESETS_KEY = `${storageKey}:presets`;
  const ACTIVE_KEY  = `${storageKey}:active`;

  const [filters, setFilters] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(ACTIVE_KEY) || "null");
      return saved ? { ...defaultFilters, ...saved } : { ...defaultFilters };
    } catch { return { ...defaultFilters }; }
  });

  const [presets, setPresets] = useState(() => {
    try { return JSON.parse(localStorage.getItem(PRESETS_KEY) || "[]"); }
    catch { return []; }
  });

  const updateFilter = useCallback((key, value) => {
    setFilters(prev => {
      const next = { ...prev, [key]: value };
      try { localStorage.setItem(ACTIVE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }, [ACTIVE_KEY]);

  const updateFilters = useCallback((updates) => {
    setFilters(prev => {
      const next = { ...prev, ...updates };
      try { localStorage.setItem(ACTIVE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }, [ACTIVE_KEY]);

  const resetFilters = useCallback(() => {
    setFilters({ ...defaultFilters });
    try { localStorage.removeItem(ACTIVE_KEY); } catch {}
  }, [ACTIVE_KEY]);

  const savePreset = useCallback((name) => {
    setFilters(cur => {
      const preset = { id: Date.now(), name, filters: { ...cur } };
      setPresets(prev => {
        const next = [...prev.filter(p => p.name !== name), preset];
        try { localStorage.setItem(PRESETS_KEY, JSON.stringify(next)); } catch {}
        return next;
      });
      return cur;
    });
  }, [PRESETS_KEY]);

  const loadPreset = useCallback((preset) => {
    const next = { ...defaultFilters, ...preset.filters };
    setFilters(next);
    try { localStorage.setItem(ACTIVE_KEY, JSON.stringify(next)); } catch {}
  }, [ACTIVE_KEY]);

  const deletePreset = useCallback((id) => {
    setPresets(prev => {
      const next = prev.filter(p => p.id !== id);
      try { localStorage.setItem(PRESETS_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }, [PRESETS_KEY]);

  const activeCount = Object.entries(filters).filter(([k, v]) => {
    const def = defaultFilters[k];
    return v !== def && v !== "" && v !== null && v !== undefined &&
      !(Array.isArray(v) && v.length === 0);
  }).length;

  return { filters, updateFilter, updateFilters, resetFilters, presets, savePreset, loadPreset, deletePreset, activeCount };
};

// ─── FilterPanel ──────────────────────────────────────────────────────────────
const FilterPanel = ({ isOpen, onClose, filters, onUpdate, onReset, presets, onSavePreset, onLoadPreset, onDeletePreset, fields }) => {
  const { t } = useI18n();
  const [newPresetName, setNewPresetName] = useState("");
  const [showPresetInput, setShowPresetInput] = useState(false);

  if (!isOpen) return null;

  const inp = {
    fontSize: 12, padding: "5px 8px", borderRadius: 5,
    background: "var(--s3)", border: "1px solid var(--b2)",
    color: "var(--tx)", outline: "none", width: "100%",
  };

  return createPortal(
    <div style={{ position: "fixed", inset: 0, zIndex: 1400, background: "rgba(0,0,0,.4)",
      display: "flex", alignItems: "flex-start", justifyContent: "flex-end" }}
      onClick={onClose}>
      <div style={{ width: 320, height: "100vh", overflowY: "auto",
        background: "var(--s1)", borderLeft: "1px solid var(--b2)",
        padding: "0 0 40px", display: "flex", flexDirection: "column",
        animation: "slideInRight .2s ease" }}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--b2)",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          position: "sticky", top: 0, background: "var(--s1)", zIndex: 1 }}>
          <span style={{ fontFamily: "var(--disp)", fontSize: 15, fontWeight: 600 }}>{t("filter.title")}</span>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={onReset} className="btn btn-ghost"
              style={{ fontSize: 11, padding: "4px 10px", color: "var(--tx3)" }}>{t("filter.reset")}</button>
            <button onClick={onClose} className="btn btn-ghost" style={{ fontSize: 11, padding: "4px 8px" }}><X size={14} strokeWidth={1.75} /></button>
          </div>
        </div>

        {/* Saved Presets */}
        <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--b2)" }}>
          <div style={{ fontSize: 10, color: "var(--tx3)", fontFamily: "var(--mono)",
            textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 8 }}>{t("filter.presets")}</div>
          {presets.length === 0
            ? <div style={{ fontSize: 11, color: "var(--tx3)" }}>{t("filter.noPresets")}</div>
            : <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {presets.map(p => (
                  <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "space-between" }}>
                    <button onClick={() => onLoadPreset(p)}
                      style={{ fontSize: 12, color: "var(--ac)", background: "none",
                        border: "none", cursor: "pointer", textAlign: "left", flex: 1, padding: "3px 0", display: "flex", alignItems: "center", gap: 4 }}>
                      <SlidersHorizontal size={11} strokeWidth={1.75} /> {p.name}
                    </button>
                    <button onClick={() => onDeletePreset(p.id)}
                      style={{ fontSize: 10, color: "var(--tx3)", background: "none", border: "none", cursor: "pointer", padding: "0 4px" }}><X size={10} strokeWidth={1.75} /></button>
                  </div>
                ))}
              </div>
          }
          {showPresetInput
            ? <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <input value={newPresetName} onChange={e => setNewPresetName(e.target.value)}
                  placeholder={t("filter.presetName")} style={{ ...inp, flex: 1 }}
                  onKeyDown={e => { if (e.key === "Enter" && newPresetName.trim()) {
                    onSavePreset(newPresetName.trim()); setNewPresetName(""); setShowPresetInput(false);
                  }}}
                  autoFocus />
                <button onClick={() => { if (newPresetName.trim()) {
                  onSavePreset(newPresetName.trim()); setNewPresetName(""); setShowPresetInput(false);
                }}} className="btn btn-primary" style={{ fontSize: 11, padding: "4px 10px" }}>{t("filter.save")}</button>
              </div>
            : <button onClick={() => setShowPresetInput(true)}
                className="btn btn-ghost" style={{ fontSize: 11, marginTop: 8, padding: "4px 10px" }}>
                + {t("filter.savePreset")}
              </button>
          }
        </div>

        {/* Filter Fields */}
        <div style={{ padding: "12px 18px", display: "flex", flexDirection: "column", gap: 16 }}>
          {fields.map(field => (
            <div key={field.key}>
              {field.type !== "toggle" && (
                <div style={{ fontSize: 10, color: "var(--tx3)", fontFamily: "var(--mono)",
                  textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 6 }}>
                  {field.label}{field.unit && <span style={{ color: "var(--tx3)", marginLeft: 4, textTransform: "none" }}>{field.unit}</span>}
                </div>
              )}

              {field.type === "select" && (
                <select value={filters[field.key] ?? "all"} style={inp}
                  onChange={e => onUpdate(field.key, e.target.value === "all" ? "" : e.target.value)}>
                  <option value="all">{t("filter.all")}</option>
                  {field.options?.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                </select>
              )}

              {field.type === "range" && (
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="number" placeholder={t("filter.from")}
                    value={filters[`${field.key}Min`] ?? ""}
                    min={field.min} max={field.max} step={field.step || 1}
                    style={{ ...inp, width: "50%" }}
                    onChange={e => onUpdate(`${field.key}Min`, e.target.value)} />
                  <span style={{ color: "var(--tx3)", fontSize: 12 }}>—</span>
                  <input type="number" placeholder={t("filter.to")}
                    value={filters[`${field.key}Max`] ?? ""}
                    min={field.min} max={field.max} step={field.step || 1}
                    style={{ ...inp, width: "50%" }}
                    onChange={e => onUpdate(`${field.key}Max`, e.target.value)} />
                </div>
              )}

              {field.type === "number" && (
                <input type="number" placeholder={`≥ ${field.placeholder ?? 0}`}
                  value={filters[field.key] ?? ""}
                  min={field.min ?? 0} step={field.step || 1}
                  style={inp}
                  onChange={e => onUpdate(field.key, e.target.value)} />
              )}

              {field.type === "toggle" && (
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
                  fontSize: 12, color: filters[field.key] ? "var(--ac2)" : "var(--tx3)" }}>
                  <input type="checkbox" checked={!!filters[field.key]}
                    onChange={e => onUpdate(field.key, e.target.checked)}
                    style={{ accentColor: "var(--ac)", width: 13, height: 13 }} />
                  {field.label}
                </label>
              )}

              {field.type === "multiselect" && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {field.options?.map(opt => {
                    const active = (filters[field.key] || []).includes(opt.value);
                    return (
                      <button key={opt.value}
                        onClick={() => {
                          const cur = filters[field.key] || [];
                          onUpdate(field.key, active ? cur.filter(v => v !== opt.value) : [...cur, opt.value]);
                        }}
                        style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4, cursor: "pointer",
                          background: active ? "rgba(59,130,246,.2)" : "var(--s3)",
                          border: `1px solid ${active ? "var(--ac)" : "var(--b2)"}`,
                          color: active ? "var(--ac2)" : "var(--tx2)" }}>
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
};

// ─── Campaigns Page (real data) ───────────────────────────────────────────────
const CAMPAIGN_DEFAULT_FILTERS = {
  search: "", status: "", type: "", strategy: "",
  budgetMin: "", budgetMax: "",
  spendMin: "", spendMax: "",
  acosMin: "", acosMax: "",
  roasMin: "", roasMax: "",
  ordersMin: "", clicksMin: "",
  noSales: false, hasMetrics: false,
  metricsDays: 30,
};

const CampaignsPage = ({ workspaceId }) => {
  const { t } = useI18n();
  const {
    filters: campFilters, updateFilter: setCampFilter,
    resetFilters: resetCampFilters,
    presets: campPresets, savePreset: saveCampPreset,
    loadPreset: loadCampPreset, deletePreset: deleteCampPreset,
    activeCount: campActiveCount,
  } = useSavedFilters("af:campaigns", CAMPAIGN_DEFAULT_FILTERS);
  const [showCampFilters, setShowCampFilters] = useState(false);
  const [sortBy, setSortBy] = useState("spend");
  const [sortDir, setSortDir] = useState("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [editId, setEditId] = useState(null);
  const [editState, setEditState] = useState(null);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [showBudgetModal, setShowBudgetModal] = useState(false);
  const [budgetPct, setBudgetPct] = useState("");
  // S2-4: Campaign drill-down panel
  const [panelCampaign, setPanelCampaign] = useState(null);
  const [panelKws, setPanelKws]           = useState([]);
  const [panelLoading, setPanelLoading]   = useState(false);
  const { colgroup: campColgroup, resizeHandle: campRH, resetCols: campResetCols } = useResizableColumns(
    "campaigns", [36, 200, 80, 90, 95, 85, 85, 75, 75, 60]
  );
  const { isVisible: campCV, ColVisDropdown: CampColsBtn } = useColumnVisibility("campaigns", [
    { key: "name",   label: t("campaigns.colName") },
    { key: "type",   label: t("campaigns.colType") },
    { key: "status", label: t("campaigns.colStatus") },
    { key: "budget", label: t("campaigns.colBudget") },
    { key: "spend",  label: "Spend" },
    { key: "sales",  label: "Sales" },
    { key: "acos",   label: "ACOS" },
    { key: "roas",   label: "ROAS" },
  ]);

  // S1-7: connections for last-sync timestamp
  const [connections, setConnections] = useState([]);
  useEffect(() => {
    if (workspaceId) {
      get("/connections").then(data => {
        if (Array.isArray(data)) setConnections(data);
      }).catch(() => {});
    }
  }, [workspaceId]);
  const lastSync = connections.length
    ? connections.reduce((latest, c) =>
        !latest || new Date(c.last_refresh_at) > new Date(latest)
          ? c.last_refresh_at : latest
      , null)
    : null;

  // S3-6: keyboard shortcuts
  useKeyboardShortcuts([
    { key: "/", handler: () => document.querySelector("[data-search-input]")?.focus() },
    { key: "r", handler: () => reload() },
    { key: "R", handler: () => reload() },
  ]);

  // S2-4: open campaign panel + Escape key close
  const openCampaignPanel = async (campaign) => {
    setPanelCampaign(campaign);
    setPanelLoading(true);
    setPanelKws([]);
    try {
      const data = await apiFetch(`/keywords?limit=200&campaignId=${campaign.id}`);
      const campKws = data?.data || data?.keywords || [];
      campKws.sort((a, b) => parseFloat(b.spend || 0) - parseFloat(a.spend || 0));
      setPanelKws(campKws);
    } catch {
      setPanelKws([]);
    } finally {
      setPanelLoading(false);
    }
  };

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape' && panelCampaign) setPanelCampaign(null); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [panelCampaign]);

  function handleCampSort(field) {
    const isText = ["name", "state"].includes(field);
    if (sortBy === field) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortBy(field); setSortDir(isText ? "asc" : "desc"); }
  }

  useEffect(() => { setPage(1); }, [campFilters, sortBy, sortDir]);

  const { data, loading, reload } = useAsync(
    () => workspaceId ? get("/campaigns", {
      page, limit: pageSize, sortBy, sortDir,
      search:      campFilters.search      || undefined,
      status:      campFilters.status      || undefined,
      type:        campFilters.type        || undefined,
      strategy:    campFilters.strategy    || undefined,
      budgetMin:   campFilters.budgetMin   || undefined,
      budgetMax:   campFilters.budgetMax   || undefined,
      spendMin:    campFilters.spendMin    || undefined,
      spendMax:    campFilters.spendMax    || undefined,
      acosMin:     campFilters.acosMin     || undefined,
      acosMax:     campFilters.acosMax     || undefined,
      roasMin:     campFilters.roasMin     || undefined,
      roasMax:     campFilters.roasMax     || undefined,
      ordersMin:   campFilters.ordersMin   || undefined,
      clicksMin:   campFilters.clicksMin   || undefined,
      noSales:     campFilters.noSales     || undefined,
      hasMetrics:  campFilters.hasMetrics  || undefined,
      metricsDays: campFilters.metricsDays !== 30 ? campFilters.metricsDays : undefined,
    }) : Promise.resolve({ data: [], pagination: {} }),
    [workspaceId, page, pageSize, sortBy, sortDir, campFilters]
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

      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <input placeholder={t("campaigns.searchPlaceholder")} value={campFilters.search}
          onChange={e => { setCampFilter("search", e.target.value); setPage(1); }} style={{ width: 200 }} data-search-input />
        {[
          { value: "", label: t("filter.all") },
          { value: "enabled",  label: t("common.statusEnabled") },
          { value: "paused",   label: t("common.statusPaused") },
          { value: "archived", label: t("common.statusArchived") },
        ].map(s => (
          <button key={s.value} onClick={() => { setCampFilter("status", s.value); setPage(1); }}
            className={`btn ${campFilters.status === s.value ? "btn-primary" : "btn-ghost"}`}
            style={{ fontSize: 12, padding: "5px 12px" }}>{s.label}</button>
        ))}
        {[
          { value: "", label: t("filter.all") },
          { value: "SP", label: "SP" },
          { value: "SB", label: "SB" },
          { value: "SD", label: "SD" },
        ].map(tp => (
          <button key={tp.value} onClick={() => { setCampFilter("type", tp.value); setPage(1); }}
            className={`btn ${campFilters.type === tp.value ? "btn-primary" : "btn-ghost"}`}
            style={{ fontSize: 11, padding: "4px 8px" }}>{tp.label}</button>
        ))}
        <select value={campFilters.metricsDays}
          onChange={e => { setCampFilter("metricsDays", parseInt(e.target.value)); setPage(1); }}
          style={{ fontSize: 12, padding: "5px 8px", borderRadius: 5,
            background: "var(--s2)", border: "1px solid var(--b2)", color: "var(--tx)" }}>
          {[7,14,30,60,90].map(d => <option key={d} value={d}>{d}d</option>)}
        </select>
        <button onClick={() => setShowCampFilters(true)}
          className={`btn ${campActiveCount > 0 ? "btn-primary" : "btn-ghost"}`}
          style={{ fontSize: 12, padding: "5px 12px", display: "flex", alignItems: "center", gap: 5 }}>
          <Ic icon={Filter} size={13} /> {t("filter.filters")}
          {campActiveCount > 0 && (
            <span style={{ background: "var(--red)", color: "#fff", borderRadius: 8,
              fontSize: 9, padding: "1px 5px", minWidth: 14, textAlign: "center" }}>{campActiveCount}</span>
          )}
        </button>
        {campActiveCount > 0 && (
          <button onClick={() => { resetCampFilters(); setPage(1); }} className="btn btn-ghost"
            style={{ fontSize: 11, padding: "4px 10px", color: "var(--tx3)" }}><X size={11} strokeWidth={1.75} style={{display:'inline-block',verticalAlign:'middle'}} /> {t("filter.reset")}</button>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          <button className="btn btn-ghost" style={{ fontSize: 12 }} data-refresh-btn onClick={reload}><Ic icon={RefreshCw} size={13} /> {t("common.refresh")}</button>
          {lastSync && (
            <span className="last-sync-label" style={{ marginLeft: 2 }}>
              · {fmtLastSync(lastSync)}
            </span>
          )}
          {CampColsBtn}
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={campResetCols} title="Reset column widths"><Ic icon={Minus} size={13} /></button>
        </div>
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
                <table className="resizable">
                  {campColgroup}
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}>
                        <input type="checkbox" checked={selected.size === campaigns.length && campaigns.length > 0} onChange={toggleAll} />
                      </th>
                      {campCV("name")   && <SortHeader field="name"   label={t("campaigns.colName")}   currentSort={sortBy} currentDir={sortDir} onSort={handleCampSort} rh={campRH(1)} />}
                      {campCV("type")   && <th>{t("campaigns.colType")}{campRH(2)}</th>}
                      {campCV("status") && <SortHeader field="state"  label={t("campaigns.colStatus")} currentSort={sortBy} currentDir={sortDir} onSort={handleCampSort} rh={campRH(3)} />}
                      {campCV("budget") && <SortHeader field="budget" label={t("campaigns.colBudget")} currentSort={sortBy} currentDir={sortDir} onSort={handleCampSort} align="right" rh={campRH(4)} />}
                      {campCV("spend")  && <SortHeader field="spend"  label="Spend" currentSort={sortBy} currentDir={sortDir} onSort={handleCampSort} align="right" rh={campRH(5)} />}
                      {campCV("sales")  && <SortHeader field="sales"  label="Sales" currentSort={sortBy} currentDir={sortDir} onSort={handleCampSort} align="right" rh={campRH(6)} />}
                      {campCV("acos")   && <SortHeader field="acos"   label="ACOS"  currentSort={sortBy} currentDir={sortDir} onSort={handleCampSort} align="right" rh={campRH(7)} />}
                      {campCV("roas")   && <SortHeader field="roas"   label="ROAS"  currentSort={sortBy} currentDir={sortDir} onSort={handleCampSort} align="right" rh={campRH(8)} />}
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaigns.map(c => (
                      <tr key={c.id} className={`tbl-row${selected.has(c.id) ? ' row-selected' : ''}`}>
                        <td><input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleSelect(c.id)} /></td>
                        {campCV("name") && <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>
                          <span
                            onClick={(e) => { e.stopPropagation(); openCampaignPanel(c); }}
                            style={{ cursor: 'pointer', color: 'var(--ac2)' }}
                            onMouseEnter={e => e.target.style.textDecoration = 'underline'}
                            onMouseLeave={e => e.target.style.textDecoration = 'none'}
                            title="View campaign details"
                          >{c.name}</span>
                        </td>}
                        {campCV("type") && <td><span className="badge bg-bl">{typeLabel(c.campaign_type)}</span></td>}
                        {campCV("status") && <td>
                          {editId === c.id
                            ? (
                              <select value={editState} onChange={e => setEditState(e.target.value)} style={{ fontSize: 11, padding: "3px 6px" }}>
                                <option value="enabled">enabled</option>
                                <option value="paused">paused</option>
                                <option value="archived">archived</option>
                              </select>
                            )
                            : (
                              <span
                                className={`tag status-clickable ${c.state === "enabled" ? "tag-on" : c.state === "paused" ? "tag-pause" : "tag-arch"}`}
                                onClick={() => { setEditId(c.id); setEditState(c.state); }}
                                title="Click to change status"
                              >
                                <span style={{ width: 5, height: 5, borderRadius: "50%", background: "currentColor", display: "inline-block" }} />
                                {c.state}
                              </span>
                            )
                          }
                        </td>}
                        {campCV("budget") && <td className="num" style={{ textAlign: "right", minWidth: 80 }}>
                          {(() => {
                            const pct = budgetUtil(c.spend, c.daily_budget, campFilters.metricsDays || 30);
                            const barColor = pct === null ? null
                              : pct >= 100 ? 'var(--red)'
                              : pct >= 85  ? 'var(--amb)'
                              : pct >= 50  ? 'var(--grn)'
                              : 'var(--tx3)';
                            const tipText = pct !== null
                              ? `Avg daily spend: $${(c.spend / (campFilters.metricsDays || 30)).toFixed(2)} / $${parseFloat(c.daily_budget).toFixed(0)} budget (${pct}% utilized)`
                              : 'No budget set';
                            return (
                              <Tip text={tipText} width={210}>
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                                    {c.daily_budget ? `$${parseFloat(c.daily_budget).toFixed(0)}` : '—'}
                                  </span>
                                  {pct !== null && (
                                    <div style={{ width: 60, height: 3, borderRadius: 2, background: 'var(--b2)', marginTop: 3, overflow: 'hidden' }}>
                                      <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: barColor, borderRadius: 2, transition: 'width 300ms ease' }} />
                                    </div>
                                  )}
                                </div>
                              </Tip>
                            );
                          })()}
                        </td>}
                        {campCV("spend") && <td className="num" style={{ textAlign: "right", color: "var(--ac2)" }}>${parseFloat(c.spend || 0).toFixed(0)}</td>}
                        {campCV("sales") && <td className="num" style={{ textAlign: "right", color: "var(--grn)" }}>{c.sales > 0 ? `$${parseFloat(c.sales).toFixed(0)}` : "—"}</td>}
                        {campCV("acos") && <td className="num" style={{ textAlign: "right", color: acosColor(c.acos) }}>
                          {c.acos > 0 ? `${parseFloat(c.acos).toFixed(1)}%` : "—"}
                        </td>}
                        {campCV("roas") && <td className="num" style={{ textAlign: "right", color: "var(--pur)" }}>
                          {c.roas > 0 ? `${parseFloat(c.roas).toFixed(2)}×` : "—"}
                        </td>}
                        <td className="act-cell">
                          {editId === c.id
                            ? (
                              <div style={{ display: "flex", gap: 4 }}>
                                <button className="btn btn-green" style={{ fontSize: 10, padding: "3px 8px" }}
                                  onClick={() => updateCampaign(c.id, { state: editState })} disabled={saving}>
                                  {saving ? "…" : <Check size={11} strokeWidth={1.75} />}
                                </button>
                                <button className="btn btn-ghost" style={{ fontSize: 10, padding: "3px 8px" }} onClick={() => setEditId(null)}><X size={11} strokeWidth={1.75} /></button>
                              </div>
                            )
                            : (
                              <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
                                <button className="btn btn-ghost" style={{ fontSize: 11, padding: "4px 8px" }}
                                  onClick={() => { setEditId(c.id); setEditState(c.state); }}>
                                  {t("common.edit")}
                                </button>
                                <ChangeHistoryBtn entityId={c.id} />
                              </div>
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

      {(data?.pagination?.total > 0) && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14, flexWrap: "wrap", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--tx2)" }}>
            {t("common.perPage")}
            {[25, 50, 100, 200].map(size => (
              <button key={size} onClick={() => { setPageSize(size); setPage(1); }}
                className={`btn ${pageSize === size ? "btn-primary" : "btn-ghost"}`}
                style={{ fontSize: 11, padding: "4px 10px", minWidth: 36 }}>{size}</button>
            ))}
          </div>
          <div style={{ fontSize: 13, color: "var(--tx2)" }}>
            {((page - 1) * pageSize) + 1}–{Math.min(page * pageSize, data.pagination.total)} {t("common.of")} {data.pagination.total.toLocaleString()}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }}
              onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>{t("common.back")}</button>
            {getPageRange(page, data.pagination.pages ?? 1).map((p, i) =>
              p === "..." ? <span key={`e${i}`} style={{ padding: "0 6px", color: "var(--tx3)" }}>…</span>
              : <button key={p} onClick={() => setPage(p)} className={`btn ${page === p ? "btn-primary" : "btn-ghost"}`}
                  style={{ fontSize: 11, padding: "4px 8px", minWidth: 32 }}>{p}</button>
            )}
            <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }}
              onClick={() => setPage(p => Math.min(data.pagination.pages ?? 1, p + 1))} disabled={page === (data.pagination.pages ?? 1)}>{t("common.next")}</button>
          </div>
        </div>
      )}

      {showBudgetModal && createPortal(
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "flex-start", justifyContent: "center", overflowY: "auto", padding: "24px 16px", zIndex: 1000 }}>
          <div className="card fade" style={{ width: 360, padding: "24px 28px", margin: "0 auto", flexShrink: 0 }}>
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
        </div>,
      document.body
      )}

      {/* S2-4: Campaign drill-down panel */}
      {panelCampaign && createPortal(
        <div>
          <div onClick={() => setPanelCampaign(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 800 }} />
          <div style={{ position: 'fixed', top: 0, right: 0, width: 520, height: '100vh', background: 'var(--s2)', borderLeft: '1px solid var(--b1)', zIndex: 801, display: 'flex', flexDirection: 'column', overflowY: 'hidden', animation: 'slideInRight 200ms ease' }}>
            {/* Header */}
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--b1)', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexShrink: 0 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--tx)', maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {panelCampaign.name}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  {[
                    { label: 'Type',       value: panelCampaign.campaign_type || '—' },
                    { label: 'Status',     value: panelCampaign.state, color: panelCampaign.state === 'enabled' ? 'var(--grn)' : 'var(--tx3)' },
                    { label: 'Budget/day', value: panelCampaign.daily_budget ? `$${parseFloat(panelCampaign.daily_budget).toFixed(0)}` : '—' },
                    { label: 'Spend',      value: `$${parseFloat(panelCampaign.spend || 0).toFixed(0)}` },
                    { label: 'ACOS',       value: panelCampaign.acos != null ? `${parseFloat(panelCampaign.acos).toFixed(1)}%` : '—', color: panelCampaign.acos != null ? acosColor(parseFloat(panelCampaign.acos)) : 'var(--tx3)' },
                    { label: 'ROAS',       value: panelCampaign.roas != null ? `${parseFloat(panelCampaign.roas).toFixed(2)}×` : '—' },
                  ].map(stat => (
                    <span key={stat.label} style={{ fontSize: 11, background: 'var(--s3)', border: '1px solid var(--b2)', borderRadius: 5, padding: '2px 8px', color: stat.color || 'var(--tx2)', whiteSpace: 'nowrap' }}>
                      <span style={{ color: 'var(--tx3)' }}>{stat.label}:</span> {stat.value}
                    </span>
                  ))}
                </div>
              </div>
              <button onClick={() => setPanelCampaign(null)} style={{ background: 'none', border: 'none', color: 'var(--tx3)', cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: '0 4px', flexShrink: 0 }}>×</button>
            </div>
            {/* Keywords label */}
            <div style={{ padding: '10px 20px 8px', borderBottom: '1px solid var(--b1)', fontSize: 11, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--tx3)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              Keywords
              {!panelLoading && <span style={{ background: 'var(--s3)', border: '1px solid var(--b2)', borderRadius: 10, padding: '1px 7px', fontSize: 11, color: 'var(--tx2)', textTransform: 'none', letterSpacing: 0 }}>{panelKws.length}</span>}
            </div>
            {/* Keywords table */}
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {panelLoading ? (
                <div style={{ padding: 40, textAlign: 'center' }}><span className="loader" /></div>
              ) : panelKws.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: 'var(--tx3)', fontSize: 13 }}>{t("settings.noPanelKeywords")}</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ position: 'sticky', top: 0, background: 'var(--s2)' }}>
                      {['Keyword', 'Match', 'Bid', 'Clicks', 'ACOS', 'Spend'].map(h => (
                        <th key={h} style={{ padding: '8px 12px', textAlign: h === 'Keyword' || h === 'Match' ? 'left' : 'right', color: 'var(--tx3)', fontWeight: 500, fontSize: 11, borderBottom: '1px solid var(--b1)', whiteSpace: 'nowrap', fontFamily: 'var(--mono)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {panelKws.slice(0, 100).map((kw, i) => (
                      <tr key={kw.id} style={{ borderBottom: '1px solid var(--b1)', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)' }}>
                        <td style={{ padding: '7px 12px', color: 'var(--tx)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={kw.keyword_text}>{kw.keyword_text}</td>
                        <td style={{ padding: '7px 12px', color: 'var(--tx3)', fontSize: 10, textTransform: 'lowercase' }}>{kw.match_type}</td>
                        <td style={{ padding: '7px 12px', textAlign: 'right', color: 'var(--ac2)', fontFamily: 'var(--mono)' }}>${parseFloat(kw.bid || 0).toFixed(2)}</td>
                        <td style={{ padding: '7px 12px', textAlign: 'right', color: 'var(--tx2)', fontFamily: 'var(--mono)' }}>{kw.clicks ? Number(kw.clicks).toLocaleString() : '—'}</td>
                        <td style={{ padding: '7px 12px', textAlign: 'right', color: kw.acos != null ? acosColor(parseFloat(kw.acos)) : 'var(--tx3)', fontFamily: 'var(--mono)' }}>{kw.acos != null ? parseFloat(kw.acos).toFixed(1) + '%' : '—'}</td>
                        <td style={{ padding: '7px 12px', textAlign: 'right', color: 'var(--tx2)', fontFamily: 'var(--mono)' }}>{kw.spend && parseFloat(kw.spend) > 0 ? '$' + parseFloat(kw.spend).toFixed(2) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {/* Footer */}
            <div style={{ padding: '12px 20px', borderTop: '1px solid var(--b1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
              <span style={{ fontSize: 11, color: 'var(--tx3)' }}>Showing top {Math.min(panelKws.length, 100)} keywords by spend</span>
              <button onClick={() => setPanelCampaign(null)} style={{ fontSize: 12, padding: '4px 12px', background: 'var(--s3)', border: '1px solid var(--b2)', borderRadius: 5, color: 'var(--tx2)', cursor: 'pointer' }}>{t("settings.close")}</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      <FilterPanel
        isOpen={showCampFilters}
        onClose={() => setShowCampFilters(false)}
        filters={campFilters}
        onUpdate={(k, v) => { setCampFilter(k, v); setPage(1); }}
        onReset={() => { resetCampFilters(); setPage(1); }}
        presets={campPresets}
        onSavePreset={saveCampPreset}
        onLoadPreset={p => { loadCampPreset(p); setPage(1); }}
        onDeletePreset={deleteCampPreset}
        fields={[
          { key: "status", label: t("campaigns.colStatus"), type: "select", options: [
            { value: "enabled", label: "Enabled" }, { value: "paused", label: "Paused" }, { value: "archived", label: "Archived" },
          ]},
          { key: "type", label: t("campaigns.colType"), type: "select", options: [
            { value: "SP", label: "Sponsored Products" }, { value: "SB", label: "Sponsored Brands" }, { value: "SD", label: "Sponsored Display" },
          ]},
          { key: "budget", label: t("campaigns.colBudget"), type: "range", min: 0, max: 10000, step: 1, unit: "€" },
          { key: "metricsDays", label: t("filter.metricsPeriod"), type: "select", options: [
            { value: 7, label: "7 days" }, { value: 14, label: "14 days" }, { value: 30, label: "30 days" },
            { value: 60, label: "60 days" }, { value: 90, label: "90 days" },
          ]},
          { key: "spend", label: "Spend", type: "range", min: 0, max: 10000, step: 1, unit: "€" },
          { key: "acos", label: "ACOS", type: "range", min: 0, max: 200, step: 0.1, unit: "%" },
          { key: "roas", label: "ROAS", type: "range", min: 0, max: 100, step: 0.1, unit: "×" },
          { key: "ordersMin", label: t("filter.minOrders"), type: "number", min: 0 },
          { key: "clicksMin", label: t("filter.minClicks"), type: "number", min: 0 },
          { key: "noSales", label: t("filter.noSales"), type: "toggle" },
          { key: "hasMetrics", label: t("filter.hasActivity"), type: "toggle" },
        ]}
      />
    </div>
  );
};

// ─── Reports Page ─────────────────────────────────────────────────────────────
const ReportsPage = ({ workspaceId }) => {
  const { t } = useI18n();
  const [form, setForm] = useState({ campaignType: "SP", reportLevel: "campaign", startDate: "", endDate: "" });
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const { colgroup: repColgroup, resizeHandle: repRH } = useResizableColumns(
    "reports", [110, 170, 110, 90, 150]
  );

  const { data: reportsData, loading, reload } = useAsync(
    () => workspaceId ? get("/reports", { page, limit: pageSize }) : Promise.resolve({ data: [], pagination: {} }),
    [workspaceId, page, pageSize]
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
        <div style={{ fontSize: 13, color: "var(--tx2)" }}>Download advertising performance data by campaign type and date range</div>
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
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              {[{ label: '7d', days: 7 }, { label: '14d', days: 14 }, { label: '30d', days: 30 }].map(({ label, days }) => (
                <button key={label} onClick={() => {
                  const to = new Date();
                  const from = new Date();
                  from.setDate(from.getDate() - days);
                  setForm(f => ({ ...f, startDate: from.toISOString().slice(0, 10), endDate: to.toISOString().slice(0, 10) }));
                }} style={{ fontSize: 11, padding: '3px 8px', background: 'var(--s2)', border: '1px solid var(--b2)', borderRadius: 5, color: 'var(--tx2)', cursor: 'pointer' }}>
                  {label}
                </button>
              ))}
            </div>
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
            <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={reload}><Ic icon={RefreshCw} size={13} /></button>
          </div>
          {loading
            ? <div style={{ padding: 30, textAlign: "center" }}><span className="loader" /></div>
            : !reportsData?.data?.length
              ? <div style={{ padding: "30px 20px", textAlign: "center", color: "var(--tx3)", fontSize: 13 }}>{t("reports.noReports")}</div>
              : (
                <table className="resizable">
                  {repColgroup}
                  <thead><tr>
                    <th>{t("reports.colType")}{repRH(0)}</th>
                    <th>{t("reports.colPeriod")}{repRH(1)}</th>
                    <th>{t("reports.colStatus")}{repRH(2)}</th>
                    <th>{t("reports.colRows")}{repRH(3)}</th>
                    <th>{t("reports.colCreated")}{repRH(4)}</th>
                  </tr></thead>
                  <tbody>
                    {reportsData.data.map(r => (
                      <tr key={r.id}>
                        <td><span className="badge bg-bl">{r.campaign_type}</span> <span style={{ fontSize: 11, color: "var(--tx3)" }}>{fmtReportType(r.report_type)}</span></td>
                        <td className="num" style={{ fontSize: 11 }}>{fmtReportPeriod(r.date_start, r.date_end)}</td>
                        <td>
                          {r.status === 'failed' ? (
                            <Tip text="Amazon API did not return data for this period. This is usually temporary — try re-running the report or check your connection." width={220}>
                              <span style={{ fontSize: 10, padding: '2px 7px', background: 'rgba(239,68,68,0.15)',
                                color: 'var(--red)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 4,
                                cursor: 'help', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                failed <Ic icon={HelpCircle} size={10} />
                              </span>
                            </Tip>
                          ) : (
                            <span style={{ fontSize: 10, padding: '2px 7px',
                              background: r.status === 'completed' ? 'rgba(34,197,94,0.15)' : 'var(--s3)',
                              color: r.status === 'completed' ? 'var(--grn)' : 'var(--tx2)',
                              border: `1px solid ${r.status === 'completed' ? 'rgba(34,197,94,0.3)' : 'var(--b2)'}`,
                              borderRadius: 4 }}>
                              {r.status}
                            </span>
                          )}
                        </td>
                        <td className="num">{r.row_count ?? "—"}</td>
                        <td style={{ fontSize: 11, color: "var(--tx3)" }}>{new Date(r.created_at).toLocaleString("ru")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
          }
          {(reportsData?.pagination?.total > 0) && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", flexWrap: "wrap", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--tx2)" }}>
                {[25, 50, 100].map(size => (
                  <button key={size} onClick={() => { setPageSize(size); setPage(1); }}
                    className={`btn ${pageSize === size ? "btn-primary" : "btn-ghost"}`}
                    style={{ fontSize: 11, padding: "3px 8px" }}>{size}</button>
                ))}
              </div>
              <div style={{ fontSize: 12, color: "var(--tx2)" }}>
                {((page - 1) * pageSize) + 1}–{Math.min(page * pageSize, reportsData.pagination.total)} {t("common.of")} {reportsData.pagination.total}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <button className="btn btn-ghost" style={{ fontSize: 11, padding: "3px 8px" }}
                  onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>←</button>
                {getPageRange(page, reportsData.pagination.pages ?? 1).map((p, i) =>
                  p === "..." ? <span key={`e${i}`} style={{ padding: "0 4px", color: "var(--tx3)" }}>…</span>
                  : <button key={p} onClick={() => setPage(p)} className={`btn ${page === p ? "btn-primary" : "btn-ghost"}`}
                      style={{ fontSize: 11, padding: "3px 7px", minWidth: 28 }}>{p}</button>
                )}
                <button className="btn btn-ghost" style={{ fontSize: 11, padding: "3px 8px" }}
                  onClick={() => setPage(p => Math.min(reportsData.pagination.pages ?? 1, p + 1))} disabled={page === (reportsData.pagination.pages ?? 1)}>→</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── Audit Page ───────────────────────────────────────────────────────────────
const ACTION_BADGE = {
  "campaign.update":           "bg-bl",
  "keyword.bid_change":        "bg-pur",
  "keyword.adjust_bid_pct":    "bg-pur",
  "keyword.set_bid":           "bg-pur",
  "keyword.pause_keyword":     "bg-amb",
  "keyword.enable_keyword":    "bg-grn",
  "keyword.state_change":      "bg-amb",
  "ai.recommendation_applied": "bg-teal",
  "connection.created":        "bg-grn",
};
const getActionBadge = (action) => action?.endsWith(".rollback") ? "bg-red" : (ACTION_BADGE[action] || "bg-bl");
const SOURCE_ICONS   = {
  ui:     <Pencil size={11} strokeWidth={1.75} color="var(--ac2)" />,
  rule:   <Workflow size={11} strokeWidth={1.75} color="var(--pur)" />,
  ai:     <Sparkles size={11} strokeWidth={1.75} color="var(--teal)" />,
  system: <Cog size={11} strokeWidth={1.75} color="var(--tx3)" />,
  api:    <Plug2 size={11} strokeWidth={1.75} color="var(--amb)" />,
};

const AuditPage = ({ workspaceId }) => {
  const { t } = useI18n();

  const [filterAction,   setFilterAction]   = useState("");
  const [filterEntity,   setFilterEntity]   = useState("");
  const [filterSource,   setFilterSource]   = useState("");
  const [filterActor,    setFilterActor]    = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo,   setFilterDateTo]   = useState("");
  const [onlyRollback,   setOnlyRollback]   = useState(false);
  const [sortBy,   setSortBy]   = useState("date");
  const [sortDir,  setSortDir]  = useState("desc");
  const [page,     setPage]     = useState(1);
  const [limit,    setLimit]    = useState(50);
  const [rollingBack,  setRollingBack]  = useState(null);
  const [rollbackMsg,  setRollbackMsg]  = useState({});
  const { colgroup: auditColgroup, resizeHandle: auditRH, resetCols: auditResetCols } = useResizableColumns(
    "audit", [130, 130, 160, 190, 220, 110]
  );

  useEffect(() => { setPage(1); }, [filterAction, filterEntity, filterSource, filterActor, filterDateFrom, filterDateTo, onlyRollback, sortBy, sortDir]);

  const buildQuery = () => ({
    limit, page, sortBy, sortDir,
    ...(filterAction   && { action: filterAction }),
    ...(filterEntity   && { entityName: filterEntity }),
    ...(filterSource   && { source: filterSource }),
    ...(filterActor    && { actorId: filterActor }),
    ...(filterDateFrom && { dateFrom: filterDateFrom }),
    ...(filterDateTo   && { dateTo: filterDateTo }),
    ...(onlyRollback   && { rollbackable: "true" }),
  });

  const { data: auditData, loading, reload } = useAsync(
    () => workspaceId ? get("/audit", buildQuery()) : Promise.resolve({ data: [], pagination: {} }),
    [workspaceId, page, limit, sortBy, sortDir, filterAction, filterEntity, filterSource, filterActor, filterDateFrom, filterDateTo, onlyRollback]
  );
  const { data: allAudit } = useAsync(
    () => workspaceId ? get("/audit", { limit: 200, page: 1 }) : Promise.resolve({ data: [] }),
    [workspaceId]
  );

  const events     = auditData?.data       || [];
  const pagination = auditData?.pagination || {};
  const uniqueActors = [...new Map((allAudit?.data || [])
    .filter(e => e.actor_id && e.actor_name)
    .map(e => [e.actor_id, { id: e.actor_id, name: e.actor_name }])
  ).values()];

  const handleSort = (field) => {
    if (sortBy === field) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortBy(field); setSortDir("desc"); }
  };
  const SortIcon = ({ field }) => sortBy === field
    ? <span style={{ marginLeft: 3, display:"inline-block", verticalAlign:"middle" }}>{sortDir === "asc" ? <ChevronUp size={10} strokeWidth={1.75} /> : <ChevronDown size={10} strokeWidth={1.75} />}</span>
    : <span style={{ marginLeft: 3, opacity: 0.3, display:"inline-block", verticalAlign:"middle" }}><ChevronDown size={10} strokeWidth={1.75} /></span>;

  const handleRollback = async (event) => {
    if (!confirm(t("audit.rollbackConfirm", { action: event.action, entity: event.entity_name }))) return;
    setRollingBack(event.id);
    try {
      const result = await post(`/audit/${event.id}/rollback`);
      setRollbackMsg(m => ({ ...m, [event.id]: { ok: true, msg: result.message } }));
      setTimeout(() => { setRollbackMsg(m => { const n = { ...m }; delete n[event.id]; return n; }); reload(); }, 3000);
    } catch (e) {
      setRollbackMsg(m => ({ ...m, [event.id]: { ok: false, msg: e.message || "Error" } }));
      setTimeout(() => setRollbackMsg(m => { const n = { ...m }; delete n[event.id]; return n; }), 3000);
    } finally { setRollingBack(null); }
  };

  const canRollback = (event) =>
    event.before_data &&
    !event.action?.endsWith(".rollback") &&
    ["keyword", "campaign"].includes(event.entity_type) &&
    ["keyword.bid_change","keyword.pause_keyword","keyword.enable_keyword",
     "keyword.adjust_bid_pct","keyword.set_bid","keyword.state_change","campaign.update"].includes(event.action);

  const INP = { fontSize: 12, padding: "6px 10px", borderRadius: 6,
    background: "var(--s2)", border: "1px solid var(--b2)", color: "var(--tx)", outline: "none" };
  const hasFilters = filterAction || filterEntity || filterSource || filterActor || filterDateFrom || filterDateTo || onlyRollback;

  return (
    <div className="fade">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <h1 style={{ fontFamily: "var(--disp)", fontSize: 22, fontWeight: 700 }}>{t("audit.title")}</h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--tx3)" }}>{t("audit.events", { count: pagination.total || 0 })}</span>
          <button className="btn btn-ghost" onClick={reload} style={{ fontSize: 12, padding: "5px 10px" }}><Ic icon={RefreshCw} size={13} /></button>
          <button className="btn btn-ghost" onClick={auditResetCols} style={{ fontSize: 12, padding: "5px 10px" }} title="Reset column widths"><Ic icon={Minus} size={13} /></button>
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="card" style={{ padding: "12px 16px", marginBottom: 12 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
          <div>
            <div style={{ fontSize: 10, color: "var(--tx3)", marginBottom: 3, fontFamily: "var(--mono)", textTransform: "uppercase" }}>{t("audit.filterAction")}</div>
            <input value={filterAction} onChange={e => setFilterAction(e.target.value)}
              placeholder="keyword, campaign…" style={{ ...INP, width: 150 }} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "var(--tx3)", marginBottom: 3, fontFamily: "var(--mono)", textTransform: "uppercase" }}>{t("audit.filterEntity")}</div>
            <input value={filterEntity} onChange={e => setFilterEntity(e.target.value)}
              placeholder={t("audit.filterEntity").toLowerCase() + "…"} style={{ ...INP, width: 150 }} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "var(--tx3)", marginBottom: 3, fontFamily: "var(--mono)", textTransform: "uppercase" }}>{t("audit.filterSource")}</div>
            <select value={filterSource} onChange={e => setFilterSource(e.target.value)} style={{ ...INP, width: 100 }}>
              <option value="">{t("audit.filterSourceAll")}</option>
              <option value="ui">{t("audit.sourceUi")}</option>
              <option value="rule">{t("audit.sourceRule")}</option>
              <option value="ai">{t("audit.sourceAi")}</option>
              <option value="system">{t("audit.sourceSystem")}</option>
              <option value="api">{t("audit.sourceApi")}</option>
            </select>
          </div>
          {uniqueActors.length > 1 && (
            <div>
              <div style={{ fontSize: 10, color: "var(--tx3)", marginBottom: 3, fontFamily: "var(--mono)", textTransform: "uppercase" }}>{t("audit.filterActor")}</div>
              <select value={filterActor} onChange={e => setFilterActor(e.target.value)} style={{ ...INP, width: 130 }}>
                <option value="">{t("audit.filterSourceAll")}</option>
                {uniqueActors.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
          )}
          <div>
            <div style={{ fontSize: 10, color: "var(--tx3)", marginBottom: 3, fontFamily: "var(--mono)", textTransform: "uppercase" }}>{t("audit.dateFrom")}</div>
            <input type="date" value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)} style={{ ...INP, width: 128 }} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "var(--tx3)", marginBottom: 3, fontFamily: "var(--mono)", textTransform: "uppercase" }}>{t("audit.dateTo")}</div>
            <input type="date" value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)} style={{ ...INP, width: 128 }} />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
            fontSize: 12, color: onlyRollback ? "var(--ac2)" : "var(--tx3)", paddingBottom: 2 }}>
            <input type="checkbox" checked={onlyRollback} onChange={e => setOnlyRollback(e.target.checked)}
              style={{ accentColor: "var(--ac)", width: 13, height: 13 }} />
            {t("audit.onlyRollback")}
          </label>
          {hasFilters && (
            <button onClick={() => { setFilterAction(""); setFilterEntity(""); setFilterSource("");
              setFilterActor(""); setFilterDateFrom(""); setFilterDateTo(""); setOnlyRollback(false); }}
              className="btn btn-ghost" style={{ fontSize: 11, padding: "5px 10px" }}>{t("common.reset")}</button>
          )}
          <div style={{ marginLeft: "auto" }}>
            <select value={limit} onChange={e => { setLimit(parseInt(e.target.value)); setPage(1); }}
              style={{ ...INP, width: 75 }}>
              {[25, 50, 100, 200].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* ── Table ── */}
      {loading ? (
        <div style={{ color: "var(--tx3)", padding: "20px 0", fontSize: 13 }}>{t("common.loading")}</div>
      ) : events.length === 0 ? (
        <div className="card" style={{ padding: "48px 32px", textAlign: "center" }}>
          <div style={{ marginBottom: 10 }}><History size={32} strokeWidth={1.5} color="var(--tx3)" /></div>
          <div style={{ fontSize: 14, color: "var(--tx3)" }}>{t("audit.noEvents")}</div>
        </div>
      ) : (
        <div className="card" style={{ overflow: "auto" }}>
          <table className="resizable">
            {auditColgroup}
            <thead>
              <tr>
                <th onClick={() => handleSort("date")} style={{ cursor: "pointer", userSelect: "none" }}>
                  {t("audit.colTime")} <SortIcon field="date" />{auditRH(0)}
                </th>
                <th onClick={() => handleSort("actor_name")} style={{ cursor: "pointer", userSelect: "none" }}>
                  {t("audit.colUser")} <SortIcon field="actor_name" />{auditRH(1)}
                </th>
                <th onClick={() => handleSort("action")} style={{ cursor: "pointer", userSelect: "none" }}>
                  {t("audit.colAction")} <SortIcon field="action" />{auditRH(2)}
                </th>
                <th onClick={() => handleSort("entity_type")} style={{ cursor: "pointer", userSelect: "none" }}>
                  {t("audit.colEntity")} <SortIcon field="entity_type" />{auditRH(3)}
                </th>
                <th>{t("audit.diff")}{auditRH(4)}</th>
                <th style={{ textAlign: "right" }}>{t("audit.rollback")}{auditRH(5)}</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event, idx) => {
                const diff = event.diff
                  ? (typeof event.diff === "string" ? JSON.parse(event.diff) : event.diff)
                  : null;
                const canRb = canRollback(event);
                const rbState = rollbackMsg[event.id];
                const isRollingBack = rollingBack === event.id;
                const prevDateStr = idx > 0 ? new Date(events[idx - 1].created_at).toDateString() : null;
                const eventDateStr = new Date(event.created_at).toDateString();
                const isNewDay = eventDateStr !== prevDateStr;
                const entityDisplay = event.entity_name
                  ? event.entity_name
                  : event.entity_type === 'connection'
                    ? 'Amazon Ads Account'
                    : event.entity_id ? event.entity_id.slice(0, 8) + '…' : '—';
                return (
                  <React.Fragment key={event.id}>
                    {isNewDay && (
                      <tr className="audit-date-group">
                        <td colSpan={6}>{formatDateGroup(event.created_at)}</td>
                      </tr>
                    )}
                  <tr>
                    <td style={{ whiteSpace: "nowrap", fontSize: 11, fontFamily: "var(--mono)", color: "var(--tx3)" }}>
                      {new Date(event.created_at).toLocaleString("ru", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      <span style={{ marginRight: 4, display:"inline-block", verticalAlign:"middle" }}>{SOURCE_ICONS[event.source] || <MoreHorizontal size={11} strokeWidth={1.75} color="var(--tx3)" />}</span>
                      {event.actor_name || "—"}
                    </td>
                    <td>
                      <span style={{ fontSize: 12, color: 'var(--tx)', fontWeight: 500 }}>
                        {auditLabel(event.action)}
                      </span>
                      <span style={{ display: 'block', fontSize: 10, color: 'var(--tx3)', marginTop: 1 }}>
                        {event.action}
                      </span>
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {event.entity_type && (
                        <span className="badge bg-bl" style={{ fontSize: 9, marginRight: 4 }}>{event.entity_type}</span>
                      )}
                      <span style={{ color: "var(--tx2)", maxWidth: 180, overflow: "hidden",
                        textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-block" }}>
                        {entityDisplay}
                      </span>
                    </td>
                    <td style={{ fontSize: 11, fontFamily: "var(--mono)" }}>
                      {diff ? (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {Object.entries(diff).map(([field, { before, after }]) => (
                            <span key={field} style={{ fontSize: 10, padding: "2px 6px",
                              background: "var(--s3)", borderRadius: 4, color: "var(--tx2)" }}>
                              {field}:&nbsp;
                              <span style={{ color: "var(--red)" }}>{String(before ?? "—")}</span>
                              <span style={{ color: "var(--tx3)", margin: "0 3px" }}>→</span>
                              <span style={{ color: "var(--grn)" }}>{String(after ?? "—")}</span>
                            </span>
                          ))}
                        </div>
                      ) : <span style={{ color: "var(--tx3)" }}>—</span>}
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {rbState ? (
                        <span style={{ fontSize: 11, color: rbState.ok ? "var(--grn)" : "var(--red)" }}>
                          {rbState.ok ? <><Check size={11} strokeWidth={1.75} style={{display:'inline-block',verticalAlign:'middle'}} />{" "}</> : <><X size={11} strokeWidth={1.75} style={{display:'inline-block',verticalAlign:'middle'}} />{" "}</>}{rbState.msg}
                        </span>
                      ) : canRb ? (
                        <button onClick={() => handleRollback(event)} disabled={isRollingBack}
                          className="btn btn-ghost"
                          style={{ fontSize: 10, padding: "3px 8px", color: "var(--amb)", border: "1px solid rgba(245,158,11,.3)" }}>
                          {isRollingBack ? "…" : <><Ic icon={RotateCcw} size={11} />{" "}{t("audit.rollback")}</>}
                        </button>
                      ) : (
                        <span style={{ fontSize: 10, color: "var(--tx3)", opacity: 0.4 }}>—</span>
                      )}
                    </td>
                  </tr>
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Pagination ── */}
      {pagination.pages > 1 && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14, fontSize: 12 }}>
          <span style={{ color: "var(--tx3)" }}>
            {(page - 1) * limit + 1}–{Math.min(page * limit, pagination.total)} {t("common.of")} {pagination.total}
          </span>
          <div style={{ display: "flex", gap: 4 }}>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
              className="btn btn-ghost" style={{ fontSize: 12, padding: "5px 10px" }}>←</button>
            {getPageRange(page, pagination.pages).map((p, i) =>
              p === "..."
                ? <span key={`e${i}`} style={{ padding: "0 6px", color: "var(--tx3)" }}>…</span>
                : <button key={p} onClick={() => setPage(p)}
                    className={`btn ${page === p ? "btn-primary" : "btn-ghost"}`}
                    style={{ fontSize: 12, padding: "5px 10px", minWidth: 34 }}>{p}</button>
            )}
            <button onClick={() => setPage(p => Math.min(pagination.pages, p + 1))} disabled={page === pagination.pages}
              className="btn btn-ghost" style={{ fontSize: 12, padding: "5px 10px" }}>→</button>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Pagination helper ────────────────────────────────────────────────────────
function getPageRange(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set([1, total, current]);
  if (current > 1) pages.add(current - 1);
  if (current < total) pages.add(current + 1);
  const sorted = [...pages].sort((a, b) => a - b);
  const result = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) result.push("...");
    result.push(p);
    prev = p;
  }
  return result;
}

// ─── DateRangePicker ──────────────────────────────────────────────────────────
function DateRangePicker({ dateFrom, dateTo, metricsDays, onChange }) {
  const [showCustom, setShowCustom] = React.useState(!!(dateFrom || dateTo));
  const PRESETS = [
    { label: '7d',  days: 7  },
    { label: '14d', days: 14 },
    { label: '30d', days: 30 },
    { label: '90d', days: 90 },
  ];

  const applyPreset = (days) => {
    setShowCustom(false);
    const to   = new Date();
    const from = new Date();
    from.setDate(from.getDate() - days);
    onChange({
      dateFrom: from.toISOString().slice(0, 10),
      dateTo:   to.toISOString().slice(0, 10),
      metricsDays: days,
    });
  };

  const today   = new Date().toISOString().slice(0, 10);
  const minDate = '2024-01-01';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      {PRESETS.map(p => (
        <button
          key={p.days}
          onClick={() => applyPreset(p.days)}
          className={`btn ${!showCustom && p.days === (metricsDays || 30) ? 'btn-primary' : 'btn-ghost'}`}
          style={{ fontSize: 11, padding: '4px 8px' }}
        >{p.label}</button>
      ))}
      <button
        onClick={() => setShowCustom(v => !v)}
        className={`btn ${showCustom ? 'btn-primary' : 'btn-ghost'}`}
        style={{ fontSize: 11, padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4 }}
      >
        <Calendar size={11} strokeWidth={1.75} /> Range
      </button>
      {showCustom && (
        <>
          <input
            type="date" value={dateFrom || ''} min={minDate} max={dateTo || today}
            onChange={e => onChange({ dateFrom: e.target.value, dateTo, metricsDays: null })}
            style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--b2)',
                     background: 'var(--s2)', color: 'var(--tx)', fontSize: 12 }}
          />
          <span style={{ color: 'var(--tx2)', fontSize: 12 }}>—</span>
          <input
            type="date" value={dateTo || ''} min={dateFrom || minDate} max={today}
            onChange={e => onChange({ dateFrom, dateTo: e.target.value, metricsDays: null })}
            style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--b2)',
                     background: 'var(--s2)', color: 'var(--tx)', fontSize: 12 }}
          />
        </>
      )}
    </div>
  );
}

// ─── CampaignMultiSelect ──────────────────────────────────────────────────────
function CampaignMultiSelect({ selectedIds, onChange }) {
  const [open, setOpen]           = useState(false);
  const [campaigns, setCampaigns] = useState([]);
  const [search, setSearch]       = useState('');

  useEffect(() => {
    if (!open || campaigns.length > 0) return;
    apiFetch('/campaigns?limit=500')
      .then(d => setCampaigns(d.data || []))
      .catch(() => {});
  }, [open]);

  const filtered = campaigns.filter(c =>
    c.name?.toLowerCase().includes(search.toLowerCase())
  );

  const toggle = (id) => {
    onChange(
      selectedIds.includes(id)
        ? selectedIds.filter(x => x !== id)
        : [...selectedIds, id]
    );
  };

  const label = selectedIds.length === 0
    ? 'All campaigns'
    : selectedIds.length === 1
      ? (campaigns.find(c => c.id === selectedIds[0])?.name || '1 campaign')
      : `${selectedIds.length} campaigns`;

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(v => !v)}
        className={`btn ${selectedIds.length > 0 ? 'btn-primary' : 'btn-ghost'}`}
        style={{ fontSize: 11, padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 5, minWidth: 130 }}
      >
        <Filter size={11} strokeWidth={1.75} />
        <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>{label}</span>
        <ChevronDown size={11} strokeWidth={1.75} />
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: '110%', right: 0, zIndex: 999,
          background: 'var(--s1)', border: '1px solid var(--b2)',
          borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          width: 320, maxHeight: 340, display: 'flex', flexDirection: 'column',
        }}>
          <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--b1)' }}>
            <input
              autoFocus placeholder="Search campaigns…" value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ width: '100%', padding: '5px 8px', borderRadius: 5, fontSize: 12,
                background: 'var(--s2)', border: '1px solid var(--b2)',
                color: 'var(--tx)', outline: 'none', boxSizing: 'border-box' }}
            />
          </div>
          {selectedIds.length > 0 && (
            <div style={{ padding: '5px 10px', borderBottom: '1px solid var(--b1)' }}>
              <button onClick={() => onChange([])}
                style={{ fontSize: 11, color: 'var(--ac)', background: 'none',
                         border: 'none', cursor: 'pointer', padding: 0 }}>
                Clear ({selectedIds.length})
              </button>
            </div>
          )}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {filtered.length === 0 && (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--tx2)', fontSize: 12 }}>
                No campaigns
              </div>
            )}
            {filtered.map(c => (
              <label key={c.id}
                style={{ display: 'flex', alignItems: 'center', gap: 8,
                  padding: '7px 12px', cursor: 'pointer',
                  background: selectedIds.includes(c.id) ? 'rgba(59,130,246,0.08)' : 'transparent' }}>
                <input type="checkbox" checked={selectedIds.includes(c.id)}
                  onChange={() => toggle(c.id)}
                  style={{ accentColor: 'var(--ac)', width: 13, height: 13 }} />
                <span style={{ fontSize: 12, flex: 1, overflow: 'hidden',
                               textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.name}
                </span>
                {c.campaign_type && (
                  <span style={{ fontSize: 10, color: 'var(--tx3)', background: 'var(--s2)',
                                 padding: '1px 5px', borderRadius: 4 }}>
                    {c.campaign_type === 'sponsoredProducts' ? 'SP'
                      : c.campaign_type === 'sponsoredBrands' ? 'SB' : 'SD'}
                  </span>
                )}
              </label>
            ))}
          </div>
        </div>
      )}
      {open && <div onClick={() => setOpen(false)}
        style={{ position: 'fixed', inset: 0, zIndex: 998 }} />}
    </div>
  );
}

// ─── NegativesTab ─────────────────────────────────────────────────────────────
function NegativesTab({ workspaceId }) {
  const [negatives, setNegatives]   = useState([]);
  const [total, setTotal]           = useState(0);
  const [loading, setLoading]       = useState(true);
  const [page, setPage]             = useState(1);
  const PAGE_SIZE = 100;

  // Filters
  const [search, setSearch]         = useState('');
  const [filterMatchType, setFilterMatchType] = useState('');   // '' | 'negativeExact' | 'negativePhrase'
  const [filterLevel, setFilterLevel] = useState('');           // '' | 'campaign' | 'ad_group'
  const [filterCampaignType, setFilterCampaignType] = useState(''); // '' | 'SP' | 'SB' | 'SD'
  const [filterCampaignIds, setFilterCampaignIds] = useState([]);
  const [sortBy, setSortBy]         = useState('created_at');
  const [sortDir, setSortDir]       = useState('desc');

  // Selection
  const [selected, setSelected]     = useState(new Set());

  // Editing
  const [editId, setEditId]         = useState(null);
  const [editText, setEditText]     = useState('');
  const [editType, setEditType]     = useState('');
  const [editSaving, setEditSaving] = useState(false);

  // Modals
  const [showAddModal, setShowAddModal]   = useState(false);    // single add
  const [showBulkAdd, setShowBulkAdd]     = useState(false);    // bulk add textarea
  const [showCopyTo, setShowCopyTo]       = useState(false);    // copy selected to campaigns
  const [copyTargets, setCopyTargets]     = useState([]);
  const [bulkAddText, setBulkAddText]     = useState('');
  const [bulkAddType, setBulkAddType]     = useState('negativeExact');
  const [bulkAddCampaigns, setBulkAddCampaigns] = useState([]);
  const [bulkAddCampSearch, setBulkAddCampSearch] = useState('');
  const [bulkAdding, setBulkAdding]       = useState(false);
  const [toast, setToast]                 = useState(null);

  // Add single form
  const [newKw, setNewKw] = useState({ campaignId: '', adGroupId: '', keywordText: '', matchType: 'negativeExact' });
  const [newKwAdGroups, setNewKwAdGroups] = useState([]);
  const [addSaving, setAddSaving]   = useState(false);

  // Campaigns list (for pickers)
  const [campaigns, setCampaigns]   = useState([]);
  useEffect(() => {
    apiFetch('/campaigns?limit=500')
      .then(d => setCampaigns(d.data || []))
      .catch(() => {});
  }, [workspaceId]);

  // Load ad groups when campaign selected in add form
  useEffect(() => {
    if (!newKw.campaignId) { setNewKwAdGroups([]); return; }
    apiFetch(`/ad-groups?campaignId=${newKw.campaignId}&limit=100`)
      .then(d => setNewKwAdGroups(d.data || d || []))
      .catch(() => setNewKwAdGroups([]));
  }, [newKw.campaignId]);

  const showToast = (msg, ms = 3500) => { setToast(msg); setTimeout(() => setToast(null), ms); };

  const load = useCallback(() => {
    setLoading(true);
    const p = new URLSearchParams({ limit: PAGE_SIZE, page, sortBy, sortDir });
    if (search) p.set('search', search);
    if (filterMatchType) p.set('matchType', filterMatchType);
    if (filterLevel) p.set('level', filterLevel);
    if (filterCampaignType) p.set('campaignType', filterCampaignType);
    filterCampaignIds.forEach(id => p.append('campaignIds[]', id));
    apiFetch(`/negative-keywords?${p}`)
      .then(d => { setNegatives(d.data || []); setTotal(d.pagination?.total || 0); setSelected(new Set()); })
      .catch(() => setNegatives([]))
      .finally(() => setLoading(false));
  }, [search, filterMatchType, filterLevel, filterCampaignType, filterCampaignIds, sortBy, sortDir, page, workspaceId]);

  useEffect(() => { load(); }, [load]);

  // ── Sort helper ──
  const handleSort = (col) => {
    if (sortBy === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('asc'); }
  };
  const SortIcon = ({ col }) => sortBy === col ? <span style={{ marginLeft: 3 }}>{sortDir === 'asc' ? '↑' : '↓'}</span> : null;

  // ── Selection ──
  const toggleSelect = (id) => { const s = new Set(selected); s.has(id) ? s.delete(id) : s.add(id); setSelected(s); };
  const toggleAll = () => selected.size === negatives.length ? setSelected(new Set()) : setSelected(new Set(negatives.map(n => n.id)));

  // ── Delete single ──
  const remove = async (id) => {
    await apiFetch(`/negative-keywords/${id}`, { method: 'DELETE' });
    setNegatives(n => n.filter(x => x.id !== id));
    setTotal(t => t - 1);
    setSelected(s => { const ns = new Set(s); ns.delete(id); return ns; });
  };

  // ── Bulk delete ──
  const bulkDelete = async () => {
    if (!selected.size) return;
    if (!window.confirm(`Delete ${selected.size} negative(s)?`)) return;
    const ids = Array.from(selected);
    await apiFetch('/negative-keywords/bulk', { method: 'DELETE', body: JSON.stringify({ ids }) });
    setNegatives(n => n.filter(x => !ids.includes(x.id)));
    setTotal(t => t - ids.length);
    setSelected(new Set());
    showToast(`Deleted ${ids.length} negative(s)`);
  };

  // ── Inline edit ──
  const startEdit = (n) => { setEditId(n.id); setEditText(n.keyword_text); setEditType(n.match_type); };
  const saveEdit = async () => {
    if (!editId) return;
    setEditSaving(true);
    try {
      const r = await apiFetch(`/negative-keywords/${editId}`, {
        method: 'PATCH', body: JSON.stringify({ keywordText: editText, matchType: editType }),
      });
      setNegatives(ns => ns.map(n => n.id === editId ? { ...n, keyword_text: r.data.keyword_text, match_type: r.data.match_type } : n));
      setEditId(null);
      showToast('Saved');
    } catch (e) { showToast('Error: ' + e.message); }
    setEditSaving(false);
  };
  const cancelEdit = () => setEditId(null);

  // ── Quick match type toggle ──
  const toggleMatchType = async (n) => {
    const newType = isExact(n.match_type) ? 'negativePhrase' : 'negativeExact';
    const r = await apiFetch(`/negative-keywords/${n.id}`, {
      method: 'PATCH', body: JSON.stringify({ matchType: newType }),
    });
    setNegatives(ns => ns.map(x => x.id === n.id ? { ...x, match_type: r.data.match_type } : x));
  };

  // ── Add single ──
  const addSingle = async () => {
    if (!newKw.campaignId || !newKw.keywordText.trim()) return;
    setAddSaving(true);
    try {
      await apiFetch('/negative-keywords', {
        method: 'POST',
        body: JSON.stringify({ campaignId: newKw.campaignId, adGroupId: newKw.adGroupId || undefined,
          keywordText: newKw.keywordText, matchType: newKw.matchType }),
      });
      setShowAddModal(false);
      setNewKw({ campaignId: '', adGroupId: '', keywordText: '', matchType: 'negativeExact' });
      load();
      showToast('Negative keyword added');
    } catch (e) { showToast('Error: ' + e.message); }
    setAddSaving(false);
  };

  // ── Bulk add ──
  const submitBulkAdd = async () => {
    const lines = bulkAddText.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length || !bulkAddCampaigns.length) return;
    setBulkAdding(true);
    try {
      const r = await apiFetch('/negative-keywords/bulk', {
        method: 'POST',
        body: JSON.stringify({ keywords: lines.map(t => ({ keywordText: t, matchType: bulkAddType })),
          campaignIds: bulkAddCampaigns }),
      });
      showToast(`Added ${r.added}, skipped ${r.skipped} (duplicates)`);
      setShowBulkAdd(false);
      setBulkAddText(''); setBulkAddCampaigns([]);
      load();
    } catch (e) { showToast('Error: ' + e.message); }
    setBulkAdding(false);
  };

  // ── Copy selected to campaigns ──
  const submitCopyTo = async () => {
    if (!selected.size || !copyTargets.length) return;
    setBulkAdding(true);
    const selectedNeg = negatives.filter(n => selected.has(n.id));
    const keywords = selectedNeg.map(n => ({ keywordText: n.keyword_text, matchType: n.match_type }));
    try {
      const r = await apiFetch('/negative-keywords/bulk', {
        method: 'POST', body: JSON.stringify({ keywords, campaignIds: copyTargets }),
      });
      showToast(`Copied: added ${r.added}, skipped ${r.skipped}`);
      setShowCopyTo(false); setCopyTargets([]); setSelected(new Set());
    } catch (e) { showToast('Error: ' + e.message); }
    setBulkAdding(false);
  };

  // ── Export CSV ──
  const exportCsv = () => {
    const url = `/api/v1/negative-keywords/export.csv`;
    const a = document.createElement('a');
    a.href = url; a.download = 'negative-keywords.csv';
    // Include auth header via fetch + blob
    apiFetch('/negative-keywords/export.csv', {}, true)
      .then(blob => { const u = URL.createObjectURL(blob); a.href = u; a.click(); URL.revokeObjectURL(u); })
      .catch(() => showToast('Export failed'));
  };

  const isExact = (mt) => mt === 'negativeExact' || mt === 'negative_exact';
  const matchLabel = (mt) => isExact(mt) ? 'Exact' : 'Phrase';
  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div>
      {/* Toast */}
      {toast && createPortal(
        <div style={{ position: 'fixed', top: 20, right: 20, zIndex: 9999, background: 'var(--grn)', color: '#fff',
          padding: '10px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600, boxShadow: '0 4px 20px rgba(0,0,0,.3)' }}>
          {toast}
        </div>, document.body
      )}

      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <input placeholder="Search…" value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          style={{ width: 180, padding: '5px 10px', fontSize: 12,
            background: 'var(--s2)', border: '1px solid var(--b2)', borderRadius: 6, color: 'var(--tx)' }} />

        {/* Match type filter */}
        {[{ v: '', l: 'All types' }, { v: 'negativeExact', l: 'Exact' }, { v: 'negativePhrase', l: 'Phrase' }].map(f => (
          <button key={f.v} onClick={() => { setFilterMatchType(f.v); setPage(1); }}
            className={`btn ${filterMatchType === f.v ? 'btn-primary' : 'btn-ghost'}`}
            style={{ fontSize: 11, padding: '4px 10px' }}>{f.l}</button>
        ))}
        <div style={{ width: 1, height: 20, background: 'var(--b2)' }} />
        {/* Level filter */}
        {[{ v: '', l: 'All levels' }, { v: 'campaign', l: 'Campaign' }, { v: 'ad_group', l: 'Ad Group' }].map(f => (
          <button key={f.v} onClick={() => { setFilterLevel(f.v); setPage(1); }}
            className={`btn ${filterLevel === f.v ? 'btn-primary' : 'btn-ghost'}`}
            style={{ fontSize: 11, padding: '4px 10px' }}>{f.l}</button>
        ))}
        <div style={{ width: 1, height: 20, background: 'var(--b2)' }} />
        {/* Campaign type filter */}
        {[{ v: '', l: 'All' }, { v: 'SP', l: 'SP' }, { v: 'SB', l: 'SB' }, { v: 'SD', l: 'SD' }].map(f => (
          <button key={f.v} onClick={() => { setFilterCampaignType(f.v); setPage(1); }}
            className={`btn ${filterCampaignType === f.v ? 'btn-primary' : 'btn-ghost'}`}
            style={{ fontSize: 11, padding: '4px 8px' }}>{f.l}</button>
        ))}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ color: 'var(--tx3)', fontSize: 12 }}>{total.toLocaleString()} negatives</span>
          <button onClick={exportCsv} className="btn btn-ghost" title="Export CSV"
            style={{ fontSize: 11, padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 4 }}>
            <Download size={12} strokeWidth={1.75} /> CSV
          </button>
          <button onClick={() => setShowBulkAdd(true)} className="btn btn-ghost"
            style={{ fontSize: 11, padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 4 }}>
            <Plus size={12} strokeWidth={1.75} /> Bulk add
          </button>
          <button onClick={() => setShowAddModal(true)} className="btn btn-primary"
            style={{ fontSize: 12, padding: '5px 12px', display: 'flex', alignItems: 'center', gap: 5 }}>
            <Plus size={12} strokeWidth={1.75} /> Add negative
          </button>
        </div>
      </div>

      {/* Bulk action panel */}
      {selected.size > 0 && (
        <div className="card fade" style={{ padding: '10px 16px', marginBottom: 12, display: 'flex', gap: 10,
          alignItems: 'center', flexWrap: 'wrap', borderColor: 'rgba(59,130,246,.4)', background: 'rgba(59,130,246,.05)' }}>
          <span style={{ fontSize: 13, color: 'var(--ac2)', fontWeight: 500 }}>{selected.size} selected</span>
          <button className="btn btn-ghost" onClick={() => { setShowCopyTo(true); setCopyTargets([]); }}
            style={{ fontSize: 12, padding: '5px 12px', display: 'flex', alignItems: 'center', gap: 5 }}>
            <Copy size={11} strokeWidth={1.75} /> Copy to…
          </button>
          <button className="btn btn-ghost" onClick={bulkDelete}
            style={{ fontSize: 12, padding: '5px 12px', color: 'var(--red)', display: 'flex', alignItems: 'center', gap: 5 }}>
            <Trash2 size={11} strokeWidth={1.75} /> Delete selected
          </button>
          <button className="btn btn-ghost" onClick={() => setSelected(new Set())} style={{ fontSize: 12, padding: '5px 10px' }}>Cancel</button>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div style={{ padding: 40, textAlign: 'center' }}><span className="loader" /></div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--s2)' }}>
                  <th style={{ width: 36, padding: '8px 12px', borderBottom: '2px solid var(--b1)' }}>
                    <input type="checkbox"
                      checked={negatives.length > 0 && selected.size === negatives.length}
                      onChange={toggleAll} />
                  </th>
                  {[
                    { col: 'keyword_text', label: 'Keyword' },
                    { col: 'match_type',   label: 'Type' },
                    { col: 'level',        label: 'Level' },
                    { col: 'campaign',     label: 'Campaign / Ad Group' },
                    { col: 'created_at',   label: 'Added' },
                  ].map(h => (
                    <th key={h.col} onClick={() => handleSort(h.col)}
                      style={{ padding: '8px 12px', textAlign: 'left', cursor: 'pointer',
                        color: 'var(--tx3)', fontWeight: 500, fontSize: 11, borderBottom: '2px solid var(--b1)',
                        whiteSpace: 'nowrap' }}>
                      {h.label}<SortIcon col={h.col} />
                    </th>
                  ))}
                  <th style={{ width: 80, padding: '8px 12px', borderBottom: '2px solid var(--b1)' }} />
                </tr>
              </thead>
              <tbody>
                {negatives.length === 0 ? (
                  <tr><td colSpan={7} style={{ padding: 40, textAlign: 'center', color: 'var(--tx2)' }}>
                    No negative keywords
                  </td></tr>
                ) : negatives.map(n => (
                  <tr key={n.id} style={{
                    borderBottom: '1px solid var(--b1)',
                    background: selected.has(n.id) ? 'rgba(59,130,246,0.06)' : 'transparent',
                  }}>
                    <td style={{ padding: '8px 12px' }}>
                      <input type="checkbox" checked={selected.has(n.id)} onChange={() => toggleSelect(n.id)} />
                    </td>
                    {/* Keyword text — inline edit */}
                    <td style={{ padding: '8px 12px', fontWeight: 500, minWidth: 180 }}>
                      {editId === n.id ? (
                        <input autoFocus value={editText} onChange={e => setEditText(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') cancelEdit(); }}
                          style={{ width: '100%', padding: '4px 8px', fontSize: 13,
                            background: 'var(--s2)', border: '1px solid var(--ac)', borderRadius: 4, color: 'var(--tx)' }} />
                      ) : (
                        <span style={{ cursor: 'text' }} onDoubleClick={() => startEdit(n)}
                          title="Double-click to edit">{n.keyword_text}</span>
                      )}
                    </td>
                    {/* Match type — click to toggle */}
                    <td style={{ padding: '8px 12px' }}>
                      {editId === n.id ? (
                        <select value={editType} onChange={e => setEditType(e.target.value)}
                          style={{ padding: '3px 6px', fontSize: 11, background: 'var(--s2)',
                            border: '1px solid var(--b2)', borderRadius: 4, color: 'var(--tx)' }}>
                          <option value="negativeExact">Exact</option>
                          <option value="negativePhrase">Phrase</option>
                        </select>
                      ) : (
                        <button onClick={() => toggleMatchType(n)} title="Click to toggle Exact/Phrase"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                          <span className={`badge ${isExact(n.match_type) ? 'bg-red' : 'bg-amb'}`}
                            style={{ fontSize: 10 }}>
                            {matchLabel(n.match_type)}
                          </span>
                        </button>
                      )}
                    </td>
                    <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--tx3)' }}>
                      {n.level || 'ad_group'}
                    </td>
                    <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--tx2)', maxWidth: 260 }}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {n.campaign_name || '—'}
                      </div>
                      {n.ad_group_name && (
                        <div style={{ fontSize: 11, color: 'var(--tx3)', marginTop: 1 }}>
                          {n.ad_group_name}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '8px 12px', fontSize: 11, color: 'var(--tx3)', whiteSpace: 'nowrap' }}>
                      {n.created_at ? new Date(n.created_at).toLocaleDateString() : '—'}
                    </td>
                    {/* Actions */}
                    <td style={{ padding: '8px 12px' }}>
                      {editId === n.id ? (
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button onClick={saveEdit} disabled={editSaving}
                            style={{ background: 'var(--grn)', color: '#fff', border: 'none', cursor: 'pointer',
                              borderRadius: 4, padding: '3px 8px', fontSize: 11 }}>
                            {editSaving ? '…' : '✓'}
                          </button>
                          <button onClick={cancelEdit}
                            style={{ background: 'none', border: '1px solid var(--b2)', cursor: 'pointer',
                              borderRadius: 4, padding: '3px 8px', fontSize: 11, color: 'var(--tx3)' }}>✕</button>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                          <button onClick={() => startEdit(n)} title="Edit"
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--tx3)', padding: 4 }}>
                            <PenLine size={13} strokeWidth={1.75} />
                          </button>
                          <button onClick={() => remove(n.id)} title="Delete"
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--tx3)', padding: 4 }}>
                            <Trash2 size={13} strokeWidth={1.75} />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8,
              padding: '12px 16px', borderTop: '1px solid var(--b1)' }}>
              <button className="btn btn-ghost" onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1} style={{ fontSize: 12, padding: '4px 10px' }}>← Prev</button>
              <span style={{ fontSize: 12, color: 'var(--tx2)' }}>
                Page {page} of {totalPages} · {total.toLocaleString()} total
              </span>
              <button className="btn btn-ghost" onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages} style={{ fontSize: 12, padding: '4px 10px' }}>Next →</button>
            </div>
          )}
        </div>
      )}

      {/* ── Add single modal ── */}
      {showAddModal && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 9000,
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) setShowAddModal(false); }}>
          <div className="card" style={{ width: 460, padding: 28, borderRadius: 12 }}>
            <h3 style={{ fontFamily: 'var(--disp)', fontSize: 16, fontWeight: 700, marginBottom: 20 }}>Add Negative Keyword</h3>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: 'var(--tx3)', marginBottom: 5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Keyword *</div>
              <input value={newKw.keywordText} onChange={e => setNewKw(n => ({ ...n, keywordText: e.target.value }))}
                placeholder="Enter keyword…" autoFocus
                style={{ width: '100%', padding: '8px 10px', fontSize: 13, boxSizing: 'border-box',
                  background: 'var(--s2)', border: '1px solid var(--b2)', borderRadius: 6, color: 'var(--tx)' }} />
            </div>
            <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: 'var(--tx3)', marginBottom: 5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Match Type</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[['negativeExact', 'Exact'], ['negativePhrase', 'Phrase']].map(([v, l]) => (
                    <button key={v} onClick={() => setNewKw(n => ({ ...n, matchType: v }))}
                      className={`btn ${newKw.matchType === v ? 'btn-primary' : 'btn-ghost'}`}
                      style={{ fontSize: 12, padding: '5px 14px' }}>{l}</button>
                  ))}
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: 'var(--tx3)', marginBottom: 5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Level</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[['', 'Campaign'], [newKw.adGroupId || '__ag__', 'Ad Group']].map(([v, l]) => (
                    <button key={l} onClick={() => setNewKw(n => ({ ...n, adGroupId: v === '__ag__' ? '' : v }))}
                      className={`btn ${(l === 'Campaign' ? !newKw.adGroupId : !!newKw.adGroupId) ? 'btn-primary' : 'btn-ghost'}`}
                      style={{ fontSize: 12, padding: '5px 14px' }}>{l}</button>
                  ))}
                </div>
              </div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: 'var(--tx3)', marginBottom: 5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Campaign *</div>
              <select value={newKw.campaignId} onChange={e => setNewKw(n => ({ ...n, campaignId: e.target.value, adGroupId: '' }))}
                style={{ width: '100%', padding: '7px 10px', fontSize: 12, boxSizing: 'border-box',
                  background: 'var(--s2)', border: '1px solid var(--b2)', borderRadius: 6, color: 'var(--tx)' }}>
                <option value="">Select campaign…</option>
                {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            {newKw.campaignId && newKwAdGroups.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, color: 'var(--tx3)', marginBottom: 5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Ad Group (optional)</div>
                <select value={newKw.adGroupId} onChange={e => setNewKw(n => ({ ...n, adGroupId: e.target.value }))}
                  style={{ width: '100%', padding: '7px 10px', fontSize: 12, boxSizing: 'border-box',
                    background: 'var(--s2)', border: '1px solid var(--b2)', borderRadius: 6, color: 'var(--tx)' }}>
                  <option value="">Campaign level</option>
                  {newKwAdGroups.map(ag => <option key={ag.id} value={ag.id}>{ag.name}</option>)}
                </select>
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setShowAddModal(false)} style={{ fontSize: 13 }}>Cancel</button>
              <button className="btn btn-primary" onClick={addSingle} disabled={addSaving || !newKw.campaignId || !newKw.keywordText.trim()}
                style={{ fontSize: 13, minWidth: 100 }}>{addSaving ? 'Saving…' : 'Add Negative'}</button>
            </div>
          </div>
        </div>, document.body
      )}

      {/* ── Bulk add modal ── */}
      {showBulkAdd && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 9000,
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) setShowBulkAdd(false); }}>
          <div className="card" style={{ width: 540, padding: 28, borderRadius: 12 }}>
            <h3 style={{ fontFamily: 'var(--disp)', fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Bulk Add Negatives</h3>
            <p style={{ fontSize: 12, color: 'var(--tx2)', marginBottom: 16 }}>One keyword per line. Will be added to all selected campaigns.</p>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: 'var(--tx3)', marginBottom: 5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Keywords (one per line)</div>
              <textarea value={bulkAddText} onChange={e => setBulkAddText(e.target.value)}
                rows={7} placeholder={"bad keyword 1\nbad keyword 2\nbad keyword 3"}
                style={{ width: '100%', padding: '8px 10px', fontSize: 12, boxSizing: 'border-box', resize: 'vertical',
                  background: 'var(--s2)', border: '1px solid var(--b2)', borderRadius: 6, color: 'var(--tx)', fontFamily: 'monospace' }} />
              <div style={{ fontSize: 11, color: 'var(--tx3)', marginTop: 4 }}>
                {bulkAddText.split('\n').filter(l => l.trim()).length} keywords
              </div>
            </div>
            <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--tx3)', marginBottom: 5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Match Type</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[['negativeExact', 'Exact'], ['negativePhrase', 'Phrase']].map(([v, l]) => (
                    <button key={v} onClick={() => setBulkAddType(v)}
                      className={`btn ${bulkAddType === v ? 'btn-primary' : 'btn-ghost'}`}
                      style={{ fontSize: 12, padding: '5px 14px' }}>{l}</button>
                  ))}
                </div>
              </div>
            </div>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, color: 'var(--tx3)', marginBottom: 5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Target Campaigns</div>
              <input placeholder="Search campaigns…" value={bulkAddCampSearch}
                onChange={e => setBulkAddCampSearch(e.target.value)}
                style={{ width: '100%', padding: '6px 10px', fontSize: 12, boxSizing: 'border-box', marginBottom: 6,
                  background: 'var(--s2)', border: '1px solid var(--b2)', borderRadius: 6, color: 'var(--tx)' }} />
              <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid var(--b2)', borderRadius: 6 }}>
                {campaigns.filter(c => !bulkAddCampSearch || c.name.toLowerCase().includes(bulkAddCampSearch.toLowerCase()))
                  .map(c => (
                  <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer',
                    background: bulkAddCampaigns.includes(c.id) ? 'rgba(59,130,246,0.08)' : 'transparent' }}>
                    <input type="checkbox" checked={bulkAddCampaigns.includes(c.id)}
                      onChange={() => setBulkAddCampaigns(ids => ids.includes(c.id) ? ids.filter(x => x !== c.id) : [...ids, c.id])}
                      style={{ accentColor: 'var(--ac)' }} />
                    <span style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                    <span style={{ fontSize: 10, color: 'var(--tx3)' }}>
                      {c.campaign_type === 'sponsoredProducts' ? 'SP' : c.campaign_type === 'sponsoredBrands' ? 'SB' : 'SD'}
                    </span>
                  </label>
                ))}
              </div>
              <div style={{ fontSize: 11, color: 'var(--tx3)', marginTop: 4 }}>
                {bulkAddCampaigns.length} campaigns selected
                {bulkAddCampaigns.length > 0 && (
                  <button onClick={() => setBulkAddCampaigns([])}
                    style={{ marginLeft: 8, background: 'none', border: 'none', color: 'var(--ac)', cursor: 'pointer', fontSize: 11 }}>
                    Clear
                  </button>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setShowBulkAdd(false)} style={{ fontSize: 13 }}>Cancel</button>
              <button className="btn btn-primary" onClick={submitBulkAdd}
                disabled={bulkAdding || !bulkAddText.trim() || !bulkAddCampaigns.length}
                style={{ fontSize: 13, minWidth: 120 }}>
                {bulkAdding ? 'Adding…' : `Add to ${bulkAddCampaigns.length} campaign(s)`}
              </button>
            </div>
          </div>
        </div>, document.body
      )}

      {/* ── Copy to campaigns modal ── */}
      {showCopyTo && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 9000,
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) setShowCopyTo(false); }}>
          <div className="card" style={{ width: 440, padding: 28, borderRadius: 12 }}>
            <h3 style={{ fontFamily: 'var(--disp)', fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Copy to Campaigns</h3>
            <p style={{ fontSize: 12, color: 'var(--tx2)', marginBottom: 16 }}>
              Copy <strong style={{ color: 'var(--tx)' }}>{selected.size} negative(s)</strong> to selected campaigns.
              Duplicates are skipped.
            </p>
            <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--b2)', borderRadius: 6, marginBottom: 20 }}>
              {campaigns.map(c => (
                <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', cursor: 'pointer',
                  background: copyTargets.includes(c.id) ? 'rgba(59,130,246,0.08)' : 'transparent' }}>
                  <input type="checkbox" checked={copyTargets.includes(c.id)}
                    onChange={() => setCopyTargets(ids => ids.includes(c.id) ? ids.filter(x => x !== c.id) : [...ids, c.id])}
                    style={{ accentColor: 'var(--ac)' }} />
                  <span style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                  <span style={{ fontSize: 10, color: 'var(--tx3)' }}>
                    {c.campaign_type === 'sponsoredProducts' ? 'SP' : c.campaign_type === 'sponsoredBrands' ? 'SB' : 'SD'}
                  </span>
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setShowCopyTo(false)} style={{ fontSize: 13 }}>Cancel</button>
              <button className="btn btn-primary" onClick={submitCopyTo}
                disabled={bulkAdding || !copyTargets.length}
                style={{ fontSize: 13, minWidth: 120 }}>
                {bulkAdding ? 'Copying…' : `Copy to ${copyTargets.length} campaign(s)`}
              </button>
            </div>
          </div>
        </div>, document.body
      )}
    </div>
  );
}

// ─── RuleHistoryModal ─────────────────────────────────────────────────────────
function RuleHistoryModal({ rule, onClose }) {
  const [runs, setRuns]     = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch(`/rules/${rule.id}/runs`)
      .then(d => { setRuns(d.data || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [rule.id]);

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
                  zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
         onClick={onClose}>
      <div className="card" style={{ width: 640, maxHeight: '80vh', overflow: 'auto',
                                     padding: 28, margin: 16 }}
           onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontFamily: 'var(--disp)', fontSize: 16 }}>
            History: {rule.name}
          </h3>
          <button onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--tx2)' }}>
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>
        {loading && <div style={{ textAlign: 'center', padding: 32 }}><span className="loader" /></div>}
        {!loading && runs.length === 0 && (
          <div style={{ textAlign: 'center', padding: 32, color: 'var(--tx2)', fontSize: 13 }}>
            No runs yet
          </div>
        )}
        {runs.map(run => (
          <div key={run.id} style={{
            border: '1px solid var(--b1)', borderRadius: 8, padding: 14, marginBottom: 10,
            background: run.error_message ? 'rgba(239,68,68,0.05)' : 'var(--s2)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, flexWrap: 'wrap', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--tx2)' }}>
                {new Date(run.started_at).toLocaleString()}
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <span className={`badge ${run.dry_run ? 'bg-amb' : 'bg-grn'}`} style={{ fontSize: 10 }}>
                  {run.dry_run ? 'Simulation' : 'Live'}
                </span>
                <span className="badge" style={{ fontSize: 10, background: 'var(--s3)', color: 'var(--tx2)' }}>
                  {run.status || 'completed'}
                </span>
                <span className="badge bg-bl" style={{ fontSize: 10 }}>
                  {run.entities_matched || 0} matched · {run.actions_taken || 0} actions
                </span>
              </div>
            </div>
            {run.error_message && (
              <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4 }}>{run.error_message}</div>
            )}
            {run.summary && Array.isArray(run.summary) && run.summary.length > 0 && (
              <div style={{ marginTop: 8 }}>
                {run.summary.slice(0, 3).map((a, i) => (
                  <div key={i} style={{ fontSize: 11, color: 'var(--tx3)', marginTop: 2 }}>
                    • {a.entity_name || a.keyword_text}: {a.action}
                    {a.old_bid && ` $${a.old_bid} → $${a.new_bid}`}
                  </div>
                ))}
                {run.summary.length > 3 && (
                  <div style={{ fontSize: 11, color: 'var(--tx3)', marginTop: 2 }}>
                    …and {run.summary.length - 3} more
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>,
    document.body
  );
}

// ─── Keywords Page ────────────────────────────────────────────────────────────
const KEYWORD_DEFAULT_FILTERS = {
  search: "", state: "", matchType: "", campaignType: "",
  bidMin: "", bidMax: "",
  spendMin: "", spendMax: "",
  acosMin: "", acosMax: "",
  clicksMin: "", ordersMin: "",
  noSales: false, hasClicks: false,
  metricsDays: 30,
};

const KeywordsPage = ({ workspaceId }) => {
  const { t } = useI18n();
  const {
    filters: kwFilters, updateFilter: setKwFilter,
    resetFilters: resetKwFilters,
    presets: kwPresets, savePreset: saveKwPreset,
    loadPreset: loadKwPreset, deletePreset: deleteKwPreset,
    activeCount: kwActiveCount,
  } = useSavedFilters("af:keywords", KEYWORD_DEFAULT_FILTERS);
  const [showKwFilters, setShowKwFilters] = useState(false);
  const [sortBy, setSortBy] = useState("keyword_text");
  const [sortDir, setSortDir] = useState("asc");
  const [selected, setSelected] = useState(new Set());
  const [editId, setEditId] = useState(null);
  const [editBid, setEditBid] = useState("");
  const [saving, setSaving] = useState(false);
  const [bulkPct, setBulkPct] = useState("");
  const [kwToast, setKwToast] = useState(null);
  const [hoveredKwId, setHoveredKwId] = useState(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [kwTab, setKwTab] = useState('keywords'); // 'keywords' | 'searchterms' | 'negatives'

  // Keywords date range + campaign filter
  const [kwDateFrom, setKwDateFrom]     = useState(null);
  const [kwDateTo, setKwDateTo]         = useState(null);
  const [kwMetricsDays, setKwMetricsDays] = useState(30);
  const [kwCampaignIds, setKwCampaignIds] = useState([]);

  // Search Terms state
  const [searchTerms, setSearchTerms] = useState([]);
  const [stLoading, setStLoading] = useState(false);
  const [stTotal, setStTotal] = useState(0);
  const [stSearch, setStSearch] = useState('');
  const [stSortCol, setStSortCol] = useState('spend');
  const [stSortDir, setStSortDir] = useState('desc');
  const [stFilter, setStFilter] = useState('all'); // 'all' | 'harvest' | 'negate'
  const [stDateFrom, setStDateFrom]     = useState(null);
  const [stDateTo, setStDateTo]         = useState(null);
  const [stMetricsDays, setStMetricsDays] = useState(30);
  const [stCampaignIds, setStCampaignIds] = useState([]);
  const [stCampaignType, setStCampaignType] = useState('');   // '' | 'SP' | 'SB' | 'SD'
  const [stSyncing, setStSyncing] = useState(false);
  const [stSelected, setStSelected] = useState(new Set());
  // Harvest modal state
  const [stHarvestModal, setStHarvestModal] = useState(null); // { terms: [], mode: 'keyword'|'negative' }
  const [stHarvestLevel, setStHarvestLevel] = useState('campaign'); // 'account'|'campaign'|'adgroup'
  const [stHarvestCampaigns, setStHarvestCampaigns] = useState([]);
  const [stHarvestSelCampaign, setStHarvestSelCampaign] = useState('');
  const [stHarvestSelAdGroup, setStHarvestSelAdGroup] = useState('');
  const [stHarvestMatchType, setStHarvestMatchType] = useState('exact');
  const [stHarvestBid, setStHarvestBid] = useState('0.50');
  const [stHarvestCampaignSearch, setStHarvestCampaignSearch] = useState('');
  const [stHarvestSaving, setStHarvestSaving] = useState(false);

  const { colgroup: kwColgroup, resizeHandle: kwRH, resetCols: kwResetCols } = useResizableColumns(
    "keywords", [36, 220, 90, 100, 90, 170, 65, 65, 75, 80, 90]
  );
  const { isVisible: kwCV, ColVisDropdown: KwColsBtn } = useColumnVisibility("keywords", [
    { key: "match",    label: t("keywords.colMatch") },
    { key: "status",   label: t("keywords.colStatus") },
    { key: "bid",      label: t("keywords.colBid") },
    { key: "campaign", label: t("keywords.colCampaign") },
    { key: "clicks",   label: t("keywords.colClicks") },
    { key: "orders",   label: t("keywords.colOrders") },
    { key: "acos",     label: "ACOS" },
    { key: "spend",    label: t("keywords.colSpend") },
  ]);

  // S1-7: connections for last-sync timestamp
  const [connections, setConnections] = useState([]);
  useEffect(() => {
    if (workspaceId) {
      get("/connections").then(data => {
        if (Array.isArray(data)) setConnections(data);
      }).catch(() => {});
    }
  }, [workspaceId]);
  const lastSync = connections.length
    ? connections.reduce((latest, c) =>
        !latest || new Date(c.last_refresh_at) > new Date(latest)
          ? c.last_refresh_at : latest
      , null)
    : null;

  // S3-6: keyboard shortcuts (wrap reload in closure — declared later via useAsync)
  useKeyboardShortcuts([
    { key: "/", handler: () => document.querySelector("[data-search-input]")?.focus() },
    { key: "r", handler: () => reload() },
    { key: "R", handler: () => reload() },
  ]);

  function handleKwSort(field) {
    const isText = ["keyword_text", "match_type", "state", "campaign"].includes(field);
    if (sortBy === field) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortBy(field); setSortDir(isText ? "asc" : "desc"); }
  }

  // Search terms fetch
  useEffect(() => {
    if (kwTab !== 'searchterms') return;
    setStLoading(true);
    const params = new URLSearchParams({ limit: 200, sortBy: stSortCol, sortDir: stSortDir });
    if (stSearch) params.set('search', stSearch);
    if (stFilter === 'harvest') params.set('hasOrders', 'true');
    if (stFilter === 'negate') params.set('noOrders', 'true');
    if (stDateFrom && stDateTo) {
      params.set('dateFrom', stDateFrom);
      params.set('dateTo', stDateTo);
    } else {
      params.set('metricsDays', stMetricsDays);
    }
    stCampaignIds.forEach(id => params.append('campaignIds[]', id));
    if (stCampaignType) params.set('campaignType', stCampaignType);
    apiFetch(`/search-terms?${params}`)
      .then(d => { setSearchTerms(d?.data || []); setStTotal(d?.pagination?.total || 0); setStSelected(new Set()); })
      .catch(() => setSearchTerms([]))
      .finally(() => setStLoading(false));
  }, [kwTab, stSortCol, stSortDir, stSearch, stFilter, stDateFrom, stDateTo, stMetricsDays, stCampaignIds, stCampaignType]);

  const stRecommendation = (term) => {
    const acos = parseFloat(term.sales) > 0 ? (parseFloat(term.spend) / parseFloat(term.sales)) * 100 : null;
    const clicks = parseInt(term.clicks || 0);
    const orders = parseInt(term.orders || 0);
    if (orders >= 2 && acos !== null && acos < 30) return 'harvest';
    if (clicks >= 10 && orders === 0) return 'negate';
    if (orders >= 1 && acos !== null && acos < 40) return 'harvest';
    return 'neutral';
  };

  const openHarvestModal = async (termsOrTerm, mode) => {
    const terms = Array.isArray(termsOrTerm) ? termsOrTerm : [termsOrTerm];
    setStHarvestModal({ terms, mode });
    setStHarvestLevel('campaign');
    setStHarvestMatchType('exact');
    setStHarvestBid('0.50');
    setStHarvestCampaignSearch('');
    // Pre-fill campaign if all selected terms share the same campaign
    const sharedCampaign = terms.every(t => t.campaign_id && t.campaign_id === terms[0].campaign_id)
      ? terms[0].campaign_id : '';
    setStHarvestSelCampaign(sharedCampaign);
    setStHarvestSelAdGroup(sharedCampaign && terms.length === 1 ? (terms[0].ad_group_id || '') : '');
    setStHarvestSaving(false);
    try {
      const camps = await apiFetch('/search-terms/campaigns');
      setStHarvestCampaigns(Array.isArray(camps) ? camps : []);
    } catch { setStHarvestCampaigns([]); }
  };

  const submitHarvest = async () => {
    if (!stHarvestModal) return;
    const { terms, mode } = stHarvestModal;
    setStHarvestSaving(true);
    try {
      const endpoint = mode === 'keyword' ? '/search-terms/add-keyword' : '/search-terms/add-negative';
      let totalAdded = 0, totalSkipped = 0;

      for (const term of terms) {
        const body = { query: term.query, matchType: stHarvestMatchType };
        if (mode === 'keyword') body.bid = parseFloat(stHarvestBid) || 0.50;

        if (stHarvestLevel === 'account') {
          body.campaignIds = stHarvestCampaigns.map(c => c.id);
        } else if (stHarvestLevel === 'adgroup') {
          body.campaignId = stHarvestSelCampaign;
          body.adGroupId = stHarvestSelAdGroup;
        } else {
          body.campaignId = stHarvestSelCampaign;
        }

        const r = await post(endpoint, body);
        totalAdded += r.added ?? (r.success ? 1 : 0);
        totalSkipped += r.skipped ?? 0;
      }

      const what = mode === 'keyword' ? 'keyword(s)' : 'negative(s)';
      const msg = `Added ${totalAdded} ${what}${totalSkipped ? `, ${totalSkipped} skipped (duplicate)` : ''}`;
      setKwToast(msg);
      setTimeout(() => setKwToast(null), 4000);
      setStHarvestModal(null);
      setStSelected(new Set());
    } catch (e) {
      setKwToast('Error: ' + (e?.message || 'unknown'));
      setTimeout(() => setKwToast(null), 3000);
    }
    setStHarvestSaving(false);
  };

  const syncSearchTerms = async () => {
    setStSyncing(true);
    try {
      await post('/search-terms/sync', {});
      setKwToast('Search term sync queued — data will appear in a few minutes');
      setTimeout(() => setKwToast(null), 5000);
    } catch (e) {
      setKwToast('Sync failed: ' + (e?.message || 'unknown error'));
      setTimeout(() => setKwToast(null), 4000);
    }
    setStSyncing(false);
  };

  useEffect(() => { setPage(1); }, [kwFilters, sortBy, sortDir]);

  useEffect(() => {
    document.querySelector(".fade")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [page]);

  const { data: kwResponse, loading, reload, mutate: mutateKw } = useAsync(
    () => {
      if (!workspaceId) return Promise.resolve({ data: [], pagination: { total: 0, page: 1, limit: 100, pages: 0 } });
      const p = new URLSearchParams();
      p.set('page', page);
      p.set('limit', pageSize);
      p.set('sortBy', sortBy);
      p.set('sortDir', sortDir);
      if (kwFilters.search)       p.set('search', kwFilters.search);
      if (kwFilters.state)        p.set('state', kwFilters.state);
      if (kwFilters.matchType)    p.set('matchType', kwFilters.matchType);
      if (kwFilters.campaignType) p.set('campaignType', kwFilters.campaignType);
      if (kwFilters.bidMin)       p.set('bidMin', kwFilters.bidMin);
      if (kwFilters.bidMax)       p.set('bidMax', kwFilters.bidMax);
      if (kwFilters.spendMin)     p.set('spendMin', kwFilters.spendMin);
      if (kwFilters.spendMax)     p.set('spendMax', kwFilters.spendMax);
      if (kwFilters.acosMin)      p.set('acosMin', kwFilters.acosMin);
      if (kwFilters.acosMax)      p.set('acosMax', kwFilters.acosMax);
      if (kwFilters.clicksMin)    p.set('clicksMin', kwFilters.clicksMin);
      if (kwFilters.ordersMin)    p.set('ordersMin', kwFilters.ordersMin);
      if (kwFilters.noSales)      p.set('noSales', 'true');
      if (kwFilters.hasClicks)    p.set('hasClicks', 'true');
      if (kwDateFrom && kwDateTo) {
        p.set('dateFrom', kwDateFrom);
        p.set('dateTo', kwDateTo);
      } else if (kwFilters.metricsDays !== 30) {
        p.set('metricsDays', kwFilters.metricsDays);
      }
      kwCampaignIds.forEach(id => p.append('campaignIds[]', id));
      return apiFetch('/keywords?' + p.toString());
    },
    [workspaceId, page, pageSize, sortBy, sortDir, kwFilters, kwDateFrom, kwDateTo, kwMetricsDays, kwCampaignIds]
  );

  const keywords = kwResponse?.data ?? [];
  const kwTotal = kwResponse?.pagination?.total ?? 0;
  const totalPages = kwResponse?.pagination?.pages ?? 1;

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
    const bid = Math.max(0.02, parseFloat(editBid));
    setSaving(true);
    try {
      await patch(`/keywords/${id}`, { bid });
      mutateKw(prev => prev ? { ...prev, data: prev.data.map(k => k.id === id ? { ...k, bid: bid.toFixed(4) } : k) } : prev);
      setEditId(null);
    } catch (e) { alert(t("common.error") + e.message); }
    setSaving(false);
  }

  async function toggleState(id, currentState, keywordText) {
    if (currentState === "archived") return;
    const newState = currentState === "enabled" ? "paused" : "enabled";
    const label = newState === "paused" ? t("keywords.confirmPause") : t("keywords.confirmEnable");
    if (!window.confirm(`${label}: "${keywordText}"?`)) return;
    mutateKw(prev => prev ? { ...prev, data: prev.data.map(k => k.id === id ? { ...k, state: newState } : k) } : prev);
    try {
      await patch(`/keywords/${id}`, { state: newState });
    } catch (e) {
      mutateKw(prev => prev ? { ...prev, data: prev.data.map(k => k.id === id ? { ...k, state: currentState } : k) } : prev);
      alert(t("common.error") + e.message);
    }
  }

  async function bulkStateUpdate(newState) {
    if (!selected.size) return;
    const ids = Array.from(selected).filter(id => {
      const kw = keywords.find(k => k.id === id);
      return kw && kw.state !== "archived" && kw.state !== newState;
    });
    if (!ids.length) return;
    const label = newState === "paused" ? t("keywords.confirmPause") : t("keywords.confirmEnable");
    if (!window.confirm(`${label} ${ids.length} keywords?`)) return;
    setSaving(true);
    try {
      const updates = ids.map(id => ({ id, state: newState }));
      await patch("/keywords/bulk", { updates });
      mutateKw(prev => prev ? { ...prev, data: prev.data.map(k => ids.includes(k.id) ? { ...k, state: newState } : k) } : prev);
      setSelected(new Set());
      setKwToast(t("keywords.updateBids", { count: ids.length }));
      setTimeout(() => setKwToast(null), 3000);
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
      setKwToast(t("keywords.updateBids", { count: updates.length }));
      setTimeout(() => setKwToast(null), 3000);
    } catch (e) { alert(t("common.error") + e.message); }
    setSaving(false);
  }

  const matchCls = mt => ({ exact: "bg-grn", phrase: "bg-bl", broad: "bg-amb" })[mt] || "bg-bl";

  return (
    <div className="fade">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div>
          <h1 style={{ fontFamily: "var(--disp)", fontSize: 22, fontWeight: 700, marginBottom: 4 }}>{t("keywords.title")}</h1>
          <div style={{ fontSize: 13, color: "var(--tx2)" }}>{t("keywords.count", { count: kwTotal.toLocaleString() })}</div>
        </div>
      </div>

      {/* Tab selector */}
      <div style={{ display: "flex", gap: 4, marginBottom: 16, borderBottom: "1px solid var(--b1)", paddingBottom: 0 }}>
        {[
          { id: 'keywords',    label: t("keywords.title") || "Keywords" },
          { id: 'searchterms', label: "Search Terms" },
          { id: 'negatives',   label: "Negatives" },
        ].map(tab => (
          <button key={tab.id} onClick={() => setKwTab(tab.id)}
            style={{
              padding: "8px 16px", fontSize: 13, fontWeight: kwTab === tab.id ? 600 : 400,
              background: "none", border: "none", cursor: "pointer",
              color: kwTab === tab.id ? "var(--ac)" : "var(--tx3)",
              borderBottom: `2px solid ${kwTab === tab.id ? "var(--ac)" : "transparent"}`,
              marginBottom: -1, transition: "color 150ms, border-color 150ms",
            }}>
            {tab.label}
          </button>
        ))}
      </div>

      {kwToast && createPortal(
        <div style={{ position: "fixed", top: 20, right: 20, zIndex: 9999, background: "var(--grn)", color: "#fff", padding: "10px 18px", borderRadius: 8, fontSize: 13, fontWeight: 600, boxShadow: "0 4px 20px rgba(0,0,0,.3)" }}>
          {kwToast}
        </div>,
        document.body
      )}

      {/* Harvest Modal */}
      {stHarvestModal && createPortal(
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 9000, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={e => { if (e.target === e.currentTarget) setStHarvestModal(null); }}>
          <div className="card" style={{ width: 480, maxWidth: "95vw", padding: 28, borderRadius: 12 }}>
            <h3 style={{ fontFamily: "var(--disp)", fontSize: 16, fontWeight: 700, marginBottom: 4 }}>
              {stHarvestModal.mode === 'keyword' ? '+ Add as Keyword' : '− Add as Negative'}
            </h3>
            <p style={{ fontSize: 12, color: "var(--tx2)", marginBottom: 20 }}>
              {stHarvestModal.terms.length === 1
                ? <>Query: <strong style={{ color: "var(--tx)" }}>"{stHarvestModal.terms[0].query}"</strong></>
                : <><strong style={{ color: "var(--tx)" }}>{stHarvestModal.terms.length} queries</strong> selected</>
              }
            </p>

            {/* Level selector */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: "var(--tx3)", marginBottom: 6, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Level</div>
              <div style={{ display: "flex", gap: 6 }}>
                {[
                  { id: 'account',  label: 'Account (all campaigns)' },
                  { id: 'campaign', label: 'Campaign' },
                  { id: 'adgroup',  label: 'Ad Group' },
                ].map(lv => (
                  <button key={lv.id} onClick={() => { setStHarvestLevel(lv.id); setStHarvestSelCampaign(''); setStHarvestSelAdGroup(''); }}
                    className={`btn ${stHarvestLevel === lv.id ? 'btn-primary' : 'btn-ghost'}`}
                    style={{ fontSize: 11, padding: "5px 12px" }}>
                    {lv.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Campaign picker — shown for campaign and adgroup levels */}
            {(stHarvestLevel === 'campaign' || stHarvestLevel === 'adgroup') && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, color: "var(--tx3)", marginBottom: 6, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Campaign</div>
                <input
                  placeholder="Search campaigns…"
                  value={stHarvestCampaignSearch}
                  onChange={e => setStHarvestCampaignSearch(e.target.value)}
                  style={{ width: "100%", padding: "7px 10px", fontSize: 12, marginBottom: 6,
                    background: "var(--s2)", border: "1px solid var(--b2)", borderRadius: 6, color: "var(--tx)" }}
                />
                <div style={{ maxHeight: 160, overflowY: "auto", border: "1px solid var(--b2)", borderRadius: 6, background: "var(--s2)" }}>
                  {stHarvestCampaigns
                    .filter(c => !stHarvestCampaignSearch || c.name.toLowerCase().includes(stHarvestCampaignSearch.toLowerCase()))
                    .map(c => (
                      <div key={c.id} onClick={() => { setStHarvestSelCampaign(c.id); setStHarvestSelAdGroup(''); }}
                        style={{ padding: "7px 12px", cursor: "pointer", fontSize: 12,
                          background: stHarvestSelCampaign === c.id ? "var(--ac)" : "transparent",
                          color: stHarvestSelCampaign === c.id ? "#fff" : "var(--tx)" }}>
                        <span style={{ fontSize: 10, opacity: 0.7, marginRight: 6 }}>
                          {c.campaign_type === 'sponsoredProducts' ? 'SP' : c.campaign_type === 'sponsoredBrands' ? 'SB' : 'SD'}
                        </span>
                        {c.name}
                      </div>
                    ))}
                  {stHarvestCampaigns.length === 0 && (
                    <div style={{ padding: "20px 12px", textAlign: "center", fontSize: 12, color: "var(--tx3)" }}>Loading…</div>
                  )}
                </div>
              </div>
            )}

            {/* Ad Group picker */}
            {stHarvestLevel === 'adgroup' && stHarvestSelCampaign && (() => {
              const camp = stHarvestCampaigns.find(c => c.id === stHarvestSelCampaign);
              const adGroups = camp?.ad_groups || [];
              return (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, color: "var(--tx3)", marginBottom: 6, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Ad Group</div>
                  <div style={{ maxHeight: 120, overflowY: "auto", border: "1px solid var(--b2)", borderRadius: 6, background: "var(--s2)" }}>
                    {adGroups.map(ag => (
                      <div key={ag.id} onClick={() => setStHarvestSelAdGroup(ag.id)}
                        style={{ padding: "7px 12px", cursor: "pointer", fontSize: 12,
                          background: stHarvestSelAdGroup === ag.id ? "var(--ac)" : "transparent",
                          color: stHarvestSelAdGroup === ag.id ? "#fff" : "var(--tx)" }}>
                        {ag.name}
                      </div>
                    ))}
                    {adGroups.length === 0 && (
                      <div style={{ padding: "12px", fontSize: 12, color: "var(--tx3)" }}>No ad groups</div>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Account level info */}
            {stHarvestLevel === 'account' && (
              <div style={{ marginBottom: 14, padding: "10px 14px", background: "rgba(96,165,250,0.08)",
                border: "1px solid rgba(96,165,250,0.2)", borderRadius: 8, fontSize: 12, color: "var(--tx2)" }}>
                Will add to <strong style={{ color: "var(--tx)" }}>{stHarvestCampaigns.length} campaigns</strong>.
                Duplicates are skipped automatically.
              </div>
            )}

            {/* Match type + bid */}
            <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: "var(--tx3)", marginBottom: 6, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Match Type</div>
                <div style={{ display: "flex", gap: 4 }}>
                  {['exact', 'phrase', 'broad'].map(mt => (
                    <button key={mt} onClick={() => setStHarvestMatchType(mt)}
                      className={`btn ${stHarvestMatchType === mt ? 'btn-primary' : 'btn-ghost'}`}
                      style={{ fontSize: 11, padding: "4px 10px", textTransform: "capitalize" }}>
                      {mt}
                    </button>
                  ))}
                </div>
              </div>
              {stHarvestModal.mode === 'keyword' && (
                <div>
                  <div style={{ fontSize: 11, color: "var(--tx3)", marginBottom: 6, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Bid $</div>
                  <input type="number" step="0.01" min="0.02" value={stHarvestBid}
                    onChange={e => setStHarvestBid(e.target.value)}
                    style={{ width: 90, padding: "6px 10px", fontSize: 13,
                      background: "var(--s2)", border: "1px solid var(--b2)", borderRadius: 6, color: "var(--tx)" }} />
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button className="btn btn-ghost" onClick={() => setStHarvestModal(null)}
                style={{ fontSize: 13 }}>Cancel</button>
              <button className="btn btn-primary" onClick={submitHarvest} disabled={stHarvestSaving ||
                ((stHarvestLevel === 'campaign' || stHarvestLevel === 'adgroup') && !stHarvestSelCampaign) ||
                (stHarvestLevel === 'adgroup' && !stHarvestSelAdGroup)}
                style={{ fontSize: 13, minWidth: 100 }}>
                {stHarvestSaving ? "Saving…" : stHarvestModal.mode === 'keyword' ? 'Add Keyword' : 'Add Negative'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {kwTab === 'searchterms' && (
        <div>
          {/* Search Terms toolbar */}
          <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
            <input
              placeholder="Search queries…"
              value={stSearch}
              onChange={e => setStSearch(e.target.value)}
              style={{ flex: "1 1 160px", maxWidth: 200, padding: "6px 10px", fontSize: 12,
                background: "var(--s2)", border: "1px solid var(--b2)",
                borderRadius: 6, color: "var(--tx)" }}
            />
            {[
              { id: 'all',     label: 'All' },
              { id: 'harvest', label: '+ Harvest' },
              { id: 'negate',  label: '− Negate' },
            ].map(f => (
              <button key={f.id} onClick={() => setStFilter(f.id)}
                className={`btn ${stFilter === f.id ? "btn-primary" : "btn-ghost"}`}
                style={{ fontSize: 11, padding: "5px 12px" }}>
                {f.label}
              </button>
            ))}
            <div style={{ width: 1, height: 20, background: "var(--b2)", margin: "0 2px" }} />
            {[
              { id: '', label: 'All types' },
              { id: 'SP', label: 'SP' },
              { id: 'SB', label: 'SB' },
              { id: 'SD', label: 'SD' },
            ].map(f => (
              <button key={f.id} onClick={() => setStCampaignType(f.id)}
                className={`btn ${stCampaignType === f.id ? "btn-primary" : "btn-ghost"}`}
                style={{ fontSize: 11, padding: "5px 10px" }}>
                {f.label}
              </button>
            ))}
            <DateRangePicker
              dateFrom={stDateFrom} dateTo={stDateTo} metricsDays={stMetricsDays}
              onChange={({ dateFrom, dateTo, metricsDays }) => {
                setStDateFrom(dateFrom || null);
                setStDateTo(dateTo || null);
                if (metricsDays) setStMetricsDays(metricsDays);
              }}
            />
            <CampaignMultiSelect
              selectedIds={stCampaignIds}
              onChange={setStCampaignIds}
            />
            <span style={{ fontSize: 11, color: "var(--tx3)", marginLeft: "auto" }}>
              {stTotal.toLocaleString()} queries
            </span>
            <button
              className="btn btn-ghost"
              onClick={syncSearchTerms}
              disabled={stSyncing}
              title="Sync search term data from Amazon (last 30 days)"
              style={{ fontSize: 11, padding: "5px 12px", display: "flex", alignItems: "center", gap: 5 }}>
              <Ic icon={RefreshCw} size={12} style={stSyncing ? { animation: "spin 1s linear infinite" } : {}} />
              {stSyncing ? "Syncing…" : "Sync"}
            </button>
          </div>

          {/* Search Terms bulk panel */}
          {stSelected.size > 0 && (
            <div className="card fade" style={{ padding: "10px 16px", marginBottom: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", borderColor: "rgba(59,130,246,.4)", background: "rgba(59,130,246,.05)" }}>
              <span style={{ fontSize: 13, color: "var(--ac2)", fontWeight: 500 }}>{stSelected.size} selected</span>
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: "5px 12px", color: "var(--grn)" }}
                onClick={() => openHarvestModal(searchTerms.filter(t => stSelected.has(t.id)), 'keyword')}>
                + Add as Keywords
              </button>
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: "5px 12px", color: "var(--red)" }}
                onClick={() => openHarvestModal(searchTerms.filter(t => stSelected.has(t.id)), 'negative')}>
                − Add as Negatives
              </button>
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: "5px 12px" }}
                onClick={() => setStSelected(new Set())}>Cancel</button>
            </div>
          )}

          {/* Search Terms table */}
          {stLoading ? (
            <div style={{ padding: 40, textAlign: "center" }}><span className="loader" /></div>
          ) : searchTerms.length === 0 ? (
            <div className="card" style={{ padding: "60px 32px", textAlign: "center" }}>
              <Ic icon={Search} size={40} style={{ color: "var(--tx3)", opacity: 0.3, marginBottom: 12 }} />
              <p style={{ fontSize: 15, fontWeight: 600, color: "var(--tx)", margin: "0 0 8px" }}>
                No search term data yet
              </p>
              <p style={{ fontSize: 13, color: "var(--tx2)", margin: "0 0 16px", maxWidth: 400 }}>
                Search term data comes from the Amazon SP Search Term report.
                Run a report sync to populate this table.
              </p>
              <p style={{ fontSize: 11, color: "var(--tx3)", background: "var(--s2)",
                border: "1px solid var(--b2)", borderRadius: 6, padding: "6px 14px", display: "inline-block", marginBottom: 16 }}>
                Report type: spSearchTerm · Amazon data lag: 24–48h
              </p>
              <br />
              <button className="btn btn-primary" onClick={syncSearchTerms} disabled={stSyncing}
                style={{ fontSize: 12, padding: "8px 20px" }}>
                {stSyncing ? "Syncing…" : "Sync Now"}
              </button>
            </div>
          ) : (
            <div className="card" style={{ overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={{ width: 36, padding: "8px 10px", background: "var(--s2)", borderBottom: "2px solid var(--b1)" }}>
                        <input type="checkbox"
                          checked={searchTerms.length > 0 && stSelected.size === searchTerms.length}
                          onChange={() => stSelected.size === searchTerms.length
                            ? setStSelected(new Set())
                            : setStSelected(new Set(searchTerms.map(t => t.id)))}
                        />
                      </th>
                      {[
                        { col: "query",       label: "Query",      align: "left",   width: 220 },
                        { col: "campaign",    label: "Campaign",   align: "left",   width: 150, noSort: true },
                        { col: "impressions", label: "Impr.",      align: "right",  width: 70 },
                        { col: "clicks",      label: "Clicks",     align: "right",  width: 65 },
                        { col: "orders",      label: "Orders",     align: "right",  width: 65 },
                        { col: "spend",       label: "Spend",      align: "right",  width: 80 },
                        { col: "acos",        label: "ACOS",       align: "right",  width: 70, noSort: true },
                        { col: "rec",         label: "Suggestion", align: "center", width: 100, noSort: true },
                        { col: "actions",     label: "",           align: "center", width: 160, noSort: true },
                      ].map(h => (
                        <th key={h.col}
                          onClick={!h.noSort ? () => {
                            if (stSortCol === h.col) setStSortDir(d => d === "asc" ? "desc" : "asc");
                            else { setStSortCol(h.col); setStSortDir("desc"); }
                          } : undefined}
                          style={{
                            padding: "8px 10px", textAlign: h.align,
                            color: "var(--tx3)", fontWeight: 500, fontSize: 11,
                            borderBottom: "2px solid var(--b1)",
                            cursor: h.noSort ? "default" : "pointer",
                            whiteSpace: "nowrap", width: h.width,
                            background: "var(--s2)",
                          }}>
                          {h.label}
                          {!h.noSort && stSortCol === h.col && (
                            <span style={{ marginLeft: 4 }}>{stSortDir === "asc" ? "↑" : "↓"}</span>
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {searchTerms.map((term, i) => {
                      const acos = parseFloat(term.sales) > 0
                        ? (parseFloat(term.spend) / parseFloat(term.sales)) * 100
                        : null;
                      const rec = stRecommendation(term);
                      const isSel = stSelected.has(term.id);
                      return (
                        <tr key={term.id || i} style={{
                          borderBottom: "1px solid var(--b1)",
                          background: isSel
                            ? "rgba(59,130,246,0.08)"
                            : rec === "harvest"
                              ? "rgba(34,197,94,0.04)"
                              : rec === "negate"
                                ? "rgba(239,68,68,0.04)"
                                : "transparent",
                          cursor: "default",
                        }}>
                          <td style={{ padding: "7px 10px" }}>
                            <input type="checkbox" checked={isSel}
                              onChange={() => {
                                const s = new Set(stSelected);
                                isSel ? s.delete(term.id) : s.add(term.id);
                                setStSelected(s);
                              }} />
                          </td>
                          <td style={{ padding: "7px 10px", fontWeight: 500 }}>
                            <span title={term.query} style={{
                              display: "block", maxWidth: 210,
                              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                            }}>{term.query}</span>
                            {term.match_type && (
                              <span style={{ fontSize: 10, color: "var(--tx3)", marginTop: 1, display: "block" }}>
                                via {term.keyword_text || "—"} · {term.match_type}
                              </span>
                            )}
                          </td>
                          <td style={{ padding: "7px 10px", fontSize: 11, color: "var(--tx2)",
                            maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                            title={term.campaign_name}>
                            {term.campaign_name || "—"}
                          </td>
                          <td style={{ padding: "7px 10px", textAlign: "right", color: "var(--tx2)" }}>
                            {parseInt(term.impressions || 0).toLocaleString()}
                          </td>
                          <td style={{ padding: "7px 10px", textAlign: "right" }}>
                            {parseInt(term.clicks || 0).toLocaleString()}
                          </td>
                          <td style={{ padding: "7px 10px", textAlign: "right",
                            color: parseInt(term.orders || 0) > 0 ? "var(--grn)" : "var(--tx3)" }}>
                            {parseInt(term.orders || 0) > 0 ? parseInt(term.orders).toLocaleString() : "—"}
                          </td>
                          <td style={{ padding: "7px 10px", textAlign: "right", color: "var(--ac2)" }}>
                            {parseFloat(term.spend || 0) > 0 ? "$" + parseFloat(term.spend).toFixed(2) : "—"}
                          </td>
                          <td style={{ padding: "7px 10px", textAlign: "right",
                            color: acos !== null ? acosColor(acos) : "var(--tx3)" }}>
                            {acos !== null ? acos.toFixed(1) + "%" : "—"}
                          </td>
                          <td style={{ padding: "7px 10px", textAlign: "center" }}>
                            {rec === "harvest" && (
                              <span style={{ fontSize: 10, padding: "2px 7px",
                                background: "rgba(34,197,94,0.15)", color: "var(--grn)",
                                border: "1px solid rgba(34,197,94,0.3)", borderRadius: 10 }}>
                                ✓ Add as KW
                              </span>
                            )}
                            {rec === "negate" && (
                              <span style={{ fontSize: 10, padding: "2px 7px",
                                background: "rgba(239,68,68,0.15)", color: "var(--red)",
                                border: "1px solid rgba(239,68,68,0.3)", borderRadius: 10 }}>
                                − Negate
                              </span>
                            )}
                          </td>
                          <td style={{ padding: "7px 10px", textAlign: "center" }}>
                            <div style={{ display: "flex", gap: 4, justifyContent: "center" }}>
                              <button onClick={() => openHarvestModal(term, 'keyword')}
                                title="Add as keyword"
                                style={{ fontSize: 10, padding: "3px 8px", cursor: "pointer",
                                  background: "rgba(34,197,94,0.15)", color: "var(--grn)",
                                  border: "1px solid rgba(34,197,94,0.3)", borderRadius: 4,
                                  whiteSpace: "nowrap" }}>
                                + KW
                              </button>
                              <button onClick={() => openHarvestModal(term, 'negative')}
                                title="Add as negative"
                                style={{ fontSize: 10, padding: "3px 8px", cursor: "pointer",
                                  background: "rgba(239,68,68,0.10)", color: "var(--red)",
                                  border: "1px solid rgba(239,68,68,0.3)", borderRadius: 4,
                                  whiteSpace: "nowrap" }}>
                                − Neg
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {kwTab === 'negatives' && (
        <NegativesTab workspaceId={workspaceId} />
      )}

      {kwTab === 'keywords' && <>
      <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
        <input placeholder={t("keywords.searchPlaceholder")} value={kwFilters.search}
          onChange={e => { setKwFilter("search", e.target.value); setPage(1); }} style={{ width: 200 }} data-search-input />
        {[
          { value: "", label: t("filter.all") },
          { value: "enabled",  label: t("common.statusEnabled") },
          { value: "paused",   label: t("common.statusPaused") },
          { value: "archived", label: t("common.statusArchived") },
        ].map(s => (
          <button key={s.value} onClick={() => { setKwFilter("state", s.value); setPage(1); }}
            className={`btn ${kwFilters.state === s.value ? "btn-primary" : "btn-ghost"}`}
            style={{ fontSize: 11, padding: "4px 8px" }}>{s.label}</button>
        ))}
        {[
          { value: "", label: t("keywords.matchAll") },
          { value: "exact",  label: t("keywords.matchExact") },
          { value: "phrase", label: t("keywords.matchPhrase") },
          { value: "broad",  label: t("keywords.matchBroad") },
        ].map(m => (
          <button key={m.value} onClick={() => { setKwFilter("matchType", m.value); setPage(1); }}
            className={`btn ${kwFilters.matchType === m.value ? "btn-primary" : "btn-ghost"}`}
            style={{ fontSize: 11, padding: "4px 8px" }}>{m.label}</button>
        ))}
        <DateRangePicker
          dateFrom={kwDateFrom} dateTo={kwDateTo} metricsDays={kwMetricsDays}
          onChange={({ dateFrom, dateTo, metricsDays }) => {
            setKwDateFrom(dateFrom || null);
            setKwDateTo(dateTo || null);
            if (metricsDays) setKwMetricsDays(metricsDays);
            setPage(1);
          }}
        />
        <CampaignMultiSelect
          selectedIds={kwCampaignIds}
          onChange={(ids) => { setKwCampaignIds(ids); setPage(1); }}
        />
        <button onClick={() => setShowKwFilters(true)}
          className={`btn ${kwActiveCount > 0 ? "btn-primary" : "btn-ghost"}`}
          style={{ fontSize: 12, padding: "5px 12px", display: "flex", alignItems: "center", gap: 5 }}>
          <Ic icon={Filter} size={13} /> {t("filter.filters")}
          {kwActiveCount > 0 && (
            <span style={{ background: "var(--red)", color: "#fff", borderRadius: 8,
              fontSize: 9, padding: "1px 5px", minWidth: 14, textAlign: "center" }}>{kwActiveCount}</span>
          )}
        </button>
        {kwActiveCount > 0 && (
          <button onClick={() => { resetKwFilters(); setPage(1); }} className="btn btn-ghost"
            style={{ fontSize: 11, padding: "4px 10px", color: "var(--tx3)" }}><X size={11} strokeWidth={1.75} style={{display:'inline-block',verticalAlign:'middle'}} /> {t("filter.reset")}</button>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          <button className="btn btn-ghost" style={{ fontSize: 12 }} data-refresh-btn onClick={reload}><Ic icon={RefreshCw} size={13} /> {t("common.refresh")}</button>
          {lastSync && (
            <span className="last-sync-label" style={{ marginLeft: 2 }}>
              · {fmtLastSync(lastSync)}
            </span>
          )}
          {KwColsBtn}
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={kwResetCols} title="Reset column widths"><Ic icon={Minus} size={13} /></button>
        </div>
      </div>

      {selected.size > 0 && (
        <div className="card fade" style={{ padding: "10px 16px", marginBottom: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", borderColor: "rgba(59,130,246,.4)", background: "rgba(59,130,246,.05)" }}>
          <span style={{ fontSize: 13, color: "var(--ac2)", fontWeight: 500 }}>{t("keywords.selected", { count: selected.size })}</span>
          <span style={{ fontSize: 12, color: "var(--tx2)" }}>{t("keywords.bulkBidAdjustLabel")}</span>
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
            {saving ? <span className="loader" /> : t("keywords.applyBid")}
          </button>
          <div style={{ width: 1, background: "var(--b1)", alignSelf: "stretch" }} />
          <button className="btn btn-ghost" style={{ fontSize: 12, padding: "5px 12px", color: "var(--grn)" }} onClick={() => bulkStateUpdate("enabled")} disabled={saving}>
            <Play size={11} strokeWidth={2} style={{ display: "inline-block", verticalAlign: "middle", marginRight: 4 }} />{t("keywords.enableSelected")}
          </button>
          <button className="btn btn-ghost" style={{ fontSize: 12, padding: "5px 12px", color: "var(--amb)" }} onClick={() => bulkStateUpdate("paused")} disabled={saving}>
            <Pause size={11} strokeWidth={2} style={{ display: "inline-block", verticalAlign: "middle", marginRight: 4 }} />{t("keywords.pauseSelected")}
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
                <table className="resizable">
                  {kwColgroup}
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}>
                        <input type="checkbox" checked={selected.size === keywords.length && keywords.length > 0} onChange={toggleAll} />
                      </th>
                      <SortHeader field="keyword_text" label={t("keywords.colKeyword")} currentSort={sortBy} currentDir={sortDir} onSort={handleKwSort} rh={kwRH(1)} />
                      {kwCV("match")    && <SortHeader field="match_type" label={t("keywords.colMatch")}   currentSort={sortBy} currentDir={sortDir} onSort={handleKwSort} rh={kwRH(2)} />}
                      {kwCV("status")   && <SortHeader field="state"      label={t("keywords.colStatus")}  currentSort={sortBy} currentDir={sortDir} onSort={handleKwSort} rh={kwRH(3)} />}
                      {kwCV("bid")      && <SortHeader field="bid"        label={t("keywords.colBid")}     currentSort={sortBy} currentDir={sortDir} onSort={handleKwSort} align="right" rh={kwRH(4)} />}
                      {kwCV("campaign") && <SortHeader field="campaign"   label={t("keywords.colCampaign")} currentSort={sortBy} currentDir={sortDir} onSort={handleKwSort} rh={kwRH(5)} />}
                      {kwCV("clicks")   && <SortHeader field="clicks"     label={t("keywords.colClicks")}  currentSort={sortBy} currentDir={sortDir} onSort={handleKwSort} align="right" rh={kwRH(6)} />}
                      {kwCV("orders")   && <SortHeader field="orders"     label={t("keywords.colOrders")}  currentSort={sortBy} currentDir={sortDir} onSort={handleKwSort} align="right" rh={kwRH(7)} />}
                      {kwCV("acos")     && <SortHeader field="acos"       label="ACOS"                     currentSort={sortBy} currentDir={sortDir} onSort={handleKwSort} align="right" rh={kwRH(8)} />}
                      {kwCV("spend")    && <SortHeader field="spend"      label={t("keywords.colSpend")}   currentSort={sortBy} currentDir={sortDir} onSort={handleKwSort} align="right" rh={kwRH(9)} />}
                      <th>{kwRH(10)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {keywords.map(kw => (
                      <tr key={kw.id} className={`tbl-row${selected.has(kw.id) ? ' row-selected' : ''}`} onMouseEnter={() => setHoveredKwId(kw.id)} onMouseLeave={() => setHoveredKwId(null)}>
                        <td><input type="checkbox" checked={selected.has(kw.id)} onChange={() => toggleSelect(kw.id)} /></td>
                        <td style={{ fontWeight: 500 }}>{kw.keyword_text}</td>
                        {kwCV("match") && <td><span className={`badge ${matchCls(kw.match_type)}`} style={{ fontSize: 10 }}>{kw.match_type}</span></td>}
                        {kwCV("status") && <td>
                          <span
                            className={`tag ${kw.state !== "archived" ? "status-clickable" : ""} ${kw.state === "enabled" ? "tag-on" : kw.state === "paused" ? "tag-pause" : "tag-arch"}`}
                            onClick={() => toggleState(kw.id, kw.state, kw.keyword_text)}
                            title={kw.state !== "archived" ? (kw.state === "enabled" ? t("keywords.clickToPause") : t("keywords.clickToEnable")) : ""}
                          >
                            <span style={{ width: 5, height: 5, borderRadius: "50%", background: "currentColor", display: "inline-block" }} />
                            {kw.state}
                          </span>
                        </td>}
                        {kwCV("bid") && <td className="num" style={{ textAlign: "right" }}>
                          {editId === kw.id
                            ? (
                              <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                                <input type="number" step="0.01" value={editBid} onChange={e => setEditBid(e.target.value)} style={{ width: 70, fontSize: 11, padding: "3px 6px" }} autoFocus />
                                <button className="btn btn-green" style={{ fontSize: 10, padding: "3px 8px" }} onClick={() => saveBid(kw.id)} disabled={saving}><Check size={11} strokeWidth={1.75} /></button>
                                <button className="btn btn-ghost" style={{ fontSize: 10, padding: "3px 8px" }} onClick={() => setEditId(null)}><X size={11} strokeWidth={1.75} /></button>
                              </div>
                            )
                            : (
                              <span style={{ cursor: "pointer", color: "var(--ac2)" }} onClick={() => { setEditId(kw.id); setEditBid(kw.bid ? parseFloat(kw.bid).toFixed(2) : ""); }}>
                                ${parseFloat(kw.bid || 0).toFixed(2)}
                              </span>
                            )
                          }
                        </td>}
                        {kwCV("campaign") && <td style={{ fontSize: 11, color: "var(--tx3)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{kw.campaign_name}</td>}
                        {kwCV("clicks") && <td className="num" style={{ textAlign: 'right' }}>
                          {kw.clicks ? Number(kw.clicks).toLocaleString() : '—'}
                        </td>}
                        {kwCV("orders") && <td className="num" style={{ textAlign: 'right' }}>
                          {kw.orders ? Number(kw.orders).toLocaleString() : '—'}
                        </td>}
                        {kwCV("acos") && <td className="num" style={{ textAlign: 'right', color: kw.acos != null && parseFloat(kw.acos) > 0 ? acosColor(parseFloat(kw.acos)) : 'var(--tx3)' }}>
                          {kw.acos != null && parseFloat(kw.acos) > 0 ? parseFloat(kw.acos).toFixed(1) + '%' : '—'}
                        </td>}
                        {kwCV("spend") && <td className="num" style={{ textAlign: 'right', color: 'var(--ac2)' }}>
                          {kw.spend && parseFloat(kw.spend) > 0 ? '$' + parseFloat(kw.spend).toFixed(2) : '—'}
                        </td>}
                        <td className="act-cell" style={{ opacity: (hoveredKwId === kw.id || selected.has(kw.id)) ? 1 : 0, pointerEvents: (hoveredKwId === kw.id || selected.has(kw.id)) ? 'auto' : 'none' }}>
                          {editId !== kw.id && (
                            <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
                              <button className="btn btn-ghost" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => { setEditId(kw.id); setEditBid(kw.bid ? parseFloat(kw.bid).toFixed(2) : ""); }}>
                                {t("keywords.editBid")}
                              </button>
                              <ChangeHistoryBtn entityId={kw.id} />
                            </div>
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

      {/* Pagination controls */}
      {kwTotal > 0 && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14, flexWrap: "wrap", gap: 10 }}>
          {/* Left: page size selector */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--tx2)" }}>
            {t("common.perPage")}
            {[25, 50, 100, 200, 500].map(size => (
              <button
                key={size}
                onClick={() => { setPageSize(size); setPage(1); }}
                className={`btn ${pageSize === size ? "btn-primary" : "btn-ghost"}`}
                style={{ fontSize: 11, padding: "4px 10px", minWidth: 36 }}
              >
                {size}
              </button>
            ))}
          </div>

          {/* Center: range info */}
          <div style={{ fontSize: 13, color: "var(--tx2)" }}>
            {((page - 1) * pageSize) + 1}–{Math.min(page * pageSize, kwTotal)} {t("common.of")} {kwTotal.toLocaleString()}
          </div>

          {/* Right: prev/next + page numbers */}
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }}
              onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>
              {t("common.back")}
            </button>
            {getPageRange(page, totalPages).map((p, i) =>
              p === "..."
                ? <span key={`e${i}`} style={{ padding: "0 6px", color: "var(--tx3)" }}>…</span>
                : <button key={p}
                    onClick={() => setPage(p)}
                    className={`btn ${page === p ? "btn-primary" : "btn-ghost"}`}
                    style={{ fontSize: 11, padding: "4px 8px", minWidth: 32 }}
                  >{p}</button>
            )}
            <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }}
              onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
              {t("common.next")}
            </button>
          </div>
        </div>
      )}

      <FilterPanel
        isOpen={showKwFilters}
        onClose={() => setShowKwFilters(false)}
        filters={kwFilters}
        onUpdate={(k, v) => { setKwFilter(k, v); setPage(1); }}
        onReset={() => { resetKwFilters(); setPage(1); }}
        presets={kwPresets}
        onSavePreset={saveKwPreset}
        onLoadPreset={p => { loadKwPreset(p); setPage(1); }}
        onDeletePreset={deleteKwPreset}
        fields={[
          { key: "state", label: t("keywords.colStatus"), type: "select", options: [
            { value: "enabled", label: "Enabled" }, { value: "paused", label: "Paused" }, { value: "archived", label: "Archived" },
          ]},
          { key: "matchType", label: t("keywords.colMatch"), type: "multiselect", options: [
            { value: "exact", label: "Exact" }, { value: "phrase", label: "Phrase" }, { value: "broad", label: "Broad" },
          ]},
          { key: "campaignType", label: t("campaigns.colType"), type: "select", options: [
            { value: "SP", label: "Sponsored Products" }, { value: "SB", label: "Sponsored Brands" }, { value: "SD", label: "Sponsored Display" },
          ]},
          { key: "bid", label: t("keywords.colBid"), type: "range", min: 0, max: 100, step: 0.01, unit: "€" },
          { key: "metricsDays", label: t("filter.metricsPeriod"), type: "select", options: [
            { value: 7, label: "7 days" }, { value: 14, label: "14 days" }, { value: 30, label: "30 days" },
            { value: 60, label: "60 days" }, { value: 90, label: "90 days" },
          ]},
          { key: "spend", label: "Spend", type: "range", min: 0, max: 1000, step: 0.1, unit: "€" },
          { key: "acos", label: "ACOS", type: "range", min: 0, max: 500, step: 0.1, unit: "%" },
          { key: "clicksMin", label: t("filter.minClicks"), type: "number", min: 0 },
          { key: "ordersMin", label: t("filter.minOrders"), type: "number", min: 0 },
          { key: "noSales", label: t("filter.noSales"), type: "toggle" },
          { key: "hasClicks", label: t("filter.hasActivity"), type: "toggle" },
        ]}
      />
      </>}
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
// ─── Analytics / Analyst Report Page ─────────────────────────────────────────
const AnalyticsPage = ({ workspaceId }) => {
  const { t: tr } = useI18n();
  const [rangeMode, setRangeMode] = useState("7");
  const [customStart, setCustomStart] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 7);
    return d.toISOString().split("T")[0];
  });
  const [customEnd, setCustomEnd] = useState(() => new Date().toISOString().split("T")[0]);
  const [generating, setGenerating] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [editRow, setEditRow] = useState(null);
  const [saveMsg, setSaveMsg] = useState(null);
  const [tick, setTick] = useState(0);

  const endDate   = rangeMode !== "custom" ? new Date().toISOString().split("T")[0] : customEnd;
  const startDate = rangeMode !== "custom"
    ? new Date(Date.now() - parseInt(rangeMode) * 86400000).toISOString().split("T")[0]
    : customStart;

  const { data: config, loading: cfgLoading } = useAsync(
    () => workspaceId ? get("/analytics-report/config") : Promise.resolve([]),
    [workspaceId, tick]
  );

  const reloadConfig = () => setTick(t => t + 1);

  const handleDownload = async () => {
    setGenerating(true);
    try {
      const token = localStorage.getItem("af_token");
      const wid   = workspaceId || localStorage.getItem("af_workspace");
      const url   = `${(import.meta?.env?.VITE_API_URL) || "http://localhost:4000/api/v1"}/analytics-report/download?startDate=${startDate}&endDate=${endDate}`;
      const resp  = await fetch(url, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "x-workspace-id": wid,
        },
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text);
      }
      const blob = await resp.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${startDate.replace(/-/g,"_")}-${endDate.replace(/-/g,"_")}.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      alert(tr("common.error") + err.message);
    } finally {
      setGenerating(false);
    }
  };

  const handleSaveRow = async (row) => {
    try {
      await post("/analytics-report/config", {
        ...row,
        cogs_per_unit:      parseFloat(row.cogs_per_unit)      || 0,
        shipping_per_unit:  parseFloat(row.shipping_per_unit)  || 0,
        amazon_fee_pct:     parseFloat(row.amazon_fee_pct)     || -0.15,
        vat_pct:            parseFloat(row.vat_pct)            || -0.19,
        google_ads_weekly:  parseFloat(row.google_ads_weekly)  || 0,
        facebook_ads_weekly:parseFloat(row.facebook_ads_weekly)|| 0,
        sellable_quota:     parseInt(row.sellable_quota)       || 0,
        label:              row.label ? parseInt(row.label) : null,
      });
      setSaveMsg("saved");
      setTimeout(() => setSaveMsg(null), 2000);
      reloadConfig();
      setEditRow(null);
    } catch (e) {
      alert(tr("common.error") + e.message);
    }
  };

  const EMPTY_ROW = {
    asin:"", sku:"", label:"", product_name:"",
    cogs_per_unit:0, shipping_per_unit:0,
    amazon_fee_pct:-0.15, vat_pct:-0.19,
    google_ads_weekly:0, facebook_ads_weekly:0, sellable_quota:0,
  };

  const CONFIG_FIELDS = ["asin","sku","label","product_name","cogs_per_unit","shipping_per_unit","amazon_fee_pct","vat_pct","google_ads_weekly","facebook_ads_weekly"];

  return (
    <div className="fade">
      {/* ── Header ── */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:20, flexWrap:"wrap", gap:10 }}>
        <div>
          <h1 style={{ fontFamily:"var(--disp)", fontSize:22, fontWeight:700, marginBottom:4 }}>
            {tr("analytics.title")}
          </h1>
          <div style={{ fontSize:12, color:"var(--tx3)" }}>{startDate} – {endDate}</div>
        </div>
        <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
          {[["7","7d"],["14","14d"],["30","30d"]].map(([val,label]) => (
            <button key={val}
              onClick={() => setRangeMode(val)}
              className={`btn ${rangeMode===val?"btn-primary":"btn-ghost"}`}
              style={{ fontSize:12, padding:"5px 10px" }}>
              {label}
            </button>
          ))}
          <button
            onClick={() => setRangeMode("custom")}
            className={`btn ${rangeMode==="custom"?"btn-primary":"btn-ghost"}`}
            style={{ fontSize:12, padding:"5px 10px" }}
          >
            <Ic icon={Calendar} size={13} /> {rangeMode==="custom" ? `${customStart.slice(5)} – ${customEnd.slice(5)}` : "Custom"}
          </button>
          {rangeMode === "custom" && (
            <>
              <input type="date" value={customStart} max={customEnd}
                onChange={e => setCustomStart(e.target.value)}
                style={{ fontSize:12, padding:"4px 8px", borderRadius:6,
                  background:"var(--s2)", border:"1px solid var(--b2)",
                  color:"var(--tx)", outline:"none", cursor:"pointer" }} />
              <span style={{ fontSize:12, color:"var(--tx3)" }}>→</span>
              <input type="date" value={customEnd} min={customStart}
                max={new Date().toISOString().split("T")[0]}
                onChange={e => setCustomEnd(e.target.value)}
                style={{ fontSize:12, padding:"4px 8px", borderRadius:6,
                  background:"var(--s2)", border:"1px solid var(--b2)",
                  color:"var(--tx)", outline:"none", cursor:"pointer" }} />
            </>
          )}
          <button
            onClick={handleDownload}
            disabled={generating}
            className="btn btn-primary"
            style={{ fontSize:12, padding:"6px 16px", display:"flex", alignItems:"center", gap:6 }}
          >
            {generating ? tr("analytics.generating") : <><Ic icon={Download} size={13} /> {tr("analytics.download")}</>}
          </button>
        </div>
      </div>

      {/* ── Info card ── */}
      <div className="card" style={{ padding:"14px 18px", marginBottom:16,
        border:"1px solid rgba(59,130,246,.25)", background:"rgba(59,130,246,.05)" }}>
        <div style={{ fontSize:13, fontWeight:600, marginBottom:6, color:"var(--tx)" }}>Report contents</div>
        <div style={{ fontSize:12, color:"var(--tx2)", lineHeight:1.8 }}>
          <b>Sheet_1</b>: All SKUs — SP/SD/SB spend, sales, units, Real ACOS, BSR, P&amp;L formulas ·{" "}
          <b>Sheet_2</b>: Summary by product group ·{" "}
          <b>Sheet_3</b>: ASIN→SKU→Label reference
        </div>
        <div style={{ fontSize:11, color:"var(--tx3)", marginTop:6 }}>
          Amazon fees, VAT, COGS, Shipping are calculated from cost config below.
          Without config those columns will be 0.
        </div>
      </div>

      {/* ── SKU Cost Config ── */}
      <div className="card" style={{ overflow:"hidden" }}>
        <div
          onClick={() => setShowConfig(c => !c)}
          style={{ padding:"14px 18px", display:"flex", justifyContent:"space-between",
            alignItems:"center", cursor:"pointer", userSelect:"none" }}
        >
          <div>
            <div style={{ fontFamily:"var(--disp)", fontSize:14, fontWeight:600 }}>
              {tr("analytics.configTitle")}
              {saveMsg && <Check size={14} strokeWidth={1.75} color="var(--grn)" style={{ marginLeft:10, display:"inline-block", verticalAlign:"middle" }} />}
            </div>
            <div style={{ fontSize:12, color:"var(--tx3)", marginTop:2 }}>
              {tr("analytics.configSubtitle")}
            </div>
          </div>
          <span style={{ color:"var(--tx3)" }}>{showConfig ? <ChevronUp size={16} strokeWidth={1.75} /> : <ChevronDown size={16} strokeWidth={1.75} />}</span>
        </div>

        {showConfig && (
          <>
            <div style={{ overflowX:"auto" }}>
              <table style={{ minWidth:900 }}>
                <thead><tr>
                  <th>ASIN</th>
                  <th>SKU</th>
                  <th style={{ textAlign:"center" }}>Label</th>
                  <th>Name</th>
                  <th style={{ textAlign:"right" }}>COGS/unit</th>
                  <th style={{ textAlign:"right" }}>Ship/unit</th>
                  <th style={{ textAlign:"right" }}>Amz fee</th>
                  <th style={{ textAlign:"right" }}>VAT</th>
                  <th style={{ textAlign:"right" }}>Google€/wk</th>
                  <th style={{ textAlign:"right" }}>FB€/wk</th>
                  <th></th>
                </tr></thead>
                <tbody>
                  {cfgLoading ? (
                    <tr><td colSpan={11} style={{ padding:16, textAlign:"center", color:"var(--tx3)", fontSize:12 }}>Loading…</td></tr>
                  ) : (config || []).map(row => (
                    editRow?.id === row.id ? (
                      <tr key={row.id}>
                        {CONFIG_FIELDS.map(field => (
                          <td key={field} style={{ padding:"4px 6px" }}>
                            <input
                              value={editRow[field] ?? ""}
                              onChange={e => setEditRow(r => ({ ...r, [field]: e.target.value }))}
                              style={{ width:"100%", fontSize:11, padding:"2px 4px",
                                background:"var(--s2)", border:"1px solid var(--b2)",
                                borderRadius:4, color:"var(--tx)" }}
                            />
                          </td>
                        ))}
                        <td style={{ whiteSpace:"nowrap", padding:"4px 8px" }}>
                          <button onClick={() => handleSaveRow(editRow)}
                            className="btn btn-primary" style={{ fontSize:10, padding:"2px 8px" }}>
                            {tr("analytics.save")}
                          </button>
                          <button onClick={() => setEditRow(null)}
                            className="btn btn-ghost" style={{ fontSize:10, padding:"2px 6px", marginLeft:4 }}><X size={11} strokeWidth={1.75} /></button>
                        </td>
                      </tr>
                    ) : (
                      <tr key={row.id} onClick={() => setEditRow({ ...row })} style={{ cursor:"pointer" }}>
                        <td style={{ fontFamily:"var(--mono)", fontSize:11 }}>{row.asin}</td>
                        <td style={{ fontSize:11 }}>{row.sku}</td>
                        <td style={{ textAlign:"center", fontSize:11 }}>{row.label}</td>
                        <td style={{ fontSize:11, maxWidth:140, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                          {row.product_name}
                        </td>
                        <td className="num" style={{ textAlign:"right", fontSize:11 }}>{parseFloat(row.cogs_per_unit).toFixed(2)}</td>
                        <td className="num" style={{ textAlign:"right", fontSize:11 }}>{parseFloat(row.shipping_per_unit).toFixed(2)}</td>
                        <td className="num" style={{ textAlign:"right", fontSize:11 }}>{(parseFloat(row.amazon_fee_pct)*100).toFixed(0)}%</td>
                        <td className="num" style={{ textAlign:"right", fontSize:11 }}>{(parseFloat(row.vat_pct)*100).toFixed(0)}%</td>
                        <td className="num" style={{ textAlign:"right", fontSize:11 }}>{parseFloat(row.google_ads_weekly).toFixed(2)}</td>
                        <td className="num" style={{ textAlign:"right", fontSize:11 }}>{parseFloat(row.facebook_ads_weekly).toFixed(2)}</td>
                        <td style={{ color:"var(--tx3)" }}><Pencil size={11} strokeWidth={1.75} /></td>
                      </tr>
                    )
                  ))}

                  {/* Add new row */}
                  {editRow?.id === "__new__" ? (
                    <tr>
                      {CONFIG_FIELDS.map(field => (
                        <td key={field} style={{ padding:"4px 6px" }}>
                          <input
                            value={editRow[field] ?? ""}
                            onChange={e => setEditRow(r => ({ ...r, [field]: e.target.value }))}
                            placeholder={field === "amazon_fee_pct" ? "-0.15" : field === "vat_pct" ? "-0.19" : ""}
                            style={{ width:"100%", fontSize:11, padding:"2px 4px",
                              background:"var(--s2)", border:"1px solid var(--ac)",
                              borderRadius:4, color:"var(--tx)" }}
                          />
                        </td>
                      ))}
                      <td style={{ whiteSpace:"nowrap", padding:"4px 8px" }}>
                        <button onClick={() => handleSaveRow(editRow)}
                          className="btn btn-primary" style={{ fontSize:10, padding:"2px 8px" }}>
                          {tr("analytics.save")}
                        </button>
                        <button onClick={() => setEditRow(null)}
                          className="btn btn-ghost" style={{ fontSize:10, padding:"2px 6px", marginLeft:4 }}><X size={11} strokeWidth={1.75} /></button>
                      </td>
                    </tr>
                  ) : (
                    <tr>
                      <td colSpan={11} style={{ padding:"8px 14px" }}>
                        <button
                          onClick={() => setEditRow({ ...EMPTY_ROW, id:"__new__" })}
                          className="btn btn-ghost"
                          style={{ fontSize:11, padding:"4px 12px" }}>
                          + {tr("analytics.addProduct")}
                        </button>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {(!config || config.length === 0) && !editRow && (
              <div style={{ padding:"16px 18px", color:"var(--tx3)", fontSize:13 }}>
                {tr("analytics.noConfig")}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

const dayparthingToCron = (dp) => {
  if (!dp) return null;
  const hour = dp.hour != null ? dp.hour : '*';
  const days = (dp.days && dp.days.length > 0 && dp.days.length < 7) ? dp.days.join(',') : '*';
  if (hour === '*' && days === '*') return null;
  return `0 ${hour} * * ${days}`;
};
const cronToDayparting = (cron) => {
  if (!cron) return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const hourPart = parts[1];
  const dayPart  = parts[4];
  const hour = hourPart === '*' ? null : parseInt(hourPart);
  const days = dayPart  === '*' ? [] : dayPart.split(',').map(Number);
  if (hour === null && days.length === 0) return null;
  return { hour, days };
};
const DP_DAYS = [['Mo',1],['Tu',2],['We',3],['Th',4],['Fr',5],['Sa',6],['Su',0]];

const EMPTY_RULE_FORM = {
  name: "", description: "", dry_run: false, is_active: true,
  conditions: [{ metric: "clicks", op: "gte", value: "30" }],
  actions:    [{ type: "pause_keyword", value: "" }],
  scope:  { entity_type: "keyword", period_days: 14, campaign_type: "", campaign_ids: [], ad_group_ids: [], match_types: [], campaign_name_contains: "", dayparting: null },
  safety: { min_bid: "0.02", max_bid: "50" },
};

const RULE_METRICS = (t) => [
  { value:"clicks",      label:t("rules.metric.clicks") },
  { value:"spend",       label:t("rules.metric.spend") },
  { value:"sales",       label:t("rules.metric.sales") },
  { value:"orders",      label:t("rules.metric.orders") },
  { value:"impressions", label:t("rules.metric.impressions") },
  { value:"acos",        label:t("rules.metric.acos") },
  { value:"roas",        label:t("rules.metric.roas") },
  { value:"ctr",         label:t("rules.metric.ctr") },
  { value:"cpc",         label:t("rules.metric.cpc") },
  { value:"bid",         label:t("rules.metric.bid") },
];
const RULE_OPS = [
  { value:"gte", label:"≥" },
  { value:"gt",  label:">" },
  { value:"lte", label:"≤" },
  { value:"lt",  label:"<" },
  { value:"eq",  label:"=" },
  { value:"neq", label:"≠" },
];
const RULE_ACTIONS_LIST = (t) => [
  { value:"pause_keyword",         label:t("rules.pauseKeyword"),         et:"keyword" },
  { value:"enable_keyword",        label:t("rules.enableKeyword"),        et:"keyword" },
  { value:"adjust_bid_pct",        label:t("rules.adjustBidPct"),         et:"keyword" },
  { value:"set_bid",               label:t("rules.setBid"),               et:"keyword" },
  { value:"add_negative_keyword",  label:t("rules.addNegativeKeyword"),   et:"keyword" },
  { value:"pause_target",          label:t("rules.pauseTarget"),          et:"target" },
  { value:"enable_target",         label:t("rules.enableTarget"),         et:"target" },
  { value:"adjust_target_bid_pct", label:t("rules.adjustTargetBidPct"),   et:"target" },
  { value:"add_negative_target",   label:t("rules.addNegativeTarget"),    et:"target" },
];
const RULE_MATCH_TYPES = [
  { value:"exact",  label:"Exact" },
  { value:"phrase", label:"Phrase" },
  { value:"broad",  label:"Broad" },
];
const RULE_CAMP_TYPES = (t) => [
  { value:"",                   label:t("rules.allTypes") },
  { value:"sponsoredProducts",  label:"Sponsored Products" },
  { value:"sponsoredBrands",    label:"Sponsored Brands" },
  { value:"sponsoredDisplay",   label:"Sponsored Display" },
];

// ─── Rule Wizard Modal ────────────────────────────────────────────────────────
// ─── Rule templates (S1-1) ────────────────────────────────────────────────────
const RULE_TEMPLATES = [
  {
    id: 'pause_losing_kw', icon: '🔥', label: 'Pause losing keywords',
    description: 'Stop keywords with high spend and no orders',
    name: 'Pause — High Clicks, Zero Orders', entityType: 'keyword', periodDays: 30,
    conditions: [{ metric: 'clicks', op: 'gte', value: '20' }, { metric: 'orders', op: 'eq', value: '0' }],
    actions: [{ type: 'pause_keyword', value: '' }], dry_run: true,
  },
  {
    id: 'cut_high_acos', icon: '💸', label: 'Cut high ACOS bids',
    description: 'Reduce bids when ACOS exceeds target',
    name: 'Bid Down — ACOS > 40%', entityType: 'keyword', periodDays: 14,
    conditions: [{ metric: 'acos', op: 'gt', value: '40' }, { metric: 'clicks', op: 'gte', value: '10' }],
    actions: [{ type: 'adjust_bid_pct', value: '-15' }], dry_run: true,
  },
  {
    id: 'boost_top_performers', icon: '📈', label: 'Boost top performers',
    description: 'Increase bids on high-ROAS keywords',
    name: 'Bid Up — ROAS > 5×, Active Orders', entityType: 'keyword', periodDays: 14,
    conditions: [{ metric: 'roas', op: 'gt', value: '5' }, { metric: 'orders', op: 'gte', value: '3' }],
    actions: [{ type: 'adjust_bid_pct', value: '15' }], dry_run: true,
  },
  {
    id: 'add_negatives', icon: '🚫', label: 'Add wasted spend to negatives',
    description: 'Negate keywords with clicks but no sales',
    name: 'Negative Exact — Spend > €20, Zero Orders', entityType: 'keyword', periodDays: 30,
    conditions: [{ metric: 'spend', op: 'gt', value: '20' }, { metric: 'orders', op: 'eq', value: '0' }],
    actions: [{ type: 'add_negative_keyword', value: 'exact' }], dry_run: true,
  },
  {
    id: 'pause_zero_targets', icon: '⏸', label: 'Pause non-converting targets',
    description: 'Stop product targets that spend without orders',
    name: 'Pause Targets — Clicks ≥ 10, Zero Orders', entityType: 'product_target', periodDays: 30,
    conditions: [{ metric: 'clicks', op: 'gte', value: '10' }, { metric: 'orders', op: 'eq', value: '0' }],
    actions: [{ type: 'pause_target', value: '' }], dry_run: true,
  },
  {
    id: 'lower_low_roas', icon: '📉', label: 'Lower bids on low ROAS',
    description: 'Reduce bids when ROAS falls below threshold',
    name: 'Bid Down — ROAS < 2×', entityType: 'keyword', periodDays: 14,
    conditions: [{ metric: 'roas', op: 'lt', value: '2' }, { metric: 'clicks', op: 'gte', value: '15' }],
    actions: [{ type: 'adjust_bid_pct', value: '-10' }], dry_run: true,
  },
];

const RuleWizardModal = ({
  form, setForm, editRule, campaigns, adGroups,
  ruleMetrics, ruleActionsList, ruleCampTypes,
  condOperators, setCondOperators,
  updCond, remCond, addCond,
  updAct,  remAct,  addAct,
  toggleCampaign, toggleAdGroup, toggleMatchType,
  onSave, onClose,
}) => {
  const { t } = useI18n();
  const [step, setStep] = useState(1);
  const [nameErr, setNameErr] = useState(false);
  const [condErr, setCondErr] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(true);
  const [campSearch, setCampSearch] = useState("");
  // S1-2: preview state
  const [previewData, setPreviewData] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);

  const LABEL = { fontSize:11, color:"var(--tx3)", marginBottom:4,
    fontFamily:"var(--mono)", textTransform:"uppercase", letterSpacing:".05em" };
  const INP = { fontSize:13, padding:"8px 10px", borderRadius:6,
    background:"var(--s2)", border:"1px solid var(--b2)", color:"var(--tx)",
    outline:"none", boxSizing:"border-box", width:"100%" };
  const INP_SM = { ...INP, fontSize:12, padding:"7px 9px" };
  // Selects need explicit WebkitTextFillColor on macOS Chrome/Safari
  // Note: no width here — set width/flex explicitly per usage site
  const SEL_SM = { ...INP_SM, width:undefined, WebkitTextFillColor:"var(--tx)", appearance:"none",
    WebkitAppearance:"none", backgroundImage:"url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%234A5568'/%3E%3C/svg%3E\")",
    backgroundRepeat:"no-repeat", backgroundPosition:"right 8px center", paddingRight:26 };

  const periodLabel = form.scope?.period_days === 1
    ? t("rules.yesterday")
    : t("rules.periodDays", { days: form.scope?.period_days || 14 });

  const METRIC_UNIT = {
    spend:"€", sales:"€", bid:"€", cpc:"€",
    acos:"%", ctr:"%",
    roas:"×",
  };

  // Live sentence preview
  const RuleSummary = ({ showScope }) => {
    const entityType = form.scope?.entity_type || "keyword";
    const condStr = form.conditions.map((c, i) => {
      const mLabel = ruleMetrics.find(m => m.value === c.metric)?.label || c.metric;
      const opLabel = RULE_OPS.find(o => o.value === c.op)?.label || c.op;
      const gapOp = condOperators[i - 1] || 'AND';
      return (
        <span key={i}>
          {i > 0 && <span style={{ color: gapOp === 'OR' ? 'var(--amb)' : 'var(--tx3)', margin:"0 6px", fontFamily:"var(--mono)", fontWeight: 600 }}>{gapOp}</span>}
          <span style={{ color:"var(--ac)", fontWeight:600 }}>{mLabel}</span>
          {" "}<span style={{ color:"var(--pur)", fontFamily:"var(--mono)" }}>{opLabel}</span>{" "}
          <span style={{ color:"var(--ac)", fontWeight:600 }}>{c.value}</span>
        </span>
      );
    });
    const actStr = form.actions.map((a, i) => {
      const aLabel = ruleActionsList.find(x => x.value === a.type)?.label || a.type;
      return (
        <span key={i}>
          {i > 0 && <span style={{ color:"var(--tx3)", margin:"0 6px", fontFamily:"var(--mono)" }}>+</span>}
          <span style={{ color:"var(--teal)", fontWeight:600 }}>{aLabel}</span>
          {a.value ? <span style={{ color:"var(--tx2)" }}> ({a.value})</span> : null}
        </span>
      );
    });
    const campCount = (form.scope.campaign_ids || []).length;
    return (
      <div style={{ background:"var(--s2)", border:"1px solid var(--b2)", borderRadius:8,
        padding:"10px 14px", fontSize:12, color:"var(--tx2)", marginBottom:20, lineHeight:1.7 }}>
        <div><span style={{ color:"var(--tx3)", fontFamily:"var(--mono)", marginRight:6 }}>IF</span>{condStr}
          <span style={{ color:"var(--tx3)", fontFamily:"var(--mono)", margin:"0 6px" }}>over</span>
          <span style={{ color:"var(--ac2)", fontWeight:600 }}>{periodLabel}</span>
        </div>
        <div><span style={{ color:"var(--tx3)", fontFamily:"var(--mono)", marginRight:6 }}>THEN</span>{actStr}</div>
        {showScope && (
          <div style={{ marginTop:2, fontSize:11, color:"var(--tx3)" }}>
            <span style={{ fontFamily:"var(--mono)", marginRight:6 }}>SCOPE</span>
            {entityType === "keyword" ? t("rules.keyword") : t("rules.productTarget")}
            {" · "}{form.scope.campaign_type ? ruleCampTypes.find(c=>c.value===form.scope.campaign_type)?.label : t("rules.allTypes")}
            {" · "}{campCount > 0 ? t("rules.campaignsSelected", { count: campCount }) : t("rules.allEntities")}
          </div>
        )}
      </div>
    );
  };

  // S1-1: apply template
  const applyTemplate = (tpl) => {
    setForm(f => ({
      ...f,
      name: tpl.name,
      dry_run: tpl.dry_run,
      conditions: tpl.conditions,
      actions: tpl.actions,
      scope: { ...f.scope, entity_type: tpl.entityType, period_days: tpl.periodDays },
    }));
    setCondOperators(tpl.conditions.slice(1).map(() => 'AND'));
    setStep(2);
  };

  // S1-2: handle preview
  const handlePreview = async () => {
    setPreviewData(null);
    setPreviewError(null);
    setPreviewLoading(true);
    setStep(4);
    try {
      if (editRule?.id) {
        const result = await post(`/rules/${editRule.id}/run`, { dry_run: true });
        setPreviewData(result);
      } else {
        const tempName = `__preview_${Date.now()}`;
        const created = await post('/rules', { ...form, name: tempName, dry_run: true, is_active: false });
        if (created?.id) {
          const result = await post(`/rules/${created.id}/run`, { dry_run: true });
          setPreviewData(result);
          await del(`/rules/${created.id}`);
        }
      }
    } catch (e) {
      setPreviewError('Preview failed — you can still save the rule directly.');
    } finally {
      setPreviewLoading(false);
    }
  };

  const goNext = () => {
    if (step === 1) {
      if (!form.name.trim()) { setNameErr(true); return; }
      setNameErr(false);
      setStep(2);
    } else if (step === 2) {
      if (!form.conditions.length) { setCondErr(true); return; }
      setCondErr(false);
      setStep(3);
    }
  };
  const goBack  = () => {
    if (step === 4) { setStep(3); setPreviewData(null); }
    else setStep(s => s - 1);
  };
  const goClose = () => { onClose(); setStep(1); setPreviewData(null); setPreviewLoading(false); setPreviewError(null); };

  // Stepper header
  const steps = [
    { n:1, label: t("rules.wizardStep1") },
    { n:2, label: t("rules.wizardStep2") },
    { n:3, label: t("rules.wizardStep3") },
    { n:4, label: t("rules.wizardStep4") },
  ];

  const filteredCamps = (campaigns || []).filter(c =>
    !campSearch || c.name.toLowerCase().includes(campSearch.toLowerCase())
  );

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.65)", zIndex:1000,
      display:"flex", alignItems:"center", justifyContent:"center", padding:"16px" }}>
      <div className="card" style={{ width:"100%", maxWidth:880, minHeight:520,
        maxHeight:"90vh", display:"flex", flexDirection:"column", overflow:"hidden" }}>

        {/* ── Modal header ── */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
          padding:"18px 28px 0", flexShrink:0 }}>
          <div style={{ fontFamily:"var(--disp)", fontSize:18, fontWeight:700 }}>
            {editRule ? t("rules.editRule") : t("rules.new")}
          </div>
          <button onClick={goClose} style={{ background:"none", border:"none", cursor:"pointer",
            color:"var(--tx3)", display:"flex", alignItems:"center", padding:4 }}>
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>

        {/* ── Step indicator ── */}
        <div style={{ display:"flex", alignItems:"center", padding:"14px 28px 0", flexShrink:0 }}>
          {steps.map((s, idx) => {
            const done    = step > s.n;
            const active  = step === s.n;
            return (
              <div key={s.n} style={{ display:"flex", alignItems:"center", flex: idx < steps.length-1 ? 1 : "none" }}>
                <div onClick={() => done && setStep(s.n)}
                  style={{ display:"flex", alignItems:"center", gap:7, cursor: done ? "pointer" : "default",
                    paddingBottom:12 }}>
                  <div style={{ width:22, height:22, borderRadius:"50%", display:"flex",
                    alignItems:"center", justifyContent:"center", fontSize:10, fontWeight:700,
                    background: (active||done) ? "var(--ac)" : "var(--s3)",
                    color: (active||done) ? "#fff" : "var(--tx3)",
                    flexShrink:0 }}>
                    {done ? <Check size={11} strokeWidth={2.5} /> : s.n}
                  </div>
                  <span style={{ fontSize:12, fontWeight: active ? 600 : 400,
                    color: active ? "var(--tx)" : done ? "var(--ac)" : "var(--tx3)",
                    whiteSpace:"nowrap" }}>
                    {s.label}
                  </span>
                </div>
                {idx < steps.length-1 && (
                  <div style={{ flex:1, height:1, background:"var(--b2)", margin:"0 12px", marginBottom:12 }} />
                )}
              </div>
            );
          })}
        </div>
        <div style={{ height:1, background:"var(--b1)", flexShrink:0 }} />

        {/* ── Step content ── */}
        <div style={{ flex:1, overflowY:"auto", padding:"24px 28px" }}>

          {/* ════ STEP 1: Basics ════ */}
          {step === 1 && (
            <div>
              {/* Template grid — only for new rules with empty name */}
              {!editRule?.id && !form.name && (
                <div style={{ marginBottom:20 }}>
                  <button onClick={() => setTemplatesOpen(o => !o)}
                    style={{ display:"flex", alignItems:"center", gap:6, background:"none", border:"none",
                      cursor:"pointer", padding:0, marginBottom: templatesOpen ? 10 : 0 }}>
                    <span style={{ fontSize:11, color:"var(--tx3)", textTransform:"uppercase",
                      letterSpacing:"0.06em", fontWeight:600 }}>
                      {t("rules.fromTemplate")}
                    </span>
                    <span style={{ fontSize:10, color:"var(--tx3)", transform: templatesOpen ? "rotate(180deg)" : "rotate(0deg)",
                      transition:"transform 150ms", display:"inline-block" }}>▼</span>
                  </button>
                  {templatesOpen && (
                    <>
                      <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8 }}>
                        {RULE_TEMPLATES.map(tpl => (
                          <button key={tpl.id} onClick={() => applyTemplate(tpl)}
                            style={{ background:"var(--s2)", border:"1px solid var(--b2)", borderRadius:8,
                              padding:"10px 12px", cursor:"pointer", textAlign:"left", transition:"border-color 150ms",
                              display:"flex", flexDirection:"column", gap:4 }}
                            onMouseEnter={e => e.currentTarget.style.borderColor = "var(--ac)"}
                            onMouseLeave={e => e.currentTarget.style.borderColor = "var(--b2)"}>
                            <span style={{ fontSize:16 }}>{tpl.icon}</span>
                            <span style={{ fontSize:12, fontWeight:600, color:"var(--tx)", lineHeight:1.3 }}>
                              {t(`rules.tpl_${tpl.id}`) || tpl.label}
                            </span>
                            <span style={{ fontSize:11, color:"var(--tx3)", lineHeight:1.4 }}>
                              {t(`rules.tpl_${tpl.id}_desc`) || tpl.description}
                            </span>
                          </button>
                        ))}
                      </div>
                      <div style={{ display:"flex", alignItems:"center", gap:10, margin:"14px 0 2px" }}>
                        <div style={{ flex:1, height:1, background:"var(--b2)" }} />
                        <span style={{ fontSize:11, color:"var(--tx3)" }}>{t("rules.buildFromScratch")}</span>
                        <div style={{ flex:1, height:1, background:"var(--b2)" }} />
                      </div>
                    </>
                  )}
                </div>
              )}

              <div style={{ marginBottom:14 }}>
                <div style={LABEL}>{t("rules.name")} *</div>
                <input value={form.name} onChange={e => { setForm(f => ({...f, name:e.target.value})); setNameErr(false); }}
                  placeholder={t("rules.namePlaceholder")} style={{ ...INP,
                    border: nameErr ? "1px solid var(--red)" : "1px solid var(--b2)" }} />
                {nameErr && <div style={{ fontSize:11, color:"var(--red)", marginTop:4 }}>{t("rules.alertName")}</div>}
              </div>

              <div style={{ marginBottom:16 }}>
                <div style={LABEL}>{t("rules.description")} <span style={{ textTransform:"none", fontFamily:"var(--ui)", letterSpacing:0 }}>({t("common.optional")})</span></div>
                <input value={form.description} onChange={e => setForm(f => ({...f, description:e.target.value}))}
                  placeholder={t("common.optional")} style={INP} />
              </div>

              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16, marginBottom:16 }}>
                <div>
                  <div style={LABEL}>{t("rules.entityType")}</div>
                  <div style={{ display:"flex", gap:6 }}>
                    {[
                      { value:"keyword",        label: t("rules.keyword") },
                      { value:"product_target", label: t("rules.productTarget") },
                    ].map(et => (
                      <button key={et.value}
                        className={`btn ${(form.scope?.entity_type || "keyword") === et.value ? "btn-primary" : "btn-ghost"}`}
                        style={{ fontSize:12, padding:"7px 12px", flex:1 }}
                        onClick={() => setForm(f => ({ ...f, scope: { ...f.scope, entity_type: et.value } }))}>
                        {et.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div style={LABEL}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {t("rules.periodLabel")}
                      <Tip text="How many days of historical data are used to evaluate rule conditions. Longer periods smooth out daily fluctuations but react more slowly.">
                        <Ic icon={HelpCircle} size={11} style={{ color: 'var(--tx3)', cursor: 'help' }} />
                      </Tip>
                    </span>
                  </div>
                  <select value={form.scope?.period_days || 14}
                    onChange={e => setForm(f => ({ ...f, scope: { ...f.scope, period_days: parseInt(e.target.value) } }))}
                    style={{ width:"100%", ...SEL_SM }}>
                    <option value={1}>{t("rules.yesterday")}</option>
                    <option value={7}>{t("rules.periodDays", { days: 7 })}</option>
                    <option value={14}>{t("rules.periodDays", { days: 14 })}</option>
                    <option value={30}>{t("rules.periodDays", { days: 30 })}</option>
                    <option value={60}>{t("rules.periodDays", { days: 60 })}</option>
                    <option value={90}>{t("rules.periodDays", { days: 90 })}</option>
                  </select>
                </div>
              </div>

              <div style={{ display:"flex", gap:24, padding:"14px 16px",
                background:"var(--s2)", borderRadius:8, border:"1px solid var(--b2)" }}>
                <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", fontSize:13 }}>
                  <input type="checkbox" checked={form.dry_run}
                    onChange={e => setForm(f => ({...f, dry_run:e.target.checked}))}
                    style={{ accentColor:"var(--ac)", width:14, height:14 }} />
                  <span style={{ color:form.dry_run ? "var(--amb)" : "var(--tx2)" }}>{t("rules.dryRun")}</span>
                </label>
                <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", fontSize:13 }}>
                  <input type="checkbox" checked={form.is_active}
                    onChange={e => setForm(f => ({...f, is_active:e.target.checked}))}
                    style={{ accentColor:"var(--ac)", width:14, height:14 }} />
                  <span>{t("rules.active")}</span>
                </label>
              </div>

              {/* Dayparting */}
              <div style={{ marginTop:16 }}>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                  <div style={{ ...LABEL, marginBottom:0 }}>{t("rules.dayparting")}</div>
                  <span style={{ fontSize:11, color:"var(--tx3)" }}>({t("rules.daypartingHint")})</span>
                </div>
                <div style={{ padding:"12px 14px", background:"var(--s2)", borderRadius:8, border:"1px solid var(--b2)" }}>
                  <div style={{ display:"flex", gap:4, marginBottom:10 }}>
                    {DP_DAYS.map(([lbl, val]) => {
                      const sel = form.scope?.dayparting?.days?.includes(val);
                      return (
                        <button key={val}
                          onClick={() => {
                            const curr = form.scope?.dayparting || { days:[], hour:null };
                            const days = curr.days || [];
                            const nd = days.includes(val) ? days.filter(d => d !== val) : [...days, val];
                            const ndp = (nd.length === 0 && curr.hour == null) ? null : { ...curr, days: nd };
                            setForm(f => ({ ...f, scope: { ...f.scope, dayparting: ndp } }));
                          }}
                          style={{ flex:1, padding:"5px 0", fontSize:11, fontWeight: sel ? 600 : 400,
                            background: sel ? "var(--ac)" : "var(--s3)",
                            color: sel ? "#fff" : "var(--tx3)",
                            border:`1px solid ${sel ? "var(--ac)" : "var(--b2)"}`,
                            borderRadius:6, cursor:"pointer" }}>
                          {lbl}
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <span style={{ fontSize:11, color:"var(--tx3)", whiteSpace:"nowrap" }}>{t("rules.runAtHour")}</span>
                    <select
                      value={form.scope?.dayparting?.hour ?? ""}
                      onChange={e => {
                        const hour = e.target.value === "" ? null : parseInt(e.target.value);
                        const curr = form.scope?.dayparting || { days:[], hour:null };
                        const ndp = ((curr.days?.length || 0) === 0 && hour == null) ? null : { ...curr, hour };
                        setForm(f => ({ ...f, scope: { ...f.scope, dayparting: ndp } }));
                      }}
                      style={{ ...SEL_SM, width:120 }}>
                      <option value="">{t("rules.anyHour")}</option>
                      {Array.from({ length:24 }, (_,h) => (
                        <option key={h} value={h}>{String(h).padStart(2,"0")}:00</option>
                      ))}
                    </select>
                    {form.scope?.dayparting && (() => {
                      const cron = dayparthingToCron(form.scope.dayparting);
                      return cron ? (
                        <span style={{ fontSize:11, color:"var(--tx3)", fontFamily:"var(--mono)" }}>
                          → <strong style={{ color:"var(--tx)" }}>{cron}</strong>
                        </span>
                      ) : null;
                    })()}
                    {form.scope?.dayparting && (
                      <button
                        onClick={() => setForm(f => ({ ...f, scope: { ...f.scope, dayparting: null } }))}
                        style={{ marginLeft:"auto", background:"none", border:"none", cursor:"pointer",
                          color:"var(--tx3)", fontSize:11, padding:"2px 6px" }}>
                        {t("rules.clear")}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ════ STEP 2: Conditions ════ */}
          {step === 2 && (
            <div>
              <RuleSummary showScope={false} />

              {condErr && (
                <div style={{ fontSize:12, color:"var(--red)", marginBottom:10 }}>
                  {t("rules.addAtLeastOne") || "Add at least one condition"}
                </div>
              )}

              {form.conditions.map((cond, i) => (
                <div key={i}>
                  {i > 0 && (
                    <div style={{ display:"flex", alignItems:"center", gap:8, margin:"4px 0" }}>
                      <div style={{ flex:1, height:1, background:"var(--b1)" }} />
                      <button
                        onClick={() => setCondOperators(ops => {
                          const next = [...ops];
                          next[i - 1] = next[i - 1] === 'AND' ? 'OR' : 'AND';
                          return next;
                        })}
                        style={{
                          background: (condOperators[i - 1] || 'AND') === 'OR' ? 'rgba(245,158,11,0.15)' : 'var(--s2)',
                          border: `1px solid ${(condOperators[i - 1] || 'AND') === 'OR' ? 'var(--amb)' : 'var(--b2)'}`,
                          color: (condOperators[i - 1] || 'AND') === 'OR' ? 'var(--amb)' : 'var(--tx3)',
                          borderRadius: 100,
                          padding: '2px 10px',
                          fontSize: 10,
                          fontFamily: 'var(--mono)',
                          cursor: 'pointer',
                          fontWeight: 600,
                          transition: 'all 150ms',
                        }}
                        title={(condOperators[i - 1] || 'AND') === 'AND' ? 'Click to switch to OR' : 'Click to switch to AND'}
                      >
                        {condOperators[i - 1] || 'AND'}
                      </button>
                      <div style={{ flex:1, height:1, background:"var(--b1)" }} />
                    </div>
                  )}
                  <div style={{ display:"flex", gap:8, marginBottom:6, alignItems:"center" }}>
                    <select value={cond.metric} onChange={e => updCond(i,"metric",e.target.value)}
                      style={{ flex:"1 1 0%", minWidth:0, ...SEL_SM }}>
                      {ruleMetrics.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                    </select>
                    <select value={cond.op} onChange={e => updCond(i,"op",e.target.value)}
                      style={{ width:76, flexShrink:0, ...SEL_SM, textAlign:"center" }}>
                      {RULE_OPS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <div style={{ display:"flex", alignItems:"center", gap:4, flex:"0 0 130px" }}>
                      <input type="number" value={cond.value} onChange={e => updCond(i,"value",e.target.value)}
                        style={{ width:"100%", ...INP_SM, boxSizing:"border-box" }} />
                      {METRIC_UNIT[cond.metric] && (
                        <span style={{ color:"var(--tx3)", fontSize:11, flexShrink:0, whiteSpace:"nowrap" }}>
                          {METRIC_UNIT[cond.metric]}
                        </span>
                      )}
                    </div>
                    <button onClick={() => remCond(i)} disabled={form.conditions.length === 1}
                      style={{ width:28, height:28, flexShrink:0, background:"none", border:"none",
                        color:"var(--red)", cursor:"pointer", opacity:form.conditions.length===1?0.3:1,
                        display:"flex", alignItems:"center", justifyContent:"center" }}>
                      <X size={13} strokeWidth={1.75} />
                    </button>
                  </div>
                </div>
              ))}
              <button onClick={() => { addCond(); setCondErr(false); }} className="btn btn-ghost"
                style={{ fontSize:12, padding:"5px 12px", marginTop:6 }}>
                + {t("rules.addCondition")}
              </button>
            </div>
          )}

          {/* ════ STEP 3: Actions + Scope ════ */}
          {step === 3 && (
            <div>
              <RuleSummary showScope={true} />

              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>

                {/* LEFT — Actions + Guardrails */}
                <div>
                  <div style={{ background:"var(--s2)", border:"1px solid var(--b2)",
                    borderRadius:10, padding:"14px 16px", marginBottom:12 }}>
                    <div style={{ ...LABEL, marginBottom:10 }}>{t("rules.actionsTitle")}</div>
                    {form.actions.map((act, i) => {
                      const curEntityType = form.scope?.entity_type || "keyword";
                      const filteredActions = ruleActionsList.filter(a =>
                        curEntityType === "product_target" ? a.et === "target" : a.et === "keyword"
                      );
                      const isBidAct = act.type === "adjust_bid_pct" || act.type === "set_bid" || act.type === "adjust_target_bid_pct";
                      const isNegKw  = act.type === "add_negative_keyword";
                      return (
                        <div key={i} style={{ marginBottom:8 }}>
                          <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                            <select value={act.type} onChange={e => updAct(i,"type",e.target.value)}
                              style={{ flex:1, ...SEL_SM }}>
                              {filteredActions.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                            </select>
                            <button onClick={() => remAct(i)} disabled={form.actions.length === 1}
                              style={{ width:28, height:28, background:"none", border:"none", color:"var(--red)",
                                cursor:"pointer", opacity:form.actions.length===1?0.3:1,
                                display:"flex", alignItems:"center", justifyContent:"center" }}>
                              <X size={13} strokeWidth={1.75} />
                            </button>
                          </div>
                          {isBidAct && (
                            <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:6 }}>
                              <input type="number" value={act.value}
                                onChange={e => updAct(i,"value",e.target.value)}
                                placeholder={act.type === "set_bid" ? "e.g. 0.50" : "e.g. -20"}
                                style={{ flex:1, ...INP_SM }} />
                              <span style={{ fontSize:12, color:"var(--tx3)", width:20 }}>
                                {act.type === "set_bid" ? "€" : "%"}
                              </span>
                            </div>
                          )}
                          {isNegKw && (
                            <select value={act.value || "exact"} onChange={e => updAct(i,"value",e.target.value)}
                              style={{ width:"100%", marginTop:6, ...SEL_SM }}>
                              <option value="exact">{t("rules.negExact")}</option>
                              <option value="phrase">{t("rules.negPhrase")}</option>
                              <option value="both">{t("rules.negBoth")}</option>
                            </select>
                          )}
                        </div>
                      );
                    })}
                    <button onClick={addAct} className="btn btn-ghost"
                      style={{ fontSize:12, padding:"5px 12px", marginTop:2 }}>
                      + {t("rules.addAction")}
                    </button>
                  </div>

                  {/* Bid guardrails */}
                  <div style={{ background:"var(--s2)", border:"1px solid var(--b2)",
                    borderRadius:10, padding:"14px 16px" }}>
                    <div style={{ ...LABEL, marginBottom:4 }}>{t("rules.safetyTitle") || t("rules.safety")}</div>
                    <div style={{ fontSize:11, color:"var(--tx3)", marginBottom:8 }}>
                      {t("rules.safetyHint") || "leave empty — no limits"}
                    </div>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                      <div>
                        <div style={{ fontSize:11, color:"var(--tx3)", marginBottom:3 }}>{t("rules.minBid")}</div>
                        <input type="number" value={form.safety.min_bid || ""}
                          onChange={e => setForm(f => ({...f, safety:{...f.safety, min_bid:e.target.value}}))}
                          placeholder="0.02" style={{ ...INP_SM }} />
                      </div>
                      <div>
                        <div style={{ fontSize:11, color:"var(--tx3)", marginBottom:3 }}>{t("rules.maxBid")}</div>
                        <input type="number" value={form.safety.max_bid || ""}
                          onChange={e => setForm(f => ({...f, safety:{...f.safety, max_bid:e.target.value}}))}
                          placeholder="50" style={{ ...INP_SM }} />
                      </div>
                    </div>
                  </div>
                </div>

                {/* RIGHT — Scope */}
                <div style={{ background:"var(--s2)", border:"1px solid var(--b2)",
                  borderRadius:10, padding:"14px 16px" }}>
                  <div style={{ ...LABEL, marginBottom:10 }}>{t("rules.scopeTitle")}</div>

                  <div style={{ marginBottom:10 }}>
                    <div style={{ fontSize:11, color:"var(--tx3)", marginBottom:3 }}>{t("rules.campaignType")}</div>
                    <select value={form.scope.campaign_type || ""}
                      onChange={e => setForm(f => ({ ...f, scope:{ ...f.scope, campaign_type:e.target.value } }))}
                      style={{ width:"100%", ...SEL_SM }}>
                      {ruleCampTypes.map(ct => <option key={ct.value} value={ct.value}>{ct.label}</option>)}
                    </select>
                  </div>

                  <div style={{ marginBottom:10 }}>
                    <div style={{ fontSize:11, color:"var(--tx3)", marginBottom:3 }}>{t("rules.matchTypes")}</div>
                    <div style={{ display:"flex", gap:5 }}>
                      {RULE_MATCH_TYPES.map(mt => (
                        <button key={mt.value} onClick={() => toggleMatchType(mt.value)}
                          className={`btn ${(form.scope.match_types||[]).includes(mt.value)?"btn-primary":"btn-ghost"}`}
                          style={{ fontSize:11, padding:"5px 10px", flex:1 }}>{mt.label}</button>
                      ))}
                    </div>
                  </div>

                  <div style={{ marginBottom:10 }}>
                    <div style={{ fontSize:11, color:"var(--tx3)", marginBottom:3 }}>{t("rules.campaignNameFilter")}</div>
                    <input
                      value={form.scope?.campaign_name_contains || ""}
                      onChange={e => setForm(f => ({ ...f, scope: { ...f.scope, campaign_name_contains: e.target.value } }))}
                      placeholder={t("rules.campaignNamePlaceholder")}
                      style={{ ...INP_SM }} />
                  </div>

                  {(form.scope?.entity_type || "keyword") === "product_target" && (
                    <div style={{ marginBottom:10 }}>
                      <div style={{ fontSize:11, color:"var(--tx3)", marginBottom:3 }}>{t("rules.targetingType")}</div>
                      <select value={form.scope?.targeting_type || ""}
                        onChange={e => setForm(f => ({ ...f, scope: { ...f.scope, targeting_type: e.target.value } }))}
                        style={{ width:"100%", ...SEL_SM }}>
                        <option value="">{t("rules.targetingAll")}</option>
                        <option value="product">{t("rules.targetingProduct")}</option>
                        <option value="views">{t("rules.targetingViews")}</option>
                        <option value="audience">{t("rules.targetingAudience")}</option>
                        <option value="auto">{t("rules.targetingAuto")}</option>
                      </select>
                    </div>
                  )}

                  {/* Searchable campaign picker */}
                  <div>
                    <div style={{ fontSize:11, color:"var(--tx3)", marginBottom:3 }}>
                      {t("rules.campaigns")}
                      {(form.scope.campaign_ids||[]).length > 0 && (
                        <span style={{ marginLeft:6, color:"var(--ac2)" }}>
                          ({t("rules.campaignsSelected", { count: (form.scope.campaign_ids||[]).length })})
                        </span>
                      )}
                    </div>
                    <div style={{ position:"relative", marginBottom:6 }}>
                      <Search size={12} strokeWidth={1.75} style={{ position:"absolute", left:8,
                        top:"50%", transform:"translateY(-50%)", color:"var(--tx3)", pointerEvents:"none" }} />
                      <input
                        value={campSearch}
                        onChange={e => setCampSearch(e.target.value)}
                        placeholder={t("campaigns.search")}
                        style={{ ...INP_SM, paddingLeft:26 }} />
                    </div>
                    <div style={{ maxHeight:160, overflowY:"auto", border:"1px solid var(--b2)",
                      borderRadius:6, padding:4, background:"var(--s1)" }}>
                      {!campaigns.length
                        ? <div style={{ fontSize:12, color:"var(--tx3)", padding:"6px 4px" }}>{t("common.loading")}</div>
                        : filteredCamps.map(c => (
                          <label key={c.id} style={{ display:"flex", gap:7, alignItems:"center",
                            padding:"4px 6px", cursor:"pointer", borderRadius:4,
                            fontSize:12, color:(form.scope.campaign_ids||[]).includes(c.id)?"var(--ac2)":"var(--tx2)" }}>
                            <input type="checkbox"
                              checked={(form.scope.campaign_ids||[]).includes(c.id)}
                              onChange={() => toggleCampaign(c.id)}
                              style={{ accentColor:"var(--ac)", flexShrink:0 }} />
                            <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1 }}>{c.name}</span>
                            <span className="badge bg-bl" style={{ fontSize:9, flexShrink:0 }}>
                              {c.campaign_type?.replace("sponsored","").toUpperCase().slice(0,2)}
                            </span>
                          </label>
                        ))
                      }
                      {campaigns.length > 0 && filteredCamps.length === 0 && (
                        <div style={{ fontSize:12, color:"var(--tx3)", padding:"6px 4px" }}>{t("common.noData")}</div>
                      )}
                    </div>
                  </div>

                  {adGroups.length > 0 && (
                    <div style={{ marginTop:10 }}>
                      <div style={{ fontSize:11, color:"var(--tx3)", marginBottom:3 }}>
                        {t("rules.adGroups")} ({t("rules.adGroupsSelected", { count: (form.scope.ad_group_ids||[]).length })})
                      </div>
                      <div style={{ maxHeight:100, overflowY:"auto", border:"1px solid var(--b2)",
                        borderRadius:6, padding:4, background:"var(--s1)" }}>
                        {adGroups.map(ag => (
                          <label key={ag.id} style={{ display:"flex", gap:7, alignItems:"center",
                            padding:"4px 6px", cursor:"pointer", fontSize:12,
                            color:(form.scope.ad_group_ids||[]).includes(ag.id)?"var(--ac2)":"var(--tx2)" }}>
                            <input type="checkbox"
                              checked={(form.scope.ad_group_ids||[]).includes(ag.id)}
                              onChange={() => toggleAdGroup(ag.id)}
                              style={{ accentColor:"var(--ac)", flexShrink:0 }} />
                            {ag.name}
                            <span style={{ fontSize:10, color:"var(--tx3)" }}>• {ag.campaign_name}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ════ STEP 4: Preview ════ */}
          {step === 4 && (
            <div>
              <div style={{ marginBottom:16, fontSize:13, color:"var(--tx2)" }}>
                {t("rules.previewDesc")}
              </div>

              {previewLoading && (
                <div style={{ display:"flex", alignItems:"center", gap:10, padding:"32px 0",
                  justifyContent:"center", color:"var(--tx3)", fontSize:13 }}>
                  <div style={{ width:18, height:18, border:"2px solid var(--ac)",
                    borderTopColor:"transparent", borderRadius:"50%",
                    animation:"spin 0.7s linear infinite" }} />
                  {t("rules.previewRunning")}
                </div>
              )}

              {previewError && (
                <div style={{ background:"rgba(239,68,68,.08)", border:"1px solid var(--red)",
                  borderRadius:8, padding:"12px 16px", fontSize:13, color:"var(--red)", marginBottom:16 }}>
                  {previewError}
                </div>
              )}

              {previewData && !previewLoading && (
                <div>
                  {/* Summary stats */}
                  <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:12, marginBottom:20 }}>
                    {[
                      { label: t("rules.entitiesMatched"), value: previewData.matched_count ?? previewData.actions_taken ?? "—" },
                      { label: t("rules.actionsPlanned"),  value: previewData.actions_planned ?? previewData.actions_taken ?? "—" },
                      { label: t("rules.previewModeLabel"), value: previewData.dry_run ? t("rules.modeDryRun") : t("rules.modeLive") },
                    ].map(stat => (
                      <div key={stat.label} style={{ background:"var(--s2)", border:"1px solid var(--b2)",
                        borderRadius:8, padding:"12px 16px", textAlign:"center" }}>
                        <div style={{ fontSize:22, fontWeight:700, fontFamily:"var(--disp)",
                          color:"var(--ac)" }}>{stat.value}</div>
                        <div style={{ fontSize:11, color:"var(--tx3)", marginTop:3 }}>{stat.label}</div>
                      </div>
                    ))}
                  </div>

                  {/* Sample matches table */}
                  {Array.isArray(previewData.sample_matches) && previewData.sample_matches.length > 0 && (
                    <div>
                      <div style={{ fontSize:11, color:"var(--tx3)", marginBottom:8, textTransform:"uppercase",
                        letterSpacing:"0.06em", fontWeight:600 }}>
                        {t("rules.sampleMatches")}
                      </div>
                      <div style={{ border:"1px solid var(--b2)", borderRadius:8, overflow:"hidden" }}>
                        <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                          <thead>
                            <tr style={{ background:"var(--s2)" }}>
                              <th style={{ textAlign:"left", padding:"8px 12px", color:"var(--tx3)",
                                fontWeight:600, fontSize:11 }}>{t("rules.colKeywordTarget")}</th>
                              <th style={{ textAlign:"right", padding:"8px 12px", color:"var(--tx3)",
                                fontWeight:600, fontSize:11 }}>{t("rules.colAction")}</th>
                              <th style={{ textAlign:"right", padding:"8px 12px", color:"var(--tx3)",
                                fontWeight:600, fontSize:11 }}>{t("rules.colValue")}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {previewData.sample_matches.slice(0, 10).map((m, i) => (
                              <tr key={i} style={{ borderTop:"1px solid var(--b1)" }}>
                                <td style={{ padding:"7px 12px", color:"var(--tx2)", maxWidth:260,
                                  overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                                  {m.keyword_text || m.target_text || m.entity_id}
                                </td>
                                <td style={{ padding:"7px 12px", textAlign:"right", color:"var(--tx3)" }}>
                                  {m.action_type?.replace(/_/g," ")}
                                </td>
                                <td style={{ padding:"7px 12px", textAlign:"right",
                                  color: m.action_value ? "var(--ac2)" : "var(--tx3)" }}>
                                  {m.action_value ?? "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* No matches */}
                  {(previewData.matched_count === 0 || previewData.actions_taken === 0) &&
                    (!previewData.sample_matches || previewData.sample_matches.length === 0) && (
                    <div style={{ padding:"20px", textAlign:"center", color:"var(--tx3)", fontSize:13,
                      background:"var(--s2)", borderRadius:8, border:"1px solid var(--b2)" }}>
                      {t("rules.noMatchDesc")}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div style={{ display:"flex", alignItems:"center", padding:"14px 28px",
          borderTop:"1px solid var(--b1)", flexShrink:0, background:"var(--s1)", gap:8 }}>
          {step > 1
            ? <button onClick={goBack} className="btn btn-ghost" style={{ fontSize:12, padding:"7px 16px" }}>
                <ChevronLeft size={13} strokeWidth={1.75} /> {t("common.back")}
              </button>
            : <button onClick={goClose} className="btn btn-ghost" style={{ fontSize:12, padding:"7px 16px" }}>
                {t("common.cancel")}
              </button>
          }
          <div style={{ flex:1 }} />
          {step < 3 ? (
            <button onClick={goNext} className="btn btn-primary" style={{ fontSize:12, padding:"7px 20px" }}>
              {t("common.next")} <ChevronRight size={13} strokeWidth={1.75} />
            </button>
          ) : step === 3 ? (
            <>
              <button onClick={goClose} className="btn btn-ghost" style={{ fontSize:12, padding:"7px 16px" }}>
                {t("common.cancel")}
              </button>
              <button onClick={handlePreview} className="btn btn-primary"
                style={{ fontSize:12, padding:"7px 20px" }}
                disabled={!form.name || !form.conditions.length || !form.actions.length}>
                Предпросмотр <ChevronRight size={13} strokeWidth={1.75} />
              </button>
            </>
          ) : (
            <>
              <button onClick={goClose} className="btn btn-ghost" style={{ fontSize:12, padding:"7px 16px" }}>
                {t("common.cancel")}
              </button>
              <button onClick={onSave} className="btn btn-primary"
                style={{ fontSize:12, padding:"7px 20px" }}
                disabled={!form.name || !form.conditions.length || !form.actions.length}>
                {t("rules.saveRule")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── Rules Page ───────────────────────────────────────────────────────────────
const RulesPage = ({ workspaceId }) => {
  const { t } = useI18n();
  const ruleMetrics     = RULE_METRICS(t);
  const ruleActionsList = RULE_ACTIONS_LIST(t);
  const ruleCampTypes   = RULE_CAMP_TYPES(t);
  const [showForm,   setShowForm]   = useState(false);
  const [editRule,   setEditRule]   = useState(null);
  const [form,       setForm]       = useState(EMPTY_RULE_FORM);
  const [condOperators, setCondOperators] = useState([]);
  const [adGroups,   setAdGroups]   = useState([]);
  const [runningId,  setRunningId]  = useState(null);
  const [runResult,  setRunResult]  = useState({});
  const [showResult, setShowResult] = useState(null);
  const [toast,      setToast]      = useState(null);
  const [historyRule, setHistoryRule] = useState(null);

  const [page, setPage] = useState(1);

  const { data: rulesData, loading, reload } = useAsync(
    () => workspaceId ? get("/rules", { page, limit: 25 }) : Promise.resolve({ data: [], pagination: {} }),
    [workspaceId, page]
  );
  const { data: campaigns } = useAsync(
    () => workspaceId ? get("/rules/campaigns") : Promise.resolve([]),
    [workspaceId]
  );
  const rules      = rulesData?.data       || [];
  const pagination = rulesData?.pagination || {};

  // Load ad groups when scope campaigns change
  useEffect(() => {
    if (!form.scope?.campaign_ids?.length) { setAdGroups([]); return; }
    Promise.all(form.scope.campaign_ids.map(cid => get("/rules/ad-groups", { campaignId: cid })))
      .then(results => setAdGroups(results.flat())).catch(() => {});
  }, [JSON.stringify(form.scope?.campaign_ids)]);

  const openNew = () => { setForm(EMPTY_RULE_FORM); setEditRule(null); setShowForm(true); setCondOperators([]); };
  const openEdit = (rule) => {
    const parse = (v, fb) => { if (!v) return fb; if (typeof v === "string") { try { return JSON.parse(v); } catch { return fb; } } return v; };
    const parsedScope = parse(rule.scope, EMPTY_RULE_FORM.scope);
    // Restore dayparting from rule.schedule if scope doesn't have it
    const dayparting = parsedScope.dayparting || cronToDayparting(rule.schedule);
    setForm({
      name:        rule.name,
      description: rule.description || "",
      dry_run:     !!rule.dry_run,
      is_active:   rule.is_active !== false,
      conditions:  parse(rule.conditions, EMPTY_RULE_FORM.conditions),
      actions:     parse(rule.actions,    EMPTY_RULE_FORM.actions),
      scope:       { ...parsedScope, dayparting },
      safety:      parse(rule.safety,     EMPTY_RULE_FORM.safety),
    });
    setEditRule(rule); setShowForm(true);
    const parsedConds = parse(rule.conditions, EMPTY_RULE_FORM.conditions);
    setCondOperators(parsedConds.slice(1).map(() => 'AND'));
  };

  const saveRule = async () => {
    if (!form.name) return alert(t("rules.alertName"));
    try {
      const cronStr = dayparthingToCron(form.scope?.dayparting);
      const payload = {
        ...form,
        conditions: form.conditions.map((c, i) => ({
          ...c,
          ...(i < form.conditions.length - 1 ? { nextOperator: condOperators[i] || 'AND' } : {}),
        })),
        ...(cronStr ? { schedule: cronStr, schedule_type: "cron" } : { schedule: null, schedule_type: "hourly" }),
      };
      editRule ? await patch(`/rules/${editRule.id}`, payload) : await post("/rules", payload);
      setShowForm(false); reload();
    } catch (e) { alert(t("common.error") + e.message); }
  };

  const deleteRule = async (id) => {
    if (!confirm(t("rules.confirmDelete"))) return;
    await del(`/rules/${id}`); reload();
  };

  const toggleActive = async (rule) => {
    await patch(`/rules/${rule.id}`, { is_active: !rule.is_active }); reload();
  };

  const runRule = async (id, dryRun) => {
    setRunningId(id);
    try {
      const result = await post(`/rules/${id}/run`, { dry_run: dryRun });
      setRunResult(r => ({ ...r, [id]: result }));
      setShowResult(id);
      reload();
    } catch (e) { alert(t("common.error") + e.message); }
    finally { setRunningId(null); }
  };

  // Condition helpers
  const updCond = (i, f, v) => setForm(fm => { const c = [...fm.conditions]; c[i] = { ...c[i], [f]: v }; return { ...fm, conditions: c }; });
  const remCond = (i) => {
    setForm(f => ({ ...f, conditions: f.conditions.filter((_,idx) => idx !== i) }));
    setCondOperators(ops => ops.filter((_,idx) => idx !== (i > 0 ? i - 1 : 0)));
  };
  const addCond = () => {
    setForm(f => ({ ...f, conditions: [...f.conditions, { metric:"clicks", op:"gte", value:"10" }] }));
    setCondOperators(ops => [...ops, 'AND']);
  };

  // Action helpers
  const updAct = (i, f, v) => setForm(fm => { const a = [...fm.actions]; a[i] = { ...a[i], [f]: v }; return { ...fm, actions: a }; });
  const remAct = (i)       => setForm(f => ({ ...f, actions: f.actions.filter((_,idx) => idx !== i) }));
  const addAct = ()        => setForm(f => ({ ...f, actions: [...f.actions, { type: (f.scope?.entity_type || "keyword") === "keyword" ? "pause_keyword" : "pause_target", value:"" }] }));

  // Scope toggle helpers
  const toggleCampaign  = id => setForm(f => { const ids = f.scope.campaign_ids||[]; return { ...f, scope: { ...f.scope, campaign_ids: ids.includes(id) ? ids.filter(x=>x!==id) : [...ids,id] } }; });
  const toggleAdGroup   = id => setForm(f => { const ids = f.scope.ad_group_ids||[]; return { ...f, scope: { ...f.scope, ad_group_ids: ids.includes(id) ? ids.filter(x=>x!==id) : [...ids,id] } }; });
  const toggleMatchType = mt => setForm(f => { const mts = f.scope.match_types||[]; return { ...f, scope: { ...f.scope, match_types: mts.includes(mt) ? mts.filter(x=>x!==mt) : [...mts,mt] } }; });

  const LABEL = { fontSize:11, color:"var(--tx3)", marginBottom:4, fontFamily:"var(--mono)", textTransform:"uppercase", letterSpacing:".05em" };

  return (
    <div className="fade">
      {/* Toast */}
      {toast && (
        <div style={{ position:"fixed", top:20, right:20, zIndex:9999, background:"var(--grn)",
          color:"#fff", padding:"10px 18px", borderRadius:8, fontSize:13, fontWeight:600 }}>
          {toast}
        </div>
      )}

      {/* ── Header ── */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:22 }}>
        <h1 style={{ fontFamily:"var(--disp)", fontSize:22, fontWeight:700 }}>{t("rules.title")}</h1>
        <button onClick={openNew} className="btn btn-primary" style={{ fontSize:12, padding:"7px 16px" }}>
          + {t("rules.new")}
        </button>
      </div>

      {/* ── Rule Form Modal (3-step wizard) ── */}
      {showForm && createPortal(
        <RuleWizardModal
          form={form} setForm={setForm}
          editRule={editRule}
          campaigns={campaigns || []}
          adGroups={adGroups}
          ruleMetrics={ruleMetrics}
          ruleActionsList={ruleActionsList}
          ruleCampTypes={ruleCampTypes}
          condOperators={condOperators} setCondOperators={setCondOperators}
          updCond={updCond} remCond={remCond} addCond={addCond}
          updAct={updAct}   remAct={remAct}   addAct={addAct}
          toggleCampaign={toggleCampaign}
          toggleAdGroup={toggleAdGroup}
          toggleMatchType={toggleMatchType}
          onSave={saveRule}
          onClose={() => setShowForm(false)}
        />,
      document.body
      )}

      {/* ── Rule History Modal ── */}
      {historyRule && <RuleHistoryModal rule={historyRule} onClose={() => setHistoryRule(null)} />}

      {/* ── Run Result Modal ── */}
      {showResult && runResult[showResult] && createPortal(
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.65)", zIndex:1000,
          display:"flex", alignItems:"flex-start", justifyContent:"center", overflowY:"auto", padding:"24px 16px" }}>
          <div className="card" style={{ width:"100%", maxWidth:700,
            padding:"24px 28px", margin:"0 auto", flexShrink:0 }}>
            {(() => {
              const r = runResult[showResult];
              return (
                <>
                  <div style={{ display:"flex", justifyContent:"space-between", marginBottom:16 }}>
                    <div>
                      <div style={{ fontFamily:"var(--disp)", fontSize:16, fontWeight:700 }}>
                        {r.dry_run ? t("rules.simulation") : t("rules.runResult")}
                      </div>
                      <div style={{ fontSize:12, color:"var(--tx3)", marginTop:4 }}>
                        {r.period?.start} – {r.period?.end}
                        {r.period?.days ? ` · ${r.period.days === 1 ? t("rules.yesterday") : t("rules.periodDays", { days: r.period.days })}` : ""}
                        {r.entity_counts
                          ? ` · ${r.entity_counts.keywords || 0} kw + ${r.entity_counts.targets || 0} tgt`
                          : ` · ${r.total_evaluated} ${t("rules.evaluated").toLowerCase()}`}
                      </div>
                    </div>
                    <button onClick={() => setShowResult(null)} className="btn btn-ghost" style={{ fontSize:12 }}><X size={13} strokeWidth={1.75} /></button>
                  </div>

                  <div style={{ display:"flex", gap:12, marginBottom:16 }}>
                    {[
                      { label:t("rules.evaluated"), val:r.total_evaluated, color:"var(--tx2)" },
                      { label:t("rules.matched"),   val:r.matched_count,   color:"var(--amb)" },
                      { label:r.dry_run ? t("rules.willChange") : t("rules.changed"), val:r.applied_count, color:"var(--grn)" },
                    ].map(s => (
                      <div key={s.label} className="card" style={{ flex:1, padding:"12px 14px",
                        background:"var(--s2)", textAlign:"center" }}>
                        <div style={{ fontSize:24, fontFamily:"var(--mono)", fontWeight:600, color:s.color }}>{s.val}</div>
                        <div style={{ fontSize:11, color:"var(--tx3)", marginTop:2 }}>{s.label}</div>
                      </div>
                    ))}
                  </div>

                  {r.applied?.length > 0 ? (
                    <div>
                      <div style={LABEL}>{r.dry_run ? t("rules.willChange") : t("rules.changed")}</div>
                      <div style={{ maxHeight:280, overflowY:"auto" }}>
                        {r.applied.map((a, i) => {
                          const entityLabel = a.keyword_text || (a.expression
                            ? (typeof a.expression === "object"
                                ? (a.expression[0]?.value || JSON.stringify(a.expression))
                                : a.expression)
                            : a.entity_id);
                          const isTarget = !a.keyword_text;
                          const badgeCls = ["pause_keyword","pause_target"].includes(a.action) ? "bg-amb"
                            : ["enable_keyword","enable_target"].includes(a.action) ? "bg-grn" : "bg-bl";
                          const actionLabel =
                            a.action === "pause_keyword"         ? "PAUSE"
                            : a.action === "enable_keyword"      ? "ENABLE"
                            : a.action === "pause_target"        ? "PAUSE TGT"
                            : a.action === "enable_target"       ? "ENABLE TGT"
                            : a.action === "adjust_bid_pct"      ? `BID ${a.change_pct}`
                            : a.action === "adjust_target_bid_pct" ? `TGT ${a.change_pct}`
                            : a.action === "add_negative_keyword"  ? `NEG-${(a.match_type||"exact").toUpperCase()}`
                            : a.action === "add_negative_target"   ? "NEG TGT"
                            : `BID→${a.new_bid}€`;
                          return (
                            <div key={i} style={{ padding:"8px 12px", borderBottom:"1px solid var(--b1)",
                              display:"flex", gap:10, alignItems:"center", fontSize:12 }}>
                              <span style={{ fontFamily:"var(--mono)", color: isTarget ? "var(--amb)" : "var(--ac2)",
                                minWidth:120, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                                {entityLabel}
                              </span>
                              <span className={`badge ${badgeCls}`} style={{ fontSize:10 }}>{actionLabel}</span>
                              <span style={{ color:"var(--tx3)", fontSize:11, marginLeft:"auto" }}>
                                {a.campaign_name}
                              </span>
                              {a.metrics && (
                                <span style={{ fontSize:10, color:"var(--tx3)" }}>
                                  {a.metrics.clicks}cl · {a.metrics.orders}ord · {a.metrics.acos ? parseFloat(a.metrics.acos).toFixed(1)+"%" : "—"}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <div style={{ padding:24, textAlign:"center", color:"var(--tx3)", fontSize:13 }}>
                      {t("rules.noMatches")}
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </div>,
      document.body
      )}

      {/* ── Rules List ── */}
      {loading ? (
        <div style={{ color:"var(--tx3)", padding:20 }}>{t("common.loading")}</div>
      ) : rules.length === 0 ? (
        <div className="card" style={{ padding:"48px 32px", textAlign:"center" }}>
          <div style={{ marginBottom:10 }}><Workflow size={32} strokeWidth={1.5} color="var(--tx3)" /></div>
          <div style={{ fontSize:14, color:"var(--tx3)" }}>{t("rules.noRules")}</div>
          <button onClick={openNew} className="btn btn-primary"
            style={{ marginTop:14, fontSize:12, padding:"8px 20px" }}>
            + {t("rules.new")}
          </button>
        </div>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          {rules.map(rule => {
            const parse = v => { if (!v) return []; if (typeof v === "string") { try { return JSON.parse(v); } catch { return []; } } return v; };
            const cond  = parse(rule.conditions);
            const acts  = parse(rule.actions);
            const scope = parse(rule.scope) || {};
            const last  = rule.last_run_result
              ? (typeof rule.last_run_result === "string" ? JSON.parse(rule.last_run_result) : rule.last_run_result)
              : null;
            const isRunning = runningId === rule.id;

            return (
              <div key={rule.id} className="card fade" style={{
                padding:"16px 20px", opacity:rule.is_active?1:0.55,
                borderLeft:`3px solid ${rule.is_active?"var(--ac)":"var(--b2)"}`,
              }}>
                <div style={{ display:"flex", gap:12, alignItems:"flex-start" }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    {/* Title row */}
                    <div style={{ display:"flex", gap:8, alignItems:"center", marginBottom:6, flexWrap:"wrap" }}>
                      <span style={{ fontSize:14, fontWeight:600 }}>{rule.name}</span>
                      {rule.dry_run && (
                        <Tip text="Simulation mode — the rule evaluates conditions and logs matches but makes no actual changes to bids or statuses.">
                          <span className="badge bg-amb" style={{ fontSize:10 }}>SIM</span>
                        </Tip>
                      )}
                      <span className={`badge ${rule.is_active?"bg-grn":"bg-red"}`} style={{ fontSize:10 }}>
                        {rule.is_active ? t("rules.active") : t("rules.inactive")}
                      </span>
                      <span className="badge bg-bl" style={{ fontSize:9 }}>
                        {scope.entity_type === "product_target" ? t("rules.productTarget") : t("rules.keyword")}
                      </span>
                      <span className="badge" style={{ fontSize:9, background:"var(--s3)", color:"var(--tx2)" }}>
                        {scope.period_days === 1 ? t("rules.yesterday") : t("rules.periodDays", { days: scope.period_days || 14 })}
                      </span>
                      {last && (
                        <span style={{ fontSize:11, color:"var(--tx3)" }}>
                          {t("rules.lastRun")}: {new Date(rule.last_run_at).toLocaleString(undefined,{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})}
                          · {last.matched_count} {t("rules.matched")}
                          · {last.applied_count} {t("rules.applied")}
                          {last.dry_run?" (sim)":""}
                        </span>
                      )}
                      {rule.schedule && rule.schedule_type === "cron" && (() => {
                        const dp = cronToDayparting(rule.schedule);
                        if (!dp) return null;
                        const DAY_SHORT = ['Su','Mo','Tu','We','Th','Fr','Sa'];
                        const dayStr = dp.days && dp.days.length > 0 && dp.days.length < 7
                          ? dp.days.sort((a,b) => { const ord = [1,2,3,4,5,6,0]; return ord.indexOf(a) - ord.indexOf(b); }).map(d => DAY_SHORT[d]).join(',')
                          : null;
                        const hourStr = dp.hour != null ? `${String(dp.hour).padStart(2,'0')}:00` : null;
                        const label = [dayStr, hourStr].filter(Boolean).join(' · ');
                        return label ? (
                          <span className="badge" style={{ fontSize:9, background:"rgba(20,184,166,.12)", color:"var(--teal)", border:"1px solid rgba(20,184,166,.3)" }}>
                            ⏰ {label}
                          </span>
                        ) : null;
                      })()}
                    </div>

                    {/* Condition badges */}
                    <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginBottom:6 }}>
                      {cond.map((c, i) => (
                        <span key={i} style={{ fontSize:11, padding:"3px 8px",
                          background:"rgba(99,102,241,.12)", border:"1px solid rgba(99,102,241,.25)",
                          borderRadius:20, color:"var(--ac2)", fontFamily:"var(--mono)" }}>
                          {i > 0 && <span style={{ color:"var(--tx3)", marginRight:4 }}>AND</span>}
                          {ruleMetrics.find(m=>m.value===c.metric)?.label}
                          {" "}{RULE_OPS.find(o=>o.value===c.op)?.label}
                          {" "}{c.value}
                        </span>
                      ))}
                      {acts.length > 0 && <span style={{ fontSize:11, color:"var(--tx3)", alignSelf:"center" }}>→</span>}
                      {acts.map((a, i) => (
                        <span key={i} style={{ fontSize:11, padding:"3px 8px",
                          background:"rgba(34,197,94,.1)", border:"1px solid rgba(34,197,94,.25)",
                          borderRadius:20, color:"var(--grn)" }}>
                          {ruleActionsList.find(al=>al.value===a.type)?.label}
                          {a.value ? ` ${a.value}${a.type==="adjust_bid_pct"?"%":"€"}` : ""}
                        </span>
                      ))}
                    </div>

                    {/* Scope summary */}
                    <div style={{ fontSize:11, color:"var(--tx3)" }}>
                      {(scope.campaign_ids?.length) ? t("rules.campaigns") + `: ${scope.campaign_ids.length}` : t("rules.allEntities")}
                      {scope.campaign_type ? ` · ${scope.campaign_type.replace("sponsored","").toUpperCase()}` : ""}
                      {scope.match_types?.length ? ` · ${scope.match_types.join("/")}` : ""}
                      {scope.ad_group_ids?.length ? ` · ${t("rules.adGroups")}: ${scope.ad_group_ids.length}` : ""}
                      {scope.campaign_name_contains ? ` · "${scope.campaign_name_contains}"` : ""}
                      {scope.targeting_type ? ` · ${scope.targeting_type}` : ""}
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div style={{ display:"flex", gap:6, flexShrink:0, flexWrap:"wrap", justifyContent:"flex-end" }}>
                    <button onClick={() => runRule(rule.id, true)} disabled={isRunning}
                      className="btn btn-ghost" style={{ fontSize:11, padding:"5px 10px" }}>
                      {isRunning ? "…" : <><Ic icon={Eye} size={12} /> {t("rules.preview")}</>}
                    </button>
                    <button onClick={() => runRule(rule.id, false)} disabled={isRunning}
                      className="btn btn-primary" style={{ fontSize:11, padding:"5px 10px" }}>
                      {isRunning ? "…" : <><Ic icon={Play} size={12} /> {t("rules.runNow")}</>}
                    </button>
                    <button onClick={() => toggleActive(rule)} className="btn btn-ghost"
                      style={{ fontSize:11, padding:"5px 10px", color:rule.is_active?"var(--amb)":"var(--grn)" }}>
                      {rule.is_active ? <Ic icon={Pause} size={13} /> : <Ic icon={Play} size={13} />}
                    </button>
                    <button onClick={() => openEdit(rule)} className="btn btn-ghost"
                      style={{ fontSize:11, padding:"5px 8px" }}><Ic icon={Edit2} size={13} /></button>
                    <button onClick={() => deleteRule(rule.id)} className="btn btn-red"
                      style={{ fontSize:11, padding:"5px 8px" }}><X size={13} strokeWidth={1.75} /></button>
                    <button onClick={() => setHistoryRule(rule)} className="btn btn-ghost"
                      style={{ fontSize:11, padding:"5px 8px" }} title="Run history">
                      <Ic icon={History} size={13} />
                    </button>
                    {(last || runResult[rule.id]) && (
                      <button onClick={() => {
                        if (runResult[rule.id]) setRunResult(r => ({...r,[rule.id]:runResult[rule.id]}));
                        else setRunResult(r => ({...r,[rule.id]:last}));
                        setShowResult(rule.id);
                      }} className="btn btn-ghost" style={{ fontSize:11, padding:"5px 8px" }}><Ic icon={BarChart2} size={13} /></button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {pagination.pages > 1 && (
        <div style={{ display:"flex", gap:6, justifyContent:"center", marginTop:16 }}>
          {Array.from({length:pagination.pages},(_,i)=>i+1).map(p => (
            <button key={p} onClick={() => setPage(p)}
              className={`btn ${page===p?"btn-primary":"btn-ghost"}`}
              style={{ fontSize:12, padding:"5px 10px", minWidth:34 }}>{p}</button>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Strategies Page ─────────────────────────────────────────────────────────
const StrategiesPage = ({ workspaceId }) => {
  const { t } = useI18n();
  const [strategies, setStrategies] = useState([]);
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editStrategy, setEditStrategy] = useState(null);
  const [historyStrategy, setHistoryStrategy] = useState(null);
  const [historyRuns, setHistoryRuns] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [runningId, setRunningId] = useState(null);
  const [toast, setToast] = useState(null);

  const showToast = (msg, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [strats, ruleList] = await Promise.all([
        get("/strategies"),
        get("/rules", { limit: 100 }),
      ]);
      setStrategies(strats);
      setRules(ruleList?.data || ruleList || []);
    } catch (e) { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const openHistory = async (s) => {
    setHistoryStrategy(s);
    setHistoryLoading(true);
    try {
      const runs = await get(`/strategies/${s.id}/runs`);
      setHistoryRuns(runs);
    } catch { setHistoryRuns([]); }
    setHistoryLoading(false);
  };

  const runStrategy = async (s, dryRun = false) => {
    setRunningId(s.id + (dryRun ? "_dry" : ""));
    try {
      const result = await post(`/strategies/${s.id}/run`, { dry_run: dryRun });
      showToast(t("strategies.runSuccess").replace("{n}", result.totalActions));
      load();
    } catch (e) {
      showToast(e.message, "error");
    }
    setRunningId(null);
  };

  const deleteStrategy = async (s) => {
    if (!confirm(t("strategies.deleteConfirm").replace("{name}", s.name))) return;
    try {
      await del(`/strategies/${s.id}`);
      load();
    } catch (e) { showToast(e.message, "error"); }
  };

  const statusColor = (status) => {
    if (!status || status === "never") return "var(--tx3)";
    if (status === "completed") return "var(--grn)";
    return "var(--red)";
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: "var(--disp)", fontSize: 22, fontWeight: 700, marginBottom: 4 }}>
            {t("strategies.title")}
          </h1>
          <p style={{ fontSize: 13, color: "var(--tx2)", maxWidth: 560 }}>{t("strategies.subtitle")}</p>
        </div>
        <button className="btn btn-primary" style={{ fontSize: 13, padding: "8px 16px" }}
          onClick={() => { setEditStrategy(null); setShowModal(true); }}>
          + {t("strategies.new")}
        </button>
      </div>

      {/* Toast */}
      {toast && (
        <div style={{
          position: "fixed", top: 20, right: 24, zIndex: 9000,
          background: toast.type === "error" ? "var(--red)" : "var(--grn)",
          color: "#fff", padding: "10px 18px", borderRadius: 8, fontSize: 13,
          boxShadow: "0 4px 16px rgba(0,0,0,.3)",
        }}>{toast.msg}</div>
      )}

      {/* Loading */}
      {loading && <div style={{ color: "var(--tx3)", fontSize: 13, padding: 24 }}>{t("common.loading")}</div>}

      {/* Empty */}
      {!loading && strategies.length === 0 && (
        <div style={{
          background: "var(--s1)", border: "1px dashed var(--b2)", borderRadius: 12,
          padding: "48px 24px", textAlign: "center",
        }}>
          <Orbit size={32} color="var(--tx3)" style={{ marginBottom: 12 }} />
          <div style={{ fontSize: 14, color: "var(--tx2)" }}>{t("strategies.empty")}</div>
        </div>
      )}

      {/* Strategy Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 16 }}>
        {strategies.map(s => (
          <div key={s.id} className="card" style={{ padding: 20, borderRadius: 10 }}>
            {/* Header row */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.name}
                </div>
                {s.description && (
                  <div style={{ fontSize: 12, color: "var(--tx2)", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.description}
                  </div>
                )}
              </div>
              <span style={{
                fontSize: 10, padding: "2px 7px", borderRadius: 20, marginLeft: 8, flexShrink: 0,
                background: s.is_active ? "rgba(34,197,94,.15)" : "rgba(100,116,139,.15)",
                color: s.is_active ? "var(--grn)" : "var(--tx3)",
              }}>
                {s.is_active ? "Active" : "Inactive"}
              </span>
            </div>

            {/* Rule chips */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 12, minHeight: 24 }}>
              {(s.rules || []).length === 0
                ? <span style={{ fontSize: 11, color: "var(--tx3)" }}>{t("strategies.noRules")}</span>
                : (s.rules || []).map((r, i) => (
                    <span key={r.id} style={{
                      fontSize: 11, padding: "2px 8px", borderRadius: 12,
                      background: "var(--s2)", border: "1px solid var(--b2)", color: "var(--tx2)",
                      display: "flex", alignItems: "center", gap: 4,
                    }}>
                      <span style={{ color: "var(--tx3)", fontFamily: "var(--mono)" }}>{i + 1}.</span>
                      {r.name}
                    </span>
                  ))
              }
            </div>

            {/* Last run */}
            <div style={{ fontSize: 11, color: "var(--tx3)", marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: statusColor(s.last_run_status) }}>●</span>
              {t("strategies.lastRun")}:{" "}
              {s.last_run_at
                ? new Date(s.last_run_at).toLocaleString()
                : t("strategies.never")}
            </div>

            {/* Actions */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button
                className="btn btn-primary"
                style={{ fontSize: 11, padding: "4px 12px" }}
                disabled={runningId === s.id}
                onClick={() => runStrategy(s, false)}
              >
                {runningId === s.id ? t("strategies.running") : t("strategies.run")}
              </button>
              <button
                className="btn btn-ghost"
                style={{ fontSize: 11, padding: "4px 12px" }}
                disabled={runningId === s.id + "_dry"}
                onClick={() => runStrategy(s, true)}
              >
                {runningId === s.id + "_dry" ? t("strategies.running") : t("strategies.runDry")}
              </button>
              <button
                className="btn btn-ghost"
                style={{ fontSize: 11, padding: "4px 10px" }}
                onClick={() => openHistory(s)}
              >
                <History size={12} />
              </button>
              <button
                className="btn btn-ghost"
                style={{ fontSize: 11, padding: "4px 10px" }}
                onClick={() => { setEditStrategy(s); setShowModal(true); }}
              >
                <Pencil size={12} />
              </button>
              <button
                className="btn btn-ghost"
                style={{ fontSize: 11, padding: "4px 10px", color: "var(--red)" }}
                onClick={() => deleteStrategy(s)}
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Create/Edit Modal */}
      {showModal && createPortal(
        <StrategyModal
          strategy={editStrategy}
          availableRules={rules}
          onClose={() => setShowModal(false)}
          onSave={() => { setShowModal(false); load(); }}
          t={t}
        />,
        document.body
      )}

      {/* History Modal */}
      {historyStrategy && createPortal(
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}
          onClick={() => setHistoryStrategy(null)}>
          <div style={{ background: "var(--s1)", borderRadius: 12, padding: 24, width: "100%", maxWidth: 600, maxHeight: "80vh", overflow: "auto" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <span style={{ fontFamily: "var(--disp)", fontSize: 16, fontWeight: 700 }}>
                {t("strategies.historyTitle")}: {historyStrategy.name}
              </span>
              <button className="btn btn-ghost" style={{ padding: "3px 8px" }} onClick={() => setHistoryStrategy(null)}><X size={14} /></button>
            </div>
            {historyLoading && <div style={{ color: "var(--tx3)", fontSize: 13 }}>{t("common.loading")}</div>}
            {!historyLoading && historyRuns.length === 0 && (
              <div style={{ color: "var(--tx3)", fontSize: 13, textAlign: "center", padding: 24 }}>{t("strategies.historyEmpty")}</div>
            )}
            {!historyLoading && historyRuns.length > 0 && (
              <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--b2)" }}>
                    <th style={{ textAlign: "left", padding: "6px 8px", color: "var(--tx2)", fontWeight: 500 }}>{t("strategies.colStarted")}</th>
                    <th style={{ textAlign: "center", padding: "6px 8px", color: "var(--tx2)", fontWeight: 500 }}>{t("strategies.colStatus")}</th>
                    <th style={{ textAlign: "center", padding: "6px 8px", color: "var(--tx2)", fontWeight: 500 }}>{t("strategies.colRules")}</th>
                    <th style={{ textAlign: "center", padding: "6px 8px", color: "var(--tx2)", fontWeight: 500 }}>{t("strategies.colActions")}</th>
                    <th style={{ textAlign: "center", padding: "6px 8px", color: "var(--tx2)", fontWeight: 500 }}>{t("strategies.colDuration")}</th>
                  </tr>
                </thead>
                <tbody>
                  {historyRuns.map(run => {
                    const durationMs = run.completed_at
                      ? new Date(run.completed_at) - new Date(run.started_at)
                      : null;
                    return (
                      <tr key={run.id} style={{ borderBottom: "1px solid var(--b2)" }}>
                        <td style={{ padding: "7px 8px", color: "var(--tx2)" }}>
                          {new Date(run.started_at).toLocaleString()}
                          {run.dry_run && (
                            <span style={{ marginLeft: 6, fontSize: 10, background: "rgba(167,139,250,.15)", color: "var(--pur)", padding: "1px 6px", borderRadius: 10 }}>
                              {t("strategies.dryRunBadge")}
                            </span>
                          )}
                        </td>
                        <td style={{ padding: "7px 8px", textAlign: "center" }}>
                          <span style={{ color: run.status === "completed" ? "var(--grn)" : "var(--red)", fontSize: 11 }}>
                            {run.status === "completed" ? t("strategies.statusCompleted") : t("strategies.statusError")}
                          </span>
                        </td>
                        <td style={{ padding: "7px 8px", textAlign: "center", color: "var(--tx)" }}>{run.rules_run}</td>
                        <td style={{ padding: "7px 8px", textAlign: "center", color: "var(--ac2)", fontWeight: 600 }}>{run.total_actions}</td>
                        <td style={{ padding: "7px 8px", textAlign: "center", color: "var(--tx3)" }}>
                          {durationMs != null ? `${(durationMs / 1000).toFixed(1)}s` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

// Strategy Create/Edit Modal
const StrategyModal = ({ strategy, availableRules, onClose, onSave, t }) => {
  const [name, setName] = useState(strategy?.name || "");
  const [description, setDescription] = useState(strategy?.description || "");
  const [selectedRuleIds, setSelectedRuleIds] = useState(
    strategy?.rule_ids || strategy?.rules?.map(r => r.id) || []
  );
  const [isActive, setIsActive] = useState(strategy?.is_active !== false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const addRule = (ruleId) => {
    if (!selectedRuleIds.includes(ruleId)) {
      setSelectedRuleIds(prev => [...prev, ruleId]);
    }
  };

  const removeRule = (ruleId) => {
    setSelectedRuleIds(prev => prev.filter(id => id !== ruleId));
  };

  const moveRule = (idx, dir) => {
    setSelectedRuleIds(prev => {
      const arr = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= arr.length) return arr;
      [arr[idx], arr[target]] = [arr[target], arr[idx]];
      return arr;
    });
  };

  const handleSave = async () => {
    if (!name.trim()) { setError(t("strategies.name") + " required"); return; }
    setSaving(true);
    setError(null);
    try {
      const payload = { name: name.trim(), description: description.trim() || null, rule_ids: selectedRuleIds, is_active: isActive };
      if (strategy?.id) {
        await patch(`/strategies/${strategy.id}`, payload);
      } else {
        await post("/strategies", payload);
      }
      onSave();
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  const availableToAdd = availableRules.filter(r => !selectedRuleIds.includes(r.id));
  const selectedRulesOrdered = selectedRuleIds
    .map(id => availableRules.find(r => r.id === id))
    .filter(Boolean);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}
      onClick={onClose}>
      <div style={{ background: "var(--s1)", borderRadius: 12, padding: 28, width: "100%", maxWidth: 520, maxHeight: "90vh", overflow: "auto" }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <span style={{ fontFamily: "var(--disp)", fontSize: 16, fontWeight: 700 }}>
            {strategy ? t("common.edit") : t("strategies.new")}
          </span>
          <button className="btn btn-ghost" style={{ padding: "3px 8px" }} onClick={onClose}><X size={14} /></button>
        </div>

        {error && <div style={{ background: "rgba(239,68,68,.1)", color: "var(--red)", borderRadius: 6, padding: "8px 12px", fontSize: 12, marginBottom: 12 }}>{error}</div>}

        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, color: "var(--tx2)", display: "block", marginBottom: 5 }}>{t("strategies.name")} *</label>
          <input
            className="inp"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={t("strategies.name")}
            style={{ width: "100%" }}
          />
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, color: "var(--tx2)", display: "block", marginBottom: 5 }}>{t("strategies.description")}</label>
          <input
            className="inp"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder={t("common.optional")}
            style={{ width: "100%" }}
          />
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, color: "var(--tx2)", display: "block", marginBottom: 5 }}>{t("strategies.rules")}</label>

          {/* Ordered list of selected rules */}
          {selectedRulesOrdered.length === 0
            ? <div style={{ fontSize: 12, color: "var(--tx3)", padding: "8px 0" }}>{t("strategies.noRules")}</div>
            : selectedRulesOrdered.map((r, i) => (
              <div key={r.id} style={{
                display: "flex", alignItems: "center", gap: 8,
                background: "var(--s2)", borderRadius: 6, padding: "6px 10px", marginBottom: 5,
              }}>
                <span style={{ fontSize: 11, color: "var(--tx3)", fontFamily: "var(--mono)", minWidth: 18 }}>{i + 1}.</span>
                <span style={{ flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                <button className="btn btn-ghost" style={{ padding: "2px 5px" }} onClick={() => moveRule(i, -1)} disabled={i === 0} title="Move up">
                  <ChevronUp size={11} />
                </button>
                <button className="btn btn-ghost" style={{ padding: "2px 5px" }} onClick={() => moveRule(i, 1)} disabled={i === selectedRulesOrdered.length - 1} title="Move down">
                  <ChevronDown size={11} />
                </button>
                <button className="btn btn-ghost" style={{ padding: "2px 5px", color: "var(--red)" }} onClick={() => removeRule(r.id)}>
                  <X size={11} />
                </button>
              </div>
            ))
          }

          {/* Add rule dropdown */}
          {availableToAdd.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <select
                className="inp"
                style={{ fontSize: 12, width: "100%" }}
                value=""
                onChange={e => { if (e.target.value) addRule(e.target.value); }}
              >
                <option value="">{t("strategies.rulesPlaceholder")}</option>
                {availableToAdd.map(r => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div style={{ marginBottom: 20, display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" id="strat-active" checked={isActive} onChange={e => setIsActive(e.target.checked)} />
          <label htmlFor="strat-active" style={{ fontSize: 12, color: "var(--tx2)", cursor: "pointer" }}>Active</label>
        </div>

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button className="btn btn-ghost" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? "…" : t("strategies.save")}
          </button>
        </div>
      </div>
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

  const [configPage, setConfigPage] = useState(1);
  const [configPageSize, setConfigPageSize] = useState(25);
  const [instancePage, setInstancePage] = useState(1);
  const [instancePageSize, setInstancePageSize] = useState(25);

  const { data: configsData, loading: cl, reload: reloadConfigs } = useAsync(
    () => workspaceId ? get("/alerts/configs", { page: configPage, limit: configPageSize }) : Promise.resolve({ data: [], pagination: {} }),
    [workspaceId, configPage, configPageSize]
  );
  const { data: instancesData, loading: il, reload: reloadInstances } = useAsync(
    () => workspaceId ? get("/alerts", { status: "open", page: instancePage, limit: instancePageSize }) : Promise.resolve({ data: [], pagination: {} }),
    [workspaceId, instancePage, instancePageSize]
  );
  const configs = configsData?.data ?? [];
  const instances = instancesData?.data ?? [];

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
            {tabId === "instances" && (instancesData?.pagination?.total > 0) && (
              <span className="badge bg-red" style={{ marginLeft: 6, fontSize: 9, padding: "1px 5px" }}>{instancesData.pagination.total}</span>
            )}
          </button>
        ))}
      </div>

      {tab === "configs" && (
        <>
          <div className="card" style={{ overflow: "hidden" }}>
            {cl
              ? <div style={{ padding: 40, textAlign: "center" }}><span className="loader" /></div>
              : !configs.length
                ? <div style={{ padding: "40px", textAlign: "center", color: "var(--tx3)" }}>{t("alerts.noAlerts")}</div>
                : (
                  <table>
                    <thead>
                      <tr>
                        <th>{t("alerts.colName")}</th>
                        <th>{t("alerts.colMetric")}</th>
                        <th>{t("alerts.colThreshold")}</th>
                        <th>{t("alerts.colChannels")}</th>
                        <th>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            {t("alerts.colCooldown")}
                            <Tip text="Minimum time before the same alert can fire again. Prevents repeated notifications for the same condition." width={210}>
                              <Ic icon={HelpCircle} size={11} style={{ color: 'var(--tx3)', cursor: 'help' }} />
                            </Tip>
                          </span>
                        </th>
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
                                <button className="btn btn-red"   style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => deleteConfig(config.id)}><X size={11} strokeWidth={1.75} /></button>
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
          {(configsData?.pagination?.total > 0) && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14, flexWrap: "wrap", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--tx2)" }}>
                {[10, 25, 50, 100].map(size => (
                  <button key={size} onClick={() => { setConfigPageSize(size); setConfigPage(1); }}
                    className={`btn ${configPageSize === size ? "btn-primary" : "btn-ghost"}`}
                    style={{ fontSize: 11, padding: "4px 10px", minWidth: 36 }}>{size}</button>
                ))}
              </div>
              <div style={{ fontSize: 13, color: "var(--tx2)" }}>
                {((configPage - 1) * configPageSize) + 1}–{Math.min(configPage * configPageSize, configsData.pagination.total)} {t("common.of")} {configsData.pagination.total}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }}
                  onClick={() => setConfigPage(p => Math.max(1, p - 1))} disabled={configPage === 1}>{t("common.back")}</button>
                {getPageRange(configPage, configsData.pagination.pages ?? 1).map((p, i) =>
                  p === "..." ? <span key={`e${i}`} style={{ padding: "0 6px", color: "var(--tx3)" }}>…</span>
                  : <button key={p} onClick={() => setConfigPage(p)} className={`btn ${configPage === p ? "btn-primary" : "btn-ghost"}`}
                      style={{ fontSize: 11, padding: "4px 8px", minWidth: 32 }}>{p}</button>
                )}
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }}
                  onClick={() => setConfigPage(p => Math.min(configsData.pagination.pages ?? 1, p + 1))} disabled={configPage === (configsData.pagination.pages ?? 1)}>{t("common.next")}</button>
              </div>
            </div>
          )}
        </>
      )}

      {tab === "instances" && (
        <>
          <div className="card" style={{ overflow: "hidden" }}>
            {il
              ? <div style={{ padding: 40, textAlign: "center" }}><span className="loader" /></div>
              : !instances.length
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
          {(instancesData?.pagination?.total > 0) && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14, flexWrap: "wrap", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--tx2)" }}>
                {[10, 25, 50, 100].map(size => (
                  <button key={size} onClick={() => { setInstancePageSize(size); setInstancePage(1); }}
                    className={`btn ${instancePageSize === size ? "btn-primary" : "btn-ghost"}`}
                    style={{ fontSize: 11, padding: "4px 10px", minWidth: 36 }}>{size}</button>
                ))}
              </div>
              <div style={{ fontSize: 13, color: "var(--tx2)" }}>
                {((instancePage - 1) * instancePageSize) + 1}–{Math.min(instancePage * instancePageSize, instancesData.pagination.total)} {t("common.of")} {instancesData.pagination.total}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }}
                  onClick={() => setInstancePage(p => Math.max(1, p - 1))} disabled={instancePage === 1}>{t("common.back")}</button>
                {getPageRange(instancePage, instancesData.pagination.pages ?? 1).map((p, i) =>
                  p === "..." ? <span key={`e${i}`} style={{ padding: "0 6px", color: "var(--tx3)" }}>…</span>
                  : <button key={p} onClick={() => setInstancePage(p)} className={`btn ${instancePage === p ? "btn-primary" : "btn-ghost"}`}
                      style={{ fontSize: 11, padding: "4px 8px", minWidth: 32 }}>{p}</button>
                )}
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }}
                  onClick={() => setInstancePage(p => Math.min(instancesData.pagination.pages ?? 1, p + 1))} disabled={instancePage === (instancesData.pagination.pages ?? 1)}>{t("common.next")}</button>
              </div>
            </div>
          )}
        </>
      )}

      {showModal && createPortal(
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.65)", display: "flex", alignItems: "flex-start", justifyContent: "center", overflowY: "auto", padding: "24px 16px", zIndex: 1000 }}>
          <div className="card fade" style={{ width: 480, padding: "24px 28px", margin: "0 auto", flexShrink: 0 }}>
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
        </div>,
      document.body
      )}
    </div>
  );
};

// ─── Invite Accept Page ───────────────────────────────────────────────────────
const InvitePage = ({ token, onLogin }) => {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const ROLE_LABELS = {
    admin: "Admin", analyst: "Analyst", media_buyer: "Media Buyer",
    ai_operator: "AI Operator", read_only: "Read Only",
  };

  useEffect(() => {
    fetch(`${import.meta.env.VITE_API_URL || "http://localhost:4000/api/v1"}/auth/invite/${token}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) setError(data.error);
        else setInfo(data);
      })
      .catch(() => setError("Failed to load invitation"))
      .finally(() => setLoading(false));
  }, [token]);

  async function accept() {
    setSubmitting(true); setError(null);
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL || "http://localhost:4000/api/v1"}/auth/accept-invite/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(info?.is_new_user ? { password } : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to accept invitation");
      localStorage.setItem("af_token", data.accessToken);
      if (data.workspaces?.[0]) localStorage.setItem("af_workspace", data.workspaces[0].id);
      window.history.replaceState({}, "", "/");
      onLogin(data);
    } catch (e) {
      setError(e.message);
    }
    setSubmitting(false);
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)" }}>
      <Styles />
      <div style={{ width: 420, padding: "36px 32px", background: "var(--s1)", borderRadius: 14, border: "1px solid var(--b1)" }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ width: 48, height: 48, background: "linear-gradient(135deg,#3B82F6,#A78BFA)", borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px" }}>
            <Activity size={24} strokeWidth={1.75} color="#fff" />
          </div>
          <div style={{ fontFamily: "var(--disp)", fontSize: 22, fontWeight: 800 }}>AdsFlow</div>
          <div style={{ fontSize: 12, color: "var(--tx3)" }}>Amazon Ads Dashboard</div>
        </div>

        {loading && <div style={{ textAlign: "center", color: "var(--tx3)", padding: "20px 0" }}>Loading invitation…</div>}

        {!loading && error && (
          <div style={{ textAlign: "center" }}>
            <div style={{ padding: "16px", background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.2)", borderRadius: 8, color: "var(--red)", fontSize: 13, marginBottom: 16 }}>{error}</div>
            <button className="btn btn-secondary" onClick={() => { window.history.replaceState({}, "", "/"); window.location.reload(); }}>Back to login</button>
          </div>
        )}

        {!loading && info && (
          <>
            <div style={{ background: "var(--s2)", borderRadius: 10, padding: "16px 18px", marginBottom: 20 }}>
              <div style={{ fontSize: 13, color: "var(--tx3)", marginBottom: 4 }}>You've been invited by <strong style={{ color: "var(--tx)" }}>{info.inviter_name}</strong></div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--tx)", marginBottom: 4 }}>{info.workspace_name}</div>
              <div style={{ display: "inline-block", background: "rgba(167,139,250,0.12)", color: "#a78bfa", borderRadius: 6, padding: "2px 10px", fontSize: 12, fontWeight: 600 }}>
                {ROLE_LABELS[info.role] || info.role}
              </div>
            </div>

            {error && <div style={{ marginBottom: 14, padding: "10px 14px", background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.2)", borderRadius: 8, color: "var(--red)", fontSize: 12 }}>{error}</div>}

            {info.is_new_user && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, color: "var(--tx3)", marginBottom: 8 }}>Set a password for your new account (<strong style={{ color: "var(--tx2)" }}>{info.email}</strong>)</div>
                <input
                  type="password"
                  placeholder="Choose a password (min 8 characters)"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && accept()}
                  style={{ width: "100%", boxSizing: "border-box" }}
                />
              </div>
            )}

            <button
              className="btn btn-primary"
              style={{ width: "100%", justifyContent: "center", padding: "11px" }}
              onClick={accept}
              disabled={submitting || (info.is_new_user && password.length < 8)}
            >
              {submitting ? <span className="loader" /> : "Accept Invitation & Open Dashboard"}
            </button>
          </>
        )}
      </div>
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
  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotDone, setForgotDone] = useState(false);

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

  async function submitForgot() {
    setForgotLoading(true);
    try {
      await post("/auth/forgot-password", { email: forgotEmail });
      setForgotDone(true);
    } catch (_) {
      // Always show success to prevent user enumeration
      setForgotDone(true);
    }
    setForgotLoading(false);
  }

  const f = (field) => ({ value: form[field], onChange: e => setForm(f => ({ ...f, [field]: e.target.value }) )});

  const logoBlock = (
    <div style={{ textAlign: "center", marginBottom: 28 }}>
      <div style={{ width: 44, height: 44, background: "linear-gradient(135deg,#3B82F6,#A78BFA)", borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px" }}><Activity size={22} strokeWidth={1.75} color="#fff" /></div>
      <div style={{ fontFamily: "var(--disp)", fontSize: 22, fontWeight: 800 }}>AdsFlow</div>
      <div style={{ fontSize: 12, color: "var(--tx3)" }}>{t("login.subtitle")}</div>
    </div>
  );

  if (showForgot) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)" }}>
        <Styles />
        <div style={{ width: 380, padding: "36px 32px", background: "var(--s1)", borderRadius: 14, border: "1px solid var(--b1)" }}>
          {logoBlock}
          {forgotDone ? (
            <div style={{ textAlign: "center" }}>
              <div style={{ width: 48, height: 48, background: "rgba(34,197,94,.12)", borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--grn)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--tx)", marginBottom: 8 }}>{t("login.resetEmailSent")}</div>
              <div style={{ fontSize: 13, color: "var(--tx3)", lineHeight: 1.6, marginBottom: 20 }}>{t("login.resetEmailSentDesc")}</div>
              <button className="btn btn-secondary" style={{ width: "100%", justifyContent: "center" }} onClick={() => { setShowForgot(false); setForgotDone(false); setForgotEmail(""); }}>
                {t("login.backToLogin")}
              </button>
            </div>
          ) : (
            <>
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: "var(--tx)", marginBottom: 6 }}>{t("login.resetPasswordTitle")}</div>
                <div style={{ fontSize: 13, color: "var(--tx3)" }}>{t("login.resetPasswordSubtitle")}</div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <input placeholder={t("login.emailPlaceholder")} type="email" value={forgotEmail}
                  onChange={e => setForgotEmail(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && forgotEmail && submitForgot()} />
                <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center", padding: "10px" }}
                  onClick={submitForgot} disabled={forgotLoading || !forgotEmail}>
                  {forgotLoading ? <span className="loader" /> : t("login.sendResetLink")}
                </button>
                <button className="btn btn-secondary" style={{ width: "100%", justifyContent: "center" }}
                  onClick={() => setShowForgot(false)}>
                  {t("login.backToLogin")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)" }}>
      <Styles />
      <div style={{ width: 380, padding: "36px 32px", background: "var(--s1)", borderRadius: 14, border: "1px solid var(--b1)" }}>
        {logoBlock}

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
          {tab === "login" && (
            <div style={{ textAlign: "right", marginTop: -4 }}>
              <button style={{ background: "none", border: "none", color: "var(--ac)", fontSize: 12, cursor: "pointer", padding: 0 }}
                onClick={() => { setShowForgot(true); setForgotEmail(form.email); }}>
                {t("login.forgotPassword")}
              </button>
            </div>
          )}
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

// ─── Reset Password Page ───────────────────────────────────────────────────────
const ResetPasswordPage = ({ token, onLogin }) => {
  const { t } = useI18n();
  const [password, setPassword]   = useState("");
  const [confirm, setConfirm]     = useState("");
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);
  const [done, setDone]           = useState(false);

  async function submit() {
    if (password !== confirm) { setError(t("login.passwordMismatch")); return; }
    setLoading(true); setError(null);
    try {
      await post(`/auth/reset-password/${token}`, { password });
      setDone(true);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }

  const logoBlock = (
    <div style={{ textAlign: "center", marginBottom: 28 }}>
      <div style={{ width: 44, height: 44, background: "linear-gradient(135deg,#3B82F6,#A78BFA)", borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px" }}><Activity size={22} strokeWidth={1.75} color="#fff" /></div>
      <div style={{ fontFamily: "var(--disp)", fontSize: 22, fontWeight: 800 }}>AdsFlow</div>
      <div style={{ fontSize: 12, color: "var(--tx3)" }}>{t("login.subtitle")}</div>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)" }}>
      <Styles />
      <div style={{ width: 380, padding: "36px 32px", background: "var(--s1)", borderRadius: 14, border: "1px solid var(--b1)" }}>
        {logoBlock}
        {done ? (
          <div style={{ textAlign: "center" }}>
            <div style={{ width: 48, height: 48, background: "rgba(34,197,94,.12)", borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--grn)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--tx)", marginBottom: 8 }}>{t("login.passwordReset")}</div>
            <div style={{ fontSize: 13, color: "var(--tx3)", lineHeight: 1.6, marginBottom: 20 }}>{t("login.passwordResetDesc")}</div>
            <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center" }}
              onClick={() => { window.history.replaceState({}, "", "/"); window.location.reload(); }}>
              {t("login.login")}
            </button>
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--tx)", marginBottom: 6 }}>{t("login.resetPasswordTitle")}</div>
            </div>
            {error && <div style={{ marginBottom: 14, padding: "10px 14px", background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.2)", borderRadius: 8, color: "var(--red)", fontSize: 12 }}>{error}</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <input placeholder={t("login.newPassword")} type="password" value={password}
                onChange={e => setPassword(e.target.value)} />
              <input placeholder={t("login.confirmPassword")} type="password" value={confirm}
                onChange={e => setConfirm(e.target.value)}
                onKeyDown={e => e.key === "Enter" && password.length >= 8 && submit()} />
              <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center", padding: "10px" }}
                onClick={submit} disabled={loading || password.length < 8}>
                {loading ? <span className="loader" /> : t("login.setNewPassword")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

// ─── AI Page ──────────────────────────────────────────────────────────────────
const AI_RISK_COLOR = { low: "var(--grn)", medium: "var(--amb)", high: "var(--red)" };
const AI_TYPE_ICON  = {
  bid_adjustment:          <Zap size={20} strokeWidth={1.75} color="var(--amb)" />,
  budget_increase:         <TrendingUp size={20} strokeWidth={1.75} color="var(--grn)" />,
  budget_decrease:         <TrendingDown size={20} strokeWidth={1.75} color="var(--red)" />,
  campaign_pause:          <Pause size={20} strokeWidth={1.75} color="var(--tx2)" />,
  keyword_add:             <Tag size={20} strokeWidth={1.75} color="var(--ac2)" />,
  keyword_pause:           <Tag size={20} strokeWidth={1.75} color="var(--tx3)" />,
  targeting_optimization:  <Target size={20} strokeWidth={1.75} color="var(--pur)" />,
  other:                   <Sparkles size={20} strokeWidth={1.75} color="var(--teal)" />,
};

function AIPage({ workspaceId }) {
  const { t } = useI18n();

  // Run state
  const [prompt, setPrompt]       = useState("");
  const [scope, setScope]         = useState("all");
  const [rangeMode, setRangeMode] = useState("14");
  const [running, setRunning]     = useState(false);
  const [runError, setRunError]   = useState(null);

  // Settings state
  const [showSettings, setShowSettings]   = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSaved, setSettingsSaved]   = useState(false);
  const [settings, setSettings] = useState({
    target_acos: "", max_acos: "", target_roas: "", min_roas: "",
    target_margin: "", monthly_budget: "", business_notes: "", response_language: "ru",
  });

  // Preview/confirm modals
  const [confirmRec, setConfirmRec]   = useState(null);
  const [applying, setApplying]       = useState(null);
  const [previewRec, setPreviewRec]   = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [toast, setToast] = useState(null);

  const { data: recs, loading: recsLoading, reload: reloadRecs } = useAsync(
    () => workspaceId ? get("/ai/recommendations") : Promise.resolve([]),
    [workspaceId]
  );

  // Load settings on mount
  useEffect(() => {
    if (!workspaceId) return;
    get("/ai/settings").then(data => {
      if (data) setSettings({
        target_acos:       data.target_acos       || "",
        max_acos:          data.max_acos          || "",
        target_roas:       data.target_roas       || "",
        min_roas:          data.min_roas          || "",
        target_margin:     data.target_margin     || "",
        monthly_budget:    data.monthly_budget    || "",
        business_notes:    data.business_notes    || "",
        response_language: data.response_language || "ru",
      });
    }).catch(() => {});
  }, [workspaceId]);

  const showToast = (msg, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  };

  const endDate   = new Date().toISOString().split("T")[0];
  const startDate = new Date(Date.now() - parseInt(rangeMode) * 86400000).toISOString().split("T")[0];

  const handleAnalyze = async () => {
    if (!workspaceId) return;
    setRunning(true); setRunError(null);
    try {
      await post("/ai/analyze", { prompt, scope, startDate, endDate });
      reloadRecs();
    } catch (e) {
      setRunError(e.message || "Analysis failed");
    } finally {
      setRunning(false);
    }
  };

  const handleSaveSettings = async () => {
    setSettingsSaving(true);
    try {
      const saved = await patch("/ai/settings", settings);
      setSettings(s => ({ ...s, ...saved }));
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 2000);
    } catch (e) {
      alert(t("common.error") + e.message);
    } finally {
      setSettingsSaving(false);
    }
  };

  async function handleApply(rec) {
    setApplying(rec.id);
    try {
      await post(`/ai/recommendations/${rec.id}/apply`, {});
      showToast(t("ai.applySuccess"));
      reloadRecs();
    } catch (e) {
      showToast(t("ai.applyError") + ": " + e.message, false);
    } finally {
      setApplying(null);
      setConfirmRec(null);
    }
  }

  async function handleDismiss(id) {
    try {
      await post(`/ai/recommendations/${id}/dismiss`, {});
      reloadRecs();
    } catch (e) {
      showToast(t("common.error") + e.message, false);
    }
  }

  async function handlePreview(rec) {
    setPreviewRec(rec); setPreviewLoading(true); setPreviewData(null);
    try {
      const data = await post(`/ai/recommendations/${rec.id}/preview`, {});
      setPreviewData(data.changes || []);
    } catch { setPreviewData([]); }
    finally { setPreviewLoading(false); }
  }

  const pendingRecs = (recs || []).filter(r => r.status === "pending");

  return (
    <div className="fade">
      {/* Toast */}
      {toast && (
        <div style={{ position:"fixed", top:24, right:24, zIndex:9999,
          background: toast.ok ? "var(--grn)" : "var(--red)",
          color:"#fff", padding:"10px 18px", borderRadius:8,
          fontSize:13, fontWeight:500, animation:"slideDown .2s ease" }}>
          {toast.msg}
        </div>
      )}

      {/* Confirm Apply Modal */}
      {confirmRec && createPortal(
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.6)", zIndex:1000,
          display:"flex", alignItems:"flex-start", justifyContent:"center", overflowY:"auto", padding:"24px 16px" }}>
          <div className="card" style={{ padding:28, maxWidth:440, width:"90%", margin:"0 auto", flexShrink:0 }}>
            <div style={{ fontWeight:700, fontSize:16, marginBottom:10 }}>{t("ai.confirmApply")}</div>
            <div style={{ fontSize:13, color:"var(--tx2)", marginBottom:6 }}><strong>{confirmRec.title}</strong></div>
            <div style={{ fontSize:12, color:"var(--tx3)", marginBottom:20 }}>{confirmRec.rationale}</div>
            <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
              <button className="btn btn-ghost" onClick={() => setConfirmRec(null)}>{t("common.cancel")}</button>
              <button className="btn btn-primary" disabled={applying === confirmRec.id} onClick={() => handleApply(confirmRec)}>
                {applying === confirmRec.id ? <span className="loader" /> : t("ai.confirmApplyBtn")}
              </button>
            </div>
          </div>
        </div>,
      document.body
      )}

      {/* Preview Modal */}
      {previewRec && createPortal(
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.6)", zIndex:1000,
          display:"flex", alignItems:"flex-start", justifyContent:"center", overflowY:"auto", padding:"24px 16px" }}>
          <div className="card" style={{ padding:28, maxWidth:600, width:"90%", margin:"0 auto", flexShrink:0 }}>
            <div style={{ fontWeight:700, fontSize:16, marginBottom:14 }}>{t("ai.previewTitle")}: {previewRec.title}</div>
            {previewLoading ? (
              <div style={{ textAlign:"center", padding:30 }}><span className="loader" /></div>
            ) : previewData?.length ? (
              <table style={{ marginBottom:16 }}>
                <thead><tr>
                  <th>{t("ai.entity")}</th><th>{t("ai.field")}</th>
                  <th>{t("ai.current")}</th><th>{t("ai.new")}</th>
                </tr></thead>
                <tbody>
                  {previewData.map((ch, i) => (
                    <tr key={i}>
                      <td><span className="mono" style={{ fontSize:11 }}>{ch.entity_name}</span></td>
                      <td><span className="mono" style={{ fontSize:11 }}>{ch.field}</span></td>
                      <td style={{ color:"var(--red)" }}>{String(ch.current_value ?? "—")}</td>
                      <td style={{ color:"var(--grn)" }}>{String(ch.new_value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div style={{ color:"var(--tx3)", fontSize:13, marginBottom:16 }}>No entity details available.</div>
            )}
            <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
              <button className="btn btn-ghost" onClick={() => { setPreviewRec(null); setPreviewData(null); }}>{t("common.cancel")}</button>
              {previewRec.status === "pending" && (
                <button className="btn btn-primary" onClick={() => { setPreviewRec(null); setConfirmRec(previewRec); }}>{t("ai.apply")}</button>
              )}
            </div>
          </div>
        </div>,
      document.body
      )}

      {/* ── Header ── */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:20 }}>
        <div>
          <h1 style={{ fontFamily:"var(--disp)", fontSize:22, fontWeight:700, marginBottom:4 }}>{t("ai.title")}</h1>
          <div style={{ fontSize:12, color:"var(--tx3)" }}>{startDate} – {endDate}</div>
        </div>
        <div style={{ display:"flex", gap:6, alignItems:"center" }}>
          {[["7","7d"],["14","14d"],["30","30d"]].map(([v,l]) => (
            <button key={v} onClick={() => setRangeMode(v)}
              className={`btn ${rangeMode===v?"btn-primary":"btn-ghost"}`}
              style={{ fontSize:12, padding:"5px 10px" }}>{l}
            </button>
          ))}
        </div>
      </div>

      {/* ── Prompt + Run card ── */}
      <div className="card" style={{ padding:"18px 20px", marginBottom:16 }}>
        {/* Scope selector */}
        <div style={{ display:"flex", gap:8, marginBottom:12, flexWrap:"wrap", alignItems:"center" }}>
          <span style={{ fontSize:12, color:"var(--tx3)" }}>{t("ai.scope")}:</span>
          {[
            ["all",               t("ai.scopeAll")],
            ["sponsoredProducts", t("ai.scopeSP")],
            ["sponsoredBrands",   t("ai.scopeSB")],
            ["sponsoredDisplay",  t("ai.scopeSD")],
          ].map(([v,l]) => (
            <button key={v} onClick={() => setScope(v)}
              className={`btn ${scope===v?"btn-primary":"btn-ghost"}`}
              style={{ fontSize:11, padding:"4px 10px" }}>{l}
            </button>
          ))}
        </div>

        {/* Suggested prompts */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          {[
            "Which campaigns are overspending budget?",
            "Where is ACOS too high?",
            "Which keywords should be paused?",
            "Show top performers this week",
            "Which search terms to add as keywords?",
            "Where are the most wasteful clicks?",
          ].map(p => (
            <button key={p} onClick={() => setPrompt(p)}
              className="btn btn-ghost"
              style={{ fontSize: 11, padding: "4px 10px", borderRadius: 20, color: "var(--tx3)" }}>
              {p}
            </button>
          ))}
        </div>

        {/* Prompt textarea */}
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder={t("ai.promptPlaceholder")}
          rows={3}
          style={{
            width:"100%", fontSize:13, padding:"10px 12px",
            borderRadius:8, resize:"vertical",
            background:"var(--s2)", border:"1px solid var(--b2)",
            color:"var(--tx)", outline:"none", lineHeight:1.5,
            fontFamily:"var(--ui)", boxSizing:"border-box",
          }}
        />

        {/* Error */}
        {runError && (
          <div style={{ marginTop:10, fontSize:12, color:"var(--red)",
            background:"rgba(239,68,68,.1)", padding:"8px 12px", borderRadius:6 }}>
            <AlertCircle size={12} strokeWidth={1.75} style={{display:'inline-block',verticalAlign:'middle',marginRight:5}} /> {runError.includes("ANTHROPIC_API_KEY") ? t("ai.noKey") : runError}
          </div>
        )}

        <div style={{ marginTop:12, display:"flex", justifyContent:"flex-end" }}>
          <button onClick={handleAnalyze} disabled={running || !workspaceId}
            className="btn btn-primary" style={{ fontSize:13, padding:"8px 24px" }}>
            {running
              ? <><RefreshCw size={14} strokeWidth={1.75} style={{ animation:"spin 1s linear infinite", display:"inline-block" }} /> {t("ai.running")}</>
              : <><Ic icon={Sparkles} size={14} /> {t("ai.run")}</>}
          </button>
        </div>
      </div>

      {/* ── Business Context Settings (collapsible) ── */}
      <div className="card" style={{ marginBottom:16, overflow:"hidden" }}>
        <div onClick={() => setShowSettings(s => !s)}
          style={{ padding:"14px 20px", display:"flex", justifyContent:"space-between",
            alignItems:"center", cursor:"pointer", userSelect:"none" }}>
          <div>
            <span style={{ fontFamily:"var(--disp)", fontSize:14, fontWeight:600, display:"flex", alignItems:"center", gap:6 }}>
              <Cog size={14} strokeWidth={1.75} /> {t("ai.settingsTitle")}
            </span>
            {settingsSaved && <span style={{ fontSize:12, color:"var(--grn)", marginLeft:10 }}>{t("ai.saved")}</span>}
            <div style={{ fontSize:12, color:"var(--tx3)", marginTop:2 }}>{t("ai.settingsSubtitle")}</div>
          </div>
          <span style={{ color:"var(--tx3)" }}>{showSettings ? <ChevronUp size={16} strokeWidth={1.75} /> : <ChevronDown size={16} strokeWidth={1.75} />}</span>
        </div>

        {showSettings && (
          <div style={{ padding:"0 20px 18px" }}>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(3, 1fr)", gap:12, marginBottom:14 }}>
              {[
                { key:"target_acos",    label:"Target ACOS (%)",    placeholder:"e.g. 15" },
                { key:"max_acos",       label:"Max ACOS (%)",       placeholder:"e.g. 25" },
                { key:"target_roas",    label:"Target ROAS (x)",    placeholder:"e.g. 5.0" },
                { key:"min_roas",       label:"Min ROAS (x)",       placeholder:"e.g. 3.0" },
                { key:"target_margin",  label:"Margin (%)",         placeholder:"e.g. 30" },
                { key:"monthly_budget", label:"Monthly Budget (€)", placeholder:"e.g. 5000" },
              ].map(({ key, label, placeholder }) => (
                <div key={key}>
                  <div style={{ fontSize:11, color:"var(--tx3)", marginBottom:4, fontFamily:"var(--mono)",
                    textTransform:"uppercase", letterSpacing:".05em" }}>{label}</div>
                  <input type="number" value={settings[key]}
                    onChange={e => setSettings(s => ({ ...s, [key]: e.target.value }))}
                    placeholder={placeholder}
                    style={{ width:"100%", fontSize:13, padding:"7px 10px", borderRadius:6,
                      background:"var(--s2)", border:"1px solid var(--b2)",
                      color:"var(--tx)", outline:"none", boxSizing:"border-box" }} />
                </div>
              ))}
            </div>

            <div style={{ marginBottom:12 }}>
              <div style={{ fontSize:11, color:"var(--tx3)", marginBottom:4, fontFamily:"var(--mono)",
                textTransform:"uppercase", letterSpacing:".05em" }}>Business notes</div>
              <textarea value={settings.business_notes}
                onChange={e => setSettings(s => ({ ...s, business_notes: e.target.value }))}
                placeholder="Describe your business: product type, target market, seasonality, price segment..."
                rows={3}
                style={{ width:"100%", fontSize:12, padding:"9px 12px", borderRadius:6, resize:"vertical",
                  background:"var(--s2)", border:"1px solid var(--b2)",
                  color:"var(--tx)", outline:"none", lineHeight:1.5,
                  fontFamily:"var(--ui)", boxSizing:"border-box" }} />
            </div>

            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14 }}>
              <span style={{ fontSize:11, color:"var(--tx3)", fontFamily:"var(--mono)",
                textTransform:"uppercase", letterSpacing:".05em" }}>Response language:</span>
              {[["ru","🇷🇺 RU"],["en","🇬🇧 EN"],["de","🇩🇪 DE"]].map(([v,l]) => (
                <button key={v} onClick={() => setSettings(s => ({ ...s, response_language: v }))}
                  className={`btn ${settings.response_language===v?"btn-primary":"btn-ghost"}`}
                  style={{ fontSize:11, padding:"4px 10px" }}>{l}
                </button>
              ))}
            </div>

            <button onClick={handleSaveSettings} disabled={settingsSaving}
              className="btn btn-primary" style={{ fontSize:12, padding:"6px 16px" }}>
              {settingsSaving ? "…" : t("ai.save")}
            </button>
          </div>
        )}
      </div>

      {/* ── Recommendations list ── */}
      {recsLoading ? (
        <div style={{ textAlign:"center", padding:60, color:"var(--tx3)" }}>
          <span className="loader" style={{ width:24, height:24, borderWidth:3 }} />
        </div>
      ) : pendingRecs.length === 0 ? (
        <div className="card" style={{ padding:"48px 32px", textAlign:"center" }}>
          <div style={{ marginBottom:12 }}><Sparkles size={36} strokeWidth={1.5} color="var(--tx3)" /></div>
          <div style={{ fontSize:14, color:"var(--tx3)" }}>{t("ai.noRecs")}</div>
        </div>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          {pendingRecs.map((rec, idx) => {
            const actions = typeof rec.actions === "string" ? JSON.parse(rec.actions) : (rec.actions || []);
            const ctx = typeof rec.context_snapshot === "string" ? JSON.parse(rec.context_snapshot) : (rec.context_snapshot || {});
            const riskColor = AI_RISK_COLOR[rec.risk_level] || "var(--b2)";

            return (
              <div key={rec.id} className="card" style={{ padding:"16px 20px", borderLeft:`3px solid ${riskColor}` }}>
                <div style={{ display:"flex", gap:12, alignItems:"flex-start" }}>
                  {/* Icon + priority */}
                  <div style={{ flexShrink:0, display:"flex", flexDirection:"column", alignItems:"center", gap:4, paddingTop:2 }}>
                    <span style={{ display:"flex", alignItems:"center", justifyContent:"center" }}>{AI_TYPE_ICON[rec.type] || <Sparkles size={20} strokeWidth={1.75} color="var(--teal)" />}</span>
                    <span style={{ fontSize:10, color:"var(--tx3)", fontFamily:"var(--mono)" }}>#{idx+1}</span>
                  </div>

                  {/* Content */}
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:"flex", gap:8, alignItems:"center", marginBottom:6, flexWrap:"wrap" }}>
                      <span style={{ fontSize:14, fontWeight:600 }}>{rec.title}</span>
                      <span className={`badge bg-${rec.risk_level === "low" ? "grn" : rec.risk_level === "high" ? "red" : "amb"}`} style={{ fontSize:10 }}>
                        {rec.risk_level}
                      </span>
                      <span className="badge bg-bl" style={{ fontSize:10 }}>{rec.type?.replace(/_/g," ")}</span>
                    </div>

                    <div style={{ fontSize:13, color:"var(--tx2)", marginBottom:8, lineHeight:1.6 }}>{rec.rationale}</div>

                    {rec.expected_effect && (
                      <div style={{ fontSize:12, color:"var(--grn)", marginBottom:8,
                        padding:"5px 10px", background:"rgba(34,197,94,.08)",
                        borderRadius:6, display:"inline-block" }}>
                        → {rec.expected_effect}
                      </div>
                    )}

                    {actions.length > 0 && (
                      <div style={{ marginBottom:10 }}>
                        {actions.map((a, ai) => (
                          <div key={ai} style={{ fontSize:11, color:"var(--tx3)", padding:"2px 0",
                            display:"flex", gap:6, alignItems:"center" }}>
                            <ChevronRight size={11} strokeWidth={1.75} color="var(--ac2)" />
                            <span style={{ fontFamily:"var(--mono)" }}>{a.entity_name || a.entity_id}</span>
                            <span>—</span>
                            <span>{a.action_type?.replace(/_/g," ")}</span>
                            {a.params && Object.keys(a.params).length > 0 && renderAiParams(a.params)}
                          </div>
                        ))}
                      </div>
                    )}

                    <div style={{ fontSize:11, color:"var(--tx3)" }}>
                      {new Date(rec.created_at).toLocaleString(undefined, { day:"2-digit", month:"short", hour:"2-digit", minute:"2-digit" })}
                      {ctx.prompt && <span style={{ marginLeft:8, fontStyle:"italic" }}>• «{ctx.prompt.slice(0,60)}{ctx.prompt.length>60?"…":""}»</span>}
                    </div>
                  </div>

                  {/* Buttons */}
                  <div style={{ display:"flex", flexDirection:"column", gap:6, flexShrink:0 }}>
                    <button onClick={() => setConfirmRec(rec)} disabled={applying === rec.id}
                      className="btn btn-green" style={{ fontSize:11, padding:"5px 12px" }}>
                      {applying === rec.id ? <span className="loader" /> : <><Check size={12} strokeWidth={1.75} /> {t("ai.apply")}</>}
                    </button>
                    <button onClick={() => handlePreview(rec)}
                      className="btn btn-ghost" style={{ fontSize:11, padding:"5px 12px" }}>
                      <Ic icon={Eye} size={12} /> {t("ai.preview")}
                    </button>
                    <button onClick={() => handleDismiss(rec.id)}
                      className="btn btn-red" style={{ fontSize:11, padding:"5px 12px" }}>
                      <X size={12} strokeWidth={1.75} /> {t("ai.dismiss")}
                    </button>
                  </div>
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
      setProfile(d); showToast(t("settings.saveChanges"));
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
      showToast(t("settings.changePassword"));
    } catch (e) { setPwErr(e.message); }
    setSaving(false);
  }

  async function saveWorkspace() {
    setSaving(true);
    try {
      const d = await apiFetch("/settings/workspace", { method: "PATCH", body: JSON.stringify(wsForm) });
      setWsData(d); showToast(t("settings.saveChanges"));
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
      showToast(t("settings.inviteSent"));
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
      showToast(t("settings.roleUpdated"));
    } catch (e) { showToast(e.message, true); }
  }

  async function removeMember(userId, name) {
    if (!confirm(`Remove ${name} from workspace?`)) return;
    try {
      await apiFetch(`/settings/members/${userId}`, { method: "DELETE" });
      setMembers(m => m.filter(x => x.id !== userId));
      showToast(t("settings.memberRemoved"));
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
      showToast(t("settings.workspaceDeleted"));
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
    { id: "profile",       icon: <Pencil size={13} strokeWidth={1.75} />,       label: t("settings.profile") },
    { id: "workspace",     icon: <Settings size={13} strokeWidth={1.75} />,     label: t("settings.workspace") },
    { id: "team",          icon: <Activity size={13} strokeWidth={1.75} />,     label: t("settings.team") },
    { id: "notifications", icon: <Bell size={13} strokeWidth={1.75} />,         label: t("settings.notifications") },
    { id: "security",      icon: <Lock size={13} strokeWidth={1.75} />,         label: t("settings.security") },
    { id: "danger",        icon: <AlertCircle size={13} strokeWidth={1.75} />,  label: t("settings.dangerZone") },
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
                    { key: "timezone", label: t("settings.timezone"), opts: ["UTC","Europe/Berlin","Europe/London","America/New_York","America/Los_Angeles","Asia/Tokyo"] },
                    { key: "default_attribution_window", label: t("settings.attributionWindow"), opts: ["1d","7d","14d","30d"], tip: t("settings.attributionWindowTip") },
                    { key: "currency", label: t("settings.currency"), opts: ["EUR","USD","GBP","JPY","CAD","AUD","PLN","SEK"] },
                  ].map(({ key, label, opts, tip }) => (
                    <div key={key}>
                      <div style={SL}>
                        {tip ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            {label}
                            <Tip text={tip} width={240}>
                              <Ic icon={HelpCircle} size={11} style={{ color: 'var(--tx3)', cursor: 'help' }} />
                            </Tip>
                          </span>
                        ) : label}
                      </div>
                      <select value={wsForm.settings[key] || opts[0]} onChange={e => setWsForm(f => ({...f, settings: {...f.settings, [key]: e.target.value}}))} style={{ width: "100%", minWidth: 200 }}>
                        {opts.map(o => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
                <div style={{ marginBottom: 14 }}>
                  <div style={SL}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      Target ACOS (%)
                      <Tip text="Your profitability target. Used to color-code ACOS on the dashboard. Typical range: 15–30%." width={240}>
                        <Ic icon={HelpCircle} size={11} style={{ color: 'var(--tx3)', cursor: 'help' }} />
                      </Tip>
                    </span>
                  </div>
                  <input
                    type="number"
                    min="1" max="200" step="0.1"
                    placeholder="e.g. 20"
                    value={wsForm.settings.target_acos || ''}
                    onChange={e => setWsForm(f => ({ ...f, settings: { ...f.settings, target_acos: e.target.value } }))}
                    style={{ width: 140 }}
                  />
                  <div style={{ fontSize: 11, color: 'var(--tx3)', marginTop: 3 }}>
                    SP campaigns: aim for 15–25%. SB/SD: typically 25–40%.
                  </div>
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
                { heading: t("settings.notificationsTitle"), keys: [
                  { key: "email_alerts",        label: t("settings.notifCampaignAlerts") },
                  { key: "email_weekly_report", label: t("settings.notifWeeklyReport") },
                  { key: "email_ai_summary",    label: t("settings.notifAiSummary") },
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
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>{t("settings.currentSession")}</div>
              <div style={{ fontSize: 12, color: "var(--tx2)", marginBottom: 12 }}>{navigator.userAgent.slice(0, 80)}</div>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => showToast(t("common.comingSoon"))}>
                {t("settings.signOutOtherSessions")}
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
        <div style={{ marginBottom: 12, color: "var(--tx3)" }}><Cog size={36} strokeWidth={1.5} /></div>
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
  const [active, setActive] = useState(() => localStorage.getItem("af_page") || "overview");
  const [syncTrigger, setSyncTrigger] = useState(0);
  const [toast, setToast] = useState(null);
  const [theme, setTheme] = useState(() => localStorage.getItem("af_theme") || "dark");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("af_sidebar") === "1");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("af_theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("af_sidebar", sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);

  const toggleTheme = () => setTheme(t => t === "dark" ? "light" : "dark");
  const toggleSidebar = () => setSidebarCollapsed(c => !c);

  // Detect /invite/:token path
  const inviteTokenMatch = window.location.pathname.match(/^\/invite\/([a-f0-9]{64})$/);
  const inviteToken = inviteTokenMatch?.[1] || null;

  // Detect /reset-password/:token path
  const resetTokenMatch = window.location.pathname.match(/^\/reset-password\/([a-f0-9]{64})$/);
  const resetToken = resetTokenMatch?.[1] || null;

  useEffect(() => {
    const handler = (e) => { setToast(e.detail); setTimeout(() => setToast(null), 2000); };
    window.addEventListener("af:toast", handler);
    return () => window.removeEventListener("af:toast", handler);
  }, []);

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

  function handleLogout() {
    localStorage.removeItem("af_token");
    localStorage.removeItem("af_workspace");
    localStorage.removeItem("af_page");
    setAuthed(false);
    setUser(null);
    setWorkspace(null);
  }

  if (inviteToken) return <InvitePage token={inviteToken} onLogin={handleLogin} />;
  if (resetToken)  return <ResetPasswordPage token={resetToken} onLogin={handleLogin} />;
  if (!authed) return <LoginPage onLogin={handleLogin} />;

  const wid = workspace?.id || localStorage.getItem("af_workspace");

  const handleSettingsUpdate = (newSettings) => {
    setUser(u => ({ ...u, settings: { ...(u?.settings || {}), ...newSettings } }));
  };

  const pages = {
    overview: <OverviewPage workspaceId={wid} user={user} onSettingsUpdate={handleSettingsUpdate} onNavigate={setActive} />,
    campaigns: <CampaignsPage workspaceId={wid} />,
    products: <ProductsPage workspaceId={wid} />,
    keywords: <KeywordsPage workspaceId={wid} />,
    reports: <ReportsPage workspaceId={wid} />,
    analytics: <AnalyticsPage workspaceId={wid} />,
    rules: <RulesPage workspaceId={wid} />,
    strategies: <StrategiesPage workspaceId={wid} />,
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
        <Sidebar active={active} setActive={(p) => { localStorage.setItem("af_page", p); setActive(p); }} user={user} workspace={workspace} onLogout={handleLogout} theme={theme} toggleTheme={toggleTheme} collapsed={sidebarCollapsed} toggleCollapsed={toggleSidebar} />

        {/* ── Fixed sidebar edge toggle — stays at the boundary regardless of state ── */}
        <button
          onClick={toggleSidebar}
          title={sidebarCollapsed ? t("common.expandSidebar") : t("common.collapseSidebar")}
          style={{
            position: "fixed",
            left: (sidebarCollapsed ? SIDEBAR_W_COLLAPSED : SIDEBAR_W) - 12,
            top: 20,
            zIndex: 200,
            width: 24, height: 24,
            borderRadius: "50%",
            background: "var(--s1)",
            border: "1px solid var(--b2)",
            boxShadow: "0 1px 4px rgba(0,0,0,.18)",
            cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--tx3)",
            transition: "left 220ms cubic-bezier(0.4,0,0.2,1), background 150ms, color 150ms",
            padding: 0,
          }}
          onMouseEnter={e => { e.currentTarget.style.background = "var(--s3)"; e.currentTarget.style.color = "var(--tx)"; }}
          onMouseLeave={e => { e.currentTarget.style.background = "var(--s1)"; e.currentTarget.style.color = "var(--tx3)"; }}
        >
          <Ic icon={sidebarCollapsed ? ChevronRight : ChevronLeft} size={13} />
        </button>

        <main style={{ marginLeft: sidebarCollapsed ? SIDEBAR_W_COLLAPSED : SIDEBAR_W, flex: 1, padding: "26px 30px", minHeight: "100vh", overflow: "auto", transition: "margin-left 220ms cubic-bezier(0.4,0,0.2,1)" }}>
          {pages[active]}
        </main>
      </div>
      <SyncStatusToast triggerShow={syncTrigger} />
      <GlobalProgressBar workspaceId={wid} />
      {toast && (
        <div style={{
          position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)",
          zIndex: 3000, background: toast.ok ? "rgba(34,197,94,.15)" : "rgba(239,68,68,.15)",
          border: `1px solid ${toast.ok ? "rgba(34,197,94,.35)" : "rgba(239,68,68,.35)"}`,
          color: toast.ok ? "var(--grn)" : "var(--red)",
          borderRadius: 8, padding: "8px 20px", fontSize: 13, fontWeight: 500,
          boxShadow: "0 4px 16px rgba(0,0,0,.4)", animation: "fadeIn .2s ease both",
          whiteSpace: "nowrap",
        }}>
          {toast.msg}
        </div>
      )}
    </>
  );
}
