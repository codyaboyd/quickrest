import net from 'node:net';
import { redis } from '../lib/redis.js';
import { query } from '../db/postgres.js';
import { getSetting } from './adminSettingsService.js';

export const ERROR_CODES = {
  RATE_LIMITED: 'RATE_LIMITED',
  API_KEY_REQUIRED: 'API_KEY_REQUIRED',
  INVALID_API_KEY: 'INVALID_API_KEY',
  DOMAIN_NOT_ALLOWED: 'DOMAIN_NOT_ALLOWED',
  IP_BLOCKED: 'IP_BLOCKED',
  IP_NOT_ALLOWED: 'IP_NOT_ALLOWED',
  AUTH_THROTTLED: 'AUTH_THROTTLED',
  LOGIN_THROTTLED: 'LOGIN_THROTTLED',
  SIGNUP_THROTTLED: 'SIGNUP_THROTTLED'
};

export function clientIp(c) {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'anonymous';
}

export function errorPayload(code, message, requestId, details = {}) {
  return { error: { code, message, ...details }, requestId };
}

function safePart(value) { return String(value || 'unknown').replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 180); }
function parseLimit(config, fallback) { return { windowSeconds: Number(config?.window_seconds ?? fallback.windowSeconds), max: Number(config?.max_requests ?? fallback.max) }; }

export async function consumeRateLimit({ bucket, limit, c }) {
  if (!limit.max || limit.max <= 0) return { allowed: true, limit: 0, remaining: 0 };
  const key = `rate:${bucket}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, limit.windowSeconds);
  const ttl = await redis.ttl(key);
  const resetSeconds = ttl > 0 ? ttl : limit.windowSeconds;
  c?.header('X-RateLimit-Limit', String(limit.max));
  c?.header('X-RateLimit-Remaining', String(Math.max(limit.max - count, 0)));
  c?.header('X-RateLimit-Reset', String(resetSeconds));
  return { allowed: count <= limit.max, count, limit: limit.max, remaining: Math.max(limit.max - count, 0), resetSeconds };
}

export async function enforceNamedThrottle(c, name, identity, fallback, code) {
  const configured = await getSetting(`limits.${name}`, null).catch(() => null);
  const limit = parseLimit(configured, fallback);
  const result = await consumeRateLimit({ bucket: `${name}:${safePart(identity)}`, limit, c });
  if (!result.allowed) {
    await logSuspiciousUsage({ c, reason: code, severity: 'medium', metadata: { identity, limit: result.limit, count: result.count, resetSeconds: result.resetSeconds } });
    return c.json(errorPayload(code, 'Too many requests. Please retry after the reset window.', c.get('requestId'), { resetSeconds: result.resetSeconds }), 429);
  }
  return null;
}

export function throttleMiddleware(name, fallback, code, identityFn = clientIp) {
  return async (c, next) => {
    const blocked = await enforceNamedThrottle(c, name, identityFn(c), fallback, code);
    if (blocked) return blocked;
    await next();
  };
}

export async function enforceProxyRateLimits(c, { userId, endpointId }) {
  const ip = clientIp(c);
  const checks = [
    ['global_requests', `global:${ip}`, { windowSeconds: 60, max: 120 }, ERROR_CODES.RATE_LIMITED],
    ['per_user_requests', `user:${userId}`, { windowSeconds: 60, max: 600 }, ERROR_CODES.RATE_LIMITED],
    ['per_endpoint_requests', `endpoint:${endpointId}:${userId || ip}`, { windowSeconds: 60, max: 300 }, ERROR_CODES.RATE_LIMITED]
  ];
  for (const [setting, bucket, fallback, code] of checks) {
    const limit = parseLimit(await getSetting(`limits.${setting}`, null).catch(() => null), fallback);
    const result = await consumeRateLimit({ bucket, limit, c });
    if (!result.allowed) {
      await logSuspiciousUsage({ c, userId, endpointId, reason: `${setting}_exceeded`, severity: 'medium', metadata: result });
      return { ok: false, status: 429, code, error: 'Rate limit exceeded', resetSeconds: result.resetSeconds };
    }
  }
  return { ok: true };
}

export async function enforceIpAccess(c) {
  const enabled = await getSetting('security.ip_access_lists_enabled', false).catch(() => false);
  if (!enabled) return { ok: true };
  const ip = clientIp(c);
  if (!net.isIP(ip)) return { ok: true };
  const rows = (await query(`select list_type, ip_address, cidr, reason from api_ip_access_rules where is_enabled = true`)).rows;
  const matches = rows.filter((r) => ipMatches(ip, r.ip_address, r.cidr));
  const blocked = matches.find((r) => r.list_type === 'block');
  if (blocked) return { ok: false, status: 403, code: ERROR_CODES.IP_BLOCKED, error: 'IP address is blocked' };
  if (rows.some((r) => r.list_type === 'allow') && !matches.some((r) => r.list_type === 'allow')) return { ok: false, status: 403, code: ERROR_CODES.IP_NOT_ALLOWED, error: 'IP address is not allowed' };
  return { ok: true };
}

function ipMatches(ip, exact, cidr) {
  if (exact && ip === exact) return true;
  if (!cidr) return false;
  const [range, bits] = cidr.split('/');
  if (!net.isIPv4(ip) || !net.isIPv4(range)) return ip === range;
  const mask = -1 << (32 - Number(bits));
  const toInt = (v) => v.split('.').reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;
  return (toInt(ip) & mask) === (toInt(range) & mask);
}

export async function logSuspiciousUsage({ c, userId = null, apiKeyId = null, endpointId = null, reason, severity = 'low', metadata = {} }) {
  await query(`insert into suspicious_usage_logs (user_id, api_key_id, endpoint_id, ip_address, user_agent, request_path, reason, severity, metadata) values ($1,$2,$3,nullif($4, '')::inet,$5,$6,$7,$8,$9::jsonb)`, [userId, apiKeyId, endpointId, clientIp(c), c.req.header('user-agent') || '', new URL(c.req.url).pathname, reason, severity, JSON.stringify(metadata)]).catch((error) => console.error('Failed to log suspicious usage', error.message));
}
