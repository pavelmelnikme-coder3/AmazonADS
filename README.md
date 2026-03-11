# AdsFlow — Amazon Ads Dashboard

Полноценный дашборд для управления Amazon Ads кампаниями с AI-рекомендациями, автоматическими правилами, кастомизируемым обзорным дашбордом и поддержкой SP/SB/SD типов кампаний.

## ⚡ Быстрый старт

### 1. Получить Amazon LwA credentials

1. Перейти на https://developer.amazon.com/apps-and-games/console/app/list
2. Нажать **Create a New Security Profile**
3. Заполнить: Profile Name, Description, Privacy URL
4. Перейти в **Web Settings → Allowed Return URLs**: добавить `http://localhost:3000/connect/amazon/callback`
5. Скопировать **Client ID** и **Client Secret**
6. Получить доступ к Amazon Advertising API: https://advertising.amazon.com/API/docs/en-us/onboarding/overview

### 2. Настроить окружение

```bash
cp .env.example .env
```

Заполнить `.env`:
```env
AMAZON_CLIENT_ID=amzn1.application-oa2-client.XXXX
AMAZON_CLIENT_SECRET=your_secret_here
AMAZON_REDIRECT_URI=http://localhost:3000/connect/amazon/callback

AMAZON_ADS_API_URL=https://advertising-api.amazon.com
AMAZON_ADS_API_EU_URL=https://advertising-api-eu.amazon.com
AMAZON_ADS_API_FE_URL=https://advertising-api-fe.amazon.com

JWT_SECRET=$(openssl rand -base64 32)
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
POSTGRES_PASSWORD=your_db_password
```

### 3. Запустить

```bash
docker compose up -d
docker compose logs -f backend
curl http://localhost:4000/health
```

### 4. Открыть приложение

- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:4000/api/v1

### 5. Подключить Amazon

1. Зарегистрироваться → Подключения → Connect Amazon Ads Account
2. Авторизоваться на amazon.com
3. Выбрать профили → ждать синк (~3-10 мин)

---

## 🏗 Архитектура

```
┌──────────────────────────────────────────────────────────────────┐
│                  Frontend (React 18 + Vite)                       │
│  Overview · Campaigns · Keywords · Reports · Rules · Alerts       │
│  AI Assistant · Audit · Connections · Settings                    │
│  i18n: EN / RU / DE                                              │
└────────────────────────────┬─────────────────────────────────────┘
                             │ REST /api/v1
┌────────────────────────────▼─────────────────────────────────────┐
│                   Backend (Node.js / Express)                      │
│  Auth/RBAC (JWT)  ·  Amazon OAuth (LwA)  ·  Ads API Client       │
│  SP v3 POST /list  ·  SB v4  ·  SD                               │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │  BullMQ Workers (Redis)                                   │   │
│  │  entity-sync · report-pipeline · rule-engine              │   │
│  │  ai-analysis · metrics-backfill · bulk-operations         │   │
│  └───────────────────────────────────────────────────────────┘   │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│  PostgreSQL 16 (entities, metrics, rules, audit, user settings)   │
│  Redis 7 (BullMQ queues)                                         │
└──────────────────────────────────────────────────────────────────┘
```

---

## 📁 Структура проекта

```
adsflow/
├── docker-compose.yml
├── .env.example
├── backend/src/
│   ├── app.js                     # Express entry point
│   ├── config/
│   │   ├── logger.js              # Winston
│   │   ├── redis.js               # BullMQ connection
│   │   └── encryption.js          # AES-256-GCM
│   ├── db/
│   │   ├── pool.js                # PostgreSQL pool
│   │   └── migrations/
│   │       ├── 001_initial.sql    # Core schema
│   │       └── 002_add_region.sql # Amazon region column
│   ├── middleware/auth.js          # JWT + RBAC (loads user.settings)
│   ├── services/amazon/
│   │   ├── lwa.js                 # OAuth + token refresh
│   │   ├── adsClient.js           # HTTP client, rate limiting
│   │   ├── entities.js            # Sync: SP v3 POST /list + SB/SD
│   │   └── reporting.js           # Reporting API v3 async pipeline
│   ├── jobs/
│   │   ├── workers.js             # 7 BullMQ workers
│   │   └── scheduler.js           # Smart scheduler (hourly/daily/weekly)
│   └── routes/
│       ├── auth.js                # POST /login, GET /me, PATCH /me
│       ├── connections.js         # OAuth + PATCH /:id/schedule + POST /:id/sync
│       ├── profiles.js
│       ├── campaigns.js           # Server-side sort + pagination
│       ├── keywords.js            # Server-side sort + pagination
│       ├── metrics.js             # /summary, /top-campaigns, /by-type
│       ├── reports.js             # Paginated
│       ├── rules.js               # Paginated
│       ├── alerts.js              # Paginated (configs + instances)
│       ├── audit.js               # Server-side sort + pagination
│       ├── ai.js
│       └── jobs.js
└── frontend/src/
    ├── App.jsx                    # SPA — все страницы + компоненты
    └── i18n/
        ├── en.js
        ├── ru.js
        └── de.js
```

---

## 🔑 API endpoints

### Auth & User Settings
| Метод | URL | Описание |
|-------|-----|----------|
| POST | `/auth/register` | Регистрация |
| POST | `/auth/login` | Вход → JWT + `user.settings` |
| GET  | `/auth/me` | Текущий пользователь + `settings` |
| PATCH | `/auth/me` | Обновить `user.settings` (dashboard layout и др.) |

### Connections & Sync
| Метод | URL | Описание |
|-------|-----|----------|
| GET  | `/connections` | Список подключений (включает `sync_schedule`) |
| GET  | `/connections/amazon/init` | OAuth URL |
| POST | `/connections/amazon/callback` | OAuth callback |
| PATCH | `/connections/:id/schedule` | Расписание (`hourly`/`daily`/`weekly`) |
| POST | `/connections/:id/sync` | Запустить entity sync вручную |
| POST | `/connections/:id/profiles/attach` | Привязать профили |

### Campaigns & Keywords
| Метод | URL | Описание |
|-------|-----|----------|
| GET  | `/campaigns` | Список, сортировка, фильтры, пагинация |
| PATCH | `/campaigns/:id` | state / budget |
| POST | `/campaigns/bulk` | Bulk update |
| GET  | `/keywords` | Список, сортировка, фильтры, пагинация |
| PATCH | `/keywords/bulk` | Bulk bid update |

### Metrics
| Метод | URL | Описание |
|-------|-----|----------|
| GET | `/metrics/summary` | KPI + дельты к пред. периоду + тренд по дням |
| GET | `/metrics/top-campaigns` | Топ кампании по spend |
| GET | `/metrics/by-type` | Разбивка по типу кампании (SP / SD / SB) |

### Reports, Rules, Alerts
| Метод | URL | Описание |
|-------|-----|----------|
| GET  | `/reports` | Список запросов отчётов (пагинация) |
| POST | `/reports` | Запустить отчёт |
| GET  | `/rules` | Список правил (пагинация) |
| POST/PATCH/DELETE | `/rules/:id` | CRUD правила |
| POST | `/rules/:id/run` | Запуск (`dry_run` поддерживается) |
| GET  | `/alerts` | Конфиги оповещений (пагинация) |
| GET  | `/alerts/instances` | Срабатывания (пагинация) |
| PATCH | `/alerts/:id/acknowledge` | Подтвердить оповещение |

### Audit & AI
| Метод | URL | Описание |
|-------|-----|----------|
| GET  | `/audit` | Журнал событий (сортировка + пагинация) |
| GET  | `/ai/recommendations` | AI рекомендации |
| POST | `/ai/recommendations/:id/apply` | Применить |
| POST | `/ai/recommendations/:id/dismiss` | Отклонить |

---

## 📊 Страницы приложения

### Обзор — кастомизируемый дашборд

Переключатель **7d / 14d / 30d** · кнопки **↺ Обновить** и **⟳ Синхронизировать** · **⊞ Настроить**

**16 виджетов:**

| Группа | Виджеты |
|--------|---------|
| KPI (half-width) | Spend, Sales, ACOS, ROAS, Клики, Показы, Заказы, CTR, CPC |
| Графики (full-width) | Динамика Spend (барчарт по дням), Мульти-тренд (клики + продажи) |
| Таблицы (full-width) | Топ кампании, По типу кампании (SP/SB/SD) |
| Другое | Оповещения (half), ИИ Рекомендации (full), Статус синхронизации (half) |

**Дефолт:** Spend · Sales · ACOS · ROAS · Клики · Показы · Динамика Spend · Топ кампании

**Режим ⊞ Настроить:**
- Палитра с кнопками `✓ активен` / `+ добавить` по группам
- Контролы на каждом виджете: **↑↓** (позиция) · **⇔** (half↔full) · **✕** (удалить)
- **↺ Сброс** — вернуть дефолтный лейаут
- Автосохранение debounced 800ms → `PATCH /auth/me` → `users.settings.dashboardLayout`
- Лейаут **индивидуален** для каждого пользователя, персистентен между сессиями

### Кампании
- Сортировка по любому столбцу (server-side), фильтр статуса, поиск, пагинация 25/50/100/200

### Ключевые слова
- 33 689+ записей, сортировка, фильтр, поиск, bid inline, пагинация 25/50/100/200/500

### Отчёты · Правила · Оповещения · Аудит
- Пагинация на каждой странице с выбором размера страницы и smart page range

### Подключения
- Расписание синхронизации per-connection: **Каждый час / Раз в день / Раз в неделю**
- Кнопка ручного запуска синхронизации

---

## ⚙️ Умный планировщик синхронизации

```
scheduler.js — запускается каждый час, проверяет все подключения:
  hourly  → синк если прошло > 1 час
  daily   → синк если прошло > 23 часа
  weekly  → синк если прошло > 6.5 суток
```

Расписание в `amazon_connections.sync_schedule TEXT DEFAULT 'daily' CHECK IN ('hourly','daily','weekly')`.

---

## 🗄 DB изменения (run directly, not via migration files)

```sql
-- Пользовательские настройки (лейаут дашборда и др.)
ALTER TABLE users ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}';

-- Расписание синхронизации
ALTER TABLE amazon_connections
  ADD COLUMN IF NOT EXISTS sync_schedule TEXT NOT NULL DEFAULT 'daily'
  CHECK (sync_schedule IN ('hourly','daily','weekly'));
```

---

## ⚠️ Amazon SP v3 — критические детали

Amazon Sponsored Products API v3 **требует POST /list** (не GET).

```
POST /sp/campaigns/list    Content-Type: application/vnd.spCampaign.v3+json
POST /sp/adGroups/list     Content-Type: application/vnd.spAdGroup.v3+json
POST /sp/keywords/list     Content-Type: application/vnd.spKeyword.v3+json
```

Тело:
```json
{ "stateFilter": { "include": ["ENABLED","PAUSED","ARCHIVED"] }, "maxResults": 100, "nextToken": "..." }
```

- `state` в UPPERCASE → нормализуем `.toLowerCase()`
- `budget` → `c.dailyBudget ?? c.budget?.budget`
- Пагинация: `nextToken` (не `startIndex`)

SB v4 и SD используют GET-endpoints.

---

## 🤖 AI Orchestrator

Claude claude-sonnet-4-20250514 анализирует метрики, генерирует рекомендации EN/RU/DE.
Типы: `bid_adjustment`, `budget_increase`, `campaign_pause`, `keyword_add`, `targeting_optimization`.

---

## ⚙️ Rule Engine

Условия: `acos_gt` · `spend_gt` · `ctr_lt` · `impressions_lt`
Действия: `pause_campaign` · `adjust_bid_pct` · `adjust_budget_pct`
Safety: `max_change_pct` (20%), `min_bid`/`max_bid`. `dry_run: true` — симуляция.

---

## 👥 RBAC

`owner` > `admin` > `media_buyer` / `ai_operator` / `analyst` > `read_only`

---

## 🛡 Безопасность

- LwA tokens: AES-256-GCM в БД
- JWT: 7-дневный TTL
- Audit log: append-only (PostgreSQL триггер)
- CSRF: state parameter в OAuth

---

## 🔧 Отладка

```bash
# Пересобрать backend
docker compose build --no-cache backend && docker compose up -d backend

# Проверить код внутри контейнера
docker exec adsflow_backend node -e \
  "console.log(require('fs').readFileSync('/app/src/routes/campaigns.js','utf8').slice(0,300))"
```

> ⚠️ API всегда через Vite proxy (`/api/v1/...` порт **3000**), не напрямую на 4000.

---

## ✅ Реализовано

### Core
- [x] Auth (JWT, 6 ролей RBAC)
- [x] Amazon OAuth LwA, авто-refresh, мультирегион (NA/EU/FE)
- [x] Entity sync: SP v3 POST /list, SB v4, SD
- [x] Metrics: KPI + дельты + тренды + `/by-type` разбивка
- [x] Reports: Reporting API v3 async pipeline
- [x] Bulk Operations: BullMQ batch jobs
- [x] Rule Engine: dry_run, hourly cron
- [x] Alerts: ACOS/ROAS/budget пороги
- [x] AI Orchestrator: Claude Sonnet, EN/RU/DE
- [x] Audit Log: append-only
- [x] i18n: EN / RU / DE · Dark theme

### UI/UX
- [x] **Server-side сортировка** по всем столбцам (Campaigns, Keywords, Audit)
- [x] **Пагинация на 6 страницах** — выбор размера + smart page range с `…`

| Страница | Варианты | Дефолт |
|---|---|---|
| Campaigns | 25/50/100/200 | 100 |
| Keywords | 25/50/100/200/500 | 100 |
| Reports | 25/50/100 | 50 |
| Rules | 10/25/50/100 | 25 |
| Alerts | 10/25/50/100 | 25 |
| Audit | 25/50/100/200 | 50 |

- [x] **Синхронизация**: кнопки Обновить/Синхронизировать на Обзоре
- [x] **Расписание синхронизации** per-connection (hourly/daily/weekly)
- [x] **Умный планировщик** — нет дублирования синков
- [x] **Кастомизируемый дашборд** — 16 виджетов, ↑↓ reorder, ⇔ resize, add/remove, сброс, сохранение в БД

## 🚧 Known Issues / TODO

- `negativeKeywords`: нужна миграция на `POST /sp/negativeKeywords/list`
- Settings Workspace: timezone/currency dropdown обрезает текст
