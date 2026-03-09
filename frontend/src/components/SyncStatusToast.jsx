import { useState, useEffect, useRef, useCallback } from "react";
import { useI18n } from "../i18n/index.jsx";

const API = (import.meta?.env?.VITE_API_URL) || "http://localhost:4000/api/v1";

async function apiFetchSync(path) {
  const token = localStorage.getItem("af_token");
  const wsId = localStorage.getItem("af_workspace");
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (wsId) headers["x-workspace-id"] = wsId;
  try {
    const res = await fetch(`${API}${path}`, { headers });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function apiPostSync(path) {
  const token = localStorage.getItem("af_token");
  const wsId = localStorage.getItem("af_workspace");
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (wsId) headers["x-workspace-id"] = wsId;
  try {
    await fetch(`${API}${path}`, { method: "POST", headers });
  } catch {
    // ignore
  }
}

export default function SyncStatusToast({ triggerShow = 0 }) {
  const { t } = useI18n();
  const [status, setStatus] = useState(null);
  const [visible, setVisible] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const hideTimerRef = useRef(null);
  const visibleRef = useRef(false);
  visibleRef.current = visible;

  const fetchStatus = useCallback(async () => {
    const data = await apiFetchSync("/connections/sync/status");
    if (!data) return;
    setStatus(data);

    const hasActive = data.activeSyncCount > 0;
    const hasError = !!data.lastError;

    if (hasActive || hasError) {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      setVisible(true);
    } else if (visibleRef.current && !hasActive && !hasError) {
      // All syncs complete — auto-hide after 10s
      if (!hideTimerRef.current) {
        hideTimerRef.current = setTimeout(() => {
          setVisible(false);
          hideTimerRef.current = null;
        }, 10000);
      }
    }
  }, []);

  // Initial check on mount
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Poll every 5s while visible
  useEffect(() => {
    if (!visible) return;
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [visible, fetchStatus]);

  // Show immediately on external trigger (e.g. after profile attach)
  useEffect(() => {
    if (triggerShow > 0) {
      setVisible(true);
      fetchStatus();
    }
  }, [triggerShow, fetchStatus]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  function dismiss() {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    setVisible(false);
  }

  async function handleRetry() {
    if (!status || retrying) return;
    setRetrying(true);

    const failedIds = [
      ...new Set(
        status.profiles
          .filter(p => p.syncStatus === "error" || p.error)
          .map(p => p.connectionId)
          .filter(Boolean)
      ),
    ];
    const idsToRetry =
      failedIds.length > 0
        ? failedIds
        : [...new Set(status.profiles.map(p => p.connectionId).filter(Boolean))];

    for (const id of idsToRetry) {
      await apiPostSync(`/connections/${id}/sync`);
    }

    setRetrying(false);
    fetchStatus();
  }

  if (!visible || !status) return null;

  const { profiles, activeSyncCount, lastError } = status;
  const isSyncing = activeSyncCount > 0;
  const isError = !!lastError;
  const isSuccess = !isSyncing && !isError && profiles.length > 0;

  const totalCampaigns = profiles.reduce((s, p) => s + (p.campaignCount || 0), 0);
  const totalKeywords = profiles.reduce((s, p) => s + (p.keywordCount || 0), 0);
  const lastSyncedAt = profiles.reduce((latest, p) => {
    if (!p.lastSyncedAt) return latest;
    return !latest || new Date(p.lastSyncedAt) > new Date(latest) ? p.lastSyncedAt : latest;
  }, null);
  const syncingProfiles = profiles.filter(
    p => p.syncStatus === "syncing" || p.syncStatus === "pending"
  );

  const borderColor = isError
    ? "rgba(239,68,68,.35)"
    : isSyncing
    ? "rgba(59,130,246,.35)"
    : "rgba(34,197,94,.35)";

  return (
    <>
      <style>{`
        @keyframes syncProgress {
          0%   { transform: translateX(-150%); }
          100% { transform: translateX(350%); }
        }
      `}</style>
      <div style={{
        position: "fixed",
        bottom: 24,
        right: 24,
        zIndex: 500,
        width: 320,
        background: "var(--s1)",
        border: `1px solid ${borderColor}`,
        borderRadius: 12,
        boxShadow: "0 8px 32px rgba(0,0,0,.45)",
        overflow: "hidden",
        animation: "fadeIn .3s ease both",
      }}>
        {/* Header */}
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "11px 14px 10px",
          borderBottom: "1px solid var(--b1)",
        }}>
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
            {isSyncing && (
              <div style={{
                width: 13, height: 13,
                border: "2px solid rgba(59,130,246,.25)",
                borderTopColor: "var(--ac)",
                borderRadius: "50%",
                animation: "spin .7s linear infinite",
                flexShrink: 0,
              }} />
            )}
            {isError && (
              <span style={{ color: "var(--red)", fontSize: 15, flexShrink: 0, lineHeight: 1 }}>✕</span>
            )}
            {isSuccess && (
              <span style={{ color: "var(--grn)", fontSize: 15, flexShrink: 0, lineHeight: 1 }}>✓</span>
            )}
            <span style={{
              fontSize: 13, fontWeight: 600,
              color: isError ? "var(--red)" : isSyncing ? "var(--ac2)" : "var(--grn)",
            }}>
              {isSyncing ? t("sync.syncing") : isError ? t("sync.error") : t("sync.complete")}
            </span>
          </div>
          <button
            onClick={dismiss}
            style={{
              background: "none", border: "none", color: "var(--tx3)",
              cursor: "pointer", fontSize: 18, padding: "0 2px", lineHeight: 1,
            }}
            title="Dismiss"
          >×</button>
        </div>

        {/* Body */}
        <div style={{ padding: "10px 14px 14px" }}>

          {/* SYNCING state */}
          {isSyncing && (
            <>
              {/* Indeterminate progress bar */}
              <div style={{
                height: 3, background: "var(--b2)", borderRadius: 2,
                overflow: "hidden", marginBottom: 10,
              }}>
                <div style={{
                  height: "100%", width: "40%",
                  background: "linear-gradient(90deg, transparent, var(--ac), transparent)",
                  borderRadius: 2,
                  animation: "syncProgress 1.4s ease-in-out infinite",
                }} />
              </div>

              {syncingProfiles.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  {syncingProfiles.map(p => (
                    <div key={p.id} style={{
                      display: "flex", alignItems: "center", gap: 6,
                      fontSize: 12, color: "var(--tx2)", marginBottom: 4,
                    }}>
                      <span style={{
                        width: 6, height: 6, borderRadius: "50%",
                        background: "var(--ac)", flexShrink: 0,
                        animation: "pulse 1.5s infinite",
                      }} />
                      <span style={{
                        flex: 1, overflow: "hidden",
                        textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>
                        {p.accountName || p.id}
                      </span>
                      <span style={{
                        fontSize: 10, fontFamily: "var(--mono)",
                        color: "var(--ac2)", flexShrink: 0,
                      }}>{p.marketplace}</span>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ fontSize: 11, color: "var(--tx3)", fontFamily: "var(--mono)" }}>
                {t("sync.loading")}
              </div>
            </>
          )}

          {/* SUCCESS state */}
          {isSuccess && (
            <>
              <div style={{ fontSize: 13, color: "var(--tx2)", marginBottom: 6 }}>
                <span style={{ fontFamily: "var(--mono)", color: "var(--ac2)" }}>{totalCampaigns}</span>
                {" "}{t("sync.campaigns")}{" · "}
                <span style={{ fontFamily: "var(--mono)", color: "var(--ac2)" }}>{totalKeywords}</span>
                {" "}{t("sync.keywords")}
              </div>
              {lastSyncedAt && (
                <div style={{ fontSize: 11, color: "var(--tx3)", fontFamily: "var(--mono)" }}>
                  {t("sync.lastSync")}: {new Date(lastSyncedAt).toLocaleString()}
                </div>
              )}
            </>
          )}

          {/* ERROR state */}
          {isError && (
            <>
              <div style={{
                fontSize: 12, color: "var(--tx2)", marginBottom: 10,
                wordBreak: "break-word", lineHeight: 1.5,
              }}>
                {lastError}
              </div>
              <button
                className="btn btn-red"
                onClick={handleRetry}
                disabled={retrying}
                style={{ fontSize: 12, padding: "5px 12px" }}
              >
                {retrying && (
                  <span style={{
                    width: 10, height: 10, borderRadius: "50%",
                    border: "2px solid rgba(239,68,68,.3)", borderTopColor: "var(--red)",
                    animation: "spin .7s linear infinite", display: "inline-block",
                  }} />
                )}
                {t("sync.retry")}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
