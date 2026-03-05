# AdsFlow — Amazon Ads Dashboard

Полноценный дашборд для управления Amazon Ads кампаниями с AI-рекомендациями.

## ⚡ Быстрый старт (сегодня подключиться к Amazon)

### 1. Получить Amazon LwA credentials

1. Перейти на https://developer.amazon.com/apps-and-games/console/app/list
2. Нажать **Create a New Security Profile**
3. Заполнить: Profile Name, Description, Privacy URL
4. Перейти в **Web Settings** → **Allowed Return URLs**: добавить `http://localhost:3000/connect/amazon/callback`
5. Скопировать **Client ID** и **Client Secret**

> 📌 Если у вас уже есть Amazon Ads API доступ через Seller/Vendor Central — используйте тот же аккаунт для авторизации.

### 2. Настроить окружение

```bash
cp .env.example .env
```

Заполнить в `.env`:
```env
AMAZON_CLIENT_ID=amzn1.application-oa2-client.XXXX
AMAZON_CLIENT_SECRET=your_secret_here
AMAZON_REDIRECT_URI=http://localhost:3000/connect/amazon/callback

# Сгенерировать:
JWT_SECRET=$(openssl rand -base64 32)
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
POSTGRES_PASSWORD=your_db_password
```

### 3. Запустить

```bash
docker-compose up -d
```

Первый запуск: ~2-3 минуты (скачивание образов, инициализация БД).

```bash
# Проверить логи
docker-compose logs -f backend

# Убедиться что всё работает
curl http://localhost:4000/health
```

### 4. Открыть приложение

- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:4000/api/v1

### 5. Подключить Amazon

1. Зарегистрироваться в приложении
2. Перейти в раздел **Connections** (⊕ в боковом меню)
3. Нажать **Connect Amazon Ads Account**
4. Авторизоваться на amazon.com и разрешить доступ
5. Выбрать профили для синхронизации
6. Ждать ~2-5 минут пока пройдёт первый синк

---

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
- [ ] **Этап 2**: Bulk ops + Rule engine + Alerts + Keywords management
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
