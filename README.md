# AdsFlow — Amazon Ads Dashboard

Полноценный дашборд для управления Amazon Ads кампаниями с AI-рекомендациями.

## 🏗 Архитектура

```
┌─────────────────────────────────────────────────────────┐
│                     Frontend (React)                     │
│  Login → Connect → Overview → Campaigns → Reports → AI  │
└────────────────────────┬────────────────────────────────┘
                         │ REST API /api/v1
┌────────────────────────▼────────────────────────────────┐
│                   Backend (Express.js)                   │
│                                                         │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Auth/RBAC│  │ Amazon OAuth │  │   Ads Control    │  │
│  │  (JWT)   │  │  (LwA v2)   │  │  (SP/SB/SD API)  │  │
│  └──────────┘  └──────┬───────┘  └──────────────────┘  │
│                        │                                 │
│  ┌─────────────────────▼──────────────────────────────┐ │
│  │         BullMQ Workers (Redis)                     │ │
│  │  entity-sync │ report-pipeline │ bulk-operations   │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│                   Data Layer                             │
│  PostgreSQL (entities, metrics)  +  S3 (raw reports)    │
└─────────────────────────────────────────────────────────┘
```

## 📁 Структура проекта

```
adsflow/
├── docker-compose.yml
├── .env.example
├── backend/
│   └── src/
│       ├── app.js                    # Express entry point
│       ├── config/
│       │   ├── logger.js             # Winston logger
│       │   ├── redis.js              # Redis/BullMQ connection
│       │   └── encryption.js         # AES-256-GCM for tokens
│       ├── db/
│       │   ├── pool.js               # PostgreSQL pool
│       │   └── migrations/
│       │       └── 001_initial.sql   # Full schema
│       ├── middleware/
│       │   └── auth.js               # JWT + RBAC
│       ├── services/amazon/
│       │   ├── lwa.js                # Login with Amazon OAuth
│       │   ├── adsClient.js          # HTTP client + rate limiting
│       │   ├── entities.js           # Profiles/Campaigns/Keywords sync
│       │   └── reporting.js          # Reporting API v3 pipeline
│       ├── jobs/
│       │   ├── workers.js            # BullMQ workers
│       │   └── scheduler.js          # Cron jobs
│       └── routes/
│           ├── auth.js               # /auth/*
│           ├── connections.js        # /connections/* (OAuth flow)
│           ├── campaigns.js          # /campaigns/*
│           ├── metrics.js            # /metrics/summary, /top-campaigns
│           ├── reports.js            # /reports/*
│           └── audit.js              # /audit/*
└── frontend/
    └── src/
        ├── App.jsx                   # Full SPA: Login, Connect, Dashboard
        └── api/index.js              # API client
```

## 🔑 Ключевые API endpoints

| Метод | URL | Описание |
|-------|-----|----------|
| POST | `/auth/register` | Регистрация |
| POST | `/auth/login` | Вход |
| GET | `/connections/amazon/init` | Получить OAuth URL |
| POST | `/connections/amazon/callback` | Обработать callback с кодом |
| POST | `/connections/:id/profiles/attach` | Привязать профили к workspace |
| GET | `/campaigns` | Список кампаний с метриками |
| PATCH | `/campaigns/:id` | Изменить статус/бюджет |
| GET | `/metrics/summary` | KPI агрегация |
| GET | `/metrics/top-campaigns` | Топ кампании |
| POST | `/reports` | Запустить отчёт |
| GET | `/audit` | Лог изменений |

## 🔄 Roadmap

- [x] **Этап 1**: OAuth + Profiles + Entities sync + Campaigns table + Reports v3 + Audit
- [x] **Этап 2**: Bulk ops + Rule engine + Alerts + Keywords management
- [ ] **Этап 3**: AI Orchestrator + Recommendations + Preview/Apply
- [ ] **Этап 4**: Automated runs + DSP/AMC integration

## 🛡 Безопасность

- LwA tokens шифруются AES-256-GCM до записи в БД
- Refresh tokens никогда не передаются на frontend
- CSRF защита через state parameter в OAuth
- JWT с 7-дневным TTL
- Rate limiting на все публичные endpoints
- Audit log — append-only (триггер в PostgreSQL запрещает UPDATE/DELETE)
- RBAC проверки на каждом защищённом endpoint

---

> Разработано по ТЗ для максимального покрытия Amazon Ads API функций.
