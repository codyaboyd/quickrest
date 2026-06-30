import { env } from '../config/env.js';
import { query } from '../db/postgres.js';
import { hashApiKey, domainMatches, logAuthAttempt } from './apiKeyService.js';
import { clientIp } from './apiProtectionService.js';

const demoServices = new Map([
  ['weather', {
    slug: 'weather',
    name: 'Weather API',
    upstreamUrl: 'https://api.open-meteo.com/v1/forecast',
    creditCost: env.DEFAULT_CREDIT_COST
  }],
  ['httpbin', {
    slug: 'httpbin',
    name: 'HTTPBin Echo',
    upstreamUrl: 'https://httpbin.org/anything',
    creditCost: env.DEFAULT_CREDIT_COST
  }]
]);

export function listDemoServices() {
  return [...demoServices.values()];
}

export async function proxyRequest(serviceSlug, request, c) {
  const startedAt = performance.now();
  const sourceUrl = new URL(request.url);
  const service = demoServices.get(serviceSlug);
  const auth = await validateProxyAccess(request, serviceSlug, c);
  if (!auth.ok) return { status: auth.status, body: { error: auth.error } };
  if (!service) {
    await logDemoProxyRequest({ request, c, serviceSlug, sourceUrl, auth, status: 404, failureReason: 'Unknown API service', startedAt });
    return { status: 404, body: { error: 'Unknown API service' } };
  }
  const upstreamUrl = new URL(service.upstreamUrl);
  sourceUrl.searchParams.forEach((value, key) => upstreamUrl.searchParams.set(key, value));

  const upstreamResponse = await fetch(upstreamUrl, {
    method: request.method,
    headers: {
      accept: request.headers.get('accept') || 'application/json',
      'user-agent': 'QuickRest/0.1'
    }
  });

  const contentType = upstreamResponse.headers.get('content-type') || 'application/json';
  const body = contentType.includes('application/json')
    ? await upstreamResponse.json()
    : await upstreamResponse.text();

  await logDemoProxyRequest({ request, c, serviceSlug: service.slug, sourceUrl, auth, status: upstreamResponse.status, creditsCharged: service.creditCost, startedAt });
  await query('update api_keys set last_used_at = now() where id = $1', [auth.apiKey.id]);

  return {
    status: upstreamResponse.status,
    body: {
      service: service.slug,
      creditsCharged: service.creditCost,
      upstreamStatus: upstreamResponse.status,
      data: body
    }
  };
}


async function validateProxyAccess(request, serviceSlug, c) {
  const header = request.headers.get('authorization') || '';
  const rawKey = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : request.headers.get('x-api-key');
  const sourceUrl = new URL(request.url);
  const fail = async (status, error, extra = {}) => {
    await logDemoProxyRequest({ request, c, serviceSlug, sourceUrl, auth: { ok: false, user: { id: extra.userId }, apiKey: { id: extra.apiKeyId } }, status, failureReason: error, startedAt: performance.now() });
    if (c) await logAuthAttempt({ userId: extra.userId, apiKeyId: extra.apiKeyId, action: 'proxy_auth_failed', reason: error, c }).catch(() => {});
    return { ok: false, status, error };
  };
  if (!rawKey) return fail(401, 'API key required');
  const result = await query(`select k.id, k.user_id, u.username, u.status as user_status, u.wildcard_domains_enabled from api_keys k join users u on u.id = k.user_id where k.key_hash = $1 and k.status = 'active'`, [hashApiKey(rawKey)]);
  const row = result.rows[0];
  if (!row) return fail(401, 'Invalid API key');
  if (row.user_status !== 'active') return fail(403, row.user_status === 'suspended' ? 'User suspended' : 'User inactive', { userId: row.user_id, apiKeyId: row.id });
  const domain = request.headers.get('origin') || request.headers.get('referer') || request.headers.get('host') || '';
  if (!row.wildcard_domains_enabled) {
    const domains = await query(`select domain from allowed_domains where user_id = $1 and status = 'active'`, [row.user_id]);
    if (domains.rowCount === 0 || !domains.rows.some((d) => domainMatches(domain, d.domain))) {
      return fail(403, 'Domain is not allowed', { userId: row.user_id, apiKeyId: row.id });
    }
  }
  return { ok: true, user: { id: row.user_id, username: row.username }, apiKey: { id: row.id } };
}

async function logDemoProxyRequest({ request, c, serviceSlug, sourceUrl, auth, status, failureReason = null, creditsCharged = 0, startedAt }) {
  await query(
    `insert into api_usage_logs (user_id, api_key_id, service_slug, request_method, request_path, request_domain, response_status, credits_charged, auth_success, failure_reason, duration_ms, request_ip)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,nullif($12, '')::inet)`,
    [auth.user?.id || null, auth.apiKey?.id || null, serviceSlug, request.method, sourceUrl.pathname, request.headers.get('origin') || request.headers.get('referer') || request.headers.get('host'), status, creditsCharged, auth.ok !== false, failureReason, Math.round(performance.now() - startedAt), c ? clientIp(c) : '']
  );
}
