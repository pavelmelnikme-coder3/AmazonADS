# Contributing to AdsFlow

Welcome! This guide helps new developers get up to speed quickly and work safely on the project.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Local Setup](#local-setup)
3. [Project Structure](#project-structure)
4. [Development Workflow](#development-workflow)
5. [Code Conventions](#code-conventions)
6. [Branch Strategy](#branch-strategy)
7. [Commit Message Format](#commit-message-format)
8. [Environment Variables](#environment-variables)
9. [Testing](#testing)
10. [Deployment](#deployment)

---

## Project Overview

**AdsFlow** is a full-stack Amazon Ads management dashboard built for agencies and brands. It connects to the Amazon Ads API to sync campaign data, provides analytics, and will include AI-driven optimization recommendations.

**Tech stack:**
- **Frontend:** React 18 + Vite, CSS variables (dark theme), i18n (RU/EN)
- **Backend:** Node.js + Express.js, JWT auth, RBAC
- **Queue:** BullMQ + Redis
- **Database:** PostgreSQL
- **Infrastructure:** Docker Compose

---

## Local Setup

### Prerequisites
- Docker Desktop (v24+)
- Node.js 20+ (for running Claude Code or local scripts)
- Git

### First-time setup

```bash
# 1. Clone the repo
git clone https://github.com/pavelmelnikme-coder3/AmazonADS.git
cd AmazonADS

# 2. Copy and fill environment variables
cp .env.example .env
# Edit .env — see "Environment Variables" section below

# 3. Start all services
docker compose up --build -d

# 4. Verify everything is running
docker compose ps
curl http://localhost:4000/health

# 5. Open the app
open http://localhost:3000
```

### Subsequent starts

```bash
docker compose up -d          # start without rebuilding
docker compose up --build -d  # start with rebuild (after code changes)
docker compose down           # stop all services
```

### Useful commands

```bash
# View logs
docker compose logs -f backend
docker compose logs -f frontend

# Access database
docker compose exec postgres psql -U adsflow -d adsflow

# Access Redis
docker compose exec redis redis-cli

# Rebuild only one service
docker compose up --build -d backend
```

---

## Project Structure

```
adsflow/
├── docker-compose.yml          # Service orchestration
├── .env.example                # Environment variable template
├── .gitignore
├── CHANGELOG.md                # Version history (update on every release!)
├── README.md                   # Quick start guide
│
├── docs/
│   ├── ARCHITECTURE.md         # System design & data flow
│   ├── API.md                  # API endpoint reference
│   └── ROLLBACK.md             # How to roll back versions
│
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── app.js              # Express entry point, middleware, routes
│       ├── config/
│       │   ├── logger.js       # Winston logger
│       │   ├── redis.js        # Redis/BullMQ connection
│       │   └── encryption.js  # AES-256-GCM token encryption
│       ├── db/
│       │   ├── pool.js         # PostgreSQL connection pool
│       │   └── migrations/     # SQL migration files (run in order)
│       │       ├── 001_initial.sql
│       │       └── 003_rules_alerts.sql
│       ├── middleware/
│       │   └── auth.js         # JWT verification + RBAC checks
│       ├── services/amazon/
│       │   ├── lwa.js          # Login with Amazon OAuth flow
│       │   ├── adsClient.js    # Amazon Ads HTTP client + rate limiting
│       │   ├── entities.js     # Profiles/Campaigns/Keywords sync
│       │   └── reporting.js    # Reporting API v3 pipeline
│       ├── jobs/
│       │   ├── workers.js      # BullMQ workers (entity-sync, rule-engine)
│       │   └── scheduler.js    # Cron jobs (hourly sync, daily reports)
│       └── routes/
│           ├── auth.js         # POST /auth/register, /auth/login
│           ├── connections.js  # Amazon OAuth flow
│           ├── campaigns.js    # CRUD + status/budget updates
│           ├── keywords.js     # Keywords with inline bid editing
│           ├── rules.js        # Automation rules CRUD
│           ├── alerts.js       # Alert configs + triggered instances
│           ├── bulk.js         # Bulk status/budget/bid operations
│           ├── metrics.js      # KPI aggregations
│           ├── reports.js      # Report generation & download
│           └── audit.js        # Audit log viewer
│
└── frontend/
    ├── Dockerfile
    ├── package.json
    └── src/
        ├── main.jsx            # React entry point, wraps App in I18nProvider
        ├── App.jsx             # All pages & routing (single file SPA)
        ├── i18n/
        │   ├── index.jsx       # I18nProvider + useI18n() hook
        │   ├── en.js           # English translations
        │   └── ru.js           # Russian translations
        ├── components/
        │   └── LanguageSwitcher.jsx
        └── api/
            └── index.js        # Axios API client
```

---

## Development Workflow

### Before starting work

```bash
git checkout main
git pull origin main
git checkout -b feature/your-feature-name
```

### During development

```bash
# Rebuild after backend changes
docker compose up --build -d backend

# Frontend hot-reloads automatically via Vite
# No rebuild needed for frontend changes

# Check for errors
docker compose logs backend --tail=30
```

### Before committing

1. ✅ Test your changes in the browser
2. ✅ Check both RU and EN languages work for any new UI text
3. ✅ Add new translation keys to **both** `en.js` and `ru.js`
4. ✅ Update `CHANGELOG.md` under `[Unreleased]`
5. ✅ Make sure `.env` is not in your staged files: `git status`

### Submitting changes

```bash
git add .
git commit -m "feat: your descriptive message"
git push origin feature/your-feature-name
# Then open a Pull Request on GitHub
```

---

## Code Conventions

### Backend

- Use `async/await` — no callbacks or raw Promise chains
- Always wrap route handlers in `try/catch`, pass errors to `next(err)`
- Use `process.env.*` for all config — never hardcode secrets
- Log with `logger.info()` / `logger.error()` — never `console.log`
- RBAC: every protected route must call `requireAuth` middleware
- DB queries: use parameterized queries (`$1, $2`) — never string interpolation

```js
// ✅ Correct
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM rules WHERE workspace_id = $1', [wid]);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ❌ Wrong
router.get('/', async (req, res) => {
  const data = await pool.query(`SELECT * FROM rules WHERE id = ${req.params.id}`); // SQL injection!
  res.json(data);
});
```

### Frontend

- All user-facing strings **must** use `t()` from `useI18n()`:

```jsx
// ✅ Correct
const { t } = useI18n();
<h1>{t('campaigns.title')}</h1>

// ❌ Wrong
<h1>Кампании</h1>
<h1>Campaigns</h1>
```

- Add translation keys to **both** `src/i18n/en.js` and `src/i18n/ru.js`
- Use inline styles consistent with the dark theme CSS variables (`var(--s1)`, `var(--tx1)`, etc.)
- No external UI libraries — keep the bundle lean

---

## Branch Strategy

```
main          ← production-ready, always deployable
  └── feature/stage-3-ai     ← new features
  └── fix/keyword-bulk-crash ← bug fixes
  └── chore/update-deps      ← maintenance
```

- **Never commit directly to `main`** (except hotfixes with team approval)
- Branch names: `feature/`, `fix/`, `chore/`, `docs/`
- Merge via Pull Request with at least 1 review

---

## Commit Message Format

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <short description>

[optional body]
[optional footer]
```

**Types:**
| Type | Use for |
|------|---------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `chore` | Maintenance, deps, config |
| `refactor` | Code change without feature/fix |
| `test` | Adding or fixing tests |
| `perf` | Performance improvement |

**Examples:**
```
feat: add bulk keyword bid adjustment
fix: modal cut off at top on Rules page
docs: add CONTRIBUTING.md and ROLLBACK guide
chore: upgrade bullmq to 5.x
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|----------|----------|-------------|
| `POSTGRES_PASSWORD` | ✅ | PostgreSQL password |
| `DATABASE_URL` | ✅ | Full postgres connection string |
| `REDIS_URL` | ✅ | Redis connection string |
| `JWT_SECRET` | ✅ | Generate: `openssl rand -base64 32` |
| `ENCRYPTION_KEY` | ✅ | Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `AMAZON_CLIENT_ID` | ✅ | From Amazon Developer Console |
| `AMAZON_CLIENT_SECRET` | ✅ | From Amazon Developer Console |
| `AMAZON_REDIRECT_URI` | ✅ | Must match LwA Security Profile |
| `OPENAI_API_KEY` | ⬜ | Optional, for AI recommendations |
| `NODE_ENV` | ✅ | `development` or `production` |
| `PORT` | ✅ | Backend port (default: 4000) |
| `FRONTEND_URL` | ✅ | Frontend URL for CORS (default: http://localhost:3000) |

> ⚠️ **Never commit `.env` to git.** It is in `.gitignore`.

---

## Testing

Currently manual testing. Planned: Jest + Supertest for backend, Vitest for frontend.

**Manual test checklist before PR:**
- [ ] Login / Register works
- [ ] Amazon connection flow works (or returns expected error)
- [ ] Campaigns page loads
- [ ] Keywords page loads
- [ ] Rules: create, toggle active, delete
- [ ] Alerts: create, toggle enable
- [ ] Language switcher: RU ↔ EN all new strings translated
- [ ] No console errors in browser

---

## Deployment

**Production deployment** is not yet configured. Planned:
- CI/CD via GitHub Actions
- Docker images pushed to registry
- Deployed to AWS ECS or similar

For now, deploy manually:
```bash
git pull origin main
docker compose up --build -d
```
