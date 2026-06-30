import { randomBytes, createHmac, createHash } from 'node:crypto';
import { query } from '../db/postgres.js';
import { env } from '../config/env.js';
import { normalizeOriginHost } from './security.js';

const API_KEY_PREFIX = 'qrst';

export function generateApiKey() {
  return `${API_KEY_PREFIX}_${randomBytes(32).toString('base64url')}`;
}

export function hashApiKey(apiKey) {
  return createHmac('sha256', env.API_KEY_PEPPER || env.SESSION_SECRET).update(apiKey).digest('hex');
}

export function apiKeyHashCandidates(apiKey) {
  const hashes = [hashApiKey(apiKey)];
  const legacy = createHash('sha256').update(apiKey).digest('hex');
  if (!hashes.includes(legacy)) hashes.push(legacy);
  return hashes;
}

export function apiKeyPrefix(apiKey) {
  return apiKey.slice(0, 16);
}

export async function ensureUserApiKey(userId) {
  const existing = await query('select id from api_keys where user_id = $1 and status = $2 limit 1', [userId, 'active']);
  if (existing.rowCount > 0) return { rawKey: null, created: false };
  return createApiKey(userId, 'Default key');
}

export async function createApiKey(userId, name = 'Default key') {
  const rawKey = generateApiKey();
  const result = await query(
    `insert into api_keys (user_id, name, key_prefix, key_hash) values ($1, $2, $3, $4)
     returning id, name, key_prefix, status, last_used_at, created_at`,
    [userId, name, apiKeyPrefix(rawKey), hashApiKey(rawKey)]
  );
  return { rawKey, apiKey: result.rows[0], created: true };
}

export async function rotateApiKey(userId) {
  await query(`update api_keys set status = 'revoked', revoked_at = now() where user_id = $1 and status = 'active'`, [userId]);
  return createApiKey(userId, 'Rotated key');
}

export function normalizeDomain(domain) {
  const normalized = normalizeOriginHost(domain);
  return normalized.startsWith('*.') ? `*.${normalizeOriginHost(normalized.slice(2))}` : normalized;
}

export function domainMatches(host, allowedDomain) {
  const normalizedHost = normalizeDomain(host || '').split(':')[0];
  if (allowedDomain.startsWith('*.')) {
    const suffix = allowedDomain.slice(1);
    return normalizedHost.endsWith(suffix) && normalizedHost !== allowedDomain.slice(2);
  }
  return normalizedHost === allowedDomain;
}

export async function logAuthAttempt({ userId = null, apiKeyId = null, action, reason, c }) {
  await query(
    `insert into audit_logs (actor_user_id, target_user_id, action, entity_type, entity_id, ip_address, user_agent, metadata)
     values ($1, $1, $2, 'api_key', $3, nullif($4, '')::inet, $5, $6::jsonb)`,
    [userId, action, apiKeyId, c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || '', c.req.header('user-agent') || '', JSON.stringify({ reason, path: new URL(c.req.url).pathname })]
  );
}
