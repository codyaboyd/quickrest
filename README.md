# QuickRest

QuickRest is a full-stack SaaS starter for a paid API proxy platform. It combines multiple upstream APIs behind one gateway, protects access with API keys and Redis-backed controls, and lays the foundation for credit-based billing.

## Stack

- **Runtime:** Bun
- **HTTP framework:** Hono
- **Database:** PostgreSQL
- **Cache/rate limits/sessions:** Redis
- **Frontend:** Bootstrap 5 with server-rendered templates and vanilla JavaScript
- **Configuration:** validated environment variables with `dotenv` and `zod`

## Features included

- Clean Bootstrap 5 marketing page and starter dashboard
- Central Hono app with request logging and global error handling
- `/health` endpoint that checks PostgreSQL and Redis
- Redis-backed API rate limiting middleware
- Demo proxy endpoints at `/api/proxy/:service`
- PostgreSQL connection pool and versioned migrations for users, API keys, proxy endpoints, credit ledgers, Stripe billing records, admin settings, audit logs, and password resets
- Docker Compose for local PostgreSQL and Redis
- Secure `.env.example` with required configuration

## Project structure

```text
.
├── docker-compose.yml
├── package.json
├── public/
│   ├── css/app.css
│   └── js/app.js
└── src/
    ├── config/env.js
    ├── db/
    │   ├── migrate.js
    │   ├── migrations/
    │   │   └── 001_initial_credit_saas_schema.sql
    │   └── postgres.js
    ├── lib/redis.js
    ├── middleware/
    │   ├── logger.js
    │   └── rateLimit.js
    ├── routes/
    │   ├── api.js
    │   └── pages.js
    ├── services/proxyService.js
    ├── templates/layout.js
    └── server.js
```

## Getting started

### Prerequisites

- Bun 1.1+
- Docker and Docker Compose

### 1. Install dependencies

```bash
bun install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Update `SESSION_SECRET` in `.env` to a long random value before using the app outside local development.

### 3. Start infrastructure

```bash
docker compose up -d
```

This starts PostgreSQL on `localhost:5432` and Redis on `localhost:6379`.

### 4. Run migrations

```bash
bun run db:migrate
```

### 5. Start the application

```bash
bun run dev
```

Open <http://localhost:3000>.

## Useful endpoints

- `GET /` — marketing homepage
- `GET /dashboard` — starter SaaS dashboard
- `GET /health` — service health with PostgreSQL and Redis checks
- `GET /api/services` — configured demo proxy services
- `GET /api/proxy/httpbin?hello=quickrest` — demo upstream proxy request
- `GET /api/proxy/weather?latitude=40.7&longitude=-74&current=temperature_2m` — demo weather proxy request

## Environment variables

| Name | Description |
| --- | --- |
| `NODE_ENV` | `development`, `test`, or `production` |
| `APP_NAME` | Display name used in server-rendered pages |
| `APP_URL` | Public base URL used by startup logs |
| `PORT` | HTTP port |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `SESSION_SECRET` | Long random secret for session/signing support |
| `RATE_LIMIT_WINDOW_SECONDS` | Redis rate-limit window size |
| `RATE_LIMIT_MAX_REQUESTS` | Max API requests per window |
| `DEFAULT_CREDIT_COST` | Default credit cost for demo proxy services |

## Next build steps

1. Add authenticated tenant signup and dashboard login.
2. Wire the proxy registry to the `proxy_endpoints` and `endpoint_credit_rules` tables.
3. Hash and validate customer API keys before proxying.
4. Deduct credits transactionally through `credit_balances` and `credit_transactions`.
5. Process Stripe checkout and webhook records into paid credit purchases.
