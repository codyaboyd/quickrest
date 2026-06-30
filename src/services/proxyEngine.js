import dns from 'node:dns/promises';
import net from 'node:net';
import { query } from '../db/postgres.js';
import { getSetting } from './adminSettingsService.js';
import { deductEndpointCredits, ensureCreditBalance } from './creditService.js';
import { hashApiKey, domainMatches, logAuthAttempt } from './apiKeyService.js';

const SUPPORTED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
  'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length'
]);
const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'x-api-key']);

export async function handleDynamicProxy(c) {
  const startedAt = performance.now();
  const sourceUrl = new URL(c.req.url);
  const requestId = c.get('requestId') || crypto.randomUUID();
  const method = c.req.method.toUpperCase();

  if (!SUPPORTED_METHODS.has(method)) return null;

  const endpoint = await findEndpoint(sourceUrl.pathname, method);
  if (!endpoint) return null;

  const auth = await validateProxyAccess(c.req.raw, endpoint, c);
  if (!auth.ok) {
    await logProxyRequest({ endpoint, auth, c, sourceUrl, status: auth.status, failureReason: auth.error, startedAt, creditsCharged: 0 });
    return c.json({ error: auth.error, requestId }, auth.status);
  }

  if (!endpoint.is_enabled) {
    await logProxyRequest({ endpoint, auth, c, sourceUrl, status: 404, failureReason: 'Endpoint disabled', startedAt, creditsCharged: 0 });
    return c.json({ error: 'Endpoint not found', requestId }, 404);
  }

  const creditCost = await resolveCreditCost(endpoint);
  const balance = (await ensureCreditBalance(auth.user.id)).balance;
  if (balance < creditCost) {
    await logProxyRequest({ endpoint, auth, c, sourceUrl, status: 402, failureReason: 'Insufficient credits', startedAt, creditsCharged: 0 });
    await auditUsage({ c, auth, endpoint, action: 'proxy_credit_rejected', metadata: { creditCost, balance } });
    return c.json({ error: 'Insufficient credits', requestId }, 402);
  }

  let targetUrl;
  try {
    targetUrl = await buildSafeTargetUrl(endpoint.target_url, sourceUrl.searchParams);
  } catch (error) {
    await logProxyRequest({ endpoint, auth, c, sourceUrl, status: 502, failureReason: error.message, startedAt, creditsCharged: 0 });
    return c.json({ error: 'Proxy target is not available', requestId }, 502);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), endpoint.timeout_ms);
  let upstreamResponse;
  let responseBody;
  let contentType = 'application/octet-stream';
  let failureReason = null;

  try {
    upstreamResponse = await fetch(targetUrl, {
      method,
      headers: buildForwardHeaders(c.req.raw.headers, endpoint.headers_config),
      body: ['GET'].includes(method) ? undefined : c.req.raw.body,
      signal: controller.signal,
      duplex: method === 'GET' ? undefined : 'half'
    });
    contentType = upstreamResponse.headers.get('content-type') || contentType;
    responseBody = await upstreamResponse.arrayBuffer();
  } catch (error) {
    failureReason = error.name === 'AbortError' ? 'Target request timed out' : 'Target request failed';
  } finally {
    clearTimeout(timeout);
  }

  const shouldCharge = creditCost > 0 && (upstreamResponse || endpoint.deduct_credits_on_failure);
  let creditsCharged = 0;
  if (shouldCharge) {
    try {
      creditsCharged = (await deductEndpointCredits({ userId: auth.user.id, apiKeyId: auth.apiKey.id, endpoint, amount: creditCost, requestId, success: Boolean(upstreamResponse), failureReason })).charged;
    } catch (error) {
      await logProxyRequest({ endpoint, auth, c, sourceUrl, status: 402, failureReason: error.message, startedAt, creditsCharged: 0 });
      await auditUsage({ c, auth, endpoint, action: 'proxy_credit_rejected', metadata: { creditCost, reason: error.message } });
      return c.json({ error: 'Insufficient credits', requestId }, 402);
    }
  }

  await query('update api_keys set last_used_at = now() where id = $1', [auth.apiKey.id]);
  await logProxyRequest({ endpoint, auth, c, sourceUrl, status: upstreamResponse?.status || 504, failureReason, startedAt, creditsCharged });
  await auditUsage({ c, auth, endpoint, action: 'proxy_request', metadata: { status: upstreamResponse?.status || 504, creditsCharged, success: Boolean(upstreamResponse) } });

  if (!upstreamResponse) return c.json({ error: failureReason, requestId }, failureReason?.includes('timed out') ? 504 : 502);

  return new Response(responseBody, {
    status: upstreamResponse.status,
    headers: { 'content-type': contentType, 'x-request-id': requestId }
  });
}

async function findEndpoint(pathname, method) {
  const result = await query(
    `select id, public_path, target_url, http_method, is_enabled, headers_config, timeout_ms, credit_cost,
            coalesce(deduct_credits_on_failure, false) as deduct_credits_on_failure
       from proxy_endpoints where public_path = $1 and http_method = $2 limit 1`,
    [pathname, method]
  );
  return result.rows[0] || null;
}

async function validateProxyAccess(request, endpoint, c) {
  const header = request.headers.get('authorization') || '';
  const rawKey = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : request.headers.get('x-api-key');
  const sourceUrl = new URL(request.url);
  const fail = async (status, error, extra = {}) => {
    if (c) await logAuthAttempt({ userId: extra.userId, apiKeyId: extra.apiKeyId, action: 'proxy_auth_failed', reason: error, c }).catch(() => {});
    return { ok: false, status, error, user: { id: extra.userId }, apiKey: { id: extra.apiKeyId } };
  };
  if (!rawKey) return fail(401, 'API key required');
  const result = await query(`select k.id, k.user_id, u.username, u.status as user_status, u.wildcard_domains_enabled from api_keys k join users u on u.id = k.user_id where k.key_hash = $1 and k.status = 'active'`, [hashApiKey(rawKey)]);
  const row = result.rows[0];
  if (!row) return fail(401, 'Invalid API key');
  if (row.user_status !== 'active') return fail(403, row.user_status === 'suspended' ? 'User suspended' : 'User inactive', { userId: row.user_id, apiKeyId: row.id });
  const domain = request.headers.get('origin') || request.headers.get('referer') || request.headers.get('host') || '';
  const domainBehavior = await getSetting('security.domain_allowlist_behavior', 'enforce');
  const wildcardAllowed = domainBehavior === 'allow_wildcard_per_user' && row.wildcard_domains_enabled;
  if (domainBehavior !== 'disabled' && !wildcardAllowed) {
    const domains = await query(`select domain from allowed_domains where user_id = $1 and status = 'active'`, [row.user_id]);
    if (domains.rowCount === 0 || !domains.rows.some((d) => domainMatches(domain, d.domain))) {
      return fail(403, 'Domain is not allowed', { userId: row.user_id, apiKeyId: row.id });
    }
  }
  return { ok: true, user: { id: row.user_id, username: row.username }, apiKey: { id: row.id } };
}

async function resolveCreditCost(endpoint) {
  const rules = await query(`select credit_cost from endpoint_credit_rules where endpoint_id = $1 and is_enabled = true order by priority asc limit 1`, [endpoint.id]);
  return rules.rows[0]?.credit_cost ?? endpoint.credit_cost;
}

function buildForwardHeaders(incomingHeaders, config = {}) {
  const headers = new Headers();
  const forwardHeaders = Array.isArray(config.forwardHeaders) ? config.forwardHeaders.map((h) => h.toLowerCase()) : ['accept', 'content-type'];
  for (const name of forwardHeaders) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || SENSITIVE_HEADERS.has(lower)) continue;
    const value = incomingHeaders.get(lower);
    if (value) headers.set(lower, value);
  }
  const customHeaders = config.customHeaders && typeof config.customHeaders === 'object' ? config.customHeaders : config;
  for (const [name, value] of Object.entries(customHeaders || {})) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'host' || value == null || typeof value === 'object') continue;
    headers.set(lower, String(value));
  }
  headers.set('user-agent', 'QuickRest/0.1');
  return headers;
}

async function buildSafeTargetUrl(rawTargetUrl, searchParams) {
  const targetUrl = new URL(rawTargetUrl);
  if (!['http:', 'https:'].includes(targetUrl.protocol)) throw new Error('Unsupported target URL protocol');
  if (targetUrl.username || targetUrl.password) throw new Error('Target URL credentials are not allowed');
  searchParams.forEach((value, key) => targetUrl.searchParams.append(key, value));
  await assertSafeTargetHost(targetUrl.hostname);
  return targetUrl;
}

async function assertSafeTargetHost(hostname) {
  const allowInternal = await getAllowInternalTargets();
  const addresses = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!allowInternal && addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('Target URL resolves to a blocked private address');
  }
}

async function getAllowInternalTargets() {
  const result = await query(`select value from admin_settings where key = 'proxy.allow_internal_targets' limit 1`);
  return result.rows[0]?.value === true || result.rows[0]?.value?.enabled === true;
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
  }
  const normalized = address.toLowerCase();
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
}

async function logProxyRequest({ endpoint, auth, c, sourceUrl, status, failureReason, startedAt, creditsCharged }) {
  await query(
    `insert into api_usage_logs (user_id, api_key_id, endpoint_id, service_slug, request_method, request_path, request_domain, response_status, credits_charged, auth_success, failure_reason, duration_ms)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [auth.user?.id || null, auth.apiKey?.id || null, endpoint.id, endpoint.public_path, c.req.method, sourceUrl.pathname, c.req.header('origin') || c.req.header('referer') || c.req.header('host'), status, creditsCharged, auth.ok !== false, failureReason, Math.round(performance.now() - startedAt)]
  );
}

async function auditUsage({ c, auth, endpoint, action, metadata }) {
  await query(
    `insert into audit_logs (actor_user_id, target_user_id, action, entity_type, entity_id, ip_address, user_agent, metadata)
     values ($1, $1, $2, 'proxy_endpoint', $3, nullif($4, '')::inet, $5, $6::jsonb)`,
    [auth.user?.id || null, action, endpoint.id, c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || '', c.req.header('user-agent') || '', JSON.stringify(metadata)]
  );
}
