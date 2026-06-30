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

## Production deployment

This section is a practical checklist for deploying QuickRest as a Bun.js API proxy SaaS on a VPS. The defaults assume Docker Compose, PostgreSQL, Redis, and Caddy on the same host. For managed PostgreSQL or Redis, keep the app and Caddy parts and point `DATABASE_URL` or `REDIS_URL` at the managed services.

### Production environment example

Copy the production template and replace every placeholder before booting the stack:

```bash
cp .env.production.example .env.production
openssl rand -base64 48 # use for SESSION_SECRET and API_KEY_PEPPER
```

Important production variables:

- `NODE_ENV=production` enables secure cookie behavior and production error messages.
- `APP_URL` must be the public HTTPS origin, for example `https://quickrest.example.com`.
- `DATABASE_URL` must point at PostgreSQL 16+ and should use a strong password.
- `REDIS_URL` must point at Redis 7+; use an authenticated Redis URL in production.
- `SESSION_SECRET` and `API_KEY_PEPPER` should be unique high-entropy secrets with at least 32 random bytes.
- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` must be live-mode values for production billing.
- `ADMIN_*` variables are only used by the admin seeding command and should be removed from shell history/secrets stores after rotation.

### Docker image

The included `Dockerfile` builds a production Bun image, installs production dependencies with the lockfile, runs as the non-root `bun` user, exposes port `3000`, and includes an HTTP health check against `/health`.

Build locally:

```bash
docker build -t quickrest:production .
```

### Docker Compose production example

Use `docker-compose.prod.yml` for a single-host deployment with app, PostgreSQL, Redis, and Caddy:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

The compose file keeps PostgreSQL, Redis, and the app off public ports. Only Caddy publishes ports `80` and `443`.

### Caddy reverse proxy and HTTPS assumptions

Edit `deploy/Caddyfile` before deployment:

1. Replace `quickrest.example.com` with your domain.
2. Replace `admin@example.com` with an email for ACME certificate notices.
3. Ensure DNS `A`/`AAAA` records point to the VPS.
4. Ensure inbound firewall rules allow TCP `80` and `443`.

Caddy automatically provisions and renews HTTPS certificates when the domain resolves to the server and ports `80`/`443` are reachable. The app should still listen on plain HTTP behind Caddy; public traffic terminates at HTTPS in Caddy and is proxied to `app:3000`.

### Health checks

QuickRest exposes:

```bash
curl -fsS https://quickrest.example.com/health
```

The endpoint returns HTTP `200` when PostgreSQL and Redis checks pass, and `503` when either dependency is degraded. Docker and Compose health checks use this endpoint to detect app readiness.

### Database migration command

Run migrations after the database is reachable and before serving traffic:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml run --rm app bun run db:migrate
```

For non-Docker deployments, run the same command in the release directory after exporting the production environment:

```bash
bun run db:migrate
```

### Seed admin command

Create or promote the first admin user with:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml run --rm app bun run db:seed-admin
```

For non-Docker deployments:

```bash
ADMIN_USERNAME=admin ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='change-me-now' ADMIN_RECOVERY_PIN='1234567890' bun run db:seed-admin
```

Immediately log in, rotate the temporary password and recovery PIN, and remove temporary admin credentials from shell history and deployment notes.

### Redis and PostgreSQL requirements

- PostgreSQL 16+ is recommended. The schema uses `pgcrypto` and `citext`; the database user must be allowed to create these extensions during migrations.
- Redis 7+ is recommended. Redis is used for sessions, rate limiting, throttles, and other short-lived controls.
- Enable persistent volumes/backups. PostgreSQL is the source of truth; Redis should use append-only persistence for better restart behavior.
- Do not expose PostgreSQL or Redis directly to the internet. Bind them to private Docker networks, private VPC interfaces, or localhost-only sockets.

### Backup notes

Back up PostgreSQL at least daily and before every migration:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml exec postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backups/quickrest-$(date +%F-%H%M%S).sql
```

Recommended backup practices:

- Store encrypted copies off-server, such as object storage with lifecycle retention.
- Periodically test restores into a fresh database.
- Keep pre-migration backups until the release has been verified.
- Redis is not the durable billing ledger, but retaining AOF persistence helps preserve sessions and throttles across restarts.

### Logging notes

- The application writes request logs and unhandled errors to stdout/stderr.
- Docker users can inspect logs with `docker compose --env-file .env.production -f docker-compose.prod.yml logs -f app caddy`.
- Caddy access logs are configured as JSON to stdout in `deploy/Caddyfile`.
- On a VPS, forward Docker or journald logs to your provider, Loki, Datadog, CloudWatch, or another log sink.
- Avoid logging full API keys, Stripe secrets, bearer tokens, or upstream credentials.

### Stripe webhook setup notes

1. In the Stripe Dashboard, create a production webhook endpoint for `https://quickrest.example.com/webhooks/stripe`.
2. Subscribe to checkout/payment events used by your billing flow, especially Checkout Session completion and payment success/failure events.
3. Copy the generated signing secret into `STRIPE_WEBHOOK_SECRET`.
4. Use live-mode `STRIPE_SECRET_KEY` in production.
5. After deployment, send a test event from Stripe and verify the app logs and admin billing page record the webhook event.
6. Keep `/webhooks/stripe` reachable without interactive auth; signature verification should rely on the webhook secret.

### Recommended VPS deployment steps

1. Provision an Ubuntu LTS VPS with at least 1 GB RAM for light traffic; use 2 GB+ when running PostgreSQL and Redis on the same host.
2. Create a non-root deploy user and install Docker Engine plus the Docker Compose plugin.
3. Point DNS for your production domain to the VPS.
4. Open firewall ports `22`, `80`, and `443`; keep database/cache ports private.
5. Clone the repository into `/opt/quickrest` or another release directory.
6. Copy `.env.production.example` to `.env.production` and replace all secrets and domain values.
7. Edit `deploy/Caddyfile` with the production domain and ACME email.
8. Start dependencies and app with `docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build`.
9. Run `docker compose --env-file .env.production -f docker-compose.prod.yml run --rm app bun run db:migrate`.
10. Run `docker compose --env-file .env.production -f docker-compose.prod.yml run --rm app bun run db:seed-admin`.
11. Verify `https://your-domain/health`, sign in as admin, configure proxy endpoints, and test a paid API request.
12. Configure Stripe webhooks, backups, log forwarding, uptime monitoring, and alerting.

### Systemd service example without Docker

If you run Bun directly on the host, install Bun, PostgreSQL, Redis, and Caddy separately. Put the app in `/opt/quickrest`, create `/etc/quickrest/quickrest.env` from `.env.production.example`, and use a service like this:

```ini
[Unit]
Description=QuickRest Bun API proxy
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target

[Service]
Type=simple
User=quickrest
Group=quickrest
WorkingDirectory=/opt/quickrest
EnvironmentFile=/etc/quickrest/quickrest.env
ExecStart=/home/quickrest/.bun/bin/bun src/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/opt/quickrest

[Install]
WantedBy=multi-user.target
```

Apply migrations and seed admin before enabling traffic:

```bash
sudo -u quickrest --preserve-env=DATABASE_URL,REDIS_URL,SESSION_SECRET,API_KEY_PEPPER bun run db:migrate
sudo -u quickrest --preserve-env=DATABASE_URL,REDIS_URL,SESSION_SECRET,API_KEY_PEPPER,ADMIN_USERNAME,ADMIN_EMAIL,ADMIN_PASSWORD,ADMIN_RECOVERY_PIN bun run db:seed-admin
sudo systemctl enable --now quickrest
sudo systemctl status quickrest
```
