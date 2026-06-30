import { timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import dns from 'node:dns/promises';
import { env, isProduction } from '../config/env.js';

const PRIVATE_HOSTS = new Set(['localhost', 'localhost.localdomain']);

export function safeEqualString(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

export function securityHeaders() {
  return async (c, next) => {
    const appOrigin = new URL(env.APP_URL).origin;
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    c.header('Content-Security-Policy', [
      "default-src 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self' https://checkout.stripe.com",
      "img-src 'self' data:",
      "style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'",
      "script-src 'self' https://cdn.jsdelivr.net",
      "connect-src 'self'",
      "object-src 'none'"
    ].join('; '));
    if (isProduction) c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

    const origin = c.req.header('origin');
    if (origin && origin === appOrigin) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
      c.header('Access-Control-Allow-Credentials', 'true');
    }
    if (c.req.method === 'OPTIONS') {
      c.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-API-Key, X-CSRF-Token');
      return c.body(null, 204);
    }
    await next();
  };
}

export function normalizeOriginHost(value = '') {
  const trimmed = String(value).trim();
  if (!trimmed) return '';
  try { return new URL(trimmed).hostname.toLowerCase(); } catch {}
  return trimmed.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();
}

export async function assertPublicHttpUrl(rawUrl) {
  const targetUrl = new URL(rawUrl);
  if (!['http:', 'https:'].includes(targetUrl.protocol)) throw new Error('Unsupported target URL protocol');
  if (targetUrl.username || targetUrl.password) throw new Error('Target URL credentials are not allowed');
  await assertSafeTargetHost(targetUrl.hostname);
  return targetUrl;
}

export async function assertSafeTargetHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host || PRIVATE_HOSTS.has(host) || host.endsWith('.localhost')) throw new Error('Target host is blocked');
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true });
  if (addresses.some(({ address }) => isPrivateAddress(address))) throw new Error('Target URL resolves to a blocked private address');
}

export function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || parts[0] >= 224 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
  }
  const normalized = address.toLowerCase();
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:') || normalized.startsWith('ff');
}
