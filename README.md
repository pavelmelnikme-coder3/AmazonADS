# AdsFlow — Amazon Ads Dashboard

Полноценный дашборд для управления Amazon Ads кампаниями: AI-рекомендации, автоматические правила, кастомизируемый дашборд, отслеживание BSR товаров, еженедельный P&L отчёт аналитика. Поддержка SP/SB/SD кампаний, мультирегион (NA/EU/FE).

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

# ── SP-API (опционально, для BSR) ──────────────────────────────────────────────
# Создать в Seller Central → Apps & Services → Develop Apps
SP_API_CLIENT_ID=amzn1.application-oa2-client.XXXX
SP_API_CLIENT_SECRET=your_sp_api_secret
SP_API_REFRESH_TOKEN=Atzr|...
SP_API_URL_EU=https://sellingpartnerapi-eu.amazon.com
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
│  Overview · Campaigns · Keywords · Products · Reports             │
│  Analytics · Rules · Alerts · AI · Audit · Connections · Settings │
│  i18n: EN / RU / DE                                              │
└────────────────────────────┬─────────────────────────────────────┘
                             │ REST /api/v1
┌────────────────────────────▼─────────────────────────────────────┐
│                   Backend (Node.js / Express)                      │
│  Auth/RBAC (JWT)  ·  Amazon OAuth (LwA)  ·  Ads API Client       │
│  SP-API Catalog Items  ·  SP v3 POST /list  ·  SB v4  ·  SD      │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │  BullMQ Workers (Redis)                                   │   │
│  │  entity-sync · report-pipeline · rule-engine              │   │
│  │  ai-analysis · metrics-backfill · bsr-sync (6h)          │   │
│  └───────────────────────────────────────────────────────────┘   │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│  PostgreSQL 16                                                    │
│  campaigns · keywords · targets · fact_metrics_daily              │
│  products · bsr_snapshots · sku_mapping                           │
│  rules · alert_configs · audit_events · users(settings JSONB)    │
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
│   ├── app.js
│   ├── config/
│   │   ├── logger.js · redis.js · encryption.js
│   ├── db/
│   │   ├── pool.js
│   │   └── migrations/
│   │       ├── 001_initial.sql · 002_add_region.sql
│   ├── middleware/auth.js          # JWT + RBAC + user.settings
│   ├── services/amazon/
│   │   ├── lwa.js                 # OAuth + token refresh (Ads API)
│   │   ├── adsClient.js           # Ads API HTTP client
│   │   ├── spClient.js            # SP-API client (BSR/Catalog)
│   │   ├── entities.js            # SP v3 POST /list + SB/SD
│   │   └── reporting.js           # Reporting API v3
│   ├── jobs/
│   │   ├── workers.js             # BullMQ workers
│   │   └── scheduler.js           # Smart sync + BSR cron
│   └── routes/
│       ├── auth.js                # POST /login, GET/PATCH /me
│       ├── connections.js         # OAuth + schedule + sync
│       ├── profiles.js
│       ├── campaigns.js           # Sort + pagination
│       ├── keywords.js            # Sort + pagination
│       ├── metrics.js             # /summary, /top-campaigns, /by-type
│       ├── reports.js · rules.js · alerts.js · audit.js
│       ├── products.js            # BSR tracking (SP-API)
│       ├── analyticsReport.js     # XLSX report download + SKU config
│       ├── ai.js · jobs.js
└── frontend/src/
    ├── App.jsx                    # SPA — все страницы
    └── i18n/
        ├── en.js · ru.js · de.js
```

---

## 🔑 API endpoints

### Auth & User Settings
| Метод | URL | Описание |
|-------|-----|----------|
| POST | `/auth/register` | Регистрация |
| POST | `/auth/login` | Вход → JWT + `user.settings` |
| GET  | `/auth/me` | Текущий пользователь + settings |
| PATCH | `/auth/me` | Обновить `user.settings` (layout и др.) |

### Connections & Sync
| Метод | URL | Описание |
|-------|-----|----------|
| GET  | `/connections` | Список (includes `sync_schedule`) |
| GET  | `/connections/amazon/init` | OAuth URL |
| POST | `/connections/amazon/callback` | OAuth callback |
| PATCH | `/connections/:id/schedule` | `hourly`/`daily`/`weekly` |
| POST | `/connections/:id/sync` | Ручной запуск sync |

### Campaigns & Keywords
| Метод | URL | Описание |
|-------|-----|----------|
| GET  | `/campaigns` | Список, сортировка, фильтры, пагинация |
| PATCH | `/campaigns/:id` | state / budget |
| POST | `/campaigns/bulk` | Bulk update |
| GET  | `/keywords` | Список, сортировка, пагинация |
| PATCH | `/keywords/bulk` | Bulk bid update |

### Metrics
| Метод | URL | Описание |
|-------|-----|----------|
| GET | `/metrics/summary` | KPI + дельты + тренд (9 метрик per day) |
| GET | `/metrics/top-campaigns` | Топ кампании |
| GET | `/metrics/by-type` | SP/SD/SB разбивка |

### Reports, Rules, Alerts, Audit
| Метод | URL | Описание |
|-------|-----|----------|
| GET/POST | `/reports` | Отчёты Reporting API (пагинация) |
| GET/POST/PATCH/DELETE | `/rules/:id` | Rule Engine CRUD |
| POST | `/rules/:id/run` | Запуск (dry_run) |
| GET  | `/alerts` | Конфиги оповещений (пагинация) |
| GET  | `/alerts/instances` | Срабатывания |
| GET  | `/audit` | Журнал (сортировка + пагинация) |

### Products & BSR (SP-API)
| Метод | URL | Описание |
|-------|-----|----------|
| GET  | `/products` | Список товаров с актуальным BSR |
| POST | `/products` | Добавить ASIN для отслеживания |
| POST | `/products/:id/refresh` | Обновить BSR вручную |
| GET  | `/products/:id/history` | История BSR (до 90 точек) |
| DELETE | `/products/:id` | Удалить из отслеживания |

### Analytics Report
| Метод | URL | Описание |
|-------|-----|----------|
| GET  | `/analytics-report/download` | Скачать XLSX (`?startDate=&endDate=`) |
| GET  | `/analytics-report/config` | Список SKU конфигов |
| POST | `/analytics-report/config` | Upsert SKU конфига |
| POST | `/analytics-report/config/bulk` | Bulk import конфигов |

---

## 📊 Страницы приложения

### Обзор — кастомизируемый дашборд
**16 виджетов** (9 KPI + 2 графика + 2 таблицы + 3 прочих), дефолт 8:

| Группа | Виджеты |
|--------|---------|
| KPI (half) | Spend · Sales · ACOS · ROAS · Клики · Показы · Заказы · CTR · CPC |
| Графики (full) | Динамика Spend (барчарт) · Мульти-тренд (клики+продажи) |
| Таблицы (full) | Топ кампании · По типу (SP/SB/SD) |
| Другое | Оповещения · ИИ Рекомендации · Статус синхронизации |

**Спарклайны на всех KPI** — каждая карточка показывает мини-график тренда за выбранный период (данные из 9 метрик ежедневного тренда: spend, sales, acos, roas, clicks, impressions, orders, ctr, cpc).

**Режим ⊞ Настроить:** добавить/удалить виджеты, ↑↓ порядок, ⇔ ширина, ↺ сброс. Лейаут сохраняется в `users.settings.dashboardLayout` (PATCH /auth/me).

**Период:** 7d / 14d / 30d / 90d + 📅 Custom (два date input inline). Период подпись отображается под заголовком.

### Кампании · Ключевые слова
Server-side сортировка + пагинация:

| Страница | Варианты | Дефолт |
|---|---|---|
| Campaigns | 25/50/100/200 | 100 |
| Keywords | 25/50/100/200/500 | 100 |
| Reports | 25/50/100 | 50 |
| Rules | 10/25/50/100 | 25 |
| Alerts | 10/25/50/100 | 25 |
| Audit | 25/50/100/200 | 50 |

### Товары и BSR
Отслеживание BSR через Amazon SP-API Catalog Items v2022-04-01.

- Добавить ASIN (10 символов) → мгновенный запрос к SP-API
- Показывает все ранги: `classificationRanks` (подкатегории) + `displayGroupRanks` (группы)
- Каждый ранг — кликабельный бейдж со ссылкой на Amazon Best Sellers
- ▼ История — барчарт BSR за время (ниже = хуже, выше = лучше ← инвертировано)
- ↻ Ручное обновление · ✕ Удалить
- Автосинхронизация каждые 6 часов (cron, пропускается если `SP_API_REFRESH_TOKEN` не задан)

**Настройка SP-API:**
```env
SP_API_CLIENT_ID=...       # из Seller Central → Apps & Services
SP_API_CLIENT_SECRET=...
SP_API_REFRESH_TOKEN=Atzr|...
```

**Ограничение Amazon:** SP-API не возвращает BSR корневой категории (задокументированный баг #2533/#3012). Используется `displayGroupRanks` как приближение.

### Аналитика — Отчёт аналитика
Генерирует XLSX-файл в формате недельного отчёта аналитика.

**Структура файла (3 листа):**

`Sheet_1` — детальный по SKU (32 колонки):
```
Product | ASIN | SKU | Label | Units | Refunds | Sales | Promo |
Ads | SP | SD | SB | SBDay | Google | FB | %Refunds | Quota |
RefundCost | Amazon fees | COGS | VAT | Shipping |
Gross profit | Net profit | Est.payout | Expenses |
Margin% | ROI | BSR | Real ACOS | Sessions | Session%
```
Колонки Amazon fees, COGS, VAT, Shipping, Gross/Net profit, Margin, ROI — **формулы Excel** (не хардкод), пересчитываются при изменении данных.

`Лист1` — сводка по группам товаров (Label): Sales, Units, PPC Spend, TACOS, Profit

`Лист2` — справочник ASIN → SKU → Label

**Настройка себестоимости** (раздел на странице):
- Inline редактирование per-ASIN: COGS/unit, Shipping/unit, Amazon fee%, VAT%, Google€/wk, FB€/wk
- Данные хранятся в таблице `sku_mapping`
- Без настройки P&L колонки = 0, но SP/SD/SB spend и продажи присутствуют

**Скачать:** кнопка "📥 Скачать XLSX" → filename `YYYY_MM_DD-YYYY_MM_DD.xlsx`

### Подключения
- Per-connection расписание: ⏰ Каждый час / 📅 Раз в день / 📆 Раз в неделю
- Умный планировщик: запускается каждый час, синкает только due connections

---

## 🗄 DB — ключевые таблицы

```sql
-- Пользовательские настройки (dashboard layout)
users.settings JSONB DEFAULT '{}'

-- Расписание синхронизации
amazon_connections.sync_schedule TEXT DEFAULT 'daily'
  CHECK (sync_schedule IN ('hourly','daily','weekly'))

-- Товары и BSR
CREATE TABLE products (
  workspace_id UUID, asin VARCHAR(20), marketplace_id VARCHAR(20),
  title TEXT, brand TEXT, image_url TEXT, is_active BOOLEAN
);
CREATE TABLE bsr_snapshots (
  product_id UUID, captured_at TIMESTAMPTZ,
  classification_ranks JSONB,  -- [{title, rank, link}]
  display_group_ranks  JSONB,  -- [{title, rank, link}]
  best_rank INTEGER, best_category TEXT
);

-- Себестоимость для аналитического отчёта
CREATE TABLE sku_mapping (
  workspace_id UUID, asin VARCHAR(20), sku VARCHAR(100), label INTEGER,
  product_name TEXT, cogs_per_unit NUMERIC, shipping_per_unit NUMERIC,
  amazon_fee_pct NUMERIC DEFAULT -0.15,
  vat_pct NUMERIC DEFAULT -0.19,
  google_ads_weekly NUMERIC, facebook_ads_weekly NUMERIC, sellable_quota INTEGER
);
```

---

## ⚠️ Amazon SP v3 — критические детали

SP API v3 **требует POST /list** (не GET). GET возвращает 0 без ошибки.

```
POST /sp/campaigns/list    Content-Type: application/vnd.spCampaign.v3+json
POST /sp/adGroups/list     Content-Type: application/vnd.spAdGroup.v3+json
POST /sp/keywords/list     Content-Type: application/vnd.spKeyword.v3+json
```

- `state` в UPPERCASE → `.toLowerCase()` перед DB
- `budget` → `c.dailyBudget ?? c.budget?.budget`
- Пагинация: `nextToken`

SB v4 и SD — GET endpoints (не изменились).

---

## 🤖 AI Orchestrator

Claude claude-sonnet-4-20250514, рекомендации EN/RU/DE.
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
  "console.log(require('fs').readFileSync('/app/src/routes/campaigns.js','utf8').slice(0,200))"

# Прямой запрос к API
curl -H "Authorization: Bearer <token>" -H "x-workspace-id: <wid>" \
  "http://localhost:3000/api/v1/metrics/summary?startDate=2026-03-01&endDate=2026-03-16"
```

> ⚠️ API всегда через Vite proxy (порт **3000**), не напрямую на 4000.

---

## ✅ Реализовано

### Core
- [x] Auth (JWT, 6 ролей RBAC)
- [x] Amazon OAuth LwA, авто-refresh, мультирегион (NA/EU/FE)
- [x] Entity sync: SP v3 POST /list, SB v4, SD
- [x] Metrics: KPI + дельты + 9-метричный тренд + `/by-type`
- [x] Reports: Reporting API v3 async pipeline
- [x] Bulk Operations: BullMQ batch jobs
- [x] Rule Engine: dry_run, cron
- [x] Alerts: ACOS/ROAS/budget пороги
- [x] AI Orchestrator: Claude Sonnet, EN/RU/DE
- [x] Audit Log: append-only
- [x] i18n: EN / RU / DE · Dark theme (DM Mono + Outfit + Syne)

### UI/UX — Overview
- [x] **Спарклайны на всех KPI** — 9 метрик, каждая своего цвета, реальные данные per-day
- [x] **Custom date range** — 7d/14d/30d/90d + 📅 кастомный диапазон с date inputs
- [x] **Кастомизируемый дашборд** — 16 виджетов, ↑↓ reorder, ⇔ resize, add/remove, сброс к умолчаниям
- [x] Автосохранение лейаута в `users.settings.dashboardLayout` (debounced 800ms)

### UI/UX — Таблицы
- [x] **Server-side сортировка** — Campaigns, Keywords, Audit
- [x] **Пагинация** на всех 6 страницах — выбор размера + smart range с `…`

### UI/UX — Sync
- [x] Кнопки ↺ Обновить / ⟳ Синхронизировать на Обзоре
- [x] Per-connection расписание (hourly/daily/weekly)
- [x] Умный планировщик — нет дублей синков

### Товары и BSR
- [x] SP-API Catalog Items v2022-04-01 клиент (`spClient.js`)
- [x] Таблица `products` + `bsr_snapshots` (JSONB ranks + денормализованный best_rank)
- [x] Страница Товары: добавить ASIN → мгновенный BSR fetch, ранги-бейджи, история барчарт
- [x] Автосинк BSR каждые 6 часов (200ms throttle между ASIN)
- [x] Graceful degradation: без SP_API_REFRESH_TOKEN — страница работает, показывает пустой BSR

### Аналитика — XLSX отчёт
- [x] Таблица `sku_mapping` — per-ASIN конфигурация P&L (COGS, shipping, fees, VAT, Google/FB)
- [x] Генерация XLSX через `exceljs` server-side (streaming response)
- [x] **Sheet_1**: 32 колонки, SP+SD+SB разбивка, P&L формулы Excel, заморозка заголовка, автофильтр
- [x] **Лист1**: Сводка по группам товаров (Label)
- [x] **Лист2**: Справочник ASIN→SKU→Label
- [x] Inline редактирование себестоимости per-ASIN на странице Аналитика

## 🚧 Known Issues / TODO

- `negativeKeywords`: нужна миграция на `POST /sp/negativeKeywords/list`
- SP-API root BSR: не возвращается API (баг Amazon #2533) — используем displayGroupRanks
- Settings Workspace: timezone/currency dropdown обрезает текст
