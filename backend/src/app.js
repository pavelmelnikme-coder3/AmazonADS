require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const cookieParser = require("cookie-parser");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const logger = require("./config/logger");
const { connectDB } = require("./db/pool");
const { runMigrations } = require("./db/migrate");
const { connectRedis } = require("./config/redis");
const { startWorkers } = require("./jobs/workers");
const { startScheduler } = require("./jobs/scheduler");

// Routes
const authRoutes = require("./routes/auth");
const connectionsRoutes = require("./routes/connections");
const profilesRoutes = require("./routes/profiles");
const campaignsRoutes = require("./routes/campaigns");
const adGroupsRoutes = require("./routes/adGroups");
const keywordsRoutes = require("./routes/keywords");
const reportsRoutes = require("./routes/reports");
const metricsRoutes = require("./routes/metrics");
const rulesRoutes = require("./routes/rules");
const alertsRoutes = require("./routes/alerts");
const auditRoutes = require("./routes/audit");
const aiRoutes = require("./routes/ai");
const jobsRoutes = require("./routes/jobs");
const bulkRoutes = require("./routes/bulk");
const settingsRoutes = require("./routes/settings");
const productsRoutes = require("./routes/products");
const spRoutes = require("./routes/sp");
const analyticsReportRouter = require("./routes/analyticsReport");
const searchTermsRoutes = require("./routes/searchTerms");
const negativeKeywordsRoutes = require("./routes/negativeKeywords");
const strategiesRoutes = require("./routes/strategies");

const app = express();

// ─── Security middleware ───────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Handled by frontend
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-workspace-id"],
}));

// ─── General middleware ────────────────────────────────────────────────────────
app.use(compression());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(morgan("combined", { stream: { write: (msg) => logger.info(msg.trim()) } }));

// ─── Rate limiting ─────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down." },
});
app.use("/api/", limiter);

// Stricter limit for auth endpoints (brute-force protection)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again in 15 minutes." },
});
app.use("/api/v1/auth/login", authLimiter);
app.use("/api/v1/auth/register", authLimiter);
app.use("/api/v1/auth/accept-invite", authLimiter);

// ─── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString(), version: "1.0.0" });
});

// ─── API Routes ────────────────────────────────────────────────────────────────
const API = "/api/v1";

app.use(`${API}/auth`, authRoutes);
app.use(`${API}/connections`, connectionsRoutes);
app.use(`${API}/profiles`, profilesRoutes);
app.use(`${API}/campaigns`, campaignsRoutes);
app.use(`${API}/ad-groups`, adGroupsRoutes);
app.use(`${API}/keywords`, keywordsRoutes);
app.use(`${API}/reports`, reportsRoutes);
app.use(`${API}/metrics`, metricsRoutes);
app.use(`${API}/rules`, rulesRoutes);
app.use(`${API}/alerts`, alertsRoutes);
app.use(`${API}/audit`, auditRoutes);
app.use(`${API}/ai`, aiRoutes);
app.use(`${API}/jobs`, jobsRoutes);
app.use(`${API}/bulk`, bulkRoutes);
app.use(`${API}/settings`, settingsRoutes);
app.use(`${API}/products`, productsRoutes);
app.use(`${API}/sp`, spRoutes);
app.use(`${API}/analytics-report`, analyticsReportRouter);
app.use(`${API}/search-terms`, searchTermsRoutes);
app.use(`${API}/negative-keywords`, negativeKeywordsRoutes);
app.use(`${API}/strategies`, strategiesRoutes);

// ─── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  const message = err.expose ? err.message : (status < 500 ? err.message : "Internal server error");

  if (status >= 500) {
    logger.error("Unhandled error", { error: err.message, stack: err.stack, path: req.path });
  }

  res.status(status).json({
    error: message,
    ...(process.env.NODE_ENV === "development" && status >= 500 ? { stack: err.stack } : {}),
  });
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────
async function bootstrap() {
  try {
    await connectDB();
    logger.info("✓ PostgreSQL connected");

    await runMigrations();
    logger.info("✓ Migrations applied");

    await connectRedis();
    logger.info("✓ Redis connected");

    await startWorkers();
    logger.info("✓ BullMQ workers started");

    await startScheduler();
    logger.info("✓ Cron scheduler started");

    const PORT = process.env.PORT || 4000;
    app.listen(PORT, () => {
      logger.info(`✓ AdsFlow backend running on http://localhost:${PORT}`);
      logger.info(`  API: http://localhost:${PORT}/api/v1`);
    });
  } catch (err) {
    logger.error("Bootstrap failed", { error: err.message });
    process.exit(1);
  }
}

bootstrap();

module.exports = app;
