import axios from "axios";

const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:4000/api/v1";

export const api = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  withCredentials: true,
});

// ─── Auth token injection ─────────────────────────────────────────────────────
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("adsflow_token");
  const workspaceId = localStorage.getItem("adsflow_workspace");

  if (token) config.headers.Authorization = `Bearer ${token}`;
  if (workspaceId) config.headers["x-workspace-id"] = workspaceId;
  return config;
});

// ─── 401 handler ─────────────────────────────────────────────────────────────
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && err.response?.data?.code === "TOKEN_EXPIRED") {
      localStorage.removeItem("adsflow_token");
      window.location.href = "/login";
    }
    return Promise.reject(err);
  }
);

// ─── API methods ──────────────────────────────────────────────────────────────
export const authApi = {
  login: (email, password) => api.post("/auth/login", { email, password }),
  register: (data) => api.post("/auth/register", data),
  me: () => api.get("/auth/me"),
};

export const connectionsApi = {
  initAmazonAuth: () => api.get("/connections/amazon/init"),
  callback: (code, state, workspaceId) =>
    api.post("/connections/amazon/callback", { code, state, workspaceId }),
  list: () => api.get("/connections"),
  getProfiles: (connectionId) => api.get(`/connections/${connectionId}/profiles`),
  attachProfiles: (connectionId, profileIds, workspaceId) =>
    api.post(`/connections/${connectionId}/profiles/attach`, { profileIds, workspaceId }),
  revoke: (connectionId) => api.delete(`/connections/${connectionId}`),
};

export const profilesApi = {
  list: (workspaceId) => api.get("/profiles", { params: { workspaceId } }),
  sync: (profileId) => api.post(`/profiles/${profileId}/sync`),
};

export const campaignsApi = {
  list: (params) => api.get("/campaigns", { params }),
  get: (id) => api.get(`/campaigns/${id}`),
  update: (id, data) => api.patch(`/campaigns/${id}`, data),
  getMetrics: (id, params) => api.get(`/campaigns/${id}/metrics`, { params }),
};

export const metricsApi = {
  summary: (params) => api.get("/metrics/summary", { params }),
  topCampaigns: (params) => api.get("/metrics/top-campaigns", { params }),
};

export const reportsApi = {
  list: () => api.get("/reports"),
  create: (data) => api.post("/reports", data),
};

export const auditApi = {
  list: (params) => api.get("/audit", { params }),
};

export const jobsApi = {
  status: () => api.get("/jobs"),
};
