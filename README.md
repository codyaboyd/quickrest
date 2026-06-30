# QuickRest

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-black.svg)](https://bun.sh/)
[![Framework: Hono](https://img.shields.io/badge/framework-Hono-orange.svg)](https://hono.dev/)

QuickRest is an open-source, full-stack SaaS starter for building a paid API proxy platform. It combines multiple upstream APIs behind one gateway, protects customer access with API keys and Redis-backed controls, tracks usage, and provides the foundation for credit-based billing with Stripe.

> **Project status:** early starter / reference implementation. The core gateway, account, admin, credit, billing, and deployment scaffolding are present, but you should review security, billing, and operational settings before using QuickRest for production traffic.

## Table of contents

- [Why QuickRest?](#why-quickrest)
- [Stack](#stack)
- [Features](#features)
- [Architecture](#architecture)
- [Project structure](#project-structure)
- [Getting started](#getting-started)
- [Development workflow](#development-workflow)
- [Useful endpoints](#useful-endpoints)
- [API usage](#api-usage)
- [Environment variables](#environment-variables)
- [Database migrations](#database-migrations)
- [Security](#security)
- [Production deployment](#production-deployment)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Community and support](#community-and-support)
- [License](#license)

## Why QuickRest?

Teams that sell data, automation, AI, enrichment, or integration APIs often need the same building blocks before they can ship a paid developer product:

- A public gateway that hides upstream API URLs and credentials.
- Customer accounts, API keys, domain restrictions, and authentication failure logging.
- Usage metering, credit balances, checkout sessions, and billing records.
- Admin controls for endpoints, pricing, maintenance mode, and abuse review.
- A deployment path that includes PostgreSQL, Redis, HTTPS, health checks, and backups.

QuickRest packages those pieces into a small Bun + Hono codebase that is easy to inspect, fork, and extend.

## Stack

- **Runtime:** Bun
- **HTTP framework:** Hono
- **Database:** PostgreSQL 16+ recommended
- **Cache/rate limits/sessions:** Redis 7+ recommended
- **Frontend:** Bootstrap 5, server-rendered templates, and vanilla JavaScript
- **Configuration:** validated environment variables with `dotenv` and `zod`
- **Billing:** Stripe Checkout and webhooks
- **Deployment:** Docker, Docker Compose, and Caddy examples

## Features

### Product and customer experience

- Bootstrap marketing page, public API documentation, signup, login, password recovery, and customer dashboard.
- Customer API-key management with one-time key display and rotation.
- Domain allowlisting with optional wildcard-domain controls.
- Credit balance, transaction history, billing history, and usage analytics pages.
- Example code snippets for calling the gateway from curl, browser JavaScript, Node, or Bun.

### Gateway and API controls

- Central Hono app with request IDs, request logging, global error handling, and secure headers.
- `/health` endpoint that checks PostgreSQL and Redis.
- Redis-backed global API rate limiting and named throttles for abuse-sensitive flows.
- Demo proxy endpoints at `/api/proxy/:service`.
- Dynamic proxy engine for database-configured public paths.
- API-key authentication via `Authorization: Bearer ...` or `X-API-Key`.
- Credit metering for successful proxy requests.
- SSRF-oriented target URL validation and redirect validation.

### Admin, billing, and operations

- Versioned PostgreSQL migrations for users, API keys, proxy endpoints, credit ledgers, Stripe billing records, admin settings, audit logs, usage logs, password resets, and analytics.
- Admin dashboard for platform metrics, endpoint settings, security review, billing visibility, and maintenance mode.
- Stripe checkout session creation and webhook processing.
- Docker Compose for local PostgreSQL and Redis.
- Production Dockerfile, production Compose file, Caddy reverse-proxy example, and systemd example.
- `SECURITY.md` with a detailed security model.

## Architecture

```text
Browser / API customer
        |
        v
     Caddy (production HTTPS reverse proxy)
        |
        v
   QuickRest Bun + Hono app
        |
        +--> PostgreSQL: users, keys, endpoints, credits, billing, audit logs
        +--> Redis: sessions, CSRF state, rate limits, throttles
        +--> Stripe: checkout and billing webhooks
        +--> Upstream APIs: private targets proxied through configured endpoints
```

Request flow for paid API traffic:

1. A customer calls a configured public path or demo `/api/proxy/:service` endpoint.
2. QuickRest validates the API key, domain restrictions, rate limits, and endpoint settings.
3. The gateway checks the customer's credit balance and the endpoint credit cost.
4. QuickRest proxies the request to the upstream API without exposing private upstream credentials.
5. Usage, credits, latency, status, and failures are written to the database for dashboards and audits.

## Project structure

```text
.
├── deploy/
│   └── Caddyfile
├── docker-compose.yml
├── docker-compose.prod.yml
├── Dockerfile
├── package.json
├── public/
│   ├── css/app.css
│   └── js/app.js
├── scripts/
│   └── start-system.js
├── src/
│   ├── config/env.js
│   ├── db/
│   │   ├── migrate.js
│   │   ├── migrations/
│   │   ├── postgres.js
│   │   └── seed-admin.js
│   ├── lib/redis.js
│   ├── middleware/
│   ├── routes/
│   ├── services/
│   ├── templates/layout.js
│   └── server.js
├── LICENSE
├── README.md
└── SECURITY.md
```

## Getting started

### Prerequisites

- [Bun](https://bun.sh/) 1.1+
- Docker and Docker Compose
- Git

### 1. Clone the repository

```bash
git clone https://github.com/your-org/quickrest.git
cd quickrest
```

If you are working from a fork, replace the URL with your fork URL.

### 2. Install dependencies

```bash
bun install
```

### 3. Configure environment variables

```bash
cp .env.example .env
```

For local development, the defaults match `docker-compose.yml`. Before using the app outside local development, update `SESSION_SECRET` to a long random value.

### 4. Start the full local system

```bash
bun start
```

`bun start` is the one-command local startup path. It creates `.env` from `.env.example` when needed, starts PostgreSQL and Redis with Docker Compose, waits for both services to accept connections, applies database migrations, and then starts the Bun HTTP server.

Open <http://localhost:3000>.

### 5. Create an account and explore

1. Visit <http://localhost:3000/signup>.
2. Create a customer account.
3. Open the dashboard at <http://localhost:3000/dashboard>.
4. Generate or rotate an API key on the dashboard or at <http://localhost:3000/api-key>.
5. Try a demo proxy request from the documentation or examples below.

## Development workflow

After PostgreSQL and Redis are already running, use hot reload:

```bash
bun run dev
```

Run the import/startup check used by this repository:

```bash
bun run check
```

Apply migrations manually:

```bash
bun run db:migrate
```

Seed or promote an admin user locally:

```bash
ADMIN_USERNAME=admin \
ADMIN_EMAIL=admin@example.com \
ADMIN_PASSWORD='change-me-now' \
ADMIN_RECOVERY_PIN='1234567890' \
bun run db:seed-admin
```

### Running in a persistent screen session

On a VPS or long-lived shell, start QuickRest in a named `screen` session so it keeps running after you disconnect:

```bash
screen -S quickrest
bun start
```

Detach from the session with `Ctrl+A`, then `D`. Reattach later with:

```bash
screen -r quickrest
```

If you only want to run the HTTP server without starting Docker Compose or applying migrations, use:

```bash
bun run start:app
```

## Useful endpoints

### Public pages

- `GET /` — marketing homepage
- `GET /docs` — public gateway documentation overview
- `GET /signup` — signup form
- `GET /login` — login form
- `GET /forgot-password` — password recovery flow
- `GET /health` — service health with PostgreSQL and Redis checks

### Authenticated customer pages

- `GET /dashboard` — customer SaaS dashboard
- `GET /docs/endpoints` — authenticated endpoint documentation
- `GET /api-key` — API-key management
- `GET /domains` — allowed-domain management
- `GET /credits` — credit purchase and transaction history
- `GET /account` — account settings

### API and billing endpoints

- `GET /api/services` — configured demo proxy services
- `GET /api/proxy/httpbin?hello=quickrest` — demo upstream proxy request
- `GET /api/proxy/weather?latitude=40.7&longitude=-74&current=temperature_2m` — demo weather proxy request
- `POST /billing/create-checkout-session` — create a Stripe Checkout session for a credit package
- `GET /billing/packages` — list active credit packages
- `POST /webhooks/stripe` — receive Stripe webhook events

### Admin endpoints

- `GET /admin` — admin dashboard
- `GET /admin/settings` — platform settings
- `GET /admin/security` — suspicious usage and protection review

## API usage

List demo services:

```bash
curl http://localhost:3000/api/services
```

Call the demo httpbin proxy:

```bash
curl "http://localhost:3000/api/proxy/httpbin?hello=quickrest"
```

Call an authenticated configured endpoint with a customer API key:

```bash
curl -H "Authorization: Bearer qrst_your_api_key" \
  "http://localhost:3000/your-configured-public-path"
```

Browser clients can also use `X-API-Key`, but `Authorization: Bearer ...` is recommended for server-to-server calls:

```js
const response = await fetch('http://localhost:3000/your-configured-public-path', {
  headers: {
    Authorization: 'Bearer qrst_your_api_key'
  }
});

console.log(await response.json());
```

## Environment variables

| Name | Required | Description |
| --- | --- | --- |
| `NODE_ENV` | Yes | `development`, `test`, or `production`. |
| `APP_NAME` | Yes | Display name used in server-rendered pages. |
| `APP_URL` | Yes | Public base URL used by links, logs, cookies, CORS, and Stripe redirects. |
| `PORT` | Yes | HTTP port for the Bun server. |
| `DATABASE_URL` | Yes | PostgreSQL connection string. |
| `REDIS_URL` | Yes | Redis connection string. Use an authenticated URL in production. |
| `SESSION_SECRET` | Yes | Long random secret for signed session cookies and related server-side controls. |
| `API_KEY_PEPPER` | Production | High-entropy secret used to HMAC customer API-key digests. |
| `RATE_LIMIT_WINDOW_SECONDS` | Yes | Redis rate-limit window size. |
| `RATE_LIMIT_MAX_REQUESTS` | Yes | Max API requests per rate-limit window. |
| `DEFAULT_CREDIT_COST` | Yes | Default credit cost for demo or unconfigured proxy services. |
| `STRIPE_SECRET_KEY` | Billing | Stripe secret key for Checkout. Use live-mode in production. |
| `STRIPE_WEBHOOK_SECRET` | Billing | Stripe webhook signing secret. |
| `STRIPE_SUCCESS_URL` | Billing | Redirect URL after successful checkout. |
| `STRIPE_CANCEL_URL` | Billing | Redirect URL after canceled checkout. |
| `POSTGRES_DB` | Docker prod | Database name used by `docker-compose.prod.yml`. |
| `POSTGRES_USER` | Docker prod | Database user used by `docker-compose.prod.yml`. |
| `POSTGRES_PASSWORD` | Docker prod | Database password used by `docker-compose.prod.yml`. |
| `REDIS_PASSWORD` | Docker prod | Redis password used by `docker-compose.prod.yml`. |
| `ADMIN_USERNAME` | Seed admin | Username for `bun run db:seed-admin`. |
| `ADMIN_EMAIL` | Seed admin | Email for `bun run db:seed-admin`. |
| `ADMIN_PASSWORD` | Seed admin | Temporary password for `bun run db:seed-admin`. |
| `ADMIN_RECOVERY_PIN` | Seed admin | Temporary recovery PIN for `bun run db:seed-admin`. |

Use `.env.example` for local development and `.env.production.example` as the production template.

## Database migrations

Migrations live in `src/db/migrations` and run in filename order. The current migration set creates and evolves the schema for:

- Users, sessions, password recovery, and customer API keys.
- Proxy endpoints, endpoint credit rules, upstream configuration, and usage logs.
- Credit balances, credit transactions, packages, Stripe checkout sessions, and webhook events.
- Admin settings, audit logs, suspicious usage logs, and analytics tables.

Run migrations with:

```bash
bun run db:migrate
```

For production, run migrations after the database is reachable and before serving new traffic.

## Security

QuickRest includes security-oriented defaults, but operators are responsible for production hardening. At minimum:

- Read [`SECURITY.md`](SECURITY.md) before deploying.
- Use HTTPS in production and set `APP_URL` to the public HTTPS origin.
- Set unique high-entropy values for `SESSION_SECRET` and `API_KEY_PEPPER`.
- Use authenticated Redis and strong PostgreSQL credentials.
- Keep Stripe secrets, database URLs, Redis URLs, and API-key peppers out of logs and source control.
- Do not expose PostgreSQL or Redis directly to the internet.
- Rotate temporary admin credentials immediately after seeding the first admin user.
- Back up PostgreSQL before migrations and on a regular schedule.

### Reporting vulnerabilities

Please do not open public issues for security vulnerabilities. Follow the private reporting process in [`SECURITY.md`](SECURITY.md). If you maintain a public fork, keep your security contact information current.

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

## Roadmap

QuickRest is intentionally small and fork-friendly. Good next contributions include:

- Add automated unit, integration, and browser tests.
- Add CI workflows for formatting, linting, tests, Docker builds, and dependency review.
- Add OpenAPI generation for configured proxy endpoints.
- Expand admin endpoint-management forms and validation.
- Add managed deployment examples for Fly.io, Render, Railway, AWS, GCP, and Kubernetes.
- Add email verification, transactional email templates, and notification hooks.
- Add first-class observability with metrics, tracing, and structured audit exports.
- Add more billing models, including subscriptions, invoices, and prepaid enterprise plans.

## Contributing

Contributions are welcome. You can help by reporting bugs, improving documentation, proposing designs, reviewing issues, or opening pull requests.

### Before opening an issue

- Search existing issues and pull requests to avoid duplicates.
- For security vulnerabilities, use the private process in [`SECURITY.md`](SECURITY.md) instead of opening a public issue.
- Include your Bun version, operating system, database/cache setup, relevant environment variables with secrets redacted, and reproduction steps.

### Pull request checklist

1. Fork the repository and create a feature branch.
2. Keep changes focused and include documentation updates when behavior changes.
3. Run `bun install` if dependencies changed and commit the updated lockfile.
4. Run `bun run check` before submitting.
5. Run any relevant manual flows, such as signup, API-key creation, migrations, or Stripe webhook tests.
6. Describe the change, why it is needed, how it was tested, and any migration/deployment notes.

### Coding guidelines

- Prefer small modules with explicit dependencies.
- Keep server-side secrets in environment variables only.
- Validate request input before database writes or proxy calls.
- Use parameterized SQL queries.
- Keep customer-facing errors safe and log operational detail server-side.
- Avoid introducing framework-heavy frontend code unless the project intentionally adopts it.

### Commit style

Use concise, imperative commit messages, for example:

- `Add endpoint usage chart`
- `Validate wildcard domains`
- `Document Docker deployment`

## Community and support

- Use GitHub Issues for bugs, feature requests, and documentation improvements.
- Use GitHub Discussions if enabled by the project maintainers for questions and design proposals.
- Maintainers should label beginner-friendly work with `good first issue` and contributor-ready work with `help wanted`.
- This project does not currently include a separate code of conduct file; maintainers are encouraged to add one before building a larger contributor community.

## License

QuickRest is released under the [MIT License](LICENSE).
