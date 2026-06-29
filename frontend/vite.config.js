import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true,
    proxy: { "/api": "http://backend:4000" },
    watch: { usePolling: true, interval: 800 },
    // Disable the dev-server error overlay: bots probe paths like /.aws/config
    // & /.aws/credentials, which the dev server fails to load and then
    // broadcasts as a full-screen overlay to every connected client. HMR
    // itself stays on.
    hmr: { overlay: false },
  },
  // Production serving: the container builds `dist` at start (so the runtime
  // VITE_API_URL is baked in) and serves it via `vite preview`. The app calls
  // the backend through the absolute VITE_API_URL, so no /api proxy is needed.
  preview: {
    port: 3000,
    host: true,
    strictPort: true,
  },
});
