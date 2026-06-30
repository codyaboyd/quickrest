# Security Model

QuickRest is a credit-metered API proxy. It treats browser sessions, customer API keys, upstream proxy targets, billing webhooks, and administrative controls as separate trust boundaries.

## Authentication and secrets

- User passwords and recovery PINs are hashed with Argon2id using explicit memory, time, and parallelism parameters.
- Customer API keys are generated from 32 random bytes and shown only once. New keys are stored as an HMAC-SHA-256 digest using `API_KEY_PEPPER` when configured, falling back to `SESSION_SECRET`; legacy SHA-256 key digests are still accepted to allow migration.
- Session cookies contain only an opaque random session id plus an HMAC signature. Session state and CSRF tokens are stored server-side in Redis.
- Server-side secrets such as Stripe keys, webhook secrets, API key pepper, database URLs, Redis URLs, and session secrets must stay in environment variables and are never rendered into frontend pages.

## Browser sessions and CSRF

- Session cookies are `HttpOnly`, `SameSite=Lax`, path-scoped to `/`, and `Secure` in production or whenever `APP_URL` uses HTTPS.
- CSRF tokens are random per session and compared with timing-safe equality for state-changing form/API routes.
- Authenticated customer, billing, and admin POST routes require CSRF tokens. Stripe webhooks are exempt from CSRF because they use Stripe's signature scheme.

## XSS and browser hardening

- Dynamic HTML values are escaped before rendering.
- Responses include hardening headers: Content Security Policy, `X-Content-Type-Options`, `X-Frame-Options`, Referrer Policy, Permissions Policy, Cross-Origin Opener Policy, and HSTS in production.
- The CSP only allows app assets plus Bootstrap from jsDelivr, blocks object embeds, denies framing, and restricts form destinations to the app and Stripe Checkout.

## API key, domain, and CORS controls

- Proxy requests must include `Authorization: Bearer ...` or `X-API-Key`.
- Domain allowlisting is enforced unless administrators disable it or explicitly enable per-user wildcard behavior. Origin, referer, and host values are normalized before comparison.
- User-managed allowed domains are validated as hostnames or `*.example.com` wildcard domains.
- CORS does not use a wildcard. The app only reflects the configured `APP_URL` origin and allows credentials for that origin.

## Proxy and SSRF protections

- Dynamic proxy target URLs must use HTTP(S), cannot contain username/password credentials, and are validated before use.
- By default, proxy targets that resolve to loopback, private, link-local, multicast, localhost, or carrier-grade NAT address ranges are blocked.
- Redirects are not automatically followed. Redirect `Location` headers are validated before being returned to callers.
- Administrators can opt into internal targets through the `proxy.allow_internal_targets` setting for controlled private-network deployments.
- Hop-by-hop and sensitive headers (`Authorization`, cookies, API keys) are not forwarded to upstream targets unless represented as explicit server-side custom headers.

## SQL injection and input validation

- Database access uses parameterized PostgreSQL queries.
- Request bodies, identifiers, paths, methods, package values, credit adjustments, and domains are validated with Zod or strict parser functions before database writes.
- Public proxy paths must begin with `/` and match a constrained URL-path character set.

## Billing webhooks

- Stripe webhook requests require the `Stripe-Signature` header.
- Events are constructed with Stripe's SDK and `STRIPE_WEBHOOK_SECRET` before processing.
- Webhook signature failures return a generic error and do not expose parser or secret details.

## Rate limiting and abuse logging

- Global API routes, proxy traffic, per-user usage, per-endpoint usage, failed authentication, login, signup, and password recovery flows are rate limited through Redis-backed counters.
- Failed authentication and suspicious usage are recorded in dedicated logs.
- Security-sensitive administrative changes, proxy credit decisions, password recovery activity, and API-key authentication failures are written to audit logs.

## Admin protection

- `/admin/*` routes require an authenticated active user with `role = 'admin'`.
- Admin mutations require CSRF tokens and write audit log entries.
- Admin settings display secret configuration status only; secret values are not shown.

## Error handling

- Production unhandled errors return a generic message and request id.
- Proxy target failures and Stripe webhook verification failures return safe, generic messages while details remain in server-side logs.

## Operational requirements

- Set strong unique values for `SESSION_SECRET`, `API_KEY_PEPPER`, `DATABASE_URL`, `REDIS_URL`, `STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET` in production.
- Use HTTPS for `APP_URL` in production.
- Rotate API keys after changing `API_KEY_PEPPER`; legacy SHA-256 API-key hashes should be phased out after customers rotate.
- Monitor audit logs and suspicious usage logs for repeated failures, blocked origins, and rate-limit events.
